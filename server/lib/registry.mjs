// Public broadcast list. A Windows sender announces itself every ~2 s with a publisher token (not by source address, which
// is meaningless across NAT); an entry lives RELAY_ANNOUNCE_TTL_MS after its last announcement and ends at once on "bye".
// Each token may only use the paths assigned to it (relay.env), and which token announced an id is remembered, so one
// publisher cannot withdraw, re-thumbnail or take over another's broadcast or path - not even while the owner reconnects.
import { createHash, timingSafeEqual } from 'node:crypto';
import { validPath } from './config.mjs';

const ID = /^[0-9a-f]{32}$/;
const AUDIO = new Set(['none', 'system', 'mic', 'mix']);
const QUALITY = /^(240|360|480|720|1080|1440)p$/;
const CODEC = /^(H\.264|H\.265|AV1|VP9)$/;

// Index of the matching token, or -1. Every stored digest is compared so the time taken does not depend on which matched.
export function tokenIndex(tokens, header) {
  const m = /^Bearer ([^\s]{1,512})$/.exec(String(header || ''));
  if (!m) return -1;
  const digest = createHash('sha256').update(m[1]).digest();
  let found = -1;
  tokens.forEach((t, i) => { if (timingSafeEqual(t, digest) && found < 0) found = i; });
  return found;
}

const bytes = s => Buffer.byteLength(s, 'utf8');
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

// One announced lower quality the sender itself encodes: {name,width,height,mbps,fps,codec} (contract v1). Plain "720p"
// strings (older senders) are accepted with only the name known.
function parseRendition(r) {
  if (typeof r === 'string') return QUALITY.test(r) ? { name: r, height: Number.parseInt(r, 10) } : null;
  if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !QUALITY.test(r.name)) return null;
  const out = { name: r.name, height: Number.parseInt(r.name, 10) };
  if (Number.isInteger(r.height) && r.height > 0 && r.height <= 8192) out.height = r.height;
  if (Number.isInteger(r.width) && r.width > 0 && r.width <= 8192) out.width = r.width;
  if (num(r.mbps, 0.05, 200)) out.mbps = r.mbps;
  if (num(r.fps, 1, 240)) out.fps = r.fps;
  if (typeof r.codec === 'string' && CODEC.test(r.codec)) out.codec = r.codec;
  return out;
}

// Fields of native/src/directory.cpp BroadcastItem plus the relay extras of the v1 contract (bitrate, audio, renditions,
// sentAtMs). host/port are ignored: on the relay, viewers use the relay's own public address. The core fields must be
// valid; an invalid extra is dropped (named in `ignored`) instead of refusing the whole announcement, so a newer sender
// still gets listed.
export function parseItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'unsupported message' };
  const s = (k) => (typeof item[k] === 'string' ? item[k] : '');
  const out = { id: s('id'), title: s('title'), publisher: s('publisher'), path: s('path') }, ignored = [];
  if (!ID.test(out.id) || !validPath(out.path)) return { error: 'invalid broadcast' };
  if (!out.title || bytes(out.title) > 200 || bytes(out.publisher) > 100) return { error: 'invalid title' };
  for (const k of ['width', 'height']) { const v = item[k] ?? 0; if (!Number.isInteger(v) || v < 0 || v > 8192) return { error: 'invalid format' }; out[k] = v; }
  const fps = item.fps ?? 0;
  if (!num(fps, 0, 240)) return { error: 'invalid format' };
  out.fps = fps;
  const started = item.startedAtMs ?? 0;
  if (!Number.isSafeInteger(started) || started < 0) return { error: 'invalid format' };
  out.startedAtMs = started;
  if (item.bitrate !== undefined) { if (num(item.bitrate, 0.1, 200)) out.bitrate = item.bitrate; else ignored.push('bitrate'); }
  if (item.audio !== undefined) { if (AUDIO.has(item.audio)) out.audio = item.audio; else ignored.push('audio'); }
  if (item.renditions !== undefined) {
    const list = Array.isArray(item.renditions) && item.renditions.length <= 6 ? item.renditions.map(parseRendition) : null;
    if (list && list.every(Boolean)) out.renditions = [...new Map(list.map(r => [r.name, r])).values()];
    else ignored.push('renditions');
  }
  if (item.sentAtMs !== undefined) { if (Number.isSafeInteger(item.sentAtMs) && item.sentAtMs > 0) out.sentAtMs = item.sentAtMs; else ignored.push('sentAtMs'); }
  return { item: out, ignored };
}

