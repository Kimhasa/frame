// DVR position accuracy on a viewer that plays a capture of tools/motion-test.html (sender and viewer on the same PC,
// so both share one clock). For each seek target it waits for recorded playback, then compares the time on the
// timeline (history base + media time of each presented frame) with the render time drawn into that frame.
// The difference is the capture-to-recording delay plus the recording's time-mapping error; a seek that lands at the
// requested moment shows the same small difference at every target.
// usage: node tools/measure-dvr.mjs [viewerPort=9334] [targets: seconds from the first recorded moment, negative = before the live edge]
import { connect, sleep } from './cdp.mjs';

const [port = '9334', ...rest] = process.argv.slice(2);
const targets = rest.length ? rest.map(Number) : [3, 59, 61, 90, -15];
const c = await connect(Number(port), t => /:\d+\/[A-Za-z0-9_-]+|frame-console\.example/.test(t.url));
const out = (name, data) => console.log(name.padEnd(12), JSON.stringify(data));
const runtime = () => c.evaluate(`({ ...window.FrameRuntime.playback, src: window.FrameRuntime.video ? (window.FrameRuntime.video.srcObject ? 'webrtc' : 'mse') : null })`);
for (const target of targets) {
  const p = await runtime();
  if (!p.ranges || !p.ranges.length) { out('no index', p); break; }
  const first = p.ranges[0].startMs, edge = p.ranges.at(-1).endMs, at = target >= 0 ? first + target * 1000 : edge + target * 1000;
  const before = await c.evaluate(`window.FrameRuntime.playback.base`);
  await c.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${at}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const started = Date.now();
  for (let i = 0; i < 60; i++) { await sleep(250); const q = await runtime(); if (q.mode === 'history' && q.base !== before) break; }
  const switchMs = Date.now() - started;
  await sleep(1200);
  const r = await c.evaluate(`(async () => {
    const video = window.FrameRuntime.video, base = window.FrameRuntime.playback.base;
    if (!video || base === null) return { error: 'not in history' };
    const W = video.videoWidth, H = video.videoHeight, canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d', { willReadFrequently: true });
    const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    function runs(row) { const out = []; let start = 0, bright = luma(row, 0) > 128; for (let x = 1; x <= W; x++) { const b = x < W && luma(row, x * 4) > 128; if (x === W || b !== bright) { out.push({ bright, start, len: x - start }); start = x; bright = b; } } return out; }
    function locate(row) { const r = runs(row), i = r.findIndex(run => run.bright && run.len >= 6); if (i < 0 || r.length < i + 4) return null; const m = r.slice(i, i + 3); const w = (m[0].len + m[1].len + m[2].len) / 3; if (m.some(run => Math.abs(run.len - w) > w * 0.25) || r[i + 1].bright || !r[i + 2].bright || r[i + 3].bright) return null; return { x0: m[0].start, w }; }
    ctx.drawImage(video, 0, 0); const full = ctx.getImageData(0, 0, W, H).data, hits = [];
    for (let y = 0; y < H; y += 2) { const loc = locate(full.subarray(y * W * 4, (y + 1) * W * 4)); if (loc) hits.push({ y, ...loc }); }
    if (!hits.length) return { error: 'barcode not found' };
    const band = hits[Math.floor(hits.length / 2)];
    const decode = () => { ctx.drawImage(video, 0, band.y, W, 1, 0, 0, W, 1); const row = ctx.getImageData(0, 0, W, 1).data; let v = 0; for (let i = 4; i < 16; i++) { const x = Math.round(band.x0 + (i + 0.5) * band.w); v = (v << 1) | (luma(row, Math.min(W - 1, x) * 4) > 128 ? 1 : 0); } return v < 4000 ? v : -1; };
    const diffs = []; let frames = 0;
    const q0 = video.getVideoPlaybackQuality();
    await new Promise(resolve => { const end = performance.now() + 3000; const on = (now, meta) => { frames++; const stamp = decode(); if (stamp >= 0) diffs.push((((base + meta.mediaTime * 1000) % 4000) - stamp + 6000) % 4000 - 2000); if (performance.now() < end) video.requestVideoFrameCallback(on); else resolve(); }; video.requestVideoFrameCallback(on); setTimeout(resolve, 6000); });
    const q1 = video.getVideoPlaybackQuality();
    diffs.sort((a, b) => a - b);
    return { frames, decoded: diffs.length, diffMs: { p5: Math.round(diffs[Math.floor(diffs.length * 0.05)]), p50: Math.round(diffs[Math.floor(diffs.length / 2)]), p95: Math.round(diffs[Math.floor(diffs.length * 0.95)]) },
      fps: +(frames / 3).toFixed(1), droppedDuring: q1.droppedVideoFrames - q0.droppedVideoFrames, size: W + 'x' + H };
  })()`);
  out('target', { target, requestedFromStartS: +((at - first) / 1000).toFixed(2), switchMs, ...r });
}
c.close();
