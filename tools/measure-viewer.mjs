// Receive-side measurement on a viewer page that is playing a capture of tools/motion-test.html.
// usage: node tools/measure-viewer.mjs <devtools-port> <seconds> [label]
// Decodes the render-time barcode on every presented frame (requestVideoFrameCallback) and the beep onsets in the
// received audio. Sender and viewer must share a clock (same PC) for the latency and A/V numbers to be meaningful.
import { connect } from './cdp.mjs';

const [port = '9334', seconds = '20', label = ''] = process.argv.slice(2);
const c = await connect(Number(port), t => /:\d+\/[A-Za-z0-9_-]+|frame-console\.example/.test(t.url));
const result = await c.evaluate(`(async () => {
  const video = document.querySelector('#viewer-preview video');
  if (!video || !video.videoWidth) return { error: 'no playing video' };
  const W = video.videoWidth, H = video.videoHeight, canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  function runs(row) { const out = []; let start = 0, bright = luma(row, 0) > 128; for (let x = 1; x <= W; x++) { const b = x < W && luma(row, x * 4) > 128; if (x === W || b !== bright) { out.push({ bright, start, len: x - start }); start = x; bright = b; } } return out; }
  function locate(row) { const r = runs(row), i = r.findIndex(run => run.bright && run.len >= 6); if (i < 0 || r.length < i + 4) return null; const m = r.slice(i, i + 3); const w = (m[0].len + m[1].len + m[2].len) / 3; if (m.some(run => Math.abs(run.len - w) > w * 0.25) || r[i + 1].bright || !r[i + 2].bright || r[i + 3].bright) return null; return { x0: m[0].start, w }; }
  ctx.drawImage(video, 0, 0); const full = ctx.getImageData(0, 0, W, H).data;
  const hits = [];
  for (let y = 0; y < H; y += 2) { const loc = locate(full.subarray(y * W * 4, (y + 1) * W * 4)); if (loc) hits.push({ y, ...loc }); }
  if (!hits.length) return { error: 'barcode not found' };
  const band = hits[Math.floor(hits.length / 2)];
  function decode() {
    ctx.drawImage(video, 0, band.y, W, 1, 0, 0, W, 1); const row = ctx.getImageData(0, 0, W, 1).data;
    let v = 0; for (let i = 4; i < 16; i++) { const x = Math.round(band.x0 + (i + 0.5) * band.w); v = (v << 1) | (luma(row, Math.min(W - 1, x) * 4) > 128 ? 1 : 0); }
    return v < 4000 ? v : -1;
  }
  const samples = [], boundaries = [], onsets = [], perSecond = new Map(); let presented = 0, lastStamp = -1;
  const quality0 = video.getVideoPlaybackQuality();
  const end = performance.now() + ${Number(seconds) * 1000};
  // Audio: beep onsets in the received track (before output, so speaker latency is not included).
  let audioCtx = null, timer = 0;
  const audioTrack = video.srcObject && video.srcObject.getAudioTracks()[0];
  if (audioTrack) {
    audioCtx = new AudioContext(); await audioCtx.resume().catch(() => {});
    const analyser = audioCtx.createAnalyser(); analyser.fftSize = 256; audioCtx.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);
    const buf = new Float32Array(analyser.fftSize); let quietSince = performance.now(), loud = false;
    timer = setInterval(() => { analyser.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; const rms = Math.sqrt(s / buf.length), now = performance.now();
      if (rms > 0.05 && !loud && now - quietSince > 300) { loud = true; onsets.push(now - buf.length / audioCtx.sampleRate * 1000 / 2); } else if (rms < 0.01) { if (loud) quietSince = now; loud = false; } }, 2);
  }
  await new Promise(resolve => {
    function onFrame(now, meta) {
      presented++;
      const stamp = decode(), display = meta.expectedDisplayTime || now, epoch = performance.timeOrigin + display;
      if (stamp >= 0) {
        samples.push(((epoch % 4000) - stamp + 4000) % 4000);
        const sec = Math.floor(display / 1000); if (!perSecond.has(sec)) perSecond.set(sec, new Set()); perSecond.get(sec).add(stamp);
        if (lastStamp >= 0 && stamp % 1000 < lastStamp % 1000) boundaries.push(display - (stamp % 1000));
        lastStamp = stamp;
      }
      if (performance.now() < end) video.requestVideoFrameCallback(onFrame); else resolve();
    }
    video.requestVideoFrameCallback(onFrame);
    setTimeout(resolve, ${Number(seconds) * 1000} + 3000);  // no frames at all must not hang the run
  });
  clearInterval(timer); if (audioCtx) audioCtx.close();
  const quality1 = video.getVideoPlaybackQuality();
  const sorted = [...samples].sort((a, b) => a - b), pct = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
  const unique = [...perSecond.values()].slice(1, -1).map(s => s.size);
  const offsets = onsets.map(t => { let best = null; for (const b of boundaries) if (best === null || Math.abs(t - b) < Math.abs(t - best)) best = b; return best === null ? null : t - best; }).filter(v => v !== null && Math.abs(v) < 500);
  return { video: W + 'x' + H, seconds: ${Number(seconds)}, presentedFps: +(presented / ${Number(seconds)}).toFixed(1), uniqueFramesPerSecond: unique.length ? +(unique.reduce((a, b) => a + b, 0) / unique.length).toFixed(1) : null,
    decoded: samples.length, latencyMs: { p50: pct(0.5), p95: pct(0.95), min: sorted[0], max: sorted[sorted.length - 1] },
    droppedFrames: quality1.droppedVideoFrames - quality0.droppedVideoFrames, totalFrames: quality1.totalVideoFrames - quality0.totalVideoFrames,
    audio: audioTrack ? { onsets: onsets.length, avOffsetMs: offsets.length ? { median: [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)], min: Math.min(...offsets), max: Math.max(...offsets), n: offsets.length } : null } : 'no audio track' };
})()`);
console.log(JSON.stringify({ label, ...result }));
c.close();
