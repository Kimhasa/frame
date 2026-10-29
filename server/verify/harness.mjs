// Process and check helpers for the relay verification scripts. Every process is started here and killed by its own PID.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(stepMs);
  }
  return null;
}

const started = [];
export function start(name, cmd, args, { cwd, env, logDir } = {}) {
  // Windows environment names are case-insensitive: drop "Path" before adding "PATH" so the child sees one value.
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env || {})) { for (const key of Object.keys(merged)) if (key.toLowerCase() === k.toLowerCase()) delete merged[key]; merged[k] = v; }
  const child = spawn(cmd, args, { cwd, env: merged, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  const file = logDir ? createWriteStream(join(logDir, name + '.log')) : null;
  for (const s of [child.stdout, child.stderr]) s.on('data', d => { const t = d.toString(); file?.write(t); for (const l of t.split(/\r?\n/)) if (l) { lines.push(l); if (lines.length > 4000) lines.shift(); } });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const proc = { name, child, pid: child.pid, lines, exited, running: true };
  child.on('exit', () => { proc.running = false; file?.end(); });
  started.push(proc);
  return proc;
}

export async function stop(proc) {
  if (!proc?.running) return;
  try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await Promise.race([proc.exited, sleep(3000)]);
}
export async function stopAll() { for (const p of started.reverse()) await stop(p); }

// Edge hands its browser over to a new process, so the launcher's PID tree does not contain it. Processes are matched by a
// command-line fragment unique to this run (its temporary profile folder) and killed by their own PIDs.
export function killByCommandLine(fragment) {
  if (!fragment || fragment.length < 20) return [];
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${fragment.replace(/'/g, "''")}') } | ForEach-Object { $_.ProcessId }`;
  const pids = execFileSync('powershell', ['-NoProfile', '-Command', script]).toString().split(/\s+/).filter(Boolean).map(Number).filter(p => p !== process.pid);
  for (const pid of pids) try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  return pids;
}

export async function portFree(port) {
  const net = await import('node:net');
  return new Promise(resolve => { const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1'); });
}

// Records each check with a pass flag and the measured detail; nothing is counted as passed without a measured value.
export function checks() {
  const list = [];
  const check = (name, ok, detail = {}) => { list.push({ name, ok: !!ok, ...detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(46) + JSON.stringify(detail).slice(0, 300)); return !!ok; };
  return { list, check };
}

export function ffprobe(exe, file) {
  const out = execFileSync(exe, ['-v', 'error', '-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,sample_rate,channels:format=duration', '-of', 'json', file]);
  return JSON.parse(out.toString());
}
