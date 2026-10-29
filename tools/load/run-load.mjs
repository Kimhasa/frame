// Staged load runner for ONE broadcast. Counts only viewers that really receive media: every viewer is a WebRTC peer in a
// separate generator MediaMTX (lib/generator.mjs) pulling the target's WHEP URL, and a viewer is "receiving" only while
// its received byte count keeps growing. HTTP 200 / WHEP 201 alone never count. Optional chat sockets, DVR readers,
// churn, quality mix and mid-session quality changes, real-browser samplers (desktop / mobile-like), resource sampling of
// generator and target, target statistics (standalone MediaMTX API or the app's /api/stats), and stop rules.
// usage: node tools/load/run-load.mjs --plan tools/load/plans/smoke-local.json [--stages 1,10 --hold 60 --name x --out <dir> ...]
//        node tools/load/run-load.mjs --plan tools/load/plans/real-app.json --host 192.168.0.10 [--generator-id pc2]
// Results: <out or verification/load>/<runId>/results.json, stages.csv, samples.csv, browser.csv (+ generator WAR/ERR logs).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, cpus, freemem, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { repo, bin, parseArgs, readJson, merge, sleep, percentile, mean, round, fetchJson, toolVersion, hostSpec, csv, killOnExit, killAll, run, onLines, pidsByCommandLine, localStamp } from './lib/common.mjs';
import { Generator } from './lib/generator.mjs';
import { Resources } from './lib/resources.mjs';
import { ChatPool, chatName } from './lib/chat.mjs';
import { DvrPool } from './lib/dvr.mjs';
import { WhepTap } from './lib/whep-tap.mjs';

const NOT = 'not measured';
const CLOCK_TOL_MS = 50;  // generator MediaMTX and this runner read the same OS clock; a ready time earlier than this before the request is stale
const defaults = {
  name: 'run',
  // Prefix of the chat display names (부하-<id>-v00012). The app refuses a name that another machine already holds, so each
  // generator PC needs its own id; default: 4 hex characters of this PC's host name hash.
  generatorId: null,
  // No default target: a plan, --whep/--base or --target-state must name it (never an app that happens to run on this PC).
  // appStats: the app's read-only statistics (GET /api/stats, contract v 1). requireAppStats: refuse to start without it.
  // useApi: read the standalone target's MediaMTX API when the state file names one.
  target: { whep: null, base: null, path: 'screen-01', stateFile: null, api: null, useApi: true, appStats: null, requireAppStats: false,
    pids: [], tree: [], names: [], pathLike: [], criticalNames: ['FrameConsole', 'mediamtx'] },
  stages: [1, 10, 50, 100, 300, 500, 1000],
  rampPerSec: 10, burst: false, burstConcurrency: 32, holdSec: 300, settleSec: null, keepBetweenStages: true, emptyWaitSec: 30,
  firstMediaTimeoutMs: 10000, sampleMs: 2000, resourceMs: 3000, stallKbps: 0, sustainedMinFraction: 0.95,
  // Full-rate check: every viewer must receive >= fullRateFraction of the reference rate of ITS quality (source or rendition).
  // Reference per quality, first available: the target's ingest rate of that path (MediaMTX API or app /api/stats),
  // plan.referenceKbps (number = source, or { "source": 8600, "720p": 4100 }), the rate measured at a first stage with <= 2
  // viewers of that quality. Without one the quality is "not measured" (never skipped as passing).
  fullRateFraction: 0.9, referenceKbps: null, rateWindowSec: 10, minSegmentSec: 4,
  lowRateKbps: 300,  // windows below this are reported as low-rate (audio alone is ~130-160 kbit/s; a 1 s GOP video is far above)
  churn: { perSec: 0, rejoinDelayMs: 0, minAgeSec: 10 },
  qualities: { source: 1 },
  // Mid-session quality change of the same viewer (its WebRTC source is replaced, as an ABR step): `fraction` of the
  // viewers present switch once, `atSec` into each hold, following `to`.
  qualitySwitch: { fraction: 0, atSec: 20, to: { source: '720p', '720p': '480p', '480p': 'source' } },
  chat: { fraction: 0, senderFraction: 0.05, messagesPerMinute: 6, reconnectMs: 0, connectTimeoutMs: 10000 },
  dvr: { fraction: 0, chunkMs: 4000, intervalMs: 4000, liveMarginMs: 5000 },
  generator: { instances: 1, apiPortBase: 21900, udpReadBufferSize: 4194304 },
  // Loopback relay of the WHEP signalling (lib/whep-tap.mjs): HTTP status and Retry-After of every offer per viewer.
  whepTap: { enabled: true, port: 21950 },
  limits: { generatorCpuPct: 90, hostCpuPct: 95, targetCpuPct: 90, sustainSec: 30, minSuccess: 0.9, successGraceSec: 20, minFullRate: 0.9, abortOnDegraded: true,
    maxTrafficGB: 50, projectTraffic: true, minFreeMemMB: 300, memSustainSec: 10, eventLoopLagMs: 1000, nicUtil: 0.8,
    max503Share: 0.1, min503Requests: 20, window503Sec: 30, sustain503Sec: 10, externalCpuPct: 25 },
  // mode "separate": the browser pages run in their own short phase after a stage's hold (the protocol viewers stay), so
  // they never disturb the hold's numbers; "inline": during the hold (startDelaySec after it starts).
  browser: { count: 0, url: null, seconds: 30, stages: null, devtoolsPort: 21222, headless: true, startDelaySec: 5, mode: 'separate', profiles: ['desktop'] },
  media: true,  // false: viewers hold only the chat socket (chat capacity without media, CHAT-01)
  calibrate: false,
  calibrateStages: [10, 25, 50, 75, 100, 150, 200, 300, 400, 500, 700, 1000],
  cleanupWaitSec: 30,
};

// ---------- plan ----------
const args = parseArgs(process.argv.slice(2));
const userPlan = args.plan ? readJson(resolve(args.plan)) : {};
const plan = merge(defaults, userPlan);
const stagesFromCli = args.stages !== undefined;
if (stagesFromCli) plan.stages = String(args.stages).split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);
for (const k of ['hold', 'holdSec']) if (args[k] !== undefined) plan.holdSec = Number(args[k]);
for (const k of ['name', 'rampPerSec', 'burst', 'calibrate', 'stallKbps', 'firstMediaTimeoutMs', 'generatorId']) if (args[k] !== undefined) plan[k] = args[k];
if (args.whep) plan.target.whep = args.whep;
if (args.base !== undefined) plan.target.base = args.base === 'none' ? null : args.base;
if (args.targetState) plan.target.stateFile = args.targetState;
if (args.targetApi !== undefined) { if (args.targetApi === 'none' || args.targetApi === false) plan.target.useApi = false; else plan.target.api = args.targetApi; }
if (args.appStats !== undefined) plan.target.appStats = args.appStats === 'none' ? null : args.appStats;
if (args.allowNoAppStats) plan.target.requireAppStats = false;
if (args.referenceKbps !== undefined) plan.referenceKbps = args.referenceKbps;
if (args.browser !== undefined) plan.browser.count = Number(args.browser);
if (args.browserMode) plan.browser.mode = args.browserMode;
if (args.browserProfiles) plan.browser.profiles = String(args.browserProfiles).split(',');
if (args.whepTap !== undefined) plan.whepTap.enabled = args.whepTap !== false && args.whepTap !== 'false';
if (args.maxTrafficGb) plan.limits.maxTrafficGB = Number(args.maxTrafficGb);
// --stages always wins, also over a calibration plan's own list.
if (plan.calibrate && !stagesFromCli) plan.stages = plan.calibrateStages;
if (plan.calibrate) plan.limits.minSuccess = Math.max(plan.limits.minSuccess, 0.9);
plan.settleSec ??= Math.ceil(plan.firstMediaTimeoutMs / 1000);
plan.generatorId = String(plan.generatorId || createHash('sha1').update(hostname()).digest('hex').slice(0, 4));
if (!/^[A-Za-z0-9]{1,8}$/.test(plan.generatorId)) { console.error('--generator-id must be 1-8 letters or digits (chat names are at most 20 characters)'); process.exit(2); }
// referenceKbps: 8600 | "source=8600,720p=4100" | { "source": 8600 }
plan.referenceKbps = (() => {
  const r = plan.referenceKbps;
  if (r === null || r === undefined || r === '') return null;
  if (typeof r === 'number') return { source: r };
  if (typeof r === 'string') return Object.fromEntries(r.split(',').map(x => x.split('=')).map(([q, v]) => (v === undefined ? ['source', Number(q)] : [q.trim(), Number(v)])));
  return r;
})();
// {host} in the plan's URLs is the sender PC (--host 192.168.0.10), so one plan file serves any address.
plan.target.host = args.host || plan.target.host || '127.0.0.1';
if (args.path) plan.target.path = String(args.path);  // the app's stream path (default screen-01)
for (const [obj, key] of [[plan.target, 'whep'], [plan.target, 'base'], [plan.target, 'appStats'], [plan.browser, 'url']]) if (typeof obj[key] === 'string') obj[key] = obj[key].replaceAll('{host}', plan.target.host);

let targetState = null;
if (plan.target.stateFile) {
  targetState = readJson(resolve(plan.target.stateFile));
  const t = plan.target;
  // The state file supplies URLs unless the plan or the command line names them (e.g. the proxy URL instead of direct WHEP).
  if (!args.whep && !userPlan.target?.whep) t.whep = targetState.urls.whepDirect;
  if (args.base === undefined && userPlan.target?.base === undefined) t.base = targetState.urls.base;
  if (t.useApi) t.api ??= targetState.urls.api;
  t.pids = [...new Set([...(t.pids || []), targetState.pids.mediamtx, targetState.pids.publisher, targetState.pids.shim].filter(Boolean))];  // shim = the target's node process (chat, DVR, WHEP proxy)
  t.tree = [...new Set([...(t.tree || []), targetState.pids.mediamtx])];  // on-demand quality encoders are its children
  t.path = targetState.options.path;
  plan.browser.url ??= targetState.urls.viewerPage;
}
if (!plan.target.useApi) plan.target.api = null;

if (plan.media && !plan.target.whep) { console.error('target.whep is not set (plan target.whep, --whep or --target-state)'); process.exit(2); }
if (!plan.media && !plan.target.base) { console.error('target.base is not set (chat-only run)'); process.exit(2); }

// The app's statistics are what make the degraded-quality stop and the reference rate work on a real-app run.
let appStatsCheck = null;
if (plan.target.appStats) {
  try {
    const r = await fetchJson(plan.target.appStats, {}, 5000);
    appStatsCheck = { ok: r.ok && r.body?.v === 1, status: r.status, v: r.body?.v ?? null, paths: r.body?.paths ? Object.keys(r.body.paths) : null };
  } catch (e) { appStatsCheck = { ok: false, error: e.message }; }
  if (!appStatsCheck.ok) {
    console.error(`target.appStats ${plan.target.appStats} did not answer with the v 1 contract: ${JSON.stringify(appStatsCheck)}`);
    if (plan.target.requireAppStats) {
      console.error('This plan requires it (reference rate, target session count, degraded-quality stop). To run without it anyway pass --allow-no-app-stats together with --reference-kbps source=<kbit/s>[,720p=...].');
      process.exit(2);
    }
  }
}
if (plan.media && plan.target.requireAppStats === false && userPlan.target?.requireAppStats && !plan.referenceKbps) {
  console.error('--allow-no-app-stats needs --reference-kbps (otherwise the degraded-quality stop has no reference)'); process.exit(2);
}

