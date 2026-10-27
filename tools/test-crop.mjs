// Window-capture crop checks with the running app (9222) and a LAN viewer (Edge 9334), using the tools/edge-window.ps1
// test windows: for each placement (DPI-unaware / per-monitor aware, normal / maximized / resized, monitor 1 / 2) the
// app's preview picture and the received video must start with the client-area colour bands on all four edges
// (no title bar, no border, nothing cut), and the logged window geometry shows how the crop was derived.
// usage: node tools/test-crop.mjs [scenario ...]   scenarios: unaware aware maximized resized monitor2 unaware-monitor2 edge-app monitor
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { app, selectWindow, snapshot, sleep } from './app-flow.mjs';
import { connect } from './cdp.mjs';

const root = new URL('../', import.meta.url);
const ctl = (title, ...args) => JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', new URL('tools/window-control.ps1', root).pathname.slice(1), '-Title', title, ...args], { encoding: 'utf8' }).trim().split('\n').pop());
const edges = (port, what, target) => JSON.parse(execFileSync(process.execPath, [new URL('tools/check-edges.mjs', root).pathname.slice(1), String(port), what, ...(target ? [target] : [])], { encoding: 'utf8' }).trim());
const logDir = new URL('dist/FrameConsole/data/logs/', root);
const geometry = () => { const name = readdirSync(logDir).filter(n => n.startsWith('frame-console-')).sort().pop(); const lines = readFileSync(new URL(name, logDir), 'utf8').split('\n').filter(l => l.includes('window geometry')); return lines.length ? lines.at(-1).replace(/^.*window geometry: /, '').trim() : null; };
const unaware = 'FRAME 가장자리 테스트 (DPI 비인식)', aware = 'FRAME 가장자리 테스트 (DPI 인식)';
const scenarios = {
  unaware: { title: unaware, setup: () => ctl(unaware, '-Action', 'move', '-X', '280', '-Y', '240') },
  aware: { title: aware, setup: () => ctl(aware, '-Action', 'move', '-X', '420', '-Y', '300') },
  maximized: { title: aware, setup: () => ctl(aware, '-Action', 'maximize') },
  resized: { title: aware, setup: () => { ctl(aware, '-Action', 'move', '-X', '420', '-Y', '300'); return ctl(aware, '-Action', 'size', '-Width', '1500', '-Height', '700'); } },
  monitor2: { title: aware, setup: () => { ctl(aware, '-Action', 'size', '-Width', '924', '-Height', '624'); return ctl(aware, '-Action', 'move', '-X', '4300', '-Y', '300'); } },
  'unaware-monitor2': { title: unaware, setup: () => ctl(unaware, '-Action', 'move', '-X', '4400', '-Y', '500') },
  square: { title: aware, setup: () => { ctl(aware, '-Action', 'move', '-X', '420', '-Y', '200'); return ctl(aware, '-Action', 'size', '-Width', '1000', '-Height', '1052'); } },
  portrait: { title: aware, setup: () => { ctl(aware, '-Action', 'move', '-X', '420', '-Y', '100'); return ctl(aware, '-Action', 'size', '-Width', '700', '-Height', '1500'); } },
  'edge-app': { title: 'FRAME 모션 테스트', setup: () => ctl('FRAME 모션 테스트', '-Action', 'restore') },
};
const run = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
const a = await app();
const running = () => a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`);
const stop = async () => { if (!(await running())) return; await a.evaluate(`document.getElementById('start-button').click()`); await sleep(300); await a.evaluate(`document.getElementById('confirm-stop').click()`); for (let i = 0; i < 40 && (await running()); i++) await sleep(250); };
const v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
for (const name of run) {
  const s = scenarios[name];
  await stop();
  const placed = s.setup();
  await a.evaluate(`document.getElementById('tab-sender').click()`);
  await selectWindow(a, s.title);
  await sleep(2500);
  const preview = edges(9222, 'preview');
  const geo = geometry(placed);
  await a.evaluate(`document.getElementById('start-button').click()`);
  for (let i = 0; i < 60 && !(await running()); i++) await sleep(250);
  const applied = (await snapshot(a)).logs.find(l => l.includes('적용:'));
  const base = await a.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`);
  await v.send('Page.navigate', { url: base }); await sleep(2500);
  await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
  for (let i = 0; i < 40 && !(await v.evaluate(`!!(window.FrameRuntime.video && window.FrameRuntime.video.currentTime > 0.5)`)); i++) await sleep(250);
  await sleep(1500);
  const viewer = edges(9334, 'viewer');
  const box = await v.evaluate(`(() => { const r = document.getElementById('viewer-preview').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
  if (process.env.SAVE) execFileSync(process.execPath, [new URL('tools/save-frames.mjs', root).pathname.slice(1), name, s.title]);
  console.log(JSON.stringify({ scenario: name, window: placed, geometry: geo, applied, preview, viewer, playerBox: box }));
}
await stop();
a.close(); v.close();
