// Real-browser playback sampler: headless Edge (own profile and DevTools port) opens K viewer pages and measures what a
// protocol client cannot: first presented frame, presented FPS (requestVideoFrameCallback), freezes (gaps > 500 ms),
// decoded resolution, getStats decode/loss/jitter, and capture->display latency when the picture carries the barcode of
// tools/motion-test.html or tools/load/target.mjs (16 cells: 4 markers + 12 bits of epoch ms % 4000; same clock needed).
// usage: node tools/load/browser-sampler.mjs --url http://<host>:8889/screen-01 [--count 2] [--seconds 30] [--port 21222]
//        [--video "<css selector>"] [--window 1920,1080] [--latency true] [--headless true] [--out result.json] [--dir <profile dir>]
//        [--profiles desktop,mobile]  (pages take the profiles in turn; "mobile" = 390x844 CSS px, DPR 3, touch, Android
//        Chrome user agent through DevTools emulation: a mobile-LIKE page in desktop Edge, not a real phone or mobile network)
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '../cdp.mjs';
import { spawnSync } from 'node:child_process';
import { bin, parseArgs, run, killTree, killOnExit, sleep, percentile, mean, round, pidsByCommandLine } from './lib/common.mjs';

const a = parseArgs(process.argv.slice(2));
const o = { url: a.url, count: a.count ?? 2, seconds: a.seconds ?? 30, port: a.port ?? 21222, video: a.video || '', headless: a.headless ?? true,
  latency: a.latency ?? true, window: a.window || '1920,1080', out: a.out || '', dir: a.dir || join(tmpdir(), `frame-load-edge-${Date.now()}`), firstFrameTimeoutSec: a.firstFrameTimeout ?? 25,
  profiles: String(a.profiles || 'desktop').split(',').map(s => s.trim()).filter(Boolean) };
const PROFILES = {
  desktop: null,  // the browser window as started (--window)
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: 5,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
};
for (const p of o.profiles) if (!(p in PROFILES)) { console.error(`unknown profile ${p} (desktop, mobile)`); process.exit(2); }
if (!o.url) { console.error('--url is required'); process.exit(2); }
if (o.port < 21000 || o.port > 21999) console.error(`warning: DevTools port ${o.port} is outside the load tools' range 21000-21999`);

