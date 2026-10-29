// Resource sampling on the sender PC while the load generator runs elsewhere: FrameConsole.exe and its MediaMTX/FFmpeg
// children (CPU, memory, threads, handles), host CPU/memory, NIC upload (what really leaves this PC) and the NVIDIA
// encoder. Same counters as the runner's target columns, so both CSVs can be lined up by time (keep the clocks synced).
// usage: node tools/load/host-sampler.mjs [--tree FrameConsole] [--seconds 0 (until Ctrl+C)] [--interval 3000] [--name sender]
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { repo, parseArgs, csv, killOnExit, killAll, sleep, hostSpec, localStamp } from './lib/common.mjs';
import { Resources } from './lib/resources.mjs';

const a = parseArgs(process.argv.slice(2));
const o = { tree: String(a.tree || 'FrameConsole'), seconds: a.seconds ?? 0, interval: a.interval ?? 3000, name: a.name || 'sender' };
const stamp = localStamp();
const out = join(repo, 'verification', 'load', `${stamp}-host-${o.name}`);
mkdirSync(out, { recursive: true });
killOnExit({ signals: false });

const roots = o.tree.split(',').flatMap(v => /^\d+$/.test(v) ? [Number(v)] : String(spawnSync('powershell', ['-NoProfile', '-Command', `@(Get-Process -Name '${v.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`], { encoding: 'utf8', windowsHide: true }).stdout).trim().split(',').filter(Boolean).map(Number));
if (!roots.length) console.error(`no running process for --tree ${o.tree}; only host, NIC and GPU are sampled`);
writeFileSync(join(out, 'host.json'), JSON.stringify({ startedAt: new Date().toISOString(), command: process.argv.join(' '), tree: o.tree, roots, host: hostSpec() }, null, 2));

const cols = ['t', 'hostCpuPct', 'hostMemUsedPct', 'targetCpuPct', 'targetCores', 'targetRssMB', 'targetProcs', 'nicRxMbps', 'nicTxMbps', 'gpuPct', 'gpuEncPct', 'gpuDecPct', 'gone', 'procs'];
const file = join(out, 'samples.csv');
writeFileSync(file, '﻿' + csv([], cols));
const r = new Resources({ controlFile: join(tmpdir(), `frame-load-host-${process.pid}.json`), intervalMs: o.interval });
r.on(s => {
  const row = { t: new Date(s.t).toISOString(), hostCpuPct: s.host.cpuPct, hostMemUsedPct: s.host.memUsedPct, targetCpuPct: s.target.cpuPct, targetCores: s.target.cores, targetRssMB: s.target.rssMB,
    targetProcs: s.target.count, nicRxMbps: s.nics.reduce((x, n) => x + (n.rxMbps || 0), 0), nicTxMbps: s.nics.reduce((x, n) => x + (n.txMbps || 0), 0),
    gpuPct: s.gpu?.util ?? null, gpuEncPct: s.gpu?.enc ?? null, gpuDecPct: s.gpu?.dec ?? null, gone: s.targetGone.map(p => `${p.name}:${p.id}`).join(' '),
    procs: s.target.procs.map(p => `${p.name}:${p.id}:${p.cores}c:${p.rssMB}MB:${p.threads}t`).join(' ') };
  appendFileSync(file, csv([row], cols).split('\n').slice(1).join('\n'));
  console.log(`${row.t.slice(11, 19)} host ${row.hostCpuPct}% target ${row.targetCpuPct}% (${row.targetProcs} procs, ${row.targetRssMB} MB) up ${row.nicTxMbps.toFixed(1)} Mbps gpu-enc ${row.gpuEncPct}%${row.gone ? ' GONE ' + row.gone : ''}`);
});
r.start();
r.set({ targetTree: roots });
let stop = false;
process.on('SIGINT', () => { stop = true; });
for (const t0 = Date.now(); !stop && (!o.seconds || Date.now() - t0 < o.seconds * 1000); ) await sleep(500);
r.stop();
killAll();
console.log(`samples: ${file}`);
process.exit(0);
