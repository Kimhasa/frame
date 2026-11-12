// HLS as the default browser path, on a viewer page in an Edge with DevTools (default port 9334; e.g. one headless Edge
// started with --headless=new --remote-debugging-port=9334). RTCPeerConnection is wrapped before the page loads to count
// WebRTC peers (a browser with HLS must create none). Checks and measures:
//   transport (hls.js), peers created, hls.js load, first frame after navigation, hls.js live latency and the live delay
//   against the motion-test barcode (sender and viewer on this PC share the clock), the quality menu (자동 -> 720p -> 자동
//   with the decoded height really changing), a DVR seek to the start of the broadcast (dvr.m3u8) and back to live.
// usage: node tools/test-hls.mjs [viewer url] [devtools port]
import { connect, sleep } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8889/screen-01', port = Number(process.argv[3] || 9334);
const c = await connect(port, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
const result = { at: new Date().toISOString(), url, checks: [] };
const check = (name, ok, data) => { result.checks.push({ name, ok: !!ok, ...(data === undefined ? {} : { data }) }); console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(34), data === undefined ? '' : JSON.stringify(data)); };
const until = async (expression, timeoutMs, stepMs = 200) => { const t0 = Date.now(); for (;;) { const v = await c.evaluate(expression); if (v) return { value: v, ms: Date.now() - t0 }; if (Date.now() - t0 > timeoutMs) return { value: null, ms: Date.now() - t0 }; await sleep(stepMs); } };
const hls = () => c.evaluate(`(() => { const r = window.FrameRuntime, v = r.video; return { ...r.hls, playback: { mode: r.playback.mode, positionMs: r.playback.positionMs }, decoded: v ? v.videoWidth + 'x' + v.videoHeight : null,
  t: v ? +v.currentTime.toFixed(2) : null, paused: v ? v.paused : null, videos: document.querySelectorAll('#viewer-preview video').length, peers: window.__framePeers || 0,
  label: document.getElementById('player-quality-label').textContent, status: document.getElementById('viewer-status')?.textContent || '' }; })()`);

