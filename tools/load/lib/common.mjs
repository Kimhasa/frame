// Shared helpers for the load tools: paths of the bundled binaries, argument parsing, child-process bookkeeping, statistics.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, release, hostname } from 'node:os';

export const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const bin = {
  mediamtx: fileURLToPath(new URL('../../../dist/FrameConsole/bin/mediamtx.exe', import.meta.url)),
  ffmpeg: fileURLToPath(new URL('../../../dist/FrameConsole/bin/ffmpeg.exe', import.meta.url)),
  ffprobe: fileURLToPath(new URL('../../../build/third_party/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe', import.meta.url)),
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --key value / --flag pairs; values that look like numbers or booleans are converted, "a,b" stays a string.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    const next = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next === 'true' ? true : next === 'false' ? false : /^-?\d+(\.\d+)?$/.test(next) ? Number(next) : next;
  }
  return out;
}

export function readJson(file) { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }

// Deep merge for plan files: objects merge, arrays and scalars replace.
export function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  return out;
}

// Children started by this process. Windows has no process groups for Node, so trees are ended with taskkill /T by PID
// (MediaMTX's on-demand FFmpeg encoders and Edge's helpers are children of the processes we started).
const children = new Set();
export function track(child) { children.add(child); child.once('exit', () => children.delete(child)); return child; }
export function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}
export function killAll() { for (const c of [...children]) killTree(c); }
let hooked = false;
export function killOnExit({ signals = true } = {}) {
  if (hooked) return;
  hooked = true;
  process.on('exit', killAll);
  for (const sig of signals ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGTERM', 'SIGBREAK']) process.on(sig, () => { killAll(); process.exit(130); });
}

export function run(file, args, opts = {}) { return track(spawn(file, args, { windowsHide: true, ...opts })); }

// Line splitter for child stdout/stderr.
export function onLines(stream, fn) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => { rest += chunk; let i; while ((i = rest.indexOf('\n')) >= 0) { fn(rest.slice(0, i).replace(/\r$/, '')); rest = rest.slice(i + 1); } });
}

export function percentile(values, p) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}
export const mean = values => { const v = values.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
export const round = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export async function fetchJson(url, opts = {}, timeoutMs = 5000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, ok: r.ok, body, headers: r.headers };
}

export function toolVersion(file, args = ['-version']) {
  if (!existsSync(file)) return null;
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).find(l => l.trim()) || null;
}

// Host description for the result files (who generated the load and on what).
export function hostSpec() {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', [
    '$c = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors',
    '$g = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })',
    '$n = @(Get-NetAdapter | Where-Object Status -eq Up | ForEach-Object { @{ name = $_.Name; description = $_.InterfaceDescription; linkSpeed = $_.LinkSpeed } })',
    '$o = Get-CimInstance Win32_OperatingSystem',
    '@{ cpu = $c.Name; cores = $c.NumberOfCores; logical = $c.NumberOfLogicalProcessors; gpus = $g; nics = $n; os = $o.Caption + " " + $o.Version } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  let extra = {};
  try { extra = JSON.parse(ps.stdout); } catch {}
  return { hostname: hostname(), ...extra, logicalCpus: cpus().length, ramGB: round(totalmem() / 2 ** 30, 1), osRelease: release(), node: process.version };
}

export function csv(rows, columns) {
  const esc = v => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  return [columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\n') + '\n';
}

// True when nothing listens on the port (checked by binding it briefly); a second target or generator on the same
// ports would otherwise answer the first one's API and steal its publisher.
export async function portFree(port, type = 'tcp', host = type === 'tcp' ? '127.0.0.1' : '0.0.0.0') {
  const { createServer } = await import('node:net');
  const { createSocket } = await import('node:dgram');
  return new Promise(resolve => {
    if (type === 'udp') {
      const s = createSocket('udp4');
      s.once('error', () => resolve(false));
      s.bind(port, host, () => s.close(() => resolve(true)));
      return;
    }
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

// Processes whose command line contains `needle` (e.g. a unique --user-data-dir). Edge's launcher process exits right
// after starting the real browser, so the browser tree cannot be found from the PID that spawn() returned.
export function pidsByCommandLine(needle, name = '') {
  const filter = name ? `-Filter \"Name='${name}'\"` : '';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process ${filter} | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle.replace(/'/g, "''")}') } | ForEach-Object { '' + $_.ProcessId + ':' + [int]($_.CommandLine -notmatch ' --type=') }) -join ','`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return String(r.stdout || '').trim().split(',').filter(Boolean).map(x => { const [pid, main] = x.split(':'); return { pid: Number(pid), main: main === '1' }; });
}

// Local time as yyyyMMdd-HHmmss for result folder names (the run id sorts by start time on that PC).
export function localStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
