// User-space network shaper for the media path of one WebRTC viewer (Windows has no tc/netem, and DevTools throttling
// does not touch WebRTC UDP). The browser is told (tools/netem/attach.mjs) that the server's ICE candidate is this
// proxy; every browser socket gets its own upstream socket to the real ICE UDP port, so the server sees ordinary
// peer-reflexive candidates. Both directions go through link.mjs on a schedule from a profile; counters go to JSONL.
//
// usage: node tools/netem/udp-proxy.mjs --target <server-ip>:<ice-udp-port> [--listen 127.0.0.1:22300]
//          [--profile tools/netem/profiles/steps.json] [--log out.jsonl] [--interval 1000] [--time-scale 1]
//          [--rate-scale 1] [--hold] [--exit-after-profile] [--timer spin|coarse] [--idle 60] [--priority normal|above|high]
// stdin commands: start (restart the profile now), hold (back to the profile defaults), set <down|up> <json>, quit
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { setPriority, constants } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createLink, checkLinkConfig } from './link.mjs';
import { loadProfile, stepAt, brief } from './profile.mjs';

const DIRS = ['down', 'up'];
const SPIN_MS = 17;  // Windows timers fire on a ~15.6 ms tick; deadlines closer than that are met by spinning

export function parseHostPort(text, fallbackHost = '127.0.0.1') {
  const m = /^(?:(.+):)?(\d+)$/.exec(String(text));
  if (!m) throw new Error('expected host:port, got ' + text);
  return { address: m[1] || fallbackHost, port: Number(m[2]) };
}

// Host names are resolved once, to IPv4 (the proxy's sockets are udp4): replies are matched against this address, so
// "localhost:8189" or "sender-pc:8189" behave exactly like the IP itself.
export async function resolveHostPort(text, fallbackHost) {
  const at = parseHostPort(text, fallbackHost);
  if (isIPv4(at.address)) return { ...at, name: at.address };
  const { address } = await lookup(at.address, { family: 4 });
  return { address, port: at.port, name: at.address };
}

