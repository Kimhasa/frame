// Live delay of the two browser transports on the same broadcast, same PC, same clock: the viewer page as a browser
// without any HLS sees it (MediaSource and HLS playback hidden before the page loads -> the page's own WebRTC fallback)
// and as a normal browser (hls.js LL-HLS). Each run: first frame after navigation, then 3 x 20 barcode samples of the
// motion-test window (tools/motion-test.html draws the render time, ms modulo 4000, as a barcode). Both run in the same
// headless Edge (DevTools port, default 9334), one after the other, against a running broadcast of the motion-test window.
// usage: node tools/compare-delay.mjs [viewer url] [devtools port] [out.json]
import { connect, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8889/screen-01', port = Number(process.argv[3] || 9334);
const outFile = process.argv[4] || new URL('../verification/abr/delay-webrtc-vs-hls.json', import.meta.url);
const HIDE_HLS = `(() => { for (const k of ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource']) try { Object.defineProperty(window, k, { value: undefined, configurable: true }); } catch {}
  const original = HTMLMediaElement.prototype.canPlayType; HTMLMediaElement.prototype.canPlayType = function (type) { return /mpegurl/i.test(String(type)) ? '' : original.call(this, type); }; })();`;
const BARCODE = `(async () => {
  const video = window.FrameRuntime.video, W = video.videoWidth, H = video.videoHeight, cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d', { willReadFrequently: true });
  const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  cx.drawImage(video, 0, 0); const full = cx.getImageData(0, 0, W, H).data, hits = [];
  let top = 0; for (let i = 0; i < full.length; i += 4 * 7) top = Math.max(top, luma(full, i));
  const thr = Math.max(24, top / 2);
  function runs(row) { const out = []; let start = 0, bright = luma(row, 0) > thr; for (let x = 1; x <= W; x++) { const b = x < W && luma(row, x * 4) > thr; if (x === W || b !== bright) { out.push({ bright, start, len: x - start }); start = x; bright = b; } } return out; }
  function locate(row) { const r = runs(row), i = r.findIndex(run => run.bright && run.len >= 6); if (i < 0 || r.length < i + 4) return null; const m = r.slice(i, i + 3); const w = (m[0].len + m[1].len + m[2].len) / 3; if (m.some(run => Math.abs(run.len - w) > w * 0.25) || r[i + 1].bright || !r[i + 2].bright || r[i + 3].bright) return null; return { x0: m[0].start, w }; }
  for (let y = 0; y < H; y += 2) { const loc = locate(full.subarray(y * W * 4, (y + 1) * W * 4)); if (loc) hits.push({ y, ...loc }); }
  if (!hits.length) return null;
  const band = hits[Math.floor(hits.length / 2)], out = [];
  for (let k = 0; k < 20; k++) { await new Promise(r => setTimeout(r, 100)); cx.drawImage(video, 0, band.y, W, 1, 0, 0, W, 1); const row = cx.getImageData(0, 0, W, 1).data; let v = 0; for (let i = 4; i < 16; i++) { const x = Math.round(band.x0 + (i + 0.5) * band.w); v = (v << 1) | (luma(row, Math.min(W - 1, x) * 4) > thr ? 1 : 0); } if (v < 4000) out.push(((Date.now() % 4000) - v + 4000) % 4000); }
  return out; })()`;

const c = await connect(port, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
const result = { at: new Date().toISOString(), url, runs: [] };
for (const mode of ['webrtc', 'hls']) {
  const added = mode === 'webrtc' ? await c.send('Page.addScriptToEvaluateOnNewDocument', { source: HIDE_HLS }) : null;
  await c.send('Page.navigate', { url: 'about:blank' }); await sleep(500);
  const t0 = Date.now();
  await c.send('Page.navigate', { url });
  let firstMs = null;
  for (; Date.now() - t0 < 30000; await sleep(100))
    if (await c.evaluate(`!!(window.FrameRuntime && window.FrameRuntime.video && window.FrameRuntime.video.videoWidth && window.FrameRuntime.video.currentTime > 0)`)) { firstMs = Date.now() - t0; break; }
  await sleep(8000);
  const info = await c.evaluate(`(() => { const r = window.FrameRuntime, v = r.video; return { transport: r.hls && r.hls.transport, latency: r.hls && r.hls.latency, decoded: v ? v.videoWidth + 'x' + v.videoHeight : null, peers: typeof RTCPeerConnection }; })()`);
  const samples = [];
  for (let round = 0; round < 3; round++) { samples.push(...((await c.evaluate(BARCODE)) || [])); await sleep(2000); }
  samples.sort((a, b) => a - b);
  // Modulo 4000 ms: hls.js's own latency tells how many whole 4 s periods to add (WebRTC stays well under 4 s).
  const p = q => samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] : null;
  const wrap = v => v === null ? null : v + (Number.isFinite(info.latency) ? 4000 * Math.max(0, Math.round((info.latency * 1000 - v) / 4000)) : 0);
  const run = { mode, transport: info.transport, decoded: info.decoded, firstFrameMs: firstMs, hlsLatencyS: info.latency ?? null, samples: samples.length, delayP50Ms: wrap(p(0.5)), delayP10Ms: wrap(p(0.1)), delayP90Ms: wrap(p(0.9)) };
  result.runs.push(run);
  console.log(JSON.stringify(run));
  if (added) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier });
}
writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log('saved', String(outFile));
process.exit(0);
