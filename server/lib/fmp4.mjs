// HLS DVR over the fMP4 files MediaMTX records: the same rules as native/src/recorder.cpp (ScanRecordFile, GroupRecordFile,
// BuildRecordFragment), so the relay's dvr.m3u8 means exactly what the app's does.
// MediaMTX 1.21 closes a recorded part (moof+mdat) every recordPartDuration regardless of keyframes, so a part's first
// video sample is normally not a sync sample and whole parts cannot form HLS segments that start with a keyframe. Segments
// are therefore cut at the video sync samples and served as new fragments whose samples are copied byte for byte from the
// recorded parts (no re-encode); the init is the file's own ftyp+moov (a byte range of the file).
import { open } from 'node:fs/promises';

const MAX_META = 8 * 1024 * 1024;  // a moov or moof larger than this is not something MediaMTX writes

async function readAt(fh, offset, size) {
  const b = Buffer.allocUnsafe(size);
  let done = 0;
  while (done < size) {
    const { bytesRead } = await fh.read(b, done, size - done, offset + done);
    if (!bytesRead) return null;
    done += bytesRead;
  }
  return b;
}

// Box header at offset: { type, size, header } or null when it cannot be read yet. size 0 ("to the end of the file") is
// never complete while the file grows; a size smaller than its header marks a broken file (checked by the caller).
async function boxHeader(fh, offset, fileSize) {
  if (offset + 8 > fileSize) return null;
  const h = await readAt(fh, offset, 8);
  if (!h) return null;
  let size = h.readUInt32BE(0), header = 8;
  const type = h.toString('latin1', 4, 8);
  if (size === 1) {
    if (offset + 16 > fileSize) return null;
    const e = await readAt(fh, offset + 8, 8);
    if (!e) return null;
    size = Number(e.readBigUInt64BE(0)); header = 16;
  }
  return { type, size, header };
}

// Calls fn(type, start, end) for each child box inside buf[start, end).
function forEachBox(buf, start, end, fn) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off), header = 8;
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) { if (off + 16 > end) return; size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || size > end - off) return;
    fn(type, off + header, off + size);
    off += size;
  }
}

function parseMoov(f, buf) {
  const tracks = [], defaults = [];
  forEachBox(buf, 0, buf.length, (type, b, e) => {
    if (type === 'trak') {
      const t = { id: 0, timescale: 0, handler: '', trexDuration: 0, trexSize: 0, trexFlags: 0 };
      forEachBox(buf, b, e, (type2, c, ce) => {
        if (type2 === 'tkhd' && ce - c >= 24) t.id = buf[c] === 1 ? buf.readUInt32BE(c + 20) : buf.readUInt32BE(c + 12);
        if (type2 !== 'mdia') return;
        forEachBox(buf, c, ce, (type3, d, de) => {
          if (type3 === 'mdhd' && de - d >= 24) t.timescale = buf[d] === 1 ? buf.readUInt32BE(d + 20) : buf.readUInt32BE(d + 12);
          if (type3 === 'hdlr' && de - d >= 12) t.handler = buf.toString('latin1', d + 8, d + 12);
        });
      });
      if (t.id && t.timescale) tracks.push(t);
    } else if (type === 'mvex') {
      forEachBox(buf, b, e, (type2, c, ce) => {
        if (type2 !== 'trex' || ce - c < 24) return;
        defaults.push({ id: buf.readUInt32BE(c + 4), duration: buf.readUInt32BE(c + 12), size: buf.readUInt32BE(c + 16), flags: buf.readUInt32BE(c + 20) });
      });
    }
  });
  for (const t of tracks) for (const d of defaults) if (d.id === t.id) Object.assign(t, { trexDuration: d.duration, trexSize: d.size, trexFlags: d.flags });
  f.tracks = tracks;
  f.video = tracks.findIndex(t => t.handler === 'vide');
}

const isSync = flags => (flags & 0x00010000) === 0;  // sample_is_non_sync_sample clear

