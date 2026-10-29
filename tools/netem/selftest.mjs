// Accuracy check of udp-proxy.mjs with synthetic UDP traffic (no browser): a fake ICE server and a fake viewer in this
// process share one clock, the proxy runs as its own process exactly as in a real test. Each step offers a known load
// in one or both directions and the measured rate, loss, burst length, one-way delay and reordering are compared with
// the step's settings against fixed pass/fail limits. Model-only checks (link.mjs without sockets) run first.
// Exit code: 0 when every check passes, 1 otherwise.
// usage: node tools/netem/selftest.mjs [--timer spin|coarse] [--out verification/netem/selftest.json] [--base-port 22400]
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { tmpdir, cpus, setPriority, constants } from 'node:os';
import { createLink, checkLinkConfig } from './link.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const opt = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s*--/).filter(Boolean).map(s => { const [k, ...v] = s.split(/\s+/); return [k, v.join(' ') || true]; }));
const timer = opt.timer || 'spin', base = Number(opt['base-port'] || 22400);
const PROXY = base, SERVER = base + 1, CLIENT = base + 2;
const SIZE = 1200, OVERHEAD = 28, PROBE_EVERY_MS = 20, PROBE_BYTES = 64;
const UP_DATA = 0xfffffffe, UP_PROBE = 0xffffffff;
// The harness timestamps both ends, so it must not be starved either; other programs' load is recorded with the result.
try { setPriority(constants.priority.PRIORITY_HIGH); } catch {}
const cpuTimes = () => cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });
const cpu0 = cpuTimes(), ownCpu0 = process.cpuUsage();
const check = (name, value, min, max) => ({ name, value: value === null || value === undefined || Number.isNaN(value) ? null : +(+value).toFixed(3), min, max, pass: value !== null && value !== undefined && !Number.isNaN(value) && (min === null || value >= min) && (max === null || value <= max) });

