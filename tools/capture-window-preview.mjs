// Screenshots of the source dialog's program-window cards, FRAME test windows only: the user's own windows are never
// captured (their cards are hidden from the page before a whole-dialog shot and skipped for card shots).
//   cards (default): one PNG per test card under verification/window-preview/cards/<tag>-<n>-<state>.png
//   --dialog: the whole dialog with only the test cards, plus its geometry, under verification/window-preview/screens/<tag>.png/.json
// usage: node tools/capture-window-preview.mjs [tag] [--dialog]
import { app, sleep } from './app-flow.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const tag = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'states';
const a = await app();
if (!(await a.evaluate(`document.getElementById('source-dialog').open`))) {
  await a.evaluate(`(document.getElementById('source-row').hidden ? document.getElementById('source-empty-button') : document.getElementById('source-button')).click()`);
  await sleep(2500);
}
const shoot = async (clip, file) => {
  // The dialog is in the top layer: capture the visible viewport only (capturing beyond it re-lays the page out).
  const shot = await a.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...clip, scale: 1 } });
  await writeFile(file, Buffer.from(shot.data, 'base64'));
};
if (process.argv.includes('--dialog')) {
  const geometry = await a.evaluate(`(() => {
    for (const item of document.querySelectorAll('.source-options .source-item')) if (!/^FRAME /.test(item.querySelector('.source-choice').title)) item.style.display = 'none';
    const d = document.getElementById('source-dialog'), body = d.querySelector('.source-dialog-body'), r = d.getBoundingClientRect(), rect = e => { const x = e.getBoundingClientRect(); return [+x.left.toFixed(1), +x.top.toFixed(1), +x.width.toFixed(1), +x.height.toFixed(1)]; };
    const card = d.querySelector('.source-options .source-item:not([style*="none"])');
    return { viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, dialog: rect(d), body: rect(body), bodyScroll: [body.scrollHeight, body.clientHeight], pageScrollX: document.documentElement.scrollWidth > innerWidth,
      footer: rect(d.querySelector('.dialog-footer')), tabs: rect(d.querySelector('.source-tabs')), card: card ? rect(card) : null, thumb: card ? rect(card.querySelector('.source-thumb')) : null,
      overlay: card ? rect(card.querySelector('.source-overlay')) : null, label: card ? rect(card.querySelector('.source-label')) : null, icon: card ? rect(card.querySelector('.source-app-icon')) : null,
      nameFont: card ? getComputedStyle(card.querySelector('.source-window-name')).font : null };
  })()`);
  await sleep(300);
  await mkdir(new URL('../verification/window-preview/screens/', import.meta.url), { recursive: true });
  const [x, y, width, height] = geometry.dialog;
  await shoot({ x: Math.max(0, x - 8), y: Math.max(0, y - 8), width: Math.min(geometry.viewport[0], width + 16), height: Math.min(geometry.viewport[1], height + 16) }, new URL('../verification/window-preview/screens/' + tag + '.png', import.meta.url));
  await writeFile(new URL('../verification/window-preview/screens/' + tag + '.json', import.meta.url), JSON.stringify(geometry, null, 1));
  await a.evaluate(`document.querySelectorAll('.source-options .source-item').forEach(item => item.style.display = '')`);
  console.log(JSON.stringify(geometry));
} else {
  const titles = await a.evaluate(`[...document.querySelectorAll('.source-options .source-choice')].map(b => ({ title: b.title.split(String.fromCharCode(10))[0], state: b.dataset.thumbState })).filter(c => /^FRAME /.test(c.title))`);
  await mkdir(new URL('../verification/window-preview/cards/', import.meta.url), { recursive: true });
  for (const [i, c] of titles.entries()) {
    const box = await a.evaluate(`(() => { const b = [...document.querySelectorAll('.source-options .source-choice')].find(x => x.title.startsWith(${JSON.stringify(c.title)})); b.scrollIntoView({ block: 'nearest' }); const r = b.closest('.source-item').getBoundingClientRect(); return { x: r.left - 4, y: r.top - 4, width: r.width + 8, height: r.height + 8 }; })()`);
    await sleep(150);
    const file = `${tag}-${i + 1}-${c.state}.png`;
    await shoot(box, new URL('../verification/window-preview/cards/' + file, import.meta.url));
    console.log(file, c.title);
  }
}
a.close();
