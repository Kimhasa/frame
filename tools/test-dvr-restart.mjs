// Sender stop / quick restart while a LAN viewer (Edge, DevTools 9334) watches recorded history.
// 1) quick restart: the viewer moves to the new broadcast (new id) live, with chat and the rewind bar for the new id;
// 2) stop: the viewer shows that the broadcast ended (no frozen picture).
import { app, selectWindow, sleep } from './app-flow.mjs';
import { connect } from './cdp.mjs';

const out = (name, data) => console.log(name.padEnd(14), JSON.stringify(data));
const a = await app();
const running = () => a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`);
const start = async () => { await a.evaluate(`document.getElementById('tab-sender').click()`); if (await a.evaluate(`document.getElementById('source-row').hidden`)) await selectWindow(a, 'FRAME 모션 테스트');
  await a.evaluate(`document.getElementById('start-button').click()`); for (let i = 0; i < 60 && !(await running()); i++) await sleep(250); };
const stop = async () => { await a.evaluate(`document.getElementById('start-button').click()`); await sleep(300); await a.evaluate(`document.getElementById('confirm-stop').click()`); for (let i = 0; i < 40 && (await running()); i++) await sleep(250); };
if (!(await running())) { await start(); await sleep(25000); }
const base = await a.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`);
const v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Page.navigate', { url: base }); await sleep(2500);
await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
const view = () => v.evaluate(`(() => { const x = document.querySelector('#viewer-preview video'), p = window.FrameRuntime.playback;
  return { connected: window.FrameRuntime.connected, src: x ? (x.srcObject ? 'webrtc' : 'mse') : null, mode: p.mode, broadcastId: window.FrameRuntime.stream?.info.broadcastId?.slice(0, 8) || null,
    timeline: !document.getElementById('player-timeline').hidden, dur: document.getElementById('player-duration').textContent,
    heading: document.getElementById('no-signal').hidden ? null : document.getElementById('empty-heading').textContent, chat: document.getElementById('chat-empty').textContent, chatInput: !document.getElementById('chat-message').disabled }; })()`);
for (let i = 0; i < 30 && !(await view()).timeline; i++) await sleep(500);
const goPast = async () => { let r = null; for (let i = 0; i < 40 && !r; i++) { r = await v.evaluate(`window.FrameRuntime.playback.ranges?.[0]?.startMs ?? null`); if (!r) await sleep(500); } await v.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${r + 2000}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); for (let i = 0; i < 30 && (await view()).mode !== 'history'; i++) await sleep(300); };
await goPast();
out('in history', await view());
await stop(); await sleep(1500); await start();
out('restarted', { app: await a.evaluate(`[...document.querySelectorAll('#log-list tr')].slice(0, 1).map(r => r.innerText.split('\\t').join(' | '))[0]`) });
await sleep(15000);
out('viewer after', await view());
await sleep(10000);
await goPast();
out('new history', await view());
await stop();
await sleep(12000);
out('after stop', await view());
a.close(); v.close();