// ---- model-only checks (no sockets, seeded random numbers) ------------------------------------------------------------
function mulberry32(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function modelChecks() {
  const out = [];
  const rejects = cfg => { try { checkLinkConfig(cfg); return 0; } catch { return 1; } };
  out.push({ label: 'model-gilbert-limit', checks: [check('rejects lossPct 90 / lossBurst 2 (max 66.7%)', rejects({ lossPct: 90, lossBurst: 2 }), 1, 1), check('accepts lossPct 60 / lossBurst 2', rejects({ lossPct: 60, lossBurst: 2 }), 0, 0), check('accepts lossPct 90 / lossBurst 1', rejects({ lossPct: 90, lossBurst: 1 }), 0, 0)] });
  {
    // lossPct 100 means every packet (it used to be capped at 99.9%).
    const link = createLink(mulberry32(100)); link.setConfig({ lossPct: 100 });
    let lost = 0; const n = 100000, data = Buffer.alloc(10);
    for (let i = 0; i < n; i++) if (!link.offer(data, i, null)) lost++;
    out.push({ label: 'model-loss100', measured: { lossPct: lost / n * 100 }, checks: [check('loss % at lossPct 100', lost / n * 100, 100, 100)] });
  }
  for (const [lossPct, lossBurst] of [[20, 3], [5, 4], [60, 2]]) {
    const link = createLink(mulberry32(lossPct * 7 + lossBurst)); link.setConfig({ lossPct, lossBurst });
    const n = 300000, data = Buffer.alloc(100);
    let lost = 0, runs = 0, run = 0;
    for (let i = 0; i < n; i++) { if (!link.offer(data, i, null)) { lost++; run++; } else if (run) { runs++; run = 0; } }
    if (run) runs++;
    link.drain(n + 1, () => {});
    out.push({ label: `model-loss${lossPct}-burst${lossBurst}`, measured: { lossPct: +(lost / n * 100).toFixed(2), meanBurst: +(lost / runs).toFixed(2) },
      checks: [check('loss %', lost / n * 100, lossPct * 0.95, lossPct * 1.05), check('mean loss run', lost / runs, lossBurst * 0.93, lossBurst * 1.07)] });
  }
  return out;
}

// ---- proxy with synthetic traffic ---------------------------------------------------------------------------------
// offer: what the fake server sends down during the step ("video" = 60 bursts/s, like an encoder's frames); upOffer:
// what the fake viewer sends up besides its 64-byte delay probes. limits: the pass/fail range of each measurement.
const profile = {
  name: 'selftest',
  defaults: { down: { maxQueueMs: 200 }, up: {} },
  steps: [
    { label: 'pass-through', duration: 4, offer: { mbps: 8, pattern: 'cbr' }, limits: { recvOfOffer: [0.995, 1.001], delayP50: [0, 3] } },
    { label: 'rate5-offer10', duration: 5, down: { rateMbps: 5 }, offer: { mbps: 10, pattern: 'cbr' }, limits: { recvOfExpect: [0.97, 1.03], delayP50: [180, 210] } },
    { label: 'rate3-offer2-video', duration: 5, down: { rateMbps: 3 }, offer: { mbps: 2, pattern: 'video' }, limits: { recvOfOffer: [0.99, 1.001], delayP95: [0, 30] } },
    { label: 'rate1-offer8-video', duration: 5, down: { rateMbps: 1, maxQueueMs: 300 }, offer: { mbps: 8, pattern: 'video' }, limits: { recvOfExpect: [0.95, 1.05], delayP50: [250, 320] } },
    { label: 'up-rate2-offer4', duration: 5, up: { rateMbps: 2, maxQueueMs: 200 }, offer: { mbps: 1, pattern: 'cbr' }, upOffer: { mbps: 4 }, limits: { upRecvOfExpect: [0.97, 1.03], upDelayP50: [170, 215], recvOfOffer: [0.995, 1.001] } },
    { label: 'delay50', duration: 4, down: { delayMs: 50 }, up: { delayMs: 30 }, offer: { mbps: 4, pattern: 'cbr' }, limits: { delayP50: [49, 53], upDelayP50: [29, 33], reordered: [0, 0] } },
    { label: 'delay50-jitter10', duration: 5, down: { delayMs: 50, jitterMs: 10 }, offer: { mbps: 4, pattern: 'cbr' }, limits: { delayMin: [38, 52], delayP95: [52, 63], reordered: [0, 0] } },
    { label: 'delay50-jitter10-packet', duration: 5, down: { delayMs: 50, jitterMs: 10, jitterMode: 'packet' }, offer: { mbps: 4, pattern: 'cbr' }, limits: { delayMin: [38, 45], delayP50: [46, 55], delayP95: [55, 63], reorderedPct: [5, 100] } },
    { label: 'loss5', duration: 5, down: { lossPct: 5 }, offer: { mbps: 8, pattern: 'cbr' }, limits: { lossPct: [3.5, 6.5], meanLossBurst: [0.9, 1.3] } },
    { label: 'loss5-burst4', duration: 5, down: { lossPct: 5, lossBurst: 4 }, offer: { mbps: 8, pattern: 'cbr' }, limits: { lossPct: [3, 7.5], meanLossBurst: [3, 5.5] } },
    { label: 'outage', duration: 3, outage: true, offer: { mbps: 4, pattern: 'cbr' }, upOffer: { mbps: 1 }, limits: { received: [0, 0], upReceived: [0, 0] } },
    { label: 'recovered', duration: 3, offer: { mbps: 4, pattern: 'cbr' }, limits: { recvOfOffer: [0.99, 1.001] } },
  ],
};
const model = modelChecks();
// Temporary files are named after the PID; files of earlier runs whose process is gone (one that was killed) go first.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
for (const name of readdirSync(tmpdir())) { const m = /^netem-selftest-(\d+)\.jsonl?$/.exec(name); if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) rmSync(join(tmpdir(), name), { force: true }); }
const profileFile = join(tmpdir(), `netem-selftest-${process.pid}.json`);
writeFileSync(profileFile, JSON.stringify({ ...profile, steps: profile.steps.map(({ offer, upOffer, limits, ...s }) => s) }));
const logFile = join(tmpdir(), `netem-selftest-${process.pid}.jsonl`);
// Every way out (a failed check, an exception, a port in use) removes the temporary files and stops the proxy.
let child = null;
process.on('exit', () => { try { if (child && child.exitCode === null && !child.signalCode) child.kill(); } catch {} rmSync(profileFile, { force: true }); rmSync(logFile, { force: true }); });