const stamp = localStamp();
const runId = `${stamp}-${plan.name}`;
const outRoot = args.out ? resolve(String(args.out)) : join(repo, 'verification', 'load');
const outDir = join(outRoot, runId);
const tmp = join(tmpdir(), `frame-load-${runId}`);
mkdirSync(outDir, { recursive: true });
mkdirSync(tmp, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- helpers ----------
const PHI = 0.6180339887;
const frac = x => x - Math.floor(x);
function pickQuality(i) {
  const entries = Object.entries(plan.qualities).filter(([, w]) => w > 0), sum = entries.reduce((a, [, w]) => a + w, 0);
  let x = frac(i * PHI) * sum;
  for (const [q, w] of entries) { if (x < w) return q; x -= w; }
  return entries[entries.length - 1][0];
}
const isSourceQ = q => q === 'source' || q === '';
const streamFor = q => (isSourceQ(q) ? plan.target.path : `${plan.target.path}/${q}`);
const qualityOfPath = name => (name === plan.target.path ? 'source' : name.startsWith(plan.target.path + '/') ? name.slice(plan.target.path.length + 1) : null);
const upstreamWhep = q => plan.target.whep.replace('{stream}', streamFor(q)).replace('{path}', plan.target.path);
let tap = null;
const sourceUrlFor = (v, q) => (tap ? tap.urlFor(v.name, upstreamWhep(q)) : upstreamWhep(q));
function linkMbps(s) { const m = String(s || '').match(/([\d.]+)\s*(G|M|K)bps/i); return m ? Number(m[1]) * { g: 1000, m: 1, k: 0.001 }[m[2].toLowerCase()] : null; }
// MediaMTX reports "0001-01-01T00:00:00Z" (or null) before a source is ready: only real times are times.
const validTime = s => typeof s === 'string' && !s.startsWith('0001-') && Number.isFinite(Date.parse(s)) && Date.parse(s) > Date.UTC(2000, 0, 1);
const counterDelta = (cur, prev) => (Number.isFinite(cur) && Number.isFinite(prev) && cur >= prev ? cur - prev : null);  // a smaller value = counter restarted: no rate
const pcts = (list, d = 0) => ({ n: list.filter(Number.isFinite).length, p50: round(percentile(list, 0.5), d), p95: round(percentile(list, 0.95), d), max: round(percentile(list, 1), d) });

async function resolveTree(list) {
  const out = [];
  for (const v of list || []) {
    if (typeof v === 'number') { out.push(v); continue; }
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `@(Get-Process -Name '${String(v).replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`], { encoding: 'utf8', windowsHide: true });
    out.push(...String(r.stdout).trim().split(',').filter(Boolean).map(Number));
  }
  return out;
}

// ---------- state ----------
const viewers = new Map();  // name -> viewer
const inflight = new Set(); // add operations not finished yet (cleanup waits for them before deleting)
let seq = 0, stageIndex = -1, stageN = 0, phase = 'init', abort = null, trafficBytes = 0, epoch = 0;
const samples = [], stages = [], saturation = [], sustained = {};
let lastRes = null, lastStats = null, genListMs = null, lastSampleAt = 0;
const refHist = {};       // quality -> [{ t, b }] cumulative ingest bytes of that path on the target (rolling reference)
const ingestTotal = {};   // quality -> { last, sum } monotonic sum over counter restarts
const measuredRef = {};   // quality -> { kbps, from } measured at a first stage with <= 2 viewers of it
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();

killOnExit({ signals: false });
const host = hostSpec();
const logical = cpus().length;
const nicLimit = Math.max(0, ...(host.nics || []).map(n => linkMbps(n.linkSpeed) || 0)) || null;
const versions = { node: process.version, generatorMediamtx: toolVersion(bin.mediamtx, ['--version']), target: targetState?.versions || null };

const resources = new Resources({ controlFile: join(tmp, 'sampler-control.json'), intervalMs: plan.resourceMs });
const critical = new Set();
resources.on(r => { lastRes = r; });

const generator = new Generator({ ...plan.generator, dir: outDir });
let info = null, chat = null, dvr = null, dvrSkipped = null;

function newViewer(requestedAt = Date.now()) {
  const i = seq++;
  const q = pickQuality(i);
  const v = { name: `v${String(i).padStart(5, '0')}`, i, inst: i % Math.max(1, plan.generator.instances), quality: q, initialQuality: q, stage: stageN, churn: false,
    chat: frac(i * PHI + 0.37) < plan.chat.fraction, sender: frac(i * 0.7548776662 + 0.11) < plan.chat.senderFraction, dvr: frac(i * PHI + 0.71) < plan.dvr.fraction,
    // requestedAt: when the join was due (ramp slot, burst start, churn re-join); addedAt: when the add request was sent
    requestedAt, addedAt: 0, addDoneAt: null, addOk: null, addStatus: null, apiMs: null, addError: null, addP: null,
    sessionStart: 0, firstAt: null, firstMs: null, firstBasis: null, firstBracketMs: null, staleReadyTimes: 0,
    ready: false, readyTime: null, mediaAt: null, lastBytes: 0, lastT: 0, totalBytes: 0, hist: [],
    disconnects: 0, reconnects: 0, removed: false, removedAt: null, h: null, sw: null };
  viewers.set(v.name, v);
  return v;
}

function addViewer(v) {
  const p = (async () => {
    v.addedAt = Date.now();
    v.sessionStart = v.addedAt;
    if (plan.media) {
      const r = await generator.add(v.name, sourceUrlFor(v, v.quality), v.inst);
      Object.assign(v, { addOk: r.ok, addStatus: r.status, apiMs: r.apiMs, addError: r.error, addDoneAt: Date.now() });
    }
    if (v.chat && chat) chat.open(v.name, v.sender);
    if (v.dvr && dvr) dvr.add(v.name);
  })();
  v.addP = p;
  inflight.add(p);
  p.then(() => inflight.delete(p), e => { inflight.delete(p); log('add error', v.name, e.message); });
  return p;
}

async function removeViewer(v) {
  if (v.removed) return;
  v.removed = true;
  v.removedAt = Date.now();
  if (v.addP) await v.addP;  // a delete sent before the add finished would leave the path (and its target session) behind
  chat?.close(v.name);
  dvr?.remove(v.name);
  if (plan.media) v.removeOk = await generator.remove(v.name, v.inst);
}

const active = () => [...viewers.values()].filter(v => !v.removed && v.addedAt);

// Adds at plan.rampPerSec (or all at once with limited concurrency in burst mode). Every viewer carries the time its join
// was requested, so queueing behind the concurrency limit is part of its first-media time.
async function addMany(count) {
  const t = Date.now();
  if (plan.burst) {
    const list = Array.from({ length: count }, () => newViewer(t));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(plan.burstConcurrency, list.length) }, async () => { while (next < list.length && !abort) await addViewer(list[next++]); }));
    return;
  }
  const gap = 1000 / Math.max(0.1, plan.rampPerSec), pending = [];
  for (let k = 0; k < count && !abort; k++) {
    const due = t + k * gap;
    if (due > Date.now()) await sleep(due - Date.now());
    pending.push(addViewer(newViewer(due)));
  }
  await Promise.all(pending);
}

async function sleepUnlessAbort(ms) { for (const end = Date.now() + ms; Date.now() < end && !abort; ) await sleep(Math.min(500, end - Date.now())); }

// ---------- sampling ----------
const newSeg = q => ({ quality: q, windows: 0, observedMs: 0, bytes: 0 });
function holdWindowStart(v) { v.h = { stage: stageN, windows: 0, receiving: 0, low: 0, stalls: 0, stallMs: 0, observedMs: 0, bytes: 0, stallEvents: 0, inStall: false, switchGapMs: 0, segs: [], seg: newSeg(v.quality) }; }

// Target statistics, normalised: the standalone target's MediaMTX API and/or the app's /api/stats (contract v 1).
async function targetStatsSample() {
  const out = { t: Date.now(), via: [], sessions: null, established: null, perSession: null, pathsIn: null, sendBytes: null, app: null };
  if (plan.target.api) {
    try {
      const items = [];
      for (let page = 0, pages = 1; page < pages; page++) {
        const r = await fetchJson(`${plan.target.api}/v3/webrtcsessions/list?itemsPerPage=1000&page=${page}`, {}, 5000);
        if (!r.ok) throw new Error(`status ${r.status}`);
        pages = r.body.pageCount || 1;
        items.push(...r.body.items);
      }
      out.sessions = items.length;
      out.established = items.filter(s => s.peerConnectionEstablished).length;
      out.perSession = new Map(items.map(s => [s.id, { discarded: s.outboundFramesDiscarded || 0, out: s.outboundBytes ?? s.bytesSent ?? 0 }]));
      const p = await fetchJson(`${plan.target.api}/v3/paths/list?itemsPerPage=1000`, {}, 3000);
      if (p.ok) out.pathsIn = new Map((p.body.items || []).map(x => [x.name, x.inboundBytes ?? x.bytesReceived ?? 0]));
      out.via.push('mediamtx-api');
    } catch {}
  }
  if (plan.target.appStats) {
    try {
      const r = await fetchJson(plan.target.appStats, {}, 3000);
      if (r.ok && r.body?.v === 1) {
        out.app = r.body;
        out.via.push('app-stats');
        // Without the MediaMTX API the app's own snapshot time is the clock of every delta: the app caches /api/stats for
        // 1 s, so a repeated snapshot gives dt = 0 (no rate) instead of a false zero ingest rate.
        if (!out.via.includes('mediamtx-api') && Number.isFinite(r.body.timeMs)) out.t = r.body.timeMs;
        if (out.sessions === null) out.sessions = r.body.webrtc?.sessions ?? null;
        if (out.pathsIn === null) out.pathsIn = new Map(Object.entries(r.body.paths || {}).map(([name, x]) => [name, x.bytesReceived ?? null]));
        out.sendBytes = r.body.webrtc?.bytesSent ?? null;
      }
    } catch {}
  }
  return out.via.length ? out : null;
}

// Rolling reference of one quality: target ingest of its path over the last rateWindowSec, else the plan / stage-1 value.
function liveRef(q) {
  const h = refHist[q];
  // An idle path (on-demand quality nobody watches yet) has ingest 0: that is no reference, never a pass for everything.
  if (h && h.length >= 2) { const a = h[0], b = h[h.length - 1]; if (b.t - a.t >= plan.rateWindowSec * 800) { const k = (b.b - a.b) * 8 / (b.t - a.t); if (k > 0) return k; } }
  return plan.referenceKbps?.[q] ?? measuredRef[q]?.kbps ?? null;
}
function liveKbps(v) {
  const h = v.hist;
  if (h.length < 2) return null;
  const a = h[0], b = h[h.length - 1];
  return b.t - a.t >= plan.rateWindowSec * 800 ? (b.b - a.b) * 8 / (b.t - a.t) : null;
}
function pushRolling(h, t, b) { h.push({ t, b }); while (h.length > 2 && h[h.length - 1].t - h[1].t >= plan.rateWindowSec * 1000) h.shift(); }

function noteSaturation(kind, detail) {
  if (saturation.find(s => s.kind === kind)) return;
  saturation.push({ kind, stage: stageN, phase, t: new Date().toISOString(), detail });
  log('saturation:', kind, JSON.stringify(detail));
}

// A condition that must hold for `sec` seconds before it aborts the run.
function sustain(key, cond, sec) {
  if (!cond) { delete sustained[key]; return false; }
  sustained[key] ??= Date.now();
  return Date.now() - sustained[key] >= sec * 1000;
}

function setAbort(reason, detail) { if (!abort) { abort = { reason, stage: stageN, phase, t: new Date().toISOString(), detail }; log('ABORT:', reason, JSON.stringify(detail || {})); } }

