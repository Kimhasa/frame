// Real-broadcast end-to-end check of the React public web (apps/web, served at /_frame/) on one PC, on loopback ports
// 25000-25999 (server/verify/e2e.mjs uses 24000-24999, so the two never collide):
//   RTSPS test publisher (FFmpeg: H.264 + Opus + AAC test tone, as the app publishes) -> relay MediaMTX
//   (deploy/mediamtx-relay.yml, only environment overrides) -> server/relay.mjs (RELAY_RENDITIONS=480p quality ladder)
//   -> server/verify/web-proxy.mjs (apps/web/dist at /_frame/, everything else to the relay, fault injection, request
//   log) -> headless Edge (own temporary profile, at most 3 tabs) driven over CDP (tools/cdp.mjs).
// The pages use only the shipped UI (selectors of apps/web/src/features) and the adapter's window.FrameRuntime.
// Checks, each recorded with what was measured:
//    1 list: empty state, /api/broadcasts 500 -> error state, card for A -> /_frame/watch/screen-01/<A>
//    2 playback: frames and audio decoded, 1280x720, hls.js, no RTCPeerConnection, media only under /screen-01/b/<A>/
//      (2b: the relay's scoped routes directly)
//    3 quality: 480p from the menu -> 480 lines within 10 s, 자동 -> 720
//    4 chat: nickname, send + ack, a second page (other origin, same broadcast) receives the message once
//    5 DVR: seek near the recording's start -> history at the target, 실시간 복귀 -> live with latency < 4 s
//    6 path reuse: A ends and B starts on the same path: A's page ends and never plays B (media, DVR or chat), A's scoped
//      routes answer 404 not-running (nothing on the path) then 409, an old direct link never plays, the list shows B and
//      B plays (plus: B announced while A still publishes waits); 6f: a key change inside the page (B -> A's link, no
//      reload) stops B's media, session and chat socket
//    7 reconnect: relay MediaMTX restart -> reconnecting (or a silent recovery under 4 s), then plays; chat socket
//      dropped -> history redrawn, no duplicates
//    8 waiting: publisher away while still announced -> waiting, Retry-After honoured, plays again
//    9 cap: RELAY_MAX_VIEWERS_PER_PATH=1 -> a second page is busy, Retry-After honoured, no media, no WHEP
//   10 forbidden: 403 on the scoped session POST -> error overlay, one attempt, no WHEP
//   11 cleanup: leaving the watch page closes the session, the chat socket and every media request
//   12 WHEP: a page without MSE or native HLS plays over WebRTC; at the cap it shows busy and never plays
// Before running: build the production web (the design build has no relay adapter):
//   cd apps/web && corepack yarn install --immutable && corepack yarn build
// Needs dist/FrameConsole/bin/{ffmpeg,mediamtx}.exe, Microsoft Edge (FRAME_EDGE overrides its path) and the openssl of Git
// for Windows (test certificate). It is a heavy run (MediaMTX, the relay, an FFmpeg publisher, the relay's 480p encoder,
// Edge): run it alone, one heavy run at a time, never next to e2e.mjs or a load test.
// Usage: node server/verify/web-e2e.mjs [--keep] [--audible]
//   --keep     keep the temporary folder (logs, recordings, Edge profile): %TEMP%\frame-web-e2e-<time>
//   --audible  start Edge without --mute-audio (audio is decoded and measured either way)
// Evidence: verification/web/web-e2e-result.json, verification/web/web-*.png, verification/web/logs/ (secrets masked).
// Prints PASS/FAIL per check and a summary; exit code 1 when a check failed. Every process it starts is stopped by its
// PID on exit, also after a failure, a time-out (30 min) or Ctrl+C.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { start, stop, stopAll, waitFor, sleep, checks, killByCommandLine, portFree, scrub } from './harness.mjs';
import { connect } from '../../tools/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The backend under test: the Node relay (default) or the Spring Boot port (--backend spring: apps/api/build/libs/frame-api.jar,
// started with the same RELAY_* environment). --steps 1,2 runs only those steps (the Spring port covers registration, list and
// playback first). Each backend writes its own evidence folder.
const argValue = name => { const i = process.argv.indexOf('--' + name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null; };
// Never fall back to the Node relay by accident: "--backend" without a value and "--backend=spring" are refused.
if (process.argv.some(a => a.startsWith('--backend=')) || (process.argv.includes('--backend') && !argValue('backend'))) throw new Error('usage: --backend node|spring');
const BACKEND = argValue('backend') || 'node';
if (!['node', 'spring'].includes(BACKEND)) throw new Error('--backend must be node or spring');
const STEPS = argValue('steps') ? new Set(argValue('steps').split(',').map(s => s.trim())) : null;
const JAVA = process.env.FRAME_JAVA || join(process.env.JAVA_HOME || '', 'bin', 'java.exe');
const API_JAR = join(ROOT, 'apps/api/build/libs/frame-api.jar');
const OUT = join(ROOT, BACKEND === 'spring' ? 'verification/spring' : 'verification/web');
const DIST = join(ROOT, 'apps/web/dist');
const TMP = join(tmpdir(), 'frame-web-e2e-' + Date.now());
const BIN = join(ROOT, 'dist/FrameConsole/bin');
const FFMPEG = join(BIN, 'ffmpeg.exe'), MEDIAMTX = join(BIN, 'mediamtx.exe');
const EDGE = process.env.FRAME_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OPENSSL = ['C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'].find(existsSync);
const PORT = { rtsp: 25554, rtsps: 25322, rtp: 25000, rtcp: 25001, webrtc: 25889, ice: 25189, hls: 25888, api: 25997, playback: 25996, metrics: 25998,
  relay: 25070, web: 25080, control: 25081, edge: 25222 };
const RELAY = `http://127.0.0.1:${PORT.relay}`, CONTROL = `http://127.0.0.1:${PORT.control}`, MTX_API = `http://127.0.0.1:${PORT.api}`;
// Two origins of the same proxy: a browser allows 6 connections per origin, and one LL-HLS player holds about 4 (blocking
// playlist reloads + parts), so the second page plays from its own origin.
const WEB = `http://127.0.0.1:${PORT.web}`, WEB2 = `http://localhost:${PORT.web}`;
const PATH = 'screen-01', USER = 'frame-sender-01';  // the deploy yml's first sender account may publish screen-01
const PUBLISHER = 'WEB-E2E', TITLE_A = '웹 검증 방송 A', TITLE_B = '웹 검증 방송 B';
const KEEP = process.argv.includes('--keep'), AUDIBLE = process.argv.includes('--audible');

const secret = () => randomBytes(18).toString('hex');
const PASS = secret(), PASS_OTHER = secret(), TOKEN = secret() + secret();
const SECRETS = [PASS, PASS_OTHER, TOKEN];
// Every saved log and the result file go through this: known secrets and any user:password@ in a URL become ***.
const mask = s => SECRETS.reduce((t, x) => t.replaceAll(x, '***'), String(s)).replace(/(rtsps?:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1***@');
const sha = s => createHash('sha256').update(s).digest('base64');
const ID_A = randomBytes(16).toString('hex'), ID_B = randomBytes(16).toString('hex');
const scope = id => `/${PATH}/b/${id}/`;
const OVERLAY = { ended: '방송이 종료됐어요', waiting: '방송 신호를 기다리고 있어요', reconnecting: '방송에 다시 연결하는 중이에요', busy: '접속자가 많아요',
  error: '방송을 재생할 수 없어요', unavailable: '이 방송은 지금 볼 수 없어요' };
const TERMINAL = [OVERLAY.ended, OVERLAY.unavailable, OVERLAY.error, OVERLAY.busy];

for (const d of [TMP, OUT, join(OUT, 'logs')]) mkdirSync(d, { recursive: true });
const { list, check } = checks();
const result = {
  startedAt: new Date().toISOString(), host: { logicalCpus: cpus().length }, tools: {}, ports: PORT,
  web: { url: WEB + '/_frame/', secondOrigin: WEB2 + '/_frame/', dist: DIST }, broadcasts: { path: PATH, A: ID_A, B: ID_B }, checks: list, steps: [], notes: [],
  notConfirmed: [
    'iPhone/iPad Safari on a real device: native HLS or ManagedMediaSource, LL-HLS parts, DVR seeking, autoplay and the sound button',
    'Android Chrome on a real device; the mobile layouts with the real adapter',
    'HTTPS/WSS through Caddy (deploy/Caddyfile.example) and a CDN in front of the scoped media routes',
    'a relay process restart while a page is watching (registry and chat history in memory are lost)',
    'quality ladder failure (source-only list) seen from the React page',
    '401/403 on the media itself (live.m3u8, parts, DVR files) or on the WHEP offer: check 10 faults only the scoped session POST',
    'the React page on WHEP while B is announced but the path still carries the previous publisher (the relay answers whep?b=<B> 503 + Retry-After there, checked by e2e.mjs; this run plays WHEP only after B publishes)',
    'sessions longer than this run (session renewal over hours, DVR across many 60 s recording files)',
    'browsers other than headless Edge (Chrome, Firefox, desktop Safari)'
  ],
  pages: {}
};

// Host load while the checks run (whole PC, all processes): the PC is shared, so timings are only comparable with this.
const cpuSamples = [];
let cpuPrev = cpus();
const cpuTimer = setInterval(() => {
  const now = cpus(); let idle = 0, total = 0;
  now.forEach((c, i) => { const p = cpuPrev[i].times, t = c.times; const d = k => t[k] - p[k]; idle += d('idle'); total += d('user') + d('nice') + d('sys') + d('irq') + d('idle'); });
  cpuPrev = now; if (total > 0) cpuSamples.push(Math.round(100 * (1 - idle / total)));
}, 5000);
cpuTimer.unref();

// ---- small helpers --------------------------------------------------------------------------------------------------
function timeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' timed out')), ms); })]).finally(() => clearTimeout(timer));
}
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
async function raw(url, init) {
  const r = await timeout(fetch(url, init), 30000, 'fetch ' + url);
  const text = await r.text();
  return { status: r.status, cache: r.headers.get('cache-control'), retryAfter: r.headers.get('retry-after'), setCookie: r.headers.get('set-cookie'), type: r.headers.get('content-type'), text, json: parse(text) };
}
const getJson = async (url, init) => { try { const r = await raw(url, init); return { status: r.status, body: r.json, retryAfter: r.retryAfter, cache: r.cache }; } catch (error) { return { status: 0, body: null, error: error.message }; } };
const lines = t => String(t).split('\n').map(l => l.trim()).filter(Boolean);
const uris = t => lines(t).filter(l => !l.startsWith('#'));
const tagUris = t => [...String(t).matchAll(/URI="([^"]+)"/g)].map(m => m[1]);
const relative = u => !/^(\/|[a-z][a-z0-9+.-]*:)/i.test(u);
const healthz = async () => (await getJson(RELAY + '/healthz')).body || {};
const mtxPath = async name => (await getJson(`${MTX_API}/v3/paths/get/${encodeURIComponent(name)}`)).body || {};
const listed = async id => ((await getJson(RELAY + '/api/broadcasts')).body?.items || []).some(i => i.id === id);
async function webrtcReaders() {
  const items = (await getJson(MTX_API + '/v3/paths/list')).body?.items || [];
  return items.filter(i => i.name === PATH || i.name.startsWith(PATH + '/')).reduce((n, i) => n + (i.readers || []).filter(r => /webrtc/i.test(r.type)).length, 0);
}
// Most requests in any window of `windowMs`.
function maxPer(times, windowMs = 10000) {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) { while (t[i] - t[j] >= windowMs) j++; best = Math.max(best, i - j + 1); }
  return best;
}
// Consecutive attempts: the time from an answer to the next attempt, with the Retry-After that answer carried.
const retryGaps = entries => entries.slice(1).map((e, i) => { const prev = entries[i], ra = Number(prev.retryAfter); return { status: prev.status, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : null, gapMs: e.t - (prev.tr ?? prev.t) }; });
const answered = entries => entries.filter(e => e.status !== null);  // a request still on its way has no status yet
const honoured = gaps => gaps.every(g => g.retryAfterS === null || g.gapMs >= g.retryAfterS * 1000 - 300);
const brief = e => `${e.method} ${e.path}${e.query && e.query.length < 60 ? e.query : ''} ${e.status ?? (e.failed ? 'failed' : '-')}`;

