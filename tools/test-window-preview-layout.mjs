// Layout of the widened 송출 대상 선택 dialog on the running app (DevTools 9222), FRAME test windows only:
//   dialog width/height against the viewport, list scroll, tabs and buttons inside the window, no sideways scroll;
//   16:9 thumbnail box and the status overlay over it; the app icon + title row (24 px icon, 16 px title, one line,
//   ellipsis with the full title as tooltip and accessible name, same height on every card); same-title windows told
//   apart; edge-band test windows ("FRAME 비율 ...", tools probe) from capture to image to card: the four 6 px edge bands
//   present, aspect kept, no padding baked into the image, contain display; the player frames unchanged by the 0.6.1
//   styles; keyboard Tab / Escape.
// --emulate WxH@scale: DevTools viewport and device scale emulation of the page (layout and requested image sizes only;
// the native window and Windows scaling are not changed), recorded as emulated in the result.
// usage: node tools/test-window-preview-layout.mjs [tag] [--emulate 2560x1440@1]   (writes verification/window-preview/layout-<tag>.json)
import { app, sleep } from './app-flow.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const tag = process.argv.slice(2).find(arg => !arg.startsWith('--') && !/^\d+x\d+@/.test(arg)) || 'default';
const emulateArg = process.argv.includes('--emulate') ? process.argv[process.argv.indexOf('--emulate') + 1] : null;
const a = await app();
const emulated = emulateArg ? emulateArg.match(/^(\d+)x(\d+)@([\d.]+)$/) : null;
if (emulated) { await a.send('Emulation.setDeviceMetricsOverride', { width: +emulated[1], height: +emulated[2], deviceScaleFactor: +emulated[3], mobile: false }); await sleep(800); }
if (await a.evaluate('window.FrameRuntime.running')) throw new Error('the app is broadcasting');
const checks = [];
const check = (name, ok, data) => { checks.push({ name, ok: !!ok, data }); console.log((ok ? 'PASS ' : 'FAIL ') + name, data === undefined ? '' : JSON.stringify(data).slice(0, 300)); };
// Player frames first, with the 0.6.1 styles on and off (they are scoped to the dialog, so nothing may move).
const players = `JSON.stringify([...document.querySelectorAll('.preview, #viewer-stage, .player')].map(e => { const r = e.getBoundingClientRect(); return [e.id || e.className, +r.width.toFixed(1), +r.height.toFixed(1)]; }))`;
const withStyles = await a.evaluate(players);
const withoutStyles = await a.evaluate(`(() => { const s = [...document.querySelectorAll('style')].find(x => x.textContent.includes('FRAME 0.6.1 window-preview addendum')); const keep = s.textContent;
  s.textContent = keep.replace(/\\/\\* FRAME 0\\.6\\.1 window-preview addendum[\\s\\S]*?end FRAME 0\\.6\\.1 window-preview addendum \\*\\//, ''); const removed = keep.length - s.textContent.length;
  const out = ${players}; s.textContent = keep; return JSON.stringify({ removed, out }); })()`).then(JSON.parse);
check('player frames unchanged by the 0.6.1 styles (removed for the comparison)', withoutStyles.removed > 1000 && withStyles === withoutStyles.out && withStyles !== '[]', { removedBytes: withoutStyles.removed, frames: JSON.parse(withStyles).slice(0, 4) });

await a.evaluate(`(() => { window.__layoutProbe = { windows: null, icons: {} }; window.chrome.webview.addEventListener('message', ({ data }) => {
  if (data?.type === 'windows') window.__layoutProbe.windows = data.items.map(({ id, title, exe }) => ({ id, title, exe }));
  if (data?.type === 'icon') window.__layoutProbe.icons[data.id] = data.png.length; }); })()`);
