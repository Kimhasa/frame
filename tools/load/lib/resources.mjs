// Resource sampling for the load runner: host CPU/memory from Node, per-process CPU/memory, NIC counters and GPU from a
// long-running PowerShell sampler (tools/load/sampler.ps1), grouped as generator / browser sampler / target.
// CPU% is of the whole machine (all logical CPUs); "cores" is the same in CPU cores, easier to compare across hosts.
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, freemem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run, onLines, round } from './common.mjs';

const script = readFileSync(fileURLToPath(new URL('../sampler.ps1', import.meta.url)), 'utf8');

function cpuTimes() { return cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.total += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, total: 0 }); }

export class Resources {
  constructor(o) {
    this.o = o;
    this.control = o.controlFile;
    this.ctl = { gen: [process.pid], browser: [], targetPids: [], targetTree: [], targetNames: [], targetPathLike: [] };
    this.prev = null;
    this.prevCpu = cpuTimes();
    this.latest = null;
    this.listeners = [];
    this.logical = cpus().length;
    this.seenTarget = new Map();  // pid -> name of target processes seen (to notice one that disappears)
  }

  set(part) { Object.assign(this.ctl, part); writeFileSync(this.control, JSON.stringify(this.ctl)); }

  start() {
    this.set({});
    // Inline script block: running the .ps1 as a file would need an execution-policy change on default Windows installs.
    this.proc = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `& {\n${script}\n} -IntervalMs ${this.o.intervalMs || 2000} -Control '${this.control.replace(/'/g, "''")}'`]);
    onLines(this.proc.stdout, line => { if (line.startsWith('{')) try { this.ingest(JSON.parse(line)); } catch {} });
    onLines(this.proc.stderr, () => {});
  }

  ingest(s) {
    const now = cpuTimes(), dt = this.prev ? s.t - this.prev.t : 0;
    const host = { cpuPct: round(100 * (now.busy - this.prevCpu.busy) / Math.max(1, now.total - this.prevCpu.total)), memUsedPct: round(100 * (1 - freemem() / totalmem())) };
    this.prevCpu = now;
    const prevProcs = new Map((this.prev?.procs || []).map(p => [p.id, p]));
    const groups = { g: [], b: [], t: [] };
    for (const p of s.procs || []) {
      const before = prevProcs.get(p.id);
      const cores = before && dt > 0 ? Math.max(0, (p.cpuMs - before.cpuMs) / dt) : null;
      groups[p.g]?.push({ id: p.id, name: p.name, path: p.path, cores, rssMB: p.ws / 2 ** 20, privMB: p.priv / 2 ** 20, threads: p.threads, handles: p.handles });
    }
    const sum = list => {
      const known = list.filter(p => p.cores !== null);
      return { cores: known.length ? round(known.reduce((a, p) => a + p.cores, 0), 2) : null, cpuPct: known.length ? round(100 * known.reduce((a, p) => a + p.cores, 0) / this.logical) : null,
        rssMB: round(list.reduce((a, p) => a + p.rssMB, 0)), privMB: round(list.reduce((a, p) => a + p.privMB, 0)), count: list.length,
        procs: list.map(p => ({ id: p.id, name: p.name, cores: round(p.cores, 2), rssMB: round(p.rssMB), threads: p.threads, handles: p.handles })) };
    };
    const prevNics = new Map((this.prev?.nics || []).map(n => [n.name, n]));
    const nics = (s.nics || []).map(n => { const b = prevNics.get(n.name); return { name: n.name, rxMbps: b && dt > 0 ? round((n.rx - b.rx) * 8 / dt / 1000) : null, txMbps: b && dt > 0 ? round((n.tx - b.tx) * 8 / dt / 1000) : null }; });
    const died = [];
    for (const p of groups.t) this.seenTarget.set(p.id, p.name);
    const alive = new Set(groups.t.map(p => p.id));
    for (const [id, name] of this.seenTarget) if (!alive.has(id)) { died.push({ id, name }); this.seenTarget.delete(id); }
    this.latest = { t: s.t, dtMs: dt, samplerMs: s.ms, host, gen: sum(groups.g), browser: sum(groups.b), target: sum(groups.t), nics, gpu: s.gpu || null, targetGone: died };
    this.prev = s;
    for (const fn of this.listeners) fn(this.latest);
  }

  on(fn) { this.listeners.push(fn); }
  stop() { if (this.proc && this.proc.exitCode === null) this.proc.kill(); }
}
