// DVR load: viewers that read the broadcast's time index (/<path>/dvr) and fetch bounded fMP4 chunks
// (/<path>/dvr/media?id=&start=&duration=) at random past positions, as the viewer's DVR player does while seeking.
// A chunk counts as OK only when it arrives complete (status 200, body read to the end, non-empty).
import { percentile, round } from './common.mjs';

export class DvrPool {
  constructor(o) {
    this.o = o;  // { base, path, chunkMs, intervalMs, liveMarginMs }
    this.viewers = new Map();
    this.reset();
  }

  reset() { this.w = { index: 0, indexErr: 0, chunks: 0, ok: 0, noData: 0, errors: 0, errorKinds: {}, bytes: 0, ttfbMs: [], totalMs: [], noRanges: 0 }; }

  add(viewer) {
    if (this.viewers.has(viewer)) return;
    const v = { viewer, active: true };
    this.viewers.set(viewer, v);
    const loop = async () => {
      await new Promise(r => setTimeout(r, Math.random() * (this.o.intervalMs || 4000)));
      while (v.active) {
        const t0 = Date.now();
        await this.once().catch(() => {});
        await new Promise(r => setTimeout(r, Math.max(100, (this.o.intervalMs || 4000) - (Date.now() - t0))));
      }
    };
    loop();
  }

  remove(viewer) { const v = this.viewers.get(viewer); if (v) { v.active = false; this.viewers.delete(viewer); } }
  removeAll() { for (const v of [...this.viewers.keys()]) this.remove(v); }

  error(kind) { this.w.errors++; this.w.errorKinds[kind] = (this.w.errorKinds[kind] || 0) + 1; }

  async once() {
    const { base, path } = this.o, chunk = this.o.chunkMs || 4000;
    let index;
    try {
      const r = await fetch(`${base}/${path}/dvr`, { signal: AbortSignal.timeout(10000) });
      this.w.index++;
      if (!r.ok) { this.w.indexErr++; return this.error(`index-${r.status}`); }
      index = await r.json();
    } catch (e) { this.w.indexErr++; return this.error(`index-${e.name}`); }
    const ranges = (index.ranges || []).map(x => ({ s: x.startMs, e: x.endMs - (this.o.liveMarginMs ?? 5000) - chunk })).filter(x => x.e > x.s);
    if (!index.dvr || !ranges.length) { this.w.noRanges++; return; }
    const total = ranges.reduce((a, x) => a + x.e - x.s, 0);
    let pick = Math.random() * total, start = ranges[0].s;
    for (const x of ranges) { if (pick <= x.e - x.s) { start = x.s + pick; break; } pick -= x.e - x.s; }
    const t0 = Date.now();
    this.w.chunks++;
    try {
      const r = await fetch(`${base}/${path}/dvr/media?id=${index.id}&start=${Math.round(start)}&duration=${chunk}`, { signal: AbortSignal.timeout(30000) });
      const ttfb = Date.now() - t0;
      if (r.status === 404) { this.w.noData++; await r.arrayBuffer().catch(() => {}); return; }
      if (r.status !== 200) { await r.arrayBuffer().catch(() => {}); return this.error(`media-${r.status}`); }
      const body = await r.arrayBuffer();
      if (!body.byteLength) return this.error('media-empty');
      this.w.ok++;
      this.w.bytes += body.byteLength;
      this.w.ttfbMs.push(ttfb);
      this.w.totalMs.push(Date.now() - t0);
    } catch (e) { this.error(`media-${e.name === 'TypeError' ? 'aborted' : e.name}`); }
  }

  summary() {
    const w = this.w;
    return { viewers: this.viewers.size, indexRequests: w.index, indexErrors: w.indexErr, chunks: w.chunks, ok: w.ok, noData: w.noData, errors: w.errors, errorKinds: w.errorKinds,
      errorRate: w.chunks + w.index ? round((w.errors) / (w.chunks + w.index), 4) : null, mb: round(w.bytes / 2 ** 20, 1), noRanges: w.noRanges,
      ttfbMs: { p50: percentile(w.ttfbMs, 0.5), p95: percentile(w.ttfbMs, 0.95) }, chunkMs: { p50: percentile(w.totalMs, 0.5), p95: percentile(w.totalMs, 0.95) } };
  }
}