// One viewer's state from its generator path. A viewer has media only when its path is ready, has tracks and has received
// bytes; the first-media time is the path's ready time (MediaMTX: tracks gathered = first RTP) when that time is real and
// not before the request of the current session, otherwise the sample clock (flagged as such, never silently).
function updateViewer(v, it, now) {
  const tracks = it ? (Array.isArray(it.tracks2) ? it.tracks2.length : (it.tracks || []).length) : 0;
  const bytes = it ? (it.inboundBytes ?? it.bytesReceived ?? 0) : null;
  const readyNow = !!(it && it.ready && tracks > 0 && bytes > 0);
  const rt = it && validTime(it.readyTime) ? Date.parse(it.readyTime) : null;
  const own = rt !== null && rt >= v.sessionStart - CLOCK_TOL_MS;
  const switching = v.sw && v.sw.doneAt === null && !v.sw.failed;
  const dt = v.lastT ? now - v.lastT : 0;
  // A path counter that went down was restarted with the source (quality switch, reconnect): count from zero.
  const delta = bytes === null ? 0 : bytes >= v.lastBytes ? bytes - v.lastBytes : bytes;
  if (bytes !== null) v.lastBytes = bytes;
  const prevT = v.lastT || v.addedAt;
  v.lastT = now;
  v.totalBytes += delta;
  if (readyNow && rt !== null && !own) v.staleReadyTimes++;  // the old session of a switch, or a time before the request
  // While a quality switch is pending, a ready state with a real time from before the switch is the OLD session.
  const mediaOfThisSession = readyNow && (own || rt === null || !switching);
  if (mediaOfThisSession) {
    if (v.mediaAt === null) {
      const at = own ? rt : now, basis = own ? 'ready-time' : rt === null ? 'sample-clock (no ready time)' : 'sample-clock (ready time before the request)';
      v.mediaAt = at;
      v.readyTime = own ? it.readyTime : null;
      if (v.firstAt === null) { v.firstAt = at; v.firstMs = at - v.requestedAt; v.firstBasis = basis; if (!own) v.firstBracketMs = now - prevT; }
      else if (switching) { v.sw.doneAt = at; v.sw.ms = at - v.sw.requestedAt; v.sw.basis = basis; v.hist = []; }
      else if (v.sw?.failed && !own && rt !== null) v.sw.oldSessionKept = true;  // the switch never took effect: still the old session
      else v.reconnects++;  // media again after a loss (MediaMTX restarted the source by itself)
    } else if (own && v.readyTime === null) {
      v.readyTime = it.readyTime;  // zero-year -> real time of the same session: not a reconnect
    } else if (own && v.readyTime !== null && it.readyTime !== v.readyTime) {
      v.disconnects++; v.reconnects++; v.readyTime = it.readyTime; v.mediaAt = rt;  // restarted between two samples
    }
    v.ready = true;
  } else if (v.ready && !switching) {
    v.disconnects++;
    v.ready = false;
    v.mediaAt = null;
  } else if (!readyNow) {
    v.ready = false;
  }
  if (switching && now - v.sw.requestedAt >= plan.firstMediaTimeoutMs && v.sw.doneAt === null) { v.sw.failed = true; v.ready = false; v.mediaAt = null; }
  return { delta, dt, readyNow };
}

async function sampleOnce() {
  const t0 = Date.now();
  const { ok, items, failed } = plan.media ? await generator.list() : { ok: true, items: new Map(), failed: new Set() };
  genListMs = Date.now() - t0;
  const now = Date.now();
  let readyCount = 0, receivingNow = 0, eligible = 0, receivingEligible = 0, totalDelta = 0, stalledNow = 0, frJudged = 0, frOk = 0, inSwitch = 0;
  const kbps = [], kbpsSrc = [];
  for (const v of plan.media ? viewers.values() : []) {
    if (v.removed || !v.addedAt) continue;
    if (failed.has(v.inst % generator.instances.length)) continue;  // no list from its generator instance in this sample
    const { delta, dt, readyNow } = updateViewer(v, items.get(v.name), now);
    if (readyNow) readyCount++;
    if (!dt) continue;
    trafficBytes += delta;
    totalDelta += delta;
    const rate = delta * 8 / dt;  // kbit/s
    const receiving = delta > 0 && rate > plan.stallKbps;
    if (receiving) receivingNow++;
    // Windows wholly after the first media count (a disconnect later is a stall); a window overlapping a planned quality
    // switch (request -> first media of the new quality) is the switch gap, measured separately.
    const gap = v.sw && v.sw.requestedAt < now && (v.sw.doneAt === null ? !v.sw.failed : v.sw.doneAt > now - dt);
    if (gap) inSwitch++;
    const full = v.firstAt !== null && v.firstAt <= now - dt && !gap;
    if (full) { kbps.push(rate); if (isSourceQ(v.quality)) kbpsSrc.push(rate); pushRolling(v.hist, now, v.totalBytes); }
    if (now - v.addedAt >= plan.firstMediaTimeoutMs && !gap) { eligible++; if (receiving) receivingEligible++; }
    if (full) {
      const lk = liveKbps(v), ref = liveRef(v.quality);
      if (lk !== null && ref) { frJudged++; if (lk >= plan.fullRateFraction * ref) frOk++; }
    }
    if (v.h && phase === 'hold') {
      if (gap) { v.h.switchGapMs += dt; continue; }
      if (!full) continue;
      v.h.windows++; v.h.observedMs += dt; v.h.bytes += delta;
      v.h.seg.windows++; v.h.seg.observedMs += dt; v.h.seg.bytes += delta;
      if (rate < plan.lowRateKbps) v.h.low++;
      if (receiving) { v.h.receiving++; v.h.inStall = false; }
      else { v.h.stalls++; v.h.stallMs += dt; if (!v.h.inStall) v.h.stallEvents++; v.h.inStall = true; stalledNow++; }
    }
  }
  if (!plan.media && chat) {
    // Chat-only run: a viewer 'receives' while its socket is joined to the room.
    const c = chat.counts();
    receivingNow = c.joined; eligible = active().filter(v => now - v.addedAt >= plan.firstMediaTimeoutMs).length; receivingEligible = Math.min(eligible, c.joined);
  }
  const lagP99 = lag.percentile(99) / 1e6, lagMax = lag.max / 1e6;
  lag.reset();
  const ts = await targetStatsSample();
  let send = null, disc = null, sessions = null, appRows = {};
  const ingestKbps = {};
  if (ts) {
    sessions = ts.sessions;
    const prev = lastStats;
    const dt = prev ? ts.t - prev.t : 0;
    if (prev && dt > 0) {
      if (ts.perSession && prev.perSession) {
        // Per-session deltas: sessions that ended must not turn the sums negative.
        let out = 0, d = 0;
        for (const [id, s] of ts.perSession) { const b = prev.perSession.get(id) || { discarded: 0, out: 0 }; out += Math.max(0, s.out - b.out); d += Math.max(0, s.discarded - b.discarded); }
        send = out * 8 / dt / 1000; disc = d;
      } else if (ts.sendBytes !== null) { const d = counterDelta(ts.sendBytes, prev.sendBytes); send = d === null ? null : d * 8 / dt / 1000; }
      if (ts.pathsIn && prev.pathsIn) for (const [name, b] of ts.pathsIn) { const q = qualityOfPath(name); const d = counterDelta(b, prev.pathsIn.get(name)); if (q && d !== null) ingestKbps[q] = round(d * 8 / dt, 0); }
      if (ts.app && prev.app) {
        appRows = { appHttpRefused: counterDelta(ts.app.http?.refused, prev.app.http?.refused), appChatRefused: counterDelta(ts.app.chat?.refused, prev.app.chat?.refused),
          // The app counts MediaMTX "reader is too slow, discarding frames" lines: the target dropping frames of slow readers.
          appDiscardWarnings: counterDelta(ts.app.mediaDiscardWarnings, prev.app.mediaDiscardWarnings) };
      }
    }
    if (ts.app) {
      Object.assign(appRows, { appRunning: ts.app.running ?? null, appHttpThreads: ts.app.http?.threads ?? null, appHttpRequests: ts.app.http?.requests ?? null, appChatClients: ts.app.chat?.clients ?? null, appChatJoined: ts.app.chat?.joined ?? null, appSourceReaders: ts.app.paths?.[plan.target.path]?.readers ?? null, appSourceReady: ts.app.paths?.[plan.target.path]?.ready ?? null });
      if (ts.app.running === false && phase !== 'cleanup') setAbort('target-not-running', { via: 'app-stats', running: false });
    }
    if (ts.pathsIn) for (const [name, b] of ts.pathsIn) {
      const q = qualityOfPath(name);
      if (!q || !Number.isFinite(b)) continue;
      const it = ingestTotal[q] ??= { last: b, sum: 0 };
      it.sum += b >= it.last ? b - it.last : b;
      it.last = b;
      pushRolling(refHist[q] ??= [], ts.t, it.sum);
    }
    lastStats = ts;
  }
  const tapWin = tap ? tap.window(lastSampleAt || now - plan.sampleMs, now) : null;
  const tapRoll = tap ? tap.window(now - plan.limits.window503Sec * 1000, now) : null;
  const r = lastRes;
  const nicMax = r ? Math.max(0, ...r.nics.map(n => Math.max(n.rxMbps || 0, n.txMbps || 0))) : null;
  // Host CPU not attributed to the generator, the target or the browser sampler: other programs on this PC (and kernel
  // network time the test itself causes, which no process is charged with).
  const unattributed = r && r.host.cpuPct !== null ? round(r.host.cpuPct - (r.gen.cpuPct || 0) - (r.target.cpuPct || 0) - (r.browser.cpuPct || 0)) : null;
  const row = {
    t: new Date(now).toISOString(), elapsedS: round((now - runStart) / 1000, 1), stage: stageN, phase, requested: active().length,
    ready: readyCount, receiving: receivingNow, receivingRatio: eligible ? round(receivingEligible / eligible, 3) : null, eligible, stalled: stalledNow, inSwitch,
    fullRateLive: frJudged ? round(frOk / frJudged, 3) : null, fullRateJudged: frJudged, refSourceKbps: round(liveRef('source'), 0),
    totalMbps: round(totalDelta * 8 / Math.max(1, lastSampleAt ? now - lastSampleAt : plan.sampleMs) / 1000, 1), perViewerKbpsP50: round(percentile(kbps, 0.5), 0), perViewerKbpsP5: round(percentile(kbps, 0.05), 0), perViewerKbpsSrcP50: round(percentile(kbpsSrc, 0.5), 0),
    trafficGB: round(trafficBytes / 1e9, 3), genListMs, genApiOk: ok, lagP99Ms: round(lagP99, 1), lagMaxMs: round(lagMax, 1),
    genCpuPct: r?.gen.cpuPct ?? null, genCores: r?.gen.cores ?? null, genRssMB: r?.gen.rssMB ?? null, browserCpuPct: r?.browser.cpuPct ?? null,
    targetCpuPct: r?.target.cpuPct ?? null, targetCores: r?.target.cores ?? null, targetRssMB: r?.target.rssMB ?? null, targetProcs: r?.target.count ?? null,
    hostCpuPct: r?.host.cpuPct ?? null, unattributedCpuPct: unattributed, hostMemUsedPct: r?.host.memUsedPct ?? null, freeMemMB: round(freeMB(), 0),
    nicRxMbps: r ? round(r.nics.reduce((a, n) => a + (n.rxMbps || 0), 0)) : null, nicTxMbps: r ? round(r.nics.reduce((a, n) => a + (n.txMbps || 0), 0)) : null,
    gpuPct: r?.gpu?.util ?? null, gpuEncPct: r?.gpu?.enc ?? null, gpuDecPct: r?.gpu?.dec ?? null,
    statsVia: ts ? ts.via.join('+') : null, targetSessions: sessions, targetSendMbps: round(send), targetDiscardedFrames: disc, sourceKbps: ingestKbps.source ?? null, ingestKbps,
    ...appRows,
    whepPosts: tapWin ? tapWin.posts : null, whep503: tapWin ? tapWin.status503 : null, whep503ShareRolling: tapRoll ? tapRoll.share503 : null, whepPostsRolling: tapRoll ? tapRoll.posts : null,
    chatOpen: chat ? chat.counts().open : null, chatJoined: chat ? chat.counts().joined : null, dvrChunks: dvr ? dvr.w.chunks : null, dvrErrors: dvr ? dvr.w.errors : null,
    lostPackets: lossTotal(),
  };
  samples.push(row);
  lastSampleAt = now;
  checkLimits(row, r, nicMax);
  if (samples.length % 5 === 1 || phase !== 'hold') log(`[${stageN} ${phase}] req ${row.requested} ready ${readyCount} recv ${receivingNow} ratio ${row.receivingRatio} fullRate ${row.fullRateLive ?? '-'}/${frJudged} ${row.totalMbps} Mbps | gen ${row.genCpuPct}% target ${row.targetCpuPct}% host ${row.hostCpuPct}% other ${unattributed}% free ${row.freeMemMB} MB | lag ${row.lagP99Ms} ms${ts ? ` | ${row.statsVia} ${sessions} sess${disc !== null ? ` disc ${disc}` : ''} src ${row.sourceKbps ?? '-'} kbps` : ''}${tap ? ` | whep 503 ${row.whep503}/${row.whepPosts}` : ''}${chat ? ` | chat ${row.chatJoined}` : ''}`);
}

