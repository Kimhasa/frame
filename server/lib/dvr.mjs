// DVR on the relay: same JSON, rules and HLS playlist as native/src/streamer.cpp (DvrIndex, DvrMediaTarget, DvrPlaylist,
// DvrFile), backed by the relay MediaMTX recording of the copy path "<path>/rec" (video + AAC, fMP4, 1 s parts; written by
// the runOnAvailable FFmpeg of mediamtx-relay.yml, no second encode) and its loopback playback server.
// Unlike the sender PC, one relay path is reused by successive broadcasts, so everything before the current broadcast's
// start on this relay (entry.dvrFromMs, relay clock: its first media here, never later than its announced start, so a
// relay restart after a sender reconnect does not move it) is hidden from the index, the chunk requests and dvr.m3u8.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { upstream, readBody } from './mediamtx.mjs';
import { recordFile, scanRecordFile, groupRecordFile, videoTimescale } from './fmp4.mjs';

const SLACK_MS = 2000;  // a segment opens on the first keyframe after the publisher became ready
// HLS DVR media segments: cut at video keyframes, about this long (the app's kDvrSegmentSeconds).
const SEGMENT_S = 4;
// The MediaMTX path that records a broadcast path.
export const recordPath = path => path + '/rec';

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
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.cache = new Map(); this.hls = new Map(); }

  dir(path) { return join(this.cfg.recordDir, path, 'rec'); }

  async segments(path) {
    if (!this.cfg.recordDir) return null;
    try { return (await readdir(this.dir(path))).map(segmentStart).filter(v => v !== null).sort((a, b) => a - b); }
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
      const res = await upstream(this.cfg.mediamtx.playback, 'GET', '/list?path=' + encodeURIComponent(recordPath(path)), { timeoutMs: 3000 });
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
    return [0, `/get?path=${encodeURIComponent(recordPath(path))}&start=${encodeURIComponent(start)}&duration=${(durationMs / 1000).toFixed(3)}&format=fmp4`];
  }

  // ---- HLS DVR (dvr.m3u8 and dvr/file) --------------------------------------------------------------------------
  hlsAvailable() { return this.cfg.dvr && !!this.cfg.recordDir; }

  // State of the current broadcast on `path`: its recorded files in order (a file removed by the retention stays as
  // `gone`), each scanned and cut into segments, and the playlist text. Refreshed at most once a second. A file is named
  // in URLs by its id, its recording start in whole ms (from its name), which stays the same for the file's life
  // whatever the relay restarts or the retention removes before it.
  async hlsState(path, entry, force = false) {
    let st = this.hls.get(path);
    if (!st || st.id !== entry.id) { st = { id: entry.id, files: [], at: 0, body: '', pending: null }; this.hls.set(path, st); }
    if (!force && st.at && Date.now() - st.at < 1000) return st;
    if (!st.pending) st.pending = this.refreshHls(path, entry, st).finally(() => { st.pending = null; });
    await st.pending;
    return st;
  }

  async refreshHls(path, entry, st) {
    const from = entry.dvrFromMs ? entry.dvrFromMs - SLACK_MS : Infinity, dir = this.dir(path);
    let names = [];
    try { names = await readdir(dir); } catch {}
    const onDisk = new Map();
    for (const name of names) { const t = segmentStart(name); if (t !== null && t >= from) onDisk.set(name, t); }
    // Never claim what is not on disk any more: a file the retention removed is not listed again.
    for (const f of st.files) if (!onDisk.has(f.name)) f.gone = true;
    const known = new Set(st.files.map(f => f.name)), lastStart = st.files.length ? st.files.at(-1).startMs : -Infinity;
    for (const [name, t] of [...onDisk].filter(([n]) => !known.has(n)).sort((a, b) => a[1] - b[1]))
      if (t > lastStart) st.files.push(Object.assign(recordFile(join(dir, name), t), { name, fileId: Math.floor(t) }));
    const now = Date.now();
    for (let i = 0; i < st.files.length; i++) {
      const f = st.files[i];
      if (f.complete || f.gone) continue;
      await scanRecordFile(f);
      // MediaMTX writes one file at a time: every file but the newest is finished. The newest is final once it has not
      // grown for 5 s (the sender away); until then its open last group is not listed.
      const newer = i + 1 < st.files.length;
      groupRecordFile(f, newer || now - f.grewAtMs >= 5000, SEGMENT_S);
      if (newer || f.broken) f.complete = true;
    }
    st.body = playlistText(st);
    st.at = Date.now();
  }

  // [status, error] or [0, file] for /<path>/dvr/file?id=&f=<file id>.
  async hlsFile(path, entry, live, id, fileId) {
    if (!entry || !live) return [404, 'not-running'];
    if (id !== entry.id) return [409, 'broadcast-changed'];  // a new broadcast on the same path: reload the playlist
    if (!this.hlsAvailable()) return [404, 'no-dvr'];
    let st = this.hls.get(path);
    // Not known: rescan, unless the id is older than the newest known file (only newer files are ever added).
    const known = st?.id === id && (st.files.some(x => x.fileId === fileId) || fileId < st.files.at(-1)?.fileId);
    if (!known) st = await this.hlsState(path, entry, true);
    const f = st.files.find(x => x.fileId === fileId);
    if (!f || f.gone || !f.segments.length) return [404, 'no-data'];
    return [0, f];
  }
}

// EVENT playlist (segments only appended). Each recorded file has its own init (EXT-X-MAP: its ftyp+moov as a byte range)
// and its own timeline, so a discontinuity separates files (and with them every gap where the sender was away). Decode
// time 0 is the file's first sample, the time in its name. When the retention removed the oldest files the playlist is
// no longer an EVENT one: it continues with MEDIA-SEQUENCE / DISCONTINUITY-SEQUENCE counting what was removed.
function playlistText(st) {
  const lines = [];
  let target = 1, removedSegments = 0, removedTags = 0, leading = true, first = true;
  st.files.forEach(f => {
    const ts = videoTimescale(f);
    if (!f.segments.length || ts <= 0) return;
    for (const seg of f.segments) target = Math.max(target, Math.round((seg.end - seg.start) / ts));
    if (f.gone) { if (leading) { removedSegments += f.segments.length; removedTags++; } return; }
    leading = false;
    // ".mp4" in the path: players that check segment extensions (FFmpeg's HLS demuxer) accept it; dvr/file is the same.
    const uri = `dvr/file.mp4?id=${st.id}&f=${f.fileId}`;
    if (!first) lines.push('#EXT-X-DISCONTINUITY');
    first = false;
    lines.push(`#EXT-X-MAP:URI="${uri}",BYTERANGE="${f.initSize}@0"`);
    f.segments.forEach((seg, s) => {
      const seconds = (seg.end - seg.start) / ts;  // the video samples' durations
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(f.startMs + seg.start * 1000 / ts).toISOString()}`, `#EXTINF:${seconds.toFixed(5)},`, `${uri}&s=${s}`);
    });
  });
  return ['#EXTM3U', '#EXT-X-VERSION:7', ...(removedSegments ? [] : ['#EXT-X-PLAYLIST-TYPE:EVENT']), `#EXT-X-TARGETDURATION:${Math.max(target, Math.ceil(SEGMENT_S))}`,
    `#EXT-X-MEDIA-SEQUENCE:${removedSegments}`, ...(removedTags ? [`#EXT-X-DISCONTINUITY-SEQUENCE:${removedTags}`] : []),
    '#EXT-X-INDEPENDENT-SEGMENTS', ...lines, ''].join('\n');
}