await a.evaluate(`(document.getElementById('source-row').hidden ? document.getElementById('source-empty-button') : document.getElementById('source-button')).click()`);
await sleep(3500);
const page = await a.evaluate(`(() => {
  const rect = e => { const r = e.getBoundingClientRect(); return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const d = document.getElementById('source-dialog'), body = d.querySelector('.source-dialog-body');
  const probe = window.__layoutProbe, sizes = window.FrameRuntime ? null : null;
  return { viewport: { w: document.documentElement.clientWidth, h: innerHeight, dpr: devicePixelRatio, scrollbar: innerWidth - document.documentElement.clientWidth }, dialog: rect(d), body: rect(body), scroll: { content: body.scrollHeight, visible: body.clientHeight, pageX: document.documentElement.scrollWidth > innerWidth, dialogX: d.scrollWidth > d.clientWidth + 1 },
    footer: rect(d.querySelector('.dialog-footer')), confirm: rect(document.getElementById('confirm-source')), tabs: rect(d.querySelector('.source-tabs')), columns: getComputedStyle(d.querySelector('.source-options')).gridTemplateColumns.split(' ').length,
    windows: probe.windows, icons: probe.icons,
    cards: [...d.querySelectorAll('.source-options .source-item')].map(item => { const b = item.querySelector('.source-choice'), name = b.querySelector('.source-window-name'), icon = b.querySelector('.source-app-icon'), img = b.querySelector('.source-thumb img');
      return { id: b.dataset.source, test: /^FRAME /.test(b.title), title: /^FRAME /.test(b.title) ? b.title.split(String.fromCharCode(10))[0] : null, text: /^FRAME /.test(b.title) ? name.textContent : null,
        ellipsis: name.scrollWidth > name.clientWidth, nameFont: getComputedStyle(name).fontSize + ' ' + getComputedStyle(name).fontWeight, accessible: b.textContent.includes(name.textContent),
        card: rect(b), thumb: rect(b.querySelector('.source-thumb')), overlay: rect(item.querySelector('.source-overlay')), label: rect(b.querySelector('.source-label')), icon: rect(icon), iconImg: !!icon.querySelector('img'), nameBox: rect(name),
        image: img ? { natural: [img.naturalWidth, img.naturalHeight] } : null, state: b.dataset.thumbState }; }) };
})()`);
const { viewport, dialog, footer, confirm, scroll, cards } = page;
// A run whose override did not take effect is not reported as emulated.
if (emulated && (viewport.w + viewport.scrollbar !== +emulated[1] || Math.abs(viewport.dpr - +emulated[3]) > 0.01)) { a.close(); throw new Error('emulation not applied by this runtime: viewport ' + JSON.stringify(viewport)); }
const expectedWidth = Math.min(1120, viewport.w - 48);
// The visible width excludes the page's scrollbar: the dialog keeps 24 px from each side of what is visible.
check('dialog width min(1120, visible width - 48) and centred', Math.abs(dialog.w - expectedWidth) <= 1 && Math.abs(dialog.x - (viewport.w - dialog.w) / 2) <= 2, { dialog, viewport });
check('dialog height at most 90 % of the viewport; buttons inside the window', dialog.h <= viewport.h * 0.9 + 1 && confirm.y + confirm.h <= viewport.h && footer.y + footer.h <= dialog.y + dialog.h + 1, { dialogH: dialog.h, maxH: +(viewport.h * 0.9).toFixed(1), confirmBottom: confirm.y + confirm.h });
check('no sideways scroll (page or dialog); the list scrolls by itself when longer', !scroll.pageX && !scroll.dialogX && (scroll.content <= scroll.visible + 1 || scroll.visible < scroll.content), scroll);
const columns = page.columns, cardW = cards[0]?.card.w || 0;
check('two columns unless a card would be under ~280 px', columns === (viewport.w + viewport.scrollbar > 680 ? 2 : 1), { columns, cardW });
check('thumbnail box 16:9 at the card width; overlay on it (< 1 px)', cards.every(c => Math.abs(c.thumb.w / c.thumb.h - 16 / 9) < 0.01 && Math.abs(c.overlay.y - c.thumb.y) < 1 && Math.abs(c.overlay.h - c.thumb.h) < 1 && Math.abs(c.overlay.w - c.thumb.w) < 1.5), cards.slice(0, 2).map(c => [c.thumb, c.overlay]));
check('title rows: one height on every card, 24 px icon, 16 px title, inside the card', new Set(cards.map(c => c.label.h)).size === 1 && cards.every(c => c.icon.w === 24 && c.icon.h === 24 && c.nameFont.startsWith('16px') && c.nameBox.x + c.nameBox.w <= c.card.x + c.card.w), { labelH: cards[0]?.label.h, font: cards[0]?.nameFont });
const tests = cards.filter(c => c.test);
const long = tests.find(c => c.title.startsWith('FRAME 아주 긴'));
check('long Korean title: one line with ellipsis, full title in tooltip and accessible name', long && long.ellipsis && long.label.h === cards[0].label.h && long.accessible && long.text === long.title, long && { ellipsis: long.ellipsis, labelH: long.label.h });
const twins = tests.filter(c => c.title.startsWith('FRAME 같은 제목 시험'));
check('same title and program: the cards still differ by the least needed', twins.length === 2 && twins[0].text !== twins[1].text, twins.map(c => c.text));
const iconless = tests.filter(c => /빈 창|캡처 제외|응답 없음|비율/.test(c.title));
check('windows without an icon keep the default icon (same 24 px box); the list is not held up by a hung window', iconless.every(c => !c.iconImg && c.icon.w === 24), iconless.map(c => [c.title.slice(6, 16), c.iconImg]));
// Edge bands: capture -> generated image -> card.
const ratios = { '16x9': [1280, 720], '4x3': [1024, 768], '세로': [600, 1000], '정사각': [800, 800], '울트라와이드': [1720, 720] };
for (const [label, [cw, ch]] of Object.entries(ratios)) {
  const card = tests.find(c => c.title === 'FRAME 비율 ' + label);
  if (!card) { check('edge test ' + label + ' present', false); continue; }
  const result = await a.evaluate(`(async () => { const b = document.querySelector('[data-source="${card.id}"]'), img = b.querySelector('.source-thumb img'); if (!img) return null;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const w = c.width, h = c.height;
    const avg = (x0, y0, x1, y1) => { const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data; let r = 0, gg = 0, bb = 0, n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; bb += d[i + 2]; } return [Math.round(r / n), Math.round(gg / n), Math.round(bb / n)]; };
    const box = img.getBoundingClientRect(), scale = Math.min(box.width / w, box.height / h);
    return { size: [w, h], top: avg(Math.round(w * .2), 1, Math.round(w * .8), 2), bottom: avg(Math.round(w * .2), h - 2, Math.round(w * .8), h - 1), left: avg(1, Math.round(h * .2), 2, Math.round(h * .8)), right: avg(w - 2, Math.round(h * .2), w - 1, Math.round(h * .8)),
      centre: avg(Math.round(w * .45), Math.round(h * .45), Math.round(w * .55), Math.round(h * .55)), shown: [+(w * scale).toFixed(1), +(h * scale).toFixed(1)], box: [+box.width.toFixed(1), +box.height.toFixed(1)] }; })()`);
  const near = (v, t) => v.every((x, i) => Math.abs(x - t[i]) < 70);
  const ok = result && near(result.top, [255, 0, 0]) && near(result.right, [0, 200, 0]) && near(result.bottom, [0, 0, 255]) && near(result.left, [255, 0, 255])
    && Math.abs(result.size[0] / result.size[1] - cw / ch) < 0.015 && (Math.abs(result.shown[0] - result.box[0]) < 1.5 || Math.abs(result.shown[1] - result.box[1]) < 1.5);
  check(`edge bands ${label} (${cw}x${ch}): all four edges in the image, aspect kept, contain fit`, ok, result);
}
// Keyboard: Tab moves through the cards and their retry buttons; Escape closes and the native work stops.
await a.evaluate(`document.querySelector('.source-options .source-choice').focus()`);
await a.key('Tab'); await a.key('Tab');
const focused = await a.evaluate(`(() => { const e = document.activeElement, r = e.getBoundingClientRect(), body = document.querySelector('.source-dialog-body').getBoundingClientRect(); return { cls: e.className, visible: r.top >= body.top - 1 && r.bottom <= body.bottom + 1 }; })()`);
await a.key('Escape'); await sleep(300);
const closed = !(await a.evaluate(`document.getElementById('source-dialog').open`));
check('keyboard: Tab moves between cards, the focused card is scrolled into view; Escape closes', focused.cls.includes('source-choice') && focused.visible && closed, { focused, closed });
if (emulated) await a.send('Emulation.clearDeviceMetricsOverride');
a.close();
const result = { tag, emulated: emulateArg, measuredAt: new Date().toISOString(), viewport, dialog, passed: checks.every(c => c.ok), checks };
await mkdir(new URL('../verification/window-preview/', import.meta.url), { recursive: true });
await writeFile(new URL('../verification/window-preview/layout-' + tag + '.json', import.meta.url), JSON.stringify(result, null, 1));
console.log(result.passed ? 'ALL PASS' : 'FAILURES: ' + checks.filter(c => !c.ok).map(c => c.name).join('; '));
