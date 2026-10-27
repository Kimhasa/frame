import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'UI_LOCK.json'), 'utf8'));
const hash = content => createHash('sha256').update(content).digest('hex');
const issues = [];
for (const item of [...manifest.referenceFiles, ...manifest.lockedSources]) {
  try {
    const actual = hash(await readFile(resolve(root, item.path)));
    if (actual !== item.sha256) issues.push('Changed locked file: ' + item.path);
  } catch { issues.push('Missing locked file: ' + item.path); }
}
const ui = resolve(root, process.argv[2] || 'outputs/index.html');
try {
  const html = await readFile(ui, 'utf8');
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  if (styles.length !== 1 || hash(styles[0][1]) !== manifest.presentation.styleSha256) issues.push('The approved CSS block changed');
  const svg = html.match(/<svg aria-hidden="true" style="position:absolute;[\s\S]*?<\/defs><\/svg>/)?.[0];
  if (!svg || hash(svg) !== manifest.presentation.svgSha256) issues.push('The approved SVG definitions changed');
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  if (new Set(ids).size !== ids.length) issues.push('Duplicate control IDs');
  for (const id of manifest.presentation.controlIds) if (!ids.includes(id)) issues.push('Missing approved control ID: ' + id);
  if (/<select\b/i.test(markup)) issues.push('A native select replaced an approved custom control');
  if (/<link\b[^>]*\bhref=["']https?:|<script\b[^>]*\bsrc=["']https?:/i.test(html)) issues.push('An external CSS, font or script dependency was introduced');
} catch (error) { issues.push('Cannot inspect the runtime UI: ' + error.message); }
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else {
  console.log('UI lock passed: original reference, locked UI sources, CSS, SVG and control IDs are intact.');
  console.log('Real rendering and streaming functionality still require separate verification.');
}