function freeMB() { return freemem() / 2 ** 20; }

function lossTotal() { let s = 0; for (const n of generator.loss.values()) s += n; return s; }

function checkLimits(row, r, nicMax) {
  const L = plan.limits;
  if (r) {
    if (r.gen.cpuPct > L.generatorCpuPct) noteSaturation('generator-cpu', { genCpuPct: r.gen.cpuPct });
    if (r.host.cpuPct > L.hostCpuPct) noteSaturation('host-cpu', { hostCpuPct: r.host.cpuPct, genCpuPct: r.gen.cpuPct, targetCpuPct: r.target.cpuPct, unattributedCpuPct: row.unattributedCpuPct });
    if (r.target.cpuPct > L.targetCpuPct) noteSaturation('target-cpu', { targetCpuPct: r.target.cpuPct });
    if (nicLimit && nicMax > L.nicUtil * nicLimit) noteSaturation('nic', { mbps: nicMax, linkMbps: nicLimit });
    if (r.gpu && r.gpu.enc > 90) noteSaturation('gpu-encoder', { enc: r.gpu.enc });
    if (sustain('gen-cpu', r.gen.cpuPct > L.generatorCpuPct, L.sustainSec)) setAbort('generator-cpu', { genCpuPct: r.gen.cpuPct, sustainSec: L.sustainSec });
    if (sustain('host-cpu', r.host.cpuPct > L.hostCpuPct, L.sustainSec)) setAbort('host-cpu', { hostCpuPct: r.host.cpuPct, genCpuPct: r.gen.cpuPct, targetCpuPct: r.target.cpuPct, unattributedCpuPct: row.unattributedCpuPct, note: 'generator (and a same-PC target) share this host' });
    for (const d of r.targetGone) if (critical.has(d.id) || plan.target.criticalNames.includes(d.name)) setAbort('target-process-died', d);
  }
  // External load: a busy PC makes the stage's numbers say little about the target (flagged per stage, not a stop).
  if (sustain('external', row.unattributedCpuPct > L.externalCpuPct, L.sustainSec / 3)) noteSaturation('external-load', { unattributedCpuPct: row.unattributedCpuPct, hostCpuPct: row.hostCpuPct, genCpuPct: row.genCpuPct, targetCpuPct: row.targetCpuPct });
  if (row.freeMemMB && row.freeMemMB < L.minFreeMemMB) noteSaturation('host-memory', { freeMemMB: row.freeMemMB });
  if (sustain('mem', row.freeMemMB && row.freeMemMB < L.minFreeMemMB, L.memSustainSec)) setAbort('host-memory', { freeMemMB: row.freeMemMB });
  if (row.lagP99Ms > L.eventLoopLagMs) noteSaturation('generator-event-loop', { lagP99Ms: row.lagP99Ms });
  if (sustain('lag', row.lagP99Ms > L.eventLoopLagMs, L.sustainSec)) setAbort('generator-event-loop', { lagP99Ms: row.lagP99Ms });
  if (row.targetDiscardedFrames > 0) noteSaturation('target-discarding-frames', { frames: row.targetDiscardedFrames, sessions: row.targetSessions });
  if (row.appDiscardWarnings > 0) noteSaturation('target-discarding-frames', { appDiscardWarnings: row.appDiscardWarnings, sessions: row.targetSessions, via: 'app-stats mediaDiscardWarnings' });
  if (genListMs > 5000 || !row.genApiOk) noteSaturation('generator-api-slow', { listMs: genListMs, ok: row.genApiOk });
  if (generator.dead().length) setAbort('generator-died', { instances: generator.dead() });
  if (trafficBytes / 1e9 >= L.maxTrafficGB) setAbort('traffic-cap', { trafficGB: round(trafficBytes / 1e9, 2), capGB: L.maxTrafficGB });
  // Refusals: share of WHEP offers answered 503 in the last window503Sec (needs min503Requests offers in the window).
  const busy = row.whepPostsRolling >= L.min503Requests && row.whep503ShareRolling >= L.max503Share;
  if (busy) noteSaturation('whep-503', { share: row.whep503ShareRolling, posts: row.whepPostsRolling });
  if (sustain('503', busy, L.sustain503Sec)) setAbort('whep-503-share', { share: row.whep503ShareRolling, posts: row.whepPostsRolling, max: L.max503Share, windowSec: L.window503Sec });
  const measuring = phase === 'hold' || phase === 'settle';
  if (measuring && row.receivingRatio !== null && row.receivingRatio < L.minSuccess) noteSaturation('receiving-below-min', { ratio: row.receivingRatio, eligible: row.eligible });
  // Degraded quality: share of viewers whose rolling rate is >= fullRateFraction of their quality's reference.
  const degraded = measuring && row.fullRateJudged > 0 && row.fullRateLive < L.minFullRate;
  if (degraded) noteSaturation('viewers-below-reference-rate', { fullRateLive: row.fullRateLive, judged: row.fullRateJudged, refSourceKbps: row.refSourceKbps });
  if (sustain('degraded', degraded && L.abortOnDegraded, L.successGraceSec)) setAbort('degraded-below-min', { fullRateLive: row.fullRateLive, min: L.minFullRate, judged: row.fullRateJudged, refSourceKbps: row.refSourceKbps, note: `share of viewers at >= ${plan.fullRateFraction * 100}% of their quality's reference rate (rolling ${plan.rateWindowSec} s)` });
  if (sustain('success', measuring && row.receivingRatio !== null && row.receivingRatio < L.minSuccess, L.successGraceSec)) setAbort('success-below-min', { ratio: row.receivingRatio, min: L.minSuccess, eligible: row.eligible });
}

// ---------- stage summary ----------
function errorSnapshot() { return { kinds: { ...generator.errorKinds }, lossLines: generator.lossLines }; }
function errorDelta(s0) {
  const out = {};
  for (const [k, n] of Object.entries(generator.errorKinds)) { const d = n - (s0.kinds[k] || 0); if (d > 0) out[k] = d; }
  return out;
}

function refFor(q, hr) {
  const vals = hr.map(r => r.ingestKbps?.[q]).filter(x => Number.isFinite(x) && x > 0);  // 0 = the path was idle in that sample
  if (vals.length) return { kbps: mean(vals), from: `target ingest rate of ${streamFor(q)} (${hr.find(r => r.statsVia)?.statsVia})`, samples: vals.length };
  if (plan.referenceKbps?.[q]) return { kbps: plan.referenceKbps[q], from: 'plan.referenceKbps' };
  if (measuredRef[q]) return measuredRef[q];
  return null;
}