// Runs in every page before its own scripts: records RTCPeerConnections and measures presented frames of the main video.
const probe = `(() => {
  const pcs = window.__loadPcs = [];
  const Orig = window.RTCPeerConnection;
  if (Orig) {
    const Wrapped = function (...args) { const pc = new Orig(...args); pc.__loadId = pcs.length + 1; pc.__loadAt = performance.now(); pcs.push(pc); return pc; };
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
    // First decoded video frame of every connection (stats snapshot within 200 ms of it): a connection made inside the
    // measurement window is rated from here, so ICE/DTLS set-up and the wait for the first keyframe are not counted.
    setInterval(() => {
      for (const pc of pcs) {
        if (pc.__firstDecoded || pc.__polling || pc.connectionState === 'closed') continue;
        pc.__polling = true;
        pc.getStats().then(r => r.forEach(x => {
          if (!pc.__firstDecoded && x.type === 'inbound-rtp' && x.kind === 'video' && x.framesDecoded > 0) pc.__firstDecoded = { ts: x.timestamp, framesDecoded: x.framesDecoded, bytes: x.bytesReceived, framesDropped: x.framesDropped || 0, at: performance.now() };
        })).catch(() => {}).finally(() => { pc.__polling = false; });
      }
    }, 200);
  }
  const m = window.__loadMetrics = { firstFrameAt: null, frames: 0, last: null, gaps: [], width: 0, height: 0, lat: [], latBad: 0, decodeTried: 0, decodeHit: 0, video: null, windowStart: null, wFrames: 0, wFreezes: 0, wFreezeMs: 0, wMaxGap: 0 };
  const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  let canvas = null, ctx = null, band = null, misses = 0;
  function runs(row, W) { const out = []; let start = 0, bright = luma(row, 0) > 128; for (let x = 1; x <= W; x++) { const b = x < W && luma(row, x * 4) > 128; if (x === W || b !== bright) { out.push({ bright, start, len: x - start }); start = x; bright = b; } } return out; }
  function locate(video) {
    const W = video.videoWidth, H = video.videoHeight;
    canvas = new OffscreenCanvas(W, H); ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    const full = ctx.getImageData(0, 0, W, H).data, hits = [];
    for (let y = 0; y < H; y += 2) {
      const r = runs(full.subarray(y * W * 4, (y + 1) * W * 4), W), i = r.findIndex(run => run.bright && run.len >= 6);
      if (i < 0 || r.length < i + 4) continue;
      const w = (r[i].len + r[i + 1].len + r[i + 2].len) / 3;
      if ([r[i], r[i + 1], r[i + 2]].some(run => Math.abs(run.len - w) > w * 0.25) || r[i + 1].bright || !r[i + 2].bright || r[i + 3].bright) continue;
      hits.push({ y, x0: r[i].start, w });
    }
    band = hits.length ? hits[Math.floor(hits.length / 2)] : null;
  }
  function decode(video) {
    if (!band) return -1;
    const W = video.videoWidth;
    ctx.drawImage(video, 0, band.y, W, 1, 0, 0, W, 1);
    const row = ctx.getImageData(0, 0, W, 1).data;
    for (let i = 0; i < 4; i++) { const x = Math.round(band.x0 + (i + 0.5) * band.w); if ((luma(row, Math.min(W - 1, x) * 4) > 128) !== (i % 2 === 0)) return -1; }
    let v = 0;
    for (let i = 4; i < 16; i++) { const x = Math.round(band.x0 + (i + 0.5) * band.w); v = (v << 1) | (luma(row, Math.min(W - 1, x) * 4) > 128 ? 1 : 0); }
    return v < 4000 ? v : -1;
  }
  let current = null;
  function attach(video) {
    current = video;
    m.video = video.id || video.className || 'video';
    const onFrame = (now, meta) => {
      if (m.firstFrameAt === null) m.firstFrameAt = now;
      if (m.last !== null) {
        const gap = now - m.last;
        if (m.windowStart !== null && now >= m.windowStart) { m.wFrames++; if (gap > m.wMaxGap) m.wMaxGap = gap; if (gap > 500) { m.wFreezes++; m.wFreezeMs += gap; } }
      }
      m.last = now; m.frames++;
      m.width = meta.width; m.height = meta.height;
      // Barcode on every 6th frame (about 10 per second at 60 fps): enough samples without loading the page.
      if (window.__loadLatency && m.frames % 6 === 0 && m.windowStart !== null && now >= m.windowStart) {
        try {
          if (!band && m.decodeTried % 20 === 0) locate(video);
          m.decodeTried++;
          const stamp = decode(video);
          if (stamp >= 0) {
            m.decodeHit++; misses = 0;
            // Differences above 3 s are treated as misreads (the stamp wraps every 4 s; real latency here is far below 3 s).
            const shown = performance.timeOrigin + (meta.expectedDisplayTime || now), d = ((shown % 4000) - stamp + 4000) % 4000;
            if (d < 3000) m.lat.push(d); else m.latBad++;
          }
          else if (++misses > 30) { band = null; misses = 0; }
        } catch {}
      }
      if (video === current) video.requestVideoFrameCallback(onFrame);  // a replaced element stops counting
    };
    video.requestVideoFrameCallback(onFrame);
  }
  const pickVideo = () => {
    const sel = window.__loadVideoSelector;
    const list = sel ? [...document.querySelectorAll(sel)] : [...document.querySelectorAll('video')];
    return list.filter(v => v.readyState >= 2 && v.videoWidth).sort((x, y) => y.clientWidth * y.clientHeight - x.clientWidth * x.clientHeight)[0];
  };
  // The player may swap to another <video> element (e.g. on a quality change): follow the largest playing one.
  setInterval(() => { const v = pickVideo(); if (v && v !== current) { if (current) m.videoSwitches = (m.videoSwitches || 0) + 1; attach(v); if (v.paused) v.play().catch(() => {}); } }, current ? 500 : 50);
})();`;

const statsExpr = `(async () => {
  const out = [];
  for (const pc of window.__loadPcs || []) {
    if (pc.connectionState === 'closed') continue;
    const r = await pc.getStats(), s = { id: pc.__loadId, video: null, audio: null, pair: null, state: pc.connectionState, first: pc.__firstDecoded || null };
    r.forEach(x => {
      if (x.type === 'inbound-rtp' && x.kind === 'video') s.video = { framesDecoded: x.framesDecoded, framesDropped: x.framesDropped, framesReceived: x.framesReceived, packetsLost: x.packetsLost, packetsReceived: x.packetsReceived,
        jitter: x.jitter, fps: x.framesPerSecond, width: x.frameWidth, height: x.frameHeight, freezeCount: x.freezeCount, totalFreezesDuration: x.totalFreezesDuration,
        jbDelay: x.jitterBufferDelay, jbEmitted: x.jitterBufferEmittedCount, decoder: x.decoderImplementation, powerEfficient: x.powerEfficientDecoder, bytes: x.bytesReceived, nack: x.nackCount, pli: x.pliCount, keyFrames: x.keyFramesDecoded, ts: x.timestamp };
      if (x.type === 'inbound-rtp' && x.kind === 'audio') s.audio = { packetsLost: x.packetsLost, packetsReceived: x.packetsReceived, jitter: x.jitter, concealed: x.concealedSamples, samples: x.totalSamplesReceived, bytes: x.bytesReceived };
      if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') s.pair = { rtt: x.currentRoundTripTime, local: x.localCandidateId, remote: x.remoteCandidateId };
    });
    out.push(s);
  }
  return out;
})()`;