// Request classes (paths of the relay as the page requests them through the proxy).
const underPath = e => e.path.startsWith(`/${PATH}/`);
const EXEMPT = new RegExp(`^/${PATH}/(?:info|chat|stats)$|^/${PATH}/assets/`);  // path-scoped by contract
const isMedia = path => new RegExp(`^/${PATH}/(?:b/[0-9a-f]{32}/)?(?:live\\.m3u8|(?:[a-z0-9]+/)?hls/|dvr)`).test(path);
const isSession = path => /\/session(?:\/[0-9a-f]{32})?$/.test(path);
const isWhepPost = e => e.method === 'POST' && /\/whep$/.test(e.path);
const outsideScope = (entries, id) => entries.filter(e => underPath(e) && !EXEMPT.test(e.path) && !e.path.startsWith(scope(id)));

// ---- web proxy control ----------------------------------------------------------------------------------------------
const control = async (method, path, body) => (await getJson(CONTROL + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })).body;
const addFault = rule => control('POST', '/rules', rule);
const clearFaults = () => control('DELETE', '/rules');
const proxyLog = async (since = 0) => (await control('GET', `/log?since=${since}`)) || [];

// ---- processes ------------------------------------------------------------------------------------------------------
let shuttingDown = false;
let mtxDir, mtxEnv, mediamtx, relay, proxy, edge, THUMB;
const procs = { mediamtx: [], relay: [] };
const announcers = new Set(), publishers = [];
function startMediamtx(name) { const p = start(name, MEDIAMTX, ['mediamtx.yml'], { cwd: mtxDir, env: mtxEnv, logDir: TMP }); procs.mediamtx.push(p); return p; }
const relayEnv = extra => ({
  RELAY_PORT: String(PORT.relay), RELAY_PUBLISHER_TOKENS: `${TOKEN} ${PATH}`, RELAY_MEDIAMTX_API: MTX_API, RELAY_MEDIAMTX_WEBRTC: `http://127.0.0.1:${PORT.webrtc}`,
  RELAY_MEDIAMTX_HLS: `http://127.0.0.1:${PORT.hls}`, RELAY_MEDIAMTX_PLAYBACK: `http://127.0.0.1:${PORT.playback}`, RELAY_RECORD_DIR: join(mtxDir, 'recordings'),
  RELAY_RENDITIONS: '480p', RELAY_HLS_AAC: '1', RELAY_LOG_LEVEL: 'info', RELAY_ICE_SERVERS: '[]', RELAY_TURN_URLS: '', RELAY_TURN_SECRET: '',
  // A publisher away for 20 s (check 8) is still "waiting", not ended.
  RELAY_MEDIA_GRACE_MS: '45000',
  RELAY_FFMPEG: FFMPEG, RELAY_MEDIAMTX_RTSP: `rtsp://127.0.0.1:${PORT.rtsp}`, ...extra  // the quality ladder (lib/ladder.mjs)
});
function startRelay(name, extra = {}) {
  const cmd = BACKEND === 'spring' ? [JAVA, ['-Xms64m', '-jar', API_JAR]] : [process.execPath, [join(ROOT, 'server/relay.mjs')]];
  const p = start(name, cmd[0], cmd[1], { logDir: TMP, env: relayEnv(extra) }); procs.relay.push(p); return p;
}

// The app's publish: video, Opus (first audio, WebRTC), AAC-LC 48 kHz (second audio, HLS + recording), over RTSPS to the
// relay with the sender account. B looks (hue) and sounds (tone) different from A, so a screenshot shows which one plays.
const SOURCE = { A: { video: 'testsrc2=size=1280x720:rate=30', tone: 440 }, B: { video: 'testsrc2=size=1280x720:rate=30,hue=h=180', tone: 660 } };
const pubArgs = which => ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', SOURCE[which].video, '-f', 'lavfi', '-i', `sine=frequency=${SOURCE[which].tone}:sample_rate=48000`,
  '-map', '0:v', '-map', '1:a', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-bf', '0', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
  '-b:v', '3M', '-maxrate', '3M', '-bufsize', '3M', '-c:a:0', 'libopus', '-b:a:0', '128k', '-c:a:1', 'aac', '-b:a:1', '128k', '-ac', '2',
  '-f', 'rtsp', '-rtsp_transport', 'tcp', '-pkt_size', '1190', '-ca_file', join(TMP, 'cert.pem'), `rtsps://${USER}:${PASS}@127.0.0.1:${PORT.rtsps}/${PATH}`];
// Restarted with backoff when it exits (a relay MediaMTX restart drops it), like the app's forwarder, until stopped.
function startPublisher(which) {
  const p = { which, index: publishers.length, attempts: 0, stopped: false, proc: null, lines: [] };
  const steps = [1000, 2000, 3000, 5000];
  p.done = (async () => {
    let failures = 0;
    while (!p.stopped && !shuttingDown) {
      const t = Date.now();
      p.attempts++;
      p.proc = start(`publisher-${which}-${p.index}-${p.attempts}`, FFMPEG, pubArgs(which), { logDir: TMP });
      await p.proc.exited;
      p.lines.push(...p.proc.lines.slice(-20));
      if (p.stopped || shuttingDown) break;
      failures = Date.now() - t > 15000 ? 1 : failures + 1;
      await sleep(steps[Math.min(failures, steps.length) - 1]);
    }
  })();
  p.stop = async () => { p.stopped = true; await stop(p.proc); await timeout(p.done, 10000, 'publisher stop').catch(() => {}); };
  publishers.push(p);
  return p;
}
const announce = body => fetch(RELAY + '/api/broadcasts/announce', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body) });
// Contract v1 of the app: an announcement every 2 s while the broadcast runs.
function startAnnouncer(id, title) {
  const item = { id, title, publisher: PUBLISHER, path: PATH, width: 1280, height: 720, fps: 30, startedAtMs: Date.now(), bitrate: 3, audio: 'system' };
  const a = { id, item, statuses: {}, inflight: Promise.resolve(0) };
  const once = () => (a.inflight = (async () => {
    let status = 0;
    try { status = (await announce({ v: 1, type: 'announce', item: { ...item, sentAtMs: Date.now() } })).status; } catch {}
    a.statuses[status] = (a.statuses[status] || 0) + 1;
    return status;
  })());
  a.timer = setInterval(() => { if (!shuttingDown) once(); }, 2000);
  a.first = once();
  // An announcement still on its way after a "bye" would list the broadcast again: wait for it.
  a.stop = async () => { clearInterval(a.timer); announcers.delete(a); await a.inflight.catch(() => 0); };
  announcers.add(a);
  return a;
}
const uploadThumb = async id => { try { return (await fetch(`${RELAY}/api/broadcasts/${id}/thumbnail`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + TOKEN }, body: THUMB })).status; } catch { return 0; } };

