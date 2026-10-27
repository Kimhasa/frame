// Monitor (full-screen) source checks in the running app: list with real thumbnails, selection, preview, title.
import { writeFile } from 'node:fs/promises';
import { connect, sleep } from './cdp.mjs';

const a = await connect(9222, t => t.url.includes('frame-console.example'));
const out = (name, data) => console.log(name.padEnd(12), JSON.stringify(data));
if ((await a.evaluate(`document.getElementById('start-button').innerText`)).includes('종료')) {
  await a.evaluate(`document.getElementById('start-button').click()`); await sleep(300);
  await a.evaluate(`document.getElementById('confirm-stop').click()`); await sleep(3000);
}
await a.evaluate(`document.getElementById('tab-sender').click()`);
await a.evaluate(`(document.getElementById('source-row').hidden ? document.getElementById('source-empty-button') : document.getElementById('source-button')).click()`);
await sleep(800);
await a.evaluate(`document.getElementById('source-tab-monitor').click()`);
for (let i = 0; i < 40 && !(await a.evaluate(`document.querySelectorAll('.monitor-choice').length`)); i++) await sleep(250);
out('monitors', await a.evaluate(`[...document.querySelectorAll('.monitor-choice')].map(b => ({ text: b.innerText.split('\\n').join(' | '), thumbnail: !!b.querySelector('img') }))`));
const m = await a.evaluate(`({ dpr: devicePixelRatio })`);
await writeFile(new URL('../verification/app/v05-monitors.png', import.meta.url), Buffer.from((await a.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 1000, scale: 1 / m.dpr } })).data, 'base64'));
await a.evaluate(`document.querySelector('.monitor-choice').click()`);
await a.evaluate(`document.getElementById('confirm-source').click()`);
for (let i = 0; i < 40 && (await a.evaluate(`document.getElementById('source-dialog').open`)); i++) await sleep(250);
await sleep(1500);
out('selected', await a.evaluate(`({ dialogOpen: document.getElementById('source-dialog').open, source: document.getElementById('source-name').textContent,
  canvas: [document.getElementById('sender-canvas').width, document.getElementById('sender-canvas').height], start: !document.getElementById('start-button').disabled,
  log: [...document.querySelectorAll('#log-list tr')].slice(0, 2).map(r => r.innerText.split('\\t').join(' | ')) })`));
a.close();
