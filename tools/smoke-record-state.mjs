// Recording-state checks: starts a broadcast (if needed), then reports the app's recording events, the DVR index and
// what a LAN viewer (Edge, DevTools 9334) shows: live playback and whether the rewind bar is offered.
// usage: node tools/smoke-record-state.mjs [watchSeconds=0]   (with watchSeconds, prints the index every 10 s)
import { app, selectWindow, snapshot, sleep } from './app-flow.mjs';
import { connect } from './cdp.mjs';

const watch = Number(process.argv[2] || 0);
const out = (name, data) => console.log(name.padEnd(14), JSON.stringify(data));
const a = await app();
if (!(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`))) {
  await a.evaluate(`document.getElementById('tab-sender').click()`);
  await selectWindow(a, 'FRAME 모션 테스트');
  await a.evaluate(`document.getElementById('start-button').click()`);
  for (let i = 0; i < 60 && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`)); i++) await sleep(250);
  await sleep(5000);
}
out('events', (await snapshot(a)).logs.filter(l => /녹화|송출/.test(l)).slice(0, 5));
const base = await a.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`);
const index = async () => { const j = await (await fetch(base + '/dvr', { cache: 'no-store' })).json(); return { dvr: j.dvr, recording: j.recording, ranges: (j.ranges || []).map(r => [new Date(r.startMs).toISOString().slice(11, 23), +((r.endMs - r.startMs) / 1000).toFixed(1)]) }; };
out('index', await index());
const v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Page.navigate', { url: base });
await sleep(2500);
await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
for (let i = 0; i < 40; i++) { await sleep(500); if (await v.evaluate(`(() => { const x = document.querySelector('#viewer-preview video'); return !!(x && x.videoWidth && x.currentTime > 0.3); })()`)) break; }
await sleep(3000);
const viewer = () => v.evaluate(`(() => { const x = document.querySelector('#viewer-preview video'); return { playing: !!(x && x.videoWidth && !x.paused), src: x ? (x.srcObject ? 'webrtc' : 'mse') : null, t: x ? +x.currentTime.toFixed(1) : 0,
  timelineShown: !document.getElementById('player-timeline').hidden, pos: document.getElementById('player-position').textContent, dur: document.getElementById('player-duration').textContent }; })()`);
out('viewer', await viewer());
for (let s = 10; s <= watch; s += 10) {
  await sleep(10000);
  out('t+' + s + 's', { index: await index(), viewer: await viewer(), events: (await snapshot(a)).logs.filter(l => l.includes('녹화')).slice(0, 2) });
}
a.close(); v.close();