function summarize(stage, holdFrom, holdTo, rows, extra) {
  // Without churn: the viewers present for the whole hold. With churn nobody stays the whole hold, so every viewer session
  // seen in the hold is judged over its own windows and the rates are per session (denominator = sessions measured).
  const churning = plan.churn.perSec > 0;
  const T = plan.firstMediaTimeoutMs;
  const inHold = [...viewers.values()].filter(v => v.h && v.h.stage === stage && (churning ? v.h.windows > 0 || (v.addedAt <= holdTo - T && v.addedAt >= holdFrom) : v.addedAt < holdFrom && (!v.removed || v.removedAt >= holdTo)));
  const denom = churning ? Math.max(1, inHold.length) : stage;
  const joined = [...viewers.values()].filter(v => v.stage === stage && v.addedAt);
  // First media (from the join request, queueing included). A viewer without first media is a timeout only once the
  // timeout has passed by the end of the hold or by its removal; younger ones are pending (H).
  const evalAt = v => (v.removed ? Math.min(v.removedAt, holdTo) : holdTo);
  const firsts = joined.map(v => v.firstMs).filter(x => x !== null);
  const timeouts = joined.filter(v => (v.firstMs !== null && v.firstMs > T) || (v.firstMs === null && evalAt(v) - v.requestedAt >= T));
  const pending = joined.filter(v => v.firstMs === null && evalAt(v) - v.requestedAt < T);
  const byBasis = {};
  for (const v of joined) if (v.firstBasis) byBasis[v.firstBasis] = (byBasis[v.firstBasis] || 0) + 1;
  const tapOf = v => (tap ? tap.viewers.get(v.name) : null);
  const sustainedOk = v => v.firstAt !== null && v.h.windows > 0 && v.h.receiving / v.h.windows >= plan.sustainedMinFraction;
  const observed = inHold.reduce((a, v) => a + v.h.observedMs, 0), stalled = inHold.reduce((a, v) => a + v.h.stallMs, 0);
  const perKbps = inHold.filter(v => v.h.observedMs > 0).map(v => v.h.bytes * 8 / v.h.observedMs);
  const hr = rows.filter(r => r.phase === 'hold');
  const pick = k => hr.map(r => r[k]).filter(x => x !== null && x !== undefined && Number.isFinite(x));
  const churnJoins = [...viewers.values()].filter(v => v.churn && v.addedAt >= holdFrom && v.addedAt <= holdTo);
  const chatS = chat ? chat.summary() : null, dvrS = dvr ? dvr.summary() : null;
  const pairs = {};
  for (const v of inHold) { const p = generator.pairs.get(v.name); if (!p) continue; const k = p.split(' -> ').map(candidateClass).join(' -> '); pairs[k] = (pairs[k] || 0) + 1; }
  const lossInHold = extra.lossEnd - extra.lossStart;
  const lossPerViewerMin = inHold.length && observed ? lossInHold / (observed / 60000) : null;
  const avgKbps = mean(perKbps);
  // ~1,150 payload bytes per RTP packet (FFmpeg -pkt_size 1200) to turn the byte rate into an estimated packet count.
  const estPackets = avgKbps ? inHold.reduce((a, v) => a + v.h.bytes, 0) / 1150 : null;
  // Full rate (D): every segment of a viewer (one per quality it watched in the hold) against the reference of that quality.
  const segsOf = v => [...v.h.segs, v.h.seg].filter(s => s.observedMs >= plan.minSegmentSec * 1000);
  const qualities = [...new Set([...inHold.flatMap(v => [...v.h.segs, v.h.seg].map(s => s.quality)), ...Object.keys(plan.qualities).filter(q => plan.qualities[q] > 0)])];
  const ref = Object.fromEntries(qualities.map(q => [q, refFor(q, hr)]));
  const segRatio = s => (ref[s.quality]?.kbps > 0 ? s.bytes * 8 / s.observedMs / ref[s.quality].kbps : null);
  const judge = v => {
    if (!sustainedOk(v)) return false;
    const segs = segsOf(v);
    // Receiving, but every quality segment is shorter than minSegmentSec (a churn session at the hold edge): too short to
    // judge a rate, so left out of the full-rate denominator (fullRateTooShort) instead of counted as a failure.
    if (!segs.length) return 'short';
    if (segs.some(s => !ref[s.quality])) return null;
    return segs.every(s => segRatio(s) >= plan.fullRateFraction);
  };
  const verdicts = inHold.map(judge);
  const unjudged = verdicts.filter(x => x === null).length, fullCount = verdicts.filter(x => x === true).length, tooShort = verdicts.filter(x => x === 'short').length;
  const missingRef = qualities.filter(q => !ref[q] && inHold.some(v => segsOf(v).some(s => s.quality === q)));
  const byQuality = Object.fromEntries(qualities.map(q => {
    const segs = inHold.flatMap(v => segsOf(v).filter(s => s.quality === q));
    const ratios = segs.map(segRatio).filter(Number.isFinite);
    return [q, { segments: segs.length, kbpsP50: round(percentile(segs.map(s => s.bytes * 8 / s.observedMs), 0.5), 0), referenceKbps: ref[q] ? round(ref[q].kbps, 0) : NOT, referenceFrom: ref[q]?.from ?? NOT,
      ratioP5: round(percentile(ratios, 0.05), 3), ratioP50: round(percentile(ratios, 0.5), 3), belowFraction: ratios.filter(x => x < plan.fullRateFraction).length }];
  }));
  const srcRatios = inHold.flatMap(v => segsOf(v).filter(s => isSourceQ(s.quality))).map(segRatio).filter(Number.isFinite);
  const switches = [...viewers.values()].filter(v => v.sw && v.sw.stage === stage);
  const tapStage = tap ? tap.window(extra.stageStart, holdTo) : null;
  const unattr = pick('unattributedCpuPct');
  const extMean = mean(unattr);
  return {
    stage, requested: stage, holdSec: round((holdTo - holdFrom) / 1000, 1), measuredViewers: inHold.length,
    joined: joined.length, notStarted: [...viewers.values()].filter(v => v.stage === stage && !v.addedAt).length, addFailed: joined.filter(v => v.addOk === false).length, addApiMsP95: percentile(joined.map(v => v.apiMs), 0.95),
    firstMediaMs: plan.media ? { ...pcts(firsts), basis: byBasis, sampleClockErrorMs: `<= ${plan.sampleMs} (sample-clock basis only)`, readyTimeOnly: pcts(joined.filter(v => v.firstBasis === 'ready-time').map(v => v.firstMs)),
      from: plan.burst ? 'burst start (all joins of the stage requested at once)' : 'the join\'s ramp slot', components: {
        queueMs: pcts(joined.map(v => v.addedAt - v.requestedAt)), addApiMs: pcts(joined.map(v => v.apiMs)),
        whepAnswerMs: tap ? pcts(joined.map(v => { const t = tapOf(v); return t?.okAt ? t.okAt - v.addedAt : null; })) : NOT,
        mediaAfterAnswerMs: tap ? pcts(joined.map(v => { const t = tapOf(v); return t?.okAt && v.firstAt ? v.firstAt - t.okAt : null; })) : NOT } } : NOT,
    firstMediaTimeouts: plan.media ? timeouts.length : NOT, firstMediaPending: plan.media ? pending.length : NOT,
    firstMediaFromSampleClock: plan.media ? joined.filter(v => v.firstBasis && v.firstBasis !== 'ready-time').length : NOT,
    sustainedReceiving: plan.media ? inHold.filter(sustainedOk).length : chatS?.joined ?? 0, successRate: round((plan.media ? inHold.filter(sustainedOk).length : chatS?.joined ?? 0) / denom, 4), successBasis: churning ? 'viewer sessions seen in the hold (churn)' : 'requested viewers',
    fullRateSuccessRate: !plan.media ? NOT : unjudged ? `${NOT} (no reference rate for ${missingRef.join(', ')})` : round(fullCount / Math.max(1, denom - tooShort), 4),
    fullRateUnjudged: plan.media ? unjudged : NOT, fullRateTooShort: plan.media ? tooShort : NOT, fullRateByQuality: plan.media ? byQuality : NOT,
    referenceKbps: ref.source ? round(ref.source.kbps, 0) : NOT, referenceFrom: ref.source ? ref.source.from : NOT,
    reference: Object.fromEntries(Object.entries(ref).map(([q, r]) => [q, r ? { kbps: round(r.kbps, 0), from: r.from } : NOT])),
    receivingRatio: { min: hr.length && pick('receivingRatio').length ? Math.min(...pick('receivingRatio')) : null, mean: round(mean(pick('receivingRatio')), 3) },
    fullRateLive: { min: pick('fullRateLive').length ? Math.min(...pick('fullRateLive')) : null, mean: round(mean(pick('fullRateLive')), 3) },
    stallTimeRatio: observed ? round(stalled / observed, 5) : null,
    lowRateWindowRatio: inHold.length ? round(inHold.reduce((a, v) => a + v.h.low, 0) / Math.max(1, inHold.reduce((a, v) => a + v.h.windows, 0)), 4) : null, stallEvents: inHold.reduce((a, v) => a + v.h.stallEvents, 0), viewersWithStall: inHold.filter(v => v.h.stalls > 0).length,
    // Memory slope over the hold (MB per minute, least squares): a steady climb at constant load points at a leak.
    rssTrendMBPerMin: { generator: slope(hr, 'genRssMB'), target: slope(hr, 'targetRssMB') },
    disconnects: inHold.reduce((a, v) => a + v.disconnects, 0), reconnects: inHold.reduce((a, v) => a + v.reconnects, 0), staleReadyTimes: joined.reduce((a, v) => a + v.staleReadyTimes, 0),
    perViewerKbps: { p5: round(percentile(perKbps, 0.05), 0), p50: round(percentile(perKbps, 0.5), 0), p95: round(percentile(perKbps, 0.95), 0), mean: round(avgKbps, 0) },
    totalMbps: { mean: round(mean(pick('totalMbps')), 1), max: round(Math.max(0, ...pick('totalMbps')), 1) },
    sourceKbps: ref.source && ref.source.samples ? round(ref.source.kbps, 0) : NOT,
    rateVsSource: ref.source ? { p5: round(percentile(srcRatios, 0.05), 3), p50: round(percentile(srcRatios, 0.5), 3), degradedViewers: srcRatios.filter(x => x < plan.fullRateFraction).length } : NOT,
    rtpPacketsLost: lossInHold, lostPerViewerMinute: round(lossPerViewerMin, 1), lossRatioEst: estPackets ? round(lossInHold / (estPackets + lossInHold), 5) : null,
    processingErrors: [...generator.procErrors.values()].reduce((a, b) => a + b, 0) - extra.procStart,
    iceCandidatePairs: pairs,
    churn: churning ? { leaves: extra.churnLeaves, joins: churnJoins.length, rejoinsSkippedAtHoldEnd: extra.churnSkipped, joinFirstMediaMs: { p50: percentile(churnJoins.map(v => v.firstMs), 0.5), p95: percentile(churnJoins.map(v => v.firstMs), 0.95) },
      joinTimeouts: churnJoins.filter(v => (v.firstMs !== null && v.firstMs > T) || (v.firstMs === null && evalAt(v) - v.requestedAt >= T)).length, joinPending: churnJoins.filter(v => v.firstMs === null && evalAt(v) - v.requestedAt < T).length } : null,
    qualitySwitch: plan.qualitySwitch.fraction > 0 ? { requested: switches.length, ok: switches.filter(v => v.sw.doneAt !== null).length, failed: switches.filter(v => v.sw.failed).length,
      pending: switches.filter(v => v.sw.doneAt === null && !v.sw.failed).length, switchMs: pcts(switches.map(v => v.sw.ms)), basis: switches.reduce((a, v) => (v.sw.basis ? { ...a, [v.sw.basis]: (a[v.sw.basis] || 0) + 1 } : a), {}),
      gapMsPerViewer: pcts(inHold.filter(v => v.h.switchGapMs > 0).map(v => v.h.switchGapMs)), pairs: switches.reduce((a, v) => ({ ...a, [`${v.sw.from}->${v.sw.to}`]: (a[`${v.sw.from}->${v.sw.to}`] || 0) + 1 }), {}),
      definition: 'switch request (source replaced in the generator) -> first media of the new quality (ready time); the gap windows are left out of stall and rate numbers' } : null,
    qualityMix: Object.fromEntries(qualities.map(q => [q, inHold.filter(v => v.initialQuality === q).length])),
    chat: chatS, dvr: dvrS,
    errors: { generatorErrorKinds: errorDelta(extra.errStart), lossLogLines: generator.lossLines - extra.errStart.lossLines, whep: tapStage },
    externalLoad: { unattributedCpuPctMean: round(extMean), unattributedCpuPctMax: unattr.length ? Math.max(...unattr) : null, samplesAbove: unattr.filter(x => x > plan.limits.externalCpuPct).length, samples: unattr.length,
      flagged: extMean !== null && extMean > plan.limits.externalCpuPct, thresholdPct: plan.limits.externalCpuPct },
    resources: {
      genCpuPct: { mean: round(mean(pick('genCpuPct'))), max: round(Math.max(...pick('genCpuPct'), 0)) }, genRssMB: { max: round(Math.max(...pick('genRssMB'), 0)) },
      targetCpuPct: { mean: round(mean(pick('targetCpuPct'))), max: round(Math.max(...pick('targetCpuPct'), 0)) }, targetRssMB: { max: round(Math.max(...pick('targetRssMB'), 0)) },
      hostCpuPct: { mean: round(mean(pick('hostCpuPct'))), max: round(Math.max(...pick('hostCpuPct'), 0)) }, freeMemMB: { min: pick('freeMemMB').length ? Math.min(...pick('freeMemMB')) : null },
      nicRxMbps: { mean: round(mean(pick('nicRxMbps'))) }, nicTxMbps: { mean: round(mean(pick('nicTxMbps'))) },
      gpuPct: { max: pick('gpuPct').length ? Math.max(...pick('gpuPct')) : null }, gpuEncPct: { max: pick('gpuEncPct').length ? Math.max(...pick('gpuEncPct')) : null },
      eventLoopLagP99Ms: { max: round(Math.max(0, ...pick('lagP99Ms')), 1) }, generatorListMs: { max: Math.max(0, ...pick('genListMs')) },
      statsVia: hr.find(r => r.statsVia)?.statsVia ?? NOT,
      targetSendMbps: { mean: round(mean(pick('targetSendMbps'))) }, targetDiscardedFrames: plan.target.api ? pick('targetDiscardedFrames').reduce((a, b) => a + b, 0) : NOT, targetSessionsMax: pick('targetSessions').length ? Math.max(...pick('targetSessions')) : null,
      app: plan.target.appStats ? { httpThreadsMax: pick('appHttpThreads').length ? Math.max(...pick('appHttpThreads')) : null, httpRefused: pick('appHttpRefused').reduce((a, b) => a + b, 0),
        chatClientsMax: pick('appChatClients').length ? Math.max(...pick('appChatClients')) : null, chatJoinedMax: pick('appChatJoined').length ? Math.max(...pick('appChatJoined')) : null, chatRefused: pick('appChatRefused').reduce((a, b) => a + b, 0),
        discardWarnings: pick('appDiscardWarnings').reduce((a, b) => a + b, 0) } : NOT,
    },
    // A protocol client does not decode or render: these come only from the browser sampler (browser / browserPhase).
    decodedFps: NOT, renderedFps: NOT, avSync: NOT, liveLatencyMs: NOT, rebuffering: 'stall windows only (byte growth); player rebuffering not measured',
    browser: extra.browser || null, browserPhase: null, traffic: null,
    abortReason: abort && abort.stage === stage ? abort.reason : null,
  };
}

// "host/udp/100.93.248.31/50718" -> "host/udp cgnat-vpn": candidate type, protocol and address class (not the address).
function candidateClass(c) {
  const [type, proto, ...rest] = c.split('/');
  const ip = rest.slice(0, -1).join('/');
  const cls = /^127\.|^::1$/.test(ip) ? 'loopback' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 'private' : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 'cgnat-vpn'
    : /^fe80:/i.test(ip) ? 'link-local' : /^f[cd]/i.test(ip) ? 'ula' : ip.includes(':') ? 'ipv6' : 'public';
  return `${type}/${proto} ${cls}`;
}

function slope(rows, key) {
  const pts = rows.filter(r => Number.isFinite(r[key])).map(r => [Date.parse(r.t) / 60000, r[key]]);
  if (pts.length < 3) return null;
  const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1]));
  const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return den ? round(pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / den, 2) : null;
}

