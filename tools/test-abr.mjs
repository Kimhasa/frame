// Automatic playback quality in the real app: a LAN viewer (Edge, DevTools 9334) and the app's own viewer (9222).
// 1) the viewer's player is made small: automatic mode must move to a lower shared rendition (real decoded size changes)
//    while the app's viewer keeps the original (independent choices); 2) back to full size: it must come back up after
//    the calm period; 3) a manual choice must stay fixed through size changes; 4) server side: one encoder per quality.
// usage: node tools/test-abr.mjs
import { app, selectWindow, sleep } from './app-flow.mjs';
import { connect } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const results = [];
const out = (name, data) => { results.push({ step: name, ...(Array.isArray(data) || typeof data !== 'object' || !data ? { value: data } : data) }); console.log(name.padEnd(18), JSON.stringify(data)); };
const a = await app();
if (!(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`))) {
  await a.evaluate(`document.getElementById('tab-sender').click()`);
  await selectWindow(a, 'FRAME 모션 테스트');
  await a.evaluate(`document.getElementById('start-button').click()`);
  for (let i = 0; i < 60 && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`)); i++) await sleep(250);
  await sleep(2000);
}
const base = await a.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`);
const info = await (await fetch(base + '/info')).json();
out('renditions', info.renditions);
const v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1.75, mobile: false });
await v.send('Page.navigate', { url: base }); await sleep(2500);
await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
const st = c => c.evaluate(`(() => { const r = window.FrameRuntime.abr, x = window.FrameRuntime.video; return { mode: r.mode, playing: r.playing, decoded: x ? x.videoWidth + 'x' + x.videoHeight : null,
  label: document.getElementById('player-quality-label').textContent, holdUpMs: r.holdUpMs, decisions: r.decisions.map(d => d.from + '>' + d.to + ' ' + d.reason + ' ' + d.ms + 'ms') }; })()`);
for (let i = 0; i < 40 && !(await v.evaluate(`!!(window.FrameRuntime.video && window.FrameRuntime.video.currentTime > 0.5)`)); i++) await sleep(250);
await sleep(3000);
out('viewer start', await st(v));
// The app's own viewer watches the same broadcast at full size.
await a.evaluate(`document.getElementById('open-viewer').click()`);
for (let i = 0; i < 40 && !(await a.evaluate(`!!(window.FrameRuntime.video && window.FrameRuntime.video.currentTime > 0.5)`)); i++) await sleep(250);
// 1) Small player (e.g. a phone-sized window): the picture is shown much smaller than 1080 device pixels.
await v.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 420, deviceScaleFactor: 1, mobile: false });
let s;
for (let i = 0; i < 40; i++) { await sleep(1000); s = await st(v); if (s.playing && s.playing !== info.width + 'x' + info.height && s.decoded && !s.decoded.endsWith('x' + info.height)) break; }
out('small player', s);
out('app viewer', await st(a));
const paths = async () => { const r = await (await fetch(base.replace(/\/[^/]+$/, '') + '/api/broadcasts')).json(); return r.length; };
// 2) Back to full size: up again after the calm period (and the hold time).
await v.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1.75, mobile: false });
const t0 = Date.now();
for (let i = 0; i < 90; i++) { await sleep(1000); s = await st(v); if (s.playing === info.width + 'x' + info.height) break; }
out('full size again', { ...s, secondsToOriginal: Math.round((Date.now() - t0) / 1000) });
// 3) Manual 480p stays through a size change.
await v.evaluate(`(() => { document.getElementById('player-settings').click(); const b = [...document.querySelectorAll('#player-quality-options button')].find(x => x.innerText.startsWith('480p')); b && b.click(); })()`);
await sleep(6000);
await v.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1200, deviceScaleFactor: 2, mobile: false });
await sleep(20000);
out('manual 480p', await st(v));
await v.evaluate(`(() => { document.getElementById('player-settings').click(); const b = [...document.querySelectorAll('#player-quality-options button')].find(x => x.innerText.startsWith('자동')); b && b.click(); })()`);
await sleep(2000);
out('auto again', await st(v));
out('menu detail', await v.evaluate(`(() => { document.getElementById('player-settings').click(); const t = document.querySelector('#player-quality-options button small')?.textContent; document.getElementById('player-settings').click(); return t; })()`));
await v.send('Emulation.clearDeviceMetricsOverride');
mkdirSync(new URL('../verification/abr/', import.meta.url), { recursive: true });
writeFileSync(new URL('../verification/abr/size-abr.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), base, note: 'single PC LAN, size-driven only (no network shaping)', results }, null, 2));
a.close(); v.close();
