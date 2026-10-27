// States without a delivered reference screenshot (open select menu, inline error, broadcasting, narrow width):
// the running app and a fresh render of the approved prototype are captured in the same state and compared.
// usage: node tools/capture-extra-states.mjs wide|narrow
import { mkdir, writeFile } from 'node:fs/promises';
import { connect, sleep } from './cdp.mjs';
import { app, selectWindow, snapshot } from './app-flow.mjs';

const mode = process.argv[2] || 'wide';
const root = new URL('../', import.meta.url);
await mkdir(new URL('verification/app/', root), { recursive: true });
await mkdir(new URL('verification/reference-render/', root), { recursive: true });
const proto = await connect(9444, t => t.type === 'page' && !t.url.startsWith('edge://'));
const a = await app();
const size = await a.evaluate('({ w: Math.min(innerWidth, 1440), h: innerHeight })');
if (mode === 'narrow') size.w = 420;
await proto.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
await proto.send('Page.navigate', { url: new URL('reference/index.html', root).href }); await sleep(1500);
const shoot = async (c, dir, name, scaleFromDpr) => {
  // Narrow pages scroll: capture the full page so neither side shows a scrollbar (headless Edge hides them).
  const m = await c.evaluate('({ dpr: devicePixelRatio, h: document.documentElement.scrollHeight })');
  const full = mode === 'narrow';
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, clip: { x: 0, y: 0, width: size.w, height: full ? m.h : size.h, scale: scaleFromDpr ? 1 / m.dpr : 1 } });
  await writeFile(new URL(`verification/${dir}/${name}.png`, root), Buffer.from(r.data, 'base64'));
};
const both = async (name, step) => { await step(proto); await step(a); await sleep(400); await shoot(proto, 'reference-render', name, false); await shoot(a, 'app', name, true); };
const stop = async () => { if ((await snapshot(a)).status !== '송출 중') return; await a.evaluate('document.getElementById("start-button").click()'); await sleep(300); await a.evaluate('document.getElementById("confirm-stop").click()'); for (let i = 0; i < 20 && (await snapshot(a)).status === '종료 중'; i++) await sleep(300); };
await stop();

if (mode === 'narrow') {
  await both('x-narrow-start', async c => { await c.evaluate('document.getElementById("tab-sender").click()'); });
  await both('x-narrow-viewer', async c => { await c.evaluate('document.getElementById("tab-viewer").click()'); });
} else {
  // Source chosen in both (the prototype's test pattern, the app's motion-test window).
  await proto.evaluate('document.getElementById("source-empty-button").click()'); await sleep(200); await proto.evaluate('document.getElementById("confirm-source").click()');
  if (await a.evaluate('document.getElementById("source-row").hidden')) await selectWindow(a, 'FRAME 모션 테스트');
  await both('x-menu-open', async c => { await c.evaluate('document.activeElement.blur()'); await c.click('#fps-trigger'); await sleep(200); await c.key('ArrowDown'); });
  await both('x-error', async c => {
    await c.key('Escape');
    await c.evaluate(`(() => { const i = document.getElementById('server-host'); i.value = '192.168.1.999'; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); })()`);
  });
  await both('x-running', async c => {
    await c.evaluate(`(() => { const i = document.getElementById('server-host'); i.value = '192.168.1.27'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await c.evaluate(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; set('fps', '60'); set('audio-source', 'system'); })()`);
    await c.evaluate('document.getElementById("start-button").click()');
    for (let i = 0; i < 40 && (await c.evaluate('document.getElementById("sender-status").textContent')) !== '송출 중'; i++) await sleep(300);
    await sleep(3000);
  });
  await stop();
}
console.log('captured', mode, size);
proto.close(); a.close();