function delta(a, b, k) { return a && b && Number.isFinite(a[k]) && Number.isFinite(b[k]) ? b[k] - a[k] : null; }

async function samplePage(page, index, profile) {
  const t0 = Date.now();
  await page.send('Page.enable');
  const prof = PROFILES[profile];
  if (prof) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: prof.width, height: prof.height, deviceScaleFactor: prof.deviceScaleFactor, mobile: prof.mobile });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: prof.touch });
    await page.send('Emulation.setUserAgentOverride', { userAgent: prof.userAgent, platform: 'Linux armv8l' });
  }
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: (o.video ? `window.__loadVideoSelector = ${JSON.stringify(o.video)};` : '') + `window.__loadLatency = ${!!o.latency};` + probe });
  await page.send('Page.navigate', { url: o.url });
  let first = null;
  for (const end = Date.now() + o.firstFrameTimeoutSec * 1000; Date.now() < end; ) {
    await sleep(200);
    try { first = await page.evaluate('window.__loadMetrics && window.__loadMetrics.firstFrameAt'); } catch {}
    if (first !== null && first !== undefined) break;
  }
  if (first === null || first === undefined) {
    const why = await page.evaluate(`({ videos: document.querySelectorAll('video').length, pcs: (window.__loadPcs || []).map(p => p.connectionState), title: document.title, text: document.body ? document.body.innerText.slice(0, 200) : '' })`).catch(e => ({ error: e.message }));
    return { index, profile, error: 'no frame within ' + o.firstFrameTimeoutSec + ' s', detail: why, openMs: Date.now() - t0 };
  }
  // Measurement window starts 2 s after the first frame (start-up transients are reported by firstFrameMs).
  await sleep(2000);
  await page.evaluate('window.__loadMetrics.windowStart = performance.now()');
  const s0 = await page.evaluate(statsExpr), w0 = Date.now();
  await sleep(o.seconds * 1000);
  const s1 = await page.evaluate(statsExpr), w1 = Date.now();
  const m = await page.evaluate(`(() => { const m = window.__loadMetrics; return { firstFrameAt: m.firstFrameAt, frames: m.wFrames, freezes: m.wFreezes, freezeMs: m.wFreezeMs, maxGap: m.wMaxGap, width: m.width, height: m.height, lat: m.lat, latBad: m.latBad, tried: m.decodeTried, hit: m.decodeHit, video: m.video, dpr: devicePixelRatio, viewport: innerWidth + 'x' + innerHeight, ua: navigator.userAgent, videoSwitches: m.videoSwitches || 0, windowStart: m.windowStart, nowMs: performance.now(), pcs: (window.__loadPcs || []).map(p => ({ id: p.__loadId, createdMs: Math.round(p.__loadAt), firstDecodedMs: p.__firstDecoded ? Math.round(p.__firstDecoded.at) : null, state: p.connectionState })) }; })()`);
  // The page may hold more than one peer connection (retries, the viewer's quality switch): use the one that received the
  // most video, and take deltas only against the same connection (matched by id) so a new connection never gives negatives.
  const main = list => list.reduce((best, x, i) => ((x.video?.bytes || 0) > (list[best]?.video?.bytes || 0) ? i : best), 0);
  const k = main(s1), cur = s1[k], same = s0.find(x => x.id === cur?.id && x.video);
  const zero = { framesDecoded: 0, framesDropped: 0, packetsLost: 0, packetsReceived: 0, jbDelay: 0, jbEmitted: 0, bytes: 0, nack: 0, pli: 0, freezeCount: 0, totalFreezesDuration: 0, samples: 0, concealed: 0 };
  // Loss-type counters of a connection made inside the window count from zero (its whole life is inside the window).
  const v1 = cur?.video, a1 = cur?.audio, v0 = same ? same.video : v1 && zero, a0 = same ? same.audio : a1 && zero;
  // Rate-type numbers (decoded FPS, video kbit/s) use the stats timestamps: across the window for a connection that was
  // already decoding at the window start, otherwise from that connection's first decoded frame (not from its creation).
  const rateBase = same ? same.video : cur?.first ? { framesDecoded: cur.first.framesDecoded, bytes: cur.first.bytes, framesDropped: cur.first.framesDropped, ts: cur.first.ts } : null;
  const span = rateBase && v1 && Number.isFinite(rateBase.ts) && Number.isFinite(v1.ts) ? (v1.ts - rateBase.ts) / 1000 : null;
  const rate = k2 => (span !== null && span >= 1 ? delta(rateBase, v1, k2) / span : null);
  const secs = (w1 - w0) / 1000;
  const switched = !same && s1.length > 0;
  const lost = delta(v0, v1, 'packetsLost'), recv = delta(v0, v1, 'packetsReceived');
  const jb = delta(v0, v1, 'jbDelay'), jbn = delta(v0, v1, 'jbEmitted');
  return {
    index, profile, viewport: m.viewport, dpr: m.dpr, firstFrameMs: round(m.firstFrameAt, 0), windowSec: round(secs, 1), presentedFps: round(m.frames / secs, 1), freezes: m.freezes, freezeMs: round(m.freezeMs, 0), maxGapMs: round(m.maxGap, 0),
    decodedWidth: m.width, decodedHeight: m.height, decodedFps: round(rate('framesDecoded'), 1), decodedFpsSpanSec: round(span, 1),
    decodedFpsBasis: same ? 'window (stats timestamps)' : rateBase ? 'connection created inside the window: from its first decoded frame' : 'no decoded frame', framesDropped: delta(v0, v1, 'framesDropped'),
    statsFreezeCount: delta(v0, v1, 'freezeCount'), statsFreezeSec: round(delta(v0, v1, 'totalFreezesDuration'), 3), decoder: v1?.decoder ?? null, powerEfficientDecoder: v1?.powerEfficient ?? null,
    videoPacketsLost: lost, videoPacketsReceived: recv, videoLossRatio: lost !== null && recv ? round(lost / (lost + recv), 5) : null, videoJitterMs: v1 ? round(v1.jitter * 1000, 1) : null,
    jitterBufferMs: jb !== null && jbn ? round(jb / jbn * 1000, 1) : null, videoKbps: rate('bytes') === null ? null : round(rate('bytes') * 8 / 1000, 0), nack: delta(v0, v1, 'nack'), pli: delta(v0, v1, 'pli'),
    audio: a1 ? { packetsLost: delta(a0, a1, 'packetsLost'), jitterMs: round(a1.jitter * 1000, 1), concealedRatio: delta(a0, a1, 'samples') ? round(delta(a0, a1, 'concealed') / delta(a0, a1, 'samples'), 5) : null } : null,
    rttMs: s1[k]?.pair?.rtt !== undefined ? round(s1[k].pair.rtt * 1000, 1) : null, peerConnections: s1.length, connectionChangedInWindow: switched, videoElementSwitches: m.videoSwitches, peerConnectionLog: m.pcs, windowStartMs: round(m.windowStart, 0),
    latencyMs: !o.latency ? 'not measured (source has no live barcode)' : m.lat.length ? { n: m.lat.length, p50: percentile(m.lat, 0.5), p95: percentile(m.lat, 0.95), min: percentile(m.lat, 0), max: percentile(m.lat, 1), decodeHitRatio: round(m.hit / Math.max(1, m.tried), 3), rejected: m.latBad } : 'not measured (no barcode found in the picture)',
    avSync: 'not measured', video: m.video, userAgent: m.ua,
  };
}

