// UI check for the 0.6 mobile addendum (CLAUDE_PHASE1_INSTRUCTIONS.txt: UI 보존과 허용 변경, 모바일 시청 대응, 환경 문구 정리).
// Nothing recorded for 0.4, 0.5 or 0.5.1 is changed or re-hashed. Every UI_V05_LOCK.json reference file and locked source
// must still match, except work/console-template.html, which may differ from its locked hash only by the edits recorded in
// UI_V06_ADDENDUM.json (viewport-fit=cover, the removed environment badge). The 0.5.1 stylesheet must match
// UI_V051_ADDENDUM.json. The built page with the mobile stylesheet removed and the template edits reverted must equal the
// recorded 0.5.1 markup, and without the 0.5.1 stylesheet as well the locked 0.5 markup. The mobile stylesheet must match
// the addendum and may only hold rules for narrow windows (800 px or less) or touch screens outside the FrameConsole app
// (:root:not(.frame-native)), plus the html.volume-readonly hook, so a mouse window of 801 px or more renders as in 0.5.1.
// --evidence: also require verification/mobile/results.json (tools/capture-mobile.mjs, full run) to be made from the
// current page and stylesheet, with every 801 px+ mouse window and app-on-touch state unchanged outside the removed badge,
// no finding new in 0.6 and a passing live phase. Without it a stale or missing capture is only reported.
// usage: node tools/verify-ui-v06.mjs [outputs/index.html] [--evidence]
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const lock = await json('UI_V05_LOCK.json'), v051 = await json('UI_V051_ADDENDUM.json'), v06 = await json('UI_V06_ADDENDUM.json');
const hash = value => createHash('sha256').update(value).digest('hex'), issues = [];
const once = (text, part) => text.split(part).length === 2;
// Undo the recorded template edits (last first); null when one of them is not found exactly once.
function revertEdits(text) {
  for (const edit of [...v06.template.edits].reverse()) { if (!once(text, edit.to)) return null; text = text.replace(edit.to, () => edit.from); }
  return text;
}

// 1. 0.4 references and 0.5 locked sources; the template only through its recorded edits.
for (const entry of [...lock.referenceFiles, ...lock.lockedSources]) {
  let content;
  try { content = await readFile(resolve(root, entry.path)); } catch { issues.push('Missing UI reference/source: ' + entry.path); continue; }
  if (entry.path !== v06.template.path) { if (hash(content) !== entry.sha256) issues.push('Changed UI reference/source: ' + entry.path); continue; }
  const reverted = revertEdits(content.toString('utf8'));
  if (v06.template.lockedSha256 !== entry.sha256) issues.push('UI_V06_ADDENDUM.json names a different 0.5 template hash than UI_V05_LOCK.json');
  if (reverted === null || hash(reverted) !== entry.sha256) issues.push('Template differs from 0.5 beyond the recorded edits: ' + entry.path);
  if (hash(content) !== v06.template.sha256) issues.push('Template differs from the recorded 0.6 template: ' + entry.path);
}

