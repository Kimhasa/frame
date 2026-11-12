// Process and check helpers for the relay verification scripts. Every process is started here and killed by its own PID.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Result files written into the repository name neither this PC's account nor its folders: the repository root becomes
// <repo> and the user profile <home> (a path may be written with backslashes, with slashes, or with the doubled
// backslashes of JSON text), the account in Spring Boot's "started by <account> in <folder>" line is removed, and a JSON
// string that is exactly this PC's machine name (the app announces it as the publisher) becomes "<pc>".
export function scrub(text, root) {
  const BS = String.fromCharCode(92);
  const forms = p => { const back = p.split('/').join(BS); return [...new Set([back.split(BS).join(BS + BS), back, back.split(BS).join('/')])]; };
  let t = String(text);
  for (const [path, name] of [[root, '<repo>'], [process.env.USERPROFILE || process.env.HOME || '', '<home>']])
    if (path && path.length > 3) for (const p of forms(path)) t = t.split(p).join(name);
  const pc = process.env.COMPUTERNAME || '';
  if (pc.length >= 3) t = t.split(JSON.stringify(pc)).join('"<pc>"');
  return t.replace(/started by [^ ]+ in /g, 'started by <user> in ');
}

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
// On process.exit, a normal end or an uncaught error the processes started here are killed by their own PIDs. Ctrl+C ends
// Node without the 'exit' event, so a script without its own signal handler gets one here that exits (and so runs the hook).
// Edge's browser process is never in these PID trees: the scripts stop it with killByCommandLine.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { if (process.listenerCount(sig) === 1) process.exit(130); });
process.on('exit', () => { for (const p of started) if (p.running) try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} });
export function start(name, cmd, args, { cwd, env, logDir } = {}) {
  if (process.platform !== 'win32') throw new Error('the verification scripts run on Windows only (taskkill, powershell, java.exe)');
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
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${fragment.replace(/'/g, "''")}') } | ForEach-Object { $_.ProcessId }`;
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
  // The flag is set after the detail is spread: a detail that has its own "ok" (a playing() sample) never replaces the result.
  const check = (name, ok, detail = {}) => { const entry = { name, ok: !!ok, ...detail }; entry.ok = !!ok; list.push(entry); console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(46) + JSON.stringify(detail).slice(0, 300)); return !!ok; };
  return { list, check };
}

export function ffprobe(exe, file) {
  const out = execFileSync(exe, ['-v', 'error', '-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,sample_rate,channels:format=duration', '-of', 'json', file]);
  return JSON.parse(out.toString());
}
