// Shared parts of the netem runners (run-verify.mjs, run-viewer.mjs): child processes that are started and stopped by
// PID only, the shaping proxy as its own process, Edge with its own profile and DevTools port, whole-PC CPU sampling,
// and one timed profile run with getStats recording.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cpus, totalmem, freemem } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connect, sleep } from '../cdp.mjs';
import { recorder } from './attach.mjs';
import { summarize, writeSummary, printTable } from './summarize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// --edge-args takes the next argument as is, since its value is itself a list of --flags.
export function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    if (v !== undefined && (k === 'edge-args' || !v.startsWith('--'))) { opt[k] = v; i++; } else opt[k] = true;
  }
  return opt;
}

// Work folders (Edge profile, MediaMTX config) of earlier runs that were killed before stopAll() ran — e.g. a run the
// user stopped because the PC lagged — are named after their PID; those whose process is gone are removed. A folder
// still in use (an Edge left running) cannot be removed and is kept.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
export function sweepStaleWork(parent) {
  const removed = [], kept = [];
  let names = []; try { names = readdirSync(parent); } catch { return { removed, kept }; }
  for (const name of names) {
    const m = /^frame-netem-(?:viewer-)?(\d+)$/.exec(name);
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    try { rmSync(join(parent, name), { recursive: true, force: true, maxRetries: 2 }); removed.push(name); } catch { kept.push(name); }
  }
  return { removed, kept };
}

export function createRun(out, work) {
  // The logs are appended to, so a second run into the same folder would mix two runs in one summary.
  for (const name of ['proxy.jsonl', 'stats.jsonl']) if (existsSync(join(out, name))) throw new Error(`${join(out, name)} already exists: choose another --out`);
  const stale = sweepStaleWork(dirname(work));
  mkdirSync(join(out, 'logs'), { recursive: true }); mkdirSync(work, { recursive: true });
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  if (stale.removed.length || stale.kept.length) log('earlier work folders: removed', stale.removed.join(' ') || '-', '/ in use, kept', stale.kept.join(' ') || '-');
  const children = [];
  function start(name, exe, args, { cwd = work, stdin = 'ignore' } = {}) {
    const child = spawn(exe, args, { cwd, stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
    const file = createWriteStream(join(out, 'logs', name + '.log'));
    child.stdout.pipe(file, { end: false }); child.stderr.pipe(file, { end: false });
    children.push({ name, child });
    log('started', name, 'pid', child.pid);
    return child;
  }
  function waitLine(child, pattern, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
      for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => { const m = pattern.exec(line); if (m) { clearTimeout(timer); resolve(m); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`${what}: process exited (${code})`)); });
    });
  }
  // Only processes this run started, by PID (with their own child processes, e.g. Edge's renderers).
  async function stopAll() {
    for (const { name, child } of children.reverse()) {
      if (child.exitCode !== null || child.signalCode) continue;
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      log('stopped', name, 'pid', child.pid);
    }
    children.length = 0;
    // msedge.exe may hand the browser over to a new process and exit, leaving it outside the tree above; this run's
    // own user-data-dir identifies exactly those PIDs.
    try {
      const filter = `Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*${join(work, 'edge').replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`;
      const pids = execFileSync('powershell.exe', ['-NoProfile', '-Command', filter]).toString().split(/\s+/).filter(Boolean);
      for (const pid of pids) { try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); } catch {} }
      if (pids.length) log('stopped', pids.length, 'leftover Edge processes of this run');
    } catch {}
    await sleep(500);
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
  const fail = async error => { console.error(error); await stopAll(); process.exit(1); };
  process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
  process.on('SIGINT', async () => { await stopAll(); process.exit(130); });
  return { log, start, waitLine, stopAll, out, work };
}

// The proxy waits (--hold, profile defaults applied) until playProfile sends "start".
export async function startShaper(run, { listen, target, profileFile, timeScale = 1, rateScale = 1 }) {
  const proxy = run.start('udp-proxy', process.execPath, [join(here, 'udp-proxy.mjs'), '--listen', listen, '--target', target, '--profile', profileFile,
    '--time-scale', String(timeScale), '--rate-scale', String(rateScale), '--hold', '--priority', 'high', '--log', join(run.out, 'proxy.jsonl')], { stdin: 'pipe' });
  await run.waitLine(proxy, /"event":"ready"/, 10000, 'proxy');
  return proxy;
}

