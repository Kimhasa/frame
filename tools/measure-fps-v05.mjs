// One measured run for the 0.5 UI: sets resolution and FPS in the running app (9222), broadcasts the motion-test window,
// plays it in the LAN viewer (Edge 9334), runs tools/measure-viewer.mjs there and averages the sender's per-second CSV.
// usage: node tools/measure-fps-v05.mjs <resolution WxH> <fps> [seconds=20]
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { connect, sleep } from './cdp.mjs';
import { app, selectWindow, snapshot } from './app-flow.mjs';

const [resolution = '1920x1080', fps = '60', seconds = '20'] = process.argv.slice(2);
const c = await app();
const running = () => c.evaluate(`document.getElementById('start-button').innerText.includes('종료')`);
if (await running()) { await c.evaluate(`document.getElementById('start-button').click()`); await sleep(300); await c.evaluate(`document.getElementById('confirm-stop').click()`); for (let i = 0; i < 40 && (await running()); i++) await sleep(250); }
await c.evaluate(`document.getElementById('tab-sender').click()`);
if (await c.evaluate('document.getElementById("source-row").hidden')) await selectWindow(c, 'FRAME 모션 테스트');
await c.evaluate(`(() => {
  const set = (id, value) => { const el = document.getElementById(id); el.value = value; for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true })); };
  const presets = ['30', '60', '90', '120', '144', '165'];
  set('resolution', ${JSON.stringify(resolution)});
  if (presets.includes(${JSON.stringify(fps)})) set('fps', ${JSON.stringify(fps)}); else { set('fps', 'custom'); set('custom-fps', ${JSON.stringify(fps)}); }
})()`);
await c.evaluate(`document.getElementById('start-button').click()`);
for (let i = 0; i < 60 && !(await running()); i++) await sleep(250);
if (!(await running())) { console.log(JSON.stringify({ resolution, fps, error: (await snapshot(c)).logs.slice(0, 3) })); process.exit(1); }
await sleep(3000);
const base = await c.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`);
const v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Page.navigate', { url: base }); await sleep(2500);
await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
for (let i = 0; i < 40; i++) { await sleep(500); if (await v.evaluate('(() => { const x = window.FrameRuntime.video; return !!(x && x.videoWidth && x.currentTime > 1); })()')) break; }
v.close();
await sleep(3000);
const viewer = JSON.parse(execFileSync(process.execPath, [new URL('measure-viewer.mjs', import.meta.url).pathname.slice(1), '9334', seconds], { encoding: 'utf8', timeout: (Number(seconds) + 40) * 1000 }));
const logs = new URL('../dist/FrameConsole/data/logs/', import.meta.url);
const csvName = (await readdir(logs)).filter(n => n.startsWith('stats-')).sort().pop();
const rows = (await readFile(new URL(csvName, logs), 'utf8')).trim().split('\n');
const head = rows[0].split(','), data = rows.slice(1).map(r => Object.fromEntries(r.split(',').map((x, i) => [head[i], x]))).slice(-Number(seconds));
const avg = key => +(data.reduce((a, r) => a + Number(r[key] || 0), 0) / Math.max(1, data.length)).toFixed(1);
const sum = key => data.reduce((a, r) => a + Number(r[key] || 0), 0);
const sender = { captureFps: avg('capture_fps'), sentFps: avg('sent_fps'), newFrameFps: avg('new_frames_fps'), encoderFps: avg('encoder_fps'), skipped: sum('skipped'), serverMbps: avg('server_in_mbps') };
const applied = (await snapshot(c)).logs.find(l => l.includes('적용:'));
await c.evaluate(`document.getElementById('start-button').click()`); await sleep(300); await c.evaluate(`document.getElementById('confirm-stop').click()`);
for (let i = 0; i < 40 && (await running()); i++) await sleep(250);
console.log(JSON.stringify({ resolution, fps: Number(fps), applied, sender, viewer: { presentedFps: viewer.presentedFps, uniqueFramesPerSecond: viewer.uniqueFramesPerSecond, latencyMs: viewer.latencyMs, dropped: viewer.dropped ?? viewer.droppedFrames } }));
c.close();
