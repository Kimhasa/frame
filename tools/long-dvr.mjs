// Long DVR run (default 3 h 5 min) against the running app: one broadcast of the motion-test window, a LAN viewer
// (Edge, DevTools 9334) that stays live, and a checkpoint every 10 minutes: DVR index (recorded range, segments),
// recording size, sender fps/bitrate, CPU time and memory of FrameConsole/FFmpeg/MediaMTX, and the viewer's state.
// Every 30 minutes (and at the end) the viewer jumps to "10 minutes after the start" and to the first seconds, checks
// the moment shown against the render time drawn into the frame, then returns to live.
// Output: verification/long-dvr.jsonl (one line per checkpoint). usage: node tools/long-dvr.mjs [minutes=185]
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app, selectWindow, snapshot, sleep } from './app-flow.mjs';
import { connect } from './cdp.mjs';

const minutes = Number(process.argv[2] || 185);
const log = new URL('../verification/long-dvr.jsonl', import.meta.url);
const write = (kind, data) => { const line = JSON.stringify({ at: new Date().toISOString(), kind, ...data }); appendFileSync(log, line + '\n'); console.log(line.slice(0, 400)); };
const ps = command => execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
const procs = () => { const v = JSON.parse(ps(`@(Get-Process FrameConsole,ffmpeg,mediamtx -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\dist\\FrameConsole\\*' } | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; cpu = [math]::Round($_.CPU, 1); ws = [math]::Round($_.WorkingSet64 / 1MB); priv = [math]::Round($_.PrivateMemorySize64 / 1MB); handles = $_.HandleCount } }) | ConvertTo-Json -Compress`) || '[]'); return Array.isArray(v) ? v : [v]; };
const folderMB = dir => { let total = 0; for (const name of readdirSync(dir, { recursive: true })) { const p = join(dir, name); const st = statSync(p); if (st.isFile()) total += st.size; } return +(total / 1048576).toFixed(1); };

let a = await app();
if (!(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`))) {
  await a.evaluate(`document.getElementById('tab-sender').click()`);
  await selectWindow(a, 'FRAME 모션 테스트');
  await a.evaluate(`document.getElementById('start-button').click()`);
  for (let i = 0; i < 60 && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`)); i++) await sleep(250);
}
const base = await a.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`);
const info = await (await fetch(base + '/info')).json();
const recordDir = join(process.env.LOCALAPPDATA, 'FrameConsole', 'recordings', info.broadcastId);
write('start', { broadcastId: info.broadcastId, width: info.width, height: info.height, fps: info.fps, bitrateCap: info.bitrate });
let v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Page.navigate', { url: base }); await sleep(3000);
await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
await sleep(8000);

const viewer = () => v.evaluate(`(() => { const x = window.FrameRuntime.video, p = window.FrameRuntime.playback, q = x && x.getVideoPlaybackQuality ? x.getVideoPlaybackQuality() : null;
  return { connected: window.FrameRuntime.connected, src: x ? (x.srcObject ? 'webrtc' : 'mse') : null, mode: p.mode, size: x ? x.videoWidth + 'x' + x.videoHeight : null, playing: !!(x && !x.paused && x.readyState >= 2),
    frames: q ? q.totalVideoFrames : null, dropped: q ? q.droppedVideoFrames : null, timeline: !document.getElementById('player-timeline').hidden, dur: document.getElementById('player-duration').textContent,
    heading: document.getElementById('no-signal').hidden ? null : document.getElementById('empty-heading').textContent, heapMB: Math.round(performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0) }; })()`);
// Seek, wait for recorded playback, and compare the timeline moment with the render time in the frame (motion-test barcode).
async function checkSeek(label, targetMs) {
  const before = await v.evaluate(`window.FrameRuntime.playback.base`);
  const t0 = Date.now();
  await v.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${targetMs}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  for (let i = 0; i < 80; i++) { await sleep(250); const p = await v.evaluate(`window.FrameRuntime.playback`); if (p.mode === 'history' && p.base !== before) break; }
  const switchMs = Date.now() - t0;
  await sleep(1500);
  const r = await v.evaluate(`(async () => {
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
    const diffs = [];
    await new Promise(resolve => { const end = performance.now() + 2000; const on = (now, meta) => { const stamp = decode(); if (stamp >= 0) diffs.push((((base + meta.mediaTime * 1000) % 4000) - stamp + 6000) % 4000 - 2000); if (performance.now() < end) video.requestVideoFrameCallback(on); else resolve(); }; video.requestVideoFrameCallback(on); setTimeout(resolve, 5000); });
    diffs.sort((a, b) => a - b);
    return { decoded: diffs.length, timelineMinusFrameMs: diffs.length ? diffs[Math.floor(diffs.length / 2)] : null, position: Math.round(base + video.currentTime * 1000) };
  })()`);
  return { label, switchMs, ...r };
}

const end = Date.now() + minutes * 60000;
let n = 0, lastCpu = null, lastAt = Date.now();
while (true) {
  const now = Date.now();
  const final = now >= end;
  let index = null;
  try { index = await (await fetch(base + '/dvr', { cache: 'no-store', signal: AbortSignal.timeout(5000) })).json(); } catch (e) { index = { error: e.message }; }
  const ranges = index.ranges || [];
  const p = procs(), cpu = Object.fromEntries(p.map(x => [x.name, x.cpu]));
  const cpuPct = lastCpu ? Object.fromEntries(Object.entries(cpu).map(([k, c]) => [k, +(((c - (lastCpu[k] || 0)) / ((now - lastAt) / 1000)) * 100).toFixed(1)])) : null;
  lastCpu = cpu; lastAt = now;
  let sender = null;
  try { const s = await snapshot(a); sender = { status: s.status, duration: s.duration, fps: s.fps, bitrate: s.bitrate, viewers: s.viewers, recordEvents: s.logs.filter(l => l.includes('녹화') || l.includes('실패')).slice(0, 2) }; } catch (e) { sender = { error: e.message }; try { a = await app(); } catch {} }
  let view = null;
  try { view = await viewer(); } catch (e) { view = { error: e.message }; try { v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools')); } catch {} }
  const checkpoint = { n, elapsedMin: +((now - (end - minutes * 60000)) / 60000).toFixed(1), recording: index.recording, ranges: ranges.map(r => [new Date(r.startMs).toISOString().slice(11, 19), +((r.endMs - r.startMs) / 60000).toFixed(2) + ' min']),
    segments: (index.segments || []).length, edgeBehindMs: ranges.length ? Math.round(index.nowMs - ranges.at(-1).endMs) : null, recordMB: folderMB(recordDir), procs: p, cpuPctSinceLast: cpuPct, sender, viewer: view };
  if ((n % 3 === 0 || final) && ranges.length && view && view.connected) {
    const first = ranges[0].startMs, seeks = [];
    try {
      if (ranges.at(-1).endMs - first > 11 * 60000) seeks.push(await checkSeek('start+10min', first + 10 * 60000));
      seeks.push(await checkSeek('start+3s', first + 3000));
      seeks.push(await checkSeek('edge-30s', ranges.at(-1).endMs - 30000));
      await v.evaluate(`document.getElementById('player-live').click()`); await sleep(3000);
      seeks.push({ label: 'live', ...(await viewer()) });
    } catch (e) { seeks.push({ error: e.message }); }
    checkpoint.seeks = seeks;
  }
  write('checkpoint', checkpoint);
  if (final) break;
  n++;
  await sleep(Math.min(10 * 60000, Math.max(1000, end - Date.now())));
}
write('end', { note: 'broadcast left running; stop it from the app' });
a.close(); v.close();