// ---------- quality switch ----------
function startSwitches() {
  const qs = plan.qualitySwitch;
  for (const v of active()) {
    if (v.firstAt === null || v.sw || frac(v.i * 0.3819660113 + 0.53) >= qs.fraction) continue;
    const to = qs.to[v.quality];
    if (!to || to === v.quality) continue;  // the target must serve `to` (else the switch is measured as failed)
    v.sw = { from: v.quality, to, requestedAt: Date.now(), doneAt: null, ms: null, failed: false, stage: stageN };
    if (v.h) { v.h.segs.push(v.h.seg); v.h.seg = newSeg(to); }
    Object.assign(v, { quality: to, sessionStart: v.sw.requestedAt, mediaAt: null, ready: false, readyTime: null, hist: [] });
    generator.setSource(v.name, sourceUrlFor(v, to), v.inst).then(r => { v.sw.apiOk = r.ok; v.sw.apiMs = r.apiMs; if (!r.ok) v.sw.error = r.error; });
  }
}

// ---------- browser sampler ----------
const wantBrowser = stage => plan.browser.count > 0 && !!plan.browser.url && (!plan.browser.stages || plan.browser.stages.includes(stage));
function startBrowser(stage) {
  const b = plan.browser;
  const out = join(tmp, `browser-${stage}.json`);
  const p = run(process.execPath, [join(repo, 'tools', 'load', 'browser-sampler.mjs'), '--url', b.url, '--count', String(b.count), '--seconds', String(b.seconds), '--profiles', (b.profiles || ['desktop']).join(','),
    '--port', String(b.devtoolsPort), '--headless', String(b.headless), '--out', out, '--dir', edgeDir(stage), '--latency', String(b.latency ?? !(targetState && !targetState.barcode))], { cwd: repo });
  onLines(p.stdout, line => { try { const m = JSON.parse(line); if (m.event === 'edge') resources.set({ browser: [m.pid] }); } catch {} });
  onLines(p.stderr, line => log('browser:', line));
  return new Promise(resolveP => p.once('exit', () => { resources.set({ browser: [] }); endEdge(stage); resolveP(existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { error: 'browser sampler produced no result' }); }));
}
// Separate phase: the protocol viewers stay connected, nothing churns or switches, and the stage's hold is already summarised.
async function browserPhase(stage) {
  phase = 'browser';
  const from = Date.now(), rows0 = samples.length;
  log(`stage ${stage}: browser phase (${plan.browser.count} pages, ${plan.browser.profiles.join('/')})`);
  const res = await startBrowser(stage);
  const rows = samples.slice(rows0);
  const pick = k => rows.map(r => r[k]).filter(Number.isFinite);
  return { ...res, mode: 'separate', during: { sec: round((Date.now() - from) / 1000, 1), protocolViewers: active().length, receivingRatioMin: pick('receivingRatio').length ? Math.min(...pick('receivingRatio')) : null,
    fullRateLiveMin: pick('fullRateLive').length ? Math.min(...pick('fullRateLive')) : null, totalMbpsMean: round(mean(pick('totalMbps')), 1), targetSessionsMax: pick('targetSessions').length ? Math.max(...pick('targetSessions')) : null,
    targetDiscardedFrames: pick('targetDiscardedFrames').reduce((a, b) => a + b, 0), hostCpuPctMax: pick('hostCpuPct').length ? Math.max(...pick('hostCpuPct')) : null, browserCpuPctMean: round(mean(pick('browserCpuPct'))) } };
}
const edgeDir = stage => join(tmp, `edge-${stage}`);
// The sampler closes its browser; if it was killed (abort), Edge processes of its profile are ended here by PID.
// Asynchronous on purpose: a blocking PowerShell call here would stall the sampling loop for a second or more.
function endEdge(stage) {
  const dir = edgeDir(stage).replace(/'/g, "''");
  return new Promise(res => run('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`]).once('exit', res));
}
function endAllEdges() { if (plan.browser.count) for (const s of plan.stages) for (const p of pidsByCommandLine(edgeDir(s), 'msedge.exe')) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

// ---------- traffic plan ----------
// Viewer-seconds a stage keeps open: ramp (average of old and new count), settle, hold and the separate browser phase.
function stageViewerSeconds(n, prev) {
  const ramp = plan.burst || !plan.keepBetweenStages ? 0 : Math.max(0, n - prev) / Math.max(0.1, plan.rampPerSec);
  const browser = plan.browser.mode === 'separate' && wantBrowser(n) ? plan.browser.seconds + 10 : 0;
  return ramp * (prev + n) / 2 + n * (plan.settleSec + plan.holdSec + browser);
}
function trafficPlan(kbps) {
  let prev = 0, vs = 0;
  for (const n of plan.stages) { vs += stageViewerSeconds(n, plan.keepBetweenStages ? prev : 0); prev = n; }
  const gb = k => round(vs * k * 1000 / 8 / 1e9, 1);
  return { viewerSeconds: Math.round(vs), estimatedGB: kbps ? gb(kbps) : NOT, atKbps: kbps ? round(kbps, 0) : NOT, at8600kbpsGB: gb(8600), at12000kbpsGB: gb(12000), capGB: plan.limits.maxTrafficGB,
    note: 'protocol viewers only (browser pages and chat not counted); per-viewer rate = the mix of the plan\'s qualities' };
}
const planKbps = () => {
  const r = plan.referenceKbps;
  if (!r) return null;
  const w = Object.entries(plan.qualities).filter(([, x]) => x > 0), sum = w.reduce((a, [, x]) => a + x, 0);
  return w.every(([q]) => r[q]) ? w.reduce((a, [q, x]) => a + r[q] * x / sum, 0) : null;
};

// ---------- output ----------
const stageCols = ['stage', 'requested', 'measuredViewers', 'joined', 'addFailed', 'firstMediaP50Ms', 'firstMediaP95Ms', 'firstMediaTimeouts', 'firstMediaPending', 'firstMediaFromSampleClock', 'queueMsP95', 'whepAnswerMsP95',
  'sustainedReceiving', 'successRate', 'fullRateSuccessRate', 'fullRateTooShort', 'fullRateByQuality', 'referenceKbps', 'referenceFrom',
  'receivingRatioMin', 'fullRateLiveMin', 'stallTimeRatio', 'lowRateWindowRatio', 'stallEvents', 'disconnects', 'reconnects', 'perViewerKbpsP5', 'perViewerKbpsP50', 'totalMbpsMean', 'rtpPacketsLost', 'lossRatioEst',
  'switches', 'switchMsP50', 'switchMsP95', 'switchFailed', 'whepPosts', 'whep503', 'whep503Share', 'retryAfter', 'errorKinds',
  'chatJoined', 'chatLatencyP50Ms', 'chatLatencyP95Ms', 'chatDeliveryRatio', 'chatConnectFail', 'chatNameRejected', 'dvrChunks', 'dvrErrors', 'dvrErrorRate',
  'genCpuPctMean', 'genCpuPctMax', 'genRssMBMax', 'targetCpuPctMean', 'targetCpuPctMax', 'targetRssMBMax', 'hostCpuPctMax', 'unattributedCpuPctMean', 'externalLoad', 'freeMemMBMin',
  'statsVia', 'targetSessionsMax', 'targetSendMbps', 'targetDiscardedFrames', 'appDiscardWarnings', 'appHttpRefused', 'sourceKbps', 'rateVsSourceP5', 'degradedViewers', 'trafficStageGB', 'trafficCumulativeGB',
  'browserMode', 'browserFirstFrameP50Ms', 'browserFpsMean', 'browserDecodedFps', 'browserFreezes', 'browserResolution', 'browserLatencyP50Ms', 'abortReason'];
function stageRow(s) {
  const bp = s.browserPhase || s.browser;
  const b = bp && !bp.error ? bp.summary : null;
  const fm = typeof s.firstMediaMs === 'object' ? s.firstMediaMs : null;
  const w = s.errors.whep;
  return { stage: s.stage, requested: s.requested, measuredViewers: s.measuredViewers, joined: s.joined, addFailed: s.addFailed, firstMediaP50Ms: fm?.p50 ?? NOT, firstMediaP95Ms: fm?.p95 ?? NOT,
    firstMediaTimeouts: s.firstMediaTimeouts, firstMediaPending: s.firstMediaPending, firstMediaFromSampleClock: s.firstMediaFromSampleClock, queueMsP95: fm?.components.queueMs.p95 ?? NOT,
    whepAnswerMsP95: typeof fm?.components.whepAnswerMs === 'object' ? fm.components.whepAnswerMs.p95 : NOT,
    sustainedReceiving: s.sustainedReceiving, successRate: s.successRate, fullRateSuccessRate: s.fullRateSuccessRate, fullRateTooShort: s.fullRateTooShort,
    fullRateByQuality: typeof s.fullRateByQuality === 'object' ? Object.entries(s.fullRateByQuality).map(([q, x]) => `${q}:${x.segments}seg p50 ${x.ratioP50 ?? '-'} below ${x.belowFraction}`).join(' | ') : NOT,
    referenceKbps: s.referenceKbps, referenceFrom: s.referenceFrom, receivingRatioMin: s.receivingRatio.min, fullRateLiveMin: s.fullRateLive.min, stallTimeRatio: s.stallTimeRatio, lowRateWindowRatio: s.lowRateWindowRatio,
    stallEvents: s.stallEvents, disconnects: s.disconnects, reconnects: s.reconnects, perViewerKbpsP5: s.perViewerKbps.p5, perViewerKbpsP50: s.perViewerKbps.p50, totalMbpsMean: s.totalMbps.mean,
    rtpPacketsLost: s.rtpPacketsLost, lossRatioEst: s.lossRatioEst,
    switches: s.qualitySwitch ? s.qualitySwitch.requested : NOT, switchMsP50: s.qualitySwitch ? s.qualitySwitch.switchMs.p50 : NOT, switchMsP95: s.qualitySwitch ? s.qualitySwitch.switchMs.p95 : NOT, switchFailed: s.qualitySwitch ? s.qualitySwitch.failed : NOT,
    whepPosts: w ? w.posts : NOT, whep503: w ? w.status503 : NOT, whep503Share: w ? w.share503 : NOT, retryAfter: w ? Object.entries(w.retryAfter).map(([k, n]) => `${k}s x${n}`).join(' ') : NOT,
    errorKinds: Object.entries(s.errors.generatorErrorKinds).map(([k, n]) => `${n}x ${k}`).join(' | ').slice(0, 300),
    chatJoined: s.chat?.joined ?? NOT, chatLatencyP50Ms: s.chat ? s.chat.latencyMs.p50 : NOT, chatLatencyP95Ms: s.chat ? s.chat.latencyMs.p95 : NOT,
    chatDeliveryRatio: s.chat ? s.chat.deliveryRatio : NOT, chatConnectFail: s.chat ? s.chat.connectFail : NOT, chatNameRejected: s.chat ? s.chat.nameRejected : NOT, dvrChunks: s.dvr ? s.dvr.chunks : NOT, dvrErrors: s.dvr ? s.dvr.errors : NOT, dvrErrorRate: s.dvr ? s.dvr.errorRate : NOT,
    genCpuPctMean: s.resources.genCpuPct.mean, genCpuPctMax: s.resources.genCpuPct.max, genRssMBMax: s.resources.genRssMB.max, targetCpuPctMean: s.resources.targetCpuPct.mean,
    targetCpuPctMax: s.resources.targetCpuPct.max, targetRssMBMax: s.resources.targetRssMB.max, hostCpuPctMax: s.resources.hostCpuPct.max, unattributedCpuPctMean: s.externalLoad.unattributedCpuPctMean, externalLoad: s.externalLoad.flagged,
    freeMemMBMin: s.resources.freeMemMB.min, statsVia: s.resources.statsVia, targetSessionsMax: s.resources.targetSessionsMax ?? NOT,
    targetSendMbps: s.resources.targetSendMbps.mean ?? NOT, targetDiscardedFrames: s.resources.targetDiscardedFrames, appDiscardWarnings: typeof s.resources.app === 'object' ? s.resources.app.discardWarnings : NOT, appHttpRefused: typeof s.resources.app === 'object' ? s.resources.app.httpRefused : NOT, sourceKbps: s.sourceKbps,
    rateVsSourceP5: typeof s.rateVsSource === 'object' ? s.rateVsSource.p5 : NOT, degradedViewers: typeof s.rateVsSource === 'object' ? s.rateVsSource.degradedViewers : NOT,
    trafficStageGB: s.traffic?.stageGB ?? NOT, trafficCumulativeGB: s.traffic?.cumulativeGB ?? NOT,
    browserMode: bp ? bp.mode || 'inline' : '', browserFirstFrameP50Ms: b ? b.firstFrameMs.p50 : NOT, browserFpsMean: b ? b.presentedFps.mean : NOT, browserDecodedFps: b ? b.decodedFps.mean : NOT, browserFreezes: b ? b.freezes : NOT,
    browserResolution: b ? b.resolution.join(' ') : NOT, browserLatencyP50Ms: b ? b.latencyMs.p50 ?? NOT : NOT, abortReason: s.abortReason || '' };
}
const browserCols = ['stage', 'mode', 'index', 'profile', 'viewport', 'dpr', 'error', 'firstFrameMs', 'presentedFps', 'decodedFps', 'decodedFpsBasis', 'decodedWidth', 'decodedHeight', 'freezes', 'maxGapMs', 'videoKbps', 'videoLossRatio', 'jitterBufferMs', 'peerConnections', 'connectionChangedInWindow', 'latencyP50Ms'];
const browserRows = () => stages.flatMap(s => { const bp = s.browserPhase || s.browser; return (bp?.pages || []).map(p => ({ stage: s.stage, mode: bp.mode || 'inline', ...p, latencyP50Ms: typeof p.latencyMs === 'object' ? p.latencyMs.p50 : '' })); });
const sampleCols = ['t', 'elapsedS', 'stage', 'phase', 'requested', 'ready', 'receiving', 'receivingRatio', 'eligible', 'stalled', 'inSwitch', 'fullRateLive', 'fullRateJudged', 'refSourceKbps', 'totalMbps', 'perViewerKbpsP50', 'perViewerKbpsP5', 'perViewerKbpsSrcP50', 'trafficGB',
  'lostPackets', 'genCpuPct', 'genCores', 'genRssMB', 'browserCpuPct', 'targetCpuPct', 'targetCores', 'targetRssMB', 'targetProcs', 'hostCpuPct', 'unattributedCpuPct', 'hostMemUsedPct', 'freeMemMB',
  'nicRxMbps', 'nicTxMbps', 'gpuPct', 'gpuEncPct', 'gpuDecPct', 'statsVia', 'targetSessions', 'targetSendMbps', 'targetDiscardedFrames', 'sourceKbps', 'ingestKbpsAll',
  'appRunning', 'appHttpThreads', 'appHttpRequests', 'appHttpRefused', 'appChatClients', 'appChatJoined', 'appChatRefused', 'appSourceReaders', 'appSourceReady', 'appDiscardWarnings', 'whepPosts', 'whep503', 'whepPostsRolling', 'whep503ShareRolling',
  'chatOpen', 'chatJoined', 'dvrChunks', 'dvrErrors', 'genListMs', 'genApiOk', 'lagP99Ms', 'lagMaxMs'];

let hostBaseline = null, cleanup = null, calibration = null, plannedTraffic = null;
function write(final = false) {
  const results = {
    schema: 'frame-load/2', runId, final, startedAt: new Date(runStart).toISOString(), endedAt: final ? new Date().toISOString() : null,
    command: process.argv.join(' '), cwd: process.cwd(), outDir, plan, versions, host, hostBaseline, generatorId: plan.generatorId, chatNameExample: chatName(plan.generatorId, 'v00000'),
    target: { whep: plan.target.whep, base: plan.target.base, path: plan.target.path, api: plan.target.api, appStats: plan.target.appStats, appStatsCheck, info,
      standalone: targetState ? { dir: targetState.dir, options: targetState.options, pids: targetState.pids, urls: targetState.urls, shimLimits: targetState.shimLimits ?? null } : null },
    definitions: {
      viewer: 'one WebRTC peer (MediaMTX WHEP source in the generator process): ICE + DTLS-SRTP + RTCP, receives and depacketizes H.264/Opus, no decoding or rendering',
      receiving: `received bytes grew by more than ${plan.stallKbps} kbit/s in a ${plan.sampleMs} ms sample window`,
      firstMedia: 'join requested (ramp slot, burst start or churn re-join; queueing included) -> the viewer\'s generator path has media: ready, with tracks and received bytes. ' +
        'The time is the path ready time (tracks gathered = first RTP) when it is a real time not before the request; MediaMTX\'s zero-year placeholder and earlier times are ignored. ' +
        'Without a usable ready time the sample clock is used and counted in firstMediaMs.basis / firstMediaFromSampleClock (error up to one sample interval).',
      reconnect: 'media again after a loss, or a new real ready time of the same session; the placeholder -> real ready time transition is not a reconnect',
      sustained: `first media and receiving in >= ${plan.sustainedMinFraction * 100}% of the hold windows; successRate = sustained / requested`,
      fullRate: `sustained, and every quality segment the viewer watched in the hold (>= ${plan.minSegmentSec} s) has a mean rate >= ${plan.fullRateFraction * 100}% of that quality's reference (reference.<quality>.from); fullRateSuccessRate = full-rate viewers / (requested or sessions seen) minus sessions too short to judge (fullRateTooShort, all segments < minSegmentSec), not measured when a watched quality has no reference (an idle path's ingest 0 is no reference)`,
      fullRateLive: `per sample: share of viewers whose rolling ${plan.rateWindowSec} s rate is >= ${plan.fullRateFraction * 100}% of their quality's rolling reference (stop rule degraded-below-min)`,
      stall: `a ${plan.sampleMs} ms window without growth (<= ${plan.stallKbps} kbit/s); stallTimeRatio = stalled time / observed time after first media`,
      cpuPct: 'percent of the whole machine (all logical CPUs) from process CPU time; cores = same in CPU cores',
      unattributedCpuPct: `host CPU minus generator, target and browser-sampler processes: other programs and kernel network time; a stage is flagged externalLoad when its hold mean is above ${plan.limits.externalCpuPct}%`,
      rtpPacketsLost: 'losses reported by the generator WebRTC sources (MediaMTX log, "1 RTP packet lost" and "N RTP packets lost"); lossRatioEst assumes ~1,150 B per RTP packet',
      whep: 'WHEP signalling seen by the loopback tap (status per offer, Retry-After values); MediaMTX\'s WHEP client itself retries about every 5 s whatever Retry-After says',
      traffic: 'bytes received by the generator\'s protocol viewers (browser pages not counted)',
      network: 'generator and target location are recorded in host/target; loopback or same-PC traffic does not cross the NIC',
    },
    notMeasured: ['decoded FPS, rendering, A/V sync, player rebuffering and live latency are not measured by protocol viewers (see browser sampler fields)',
      ...(plan.target.api ? [] : [plan.target.appStats ? 'target-side dropped frame counts: only the app count of MediaMTX "too slow, discarding" warnings (appDiscardWarnings)' : 'target-side dropped frames (no access to the target MediaMTX API)']),
      ...(plan.target.api || plan.target.appStats ? [] : ['target-side session count and ingest rate (no target statistics)']),
      ...(dvrSkipped ? [`DVR readers (${dvrSkipped})`] : [])],
    trafficPlan: plannedTraffic,
    stages, abort, saturation, calibration, cleanup,
    errors: { generatorErrorKinds: generator.errorKinds, lossLogLines: generator.lossLines, whep: tap ? tap.summary() : NOT,
      sourceErrorsSample: Object.fromEntries([...generator.sourceErrors.entries()].slice(0, 20)) },
    files: { stagesCsv: 'stages.csv', samplesCsv: 'samples.csv', browserCsv: 'browser.csv', generatorLogs: generator.instances.map(i => `generator-${i.index}.log`) },
  };
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, 'stages.csv'), '﻿' + csv(stages.map(stageRow), stageCols));
  writeFileSync(join(outDir, 'samples.csv'), '﻿' + csv(samples.map(r => ({ ...r, ingestKbpsAll: Object.entries(r.ingestKbps || {}).map(([q, k]) => `${q}=${k}`).join(' ') })), sampleCols));
  writeFileSync(join(outDir, 'browser.csv'), '﻿' + csv(browserRows(), browserCols));
}

// ---------- main ----------
const runStart = Date.now();
log(`run ${runId} -> ${outDir} (generator id ${plan.generatorId})`);

resources.start();
const treeRoots = await resolveTree(plan.target.tree);
for (const p of [...(plan.target.pids || []), ...treeRoots]) critical.add(p);
resources.set({ targetPids: plan.target.pids || [], targetTree: treeRoots, targetNames: plan.target.names || [], targetPathLike: plan.target.pathLike || [] });
// Baseline: what the host and target already use before any viewer joins (other programs on a shared PC count here).
for (const t0 = Date.now(); Date.now() - t0 < 20000 && !(lastRes && lastRes.host && resources.prev && lastRes.gen.cores !== null); ) await sleep(250);
hostBaseline = lastRes ? { hostCpuPct: lastRes.host.cpuPct, unattributedCpuPct: round(lastRes.host.cpuPct - (lastRes.gen.cpuPct || 0) - (lastRes.target.cpuPct || 0)), freeMemMB: round(freeMB(), 0),
  targetCpuPct: lastRes.target.cpuPct, targetRssMB: lastRes.target.rssMB, targetProcs: lastRes.target.procs, gpu: lastRes.gpu } : null;
if (hostBaseline && hostBaseline.unattributedCpuPct > plan.limits.externalCpuPct) noteSaturation('external-load-at-baseline', { unattributedCpuPct: hostBaseline.unattributedCpuPct, hostCpuPct: hostBaseline.hostCpuPct });
log('baseline', JSON.stringify(hostBaseline && { host: hostBaseline.hostCpuPct, other: hostBaseline.unattributedCpuPct, free: hostBaseline.freeMemMB, target: hostBaseline.targetCpuPct, procs: hostBaseline.targetProcs.length }));

if (plan.target.base) {
  try { info = (await fetchJson(`${plan.target.base}/${plan.target.path}/info`)).body; } catch (e) { info = { error: e.message }; }
  if (!info?.running) { log('target is not running:', JSON.stringify(info)); setAbort('target-not-running', info); }
  // Every planned lower quality must be one the broadcast offers (/info renditions), or its viewers would only measure 404s.
  const offered = Array.isArray(info?.renditions) ? info.renditions.map(r => (typeof r === 'string' ? r : r?.name)).filter(Boolean) : null;
  const planned = Object.entries(plan.qualities).filter(([q, w]) => w > 0 && !isSourceQ(q)).map(([q]) => q);
  const missing = offered ? planned.filter(q => !offered.includes(q)) : [];
  if (plan.media && info?.running && missing.length) { log(`qualities ${missing.join(', ')} are not offered by the broadcast (renditions: ${offered.join(', ') || 'none'})`); setAbort('quality-not-offered', { missing, offered }); }
  if (plan.dvr.fraction > 0 && info?.running && info.dvr === false) { log('the broadcast has no DVR: DVR readers are not started'); dvrSkipped = 'broadcast reports dvr: false'; }
}
if (plan.media && plan.whepTap.enabled) {
  tap = new WhepTap({ port: plan.whepTap.port, upstream: plan.target.whep.replace('{stream}', plan.target.path).replace('{path}', plan.target.path) });
  await tap.start();
}
await generator.start();
resources.set({ gen: [process.pid, ...generator.pids()] });
if (plan.chat.fraction > 0 && info?.broadcastId) chat = new ChatPool({ ...plan.chat, generatorId: plan.generatorId, wsUrl: `${plan.target.base.replace(/^http/, 'ws')}/${plan.target.path}/chat`, broadcastId: info.broadcastId });
if (plan.dvr.fraction > 0 && plan.target.base && !dvrSkipped) dvr = new DvrPool({ ...plan.dvr, base: plan.target.base, path: plan.target.path });
plannedTraffic = trafficPlan(planKbps());
log('traffic plan', JSON.stringify(plannedTraffic));

let sampling = true;
const sampler = (async () => { while (sampling) { const t = Date.now(); try { await sampleOnce(); } catch (e) { log('sample error', e.stack || e.message); } await sleep(Math.max(50, plan.sampleMs - (Date.now() - t))); } })();
const chatTimer = setInterval(() => chat?.tick(), 1000);
// An empty file named STOP in the result folder ends the run cleanly (Windows cannot send Ctrl+C to a background process).
const stopTimer = setInterval(() => { if (existsSync(join(outDir, 'STOP'))) setAbort('stop-file'); }, 1000);
// First Ctrl+C ends the run cleanly (viewers leave, results are written); a second one kills everything.
let interrupts = 0;
process.on('SIGINT', () => { if (++interrupts > 1) { endAllEdges(); killAll(); process.exit(130); } setAbort('interrupted'); });

// Sessions the target already had before this run (a real app may have its own viewers): cleanup returns to this count.
const baselineStats = await targetStatsSample();
const baselineSessions = baselineStats?.sessions ?? null;
if (baselineSessions) log(`target already had ${baselineSessions} WebRTC sessions before the run (cleanup waits for this count)`);

// Waits until the target reports no more WebRTC sessions than before the run (when it reports at all) and the generator holds no path.
async function waitEmpty(sec) {
  const t0 = Date.now(), trace = [];
  while (true) {
    const ts = await targetStatsSample();
    const gl = plan.media ? await generator.list() : { items: new Map() };
    trace.push({ afterMs: Date.now() - t0, targetSessions: ts?.sessions ?? null, generatorPaths: gl.items.size });
    if ((!ts || ts.sessions === null || ts.sessions <= (baselineSessions || 0)) && gl.items.size === 0) break;
    if (Date.now() - t0 >= sec * 1000) break;
    await sleep(2000);
  }
  return trace;
}

let prevN = 0;
for (const [k, n] of plan.stages.entries()) {
  if (abort) break;
  stageIndex = k; stageN = n;
  const stageStart = Date.now(), trafficStageStart = trafficBytes, errStart = errorSnapshot();
  // Stop before a stage that cannot finish inside the traffic cap (instead of cutting it in the middle).
  const estKbps = mean(stages.map(s => s.perViewerKbps.mean)) || planKbps() || measuredRef.source?.kbps || null;
  if (plan.media && plan.limits.projectTraffic && estKbps) {
    const projectedGB = stageViewerSeconds(n, plan.keepBetweenStages ? active().length : 0) * estKbps * 1000 / 8 / 1e9;
    if (trafficBytes / 1e9 + projectedGB > plan.limits.maxTrafficGB) { setAbort('traffic-cap-projected', { stage: n, projectedStageGB: round(projectedGB, 1), usedGB: round(trafficBytes / 1e9, 1), capGB: plan.limits.maxTrafficGB, perViewerKbps: round(estKbps, 0) }); break; }
  }
  phase = 'ramp';
  log(`stage ${n}: ramp`);
  chat?.resetWindow();  // connect/join numbers cover this stage's joins; delivery numbers its ramp and hold
  if (!plan.keepBetweenStages && active().length) { await Promise.all(active().map(removeViewer)); await waitEmpty(plan.emptyWaitSec); }
  const need = n - active().length;
  if (need > 0) await addMany(need);
  else if (need < 0) await Promise.all(active().slice(need).map(removeViewer));
  phase = 'settle';
  await sleepUnlessAbort(plan.settleSec * 1000);
  if (abort) { stages.push(summarize(n, Date.now(), Date.now(), [], { lossStart: lossTotal(), lossEnd: lossTotal(), procStart: 0, churnLeaves: 0, churnSkipped: 0, stageStart, errStart })); break; }
  phase = 'hold';
  const holdFrom = Date.now(), rows0 = samples.length, lossStart = lossTotal(), procStart = [...generator.procErrors.values()].reduce((a, b) => a + b, 0), trafficHoldStart = trafficBytes;
  for (const v of active()) holdWindowStart(v);
  dvr?.reset();
  const inlineBrowser = plan.browser.mode === 'inline' && wantBrowser(n) ? sleep(plan.browser.startDelaySec * 1000).then(() => (abort ? null : startBrowser(n))) : null;
  const holdEpoch = ++epoch, churnPending = new Set();
  let churnAcc = 0, churnLeaves = 0, churnSkipped = 0, switched = false;
  while (Date.now() - holdFrom < plan.holdSec * 1000 && !abort) {
    await sleep(1000);
    if (plan.qualitySwitch.fraction > 0 && !switched && Date.now() - holdFrom >= plan.qualitySwitch.atSec * 1000) { switched = true; startSwitches(); }
    if (plan.churn.perSec > 0) {
      churnAcc += plan.churn.perSec;
      const candidates = active().filter(v => Date.now() - v.addedAt > plan.churn.minAgeSec * 1000 && !(v.sw && v.sw.doneAt === null && !v.sw.failed));
      while (churnAcc >= 1 && candidates.length) {
        churnAcc--;
        const v = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0];
        churnLeaves++;
        // The re-join happens only while this hold is still running (F): not after it ended, not during cleanup or an abort.
        const p = removeViewer(v).then(() => sleep(plan.churn.rejoinDelayMs)).then(() => {
          if (abort || epoch !== holdEpoch || phase !== 'hold') { churnSkipped++; return; }
          const nv = newViewer(Date.now());
          nv.churn = true;
          holdWindowStart(nv);
          return addViewer(nv);
        }).catch(e => log('churn error', e.message));
        churnPending.add(p);
        p.then(() => churnPending.delete(p));
      }
    }
  }
  epoch++;  // closes the hold for re-joins
  await Promise.all([...churnPending]);
  const browser = inlineBrowser ? await inlineBrowser : null;
  if (browser) browser.mode = 'inline';
  const holdTo = Date.now();
  const trafficHoldEnd = trafficBytes;
  const s = summarize(n, holdFrom, holdTo, samples.slice(rows0), { lossStart, lossEnd: lossTotal(), procStart, churnLeaves, churnSkipped, browser, stageStart, errStart });
  stages.push(s);
  if (s.lowRateWindowRatio > 0.5) log(`warning: ${Math.round(s.lowRateWindowRatio * 100)}% of windows below ${plan.lowRateKbps} kbit/s (audio only? check the source)`);
  log(`stage ${n} done: success ${s.successRate} fullRate ${s.fullRateSuccessRate} (ref ${s.referenceKbps} from ${s.referenceFrom}) firstMedia p50/p95 ${s.firstMediaMs.p50 ?? NOT}/${s.firstMediaMs.p95 ?? NOT} ms timeouts ${s.firstMediaTimeouts} pending ${s.firstMediaPending} stall ${s.stallTimeRatio} kbps p50 ${s.perViewerKbps.p50} gen ${s.resources.genCpuPct.mean}% target ${s.resources.targetCpuPct.mean}% other ${s.externalLoad.unattributedCpuPctMean}%${s.externalLoad.flagged ? ' EXTERNAL LOAD' : ''}`);
  // A first stage with <= 2 viewers of a quality gives that quality a measured reference when nothing better exists.
  if (k === 0 && s.successRate === 1 && typeof s.fullRateByQuality === 'object') for (const [q, x] of Object.entries(s.fullRateByQuality)) if (x.segments > 0 && x.segments <= 2 && x.kbpsP50) measuredRef[q] = { kbps: x.kbpsP50, from: `per-viewer rate at stage ${n} (VBR content may vary)` };
  if (plan.browser.mode === 'separate' && wantBrowser(n) && !abort) s.browserPhase = await browserPhase(n);
  s.traffic = { stageGB: round((trafficBytes - trafficStageStart) / 1e9, 3), holdGB: round((trafficHoldEnd - trafficHoldStart) / 1e9, 3), cumulativeGB: round(trafficBytes / 1e9, 3), stageSec: round((Date.now() - stageStart) / 1000, 1) };
  if (k === 0 && plan.media && s.perViewerKbps.mean) { plannedTraffic = { ...trafficPlan(s.perViewerKbps.mean), basis: `per-viewer mean of stage ${n}` }; if (plannedTraffic.estimatedGB > plan.limits.maxTrafficGB) log(`warning: planned traffic ~${plannedTraffic.estimatedGB} GB is above the cap ${plan.limits.maxTrafficGB} GB`); }
  write();
  prevN = n;
  // Calibration counts full-rate viewers when a reference rate exists: growing bytes at a fraction of the source are a failure.
  const passRate = x => (typeof x.fullRateSuccessRate === 'number' ? x.fullRateSuccessRate : x.successRate);
  if (plan.calibrate && passRate(s) < 0.99) setAbort('calibration-success-below-99%', { successRate: s.successRate, fullRateSuccessRate: s.fullRateSuccessRate });
}

// Calibration: what one generator session costs on this host, and the largest stage it sustained.
if (plan.calibrate) {
  const ok = stages.filter(s => (typeof s.fullRateSuccessRate === 'number' ? s.fullRateSuccessRate : s.successRate) >= 0.99 && s.abortReason === null);
  const per = stages.filter(s => s.measuredViewers > 0).map(s => ({ stage: s.stage, coresPerViewer: s.resources.genCpuPct.mean !== null ? round(s.resources.genCpuPct.mean / 100 * logical / s.measuredViewers, 4) : null,
    rssMBPerViewer: round(s.resources.genRssMB.max / s.measuredViewers, 2), coresPerGbps: s.totalMbps.mean ? round(s.resources.genCpuPct.mean / 100 * logical / (s.totalMbps.mean / 1000), 2) : null }));
  const cost = mean(per.slice(-3).map(p => p.coresPerViewer));
  calibration = { maxSustainedStage: ok.length ? ok[ok.length - 1].stage : 0, limitedBy: abort?.reason || 'stages exhausted', firstSaturation: saturation[0] || null, perStage: per,
    estimate: cost ? { note: 'linear estimate from the generator\'s own CPU cost; not a measured capacity', viewersAtGeneratorCpuLimit: Math.floor(plan.limits.generatorCpuPct / 100 * logical / cost) } : null };
}

// Cleanup: no re-join can start any more (epoch / phase), adds still in flight finish first, then every viewer leaves
// (WHEP DELETE from the generator) and the generator's path count and the target's session count must reach zero.
phase = 'cleanup';
epoch++;
log('cleanup: removing viewers');
await Promise.all([...inflight]);
await Promise.all(active().map(removeViewer));
chat?.closeAll();
dvr?.removeAll();
const trace = await waitEmpty(plan.cleanupWaitSec);
await sleep(plan.resourceMs + 500);
// Recovery: the target's CPU and memory after every viewer left, next to the baseline taken before the run.
const last = trace[trace.length - 1] || {};
cleanup = { targetSessionsTrace: trace, baselineTargetSessions: baselineSessions, remainingTargetSessions: last.targetSessions ?? null, remainingGeneratorPaths: last.generatorPaths ?? null,
  returnedToBaseline: last.generatorPaths === 0 && (last.targetSessions === null || last.targetSessions === undefined || last.targetSessions <= (baselineSessions || 0)),
  removeFailures: [...viewers.values()].filter(v => v.removeOk === false).length,
  targetAfter: lastRes ? { cpuPct: lastRes.target.cpuPct, rssMB: lastRes.target.rssMB, procs: lastRes.target.count } : null,
  targetBaseline: hostBaseline ? { cpuPct: hostBaseline.targetCpuPct, rssMB: hostBaseline.targetRssMB } : null,
  appAfter: lastStats?.app ? { webrtcSessions: lastStats.app.webrtc?.sessions, httpThreads: lastStats.app.http?.threads, chatClients: lastStats.app.chat?.clients } : null,
  chatServerClientsAfter: targetState ? (() => { try { return readJson(resolve(plan.target.stateFile)).chatClients ?? null; } catch { return null; } })() : null };
log(`cleanup: target sessions ${cleanup.remainingTargetSessions ?? NOT}, generator paths ${cleanup.remainingGeneratorPaths}`);
sampling = false;
await sampler;
clearInterval(chatTimer);
clearInterval(stopTimer);
write(true);
generator.stop();
await tap?.close();
resources.stop();
endAllEdges();
killAll();
log(`done: ${outDir}`);
process.exit(0);