killOnExit();
mkdirSync(o.dir, { recursive: true });
const edgeArgs = [`--remote-debugging-port=${o.port}`, `--user-data-dir=${o.dir}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--mute-audio', `--window-size=${o.window}`,  // the player size steers the viewer's automatic quality
  ...(o.headless ? ['--headless=new'] : []), 'about:blank'];
const edge = run(bin.edge, edgeArgs);
// Ends every process of this profile (Browser.close first; the launcher PID may already be gone, so leftovers are found by profile path).
async function closeEdge(version) {
  try {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(1500);
  } catch {}
  killTree(edge);
  for (const p of pidsByCommandLine(o.dir, 'msedge.exe')) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}
let version = null;
for (let i = 0; i < 50 && !version; i++) { await sleep(200); try { version = await (await fetch(`http://127.0.0.1:${o.port}/json/version`)).json(); } catch {} }
if (!version) { console.error('Edge DevTools did not start'); await closeEdge({}); process.exit(1); }
console.log(JSON.stringify({ event: 'edge', pid: (pidsByCommandLine(o.dir, 'msedge.exe').find(p => p.main) || { pid: edge.pid }).pid }));

// Each viewer gets its own window: a background tab is hidden, so it presents no frames (rVFC never fires) and would read
// as a failed viewer.
async function newWindow() {
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const reply = new Promise(res => { ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id === 1) res(m.result); }; });
  ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank', newWindow: true } }));
  const r = await reply;
  ws.close();
  return r.targetId;
}