// The samples of every traf of a known track in one moof (payload buf) that starts at file offset moofOffset, or null for a
// truncated or implausible trun. Sample flags: trun first-sample flags > sample flags > tfhd default > trex default.
function parseMoofSamples(f, buf, moofOffset) {
  const out = f.tracks.map(() => []);
  let ok = true, previousEnd = moofOffset;
  forEachBox(buf, 0, buf.length, (type, b, e) => {
    if (type !== 'traf') return;
    let track = -1, base = moofOffset, dts = 0, dataPos = 0, defDuration = 0, defSize = 0, defFlags = 0;
    forEachBox(buf, b, e, (type2, c, ce) => {
      const m = ce - c;
      if (type2 === 'tfhd' && m >= 8) {
        const flags = buf.readUInt32BE(c) & 0xffffff, id = buf.readUInt32BE(c + 4);
        track = f.tracks.findIndex(t => t.id === id);
        if (track < 0) return;
        ({ trexDuration: defDuration, trexSize: defSize, trexFlags: defFlags } = f.tracks[track]);
        let o = 8, haveBase = false;
        if (flags & 0x1) { if (o + 8 <= m) { base = Number(buf.readBigUInt64BE(c + o)); haveBase = true; } o += 8; }
        if (flags & 0x2) o += 4;
        if (flags & 0x8) { if (o + 4 <= m) defDuration = buf.readUInt32BE(c + o); o += 4; }
        if (flags & 0x10) { if (o + 4 <= m) defSize = buf.readUInt32BE(c + o); o += 4; }
        if ((flags & 0x20) && o + 4 <= m) defFlags = buf.readUInt32BE(c + o);
        if (!haveBase) base = (flags & 0x20000) ? moofOffset : previousEnd;  // default-base-is-moof
        dataPos = base;
      } else if (type2 === 'tfdt' && m >= 8) {
        dts = buf[c] === 1 && m >= 12 ? Number(buf.readBigUInt64BE(c + 4)) : buf.readUInt32BE(c + 4);
      } else if (type2 === 'trun' && m >= 8 && track >= 0) {
        const version = buf[c], flags = buf.readUInt32BE(c) & 0xffffff, count = buf.readUInt32BE(c + 4);
        let o = 8;
        if (flags & 0x1) { if (o + 4 > m) { ok = false; return; } dataPos = base + buf.readInt32BE(c + o); o += 4; }
        const firstPresent = (flags & 0x4) !== 0;
        let first = 0;
        if (firstPresent) { if (o + 4 > m) { ok = false; return; } first = buf.readUInt32BE(c + o); o += 4; }
        const entry = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
        if (o > m || count > 1000000 || (entry && Math.floor((m - o) / entry) < count)) { ok = false; return; }
        const samples = out[track];
        for (let i = 0; i < count; i++) {
          let x = c + o + i * entry;
          const s = { dts, offset: dataPos, duration: defDuration, size: defSize, flags: defFlags, cto: 0 };
          if (flags & 0x100) { s.duration = buf.readUInt32BE(x); x += 4; }
          if (flags & 0x200) { s.size = buf.readUInt32BE(x); x += 4; }
          if (flags & 0x400) { s.flags = buf.readUInt32BE(x); x += 4; }
          if (flags & 0x800) { const v = buf.readUInt32BE(x); s.cto = version === 0 ? Math.min(v, 0x7fffffff) : buf.readInt32BE(x); }
          if (i === 0 && firstPresent) s.flags = first;
          dts += s.duration; dataPos += s.size;
          samples.push(s);
        }
      }
    });
    if (track >= 0) previousEnd = dataPos;
  });
  return ok ? out : null;
}

async function readMoofSamples(fh, f, offset, fileSize) {
  const h = await boxHeader(fh, offset, fileSize);
  if (!h || h.type !== 'moof' || h.size < h.header || h.size > MAX_META || offset + h.size > fileSize) return null;
  const buf = await readAt(fh, offset + h.header, h.size - h.header);
  return buf ? parseMoofSamples(f, buf, offset) : null;
}

// One recorded file: the init length, its complete parts, the video keyframe times and the segments cut from them.
export function recordFile(path, startMs) {
  return { path, startMs, size: 0, next: 0, initSize: 0, tracks: [], video: -1, broken: false, complete: false, gone: false, grewAtMs: 0,
    parts: [], keyframes: [], segments: [], nextKeyframe: 0 };
}
export const videoTimescale = f => (f.video >= 0 && f.video < f.tracks.length ? f.tracks[f.video].timescale : 0);
// Bytes of the file a client may read directly: the init and the parts the listed segments are made of.
export function listedBytes(f) {
  const last = f.segments.at(-1);
  if (!last || last.lastPart >= f.parts.length) return f.initSize;
  return f.parts[last.lastPart].offset + f.parts[last.lastPart].size;
}

