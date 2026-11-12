// HLS receiver pool for the load runner (plan.receiver "hls"): the same interface as lib/generator.mjs (add / remove /
// setSource / list / instances / dead / error maps), but every viewer is a light Node LL-HLS client (lib/hls-client.mjs)
// in one of `workers` worker threads of this process (0 = in the runner's own thread). list() returns per viewer the
// fields the runner reads from a generator path (ready, tracks, inboundBytes, readyTime) plus an `hls` block, and the
// pool's request totals (for the 429/503 share stop rule) and timing samples since the last call.
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Host } from './hls-client.mjs';

const sumInto = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v; return a; };

export class HlsPool {
  constructor(o) {
    this.o = o;
    this.instances = [];
    this.loss = new Map(); this.procErrors = new Map(); this.pairs = new Map(); this.sourceErrors = new Map();
    this.errorKinds = {}; this.lossLines = 0;
    this.totals = null; this.history = [];  // [{ t, requests, busy }] for rolling windows
    this.metrics = { unitMs: [], holdMs: [], recvDelayMs: [], masterMs: [] };
    this.lag = { p99: null, max: null };
  }

  async start() {
    const n = Math.max(0, this.o.workers ?? 2);
    if (n === 0) {
      const host = new Host(this.o.options);
      this.instances.push({ index: 0, local: host, exited: null, call: async (op, a) => (op === 'add' ? host.add(a.name, a.spec) : op === 'remove' ? host.remove(a.name)
        : op === 'quality' ? host.setQuality(a.name, a.quality) : op === 'snapshot' ? { ...host.snapshot(), lagP99Ms: null, lagMaxMs: null } : host.stopAll()) });
      return;
    }
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./hls-worker.mjs', import.meta.url), { workerData: { options: this.o.options } });
      const inst = { index: i, worker: w, exited: null, seq: 1, waiting: new Map() };
      inst.call = (op, a = {}) => new Promise(resolve => { const id = inst.seq++; inst.waiting.set(id, resolve); w.postMessage({ op, id, ...a }); });
      await new Promise((resolve, reject) => {
        w.on('message', m => { if (m.id === 0) return resolve(); const f = inst.waiting.get(m.id); if (f) { inst.waiting.delete(m.id); f(m.result); } });
        w.once('error', e => { inst.exited = 'error: ' + e.message; reject(e); });
        w.once('exit', code => { inst.exited ??= code; for (const f of inst.waiting.values()) f({ error: 'worker exited' }); inst.waiting.clear(); });
      });
      this.instances.push(inst);
    }
  }

  inst(index) { return this.instances[index % this.instances.length]; }
  // spec: { master, quality, base, path }
  async add(name, spec, index) {
    const t0 = Date.now();
    const r = await this.inst(index).call('add', { name, spec });
    if (!r || r.error && r.ok === undefined) return { ok: false, status: 0, t0, apiMs: Date.now() - t0, error: r?.error || 'no answer' };
    if (!r.ok && r.error) this.sourceErrors.set(name, [...(this.sourceErrors.get(name) || []), `${new Date().toISOString().slice(11, 19)} ${r.status} ${r.error}`].slice(-5));
    return { ...r, t0 };
  }
  async setSource(name, spec, index) { return this.inst(index).call('quality', { name, quality: spec.quality }); }
  async remove(name, index) { return !!(await this.inst(index).call('remove', { name })); }

  async list() {
    const items = new Map(), failed = new Set(), totals = { requests: 0, bytes: 0, playlistBytes: 0, mediaBytes: 0, byKind: {}, status: {}, errors: {}, busy: 0, retryAfter: {}, sessionOpened: 0, sessionRefused: 0, aborted: 0 };
    let lagP99 = null, lagMax = null;
    await Promise.all(this.instances.map(async inst => {
      if (inst.exited !== null) { failed.add(inst.index); return; }
      const s = await inst.call('snapshot');
      if (!s || s.error) { failed.add(inst.index); return; }
      for (const it of s.items) {
        items.set(it.name, it);
        if (it.hls.lastError) { const list = this.sourceErrors.get(it.name) || []; if (list[list.length - 1]?.endsWith(it.hls.lastError) !== true) { list.push(`${new Date().toISOString().slice(11, 19)} ${it.hls.lastError}`); this.sourceErrors.set(it.name, list.slice(-5)); } }
      }
      const t = s.totals;
      for (const k of ['requests', 'bytes', 'playlistBytes', 'mediaBytes', 'busy', 'sessionOpened', 'sessionRefused', 'aborted']) totals[k] += t[k] || 0;
      for (const k of ['byKind', 'status', 'errors', 'retryAfter']) sumInto(totals[k], t[k]);
      for (const [k, v] of Object.entries(s.metrics)) this.metrics[k].push(...v);
      inst.errorKinds = s.errorKinds || {};  // cumulative per worker
      if (Number.isFinite(s.lagP99Ms)) lagP99 = Math.max(lagP99 ?? 0, s.lagP99Ms);
      if (Number.isFinite(s.lagMaxMs)) lagMax = Math.max(lagMax ?? 0, s.lagMaxMs);
    }));
    this.errorKinds = this.instances.reduce((a, i) => sumInto(a, i.errorKinds), {});
    for (const k of Object.keys(this.metrics)) if (this.metrics[k].length > 20000) this.metrics[k] = this.metrics[k].slice(-20000);
    this.totals = totals;
    this.lag = { p99: lagP99, max: lagMax };
    this.history.push({ t: Date.now(), requests: totals.requests, busy: totals.busy });
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    return { ok: failed.size === 0, items, failed, totals };
  }

  // Requests and 429/503 answers between two times (from the totals of the list() calls around them).
  window(from, to = Date.now()) {
    const h = this.history;
    const a = [...h].reverse().find(x => x.t <= from) || h[0], b = [...h].reverse().find(x => x.t <= to) || h[h.length - 1];
    if (!a || !b || b === a) return { requests: 0, busy: 0, share: null };
    const requests = b.requests - a.requests, busy = b.busy - a.busy;
    return { requests, busy, share: requests > 0 ? Math.round(busy / requests * 10000) / 10000 : null };
  }
  takeMetrics() { const m = this.metrics; this.metrics = { unitMs: [], holdMs: [], recvDelayMs: [], masterMs: [] }; return m; }

  pids() { return []; }  // threads of this process (its CPU is the generator's)
  dead() { return this.instances.filter(i => i.exited !== null).map(i => i.index); }
  async stopAll() { await Promise.all(this.instances.map(i => (i.exited === null ? i.call('stop') : null))); }
  stop() {
    for (const i of this.instances) i.worker?.terminate();
    if (this.o.dir) writeFileSync(join(this.o.dir, 'hls-errors.json'), JSON.stringify({ receiver: 'hls', errorKinds: this.errorKinds, totals: this.totals, sourceErrorsSample: Object.fromEntries([...this.sourceErrors.entries()].slice(0, 50)) }, null, 2));
  }
}