await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const Original = window.RTCPeerConnection; window.__framePeers = 0;
  if (Original) { const Counted = function (...args) { window.__framePeers++; return new Original(...args); }; Counted.prototype = Original.prototype; Object.setPrototypeOf(Counted, Original); window.RTCPeerConnection = Counted; } })();` });
const navigatedAt = Date.now();
await c.send('Page.navigate', { url });
// The viewer page connects by itself when its address names a stream.
const first = await until(`!!(window.FrameRuntime && window.FrameRuntime.video && window.FrameRuntime.video.videoWidth && window.FrameRuntime.video.currentTime > 0)`, 30000, 100);
const firstMs = first.value ? Date.now() - navigatedAt : null;
const script = await c.evaluate(`(() => { const e = performance.getEntriesByType('resource').find(x => x.name.includes('hls-1.5.20.min.js')); return e ? { ms: Math.round(e.duration), bytes: e.transferSize || e.encodedBodySize, from: e.name.replace(location.origin, '') } : null; })()`);
const start = await hls();
check('first frame after navigation', firstMs !== null && firstMs < 10000, { firstFrameMs: firstMs });
check('transport is hls.js', start.transport === 'hls.js', { transport: start.transport, connection: start.connection });
check('no RTCPeerConnection created', start.peers === 0, { peers: start.peers });
check('hls.js loaded from the viewer server', !!script, script);
check('levels parsed from live.m3u8', start.levels.length >= 1, start.levels.map(l => l.height + 'p@' + Math.round(l.bitrate / 1000) + 'k'));
await sleep(8000);
// Live delay: hls.js latency (to the playlist's live edge) and the render time drawn into the frame against now.
const latency = [];
for (let i = 0; i < 5; i++) { latency.push((await hls()).latency); await sleep(1000); }
const barcode = await c.evaluate(`(async () => {
  const video = window.FrameRuntime.video, W = video.videoWidth, H = video.videoHeight, cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d', { willReadFrequently: true });
  const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  cx.drawImage(video, 0, 0); const full = cx.getImageData(0, 0, W, H).data, hits = [];
  // Threshold from the picture itself: canvas readback of MSE video can be darker than the source (white read as ~100).
  let top = 0; for (let i = 0; i < full.length; i += 4 * 7) top = Math.max(top, luma(full, i));
  const thr = Math.max(24, top / 2);
  function runs(row) { const out = []; let start = 0, bright = luma(row, 0) > thr; for (let x = 1; x <= W; x++) { const b = x < W && luma(row, x * 4) > thr; if (x === W || b !== bright) { out.push({ bright, start, len: x - start }); start = x; bright = b; } } return out; }
  function locate(row) { const r = runs(row), i = r.findIndex(run => run.bright && run.len >= 6); if (i < 0 || r.length < i + 4) return null; const m = r.slice(i, i + 3); const w = (m[0].len + m[1].len + m[2].len) / 3; if (m.some(run => Math.abs(run.len - w) > w * 0.25) || r[i + 1].bright || !r[i + 2].bright || r[i + 3].bright) return null; return { x0: m[0].start, w }; }
  for (let y = 0; y < H; y += 2) { const loc = locate(full.subarray(y * W * 4, (y + 1) * W * 4)); if (loc) hits.push({ y, ...loc }); }
  if (!hits.length) return null;
  const band = hits[Math.floor(hits.length / 2)], out = [];
  for (let k = 0; k < 20; k++) { await new Promise(r => setTimeout(r, 100)); cx.drawImage(video, 0, band.y, W, 1, 0, 0, W, 1); const row = cx.getImageData(0, 0, W, 1).data; let v = 0; for (let i = 4; i < 16; i++) { const x = Math.round(band.x0 + (i + 0.5) * band.w); v = (v << 1) | (luma(row, Math.min(W - 1, x) * 4) > thr ? 1 : 0); } if (v < 4000) out.push(((Date.now() % 4000) - v + 4000) % 4000); }
  out.sort((a, b) => a - b); return out.length ? { p50: out[Math.floor(out.length / 2)], samples: out.length } : null; })()`);
const live = await hls();
// The barcode counts milliseconds modulo 4000: hls.js's latency tells how many whole 4 s periods to add.
const latencyS = latency.filter(Number.isFinite);
const medianLatency = latencyS.length ? latencyS.sort((a, b) => a - b)[Math.floor(latencyS.length / 2)] : null;
const delayMs = barcode && medianLatency !== null ? barcode.p50 + 4000 * Math.max(0, Math.round((medianLatency * 1000 - barcode.p50) / 4000)) : barcode ? barcode.p50 : null;
check('hls.js live latency reported', latencyS.length > 0, { latencyS: latency, bufferAheadS: live.bufferAhead });
check('live delay (barcode, same clock)', delayMs !== null, { delayMs, barcodeModulo4000: barcode });
check('auto level playing', live.auto && !!live.level, { level: live.level, decoded: live.decoded, label: live.label, bandwidthEstimate: live.bandwidthEstimate, cap: live.cap });

// Quality menu: 자동 -> 720p (manual) -> 자동, judged by the decoded height, not by the request.
const menu = await c.evaluate(`(() => { document.getElementById('player-settings').click(); const items = [...document.querySelectorAll('#player-quality-options button')].map(b => ({ text: b.innerText.split('\\n')[0], checked: b.getAttribute('aria-checked') })); document.getElementById('player-settings').click(); return items; })()`);
check('quality menu lists 자동 and levels', menu.length >= 2 && menu[0].text === '자동', menu);
const pick = text => c.evaluate(`(() => { document.getElementById('player-settings').click(); const b = [...document.querySelectorAll('#player-quality-options button')].find(x => x.innerText.startsWith(${JSON.stringify(text)})); if (b) b.click(); else document.getElementById('player-settings').click(); return !!b; })()`);
const sourceHeight = Math.max(...start.levels.map(l => l.height));
if (menu.some(item => item.text === '720p') && sourceHeight > 720) {
  const before = await hls();
  await pick('720p');
  const to720 = await until(`window.FrameRuntime.video && window.FrameRuntime.video.videoHeight === 720`, 20000);
  const manual = await hls();
  check('manual 720p decodes 720 lines', !!to720.value, { ms: to720.ms, decoded: manual.decoded, label: manual.label, auto: manual.auto, level: manual.level, videos: manual.videos, from: before.decoded });
  await sleep(3000);
  await pick('자동');
  // hls.js climbs back by its own estimate; a flip just before may hold it lower for 15-30 s first (anti-oscillation).
  const back = await until(`window.FrameRuntime.video && window.FrameRuntime.video.videoHeight === ${sourceHeight}`, 75000);
  const auto = await hls();
  check('자동 returns to the source height', !!back.value, { ms: back.ms, decoded: auto.decoded, label: auto.label, auto: auto.auto, decisions: (await c.evaluate('window.FrameRuntime.abr.decisions')).map(d => d.from + '>' + d.to + ' ' + d.reason) });
} else check('quality menu has 720p below the source', false, { menu, sourceHeight });

// DVR: seek to the start of the broadcast (explicit user action through the timeline), then 실시간.
const timeline = await until(`(() => { const t = window.FrameRuntime.playback.ranges; return !document.getElementById('player-timeline').hidden && t && t.length ? t : null; })()`, 30000, 500);
if (timeline.value) {
  const ranges = timeline.value, startMs = ranges[0].startMs;
  await c.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${startMs}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const history = await until(`window.FrameRuntime.playback.mode === 'history' && window.FrameRuntime.video.currentTime >= 0 && window.FrameRuntime.video.readyState >= 2`, 20000, 100);
  await sleep(3000);
  const h1 = await hls();
  await sleep(2000);
  const h2 = await hls();
  check('DVR seek to the broadcast start', !!history.value && h1.playback.mode === 'history' && h1.transport === 'hls.js', { ms: history.ms, positionFromStartS: h1.playback.positionMs !== null ? +((h1.playback.positionMs - startMs) / 1000).toFixed(2) : null, decoded: h1.decoded, videos: h1.videos, peers: h1.peers });
  check('DVR playback progresses', h2.t > h1.t && h2.playback.positionMs > h1.playback.positionMs, { t: [h1.t, h2.t], positionMs: [h1.playback.positionMs, h2.playback.positionMs] });
  await c.evaluate(`document.getElementById('player-live').click()`);
  const back = await until(`window.FrameRuntime.playback.mode === 'live' && window.FrameRuntime.hls.mode === 'live' && window.FrameRuntime.video.readyState >= 2`, 20000, 100);
  await sleep(4000);
  const l2 = await hls();
  check('실시간 returns to live.m3u8', !!back.value && l2.transport === 'hls.js', { ms: back.ms, latencyS: l2.latency, decoded: l2.decoded, videos: l2.videos, liveButtonDisabled: await c.evaluate(`document.getElementById('player-live').disabled`), peers: l2.peers });
} else check('DVR timeline shown', false, 'no recorded range within 30 s (recording off?)');
result.log = await c.evaluate(`[...document.querySelectorAll('#log-list tr')].slice(0, 14).map(r => r.innerText.split('\\t').join(' | '))`);
result.final = await hls();
result.passed = result.checks.every(x => x.ok);
console.log(JSON.stringify({ passed: result.passed, log: result.log }, null, 1));
mkdirSync(new URL('../verification/abr/', import.meta.url), { recursive: true });
writeFileSync(new URL('../verification/abr/hls-default.json', import.meta.url), JSON.stringify(result, null, 2));
await c.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
c.close();
