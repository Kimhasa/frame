// Functional scenarios against the running app (9222), the LAN viewer page (9334) and the motion-test window (9333).
// Prints one JSON line per scenario with what the UI and the logs actually showed.
import net from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { connect, sleep } from './cdp.mjs';
import { app, selectWindow, snapshot } from './app-flow.mjs';

const c = await app();
const report = (name, data) => console.log(JSON.stringify({ scenario: name, ...data }));
const set = (id, value) => c.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const errors = () => c.evaluate(`Object.fromEntries(['host-error', 'stream-error', 'port-error', 'fps-error'].map(id => [id, document.getElementById(id).hidden ? '' : document.getElementById(id).textContent]))`);
const waitState = async (not = '준비 중', tries = 40) => { let s; for (let i = 0; i < tries; i++) { await sleep(500); s = await snapshot(c); if (s.status !== not) break; } return s; };
const stopStream = async () => { if ((await snapshot(c)).status !== '송출 중') return; await c.evaluate('document.getElementById("start-button").click()'); await sleep(300); await c.evaluate('document.getElementById("confirm-stop").click()'); await waitState('종료 중'); };
const lastCsv = async () => { const dir = new URL('../dist/FrameConsole/data/logs/', import.meta.url); const name = (await readdir(dir)).filter(n => n.startsWith('stats-')).sort().pop(); const rows = (await readFile(new URL(name, dir), 'utf8')).trim().split('\n'); const head = rows[0].split(','); return rows.slice(1).map(r => Object.fromEntries(r.split(',').map((v, i) => [head[i], v]))); };
const original = { host: await c.evaluate('document.getElementById("server-host").value') };

await stopStream();
if (await c.evaluate('document.getElementById("source-row").hidden')) await selectWindow(c, 'FRAME 모션 테스트');
await set('resolution', '1920x1080'); await set('fps', '60'); await set('audio-source', 'system');

// 1. Address that does not belong to this PC.
await set('server-host', '10.254.254.254');
await c.evaluate('document.getElementById("start-button").click()');
let s = await waitState();
report('wrong-ip', { status: s.status, errors: await errors(), toast: s.toast });
await set('server-host', original.host);

// 2. Busy ports: a local listener on the publish port, then on the viewer port.
for (const [field, port, bindHost] of [['publish-port', 18554, '127.0.0.1'], ['viewer-port', 18889, '0.0.0.0']]) {
  const server = net.createServer().listen(port, bindHost); await new Promise(r => server.once('listening', r));
  await set('publish-port', field === 'publish-port' ? port : 8554); await set('viewer-port', field === 'viewer-port' ? port : 8889);
  await c.evaluate('document.getElementById("start-button").click()');
  s = await waitState();
  report('busy-' + field, { status: s.status, errors: await errors(), toast: s.toast, advancedOpen: await c.evaluate('document.getElementById("advanced-settings").open') });
  server.close();
}
await set('publish-port', 8554); await set('viewer-port', 8889);

// 3. Normal start, live volume changes, viewer-local mute.
await c.evaluate('document.getElementById("start-button").click()');
s = await waitState();
report('start', { status: s.status, applied: s.logs.find(l => l.includes('적용:')) });
const v = await connect(9334, t => t.url.startsWith('http://192.168.1.27'));
if (await v.evaluate('document.getElementById("connect-button").textContent') === '연결 해제') { await v.evaluate('document.getElementById("connect-button").click()'); await sleep(800); }
await v.evaluate('document.getElementById("connect-button").click()'); await sleep(5000);
await c.evaluate('document.getElementById("open-viewer").click()'); await sleep(5000);
s = await snapshot(c);
report('two-viewers', { viewersMetric: s.viewers, lanViewer: await v.evaluate('document.getElementById("viewer-status").textContent'), appViewer: await c.evaluate('document.getElementById("viewer-status").textContent') });
await c.evaluate('document.getElementById("tab-sender").click()');
const peak = async () => { await sleep(4000); const rows = (await lastCsv()).slice(-3); return Math.max(...rows.map(r => Number(r.audio_system_peak))); };
const before = await peak();
await set('system-volume', 0); await c.evaluate('document.getElementById("system-volume").dispatchEvent(new Event("input", { bubbles: true }))');
const muted = await peak();
await c.evaluate('document.getElementById("system-mute").click()');
const restored = await peak();
await v.evaluate('document.getElementById("player-mute").click()');
const viewerMuted = await peak();
report('live-volume', { systemPeakBefore: before, afterSliderToZero: muted, afterUnmuteButton: restored, whileViewerMutedLocally: viewerMuted, viewerVideoMuted: await v.evaluate('document.querySelector("#viewer-preview video").muted') });
await v.evaluate('document.getElementById("player-mute").click()');

// 4. Source window resized while streaming.
const e = await connect(9333);
const { windowId } = await e.send('Browser.getWindowForTarget');
await e.send('Browser.setWindowBounds', { windowId, bounds: { left: 60, top: 60, width: 900, height: 900 } }); await sleep(4000);
let rows = (await lastCsv()).slice(-3);
const resized = { status: (await snapshot(c)).status, captureFps: rows.map(r => Math.round(r.capture_fps)), sentFps: rows.map(r => Math.round(r.sent_fps)), lanVideo: await v.evaluate('(() => { const x = document.querySelector("#viewer-preview video"); return x.videoWidth + "x" + x.videoHeight + " t=" + x.currentTime.toFixed(1); })()') };
await e.send('Browser.setWindowBounds', { windowId, bounds: { left: 60, top: 60, width: 1280, height: 761 } }); await sleep(2000);
report('window-resize', resized);

// 5. Viewer keyboard shortcuts on the LAN page (focus on the player).
await v.evaluate('document.getElementById("viewer-preview").focus()');
const keyState = () => v.evaluate('({ paused: document.querySelector("#viewer-preview video").paused, overlay: !document.getElementById("pause-overlay").hidden, wide: document.getElementById("viewer-view").classList.contains("is-wide"), muted: document.querySelector("#viewer-preview video").muted })');
const keys = {};
await v.key('k', 'KeyK', 'k'); await sleep(300); keys.afterK = await keyState();
await v.key(' ', 'Space', ' '); await sleep(300); keys.afterSpace = await keyState();
await v.key('t', 'KeyT', 't'); await sleep(300); keys.afterT = await keyState();
await v.key('m', 'KeyM', 'm'); await sleep(300); keys.afterM = await keyState();
await v.key('m', 'KeyM', 'm'); await v.key('t', 'KeyT', 't'); await sleep(300);
await v.evaluate('document.getElementById("viewer-host").disabled = false; document.getElementById("viewer-host").focus()');
await v.key('k', 'KeyK', 'k'); await sleep(200); keys.typingInHostField = await keyState();
await v.evaluate('document.getElementById("viewer-host").disabled = true');
report('viewer-keys', keys);

// 6. Shared window closed while streaming, then reselect and start again.
await e.send('Page.close').catch(() => {});
await sleep(3000);
s = await snapshot(c);
const lan = { status: await v.evaluate('document.getElementById("viewer-status").textContent'), heading: await v.evaluate('document.getElementById("empty-heading").textContent') };
report('source-closed', { status: s.status, sourceRowHidden: await c.evaluate('document.getElementById("source-row").hidden'), toast: s.toast, logs: s.logs.slice(0, 4), lanViewerAfter: lan });
v.close(); e.close(); c.close();