export async function startProxy(options) {
  const { listen = '127.0.0.1:22300', target, log, intervalMs = 1000, timer = 'spin', hold = false, idleSeconds = 60, timeScale = 1, rateScale = 1, onEvent = () => {} } = options;
  const listenAt = await resolveHostPort(listen), targetAt = await resolveHostPort(target);
  const profile = options.profile ? loadProfile(options.profile, { timeScale, rateScale }) : null;
  const links = { down: createLink(), up: createLink() };
  const sessions = new Map();   // "ip:port" of a browser socket → { client, upstream, lastSeen }
  const out = log ? createWriteStream(log, { flags: 'a' }) : null;
  const write = obj => { const line = JSON.stringify({ t: Date.now(), ...obj }); if (out) out.write(line + '\n'); onEvent(obj); };
  let profileStart = null, stepIndex = -1, stepTimer = null, closed = false, strays = 0, sendErrors = 0;

  // ---- scheduling: one pump drains both links, then sleeps until the next deadline ------------------------------
  let sleepTimer = null, sleepUntil = Infinity, spinning = false;
  // Per-socket byte counts let a run compare each browser connection with what the proxy delivered to it.
  function deliverDown(data, session) { if (session.closed) return; session.downTx += data.length; session.downTxPkts++; listenSock.send(data, session.client.port, session.client.address, sent); }
  function deliverUp(data, session) { if (session.closed) return; session.upTx += data.length; session.upstream.send(data, targetAt.port, targetAt.address, sent); }
  function sent(error) { if (error) sendErrors++; }
  function pump() {
    if (closed) return;
    const now = performance.now();
    links.down.drain(now, deliverDown);
    links.up.drain(now, deliverUp);
    const next = Math.min(links.down.nextAt(), links.up.nextAt());
    if (next === Infinity) return;
    if (timer === 'spin' && next - now < SPIN_MS) {
      if (!spinning) { spinning = true; setImmediate(() => { spinning = false; pump(); }); }
      return;
    }
    const wake = timer === 'spin' ? next - SPIN_MS + 1 : next;
    if (sleepTimer && sleepUntil <= wake) return;
    clearTimeout(sleepTimer);
    sleepUntil = wake;
    sleepTimer = setTimeout(() => { sleepTimer = null; sleepUntil = Infinity; pump(); }, Math.max(0, wake - now));
  }

  // ---- sockets ----------------------------------------------------------------------------------------------------
  const big = { recvBufferSize: 8 << 20, sendBufferSize: 8 << 20 };  // video frames arrive as bursts of ~1.2 kB packets
  const listenSock = dgram.createSocket({ type: 'udp4', ...big });
  listenSock.on('error', error => write({ event: 'error', where: 'listen', message: error.message }));
  listenSock.on('message', (data, rinfo) => {
    const key = rinfo.address + ':' + rinfo.port;
    let session = sessions.get(key);
    if (!session) session = openSession(key, rinfo);
    session.lastSeen = Date.now();
    links.up.offer(data, performance.now(), session);
    pump();
  });
  function openSession(key, rinfo) {
    const upstream = dgram.createSocket({ type: 'udp4', ...big });
    const session = { key, client: { address: rinfo.address, port: rinfo.port }, upstream, lastSeen: Date.now(), opened: Date.now(), closed: false, downRx: 0, downTx: 0, downTxPkts: 0, upTx: 0 };
    upstream.on('error', error => write({ event: 'error', where: 'upstream ' + key, message: error.message }));
    upstream.on('message', (data, from) => {
      if (from.port !== targetAt.port || from.address !== targetAt.address) { strays++; return; }
      session.lastSeen = Date.now(); session.downRx += data.length;
      links.down.offer(data, performance.now(), session);
      pump();
    });
    // Same family/interface as the target, so the server sees a sensible source address.
    upstream.bind(0, isLoopback(targetAt.address) ? '127.0.0.1' : '0.0.0.0', () => {
      session.upstreamAt = upstream.address().address + ':' + upstream.address().port;
      write({ event: 'session', client: key, upstream: upstream.address().address + ':' + upstream.address().port, sessions: sessions.size });
    });
    sessions.set(key, session);
    return session;
  }
  await new Promise((resolve, reject) => { listenSock.once('error', reject); listenSock.bind(listenAt.port, listenAt.address, () => { listenSock.off('error', reject); resolve(); }); });

  // ---- profile ----------------------------------------------------------------------------------------------------
  function apply(cfgs, reason) {
    for (const dir of DIRS) if (cfgs[dir]) links[dir].setConfig(cfgs[dir]);
    write({ event: 'config', reason, step: stepIndex, label: stepIndex >= 0 ? profile.steps[stepIndex].label : null, down: brief(links.down.config), up: brief(links.up.config) });
    pump();
  }
  function scheduleStep() {
    clearTimeout(stepTimer);
    if (!profile || profileStart === null || closed) return;
    const elapsed = (performance.now() - profileStart) / 1000;
    if (!profile.loop && elapsed >= profile.total) {
      // Past the end the line goes back to the profile defaults (logged as a config event), so the last step — an
      // outage, say — lasts exactly as long as the profile says, not until the runner quits.
      if (stepIndex !== -2) { stepIndex = -2; write({ event: 'profile-end', elapsed: +elapsed.toFixed(3) }); apply(profile.base, 'profile-end'); if (options.exitAfterProfile) proxy.close(); }
      return;
    }
    const index = stepAt(profile, elapsed);
    if (index !== stepIndex) { stepIndex = index; apply(profile.steps[index], 'step'); }
    const cycle = profile.loop ? Math.floor(elapsed / profile.total) * profile.total : 0;
    const step = profile.steps[index], end = cycle + step.start + step.duration;
    stepTimer = setTimeout(scheduleStep, Math.max(1, (end - elapsed) * 1000));
  }
  function startProfile() { if (!profile) return; profileStart = performance.now(); stepIndex = -1; write({ event: 'profile-start', name: profile.name, total: profile.total, timeScale, rateScale }); scheduleStep(); }
  function holdProfile() { clearTimeout(stepTimer); profileStart = null; stepIndex = -1; if (profile) apply(profile.base, 'hold'); }

  // ---- counters ---------------------------------------------------------------------------------------------------
  let lastTick = performance.now(), lastCpu = process.cpuUsage();
  const ended = [];
  // upstream: the address the server sees, which is also what the browser's getStats shows as its (prflx) local candidate.
  const sessionTotals = s => ({ client: s.key, upstream: s.upstreamAt || null, opened: s.opened, lastSeen: s.lastSeen, downRxBytes: s.downRx, downTxBytes: s.downTx, downTxPkts: s.downTxPkts, upTxBytes: s.upTx });
  const ticker = setInterval(() => {
    const now = performance.now(), seconds = (now - lastTick) / 1000; lastTick = now;
    const cpu = process.cpuUsage(lastCpu); lastCpu = process.cpuUsage();
    for (const [key, s] of sessions) if (Date.now() - s.lastSeen > idleSeconds * 1000) { s.closed = true; s.upstream.close(); sessions.delete(key); ended.push(sessionTotals(s)); write({ event: 'session-idle', ...sessionTotals(s) }); }
    const line = { event: 'tick', elapsed: profileStart === null ? null : +((now - profileStart) / 1000).toFixed(3), step: stepIndex, label: stepIndex >= 0 ? profile.steps[stepIndex].label : null, sessions: sessions.size, strays, sendErrors,
      cpuPct: +((cpu.user + cpu.system) / 1e4 / seconds).toFixed(1), tickLagMs: +(seconds * 1000 - intervalMs).toFixed(1) };
    for (const dir of DIRS) {
      const s = links[dir].snapshot(), cfg = links[dir].config;
      line[dir] = { rateMbps: cfg.rateMbps, outage: cfg.outage, lossPct: cfg.lossPct, delayMs: cfg.delayMs, jitterMs: cfg.jitterMs,
        rxMbps: +(s.rxBytes * 8 / seconds / 1e6).toFixed(3), txMbps: +(s.txBytes * 8 / seconds / 1e6).toFixed(3),
        rxPkts: s.rxPkts, txPkts: s.txPkts, rxBytes: s.rxBytes, txBytes: s.txBytes, dropQueue: s.dropQueue, dropLoss: s.dropLoss, dropOutage: s.dropOutage,
        queueMsAvg: s.served ? +(s.queueMsSum / s.served).toFixed(1) : 0, queueMsMax: +s.queueMsMax.toFixed(1), queueMsNow: s.queueMsNow,
        delayMsAvg: s.txPkts ? +(s.delayMsSum / s.txPkts).toFixed(1) : null, delayMsMax: +s.delayMsMax.toFixed(1),
        lateMsAvg: s.txPkts ? +(s.lateMsSum / s.txPkts).toFixed(2) : null, lateMsMax: +s.lateMsMax.toFixed(1) };
    }
    write(line);
  }, intervalMs);

  const proxy = {
    address: listenSock.address(),
    profile,
    start: startProfile,
    hold: holdProfile,
    set(dir, cfg) { if (!DIRS.includes(dir)) throw new Error('direction must be down or up'); apply({ [dir]: checkLinkConfig({ ...links[dir].config, ...cfg }) }, 'set'); },
    totals: () => ({ down: links.down.totals(), up: links.up.totals(), sessions: sessions.size, strays, sendErrors, perSession: [...ended, ...[...sessions.values()].map(sessionTotals)] }),
    async close() {
      if (closed) return;
      write({ event: 'totals', ...proxy.totals() });
      closed = true;
      clearInterval(ticker); clearTimeout(stepTimer); clearTimeout(sleepTimer);
      for (const s of sessions.values()) { s.closed = true; s.upstream.close(); }
      listenSock.close();
      if (out) await new Promise(resolve => out.end(resolve));
      options.onClose?.();
    },
  };
  write({ event: 'ready', listen: listenAt.address + ':' + proxy.address.port, target: targetAt.address + ':' + targetAt.port, targetName: targetAt.name, profile: profile && { name: profile.name, total: profile.total, steps: profile.steps.length }, timer });
  if (profile) { apply(profile.base, 'defaults'); if (!hold) startProfile(); }
  return proxy;
}

