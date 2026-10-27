// Captures the running FrameConsole.exe (DevTools 9222, client area 1440x1100 CSS px) in the reference states.
// Needs the motion-test window open. Output: verification/app/cmp-*.png (1440 px wide, downsampled from the device DPR).
import { mkdir, writeFile } from 'node:fs/promises';
import { sleep } from './cdp.mjs';
import { app, selectWindow, snapshot } from './app-flow.mjs';
import { fpsFocusState, senderState, viewerState } from './ui-states.mjs';

const root = new URL('../', import.meta.url);
await mkdir(new URL('verification/app/', root), { recursive: true });
const c = await app();
const save = async (name, full) => {
  const m = await c.evaluate('({ dpr: devicePixelRatio, h: document.documentElement.scrollHeight })');
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, clip: { x: 0, y: 0, width: 1440, height: full ? m.h : 1100, scale: 1 / m.dpr } });
  await writeFile(new URL(`verification/app/${name}.png`, root), Buffer.from(r.data, 'base64'));
};
const stop = async () => { if ((await snapshot(c)).status !== '송출 중') return; await c.evaluate('document.getElementById("start-button").click()'); await sleep(300); await c.evaluate('document.getElementById("confirm-stop").click()'); for (let i = 0; i < 20 && (await snapshot(c)).status === '종료 중'; i++) await sleep(300); };

// Fresh start state: reload the page (the native side keeps no source after the source is cleared).
await stop();
await c.send('Page.reload'); await sleep(2500);
const fresh = await c.evaluate('document.getElementById("source-row").hidden');
if (fresh) await save('cmp-start');
else console.log('a source is still selected; start state skipped (restart the app for it)');
await c.evaluate('document.getElementById("events-panel").open = false');
await senderState(c, () => selectWindow(c, 'FRAME 모션 테스트'));
await sleep(800);
await save('cmp-sender', true);
await fpsFocusState(c);
await save('cmp-fps-focus', true);
await viewerState(c, async () => {
  await c.evaluate('document.getElementById("start-button").click()');
  for (let i = 0; i < 40 && (await snapshot(c)).status !== '송출 중'; i++) await sleep(500);
  await sleep(1500);
  await c.evaluate('document.getElementById("open-viewer").click()');
  for (let i = 0; i < 40 && (await c.evaluate('document.getElementById("viewer-status").textContent')) !== '수신 중'; i++) await sleep(500);
  await sleep(2000);
});
const { x, y } = await c.center('#player-settings');
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
await sleep(1500);
await save('cmp-viewer');
console.log(JSON.stringify(await c.evaluate(`({ status: document.getElementById('viewer-status').textContent, quality: document.getElementById('player-quality-label').textContent,
  video: (() => { const v = document.querySelector('#viewer-preview video'); return v.videoWidth + 'x' + v.videoHeight; })(), info: ['info-resolution', 'info-fps', 'info-bitrate', 'info-audio'].map(id => document.getElementById(id).textContent),
  menu: [...document.querySelectorAll('#player-quality-options button')].map(b => b.textContent.trim() + (b.getAttribute('aria-checked') === 'true' ? '*' : '')) })`)));
c.close();