child = spawn(process.execPath, [join(here, 'udp-proxy.mjs'), '--listen', '127.0.0.1:' + PROXY, '--target', 'localhost:' + SERVER, '--profile', profileFile, '--hold', '--timer', timer, '--priority', 'high', '--log', logFile], { stdio: ['pipe', 'pipe', 'inherit'] });
const events = [];
let onEvent = () => {};
createInterface({ input: child.stdout }).on('line', line => { try { const e = JSON.parse(line); e.at = performance.now(); events.push(e); onEvent(e); } catch {} });
const waitEvent = pred => new Promise(resolve => { const prev = onEvent; onEvent = e => { prev(e); if (pred(e)) { onEvent = prev; resolve(e); } }; const hit = events.find(pred); if (hit) { onEvent = prev; resolve(hit); } });
const ready = await Promise.race([waitEvent(e => e.event === 'ready'),
  new Promise((_, reject) => { child.once('exit', code => reject(new Error(`proxy exited before it was ready (code ${code}; port ${PROXY} in use?)`))); setTimeout(() => reject(new Error('proxy not ready after 10 s')), 10000).unref(); })]);

const server = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20, sendBufferSize: 8 << 20 });
const client = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20, sendBufferSize: 8 << 20 });
const bind = (sock, port) => new Promise((resolve, reject) => { sock.once('error', reject); sock.bind(port, '127.0.0.1', () => { sock.off('error', reject); resolve(); }); });
await Promise.all([bind(server, SERVER), bind(client, CLIENT)]);
let upstream = null;
const upDelays = [], upGot = [];
server.on('message', (msg, rinfo) => {
  upstream = rinfo;
  if (msg.length < 12) return;
  const marker = msg.readUInt32BE(0), now = performance.now();
  if (marker === UP_PROBE) upDelays.push({ at: now, d: now - msg.readDoubleBE(4) });
  else if (marker === UP_DATA) upGot.push({ seq: msg.readUInt32BE(4), sent: msg.readDoubleBE(8), at: now });
});
const received = [];
client.on('message', msg => received.push({ seq: msg.readUInt32BE(0), sent: msg.readDoubleBE(4), at: performance.now() }));
client.send(Buffer.from('hello'), PROXY, '127.0.0.1');
for (let i = 0; i < 100 && !upstream; i++) await new Promise(r => setTimeout(r, 20));
// The target was given as a host name ("localhost"): replies only arrive if the proxy resolved it (checker D1).
if (!upstream) throw new Error('proxy did not forward the first packet');

// ---- traffic: paced by spinning, timestamps from this process -------------------------------------------------------
const steps = [];
onEvent = e => { if (e.event === 'config' && e.reason === 'step') steps.push({ index: e.step, at: e.at }); };
child.stdin.write('start\n');
await waitEvent(e => e.event === 'config' && e.reason === 'step');
const sent = [], upSent = [];
let seq = 0, upSeq = 0, lastUp = 0;
// A fresh buffer per packet: send() is asynchronous and would otherwise transmit the last header written.
function sendOne(now) { const payload = Buffer.alloc(SIZE); payload.writeUInt32BE(seq, 0); payload.writeDoubleBE(now, 4); server.send(payload, upstream.port, upstream.address); sent.push({ seq, at: now }); seq++; }
function sendUp(now) { const payload = Buffer.alloc(SIZE); payload.writeUInt32BE(UP_DATA, 0); payload.writeUInt32BE(upSeq, 4); payload.writeDoubleBE(now, 8); client.send(payload, PROXY, '127.0.0.1'); upSent.push({ seq: upSeq, at: now }); upSeq++; }
let next = performance.now(), nextUp = performance.now();
const total = profile.steps.reduce((s, x) => s + x.duration, 0) * 1000, t0 = performance.now();
await new Promise(resolve => {
  const loop = () => {
    const now = performance.now();
    if (now - t0 > total + 200) { resolve(); return; }
    const step = profile.steps[steps.length ? steps.at(-1).index : 0];
    const offer = step.offer;
    if (now - lastUp >= PROBE_EVERY_MS) { const b = Buffer.alloc(PROBE_BYTES); b.writeUInt32BE(UP_PROBE, 0); b.writeDoubleBE(now, 4); client.send(b, PROXY, '127.0.0.1'); lastUp = now; }
    if (step.upOffer) { while (now >= nextUp) { sendUp(now); nextUp += SIZE * 8 / (step.upOffer.mbps * 1e3); } } else nextUp = now;
    while (now >= next) {
      if (offer.pattern === 'cbr') { sendOne(now); next += SIZE * 8 / (offer.mbps * 1e3); }
      else { const frameBytes = offer.mbps * 1e6 / 8 / 60; for (let b = 0; b < frameBytes; b += SIZE) sendOne(now); next += 1000 / 60; }
    }
    setImmediate(loop);
  };
  loop();
});
await new Promise(r => setTimeout(r, 800));  // let delayed packets arrive