// Reads the boxes MediaMTX appended to f since the last scan (complete moof+mdat pairs only).
export async function scanRecordFile(f) {
  if (f.broken) return;
  let fh;
  try { fh = await open(f.path, 'r'); } catch { return; }
  try {
    // The open handle reports the real size; directory listings of a file another process writes can lag behind.
    const fileSize = (await fh.stat()).size;
    if (fileSize !== f.size || !f.grewAtMs) f.grewAtMs = Date.now();
    f.size = fileSize;
    let off = f.next;
    for (;;) {
      const h = await boxHeader(fh, off, fileSize);
      if (!h) return;
      if (h.size < h.header) { if (h.size !== 0) f.broken = true; return; }  // a size smaller than its header: not MP4
      let size = h.size;
      if (h.type === 'moov') {
        if (size > MAX_META) { f.broken = true; return; }
        if (off + size > fileSize) return;
        const buf = await readAt(fh, off + h.header, size - h.header);
        if (!buf) return;
        parseMoov(f, buf);
        if (f.video < 0) { f.broken = true; return; }  // the recording always carries video; without it nothing is listed
      } else if (h.type === 'moof') {
        if (f.video < 0 || size > MAX_META) { f.broken = true; return; }
        if (off + size > fileSize) return;
        const mdat = await boxHeader(fh, off + size, fileSize);
        if (!mdat) return;
        if (mdat.type !== 'mdat' || mdat.size < mdat.header) { f.broken = true; return; }
        if (off + size + mdat.size > fileSize) return;  // the part is still being written
        const samples = await readMoofSamples(fh, f, off, fileSize);
        if (!samples) { f.broken = true; return; }
        if (!f.initSize) f.initSize = off;
        const prevEnd = f.parts.length ? f.parts.at(-1).videoEnd : 0;
        const part = { offset: off, size: size + mdat.size, videoStart: prevEnd, videoEnd: prevEnd };
        const video = samples[f.video];
        if (video.length) {
          part.videoStart = video[0].dts;
          part.videoEnd = video.at(-1).dts + video.at(-1).duration;
          for (const s of video) if (isSync(s.flags) && (!f.keyframes.length || s.dts > f.keyframes.at(-1))) f.keyframes.push(s.dts);
        }
        f.parts.push(part);
        size += mdat.size;
      } else if (off + size > fileSize) {
        return;
      }
      off += size;
      f.next = off;
    }
  } catch {
    // A read that fails now (file being replaced or removed) is retried on the next scan.
  } finally { await fh.close().catch(() => {}); }
}

// Cuts new segments of about targetSeconds at video keyframes. A segment is listed once the keyframe that ends it and one
// more second of media are on disk (so every track's samples of its span are complete), or when the file is final.
// Once listed a segment never changes (EVENT playlist).
export function groupRecordFile(f, final, targetSeconds) {
  const ts = videoTimescale(f);
  if (!ts || !f.initSize || !f.parts.length || f.broken) return;
  const target = Math.floor(targetSeconds * ts), margin = ts;  // 1 s
  const videoEnd = f.parts.at(-1).videoEnd, n = f.parts.length;
  for (;;) {
    // A segment starts at the first keyframe at or after the end of the previous one.
    const from = f.segments.length ? f.segments.at(-1).end : 0;
    while (f.nextKeyframe < f.keyframes.length && f.keyframes[f.nextKeyframe] < from) f.nextKeyframe++;
    if (f.nextKeyframe >= f.keyframes.length) return;
    const s = { start: f.keyframes[f.nextKeyframe], end: 0, firstPart: 0, lastPart: 0, openStart: !f.segments.length, openEnd: false };
    let k = f.nextKeyframe + 1;
    // 0.1 s of tolerance: keyframes one GOP apart carry timestamp jitter, and 3.997 s should not make a 5 s segment.
    while (k < f.keyframes.length && f.keyframes[k] - s.start + Math.floor(ts / 10) < target) k++;
    if (k < f.keyframes.length && (final || videoEnd >= f.keyframes[k] + margin)) s.end = f.keyframes[k];
    else if (final && videoEnd > s.start) { s.end = videoEnd; s.openEnd = true; }
    else return;  // the open end of a growing file
    // The parts whose video overlaps the span, one second wider for the other tracks (their part boundaries differ).
    if (!s.openStart) while (s.firstPart + 1 < n && f.parts[s.firstPart].videoEnd + margin <= s.start) s.firstPart++;
    s.lastPart = n - 1;
    if (!s.openEnd) while (s.lastPart > s.firstPart && f.parts[s.lastPart].videoStart >= s.end + margin) s.lastPart--;
    f.segments.push(s);
    f.nextKeyframe = k;
  }
}

