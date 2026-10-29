// DVR on the relay: same JSON and rules as native/src/streamer.cpp DvrIndex/DvrMediaTarget, backed by the relay MediaMTX
// recording (one folder per path, fMP4, 1 s parts) and its loopback playback server.
// Unlike the sender PC, one relay path is reused by successive broadcasts, so everything before the current broadcast's
// first publish on this relay (entry.dvrFromMs, relay clock) is hidden from both the index and the chunk requests.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { upstream, readBody } from './mediamtx.mjs';

const SLACK_MS = 2000;  // a segment opens on the first keyframe after the publisher became ready

// 2026-10-28_11-27-35-354294+0900.mp4 (recordPath ...%Y-%m-%d_%H-%M-%S-%f%z) -> epoch ms
export function segmentStart(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})(Z|[+-]\d{4})?\.mp4$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, us, zone] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) + Number(us) / 1000;
  if (zone && zone !== 'Z') ms -= (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60000;
  else if (!zone) ms += new Date(ms).getTimezoneOffset() * 60000;  // local time without an offset
  return ms;
}

export class Dvr {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.cache = new Map(); }

  async segments(path) {
    if (!this.cfg.recordDir) return null;
    try { return (await readdir(join(this.cfg.recordDir, path))).map(segmentStart).filter(v => v !== null).sort((a, b) => a - b); }
    catch { return []; }
  }

  // entry: the registry entry currently on `path` (or null).
  // live: receiving media, or within the media grace period (the recording made so far stays available).
  async index(path, entry, live) {
    if (!entry || !live) return { running: false, path };
    if (!this.cfg.dvr) return { running: true, id: entry.id, dvr: false };
    // Not yet seen receiving on this relay: nothing of this broadcast is recorded (older files on the path are earlier broadcasts).
    if (!entry.dvrFromMs) return { running: true, id: entry.id, dvr: true, recording: false, ranges: [], segments: [], gopMs: 1000, nowMs: Date.now() };
    const cached = this.cache.get(path);
    if (cached && cached.id === entry.id && Date.now() - cached.at < 1000) return cached.value;
    const from = entry.dvrFromMs - SLACK_MS;
    let list = [];
    try {
      const res = await upstream(this.cfg.mediamtx.playback, 'GET', '/list?path=' + encodeURIComponent(path), { timeoutMs: 3000 });
      const body = await readBody(res);
      if (res.statusCode === 200) list = JSON.parse(body.toString('utf8'));
      else if (res.statusCode !== 400 && res.statusCode !== 404) this.log('warn', `playback list ${path} -> ${res.statusCode}`);  // 400/404: nothing written yet
    } catch (error) { this.log('warn', 'playback list failed: ' + error.message); }
    const disk = await this.segments(path);
    const segments = (disk || []).filter(t => t >= from);
    const ranges = [];
    for (const e of Array.isArray(list) ? list : []) {
      let start = Date.parse(e?.start || ''); const duration = Number(e?.duration) || 0;
      if (!Number.isFinite(start) || duration <= 0) continue;
      const end = start + duration * 1000;
      if (end <= from) continue;  // an earlier broadcast on this path
      if (start < from) start = segments.find(t => t >= from) ?? entry.dvrFromMs;  // merged with an earlier broadcast's tail
      if (end > start) ranges.push({ startMs: start, endMs: end });
    }
    const value = { running: true, id: entry.id, dvr: true, recording: true, ranges, segments: disk ? segments : ranges.map(r => r.startMs), gopMs: 1000, nowMs: Date.now() };
    this.cache.set(path, { id: entry.id, at: Date.now(), value });
    return value;
  }

  // [status, error] when refused, else [0, target] for the playback server.
  target(path, entry, live, id, startMs, durationMs) {
    if (!entry || !live) return [404, 'not-running'];
    if (id !== entry.id) return [409, 'broadcast-changed'];  // a new broadcast on the same path: reload the index
    if (!this.cfg.dvr) return [404, 'no-dvr'];
    const now = Date.now();
    // One bounded chunk per request, never a whole broadcast, and never before this broadcast began on the relay.
    if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs < 200 || durationMs > 30000 || startMs < now - 8 * 86400000 || startMs > now + 10000) return [400, 'bad-range'];
    if (!entry.dvrFromMs || startMs < entry.dvrFromMs - SLACK_MS) return [404, 'no-data'];
    const start = new Date(startMs).toISOString();
    return [0, `/get?path=${encodeURIComponent(path)}&start=${encodeURIComponent(start)}&duration=${(durationMs / 1000).toFixed(3)}&format=fmp4`];
  }
}
