// Assembles dist/FrameConsole (the only runtime entry point is FrameConsole.exe) and dist/FrameConsole-0.5.0-win64.zip.
// Run after: node work/build-console.mjs, node tools/verify-ui-lock.mjs, build\vsbuild.cmd
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist'), app = join(dist, 'FrameConsole'), tp = join(root, 'build/third_party');
const manifest = JSON.parse(await readFile(join(root, 'deps/manifest.json'), 'utf8'));
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const copy = async (from, to) => {
  await mkdir(join(to, '..'), { recursive: true });
  if (existsSync(to) && (await sha256(from)) === (await sha256(to))) return;
  await copyFile(from, to);
};

if (!existsSync(join(root, 'build/native/FrameConsole.exe'))) throw new Error('build/native/FrameConsole.exe is missing; run build\\vsbuild.cmd');
// Keep a user's edited config and runtime data if the folder is rebuilt in place.
const keptConfig = existsSync(join(app, 'config/frame-console.json')) ? await readFile(join(app, 'config/frame-console.json')) : null;
// bin and redist are only replaced when their content differs: a running FFmpeg/MediaMTX keeps its exe locked.
for (const name of ['FrameConsole.exe', 'ui', 'licenses', 'tools', 'README.txt', 'DEPENDENCIES.txt']) await rm(join(app, name), { recursive: true, force: true });
await mkdir(app, { recursive: true });

await copy(join(root, 'build/native/FrameConsole.exe'), join(app, 'FrameConsole.exe'));
await copy(join(root, 'outputs/index.html'), join(app, 'ui/index.html'));
for (const font of ['PretendardVariable.woff2', 'OFL.txt', 'SOURCE.txt']) await copy(join(root, 'outputs/assets/fonts', font), join(app, 'ui/assets/fonts', font));
await copy(join(tp, 'ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe'), join(app, 'bin/ffmpeg.exe'));
await copy(join(tp, 'mediamtx/mediamtx.exe'), join(app, 'bin/mediamtx.exe'));
await copy(join(root, 'deps/archives/MicrosoftEdgeWebView2RuntimeInstallerX64.exe'), join(app, 'redist/MicrosoftEdgeWebView2RuntimeInstallerX64.exe'));
await copy(join(tp, 'ffmpeg-9.0.2-essentials_build/LICENSE'), join(app, 'licenses/FFmpeg-LICENSE.txt'));
await copy(join(tp, 'ffmpeg-9.0.2-essentials_build/README.txt'), join(app, 'licenses/FFmpeg-BUILD.txt'));
await copy(join(tp, 'mediamtx/LICENSE'), join(app, 'licenses/MediaMTX-LICENSE.txt'));
await copy(join(tp, 'webview2/LICENSE.txt'), join(app, 'licenses/WebView2-SDK-LICENSE.txt'));
await copy(join(root, 'outputs/assets/fonts/OFL.txt'), join(app, 'licenses/Pretendard-OFL.txt'));
const json = await readFile(join(root, 'native/third_party/nlohmann/json.hpp'), 'utf8');
await writeFile(join(app, 'licenses/nlohmann-json-MIT.txt'), json.slice(json.indexOf('Licensed under the MIT License'), json.indexOf('\n', json.indexOf('SPDX-License-Identifier'))).trim() + '\n');
await copy(join(root, 'packaging/README.txt'), join(app, 'README.txt'));
await copy(join(root, 'packaging/firewall-rules.ps1'), join(app, 'tools/firewall-rules.ps1'));
await copy(join(root, 'packaging/frame-console.example.json'), join(app, 'config/frame-console.example.json'));
await copy(join(root, 'packaging/frame-console.secrets.example.json'), join(app, 'config/frame-console.secrets.example.json'));
if (keptConfig) await writeFile(join(app, 'config/frame-console.json'), keptConfig);
else await copy(join(root, 'packaging/frame-console.example.json'), join(app, 'config/frame-console.json'));

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'data') out.push(...await files(full)); } else out.push(full);
  }
  return out;
}
const lines = ['FRAME Console 0.5.0 - files and dependencies', '', 'Runtime files (SHA-256):'];
for (const file of (await files(app)).sort()) {
  const rel = relative(app, file).replaceAll('\\', '/');
  if (rel === 'DEPENDENCIES.txt' || rel.startsWith('config/frame-console.json')) continue;
  lines.push(`  ${await sha256(file)}  ${(await stat(file)).size.toString().padStart(10)}  ${rel}`);
}
lines.push('', 'Pinned sources (deps/manifest.json):');
for (const p of manifest.packages) lines.push(`  ${p.name} ${p.version}`, `    ${p.url}`, `    archive sha256 ${p.sha256}`, `    license: ${p.license}`);
lines.push('', 'Build toolchain:', `  ${manifest.toolchain.name} ${manifest.toolchain.version}`, '  C++17, x64, static CRT (/MT): no Visual C++ Redistributable needed.', '');
await writeFile(join(app, 'DEPENDENCIES.txt'), lines.join('\r\n'), 'utf8');

const zip = join(dist, 'FrameConsole-0.5.0-win64.zip');
await rm(zip, { force: true });
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(tar, ['-a', '-c', '-f', zip, '--exclude', 'FrameConsole/data', '-C', dist, 'FrameConsole'], { stdio: 'inherit' });
console.log('dist/FrameConsole ready; zip ' + ((await stat(zip)).size / 1048576).toFixed(1) + ' MB');