// One segment of f built from the file on disk: { moof (moof box + mdat header), runs [[offset, length]], payload } or null.
// moof: mfhd, then per track with samples traf { tfhd (default-base-is-moof), tfdt v1, trun v1 with data offset, duration,
// size, flags and composition offset for every sample }; mdat: the tracks' sample bytes in the same order.
export async function buildRecordFragment(f, segment, sequence) {
  const vts = videoTimescale(f);
  if (!vts || segment.lastPart >= f.parts.length || segment.firstPart > segment.lastPart) return null;
  let fh;
  try { fh = await open(f.path, 'r'); } catch { return null; }
  try {
    const fileSize = (await fh.stat()).size;
    // Every track's samples of [start, end): video by its own decode time, the others by the same instant in their
    // timescale. Consecutive segments share their boundaries, so each sample belongs to exactly one segment.
    const picked = f.tracks.map(() => []);
    for (let p = segment.firstPart; p <= segment.lastPart; p++) {
      const samples = await readMoofSamples(fh, f, f.parts[p].offset, fileSize);
      if (!samples) return null;
      f.tracks.forEach((t, i) => {
        for (const s of samples[i]) {
          const afterStart = i === f.video ? s.dts >= segment.start : segment.openStart || s.dts * vts >= segment.start * t.timescale;
          const beforeEnd = segment.openEnd || (i === f.video ? s.dts < segment.end : s.dts * vts < segment.end * t.timescale);
          if (afterStart && beforeEnd) picked[i].push(s);
        }
      });
    }
    if (!picked[f.video].length || !isSync(picked[f.video][0].flags)) return null;
    let moofSize = 8 + 16;
    for (const v of picked) if (v.length) moofSize += 8 + 16 + 20 + 20 + 16 * v.length;
    const m = Buffer.alloc(moofSize + 8);
    let o = 0;
    const u32 = v => { m.writeUInt32BE(v >>> 0, o); o += 4; }, tag = s => { m.write(s, o, 'latin1'); o += 4; };
    u32(moofSize); tag('moof'); u32(16); tag('mfhd'); u32(0); u32(sequence);
    const runs = [];
    let dataOffset = moofSize + 8, payload = 0;
    picked.forEach((v, i) => {
      if (!v.length) return;
      u32(8 + 16 + 20 + 20 + 16 * v.length); tag('traf');
      u32(16); tag('tfhd'); u32(0x020000); u32(f.tracks[i].id);
      u32(20); tag('tfdt'); u32(0x01000000); m.writeBigUInt64BE(BigInt(v[0].dts), o); o += 8;
      u32(20 + 16 * v.length); tag('trun'); u32(0x01000f01); u32(v.length); u32(dataOffset);
      for (const s of v) {
        u32(s.duration); u32(s.size); u32(s.flags); m.writeInt32BE(s.cto, o); o += 4;
        const last = runs.at(-1);
        if (last && last[0] + last[1] === s.offset) last[1] += s.size; else runs.push([s.offset, s.size]);
        payload += s.size; dataOffset += s.size;
        if (s.offset + s.size > fileSize) dataOffset = Infinity;
      }
    });
    if (!Number.isFinite(dataOffset) || payload + 8 > 0xffffffff || dataOffset > 0xffffffff) return null;
    m.writeUInt32BE(payload + 8, o); o += 4; m.write('mdat', o, 'latin1');
    return { moof: m, runs, payload };
  } catch { return null; }
  finally { await fh.close().catch(() => {}); }
}