// ---- per-step comparison --------------------------------------------------------------------------------------------
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const bySeq = new Map(received.map(r => [r.seq, r])), upBySeq = new Map(upGot.map(r => [r.seq, r]));
const results = steps.map((s, i) => {
  const step = profile.steps[s.index], from = s.at + 600, to = (steps[i + 1]?.at ?? s.at + step.duration * 1000) - 200;
  const window = sent.filter(p => p.at >= from && p.at < to), got = window.map(p => bySeq.get(p.seq)).filter(Boolean);
  const secs = (to - from) / 1000, delays = got.map(r => r.at - r.sent);
  let bursts = 0, burstLen = 0, run = 0;
  for (const p of window) { if (bySeq.has(p.seq)) { if (run) { bursts++; burstLen += run; run = 0; } } else run++; }
  let reordered = 0, maxSeq = -1;
  for (const r of [...got].sort((a, b) => a.at - b.at)) { if (r.seq < maxSeq) reordered++; maxSeq = Math.max(maxSeq, r.seq); }
  const down = { ...profile.defaults.down, ...step.down }, up = { ...profile.defaults.up, ...step.up }, rate = down.rateMbps;
  const recvMbps = got.length * SIZE * 8 / secs / 1e6, offerMbps = window.length * SIZE * 8 / secs / 1e6;
  const expectMbps = step.outage ? 0 : (1 - (down.lossPct || 0) / 100) * (rate ? Math.min(offerMbps, rate * SIZE / (SIZE + OVERHEAD)) : offerMbps);
  const ups = upDelays.filter(u => u.at >= from && u.at < to).map(u => u.d);
  // Up direction: data packets sent in the window that arrived (whenever), against the up rate less the probes' share.
  const upWindow = upSent.filter(p => p.at >= from && p.at < to), upArrived = upWindow.filter(p => upBySeq.has(p.seq));
  const upOfferMbps = upWindow.length * SIZE * 8 / secs / 1e6, upRecvMbps = upArrived.length * SIZE * 8 / secs / 1e6;
  const probeWire = 1000 / PROBE_EVERY_MS * (PROBE_BYTES + OVERHEAD);
  const upExpectMbps = step.outage ? 0 : up.rateMbps ? Math.min(upOfferMbps, (up.rateMbps * 1e6 / 8 - probeWire) * SIZE / (SIZE + OVERHEAD) * 8 / 1e6) : upOfferMbps;
  const m = { offeredMbps: +offerMbps.toFixed(3), receivedMbps: +recvMbps.toFixed(3), expectedPayloadMbps: +expectMbps.toFixed(3),
    lossPct: window.length ? +((1 - got.length / window.length) * 100).toFixed(2) : null, meanLossBurst: bursts ? +(burstLen / bursts).toFixed(2) : null,
    delayMs: { p50: pct(delays, 0.5), p95: pct(delays, 0.95), p99: pct(delays, 0.99), min: pct(delays, 0), max: pct(delays, 1) }, upDelayMsP50: pct(ups, 0.5), reordered, packets: window.length,
    up: step.upOffer ? { offeredMbps: +upOfferMbps.toFixed(3), receivedMbps: +upRecvMbps.toFixed(3), expectedPayloadMbps: +upExpectMbps.toFixed(3), packets: upWindow.length } : null };
  const L = step.limits || {}, checks = [];
  if (L.recvOfOffer) checks.push(check('received / offered', offerMbps ? recvMbps / offerMbps : null, ...L.recvOfOffer));
  if (L.recvOfExpect) checks.push(check('received / expected', expectMbps ? recvMbps / expectMbps : null, ...L.recvOfExpect));
  if (L.delayP50) checks.push(check('delay p50 ms', m.delayMs.p50, ...L.delayP50));
  if (L.delayP95) checks.push(check('delay p95 ms', m.delayMs.p95, ...L.delayP95));
  if (L.delayMin) checks.push(check('delay min ms', m.delayMs.min, ...L.delayMin));
  if (L.reordered) checks.push(check('reordered packets', reordered, ...L.reordered));
  if (L.reorderedPct) checks.push(check('reordered % of received', got.length ? reordered / got.length * 100 : null, ...L.reorderedPct));
  if (L.lossPct) checks.push(check('loss %', m.lossPct, ...L.lossPct));
  if (L.meanLossBurst) checks.push(check('mean loss run', m.meanLossBurst, ...L.meanLossBurst));
  if (L.received) checks.push(check('packets received', got.length, ...L.received));
  if (L.upReceived) checks.push(check('up packets received', upArrived.length, ...L.upReceived));
  if (L.upRecvOfExpect) checks.push(check('up received / expected', upExpectMbps ? upRecvMbps / upExpectMbps : null, ...L.upRecvOfExpect));
  if (L.upDelayP50) checks.push(check('up delay p50 ms', m.upDelayMsP50, ...L.upDelayP50));
  return { label: step.label, settings: { down: step.down || {}, up: step.up || {}, outage: !!step.outage }, offer: step.offer, upOffer: step.upOffer || null, ...m, checks, pass: checks.every(c => c.pass) };
});
child.stdin.write('quit\n');
await new Promise(r => child.once('exit', r));
server.close(); client.close();
const cpu1 = cpuTimes(), own = process.cpuUsage(ownCpu0);
const ticks = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === 'tick' && e.step >= 0);
const host = { cpu: cpus()[0].model, logicalCpus: cpus().length, busyPctDuringTest: +((cpu1.busy - cpu0.busy) / (cpu1.all - cpu0.all) * 100).toFixed(1),
  proxyCpuPctOfOneCore: +(ticks.reduce((a, e) => a + e.cpuPct, 0) / Math.max(1, ticks.length)).toFixed(1), harnessCpuSeconds: +((own.user + own.system) / 1e6).toFixed(1),
  proxyLateMsMax: Math.max(...ticks.map(e => Math.max(e.down.lateMsMax, e.up.lateMsMax))), proxyLateMsAvg: +(ticks.reduce((a, e) => a + (e.down.lateMsAvg || 0), 0) / Math.max(1, ticks.length)).toFixed(3) };
