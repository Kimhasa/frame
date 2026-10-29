import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
const base = new URL('../', import.meta.url);
const previous = await readFile(new URL('outputs/index.html', base), 'utf8');
let icons = previous.match(/<svg aria-hidden="true" style="position:absolute;[\s\S]*?<\/defs><\/svg>/)?.[0];
if (!icons) throw new Error('Existing icon definitions were not found');
const extraIcons = {
  'i-info': '<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/></symbol>',
  'i-chat': '<symbol id="i-chat" viewBox="0 0 24 24"><path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z"/><path d="M7 10h8m-8 4h5"/></symbol>',
  'i-search': '<symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></symbol>',
  'i-refresh': '<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8.2 8.2 0 0 1 20 12M4 12a8.2 8.2 0 0 0 13.9 5.9"/></symbol>',
  'i-link': '<symbol id="i-link" viewBox="0 0 24 24"><path d="m10 13 4-4M8.2 15.8l-1.1 1.1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m1.7.3 1.1-1.1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" transform="translate(1 0)"/></symbol>',
  'i-back': '<symbol id="i-back" viewBox="0 0 24 24"><path d="m10 5-7 7 7 7M3 12h18"/></symbol>',
  'i-pip': '<symbol id="i-pip" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/></symbol>',
  'i-pause': '<symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" stroke-width="3"/></symbol>',
  'i-layout': '<symbol id="i-layout" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M16 5v14"/></symbol>',
  'i-chevron': '<symbol id="i-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>',
  'i-volume': '<symbol id="i-volume" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></symbol>',
  'i-volume-off': '<symbol id="i-volume-off" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM16 9l6 6m0-6-6 6"/></symbol>',
  'i-gear': '<symbol id="i-gear" viewBox="0 0 24 24"><path d="m9 3-1 3-3 1-2 3 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-3-3-1-1-3z"/><circle cx="12" cy="11" r="3"/></symbol>'
};
const gearPoints = [];
for (let tooth = 0; tooth < 6; tooth++) for (const [angle, radius] of [[-22,7.5],[-14,9.5],[14,9.5],[22,7.5]]) {
  const radians = (tooth * 60 + angle - 90) * Math.PI / 180;
  gearPoints.push((12 + radius * Math.cos(radians)).toFixed(2) + ' ' + (12 + radius * Math.sin(radians)).toFixed(2));
}
extraIcons['i-gear'] = '<symbol id="i-gear" viewBox="0 0 24 24"><path d="M' + gearPoints.join('L') + 'Z"/><circle cx="12" cy="12" r="3"/></symbol>';
for (const [id, markup] of Object.entries(extraIcons)) {
  const expression = new RegExp('<symbol id="' + id + '"[\\s\\S]*?<\\/symbol>');
  icons = icons.includes('id="' + id + '"') ? icons.replace(expression, markup) : icons.replace('</defs>', markup + '</defs>');
}
const css = (await readFile(new URL('work/console.css', base), 'utf8')) + '\n' + (await readFile(new URL('work/ux.css', base), 'utf8')) + '\n' + (await readFile(new URL('work/components.css', base), 'utf8'));
const presentationCss = await readFile(new URL('work/console-ui.css', base), 'utf8');
// 0.5.1 addendum styles (player controls auto-hide, picture-shaped boxes), appended after the 0.5 styles; see UI_V051_ADDENDUM.json.
const addendumCss = await readFile(new URL('work/player-ui.css', base), 'utf8');
// 0.6 mobile and tablet addendum (responsive viewer, touch targets, safe areas), appended last so the desktop rules above
// stay untouched; see UI_V06_ADDENDUM.json.
const mobileCss = await readFile(new URL('work/mobile-ui.css', base), 'utf8');
// 0.6.1 window-preview addendum (status and retry inside the program-window thumbnails), appended after 0.6; it styles
// only elements new in 0.6.1; see UI_V061_ADDENDUM.json.
// --without-0.6.1 leaves it out (tools/verify-ui-v061.mjs compares against that build); --out writes elsewhere.
const option = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const previewCss = process.argv.includes('--without-0.6.1') ? null : await readFile(new URL('work/source-preview.css', base), 'utf8');
const js = (await readFile(new URL('work/components.js', base), 'utf8')) + '\n' + (await readFile(new URL('work/console-ux.js', base), 'utf8'));
const presentationJs = await readFile(new URL('work/console-ui.js', base), 'utf8');
new vm.Script(js); new vm.Script(presentationJs);
const template = await readFile(new URL('work/console-template.html', base), 'utf8');
const html = template.replace('__STYLES__', () => css + '\n' + presentationCss + '\n' + addendumCss + '\n' + mobileCss + (previewCss === null ? '' : '\n' + previewCss)).replace('__ICONS__', () => icons).replace('__SCRIPT__', () => js + '\n' + presentationJs);
if (/__STYLES__|__ICONS__|__SCRIPT__/.test(html)) throw new Error('Unresolved template marker');
if (/<(?:ul|li)\b|\bDEMO\b|시연|디자인 예시|SYNTHETIC|[•·]/i.test(html)) throw new Error('Unexpected label or bullet remains');
await writeFile(option('--out') || new URL('outputs/index.html', base), html, 'utf8');
console.log('FRAME Console updated; JavaScript syntax and removed labels verified.');