export class Registry {
  // allowed(token, path): may this token use this path. holdMs: after an entry expires (no "bye"), its path stays
  // reserved for the same token this long, so a reconnecting sender gets its path back.
  constructor({ ttlMs, maxEntries, allowed = () => true, holdMs = 0, onStart, onEnd }) {
    this.ttlMs = ttlMs; this.max = maxEntries; this.allowed = allowed; this.holdMs = holdMs; this.onStart = onStart; this.onEnd = onEnd;
    this.entries = new Map();  // id -> entry
    this.holds = new Map();    // path -> { token, until }
    this.ended = new Map();    // path -> time the last broadcast on it ended (playback reports may still arrive)
    this.sweeper = setInterval(() => this.sweep(), 1000);
    this.sweeper.unref();
  }
  byPath(path) { for (const e of this.entries.values()) if (e.path === path) return e; return null; }
  get(id) { return this.entries.get(id) || null; }
  all() { return [...this.entries.values()].sort((a, b) => b.startedAtMs - a.startedAtMs); }
  // A path with a broadcast now or within the last 5 minutes.
  known(path) { return !!this.byPath(path) || Date.now() - (this.ended.get(path) || 0) < 300000; }

  // Returns [status, reason, ignored]. 204 accepted, 400 invalid, 403 not this publisher's broadcast or path,
  // 409 path taken, 503 full.
  announce(message, token) {
    if (!message || typeof message !== 'object' || message.v !== 1) return [400, 'unsupported message'];
    if (message.type === 'bye') {
      const e = this.entries.get(typeof message.id === 'string' ? message.id : '');
      if (!e) return [204, ''];
      if (e.token !== token) return [403, 'not your broadcast'];
      this.remove(e, '송출이 종료되었습니다.');
      this.holds.delete(e.path);
      return [204, ''];
    }
    if (message.type !== 'announce') return [400, 'unsupported message'];
    const { item, error, ignored } = parseItem(message.item);
    if (!item) return [400, error];
    if (!this.allowed(token, item.path)) return [403, 'path not assigned to this publisher token'];
    const now = Date.now();
    const existing = this.entries.get(item.id);
    if (existing) {
      if (existing.token !== token) return [403, 'not your broadcast'];
      if (existing.path !== item.path) return [409, 'broadcast id already uses another path'];
      Object.assign(existing, { title: item.title, publisher: item.publisher, width: item.width, height: item.height, fps: item.fps });
      for (const k of ['bitrate', 'audio', 'renditions']) if (item[k] !== undefined) existing[k] = item[k];
      existing.expiresAt = now + this.ttlMs; existing.lastAnnounceMs = now;
      return [204, '', ignored];
    }
    const other = this.byPath(item.path);
    if (other) {
      if (other.token !== token) return [409, 'path is used by another broadcast'];
      this.remove(other, '새 송출이 시작되었습니다.');  // the same publisher restarted on the same path
    }
    const hold = this.holds.get(item.path);
    if (hold && hold.until > now && hold.token !== token) return [409, 'path is reserved for its broadcaster (reconnecting)'];
    this.holds.delete(item.path);
    if (this.entries.size >= this.max) return [503, 'directory full'];
    // The sender's clock may differ from the relay's: with sentAtMs (sender clock when sent) the offset is measured once,
    // so startedAtMs, elapsed time and the DVR window use the relay clock and never jump between announcements.
    const skew = item.sentAtMs ? now - item.sentAtMs : 0;
    const startedAtRelayMs = Math.min(now, Math.max(now - 7 * 86400000, (item.startedAtMs || now) + skew));
    const entry = { ...item, token, firstSeenMs: now, lastAnnounceMs: now, lastReadyMs: 0, startedAtRelayMs, clockSkewMs: skew, expiresAt: now + this.ttlMs,
      thumbnail: null, thumbnailAt: 0, dvrFromMs: 0 };
    delete entry.sentAtMs;
    this.entries.set(item.id, entry);
    this.onStart?.(entry);
    return [204, '', ignored];
  }
  setThumbnail(id, token, jpeg) {
    const e = this.entries.get(id);
    if (!e) return 404;
    if (e.token !== token) return 403;
    e.thumbnail = jpeg; e.thumbnailAt = Date.now();
    return 204;
  }
  remove(entry, reason) {
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id);
    this.ended.set(entry.path, Date.now());
    this.onEnd?.(entry, reason);
  }
  sweep() {
    const now = Date.now();
    for (const e of [...this.entries.values()]) {
      if (e.expiresAt > now) continue;
      this.remove(e, '송출이 종료되었습니다. 송출 PC의 연결이 끊어졌습니다.');
      if (this.holdMs) this.holds.set(e.path, { token: e.token, until: now + this.holdMs });
    }
    for (const [path, h] of this.holds) if (h.until <= now) this.holds.delete(path);
    for (const [path, t] of this.ended) if (now - t > 300000) this.ended.delete(path);
  }
}