const isLoopback = address => address.startsWith('127.');

// ---- command line ---------------------------------------------------------------------------------------------------
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (!m) throw new Error('unexpected argument ' + argv[i]);
    const next = argv[i + 1];
    out[m[1]] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return out;
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  const a = args(process.argv.slice(2));
  // Above-normal priority by default: a starved proxy releases queued packets in bursts and distorts the emulation.
  const priority = { normal: constants.priority.PRIORITY_NORMAL, above: constants.priority.PRIORITY_ABOVE_NORMAL, high: constants.priority.PRIORITY_HIGH }[a.priority || 'above'];
  try { setPriority(priority); } catch (error) { console.error('priority not changed: ' + error.message); }
  if (!a.target) { console.error('usage: node tools/netem/udp-proxy.mjs --target <server-ip>:<ice-udp-port> [--listen 127.0.0.1:22300] [--profile file.json] [--log out.jsonl]'); process.exit(2); }
  const proxy = await startProxy({
    listen: a.listen, target: a.target, profile: a.profile, log: a.log, intervalMs: Number(a.interval || 1000), timer: a.timer || 'spin',
    hold: !!a.hold, idleSeconds: Number(a.idle || 60), timeScale: Number(a['time-scale'] || 1), rateScale: Number(a['rate-scale'] || 1),
    exitAfterProfile: !!a['exit-after-profile'],
    onEvent: obj => { if (obj.event !== 'tick' || a.verbose) console.log(JSON.stringify(obj)); else if (process.stdout.isTTY) process.stdout.write(`\r${obj.label ?? '-'} down ${obj.down.txMbps.toFixed(2)}/${obj.down.rxMbps.toFixed(2)} Mbps drop q${obj.down.dropQueue} l${obj.down.dropLoss} o${obj.down.dropOutage} queue ${obj.down.queueMsNow} ms   `); },
    onClose: () => process.exit(0),
  });
  const quit = () => proxy.close();
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  createInterface({ input: process.stdin }).on('line', line => {
    const [cmd, dir, ...rest] = line.trim().split(/\s+/);
    try {
      if (cmd === 'start') proxy.start();
      else if (cmd === 'hold') proxy.hold();
      else if (cmd === 'set') proxy.set(dir, JSON.parse(rest.join(' ')));
      else if (cmd === 'quit') quit();
      else if (cmd) console.error('commands: start | hold | set <down|up> <json> | quit');
    } catch (error) { console.error(error.message); }
  });
}
