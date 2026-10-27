// Recording size and load for one source window: starts a broadcast of the window, samples GPU (nvidia-smi) and the
// CPU/memory of FrameConsole.exe and its FFmpeg/MediaMTX, stops after N seconds and reads the recording's real size.
// Appends one JSON line to verification/storage-results.jsonl and saves a frame from the recording (verification/storage/).
// usage: node tools/measure-storage.mjs <label> <window title prefix> [seconds=60]
import { execFileSync, execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app, selectWindow, snapshot, sleep } from './app-flow.mjs';

const [label, title, seconds = '60'] = process.argv.slice(2);
const root = new URL('../', import.meta.url), recordings = join(process.env.LOCALAPPDATA, 'FrameConsole', 'recordings');
const ps = command => execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
const procs = () => { const v = JSON.parse(ps(`@(Get-Process FrameConsole,ffmpeg,mediamtx -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\dist\\FrameConsole\\*' } | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; id = $_.Id; cpu = $_.CPU; ws = $_.WorkingSet64 } }) | ConvertTo-Json -Compress`) || '[]'); return Array.isArray(v) ? v : [v]; };
const gpu = () => new Promise(resolve => execFile('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder', '--format=csv,noheader,nounits'], (e, out) => resolve(e ? null : out.trim().split(',').map(Number))));
const a = await app();
if ((await a.evaluate(`document.getElementById('start-button').innerText`)).includes('종료')) {
  await a.evaluate(`document.getElementById('start-button').click()`); await sleep(400); await a.evaluate(`document.getElementById('confirm-stop').click()`); await sleep(3500);
}
await a.evaluate(`document.getElementById('tab-sender').click()`);
await selectWindow(a, title);
await sleep(1500);
const before = procs(), t0 = Date.now();
await a.evaluate(`document.getElementById('start-button').click()`);
for (let i = 0; i < 60 && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`)); i++) await sleep(250);
const applied = (await snapshot(a)).logs.find(l => l.includes('적용:'));
const gpuSamples = [], fpsSamples = [];
const end = Date.now() + Number(seconds) * 1000;
await sleep(3000);
while (Date.now() < end) {
  const g = await gpu(); if (g) gpuSamples.push(g);
  fpsSamples.push(await a.evaluate(`document.getElementById('metric-fps').textContent + ' / ' + document.getElementById('metric-bitrate').textContent`));
  await sleep(2000);
}
const after = procs(), elapsed = (Date.now() - t0) / 1000;
const cpu = {};
for (const p of after) {
  const b = before.find(x => x.id === p.id);
  cpu[p.name] = (cpu[p.name] || 0) + (p.cpu - (b ? b.cpu : 0));
}
const memoryMB = Object.fromEntries(after.map(p => [p.name, Math.round(p.ws / 1048576)]));
await a.evaluate(`document.getElementById('start-button').click()`); await sleep(400); await a.evaluate(`document.getElementById('confirm-stop').click()`); await sleep(3500);
const newest = readdirSync(recordings).map(n => ({ n, t: statSync(join(recordings, n)).birthtimeMs })).filter(x => x.t >= t0 - 5000).sort((x, y) => y.t - x.t)[0] || { n: '' };
let meta = {}; try { meta = JSON.parse(readFileSync(join(recordings, newest.n, 'broadcast.json'), 'utf8')); } catch {}
const avg = (rows, i) => rows.length ? +(rows.reduce((s, r) => s + r[i], 0) / rows.length).toFixed(1) : null;
const result = { label, title, seconds: +elapsed.toFixed(1), applied, recording: meta.endedAtMs ? { id: meta.id, bytes: meta.bytes, MB: +(meta.bytes / 1048576).toFixed(1), averageMbps: meta.averageMbps, capMbps: meta.bitrateMbps, rateControl: meta.rateControl } : 'none',
  cpuPercentOfOneCore: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, +(v / elapsed * 100).toFixed(1)])), memoryMB,
  gpu: { util: avg(gpuSamples, 0), encoder: avg(gpuSamples, 1), decoder: avg(gpuSamples, 2) }, uiSamples: fpsSamples.slice(-3) };
console.log(JSON.stringify(result));
mkdirSync(new URL('verification/storage/', root), { recursive: true });
appendFileSync(new URL('verification/storage-results.jsonl', root), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n');
if (meta.endedAtMs) {
  // One frame from the middle of the recording, decoded from the stored files, for a visual quality check.
  const dir = join(recordings, newest.n, meta.path || 'screen-01'), files = readdirSync(dir).filter(f => f.endsWith('.mp4')).sort();
  try { execFileSync(join(new URL('../dist/FrameConsole/bin/', import.meta.url).pathname.slice(1), 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '20', '-i', join(dir, files[0]), '-frames:v', '1', new URL(`verification/storage/${label}.png`, root).pathname.slice(1)]); } catch (e) { console.log('frame extract failed', e.message); }
}
a.close();