// 2. Stylesheets: 0.5.1 unchanged, 0.6 as recorded and limited to touch screens or narrow windows.
const css051 = await readFile(resolve(root, v051.stylesheet.path), 'utf8');
if (hash(css051) !== v051.stylesheet.sha256) issues.push('0.5.1 stylesheet differs from UI_V051_ADDENDUM.json: ' + v051.stylesheet.path);
const css06 = await readFile(resolve(root, v06.stylesheet.path), 'utf8');
if (hash(css06) !== v06.stylesheet.sha256) issues.push('Mobile stylesheet differs from UI_V06_ADDENDUM.json: ' + v06.stylesheet.path);
if (!/^\/\* FRAME 0\.6 mobile addendum/.test(css06) || !/\/\* end FRAME 0\.6 mobile addendum \*\/\s*$/.test(css06)) issues.push('Mobile stylesheet lacks its begin/end markers');
for (const problem of scopeProblems(css06)) issues.push('Mobile stylesheet: ' + problem);
// The stylesheet may hold only these rules (the same split the page uses):
// - @media blocks whose every query is a narrow window, (max-width: N px) with N <= 800 and no other condition than
//   (orientation: ...), (max-height: ...) or (min-width: ...): any pointer, the FrameConsole app in a narrow window too;
// - @media blocks with (pointer: coarse) in every query: every selector inside, nested @container blocks included,
//   starts with :root:not(.frame-native), so the app (WebView2, html.frame-native) on a touch screen keeps the desktop UI;
// - top-level rules whose every selector starts with :root.volume-readonly (script hook, never set by a desktop browser).
// So a mouse window of 801 px or more matches nothing here (tools/capture-mobile.mjs compares 801, 1000, 1100 and 1440 px
// mouse windows and the app on a touch screen pixel by pixel). No not/only/or, @import, @supports or other at-rules.
function scopeProblems(css) {
  const problems = [], NATIVE = ':root:not(.frame-native)', HOOK = ':root.volume-readonly';
  // Tokenizer: comments and strings are skipped, so braces or commas inside them do not count.
  const blocks = text => {
    const list = [];
    let i = 0, start = 0, depth = 0, open = -1;
    const skip = () => {
      if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; return true; }
      if (text[i] === '"' || text[i] === "'") { const quote = text[i]; for (i++; i < text.length && text[i] !== quote; i++) if (text[i] === '\\') i++; i++; return true; }
      return false;
    };
    while (i < text.length) {
      if (skip()) continue;
      if (text[i] === '{') { if (depth++ === 0) open = i; }
      else if (text[i] === '}') { if (--depth === 0) { list.push({ prelude: strip(text.slice(start, open)).trim(), body: text.slice(open + 1, i) }); start = i + 1; } if (depth < 0) { problems.push('unbalanced }'); return list; } }
      else if (text[i] === ';' && depth === 0) { problems.push('statement outside a block: ' + strip(text.slice(start, i)).trim().slice(0, 60)); start = i + 1; }
      i++;
    }
    if (depth !== 0) problems.push('unclosed block');
    if (strip(text.slice(start)).trim()) problems.push('stray text at the end');
    return list;
  };
  const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '');
  // Top-level commas only (not inside :not(), :is() or attribute selectors).
  const splitList = text => { const parts = []; let depth = 0, from = 0; for (let k = 0; k < text.length; k++) { if ('(['.includes(text[k])) depth++; else if (')]'.includes(text[k])) depth--; else if (text[k] === ',' && depth === 0) { parts.push(text.slice(from, k)); from = k + 1; } } parts.push(text.slice(from)); return parts.map(part => part.trim()); };
  const prefixed = (selector, prefix) => selector === prefix || (selector.startsWith(prefix) && /^[\s.:#[>+~]/.test(selector.slice(prefix.length)));
  const FEATURE = /^\((pointer:\s*coarse|orientation:\s*(portrait|landscape)|(max|min)-(width|height):\s*\d+(\.\d+)?px)\)$/;
  function checkRules(body, coarse, where) {
    for (const block of blocks(body)) {
      if (block.prelude.startsWith('@container')) { checkRules(block.body, coarse, where); continue; }
      if (block.prelude.startsWith('@')) { problems.push('at-rule not allowed inside ' + where + ': ' + block.prelude.slice(0, 60)); continue; }
      for (const selector of splitList(block.prelude)) if (coarse && !prefixed(selector, NATIVE)) problems.push('touch rule without ' + NATIVE + ' (the app on a touch screen would change): ' + selector.slice(0, 70));
    }
  }
  for (const block of blocks(css)) {
    if (!block.prelude.startsWith('@')) {
      for (const selector of splitList(block.prelude)) if (!prefixed(selector, HOOK)) problems.push('rule outside a media query (only ' + HOOK + ' hooks may be): ' + selector.slice(0, 70));
      continue;
    }
    if (!block.prelude.startsWith('@media ')) { problems.push('at-rule not allowed: ' + block.prelude.slice(0, 60)); continue; }
    const kinds = splitList(block.prelude.slice(7)).map(query => {
      const features = query.split(/\s+and\s+/i).map(item => item.trim());
      if (/^(not|only)\b|\bor\b|\bnot\b/i.test(query) || !features.every(item => FEATURE.test(item))) return 'invalid';
      if (features.some(item => /pointer/.test(item))) return 'coarse';
      const narrow = features.some(item => { const m = item.match(/^\(max-width:\s*(\d+(?:\.\d+)?)px\)$/); return m && Number(m[1]) <= 800; });
      return narrow ? 'narrow' : 'invalid';
    });
    kinds.forEach((kind, k) => { if (kind === 'invalid') problems.push('media query can match a mouse window of 801 px or more: ' + splitList(block.prelude.slice(7))[k]); });
    if (kinds.includes('coarse') && kinds.includes('narrow')) problems.push('media query list mixes touch and narrow-window queries (split it): ' + block.prelude.slice(0, 80));
    checkRules(block.body, kinds.includes('coarse'), block.prelude.slice(0, 40));
  }
  return problems;
}

// 3. Built page: only the recorded differences from 0.5.1 and 0.5.
const pageArg = process.argv.slice(2).find(arg => !arg.startsWith('--')), requireEvidence = process.argv.includes('--evidence');
const html = await readFile(resolve(root, pageArg || 'outputs/index.html'), 'utf8');
const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
if (hash(markup) !== v06.markupSha256) issues.push('Page markup differs from the recorded 0.6 markup');
if (!once(markup, '\n' + css06)) issues.push('Mobile stylesheet not found exactly once in the page');
else {
  const as051 = revertEdits(markup.replace('\n' + css06, ''));
  if (as051 === null || hash(as051) !== v051.markupSha256) issues.push('Static markup, styles or SVG differ from UI 0.5.1 beyond the recorded 0.6 changes');
  else if (!once(as051, '\n' + css051) || hash(as051.replace('\n' + css051, '')) !== lock.markupSha256) issues.push('Static markup, styles or SVG differ from UI 0.5 beyond the recorded 0.5.1 and 0.6 changes');
}
// NET-12: no environment badge or closed-network wording left in the page (markup or script).
if (/class="environment"|내부망|폐쇄망|인트라넷 전용/.test(html)) issues.push('Environment badge or closed-network wording remains in the page');
const viewport = markup.match(/<meta name="viewport" content="([^"]*)">/)?.[1] || '';
for (const part of ['width=device-width', 'initial-scale=1', 'viewport-fit=cover']) if (!viewport.split(/,\s*/).includes(part)) issues.push('Viewport meta lacks ' + part);
if (/<select\b|<h1\b|id="(?:sender-status|viewer-status)"/i.test(markup)) issues.push('Native select, large title or adjacent status badge returned');
const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(item => item[1]);
if (new Set(ids).size !== ids.length) issues.push('Duplicate IDs');
for (const id of lock.controlIds) if (!ids.includes(id)) issues.push('Missing control: ' + id);
if (/<link\b[^>]*\bhref=["']https?:|<script\b[^>]*\bsrc=["']https?:/i.test(html)) issues.push('External UI dependency');
if (/review-fixture|review\/fixture|review-broadcast|review-chat-|mobile-test-|__test\//.test(html)) issues.push('Visual review fixtures entered the production UI');
// 4. Screenshot evidence (tools/capture-mobile.mjs): made from this page and stylesheet, and covering the required sizes.
const evidence = [];
try {
  const result = await json('verification/mobile/results.json');
  if (result.page?.markupSha256 !== hash(markup) || result.page?.mobileCssSha256 !== hash(css06)) evidence.push('verification/mobile/results.json was made from another page or mobile stylesheet (re-run node tools/capture-mobile.mjs)');
  if (!result.run?.full) evidence.push('verification/mobile/results.json is not a full run');
  const unchanged = new Set((result.desktopCompare || []).filter(item => item.mustBeUnchanged && item.unchangedOutsideBadge).map(item => item.size));
  for (const size of ['mouse-801', 'mouse-1000', 'desktop-1100', 'desktop', 'native-touch-1280']) if (!unchanged.has(size)) evidence.push('no unchanged pixel comparison for ' + size);
  for (const item of result.compareFailures || []) evidence.push('pixel comparison changed outside the badge: ' + item);
  if (result.summary?.after?.newFindings !== 0) evidence.push('capture shows ' + result.summary?.after?.newFindings + ' findings new in 0.6');
  if (!result.live?.runs?.length || result.live.runs.some(run => !run.ok)) evidence.push('live phase missing or failing');
} catch { evidence.push('verification/mobile/results.json missing or unreadable'); }
if (requireEvidence) issues.push(...evidence);
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log('UI 0.6 passed: 0.4 references, the 0.5 lock and the 0.5.1 addendum are unchanged; the only static differences are the recorded template edits (' + v06.template.edits.length + ') and the mobile stylesheet (' + v06.stylesheet.path + '), which holds only narrow-window (800 px or less) rules, touch rules outside the FrameConsole app and the volume-readonly hook.'
  + (!evidence.length ? ' Capture evidence is current and passing.' : requireEvidence ? '' : '\nNote (not checked without --evidence): ' + evidence.join('; ')));