// extraArgs: e.g. --disable-accelerated-video-decode to put decoding on the CPU (decoder-limit tests).
// dpr: device pixel ratio; a player that caps quality at the size the picture is shown at (the FRAME viewer does) needs
// enough device pixels, or the run measures the size rule instead of the network.
export async function launchEdge(run, { port, headed = false, size = '1280,800', dpr = null, extraArgs = [] }) {
  run.start('edge', EDGE, [...(headed ? [] : ['--headless=new']), `--remote-debugging-port=${port}`, `--user-data-dir=${join(run.work, 'edge')}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${size}`,
    ...(dpr ? [`--force-device-scale-factor=${dpr}`] : []), ...extraArgs, 'about:blank']);
  let client = null;
  for (let i = 0; i < 50 && !client; i++) { await sleep(300); try { client = await connect(port); } catch {} }
  if (!client) throw new Error('Edge DevTools did not come up on port ' + port);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return { client, version };
}

// Whole-PC load: other programs on the same PC compete with the proxy, the encoder and the browser's decoder.
export function sampleHost(file) {
  const times = () => cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });
  let last = times();
  const timer = setInterval(() => {
    const now = times(), busy = (now.busy - last.busy) / Math.max(1, now.all - last.all) * 100; last = now;
    writeFileSync(file, JSON.stringify({ t: Date.now(), cpuPct: +busy.toFixed(1), memUsedPct: +((1 - freemem() / totalmem()) * 100).toFixed(1) }) + '\n', { flag: 'a' });
  }, 1000);
  return () => clearInterval(timer);
}

export const hostInfo = () => ({ node: process.version, os: process.platform, cpu: cpus()[0].model, logicalCpus: cpus().length, memGB: +(totalmem() / 2 ** 30).toFixed(1) });

// Waits for decoded video, warms up at the profile defaults, runs the profile and records getStats (plus an optional
// page expression per sample). The proxy is stopped before the last sample, so that sample holds every byte it
// delivered and nothing else.
export async function playProfile(run, { client, proxy, profile, warmup = 12, probe, intervalMs = 1000 }) {
  const rec = recorder(client, join(run.out, 'stats.jsonl'), { intervalMs, probe });
  const stopHost = sampleHost(join(run.out, 'host.jsonl'));
  let playing = null;
  for (let i = 0; i < 90 && !playing; i++) {
    await sleep(500);
    const s = await client.evaluate('window.__netem && window.__netem.sample ? window.__netem.sample() : null').catch(() => null);
    if (s && s.video && s.video.framesDecoded > 30) playing = s;
  }
  if (playing) run.log('playing', `${playing.video.frameWidth}x${playing.video.frameHeight}`, 'remote', playing.pair && playing.pair.remote);
  else run.log('no decoded video after 45 s; recording anyway');
  run.log(`warm-up ${warmup}s`);
  await sleep(warmup * 1000);
  const startedAt = Date.now();
  proxy.stdin.write('start\n');
  run.log(`profile ${profile.name}: ${profile.steps.length} steps, ${profile.total}s`);
  let lastLabel = null;
  const progress = setInterval(() => {
    const el = (Date.now() - startedAt) / 1000, step = profile.steps.findLast(s => el >= s.start);
    if (step && step.label !== lastLabel) { lastLabel = step.label; run.log('step', step.label); }
  }, 250);
  await sleep(profile.total * 1000 + 3000);
  clearInterval(progress);
  proxy.stdin.write('quit\n');
  await new Promise(r => { proxy.once('exit', r); setTimeout(r, 3000); });
  await sleep(1500);
  await rec.stop();
  stopHost();
  return client.evaluate('({ netem: window.__netem && { cfg: window.__netem.cfg, rewrites: window.__netem.rewrites, strippedOffers: window.__netem.strippedOffers, patches: window.__netem.patches, created: window.__netem.created, plays: window.__netem.plays }, viewer: window.viewer || null, location: location.href, videos: [...document.querySelectorAll("video")].map(v => { const q = v.getVideoPlaybackQuality(); return { videoWidth: v.videoWidth, videoHeight: v.videoHeight, totalVideoFrames: q.totalVideoFrames, droppedVideoFrames: q.droppedVideoFrames }; }) })').catch(error => ({ error: error.message }));
}

export async function closeEdge(client) {
  try { await client.send('Browser.close'); } catch {}
  client.close();
}

export function writeResults(out, meta) {
  writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 2));
  const summary = summarize(out);
  writeSummary(out, summary);
  printTable(summary);
  return summary;
}
