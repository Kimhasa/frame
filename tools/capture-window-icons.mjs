// App icons of the window picker next to their program names (no window titles, no thumbnails): a contact sheet of the
// open list's title-row icons at 24 px (as shown) and enlarged, for checking that each app got its own icon.
// The list is closed before the sheet is drawn, so no window title or thumbnail is in the picture.
// usage: node tools/capture-window-icons.mjs [tag]  -> verification/window-preview/screens/icons-<tag>.png/.json
import { app, sleep } from './app-flow.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const tag = process.argv[2] || 'default';
const a = await app();
await a.evaluate(`(() => { window.__iconProbe = []; window.chrome.webview.addEventListener('message', ({ data }) => { if (data?.type === 'windows') window.__iconProbe = data.items.map(({ id, exe }) => ({ id, exe })); }); })()`);
if (await a.evaluate(`document.getElementById('source-dialog').open`)) { await a.evaluate(`document.querySelector('#source-dialog .dialog-footer [data-close]').click()`); await sleep(300); }
await a.evaluate(`(document.getElementById('source-row').hidden ? document.getElementById('source-empty-button') : document.getElementById('source-button')).click()`);
await sleep(3000);
const rows = await a.evaluate(`(() => {
  const sheet = document.createElement('div'); sheet.id = 'icon-sheet';
  sheet.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;background:#fff;padding:12px;display:grid;grid-template-columns:repeat(3,auto auto auto);gap:6px 14px;align-items:center;font:14px Pretendard,sans-serif;color:#25364b;border:1px solid #ccd';
  const out = [];
  for (const { id, exe } of window.__iconProbe) {
    const box = document.querySelector('[data-source="' + CSS.escape(id) + '"] .source-app-icon'); if (!box) continue;
    const small = box.cloneNode(true), large = box.cloneNode(true); large.style.cssText = 'width:56px;height:56px'; large.querySelector('img,svg').style.cssText = 'width:56px;height:56px;image-rendering:pixelated';
    const name = document.createElement('span'); name.textContent = exe + (box.querySelector('img') ? '' : '  (기본 아이콘)');
    sheet.append(small, large, name); out.push({ exe, icon: !!box.querySelector('img'), natural: box.querySelector('img') ? [box.querySelector('img').naturalWidth, box.querySelector('img').naturalHeight] : null });
  }
  document.querySelector('#source-dialog .dialog-footer [data-close]').click();
  document.body.append(sheet); const r = sheet.getBoundingClientRect(); return { out, clip: { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(r.height) } };
})()`);
await sleep(200);
const shot = await a.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...rows.clip, scale: 1 } });
await a.evaluate(`document.getElementById('icon-sheet').remove()`);
await mkdir(new URL('../verification/window-preview/screens/', import.meta.url), { recursive: true });
await writeFile(new URL('../verification/window-preview/screens/icons-' + tag + '.png', import.meta.url), Buffer.from(shot.data, 'base64'));
await writeFile(new URL('../verification/window-preview/screens/icons-' + tag + '.json', import.meta.url), JSON.stringify(rows.out, null, 1));
console.log(JSON.stringify(rows.out));
a.close();