const t0 = Date.now();
const pages = await Promise.all(Array.from({ length: o.count }, async (_, i) => {
  const id = await newWindow();
  const page = await connect(o.port, t => t.id === id);
  const profile = o.profiles[i % o.profiles.length];
  try { return await samplePage(page, i, profile); } catch (e) { return { index: i, profile, error: e.message }; } finally { page.close(); }
}));
const good = pages.filter(p => !p.error);
const lat = good.filter(p => typeof p.latencyMs === 'object');
const byProfile = Object.fromEntries(o.profiles.filter((p, i, a) => a.indexOf(p) === i).map(name => {
  const all = pages.filter(p => p.profile === name), ok = all.filter(p => !p.error);
  return [name, { pages: all.length, ok: ok.length, viewport: ok[0] ? `${ok[0].viewport}@${ok[0].dpr}x` : null, resolution: [...new Set(ok.map(p => `${p.decodedWidth}x${p.decodedHeight}`))],
    firstFrameMsP50: percentile(ok.map(p => p.firstFrameMs), 0.5), presentedFpsMean: round(mean(ok.map(p => p.presentedFps)), 1), decodedFpsMean: round(mean(ok.map(p => p.decodedFps)), 1),
    videoKbpsMean: round(mean(ok.map(p => p.videoKbps)), 0), freezes: ok.reduce((s, p) => s + p.freezes, 0) }];
}));
const result = {
  tool: 'browser-sampler', url: o.url, count: o.count, seconds: o.seconds, startedAt: new Date(t0).toISOString(), browser: version.Browser, headless: o.headless,
  definitions: { firstFrameMs: 'page navigation start -> first presented video frame (requestVideoFrameCallback), includes page load, WHEP/ICE and first keyframe',
    presentedFps: 'presented frames per second in the window (rVFC)', freeze: 'gap > 500 ms between presented frames', latencyMs: 'barcode stamp (source wall clock) -> expected display time; needs a shared clock',
    decodedFps: 'framesDecoded delta / stats-timestamp delta of the main connection: over the window, or from the first decoded frame when the connection was made inside the window (decodedFpsBasis)',
    profiles: 'desktop = the window as started; mobile = DevTools emulation (390x844, DPR 3, touch, Android UA) in desktop Edge: mobile-like layout and quality choice, not a phone decoder or mobile network' },
  pages,
  summary: { ok: good.length, failed: pages.length - good.length, firstFrameMs: { p50: percentile(good.map(p => p.firstFrameMs), 0.5), p95: percentile(good.map(p => p.firstFrameMs), 0.95) },
    presentedFps: { mean: round(mean(good.map(p => p.presentedFps)), 1), min: good.length ? Math.min(...good.map(p => p.presentedFps)) : null },
    decodedFps: { mean: round(mean(good.map(p => p.decodedFps)), 1) }, freezes: good.reduce((s, p) => s + p.freezes, 0), freezeMs: good.reduce((s, p) => s + p.freezeMs, 0),
    framesDropped: good.reduce((s, p) => s + (p.framesDropped || 0), 0), videoLossRatioMax: good.length ? Math.max(...good.map(p => p.videoLossRatio || 0)) : null,
    resolution: [...new Set(good.map(p => `${p.decodedWidth}x${p.decodedHeight}`))],
    connectionChanges: good.filter(p => p.connectionChangedInWindow).length,
    latencyMs: lat.length ? { p50: percentile(lat.flatMap(p => [p.latencyMs.p50]), 0.5), p95: Math.max(...lat.map(p => p.latencyMs.p95)) } : 'not measured', byProfile },
};
const text = JSON.stringify(result, null, 2);
if (o.out) writeFileSync(o.out, text); else console.log(text);
await closeEdge(version);
await sleep(500);
try { rmSync(o.dir, { recursive: true, force: true }); } catch {}
process.exit(0);
