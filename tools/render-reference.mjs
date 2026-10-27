// Renders the approved prototype (reference/index.html) in headless Edge at 1440 px, DPR 1, in the reference states.
// Used to measure how close a fresh render of the approved UI is to the delivered JPEG screenshots (baseline noise).
import { mkdir, writeFile } from 'node:fs/promises';
import { connect, sleep } from './cdp.mjs';
import { fpsFocusState, senderState, viewerState } from './ui-states.mjs';

const root = new URL('../', import.meta.url);
await mkdir(new URL('verification/reference-render/', root), { recursive: true });
const c = await connect(9444, t => t.type === 'page' && !t.url.startsWith('edge://'));
await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
const save = async (name, full) => {
  const metrics = await c.evaluate('({ h: document.documentElement.scrollHeight })');
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, clip: { x: 0, y: 0, width: 1440, height: full ? metrics.h : 1100, scale: 1 } });
  await writeFile(new URL(`verification/reference-render/${name}.png`, root), Buffer.from(r.data, 'base64'));
};
const open = async () => { await c.send('Page.navigate', { url: new URL('reference/index.html', root).href }); await sleep(1200); await c.evaluate('document.fonts.ready.then(() => true)'); };

await open();
await save('start');
await senderState(c, async () => { await c.click('#source-empty-button'); await sleep(200); await c.click('#confirm-source'); await sleep(300); });
await save('sender', true);
await fpsFocusState(c);
await save('fps-focus', true);
await viewerState(c, async () => { await c.click('#start-button'); await sleep(800); await c.click('#open-viewer'); await sleep(600); });
await save('viewer');
console.log('reference renders written');
c.close();
