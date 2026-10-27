import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
const base = new URL('../', import.meta.url);
const previous = await readFile(new URL('outputs/index.html', base), 'utf8');
let icons = previous.match(/<svg aria-hidden="true" style="position:absolute;[\s\S]*?<\/defs><\/svg>/)?.[0];
if (!icons) throw new Error('Existing icon definitions were not found');
const extraIcons = {
  'i-pause': '<symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" stroke-width="3"/></symbol>',
  'i-layout': '<symbol id="i-layout" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M16 5v14"/></symbol>',
  'i-chevron': '<symbol id="i-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>',
  'i-volume': '<symbol id="i-volume" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></symbol>',
  'i-volume-off': '<symbol id="i-volume-off" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM16 9l6 6m0-6-6 6"/></symbol>',
  'i-gear': '<symbol id="i-gear" viewBox="0 0 24 24"><path d="m9 3-1 3-3 1-2 3 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-3-3-1-1-3z"/><circle cx="12" cy="11" r="3"/></symbol>'
};
for (const [id, markup] of Object.entries(extraIcons)) if (!icons.includes('id="' + id + '"')) icons = icons.replace('</defs>', markup + '</defs>');
const css = (await readFile(new URL('work/console.css', base), 'utf8')) + '\n' + (await readFile(new URL('work/ux.css', base), 'utf8')) + '\n' + (await readFile(new URL('work/components.css', base), 'utf8'));
const js = (await readFile(new URL('work/components.js', base), 'utf8')) + '\n' + (await readFile(new URL('work/console-ux.js', base), 'utf8'));
new vm.Script(js);
const template = await readFile(new URL('work/console-template.html', base), 'utf8');
const html = template.replace('__STYLES__', () => css).replace('__ICONS__', () => icons).replace('__SCRIPT__', () => js);
if (/__STYLES__|__ICONS__|__SCRIPT__/.test(html)) throw new Error('Unresolved template marker');
if (/<(?:ul|li)\b|\bDEMO\b|시연|디자인 예시|SYNTHETIC|[•·]/i.test(html)) throw new Error('Unexpected label or bullet remains');
await writeFile(new URL('outputs/index.html', base), html, 'utf8');
console.log('FRAME Console updated; JavaScript syntax and removed labels verified.');
