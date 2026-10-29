// HLS fallback on a viewer page in a new Edge window (DevTools 9334): WebRTC is removed from the page before it loads
// (as in a browser or network where it cannot be used), so the viewer must play the server's low-latency HLS with
// native HLS playback. Reports first frame time, decoded size, playback progress, live delay against the motion-test
// barcode (sender and viewer on this PC share the clock) and that the stream ending is noticed.
// usage: node tools/test-hls.mjs [viewer url]
import { connect, sleep } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://192.168.1.27:8889/screen-01';
const browser = new WebSocket((await (await fetch('http://127.0.0.1:9334/json/version')).json()).webSocketDebuggerUrl);
await new Promise(r => browser.onopen = r);
const id = await new Promise(resolve => { browser.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m.result.targetId); }; browser.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank', newWindow: true } })); });
browser.close();
await sleep(1500);
const c = await connect(9334, t => t.id === id);
await c.send('Page.enable');
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;' });
await c.send('Page.navigate', { url }); await sleep(2500);
const t0 = Date.now();
await c.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
let first = null;
for (let i = 0; i < 120; i++) { await sleep(250); if (await c.evaluate(`!!(window.FrameRuntime.video && window.FrameRuntime.video.videoWidth && window.FrameRuntime.video.currentTime > 0)`)) { first = Date.now() - t0; break; } }
const state = () => c.evaluate(`(() => { const v = window.FrameRuntime.video; return { connected: window.FrameRuntime.connected, src: v ? (v.srcObject ? 'webrtc' : (v.currentSrc || '').replace(/^.*\\/hls\\//, 'hls/')) : null,
  size: v ? v.videoWidth + 'x' + v.videoHeight : null, t: v ? +v.currentTime.toFixed(1) : null, paused: v ? v.paused : null, muted: v ? v.muted : null, timeline: !document.getElementById('player-timeline').hidden,
  qualities: (() => { document.getElementById('player-settings').click(); const q = [...document.querySelectorAll('#player-quality-options button')].map(b => b.innerText.split('\\n')[0]); document.getElementById('player-settings').click(); return q; })(),
  heading: document.getElementById('no-signal').hidden ? null : document.getElementById('empty-heading').textContent, rtc: typeof RTCPeerConnection }; })()`);
const s1 = await state();
await sleep(5000);
const s2 = await state();
const result = { at: new Date().toISOString(), url, firstFrameMs: first, start: s1, after5s: { t: s2.t, progressed: s2.t > s1.t } };
console.log(JSON.stringify(result));
// Live delay: render time drawn into the frame vs now (same PC clock).
const delay = await c.evaluate(`(async () => {
  const video = window.FrameRuntime.video, W = video.videoWidth, H = video.videoHeight, cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d', { willReadFrequently: true });
  const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  function runs(row) { const out = []; let start = 0, bright = luma(row, 0) > 128; for (let x = 1; x <= W; x++) { const b = x < W && luma(row, x * 4) > 128; if (x === W || b !== bright) { out.push({ bright, start, len: x - start }); start = x; bright = b; } } return out; }
  function locate(row) { const r = runs(row), i = r.findIndex(run => run.bright && run.len >= 6); if (i < 0 || r.length < i + 4) return null; const m = r.slice(i, i + 3); const w = (m[0].len + m[1].len + m[2].len) / 3; if (m.some(run => Math.abs(run.len - w) > w * 0.25) || r[i + 1].bright || !r[i + 2].bright || r[i + 3].bright) return null; return { x0: m[0].start, w }; }
  cx.drawImage(video, 0, 0); const full = cx.getImageData(0, 0, W, H).data, hits = [];
  for (let y = 0; y < H; y += 2) { const loc = locate(full.subarray(y * W * 4, (y + 1) * W * 4)); if (loc) hits.push({ y, ...loc }); }
  if (!hits.length) return null;
  const band = hits[Math.floor(hits.length / 2)], out = [];
  for (let k = 0; k < 20; k++) { await new Promise(r => setTimeout(r, 100)); cx.drawImage(video, 0, band.y, W, 1, 0, 0, W, 1); const row = cx.getImageData(0, 0, W, 1).data; let v = 0; for (let i = 4; i < 16; i++) { const x = Math.round(band.x0 + (i + 0.5) * band.w); v = (v << 1) | (luma(row, Math.min(W - 1, x) * 4) > 128 ? 1 : 0); } if (v < 4000) out.push(((Date.now() % 4000) - v + 4000) % 4000); }
  out.sort((a, b) => a - b); return out.length ? { p50: out[Math.floor(out.length / 2)], samples: out.length } : null; })()`);
console.log(JSON.stringify({ liveDelayMs: delay }));
// The barcode counts milliseconds modulo 4000, so a delay of 4 s or more wraps (4.05 s reads as 50 ms). The distance from
// the playback position to the newest media the player has (its live edge) is a lower bound that does not wrap.
const edgeGapS = await c.evaluate(`(() => { const v = window.FrameRuntime.video, r = v.seekable; return r && r.length ? +(r.end(r.length - 1) - v.currentTime).toFixed(2) : null; })()`);
result.liveDelayMs = delay;
result.edgeGapS = edgeGapS;
result.note = 'liveDelayMs is modulo 4000 ms (barcode period); when edgeGapS + segmenting delay exceeds 4 s, add 4000 ms';
console.log(JSON.stringify({ edgeGapS }));
mkdirSync(new URL('../verification/abr/', import.meta.url), { recursive: true });
writeFileSync(new URL('../verification/abr/hls-fallback.json', import.meta.url), JSON.stringify(result, null, 2));
c.close();
await fetch(`http://127.0.0.1:9334/json/close/${id}`, { method: 'PUT' });
