// Verifies (and downloads only when missing) the pinned packages in deps/manifest.json, then extracts them to build/third_party.
// With deps/archives present this runs fully offline.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'deps/manifest.json'), 'utf8'));
const archives = join(root, 'deps/archives'), thirdParty = join(root, 'build/third_party');
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const sha256 = data => createHash('sha256').update(data).digest('hex');
await mkdir(archives, { recursive: true });
await mkdir(thirdParty, { recursive: true });
for (const item of manifest.packages) {
  const file = join(archives, item.file);
  if (!existsSync(file)) {
    console.log('download ' + item.url);
    const response = await fetch(item.url, { redirect: 'follow' });
    if (!response.ok) throw new Error(item.file + ': HTTP ' + response.status);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256(await readFile(file));
  if (actual !== item.sha256) throw new Error(item.file + ': SHA-256 mismatch ' + actual);
  if (item.extract) {
    const target = join(thirdParty, item.extract);
    if (!existsSync(target)) {
      const destination = item.extract === 'mediamtx' || item.extract === 'webview2' ? target : thirdParty;
      await mkdir(destination, { recursive: true });
      execFileSync(tar, ['-xf', file, '-C', destination], { stdio: 'inherit' });
    }
  }
  if (item.copyTo) await copyFile(file, join(root, item.copyTo));
  console.log('ok ' + item.file);
}
await rm(join(thirdParty, '.tmp'), { recursive: true, force: true });