// How late the proxy released packets depends on the timer mode and on what else runs on the PC.
const timing = { label: 'timing', checks: [check('proxy late ms max', host.proxyLateMsMax, 0, timer === 'coarse' ? 40 : 25), check('target host name resolved (localhost)', ready.target === '127.0.0.1:' + SERVER ? 1 : 0, 1, 1)] };
timing.pass = timing.checks.every(c => c.pass);
for (const m of model) m.pass = m.checks.every(c => c.pass);
rmSync(profileFile, { force: true }); rmSync(logFile, { force: true });
const all = [...model, ...results, timing], failed = all.filter(r => !r.pass);
const report = { tool: 'tools/netem/selftest.mjs', node: process.version, timer, date: new Date().toISOString(), packetBytes: SIZE, host, pass: !failed.length, failed: failed.map(r => r.label), model, results, timing };
console.log('host', JSON.stringify(host));
for (const r of model) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.label.padEnd(26), r.checks.map(c => `${c.name}=${c.value}`).join('  '));
for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.label.padEnd(26), `offer ${r.offeredMbps.toFixed(2)} recv ${r.receivedMbps.toFixed(2)} expect ${r.expectedPayloadMbps.toFixed(2)} Mbps  loss ${r.lossPct}% burst ${r.meanLossBurst}  delay p50 ${r.delayMs.p50} p95 ${r.delayMs.p95} min ${r.delayMs.min} max ${r.delayMs.max} ms  up p50 ${r.upDelayMsP50}  reorder ${r.reordered}` + (r.up ? `  up offer ${r.up.offeredMbps} recv ${r.up.receivedMbps} expect ${r.up.expectedPayloadMbps}` : '') + r.checks.filter(c => !c.pass).map(c => `  [${c.name} ${c.value} not in ${c.min}..${c.max}]`).join(''));
console.log((timing.pass ? 'PASS ' : 'FAIL ') + 'timing'.padEnd(26), timing.checks.map(c => `${c.name}=${c.value}`).join('  '));
console.log(failed.length ? `FAILED ${failed.length} of ${all.length}: ${failed.map(r => r.label).join(', ')}` : `ALL ${all.length} PASSED`);
if (opt.out) { mkdirSync(dirname(opt.out), { recursive: true }); writeFileSync(opt.out, JSON.stringify(report, null, 2)); console.log('saved', opt.out); }
process.exitCode = failed.length ? 1 : 0;
