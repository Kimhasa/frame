// UI check for the 0.6.1 window-preview addendum (CLAUDE_WINDOW_PREVIEW_ADDENDUM.txt): the 송출 대상 선택 dialog only
// (wider dialog, 16:9 thumbnails, app icon + title row, status and retry inside the thumbnail area). Nothing recorded for
// 0.4, 0.5, 0.5.1 or 0.6 is changed or re-hashed.
// 1. work/source-preview.css matches UI_V061_ADDENDUM.json, keeps its markers and changes nothing outside that dialog:
//    every selector starts with #source-dialog or with an element new in 0.6.1 (.source-item, .source-overlay,
//    .source-state, .source-retry, .source-app-icon); the only at-rules are @media (max-width: N px) holding such selectors.
// 2. The page equals a build of the same sources without that stylesheet (work/build-console.mjs --without-0.6.1) with
//    the stylesheet appended once after the 0.6 mobile styles: the only static difference is that stylesheet.
// 3. That build without 0.6.1 must pass tools/verify-ui-v06.mjs (the 0.6, 0.5.1, 0.5 and 0.4 records). Its result is
//    reported on its own line, so a pending 0.6 change is never counted as a 0.6.1 one or hidden.
// --evidence: verification/window-preview/states-live.json and states-fault-{drop,delay,corrupt}.json
//    (tools/test-window-preview.mjs on the running app) must exist and pass.
// usage: node tools/verify-ui-v061.mjs [outputs/index.html] [--evidence]
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const v061 = await json('UI_V061_ADDENDUM.json'), v06 = await json('UI_V06_ADDENDUM.json');
const issues = [];

// 1. The stylesheet: recorded, marked, limited to the new elements.
const css = await readFile(resolve(root, v061.stylesheet.path), 'utf8');
if (hash(css) !== v061.stylesheet.sha256) issues.push('0.6.1 stylesheet differs from UI_V061_ADDENDUM.json: ' + v061.stylesheet.path);
if (!/^\/\* FRAME 0\.6\.1 window-preview addendum/.test(css) || !/\/\* end FRAME 0\.6\.1 window-preview addendum \*\/\s*$/.test(css)) issues.push('0.6.1 stylesheet lacks its begin/end markers');
const NEW = ['#source-dialog', '.source-item', '.source-overlay', '.source-state', '.source-retry', '.source-app-icon'];
const ownSelector = selector => NEW.some(prefix => selector === prefix || (selector.startsWith(prefix) && /^[\s.:#[>+~]/.test(selector.slice(prefix.length))));
const blocks = text => {
  const list = [];
  let depth = 0, start = 0, open = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth++ === 0) open = i; }
    else if (text[i] === '}' && --depth === 0) { list.push({ prelude: text.slice(start, open).trim(), body: text.slice(open + 1, i) }); start = i + 1; }
  }
  if (depth !== 0 || text.slice(start).trim()) issues.push('0.6.1 stylesheet: unbalanced braces or stray text');
  return list;
};
const checkRules = (body, where) => {
  for (const block of blocks(body)) {
    if (block.prelude.startsWith('@')) {
      if (where === 'top' && /^@media \(max-width: \d+px\)$/.test(block.prelude)) checkRules(block.body, block.prelude);
      else issues.push('0.6.1 stylesheet: at-rule not allowed: ' + block.prelude.slice(0, 60));
      continue;
    }
    for (const selector of block.prelude.split(',').map(s => s.trim())) if (!ownSelector(selector)) issues.push('0.6.1 stylesheet: rule outside the source dialog and the elements new in 0.6.1: ' + selector);
  }
};
checkRules(css.replace(/\/\*[\s\S]*?\*\//g, ''), 'top');

// 2. The page is the build without 0.6.1 plus this stylesheet, appended once after the 0.6 mobile styles.
const pagePath = resolve(root, process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'outputs/index.html');
const page = await readFile(pagePath, 'utf8');
const dir = await mkdtemp(join(tmpdir(), 'frame-ui-v061-')), withoutPath = join(dir, 'index.html');
const build = spawnSync(process.execPath, [resolve(root, 'work/build-console.mjs'), '--without-0.6.1', '--out', withoutPath], { cwd: root, encoding: 'utf8' });
if (build.status !== 0) issues.push('build without 0.6.1 failed: ' + (build.stderr || build.stdout).trim().slice(0, 300));
let base06 = { ok: false, output: 'not run' };
if (build.status === 0) {
  const without = await readFile(withoutPath, 'utf8'), mobile = await readFile(resolve(root, v06.stylesheet.path), 'utf8');
  if (without.split(mobile).length !== 2) issues.push('the 0.6 mobile styles were not found exactly once in the build without 0.6.1');
  else if (page !== without.replace(mobile, () => mobile + '\n' + css)) issues.push('page differs from the build without 0.6.1 by more than the 0.6.1 stylesheet (rebuild with node work/build-console.mjs?)');
  if (page.split(css).length !== 2) issues.push('0.6.1 stylesheet not found exactly once in the page');
  // 3. Everything below 0.6.1, by the 0.6 check itself.
  const run = spawnSync(process.execPath, [resolve(root, 'tools/verify-ui-v06.mjs'), withoutPath], { cwd: root, encoding: 'utf8' });
  base06 = { ok: run.status === 0 && !run.stderr.trim(), output: (run.stderr.trim() || run.stdout.trim()).split('\n').slice(0, 6).join('\n') };
}
await rm(dir, { recursive: true, force: true });

// Evidence from the running app.
const evidence = [];
for (const name of ['states-live', 'states-fault-drop', 'states-fault-delay', 'states-fault-corrupt']) {
  try { const result = await json('verification/window-preview/' + name + '.json'); if (!result.passed) evidence.push(name + '.json has failing checks: ' + result.checks.filter(c => !c.ok).map(c => c.name).join('; ')); }
  catch { evidence.push('verification/window-preview/' + name + '.json missing'); }
}
if (process.argv.includes('--evidence')) issues.push(...evidence);

if (issues.length) console.error('UI 0.6.1 FAILED:\n' + issues.join('\n'));
else console.log('UI 0.6.1 passed: the only static difference from the build without it is ' + v061.stylesheet.path + ' (' + css.length + ' bytes, scoped to #source-dialog and elements new in 0.6.1).'
  + (evidence.length ? '\nNote (not checked without --evidence): ' + evidence.join('; ') : process.argv.includes('--evidence') ? ' App evidence current and passing.' : ''));
console.log('UI 0.6 and earlier (verify-ui-v06.mjs on the build without 0.6.1): ' + (base06.ok ? 'passed' : 'FAILED\n' + base06.output));
process.exitCode = issues.length || !base06.ok ? 1 : 0;
