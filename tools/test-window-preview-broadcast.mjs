// Window thumbnails against a running broadcast (DevTools 9222). The UI locks 송출 대상 선택 while it broadcasts, so the
// picker never runs then; this checks the lock and, as a worst case, forces the list open three times through the test
// handle FrameRuntime.chooseSource() and compares the broadcast's frame rate and source bitrate with the same broadcast
// without it. Starts and stops its own short broadcast of the given window.
// usage: node tools/test-window-preview-broadcast.mjs ["FRAME 미리보기 시험 A"]
import { app, selectWindow, sleep } from './app-flow.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const title = process.argv[2] || 'FRAME 미리보기 시험 A';
const a = await app();
if (await a.evaluate('window.FrameRuntime.running')) throw new Error('already broadcasting');
await a.evaluate(`document.getElementById('tab-sender').click()`);
await selectWindow(a, title);
await a.evaluate(`document.getElementById('start-button').click()`);
for (let i = 0; i < 60 && !(await a.evaluate('window.FrameRuntime.running')); i++) await sleep(250);
await sleep(6000);
const base = await a.evaluate(`'http://127.0.0.1:' + document.getElementById('viewer-port').value`), path = await a.evaluate(`document.getElementById('stream-path').value`);
const stats = async () => (await fetch(base + '/api/stats', { cache: 'no-store' })).json();
const fps = () => a.evaluate(`parseFloat(document.getElementById('metric-fps').textContent) || 0`);
async function sample(seconds, during) {
  const values = [], s0 = await stats(), t0 = Date.now();
  const task = during ? during() : null;
  while (Date.now() - t0 < seconds * 1000) { values.push(await fps()); await sleep(500); }
  await task;
  const s1 = await stats();
  return { fpsMean: +(values.reduce((x, y) => x + y, 0) / values.length).toFixed(1), fpsMin: Math.min(...values), samples: values.length,
    sourceMbps: +((s1.paths[path].bytesReceived - s0.paths[path].bytesReceived) * 8 / ((s1.timeMs - s0.timeMs) / 1000) / 1e6).toFixed(2) };
}
const locked = await a.evaluate(`document.getElementById('source-button').disabled`);
const baseline = await sample(10);
const forced = await sample(10, async () => {
  for (let i = 0; i < 3; i++) {
    await a.evaluate('window.FrameRuntime.chooseSource()'); await sleep(1800);
    await a.evaluate(`document.querySelector('#source-dialog .dialog-footer [data-close]').click()`); await sleep(1200);
  }
});
const after = await sample(6);
// The large sender preview and the received video are checked apart from the thumbnail.
const preview = await a.evaluate(`(() => { const c = document.getElementById('sender-canvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let sum = 0, sum2 = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 97) { const l = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8; sum += l; sum2 += l * l; n++; }
  const mean = sum / n; return { size: c.width + 'x' + c.height, mean: +mean.toFixed(1), sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1) }; })()`);
await a.evaluate(`document.getElementById('open-viewer').click()`);
let received = null;
for (let i = 0; i < 40 && !received; i++) { await sleep(250); received = await a.evaluate(`(() => { const v = document.querySelector('#viewer-preview video'); return v && v.videoWidth && v.currentTime > 0.5 ? { size: v.videoWidth + 'x' + v.videoHeight, t: +v.currentTime.toFixed(1), frames: v.getVideoPlaybackQuality().totalVideoFrames } : null; })()`); }
await a.evaluate(`document.getElementById('tab-sender').click()`); await sleep(300);
await a.evaluate(`document.getElementById('start-button').click()`); await sleep(400);
await a.evaluate(`document.getElementById('confirm-stop')?.click()`);
for (let i = 0; i < 40 && (await a.evaluate('window.FrameRuntime.running')); i++) await sleep(250);
const out = { title, measuredAt: new Date().toISOString(), pickerLockedWhileBroadcasting: locked, baseline, forcedPickerThreeTimes: forced, after, senderPreview: preview, receivedVideo: received };
console.log(JSON.stringify(out, null, 1));
await mkdir(new URL('../verification/window-preview/', import.meta.url), { recursive: true });
await writeFile(new URL('../verification/window-preview/broadcast-impact.json', import.meta.url), JSON.stringify(out, null, 1));
a.close();