// The chat history the relay holds for a broadcast, read over a raw WebSocket (join, then the history message).
function chatHistory(id) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT.relay}/${PATH}/chat`);
    let settled = false;
    const done = v => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve(v); };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', broadcastId: id, name: '' }));
    ws.onmessage = e => { const m = parse(e.data); if (m?.type === 'history') done({ ids: (m.messages || []).map(x => x.id) }); else if (m?.type === 'state' && !m.connected) done({ ids: [], refused: m.error }); };
    ws.onerror = () => done({ ids: [], error: true });
    setTimeout(() => done({ ids: [], timeout: true }), 6000);
  });
}

// ---- browser --------------------------------------------------------------------------------------------------------
// Installed in every document before the app's scripts: counts RTCPeerConnections, records overlay / FrameRuntime state
// changes (100 ms) and offers small DOM helpers. It never drives playback.
const PROBE = `(() => {
  if (window.__e2e) return;
  const e2e = window.__e2e = { pcs: 0, timeline: [], last: '' };
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const P = window[name];
    if (typeof P !== 'function') continue;
    const W = function (...args) { e2e.pcs++; return new P(...args); };
    W.prototype = P.prototype; Object.setPrototypeOf(W, P);
    try { window[name] = W; } catch {}
  }
  e2e.setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  e2e.labelled = text => { const l = [...document.querySelectorAll('label')].find(x => x.htmlFor && x.textContent.trim() === text); return l ? document.getElementById(l.htmlFor) : null; };
  e2e.button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text) || null;
  e2e.overlay = () => { const s = document.querySelector('[data-testid="watch-player"] [role="status"] strong'); return s ? s.textContent.trim() : ''; };
  // Longest time since resetStall() the picture stood still while no overlay explained it (a "silent" stall).
  e2e.stall = { from: 0, since: 0, lastT: -1, max: 0 };
  e2e.resetStall = () => { const now = Date.now(); e2e.stall = { from: now, since: now, lastT: -1, max: 0 }; };
  setInterval(() => {
    let rt = null; try { rt = window.FrameRuntime || null; } catch {}
    const w = rt && rt.watch, pb = rt && rt.playback, ch = rt && rt.chat;
    const row = { overlay: e2e.overlay(), kind: w ? w.kind : null, status: pb ? pb.status : null, mode: pb ? pb.mode : null, chat: ch ? ch.status : null, transport: rt ? rt.transport : null, path: location.pathname };
    const st = e2e.stall;
    if (st.from) {
      const v = document.querySelector('[data-testid="watch-video"]'), t = v ? v.currentTime : -1, now = Date.now();
      if (row.overlay || t !== st.lastT) { st.since = now; st.lastT = t; } else st.max = Math.max(st.max, now - st.since);
    }
    const key = JSON.stringify(row);
    if (key === e2e.last) return;
    e2e.last = key; row.t = Date.now(); e2e.timeline.push(row);
    if (e2e.timeline.length > 1500) e2e.timeline.splice(0, 300);
  }, 100);
})();`;
// For the WHEP check: a browser with neither Media Source Extensions nor native HLS.
const NO_HLS = `(() => {
  for (const name of ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource']) { try { Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true }); } catch {} }
  const can = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) { return /mpegurl/i.test(String(type)) ? '' : can.call(this, type); };
})();`;

const tabs = [];
const ev = (c, expression, ms = 15000) => timeout(c.evaluate(expression), ms, 'evaluate');
const cmd = (c, method, params = {}, ms = 15000) => timeout(c.send(method, params), ms, method);
const front = c => cmd(c, 'Page.bringToFront').catch(() => {});
async function shot(c, name) {
  try { await front(c); await sleep(200); writeFileSync(join(OUT, name + '.png'), await timeout(c.screenshot(), 20000, 'screenshot')); }
  catch (error) { result.notes.push(`screenshot ${name} failed: ${error.message}`); }
}

// Per page: every HTTP request (from the CDP Network domain, stamped on this machine's clock like the proxy log), the
// WebSockets and their chat frames, console errors.
function track(c) {
  const byId = new Map(), wsById = new Map();
  const header = (h, name) => { for (const k of Object.keys(h || {})) if (k.toLowerCase() === name) return h[k]; return undefined; };
  const push = (arr, v, max) => { arr.push(v); if (arr.length > max) arr.splice(0, arr.length - max); };
  c.on(msg => {
    const p = msg.params || {};
    switch (msg.method) {
      case 'Network.requestWillBeSent': {
        const prev = byId.get(p.requestId);
        if (prev && p.redirectResponse) { prev.status = p.redirectResponse.status; prev.tr = Date.now(); }
        let u; try { u = new URL(p.request.url); } catch { return; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        const e = { t: Date.now(), method: p.request.method, origin: u.origin, path: u.pathname, query: u.search, type: p.type || '', status: null };
        byId.set(p.requestId, e); push(c.net, e, 80000);
        if (byId.size > 80000) byId.delete(byId.keys().next().value);
        break;
      }
      case 'Network.requestServedFromCache': { const e = byId.get(p.requestId); if (e) e.fromCache = true; break; }
      case 'Network.responseReceived': {
        const e = byId.get(p.requestId), r = p.response || {};
        if (!e) break;
        e.status = r.status; e.tr = Date.now();
        const ra = header(r.headers, 'retry-after'); if (ra !== undefined) e.retryAfter = ra;
        const cc = header(r.headers, 'cache-control'); if (cc !== undefined) e.cache = cc;
        if (r.fromDiskCache || r.fromPrefetchCache || r.fromServiceWorker) e.fromCache = true;
        break;
      }
      case 'Network.loadingFailed': { const e = byId.get(p.requestId); if (e) { e.failed = p.errorText; e.canceled = !!p.canceled; e.tr ??= Date.now(); } break; }
      case 'Network.webSocketCreated': {
        let path = p.url; try { path = new URL(p.url).pathname; } catch {}
        const w = { id: p.requestId, path, t: Date.now(), status: null, closedAt: null };
        wsById.set(p.requestId, w); push(c.ws, w, 500);
        break;
      }
      case 'Network.webSocketHandshakeResponseReceived': { const w = wsById.get(p.requestId); if (w) w.status = p.response?.status ?? null; break; }
      case 'Network.webSocketClosed': { const w = wsById.get(p.requestId); if (w) w.closedAt = Date.now(); break; }
      case 'Network.webSocketFrameReceived': case 'Network.webSocketFrameSent': {
        const m = parse(p.response?.payloadData || '');
        if (!m || typeof m !== 'object') break;
        const f = { t: Date.now(), ws: p.requestId, dir: msg.method.endsWith('Sent') ? 'out' : 'in', type: m.type };
        if (m.type === 'history') f.ids = (m.messages || []).map(x => x.id);
        else if (m.type === 'message') f.id = m.id;
        else if (m.type === 'ack') Object.assign(f, { clientId: m.clientId, ok: m.ok, id: m.id, error: m.error });
        else if (m.type === 'send') f.clientId = m.clientId;
        else if (m.type === 'join') f.broadcastId = m.broadcastId;
        else if (m.type === 'state') Object.assign(f, { connected: m.connected, broadcastId: m.broadcastId });
        push(c.frames, f, 5000);
        break;
      }
      case 'Runtime.exceptionThrown': push(c.console, { t: Date.now(), level: 'exception', text: String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 300) }, 200); break;
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'warning') push(c.console, { t: Date.now(), level: p.type, text: (p.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300) }, 200);
        break;
    }
  });
}
// One Edge, at most 3 tabs: the launch tab becomes the first page, the others are opened here.
async function openTab(name, { origin = WEB, init = [] } = {}) {
  let id;
  if (!tabs.length) id = (await (await fetch(`http://127.0.0.1:${PORT.edge}/json`)).json()).find(t => t.type === 'page')?.id;
  if (!id) id = (await (await fetch(`http://127.0.0.1:${PORT.edge}/json/new?about:blank`, { method: 'PUT' })).json()).id;
  const c = await connect(PORT.edge, t => t.id === id);
  Object.assign(c, { name, id, origin, net: [], ws: [], frames: [], console: [] });
  track(c);
  await cmd(c, 'Runtime.enable'); await cmd(c, 'Page.enable');
  // Small payload buffers: nothing reads response bodies, and the media would otherwise be kept in the browser.
  await cmd(c, 'Network.enable', { maxTotalBufferSize: 2000000, maxResourceBufferSize: 200000 });
  // A common desktop size: the player is wide enough for the 720p source (hls.js caps automatic quality at the player
  // size, so a smaller window would rightly keep 480p).
  await cmd(c, 'Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cmd(c, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  for (const source of [...init, PROBE]) await cmd(c, 'Page.addScriptToEvaluateOnNewDocument', { source });
  tabs.push(c);
  return c;
}
// Full navigation; waits for the new document (the old one is marked, so the same address cannot pass early).
async function go(c, path, waitPath = path) {
  await ev(c, 'window.__e2eOld = true', 3000).catch(() => {});
  await cmd(c, 'Page.navigate', { url: c.origin + path });
  return !!(await waitFor(() => ev(c, `!window.__e2eOld && document.readyState === 'complete' && location.pathname === ${JSON.stringify(waitPath)}`, 3000), 20000, 100));
}
async function reload(c) {
  await ev(c, 'window.__e2eOld = true', 3000).catch(() => {});
  await cmd(c, 'Page.reload', { ignoreCache: true });
  return !!(await waitFor(() => ev(c, `!window.__e2eOld && document.readyState === 'complete'`, 3000), 20000, 100));
}
// A trusted click (CDP mouse events) at the element's centre; `finder` is an expression returning the element.
async function press(c, finder) {
  const box = await ev(c, `(() => { const el = ${finder}; if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  if (!box || !box.w) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cmd(c, 'Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}
const leaveToList = async c => {
  const clicked = await ev(c, `(() => { const a = document.querySelector('a[aria-label="라이브 목록으로"]'); if (a) a.click(); return !!a; })()`).catch(() => false);
  return clicked && !!(await waitFor(async () => (await ev(c, 'location.pathname')) === '/_frame/live', 8000, 50));
};
const cardSel = title => `a[aria-label=${JSON.stringify(`${title}, ${PUBLISHER} 방송 시청하기`)}]`;
const reqs = (c, from = 0, to = Infinity) => c.net.filter(e => e.t >= from && e.t < to);
const timeline = async (c, since) => (await ev(c, `window.__e2e ? window.__e2e.timeline.filter(x => x.t >= ${since}) : []`).catch(() => [])) || [];

// What the page shows and what the adapter says (window.FrameRuntime), in one read.
const state = c => ev(c, `(() => {
  const v = document.querySelector('[data-testid="watch-video"]');
  let rt = null; try { rt = window.FrameRuntime || null; } catch {}
  const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  const copy = o => (o && typeof o === 'object' ? JSON.parse(JSON.stringify(o)) : o ?? null);
  return {
    path: location.pathname, visibility: document.visibilityState, overlay: window.__e2e ? window.__e2e.overlay() : '',
    message: (document.querySelector('[data-testid="watch-player"] [role="status"] p') || {}).textContent || '',
    soundButton: !!(window.__e2e && window.__e2e.button('소리 켜기')), pcs: window.__e2e ? window.__e2e.pcs : null,
    video: v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(3), paused: v.paused, muted: v.muted, readyState: v.readyState,
      frames: q ? q.totalVideoFrames : null, audioBytes: typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : null,
      src: v.srcObject ? 'srcObject' : (v.currentSrc || '').startsWith('blob:') ? 'blob' : v.currentSrc ? new URL(v.currentSrc).pathname : '' } : null,
    rt: rt ? { adapter: rt.adapter, transport: rt.transport, watch: copy(rt.watch), playback: copy(rt.playback), session: copy(rt.session), chat: copy(rt.chat) } : null
  };
})()`);
async function playing(c, ms = 3000) {
  const a = await state(c); await sleep(ms); const b = await state(c);
  const va = a.video, vb = b.video;
  const ok = !!(va && vb && vb.w > 0 && vb.t - va.t > ms / 2000 && (vb.frames === null || vb.frames > va.frames));
  return { ok, advancedS: va && vb ? +(vb.t - va.t).toFixed(2) : 0, frames: va && vb && vb.frames !== null ? vb.frames - va.frames : null,
    audioBytes: va && vb && vb.audioBytes !== null ? vb.audioBytes - va.audioBytes : null, first: a, second: b };
}
// Plays: frames advance and no overlay. Presses "소리 켜기" (trusted click) if autoplay with sound was blocked.
async function waitPlaying(c, ms = 30000) {
  let last = null;
  const ok = await waitFor(async () => {
    const s = await state(c);
    if (s.soundButton) { result.notes.push(`${c.name}: autoplay with sound blocked, pressed 소리 켜기`); await press(c, `window.__e2e.button('소리 켜기')`); }
    if (!(s.video?.w > 0)) return null;
    last = await playing(c, 1500);
    return last.ok && !last.second.overlay ? last : null;
  }, ms, 200);
  return ok || { advancedS: 0, ...(last || {}), ok: false };  // never a sample that missed the condition (an overlay still shown)
}
const summary = s => s && { overlay: s.overlay, kind: s.rt?.watch?.kind, video: s.video && { w: s.video.w, h: s.video.h, t: s.video.t, frames: s.video.frames }, transport: s.rt?.transport };

async function chooseQuality(c, pick) {
  await ev(c, `(() => { const b = document.querySelector('[data-testid="watch-controls"] button[aria-label="화질"]'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return !!b; })()`);
  const options = await waitFor(() => ev(c, `(() => { const g = document.querySelector('[role="group"][aria-label="화질 선택"]'); return g ? [...g.querySelectorAll('label')].map(l => { const i = l.querySelector('input[type="radio"]'); return { value: i ? i.value : null, text: l.textContent.trim(), checked: !!(i && i.checked) }; }) : null; })()`), 6000, 100);
  if (!options) return { options: null, chosen: null };
  const index = options.findIndex(o => (pick === 'auto' ? o.value === 'auto' || o.text.startsWith('자동') : o.value !== 'auto' && !o.text.startsWith('자동') && o.text.includes(pick)));
  if (index < 0) return { options, chosen: null };
  await ev(c, `(() => { const g = document.querySelector('[role="group"][aria-label="화질 선택"]'); g.querySelectorAll('label')[${index}].querySelector('input[type="radio"]').click(); return true; })()`);
  return { options, chosen: options[index] };
}

const NICK = 'button[aria-label^="채팅 닉네임"]';
async function setNickname(c, name) {
  const ready = await waitFor(() => ev(c, `(() => { const b = document.querySelector('${NICK}'); return !!b && !b.disabled; })()`), 20000, 100);
  if (!ready) return { ok: false, reason: 'chat not connected' };
  if ((await ev(c, `document.querySelector('${NICK}').getAttribute('aria-label')`)).endsWith('현재 ' + name)) return { ok: true, already: true };
  await ev(c, `document.querySelector('${NICK}').click(); true`);
  if (!(await waitFor(() => ev(c, `!!window.__e2e.labelled('닉네임')`), 5000, 100))) return { ok: false, reason: 'no nickname dialog' };
  await ev(c, `window.__e2e.setValue(window.__e2e.labelled('닉네임'), ${JSON.stringify(name)}); true`);
  await sleep(100);
  const submit = await ev(c, `(() => { const b = window.__e2e.labelled('닉네임').form.querySelector('button[type="submit"]'); const text = b.textContent.trim(); b.click(); return text; })()`);
  const set = await waitFor(() => ev(c, `(() => { const b = document.querySelector('${NICK}'); return !!b && b.getAttribute('aria-label').endsWith(${JSON.stringify('현재 ' + name)}) && !document.querySelector('dialog[open]'); })()`), 10000, 100);
  return { ok: !!set, submit };
}
const countText = text => `[...document.querySelectorAll('[role="log"] li')].filter(li => li.textContent.includes(${JSON.stringify(text)})).length`;
async function sendChat(c, text) {
  if (!(await waitFor(() => ev(c, `(() => { const t = window.__e2e.labelled('채팅 메시지 입력'); return !!t && !t.readOnly; })()`), 15000, 100))) return { ok: false, reason: 'composer not ready' };
  await ev(c, `window.__e2e.setValue(window.__e2e.labelled('채팅 메시지 입력'), ${JSON.stringify(text)}); true`);
  await sleep(50);
  const t0 = Date.now();
  const clicked = await ev(c, `(() => { const b = [...window.__e2e.labelled('채팅 메시지 입력').form.querySelectorAll('button[type="submit"]')].find(x => x.textContent.trim() === '보내기'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  // Acknowledged: the message is in the log, the button is back to 보내기 (pending cleared) and the draft is empty.
  const shown = await waitFor(() => ev(c, `(() => { const t = window.__e2e.labelled('채팅 메시지 입력'); const b = t.form.querySelector('button[type="submit"]'); const n = ${countText(text)}; return n >= 1 && b.textContent.trim() === '보내기' && t.value === '' ? n : 0; })()`), 10000, 50);
  const sent = c.frames.find(f => f.dir === 'out' && f.type === 'send' && f.t >= t0);
  const ack = sent && c.frames.find(f => f.dir === 'in' && f.type === 'ack' && f.clientId === sent.clientId);
  const chat = (await state(c)).rt?.chat;
  // FrameRuntime.chat.lastAckId follows the server's ack.
  return { ok: !!(clicked && shown && ack?.ok && chat?.lastAckId === ack.id), clicked, shownTimes: shown, ackMs: shown ? Date.now() - t0 : null, ack: ack ? { ok: ack.ok, id: ack.id, error: ack.error } : null, lastAckId: chat?.lastAckId ?? null };
}

// ---- checks ---------------------------------------------------------------------------------------------------------
let p1, p2, p3, pubA, pubB, annA, annB, tOpenA = 0, tOpenB = 0;

async function stepList() {
  p1 = await openTab('p1');
  await go(p1, '/_frame/live');
  await front(p1);
  const api = await getJson(RELAY + '/api/broadcasts');
  const empty = await waitFor(() => ev(p1, `document.body.innerText.includes('지금 방송 중인 채널이 없어요')`), 15000, 100);
  check('1a list: no broadcast -> empty state (200 + [])', empty && api.status === 200 && api.body?.items?.length === 0, { emptyShown: !!empty, status: api.status, items: api.body?.items?.length });

  const tf = Date.now();
  const rule = await addFault({ method: 'GET', pathRegex: '^/api/broadcasts$', status: 500 });
  await reload(p1);
  const error = await waitFor(() => ev(p1, `document.body.innerText.includes('방송 목록을 불러오지 못했어요')`), 20000, 100);
  const emptyToo = await ev(p1, `document.body.innerText.includes('지금 방송 중인 채널이 없어요')`);
  const faulted = (await proxyLog(tf)).filter(e => e.path === '/api/broadcasts' && e.fault);
  await clearFaults();
  check('1b list: /api/broadcasts 500 -> error state, not the empty state', error && !emptyToo && faulted.length > 0, { errorShown: !!error, emptyShown: emptyToo, faultedRequests: faulted.length, rule: rule?.id });

  pubA = startPublisher('A');
  const ready = await waitFor(async () => (await mtxPath(PATH)).ready, 30000, 250);
  annA = startAnnouncer(ID_A, TITLE_A);
  const annStatus = await annA.first;
  const thumb = await uploadThumb(ID_A);
  const isListed = await waitFor(() => listed(ID_A), 20000, 250);
  const retried = await ev(p1, `(() => { const b = window.__e2e.button('다시 시도'); if (b) b.click(); return !!b; })()`);
  const sel = cardSel(TITLE_A), want = `/_frame/watch/${PATH}/${ID_A}`;
  const card = await waitFor(() => ev(p1, `!!document.querySelector(${JSON.stringify(sel)})`), 25000, 100);
  await sleep(800);  // the thumbnail
  const thumbShown = await ev(p1, `(() => { const i = document.querySelector(${JSON.stringify(sel)} + ' img'); return !!(i && i.complete && i.naturalWidth > 0); })()`);
  await shot(p1, 'web-list');
  const href = card ? await ev(p1, `document.querySelector(${JSON.stringify(sel)}).getAttribute('href')`) : null;
  tOpenA = Date.now();
  const pressed = card ? await press(p1, `document.querySelector(${JSON.stringify(sel)})`) : false;
  const opened = await waitFor(async () => (await ev(p1, 'location.pathname')) === want, 10000, 50);
  check('1c list: card for A; clicking it opens /_frame/watch/screen-01/<A>', ready && annStatus === 204 && isListed && card && pressed && opened && href === want,
    { publisherReady: !!ready, announce: annStatus, thumbnailUpload: thumb, listed: !!isListed, retryButton: retried, cardShown: !!card, thumbnailShown: thumbShown, href, opened: !!opened });
}

async function stepPlayback() {
  const first = await waitFor(async () => {
    const s = await state(p1);
    if (s.soundButton) { result.notes.push('p1: autoplay with sound blocked, pressed 소리 켜기'); await press(p1, `window.__e2e.button('소리 켜기')`); }
    return s.video?.w > 0 && s.video.t > 0 ? s : null;
  }, 30000, 100);
  const firstFrameMs = first ? Date.now() - tOpenA : null;
  // Auto quality starts on the level the default estimate allows (480p or 720p here) and then climbs: hls.js measures
  // about the playing level's bitrate on LL-HLS (parts stream while produced), so the adapter probes one level up every
  // 20 s while the buffer holds (apps/web/src/relay/player.ts probeUp). The source is 1280x720.
  const hd = await waitFor(async () => { const s = await state(p1); return s.video?.w === 1280 && s.video.h === 720 ? s : null; }, 45000, 250);
  const play = await playing(p1, 4000);
  const s = play.second;
  const mine = reqs(p1, tOpenA), media = mine.filter(e => isMedia(e.path)), outside = outsideScope(mine, ID_A);
  const sessionPost = mine.find(e => e.method === 'POST' && e.path === scope(ID_A) + 'session');
  const sessionBeforeMedia = !!sessionPost && (!media.length || sessionPost.t <= media[0].t);
  const adapterRequests = await ev(p1, `window.FrameRuntime ? window.FrameRuntime.requests.slice(0, 12) : null`).catch(() => null);
  check('2 playback: A plays via hls.js, 1280x720 with audio, no RTCPeerConnection, media only under /screen-01/b/<A>/',
    first && hd && play.ok && s.video?.w === 1280 && s.video.h === 720 && play.audioBytes > 0 && s.rt?.adapter === 'relay' && s.rt.transport === 'hls.js' && s.pcs === 0
      && s.rt.watch?.broadcastId === ID_A && media.length > 0 && outside.length === 0 && sessionPost?.status === 200 && sessionBeforeMedia,
    { firstFrameMs, size: s.video && `${s.video.w}x${s.video.h}`, advancedS: play.advancedS, frames: play.frames, audioBytes: play.audioBytes, transport: s.rt?.transport, pcs: s.pcs,
      adapter: s.rt?.adapter, watch: s.rt?.watch, mediaRequests: media.length, outsideScope: outside.slice(0, 5).map(brief), session: sessionPost && brief(sessionPost), sessionBeforeMedia,
      level: s.rt?.playback?.level, latencyS: s.rt?.playback?.latency, muted: s.video?.muted, sample: media.slice(0, 4).map(brief), adapterRequests });
  await shot(p1, 'web-playing');
}

// The relay's broadcast-scoped routes, asked directly (no browser).
async function stepScopedRoutes() {
  const other = 'f'.repeat(32);
  const info = await getJson(`${RELAY}/${PATH}/info`);
  const live = await raw(RELAY + scope(ID_A) + 'live.m3u8');
  const q480 = await raw(RELAY + scope(ID_A) + 'live.m3u8?q=480p');
  const media = await raw(RELAY + scope(ID_A) + 'src/hls/video1_stream.m3u8');
  const wrong = await raw(RELAY + scope(other) + 'live.m3u8');
  const sess = await getJson(RELAY + scope(ID_A) + 'session', { method: 'POST' });
  const sessDel = sess.body?.sid ? (await raw(RELAY + scope(ID_A) + 'session/' + sess.body.sid, { method: 'DELETE' })).status : null;
  const wrongSess = await getJson(RELAY + scope(other) + 'session', { method: 'POST' });
  // A media file of the scoped variant (its init): cached publicly for 60 s under a URL that names the broadcast.
  const mapUri = /#EXT-X-MAP:URI="([^"]+)"/.exec(media.text)?.[1] || '';
  const init = mapUri && relative(mapUri) ? await raw(RELAY + scope(ID_A) + 'src/hls/' + mapUri) : null;
  const all = [...uris(live.text), ...tagUris(live.text)];
  const out = { infoScope: info.body?.hls?.scope, infoBroadcast: info.body?.broadcastId === ID_A, live: { status: live.status, cache: live.cache, uris: uris(live.text), media: tagUris(live.text) },
    q480: { status: q480.status, uris: uris(q480.text) }, mediaPlaylist: { status: media.status, cache: media.cache, setCookie: !!media.setCookie },
    init: init && { uri: mapUri, status: init.status, cache: init.cache, setCookie: !!init.setCookie },
    wrongId: { status: wrong.status, cache: wrong.cache, body: wrong.json }, session: { post: sess.status, heartbeatMs: sess.body?.heartbeatMs, delete: sessDel }, wrongIdSession: wrongSess.status };
  check('2b relay: /info hls.scope, scoped live.m3u8 with relative URIs, media playlist max-age=1 and media public max-age=60 (no cookie), other id -> 409 no-store, scoped session',
    out.infoScope === `b/${ID_A}/` && out.infoBroadcast && live.status === 200 && all.length >= 4 && all.every(relative) && out.live.uris.includes('src/hls/video1_stream.m3u8') && out.live.uris.includes('480p/hls/video1_stream.m3u8')
      && q480.status === 200 && out.q480.uris.join() === '480p/hls/video1_stream.m3u8' && media.status === 200 && media.cache === 'max-age=1' && !media.setCookie
      && init?.status === 200 && init.cache === 'public, max-age=60' && !init.setCookie
      && wrong.status === 409 && wrong.cache === 'no-store' && wrong.json?.error === 'broadcast-changed' && sess.status === 200 && sessDel === 204 && wrongSess.status === 409, out);
}

async function stepQuality() {
  await front(p1);
  const before = await state(p1);
  const pick = await chooseQuality(p1, '480p');
  const t0 = Date.now();
  const to480 = await waitFor(async () => (await state(p1)).video?.h === 480, 10000, 100);
  const switchMs = to480 ? Date.now() - t0 : null;
  const after = await playing(p1, 3000);
  const variant = reqs(p1, t0).filter(e => e.path.startsWith(scope(ID_A) + '480p/'));
  check('3a quality: 480p from the menu -> videoHeight 480 within 10 s, keeps playing', pick.chosen && to480 && after.ok && after.second.video?.h === 480 && variant.length > 0 && outsideScope(reqs(p1, t0), ID_A).length === 0,
    { switchMs, options: pick.options?.map(o => `${o.value}:${o.text}`), chosen: pick.chosen?.value, heightBefore: before.video?.h, quality: after.second.rt?.playback?.quality,
      level: after.second.rt?.playback?.level, advancedS: after.advancedS, scopedVariantRequests: variant.length });
  const pickAuto = await chooseQuality(p1, 'auto');
  const t1 = Date.now();
  // From 480p the automatic choice climbs by the adapter's up-probe (one level per 20 s while the buffer holds).
  const back = await waitFor(async () => (await state(p1)).video?.h === 720, 45000, 200);
  const backMs = back ? Date.now() - t1 : null;
  const afterAuto = await playing(p1, 2000);
  check('3b quality: 자동 -> back to 720', pickAuto.chosen && back && afterAuto.ok && afterAuto.second.video?.h === 720,
    { backMs, chosen: pickAuto.chosen?.value, quality: afterAuto.second.rt?.playback?.quality, activeQualityLabel: afterAuto.second.rt?.playback?.activeQualityLabel, advancedS: afterAuto.advancedS });
}

async function stepChat() {
  p2 = await openTab('p2', { origin: WEB2 });
  await go(p2, `/_frame/watch/${PATH}/${ID_A}`);
  const p2Chat = await waitFor(async () => (await state(p2)).rt?.chat?.status === 'connected', 20000, 200);
  await front(p1);
  const nick = await setNickname(p1, '웹 검증 시청자');
  const text = `React 웹 채팅 확인 ${Date.now().toString(36)}`;
  const t0 = Date.now();
  const sent = await sendChat(p1, text);
  const join = p1.frames.filter(f => f.dir === 'out' && f.type === 'join').at(-1);
  const sockets = [...new Set(p1.ws.filter(w => w.t >= tOpenA).map(w => w.path))];
  check('4a chat: nickname set, message sent and acknowledged (pending clears)', nick.ok && sent.ok && join?.broadcastId === ID_A && sockets.length === 1 && sockets[0] === `/${PATH}/chat`,
    { nickname: nick, ...sent, joinBroadcastIsA: join?.broadcastId === ID_A, sockets });
  const got = await waitFor(() => ev(p2, countText(text)).then(n => (n ? Date.now() : 0)), 10000, 100);
  await sleep(2000);
  const times = await ev(p2, countText(text));
  const frames = p2.frames.filter(f => f.dir === 'in' && f.type === 'message' && f.t >= t0).length;
  check('4b chat: a second page on A (other origin) receives it exactly once', p2Chat && got && times === 1, { p2Connected: !!p2Chat, shownTimes: times, messageFrames: frames, shownAfterMs: got ? got - t0 : null });
}

async function stepDvr() {
  await front(p1);
  const range = await waitFor(async () => {
    const r = await ev(p1, `(() => { const i = document.querySelector('input[aria-label="재생 위치"]'); return i && !i.disabled ? { min: Number(i.min), max: Number(i.max) } : null; })()`);
    return r && r.max - r.min >= 20000 ? r : null;
  }, 90000, 500);
  if (!range) { check('5a DVR: seek near the start -> history mode at the target', false, { reason: 'the timeline never covered 20 s', playback: (await state(p1)).rt?.playback }); return; }
  const t0 = Date.now();
  // The range input as a user sets it without a pointer (keyboard): the value, then its input event.
  const target = await ev(p1, `(() => { const i = document.querySelector('input[aria-label="재생 위치"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, String(Number(i.min) + 2000)); const v = Number(i.value); i.dispatchEvent(new Event('input', { bubbles: true })); return v; })()`);
  const hist = await waitFor(async () => { const s = await state(p1); return s.rt?.playback?.mode === 'history' && s.video?.w > 0 ? s : null; }, 20000, 100);
  const histAt = hist ? Date.now() : null;
  const histPlay = hist && await waitFor(async () => { const r = await playing(p1, 1000); return r.ok && r.second.rt?.playback?.mode === 'history' ? r : null; }, 15000, 100);
  const pos = histPlay?.first?.rt?.playback?.positionMs;
  const offset = Number.isFinite(pos) ? pos - target : null;
  const dvr = reqs(p1, t0).filter(e => /\/dvr/.test(e.path));
  const files = dvr.filter(e => /\/dvr\/file/.test(e.path));
  // The recording itself must come from the scoped dvr/file route (not the live back buffer or another route).
  check('5a DVR: seek near the start -> history mode, position within ~5 s of the target', hist && histPlay && offset !== null && Math.abs(offset) <= 5000 && files.length > 0
      && dvr.every(e => e.path.startsWith(scope(ID_A))) && files.every(e => e.query.includes('id=' + ID_A)),
    { range, target, positionMs: pos, offsetMs: offset, toHistoryMs: histAt ? histAt - t0 : null, dvrRequests: dvr.length, fileRequests: files.length, outsideScope: dvr.filter(e => !e.path.startsWith(scope(ID_A))).slice(0, 3).map(brief),
      sample: dvr.slice(0, 3).map(brief), ranges: histPlay?.second?.rt?.playback?.ranges?.length });
  await shot(p1, 'web-history');

  const tl = Date.now();
  const pressed = await ev(p1, `(() => { const b = window.__e2e.button('실시간 복귀'); if (b) b.click(); return !!b; })()`);
  const live = await waitFor(async () => { const s = await state(p1); const pb = s.rt?.playback; return pb?.mode === 'live' && Number.isFinite(pb.latency) && pb.latency < 4 && s.video?.w > 0 ? s : null; }, 20000, 200);
  const backMs = live ? Date.now() - tl : null;
  const livePlay = await playing(p1, 2000);
  check('5b DVR: 실시간 복귀 -> live again, latency < 4 s', pressed && live && livePlay.ok && livePlay.second.rt?.playback?.mode === 'live' && outsideScope(reqs(p1, tl), ID_A).length === 0,
    { pressed, backMs, latencyS: live?.rt?.playback?.latency, latencyAfter2sS: livePlay.second.rt?.playback?.latency, mode: livePlay.second.rt?.playback?.mode, advancedS: livePlay.advancedS });

  const idx = await getJson(RELAY + scope(ID_A) + 'dvr');
  const pl = await raw(RELAY + scope(ID_A) + 'dvr.m3u8');
  const segs = uris(pl.text), map = tagUris(pl.text);
  const otherId = segs[0] ? await raw(new URL(segs[0].replace(`id=${ID_A}`, 'id=' + 'f'.repeat(32)), RELAY + scope(ID_A)).href) : null;
  check('5c relay: scoped DVR index and dvr.m3u8 (relative dvr/file URIs with id=<A>); another id -> 409', idx.body?.id === ID_A && pl.status === 200 && segs.length > 0
      && [...segs, ...map].every(u => relative(u) && u.startsWith('dvr/file') && u.includes('id=' + ID_A)) && otherId?.status === 409,
    { indexId: idx.body?.id === ID_A, ranges: idx.body?.ranges?.length, playlist: pl.status, segments: segs.length, first: segs[0], map: map[0], otherIdStatus: otherId?.status });
}

async function stepPathReuse() {
  await front(p1);
  const tBye = Date.now();
  await annA.stop();
  const bye = await announce({ v: 1, type: 'bye', id: ID_A });
  const tByeDone = Date.now();
  // Nothing on the path for a moment (A said bye, B is not announced yet): A's scoped routes are "not running", uncached.
  const gone = { live: await raw(RELAY + scope(ID_A) + 'live.m3u8'), info: (await getJson(`${RELAY}/${PATH}/info`)).body };
  check('6a0 relay: right after A\'s bye (nothing on the path) /screen-01/b/<A>/live.m3u8 -> 404 not-running, no-store; /info running:false',
    bye.status === 204 && gone.live.status === 404 && gone.live.json?.error === 'not-running' && gone.live.cache === 'no-store' && gone.info?.running === false,
    { bye: bye.status, status: gone.live.status, cache: gone.live.cache, body: gone.live.json, infoRunning: gone.info?.running });
  // B is announced while A's publisher still sends: B's scoped media must wait instead of showing A.
  annB = startAnnouncer(ID_B, TITLE_B);
  const annB0 = await annB.first;
  const early = { scoped: await raw(RELAY + scope(ID_B) + 'live.m3u8'), info: (await getJson(`${RELAY}/${PATH}/info`)).body, legacy: (await raw(`${RELAY}/${PATH}/live.m3u8`)).status };
  await pubA.stop();
  pubB = startPublisher('B');
  const bReady = await waitFor(async () => (await raw(RELAY + scope(ID_B) + 'live.m3u8')).status === 200 ? Date.now() : null, 40000, 250);
  const thumbB = await uploadThumb(ID_B);
  const legacyAfter = (await raw(`${RELAY}/${PATH}/live.m3u8`)).status;
  check('6a path reuse: B announced while A still publishes -> B scoped live.m3u8 waits (503 + Retry-After), then serves B',
    bye.status === 204 && annB0 === 204 && early.scoped.status === 503 && !!early.scoped.retryAfter && bReady,
    { bye: bye.status, announceB: annB0, scopedWhileAPublishes: { status: early.scoped.status, retryAfter: early.scoped.retryAfter, body: early.scoped.text.slice(0, 60) },
      infoWhileAPublishes: { running: early.info?.running, mediaReady: early.info?.mediaReady, broadcastIsB: early.info?.broadcastId === ID_B }, bReadyAfterMs: bReady ? bReady - tByeDone : null, thumbnailB: thumbB });
  result.notes.push(`legacy /${PATH}/live.m3u8: ${early.legacy} while B was announced and A's publisher still sent (the path link serves whatever the path carries), ${legacyAfter} once B published`);

  const ended = await waitFor(async () => { const s = await state(p1); return s.overlay === OVERLAY.ended ? s : null; }, 25000, 200);
  // When page A first showed it (its probe's timeline), not when this script looked again after B was ready.
  const endedAt = ended ? (await timeline(p1, tBye)).find(x => x.overlay === OVERLAY.ended)?.t ?? null : null;
  const endedMs = endedAt ? endedAt - tBye : null;
  await shot(p1, 'web-ended');

  const oldA = {
    live: await raw(RELAY + scope(ID_A) + 'live.m3u8'), media: (await raw(RELAY + scope(ID_A) + 'src/hls/video1_stream.m3u8')).status, dvr: (await raw(RELAY + scope(ID_A) + 'dvr')).status,
    dvrPlaylist: (await raw(RELAY + scope(ID_A) + 'dvr.m3u8')).status, dvrFile: (await raw(RELAY + scope(ID_A) + `dvr/file.mp4?id=${ID_A}&f=1&s=0`)).status,
    session: (await raw(RELAY + scope(ID_A) + 'session', { method: 'POST' })).status, idOfAUnderB: (await raw(RELAY + scope(ID_B) + `dvr/file.mp4?id=${ID_A}&f=1&s=0`)).status
  };
  const statuses = [oldA.media, oldA.dvr, oldA.dvrPlaylist, oldA.dvrFile, oldA.session, oldA.idOfAUnderB];
  check('6c relay: /screen-01/b/<A>/* after B started -> 409 broadcast-changed, no-store; id=<A> under B -> 409',
    oldA.live.status === 409 && oldA.live.cache === 'no-store' && oldA.live.json?.error === 'broadcast-changed' && statuses.every(s => s === 409),
    { live: { status: oldA.live.status, cache: oldA.live.cache, body: oldA.live.json }, media: oldA.media, dvr: oldA.dvr, dvrPlaylist: oldA.dvrPlaylist, dvrFile: oldA.dvrFile, session: oldA.session, idOfAUnderB: oldA.idOfAUnderB });

  // A fresh direct visit of A's link (the second page).
  const tNav = Date.now();
  await go(p2, `/_frame/watch/${PATH}/${ID_A}`);
  await front(p2);
  const shown = await waitFor(async () => { const s = await state(p2); return s.overlay === OVERLAY.ended || s.overlay === OVERLAY.unavailable ? s : null; }, 20000, 200);
  await sleep(6000);
  const after = await state(p2);
  const navReqs = reqs(p2, tNav), toB = navReqs.filter(e => e.path.includes(`/b/${ID_B}/`)), media200 = navReqs.filter(e => isMedia(e.path) && e.status === 200);
  check('6d an old direct link to A -> ended/unavailable, never plays, never asks for B', shown && !(after.video?.w > 0) && !(after.video?.t > 0) && toB.length === 0 && media200.length === 0,
    { overlay: shown?.overlay, kind: after.rt?.watch?.kind, video: after.video && { w: after.video.w, t: after.video.t }, requestsForB: toB.length, media200: media200.length, requests: navReqs.filter(underPath).slice(0, 8).map(brief) });

  // The list now shows B only, and B plays.
  await go(p2, '/_frame/live');
  const selB = cardSel(TITLE_B), selA = cardSel(TITLE_A);
  const cardB = await waitFor(() => ev(p2, `!!document.querySelector(${JSON.stringify(selB)})`), 20000, 200);
  const cardA = await ev(p2, `!!document.querySelector(${JSON.stringify(selA)})`);
  tOpenB = Date.now();
  const pressed = cardB ? await press(p2, `document.querySelector(${JSON.stringify(selB)})`) : false;
  const openedB = await waitFor(async () => (await ev(p2, 'location.pathname')) === `/_frame/watch/${PATH}/${ID_B}`, 10000, 50);
  const playB = await waitPlaying(p2, 40000);
  const bReqs = reqs(p2, tOpenB);
  check('6e list shows B only; B plays with every media request under /screen-01/b/<B>/', cardB && !cardA && pressed && openedB && playB.ok && playB.second?.rt?.watch?.broadcastId === ID_B
      && bReqs.filter(e => isMedia(e.path)).length > 0 && outsideScope(bReqs, ID_B).length === 0,
    { cardB: !!cardB, cardA, opened: !!openedB, ...summary(playB.second), advancedS: playB.advancedS, mediaRequests: bReqs.filter(e => isMedia(e.path)).length, outsideScope: outsideScope(bReqs, ID_B).slice(0, 5).map(brief) });
  await shot(p2, 'web-playing-b');

  // Page A over the whole switch, B playing meanwhile. The second page was an open A page too until 6d, then the old link
  // until it opened B from the list: neither may ask for B's media or join, or receive, B's chat before that.
  const aNow = await state(p1);
  const toBOf = (c, from, to = Infinity) => reqs(c, from, to).filter(e => e.path.includes(`/b/${ID_B}/`));
  const chatOfB = (c, from, to = Infinity) => c.frames.filter(f => f.t > from && f.t < to && (
    (f.dir === 'out' && f.type === 'join' && f.broadcastId !== ID_A)
    || (f.dir === 'in' && f.type === 'state' && f.connected && f.broadcastId !== ID_A)
    || (f.dir === 'in' && f.type === 'message' && typeof f.id === 'string' && f.id.startsWith(ID_B.slice(0, 8) + '-'))));  // chat.mjs ids
  const aToB = [...toBOf(p1, tBye), ...toBOf(p2, tBye, tOpenB)], chatB = [...chatOfB(p1, tBye), ...chatOfB(p2, tBye, tOpenB)];
  const a200 = (await proxyLog(tByeDone)).filter(e => e.path.startsWith(scope(ID_A)) && e.t > tByeDone && e.status === 200 && !e.fault);
  const frozen = !aNow.video || aNow.video.w === 0 || (!!ended && aNow.video.frames === ended.video?.frames && Math.abs(aNow.video.t - (ended.video?.t ?? 0)) < 0.05);
  const chatClosed = aNow.rt?.chat?.status === 'closed' || await ev(p1, `document.body.innerText.includes('채팅 연결이 종료됐어요')`);
  check('6b path reuse: page A shows ended, never plays B (no /b/<B>/ request, no 200 for /b/<A>/ after bye), its chat closed and never on B',
    ended && frozen && aToB.length === 0 && a200.length === 0 && chatClosed && chatB.length === 0,
    { endedAfterMs: endedMs, frozen, videoAtEnd: summary(aNow)?.video, requestsForB: aToB.slice(0, 5).map(brief), scopedA200AfterBye: a200.slice(0, 5).map(brief), chatStatus: aNow.rt?.chat?.status,
      chatFramesOfB: chatB.slice(0, 5), chatSocketsAfterBye: p1.ws.filter(w => w.t > tByeDone).map(w => ({ path: w.path, status: w.status, closed: !!w.closedAt })) });

  // 6f: a key change inside the page (no reload): the B page follows a link to A's watch address. React keeps the
  // document, so only the adapter can stop B's player, session and chat socket.
  const before = await state(p2);
  const sidB = before.rt?.session?.sid || null;
  const openWs = p2.ws.filter(w => !w.closedAt && w.path === `/${PATH}/chat` && w.t >= tOpenB);
  const tk = Date.now();
  await ev(p2, `(() => { history.pushState(null, '', ${JSON.stringify(`/_frame/watch/${PATH}/${ID_A}`)}); dispatchEvent(new PopStateEvent('popstate', { state: null })); return true; })()`);
  const switched = await waitFor(async () => { const s = await state(p2); return s.path === `/_frame/watch/${PATH}/${ID_A}` && (s.overlay === OVERLAY.ended || s.overlay === OVERLAY.unavailable) ? s : null; }, 15000, 100);
  const wsClosed = await waitFor(() => (openWs.length && openWs.every(w => w.closedAt) ? Date.now() : null), 8000, 100);
  await sleep(Math.max(0, tk + 8000 - Date.now()));
  const still = await playing(p2, 2000);
  const lateB = reqs(p2, tk + 1500).filter(e => e.path.startsWith(scope(ID_B)));
  const deletes = reqs(p2, tk).filter(e => e.method === 'DELETE' && isSession(e.path));
  const joinsAfter = p2.frames.filter(f => f.t > tk && f.dir === 'out' && f.type === 'join');
  check('6f key change in the page (B -> A link, no reload): B session deleted, B chat socket closed, no B request after 1.5 s, nothing plays',
    before.rt?.watch?.broadcastId === ID_B && !!sidB && switched && wsClosed && !still.ok && lateB.length === 0 && joinsAfter.length === 0
      && deletes.some(e => e.path === scope(ID_B) + 'session/' + sidB && e.status === 204),
    { sidB: !!sidB, sessionBefore: before.rt?.session, visibilityBefore: before.visibility, overlay: switched?.overlay, kind: switched?.rt?.watch?.kind, chatSocketClosedAfterMs: wsClosed ? wsClosed - tk : null, openSockets: openWs.length,
      advancedS: still.advancedS, requestsForBAfter1500ms: lateB.slice(0, 5).map(brief), deletes: deletes.map(brief), joins: joinsAfter.length });
  // Back to B (history entry before the pushed one), as the next checks expect.
  await ev(p2, 'history.back(); true');
  if (!(await waitFor(async () => (await ev(p2, 'location.pathname')) === `/_frame/watch/${PATH}/${ID_B}`, 5000, 100))) await go(p2, `/_frame/watch/${PATH}/${ID_B}`);
  const backB = await waitPlaying(p2, 40000);
  if (!backB.ok) result.notes.push('6f: page 2 did not play B again after the key change; the next checks start from that state');
}

async function stepReconnect() {
  await go(p1, '/_frame/live');  // page A is done: keep the load low
  await front(p2);
  await ev(p2, 'window.__e2e.resetStall(); true').catch(() => {});
  const t0 = Date.now(), attempts0 = pubB.attempts;
  await stop(mediamtx);
  mediamtx = startMediamtx('mediamtx-restarted');
  const apiBack = await waitFor(async () => (await fetch(MTX_API + '/v3/paths/list')).ok ? Date.now() : null, 20000, 100);
  const mediaBack = await waitFor(async () => (await mtxPath(PATH)).ready ? Date.now() : null, 60000, 250);
  const transient = x => x.overlay === OVERLAY.reconnecting || x.overlay === OVERLAY.waiting || x.kind === 'reconnecting' || x.kind === 'waiting';
  let firstTransient = null, recovered = null;
  for (const end = Date.now() + 90000; Date.now() < end;) {
    const tl = await timeline(p2, t0);
    firstTransient ??= tl.find(transient)?.t ?? null;
    const overlayNow = (await state(p2)).overlay;
    // After a transient state, or 20 s after the media came back without one (a silent recovery, judged by its stall).
    if ((firstTransient || (mediaBack && Date.now() - mediaBack > 20000)) && !overlayNow) {
      const r = await playing(p2, 1500);
      if (r.ok && !r.second.overlay) { recovered = { at: Date.now(), r }; break; }
    }
    await sleep(250);
  }
  const tl = await timeline(p2, t0);
  const overlays = [...new Set(tl.map(x => x.overlay).filter(Boolean))], terminal = overlays.filter(o => TERMINAL.includes(o));
  // hls.js may ride out a short outage on its buffer and retries; then no overlay is right, but a picture frozen for
  // seconds without one is not.
  const silentStallMs = await ev(p2, 'window.__e2e.stall.max').catch(() => null);
  const explained = !!firstTransient || (Number.isFinite(silentStallMs) && silentStallMs < 4000);
  check('7a reconnect: relay MediaMTX restart -> reconnecting/waiting (or a silent recovery under 4 s), then B plays again (never ended/error/busy)', apiBack && mediaBack && explained && recovered && !terminal.length
      && recovered.r.second.rt?.watch?.broadcastId === ID_B,
    { mediaBackAfterMs: mediaBack ? mediaBack - t0 : null, transientAfterMs: firstTransient ? firstTransient - t0 : null, silentStallMs, recoveredAfterMs: recovered ? recovered.at - t0 : null, overlays,
      kinds: [...new Set(tl.map(x => x.kind).filter(Boolean))], publisherRestarts: pubB.attempts - attempts0, sessionOpens: recovered?.r.second.rt?.session?.opens });

  const nick = await setNickname(p2, '웹 검증 시청자 B');
  const stamp = Date.now().toString(36), m1 = `재연결 전 메시지 1 ${stamp}`, m2 = `재연결 전 메시지 2 ${stamp}`;
  const s1 = await sendChat(p2, m1), s2 = await sendChat(p2, m2);
  const wsBefore = p2.ws.length, td = Date.now();
  const dropped = await control('POST', '/drop-websockets', { pathRegex: `^/${PATH}/chat$` });
  const down = await waitFor(async () => (await state(p2)).rt?.chat?.status !== 'connected' ? Date.now() : null, 8000, 50);
  const back = await waitFor(async () => { const s = await state(p2); return s.rt?.chat?.status === 'connected' && p2.ws.length > wsBefore ? Date.now() : null; }, 45000, 200);
  await sleep(1500);
  const dom = await ev(p2, `(() => { const li = [...document.querySelectorAll('[role="log"] li')]; const n = t => li.filter(x => x.textContent.includes(t)).length; return { count: li.length, m1: n(${JSON.stringify(m1)}), m2: n(${JSON.stringify(m2)}) }; })()`);
  const rt = (await state(p2)).rt?.chat;
  const server = await chatHistory(ID_B);
  const ids = p2.frames.filter(f => f.dir === 'in' && f.type === 'history' && f.t > td).at(-1)?.ids || [];
  const newSockets = p2.ws.length - wsBefore;
  check('7b chat: socket dropped -> reconnects and redraws the server history once (no duplicate ids)',
    nick.ok && s1.ok && s2.ok && dropped?.dropped > 0 && back && newSockets <= 3 && dom.m1 === 1 && dom.m2 === 1 && ids.length > 0 && new Set(ids).size === ids.length
      && dom.count === ids.length && rt?.messages === dom.count && server.ids.length === ids.length,
    { dropped: dropped?.dropped, wentDownAfterMs: down ? down - td : null, reconnectedAfterMs: back ? back - td : null, newSockets, dom, runtimeMessages: rt?.messages,
      historyIds: ids.length, uniqueIds: new Set(ids).size, serverHistory: server.ids.length, sent: [s1.ok, s2.ok] });
}

async function stepWaiting() {
  await front(p2);
  const t0 = Date.now();
  await pubB.stop();  // the announcer keeps announcing B
  const waitingAt = await waitFor(async () => (await state(p2)).overlay === OVERLAY.waiting ? Date.now() : null, 30000, 100);
  if (waitingAt) { await shot(p2, 'web-waiting'); await sleep(Math.max(0, waitingAt + 20000 - Date.now())); }
  const t1 = Date.now();
  const mid = await timeline(p2, waitingAt || t0);
  pubB = startPublisher('B');
  const back = await waitPlaying(p2, 60000);
  const backAt = Date.now();
  const win = waitingAt ? reqs(p2, waitingAt, t1) : [];
  const api = win.filter(e => e.path === `/${PATH}/info` || isSession(e.path)), infos = win.filter(e => e.path === `/${PATH}/info`);
  const gaps = infos.slice(1).map((e, i) => e.t - (infos[i].tr ?? infos[i].t));
  const media = win.filter(e => isMedia(e.path));
  const terminal = [...new Set(mid.map(x => x.overlay).filter(o => TERMINAL.includes(o)))];
  // Each /info answer of the wait carries Retry-After (2 s): the next check of the page is never sooner. Media requests
  // (503 + Retry-After while not ready) must not run on in a loop either.
  check('8 waiting: publisher away (still announced) -> waiting, Retry-After honoured, no request storm, plays again',
    waitingAt && back.ok && !terminal.length && maxPer(api.map(e => e.t)) <= 8 && honoured(retryGaps(infos)) && maxPer(media.map(e => e.t)) <= 8 && back.second?.rt?.watch?.broadcastId === ID_B,
    { waitingAfterMs: waitingAt ? waitingAt - t0 : null, windowS: waitingAt ? Math.round((t1 - waitingAt) / 1000) : 0, infoSessionPer10s: maxPer(api.map(e => e.t)), infoRequests: infos.length,
      minInfoGapMs: gaps.length ? Math.min(...gaps) : null, mediaPer10s: maxPer(media.map(e => e.t)), retryAfterSeen: [...new Set(win.map(e => e.retryAfter).filter(Boolean))],
      terminal, playsAgainAfterMs: backAt - t1, advancedS: back.advancedS });
}

async function stepCap() {
  await go(p1, '/_frame/live'); await go(p2, '/_frame/live');
  await stop(relay);
  relay = startRelay('relay-cap', { RELAY_MAX_VIEWERS_PER_PATH: '1' });
  const up = await waitFor(async () => (await healthz()).mediamtx, 20000, 200);
  const isListed = await waitFor(() => listed(ID_B), 20000, 250);
  const t0 = Date.now();
  await go(p1, `/_frame/watch/${PATH}/${ID_B}`);
  await front(p1);
  const play1 = await waitPlaying(p1, 40000);
  const h1 = await healthz();
  const t2 = Date.now();
  await go(p2, `/_frame/watch/${PATH}/${ID_B}`);
  await front(p2);
  const busyAt = await waitFor(async () => (await state(p2)).overlay === OVERLAY.busy ? Date.now() : null, 25000, 100);
  if (busyAt) await shot(p2, 'web-busy');
  await sleep(Math.max(0, t2 + 36000 - Date.now()));  // two Retry-After periods (15 s) of the relay's cap answer
  const s2 = await state(p2);
  const p1Still = await playing(p1, 2000);
  const posts = reqs(p2, t2).filter(e => e.method === 'POST' && isSession(e.path)), gaps = retryGaps(posts);
  const p2Media = reqs(p2, t2).filter(e => isMedia(e.path)), whep = (await proxyLog(t0)).filter(isWhepPost);
  check('9 cap: page 1 plays, page 2 busy; its session retries honour Retry-After; no media, no WHEP',
    up && isListed && play1.ok && h1.hlsSessions === 1 && busyAt && posts.length >= 1 && posts.length <= 4 && answered(posts).every(e => e.status === 503) && honoured(gaps)
      && !(s2.video?.w > 0) && p2Media.length === 0 && whep.length === 0 && p1Still.advancedS > 1,
    { page1: summary(play1.second), sessions: h1.hlsSessions, busyAfterMs: busyAt ? busyAt - t2 : null, sessionPosts: posts.map(e => `${e.status} ra=${e.retryAfter ?? '-'}`), gaps,
      page2Media: p2Media.length, whepPosts: whep.length, page2: summary(s2), message: s2.message, page1KeepsPlayingS: p1Still.advancedS });
}

async function stepForbidden() {
  await go(p2, '/_frame/live');
  const rule = await addFault({ method: 'POST', pathRegex: `^/${PATH}/b/[0-9a-f]{32}/session$`, status: 403 });
  const t0 = Date.now();
  await go(p2, `/_frame/watch/${PATH}/${ID_B}`);
  await front(p2);
  const shownAt = await waitFor(async () => { const s = await state(p2); return s.overlay === OVERLAY.error || s.overlay === OVERLAY.unavailable ? Date.now() : null; }, 20000, 100);
  await sleep(12000);
  const s = await state(p2);
  const mine = reqs(p2, t0), posts = mine.filter(e => e.method === 'POST' && isSession(e.path));
  const afterError = shownAt ? mine.filter(e => e.t > shownAt + 500 && underPath(e) && e.path !== `/${PATH}/chat`) : mine;
  const whep = (await proxyLog(t0)).filter(isWhepPost);
  await clearFaults();
  check('10 forbidden: 403 on the scoped session POST -> error overlay, one attempt, no retry storm, no WHEP, never plays',
    rule?.id && shownAt && posts.length === 1 && posts[0].status === 403 && maxPer(afterError.map(e => e.t)) <= 6 && whep.length === 0 && !(s.video?.w > 0) && mine.filter(e => isMedia(e.path)).length === 0,
    { overlay: s.overlay, kind: s.rt?.watch?.kind, message: s.message, shownAfterMs: shownAt ? shownAt - t0 : null, sessionPosts: posts.map(brief), requestsAfterErrorPer10s: maxPer(afterError.map(e => e.t)),
      afterError: afterError.slice(0, 6).map(brief), whepPosts: whep.length, media: mine.filter(e => isMedia(e.path)).length });
}

async function stepCleanup() {
  await go(p2, '/_frame/live');
  await front(p1);
  const playingNow = await waitPlaying(p1, 30000);  // page 1 still holds B's only viewer slot
  const before = await healthz();
  const open = p1.ws.filter(w => !w.closedAt && w.path === `/${PATH}/chat`);
  const t0 = Date.now();
  const left = await leaveToList(p1);
  const sessionGone = await waitFor(async () => (await healthz()).hlsSessions < before.hlsSessions ? Date.now() : null, 10000, 200);
  const wsClosed = await waitFor(() => (open.length && open.every(w => w.closedAt) ? Date.now() : null), 8000, 100);
  await sleep(Math.max(0, t0 + 10000 - Date.now()));
  const h2 = await healthz();
  const late = reqs(p1, t0 + 1500).filter(underPath), deletes = reqs(p1, t0).filter(e => e.method === 'DELETE' && isSession(e.path));
  const videoGone = await ev(p1, `!document.querySelector('[data-testid="watch-video"]')`);
  check('11 cleanup: leaving the watch page closes the session (DELETE), the chat socket and every media request',
    playingNow.ok && left && sessionGone && wsClosed && late.length === 0 && videoGone && h2.chatClients < before.chatClients && deletes.some(e => e.status === 204),
    { sessions: [before.hlsSessions, h2.hlsSessions], sessionGoneAfterMs: sessionGone ? sessionGone - t0 : null, deletes: deletes.map(e => e.status), chatSocketClosedAfterMs: wsClosed ? wsClosed - t0 : null,
      chatClients: [before.chatClients, h2.chatClients], requestsAfterLeaving: late.slice(0, 5).map(brief), videoGone });
}

async function stepWhep() {
  const tStart = Date.now();
  const earlier = (await proxyLog(0)).filter(e => e.t < tStart && isWhepPost(e));
  check('all: no WHEP POST from the HLS-capable pages (checks 1-11)', earlier.length === 0, { whepPosts: earlier.slice(0, 5).map(brief) });
  // The cap (1) must be free: the session gone and page 1's last media requests out of the relay's 12 s window.
  const free = await waitFor(async () => { const h = await healthz(); return h.hlsSessions === 0 && h.hlsViewers === 0 ? h : null; }, 40000, 500);
  p3 = await openTab('p3', { init: [NO_HLS] });
  const t0 = Date.now();
  await go(p3, `/_frame/watch/${PATH}/${ID_B}`);
  await front(p3);
  const env = await ev(p3, `({ mediaSource: typeof window.MediaSource, managed: typeof window.ManagedMediaSource, nativeHls: document.createElement('video').canPlayType('application/vnd.apple.mpegurl') })`);
  const play = await waitPlaying(p3, 45000);
  const s = play.second || await state(p3);
  const mine = reqs(p3, t0), offer = mine.find(isWhepPost), infos = mine.filter(e => e.path === `/${PATH}/info`);
  const infoBefore = !!offer && infos.some(e => e.t < offer.t), infoAfter = !!offer && infos.some(e => e.t > (offer.tr ?? offer.t));
  const hlsUse = mine.filter(e => isMedia(e.path) || isSession(e.path));
  check('12a WHEP fallback: no MSE and no native HLS -> transport webrtc, B plays', !!free && env.mediaSource === 'undefined' && env.nativeHls === '' && play.ok && s.rt?.transport === 'webrtc'
      && s.video?.w > 0 && offer?.status === 201 && hlsUse.length === 0 && s.pcs >= 1 && s.rt?.watch?.broadcastId === ID_B,
    { env, ...summary(s), advancedS: play.advancedS, pcs: s.pcs, offer: offer && brief(offer), hlsRequests: hlsUse.slice(0, 5).map(brief), capFree: !!free });
  check('12b WHEP: /info (broadcast id) checked before and after the offer', infoBefore && infoAfter, { infoBefore, infoAfter, infoRequests: infos.length });
  await shot(p3, 'web-whep');

  const tl = Date.now();
  const left = await leaveToList(p3);
  const released = await waitFor(async () => (await webrtcReaders()) === 0 ? Date.now() : null, 20000, 500);
  // The DELETE is a keepalive fetch: its answer is read from the proxy's log (the page may not report it).
  const deleted = await waitFor(async () => (await proxyLog(tl)).filter(e => e.method === 'DELETE' && /\/whep\//.test(e.path) && e.status), 5000, 250) || [];
  check('12c WHEP: leaving the page deletes the WHEP session (MediaMTX reader released)', left && released && deleted.some(e => e.status >= 200 && e.status < 300),
    { releasedAfterMs: released ? released - tl : null, deletes: deleted.map(brief) });
  await sleep(3000);  // the relay's cached MediaMTX path list drops the reader too

  await go(p1, `/_frame/watch/${PATH}/${ID_B}`);
  await front(p1);
  const p1play = await waitPlaying(p1, 45000);  // HLS: takes the only viewer slot
  const t3 = Date.now();
  await go(p3, `/_frame/watch/${PATH}/${ID_B}`);
  await front(p3);
  const busyAt = await waitFor(async () => (await state(p3)).overlay === OVERLAY.busy ? Date.now() : null, 25000, 100);
  await sleep(Math.max(0, t3 + 36000 - Date.now()));
  const s3 = await state(p3);
  const offers = reqs(p3, t3).filter(isWhepPost), gaps = retryGaps(offers), fallback = reqs(p3, t3).filter(e => isMedia(e.path) || isSession(e.path));
  check('12d WHEP at the cap -> busy, never plays, Retry-After honoured, no HLS fallback', p1play.ok && busyAt && !(s3.video?.w > 0) && offers.length >= 1 && offers.length <= 4
      && answered(offers).every(e => e.status === 503) && honoured(gaps) && fallback.length === 0,
    { page1: summary(p1play.second), busyAfterMs: busyAt ? busyAt - t3 : null, offers: offers.map(e => `${e.status} ra=${e.retryAfter ?? '-'}`), gaps, fallback: fallback.length, page3: summary(s3), pcs: s3.pcs });
}

// ---- run ------------------------------------------------------------------------------------------------------------
async function step(name, fn) {
  if (STEPS && !STEPS.has(name.split(' ')[0])) return;
  const t0 = Date.now();
  console.log(`\n== ${name}`);
  try { await fn(); } catch (error) { check(`${name}: script error`, false, { error: String(error?.stack || error).split('\n').slice(0, 4).join(' | ') }); }
  result.steps.push({ name, s: Math.round((Date.now() - t0) / 1000) });
}

async function main() {
  for (const [what, file] of [['the production web build (cd apps/web && corepack yarn build)', join(DIST, 'index.html')], ['FFmpeg', FFMPEG], ['MediaMTX', MEDIAMTX], ['Microsoft Edge (FRAME_EDGE)', EDGE]])
    if (!existsSync(file)) throw new Error(`missing ${what}: ${file}`);
  if (BACKEND === 'spring') {
    if (!existsSync(API_JAR)) throw new Error('missing the Spring backend: cd apps/api && ./gradlew bootJar');
    if (!existsSync(JAVA)) throw new Error('no Java: set JAVA_HOME (or FRAME_JAVA) to a JDK 21');
    result.backend = { kind: 'spring', jar: 'apps/api/build/libs/frame-api.jar', jvmOptions: [process.env.JDK_JAVA_OPTIONS, '-Xms64m'].filter(Boolean).join(' '), steps: STEPS ? [...STEPS] : 'all' };
  }
  if (!OPENSSL) throw new Error('openssl of Git for Windows not found (test certificate)');
  const assets = readdirSync(join(DIST, 'assets'));
  if (!assets.filter(n => n.endsWith('.js')).some(n => readFileSync(join(DIST, 'assets', n), 'utf8').includes('FrameRuntime')))
    throw new Error('apps/web/dist has no relay adapter (window.FrameRuntime): build it with "corepack yarn build", not build:design');
  result.web.assets = assets;
  const busyPorts = [];
  for (const p of Object.values(PORT)) if (!(await portFree(p))) busyPorts.push(p);
  if (busyPorts.length) throw new Error('ports in use: ' + busyPorts.join(','));
  result.tools = {
    node: process.version, mediamtx: execFileSync(MEDIAMTX, ['--version']).toString().trim(), ffmpeg: execFileSync(FFMPEG, ['-version']).toString().split('\n')[0].trim(),
    edge: (() => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${EDGE}').VersionInfo.ProductVersion`]).toString().trim(); } catch { return 'unknown'; } })()
  };
  try { result.host.otherProcesses = execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process ffmpeg,mediamtx,msedge,FrameConsole -ErrorAction SilentlyContinue | Group-Object ProcessName | ForEach-Object { $_.Name + '=' + $_.Count }"]).toString().trim().split(/\s+/).filter(Boolean); } catch {}

  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', join(TMP, 'key.pem'), '-out', join(TMP, 'cert.pem')], { stdio: 'ignore' });
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=1', '-frames:v', '1', '-q:v', '5', '-y', join(TMP, 'thumb.jpg')]);
  THUMB = readFileSync(join(TMP, 'thumb.jpg'));

  // Relay MediaMTX: the deploy file as is; ports, password hashes and certificate from the environment.
  mtxDir = join(TMP, 'mediamtx'); mkdirSync(mtxDir, { recursive: true });
  copyFileSync(join(ROOT, 'deploy/mediamtx-relay.yml'), join(mtxDir, 'mediamtx.yml'));
  mtxEnv = {
    MTX_AUTHINTERNALUSERS_1_PASS: 'sha256:' + sha(PASS), MTX_AUTHINTERNALUSERS_2_PASS: 'sha256:' + sha(PASS_OTHER),
    MTX_RTSPADDRESS: `127.0.0.1:${PORT.rtsp}`, MTX_RTSPSADDRESS: `127.0.0.1:${PORT.rtsps}`, MTX_RTPADDRESS: `127.0.0.1:${PORT.rtp}`, MTX_RTCPADDRESS: `127.0.0.1:${PORT.rtcp}`,
    MTX_RTSPSERVERKEY: join(TMP, 'key.pem'), MTX_RTSPSERVERCERT: join(TMP, 'cert.pem'),
    MTX_WEBRTCADDRESS: `127.0.0.1:${PORT.webrtc}`, MTX_WEBRTCLOCALUDPADDRESS: `127.0.0.1:${PORT.ice}`, MTX_WEBRTCLOCALTCPADDRESS: `127.0.0.1:${PORT.ice}`, MTX_WEBRTCADDITIONALHOSTS: '127.0.0.1',
    MTX_HLSADDRESS: `127.0.0.1:${PORT.hls}`, MTX_APIADDRESS: `127.0.0.1:${PORT.api}`, MTX_PLAYBACKADDRESS: `127.0.0.1:${PORT.playback}`, MTX_METRICSADDRESS: `127.0.0.1:${PORT.metrics}`,
    PATH: BIN + ';' + process.env.PATH  // "ffmpeg" in runOnAvailable/runOnDemand resolves to the bundled build
  };
  mediamtx = startMediamtx('mediamtx');
  if (!check('setup: relay MediaMTX starts with deploy/mediamtx-relay.yml', await waitFor(async () => (await fetch(MTX_API + '/v3/paths/list')).ok, 15000), { log: mediamtx.lines.slice(0, 3) })) throw new Error('setup failed');
  relay = startRelay('relay');
  if (!check('setup: relay /healthz', await waitFor(async () => (await healthz()).mediamtx, 15000), { log: relay.lines.slice(0, 2).map(mask) })) throw new Error('setup failed');
  proxy = start('web-proxy', process.execPath, [join(ROOT, 'server/verify/web-proxy.mjs'), '--port', String(PORT.web), '--control', String(PORT.control), '--relay', RELAY, '--dist', DIST], { logDir: TMP });
  const proxyUp = await waitFor(async () => (await fetch(CONTROL + '/healthz')).ok, 10000);
  const page = await raw(WEB + '/_frame/watch/x/y', { headers: { Accept: 'text/html' } }), missing = await raw(`${WEB}/_frame/assets/missing-${Date.now()}.js`);
  const passed = await raw(WEB + '/healthz'), viaLocalhost = await getJson(WEB2 + '/api/broadcasts');
  if (!check('setup: web-proxy serves /_frame/ (SPA index for pages, 404 for a missing asset) and passes the rest to the relay',
    proxyUp && page.status === 200 && page.text.includes('id="root"') && page.cache === 'no-cache' && missing.status === 404 && passed.status === 200 && viaLocalhost.status === 200,
    { page: page.status, pageCache: page.cache, missingAsset: missing.status, relayHealthz: passed.status, secondOrigin: viaLocalhost.status })) throw new Error('setup failed');

  edge = start('edge', EDGE, ['--headless=new', `--remote-debugging-port=${PORT.edge}`, `--user-data-dir=${join(TMP, 'edge')}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', ...(AUDIBLE ? [] : ['--mute-audio']),
    // Background tabs keep their timers and media running (a second page waits or plays while another is in front).
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=msEdgeSidebarV2,EdgeCollections,BackgroundVideoTrackOptimization,BackgroundVideoPauseOptimization,IntensiveWakeUpThrottling',
    '--window-size=1920,1080', 'about:blank'], { logDir: TMP });
  if (!check('setup: headless Edge DevTools up', await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT.edge}/json/version`)).ok, 30000))) throw new Error('setup failed');
  if (!AUDIBLE) result.notes.push('Edge ran with --mute-audio (shared PC): audio is still decoded; webkitAudioDecodedByteCount is the measure');

  await step('1 list', stepList);
  await step('2 playback', stepPlayback);
  await step('2b scoped routes', stepScopedRoutes);
  await step('3 quality', stepQuality);
  await step('4 chat', stepChat);
  await step('5 DVR', stepDvr);
  await step('6 path reuse', stepPathReuse);
  await step('7 reconnect', stepReconnect);
  await step('8 waiting', stepWaiting);
  await step('9 cap', stepCap);
  await step('10 forbidden', stepForbidden);
  await step('11 cleanup', stepCleanup);
  await step('12 WHEP', stepWhep);
}

// Proxy request log, summed per kind and status (the full log of the media is too large to keep).
function summarise(log) {
  const kind = e => e.static ? 'web' : e.ws ? 'websocket' : isWhepPost(e) || /\/whep/.test(e.path) ? 'whep' : isSession(e.path) ? 'session' : /\/info$/.test(e.path) ? 'info'
    : isMedia(e.path) ? (e.path.includes('/b/') ? 'media-scoped' : 'media-legacy') : e.path.startsWith('/api/') ? 'api' : 'other';
  const out = { total: log.length, faults: log.filter(e => e.fault).length, upstreamErrors: log.filter(e => e.upstreamError).length, aborted: log.filter(e => e.aborted).length, byKind: {} };
  for (const e of log) { const k = kind(e), s = String(e.status); out.byKind[k] ??= {}; out.byKind[k][s] = (out.byKind[k][s] || 0) + 1; }
  return out;
}

let finishing = null;
function finish() {
  if (finishing) return finishing;
  finishing = (async () => {
    shuttingDown = true;
    for (const a of [...announcers]) clearInterval(a.timer);
    clearInterval(cpuTimer);
    for (const c of tabs) result.pages[c.name] = { origin: c.origin, requests: c.net.length, sockets: c.ws.slice(-20), console: c.console.slice(-30) };
    try {
      const log = await timeout(proxyLog(0), 20000, 'proxy log');
      result.proxy = summarise(log);
      // Everything but the successful media requests (API, sessions, WebSocket, faults, every non-200 answer).
      writeFileSync(join(OUT, 'logs', 'web-proxy-requests.json'), JSON.stringify(log.filter(e => !(isMedia(e.path) && e.status === 200 && !e.fault) && !e.static)));
    } catch (error) { result.notes.push('proxy log not read: ' + error.message); }
    for (const c of tabs) { try { c.close(); } catch {} }
    result.finishedAt = new Date().toISOString(); result.durationS = Math.round((Date.now() - t0) / 1000);
    result.host.cpuLoadPct = cpuSamples.length ? { samples: cpuSamples.length, min: Math.min(...cpuSamples), avg: Math.round(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length), max: Math.max(...cpuSamples) } : null;
    result.passed = list.filter(c => c.ok).length; result.failed = list.filter(c => !c.ok).length;
    const logs = [...procs.relay, ...procs.mediamtx, proxy].filter(Boolean).map(p => [p.name, p.lines]);
    for (const p of publishers) logs.push([`publisher-${p.which}-${p.index}`, p.lines.concat(p.proc?.running ? p.proc.lines : [])]);
    for (const [name, lines] of logs) { try { writeFileSync(join(OUT, 'logs', name + '.log'), scrub(mask(lines.join('\n')), ROOT)); } catch {} }
    // A failed evidence write must not keep the processes of this run alive (the browser is outside the started PID trees).
    try { writeFileSync(join(OUT, 'web-e2e-result.json'), scrub(mask(JSON.stringify(result, null, 2)), ROOT)); }
    catch (error) { result.failed += 1; console.log('FAIL evidence not written: ' + error.message); }
    console.log(`\n${result.passed} passed, ${result.failed} failed in ${result.durationS} s (host CPU ${JSON.stringify(result.host.cpuLoadPct)}) -> ${BACKEND === 'spring' ? 'verification/spring' : 'verification/web'}/web-e2e-result.json`);
    for (const c of list.filter(x => !x.ok)) console.log('  FAIL ' + c.name);
    await stopAll();
    const leftovers = killByCommandLine(TMP);
    if (leftovers.length) console.log('stopped leftover processes of this run:', leftovers.join(','));
    if (!KEEP) try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  })();
  return finishing;
}

const t0 = Date.now();
const watchdog = setTimeout(() => { check('run finished within 30 min', false, {}); finish().then(() => process.exit(1)); }, 30 * 60000);
watchdog.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (finishing) return;
  check('run completed', false, { interrupted: signal });
  finish().then(() => process.exit(130));
});
try { await main(); }
catch (error) { check('script error', false, { error: String(error?.stack || error).split('\n').slice(0, 4).join(' | ') }); }
finally {
  await finish();
  process.exit(result.failed ? 1 : 0);
}
