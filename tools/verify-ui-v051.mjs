// UI check for the 0.5.1 addendum (CLAUDE_CAPTURE_PLAYER_ADDENDUM.txt). The 0.5 lock (UI_V05_LOCK.json) is not changed:
// every 0.5 reference file and locked source must still match it, and the built page must equal the locked 0.5 markup
// once the recorded addendum stylesheet is taken out. The addendum stylesheet itself must match UI_V051_ADDENDUM.json.
// usage: node tools/verify-ui-v051.mjs [outputs/index.html]
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(resolve(root, 'UI_V05_LOCK.json'), 'utf8'));
const addendum = JSON.parse(await readFile(resolve(root, 'UI_V051_ADDENDUM.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex'), issues = [];
for (const entry of [...lock.referenceFiles, ...lock.lockedSources]) {
  try { if (hash(await readFile(resolve(root, entry.path))) !== entry.sha256) issues.push('Changed UI reference/source: ' + entry.path); }
  catch { issues.push('Missing UI reference/source: ' + entry.path); }
}
const css = await readFile(resolve(root, addendum.stylesheet.path), 'utf8');
if (hash(css) !== addendum.stylesheet.sha256) issues.push('Addendum stylesheet differs from the recorded one: ' + addendum.stylesheet.path);
const html = await readFile(resolve(root, process.argv[2] || 'outputs/index.html'), 'utf8');
const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const inserted = '\n' + css;
if (markup.split(inserted).length !== 2) issues.push('Addendum stylesheet not found exactly once in the page');
const without = markup.replace(inserted, '');
if (hash(without) !== lock.markupSha256) issues.push('Static markup, styles or SVG differ from UI 0.5 beyond the recorded addendum');
if (hash(markup) !== addendum.markupSha256) issues.push('Page markup differs from the recorded 0.5.1 markup');
if (/<select\b|<h1\b|id="(?:sender-status|viewer-status)"/i.test(markup)) issues.push('Native select, large title or adjacent status badge returned');
const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(item => item[1]);
if (new Set(ids).size !== ids.length) issues.push('Duplicate IDs');
for (const id of lock.controlIds) if (!ids.includes(id)) issues.push('Missing control: ' + id);
if (/<link\b[^>]*\bhref=["']https?:|<script\b[^>]*\bsrc=["']https?:/i.test(html)) issues.push('External UI dependency');
if (/review-fixture|review\/fixture|review-broadcast|review-chat-/.test(html)) issues.push('Visual review fixtures entered the production UI');
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log('UI 0.5.1 passed: the 0.5 lock and 0.4 references are unchanged; the only static difference from 0.5 is the recorded addendum stylesheet (' + addendum.stylesheet.path + ').');
