// LL-HLS for browser viewers, the same contract as the app's viewer server (native/src/http_server.cpp, streamer.cpp):
//   - the multivariant live.m3u8 the relay writes itself (video + the AAC track of each quality),
//   - one MediaMTX HLS session per path and quality shared by every viewer (MediaMTX 1.21 serves media playlists and parts
//     only inside a session its index.m3u8 created), its session ids removed from the playlists, so every viewer gets the
//     same bytes and no MediaMTX cookie or cookie check ever reaches a browser or a CDN,
//   - identical playlist requests (the same blocking _HLS_msn/_HLS_part) collapsed into one upstream request,
//   - viewer sessions for counting and the viewer cap, independent of media requests.
import { randomBytes } from 'node:crypto';
import { upstream, readBody, hlsAgent } from './mediamtx.mjs';

// H.264 level_idc for a High-profile stream of this size, rate and bitrate (ITU-T H.264 Table A-1, MaxBR x1.25 for High).
const LEVELS = [[10, 1485, 99, 64], [11, 3000, 396, 192], [12, 6000, 396, 384], [13, 11880, 396, 768], [20, 11880, 396, 2000], [21, 19800, 792, 4000],
  [22, 20250, 1620, 4000], [30, 40500, 1620, 10000], [31, 108000, 3600, 14000], [32, 216000, 5120, 20000], [40, 245760, 8192, 20000], [41, 245760, 8192, 50000],
  [42, 522240, 8704, 50000], [50, 589824, 22080, 135000], [51, 983040, 36864, 240000], [52, 2073600, 36864, 240000], [60, 4177920, 139264, 240000],
  [61, 8355840, 139264, 480000], [62, 16711680, 139264, 800000]];
export function avcLevelIdc(width, height, fps, mbps) {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16);
  for (const [idc, maxMbps, maxFs, maxKbps] of LEVELS) if (fs <= maxFs && fs * (fps || 30) <= maxMbps && mbps * 1000 <= maxKbps * 1.25) return idc;
  return 62;
}
const PROFILES = { Baseline: 66, 'Constrained Baseline': 66, Main: 77, Extended: 88, High: 100, 'High 10': 110, 'High 4:2:2': 122, 'High 4:4:4': 244 };
const hex2 = n => n.toString(16).padStart(2, '0');
// "avc1.PPCCLL" from MediaMTX's codecProps of an H264 track ({profile:"High", level:"4.2"}), or ''.
export function avcCodec(props) {
  const p = PROFILES[props?.profile], l = Number.parseFloat(props?.level || '');
  if (!p || !(l > 0)) return '';
  return `avc1.${hex2(p)}${hex2(props.profile === 'Constrained Baseline' ? 0x40 : 0)}${hex2(Math.round(l * 10))}`;
}

// MediaMTX writes its session id (and the request's query) into every URI of the playlists it serves: removed, so players
// get the same playlist whatever session served it and request plain file names.
export function stripPlaylistQueries(body) {
  return body.split('\n').map(raw => {
    const cr = raw.endsWith('\r'), line = cr ? raw.slice(0, -1) : raw;
    const out = line.startsWith('#') ? line.replace(/URI="([^"?]*)\?[^"]*"/g, 'URI="$1"') : line.split('?')[0];
    return cr ? out + '\r' : out;
  }).join('\n');
}

// The LL-HLS query keys a player may send; everything else is dropped (and a CDN keys playlists by exactly these).
export function hlsParams(searchParams) {
  let out = '';
  for (const name of ['_HLS_msn', '_HLS_part', '_HLS_skip']) {
    const v = searchParams.get(name);
    if (v && v.length < 16 && /^[0-9YESvy]+$/.test(v)) out += `&${name}=${v}`;
  }
  return out;
}

// Upstream MediaMTX HLS with shared sessions and collapsed playlist requests.
export class UpstreamHls {
  constructor(base, log) {
    this.base = base; this.log = log;
    this.sessions = new Map(); this.making = new Map(); this.flights = new Map();
    setInterval(() => { const old = Date.now() - 5000; for (const [k, f] of this.flights) if (f.doneAt && f.doneAt < old) this.flights.delete(k); }, 5000).unref();
  }
  // The shared session of a MediaMTX path ("screen-01", "screen-01/480p"): made once by its index.m3u8 (for an on-demand
  // quality this first waits for its encoder); `stale` is a session MediaMTX refused, so a new one is made.
  // Returns { id } or { status } (the upstream status when no session could be made, 0 when unreachable).
  async session(mtxPath, stale = '') {
    const id = this.sessions.get(mtxPath);
    if (id && id !== stale) return { id };
    let job = this.making.get(mtxPath);
    if (!job) {
      job = (async () => {
        try {
          const res = await upstream(this.base, 'GET', `/${mtxPath}/index.m3u8?cookieCheck=1`, { timeoutMs: 30000, agent: hlsAgent });
          const body = (await readBody(res, 1 << 20)).toString('utf8');
          if (res.statusCode !== 200) { if (res.statusCode !== 404) this.log('warn', `HLS session for ${mtxPath} -> ${res.statusCode}`, 'hls-session ' + res.statusCode); return { status: res.statusCode }; }
          const sid = /[?&]session=([0-9a-fA-F-]{1,64})/.exec(body)?.[1];
          if (!sid) { this.log('warn', `HLS session for ${mtxPath}: no session in index.m3u8`, 'hls-session-none'); return { status: 502 }; }
          this.sessions.set(mtxPath, sid);
          if (this.sessions.size > 4096) this.sessions.clear();
          return { id: sid };
        } catch (error) { this.log('warn', `HLS session for ${mtxPath} failed: ${error.message}`, 'hls-session-err'); return { status: 0 }; }
        finally { this.making.delete(mtxPath); }
      })();
      this.making.set(mtxPath, job);
    }
    return job;
  }
  target(mtxPath, file, sid, params) { return `/${mtxPath}/${file}?cookieCheck=1&session=${sid}${params}`; }
  // A path whose publisher restarted (a quality ladder started again) has a new muxer: its old shared session is useless.
  forget(mtxPath) { this.sessions.delete(mtxPath); }

  // A playlist: { status, type, body } with the session ids stripped. Requests for the same upstream URL share one upstream
  // request and its answer for 1 s (a blocking reload for the same _HLS_msn/_HLS_part is answered once for everyone).
  async playlist(mtxPath, file, params) {
    let s = await this.session(mtxPath);
    if (!s.id) return { status: s.status || 502 };
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetchShared(this.target(mtxPath, file, s.id, params));
      // 401: MediaMTX ended the shared session (idle). 404: its muxer is gone (the path's publisher restarted, e.g. a quality
      // ladder) and a request carrying the old session does not create the new one; only index.m3u8 does. Either way a new
      // session is made once (its index.m3u8 answers 404 itself when the path really has nothing).
      if ((r.status !== 401 && r.status !== 404) || attempt) return r;
      s = await this.session(mtxPath, s.id);
      if (!s.id) return { status: s.status || 502 };
    }
  }
  fetchShared(url) {
    const hit = this.flights.get(url);
    if (hit && (!hit.doneAt || Date.now() - hit.doneAt < 1000)) return hit.promise;
    const flight = { doneAt: 0 };
    flight.promise = (async () => {
      const res = await upstream(this.base, 'GET', url, { timeoutMs: 15000, agent: hlsAgent });
      const body = await readBody(res, 4 << 20);
      return { status: res.statusCode, type: res.headers['content-type'], body: res.statusCode === 200 ? stripPlaylistQueries(body.toString('utf8')) : '' };
    })();
    flight.promise.then(r => { if (r.status === 200) flight.doneAt = Date.now(); else this.flights.delete(url); }, () => this.flights.delete(url));
    this.flights.set(url, flight);
    return flight.promise;
  }
  // A media file (init, part, segment): the upstream response stream (status 200) or { status }. A preload-hinted part
  // arrives while MediaMTX produces it, so it is streamed, not buffered.
  async media(mtxPath, file, params) {
    let s = await this.session(mtxPath);
    if (!s.id) return { status: s.status || 502 };
    for (let attempt = 0; ; attempt++) {
      const res = await upstream(this.base, 'GET', this.target(mtxPath, file, s.id, params), { timeoutMs: 15000, agent: hlsAgent });
      if (res.statusCode === 200) return { status: 200, res };
      res.resume();
      if (res.statusCode !== 401 || attempt) return { status: res.statusCode };
      s = await this.session(mtxPath, s.id);
      if (!s.id) return { status: s.status || 502 };
    }
  }
}

// Viewer sessions (POST /<path>/session, PUT .../<sid> heartbeat, DELETE on leave): active while the last heartbeat is
// within activeMs. Each remembers the address+browser key of the page that opened it, so the fallback count of HLS clients
// without a session (by that key, from their media requests) does not count a session's own page a second time.
export class ViewerSessions {
  constructor({ activeMs = 30000, perIp = 200 } = {}) {
    this.activeMs = activeMs; this.perIp = perIp;
    this.byPath = new Map();   // path -> Map(sid -> { at, key, ip })
    this.keys = new Map();     // path -> Map(key -> number of active sessions)
    this.ips = new Map();      // ip -> number of active sessions
    setInterval(() => this.prune(), 5000).unref();
  }
  bump(map, k, d) { const v = (map.get(k) || 0) + d; if (v > 0) map.set(k, v); else map.delete(k); }
  drop(path, sid, s) {
    const m = this.byPath.get(path); m?.delete(sid); if (m && !m.size) this.byPath.delete(path);
    const k = this.keys.get(path); if (k) { this.bump(k, s.key, -1); if (!k.size) this.keys.delete(path); }
    this.bump(this.ips, s.ip, -1);
  }
  prune(path) {
    const old = Date.now() - this.activeMs;
    for (const [p, m] of path ? [[path, this.byPath.get(path)]] : [...this.byPath]) if (m) for (const [sid, s] of m) if (s.at < old) this.drop(p, sid, s);
  }
  // A new session id, or '' when this address already holds perIp active sessions.
  open(path, key, ip) {
    this.prune(path);
    if ((this.ips.get(ip) || 0) >= this.perIp) return '';
    const sid = randomBytes(16).toString('hex');
    let m = this.byPath.get(path); if (!m) this.byPath.set(path, (m = new Map()));
    m.set(sid, { at: Date.now(), key, ip });
    let k = this.keys.get(path); if (!k) this.keys.set(path, (k = new Map()));
    this.bump(k, key, 1); this.bump(this.ips, ip, 1);
    return sid;
  }
  // Heartbeat (close=false) or leave (close=true); false for an unknown or expired session.
  touch(path, sid, key, ip, close) {
    const s = this.byPath.get(path)?.get(sid);
    if (!s) return false;
    const expired = Date.now() - s.at >= this.activeMs;
    if (expired || close) { this.drop(path, sid, s); return !expired; }
    // The page may have changed address (Wi-Fi <-> mobile data): its key follows.
    if (s.key !== key) { const k = this.keys.get(path); this.bump(k, s.key, -1); this.bump(k, key, 1); s.key = key; }
    if (s.ip !== ip) { this.bump(this.ips, s.ip, -1); this.bump(this.ips, ip, 1); s.ip = ip; }
    s.at = Date.now();
    return true;
  }
  size(path) { this.prune(path); return this.byPath.get(path)?.size || 0; }
  hasKey(path, key) { return !!this.keys.get(path)?.get(key); }
  get total() { let n = 0; for (const m of this.byPath.values()) n += m.size; return n; }
}

// A single "bytes=" range against `size` bytes: [first, last], null when absent or not understood (whole resource), or
// false when it lies outside the resource (416). Same rules as the app's ParseRange.
export function parseRange(value, size) {
  if (typeof value !== 'string' || !value.startsWith('bytes=') || value.includes(',')) return null;
  const spec = value.slice(6).replace(/ /g, ''), dash = spec.indexOf('-');
  if (dash < 0) return null;
  const a = spec.slice(0, dash), b = spec.slice(dash + 1), digits = s => /^[0-9]{1,15}$/.test(s);
  if (!a) {
    if (!digits(b)) return null;
    const n = Number(b);
    if (!n || !size) return false;
    return [n >= size ? 0 : size - n, size - 1];
  }
  if (!digits(a) || (b && !digits(b))) return null;
  const first = Number(a);
  let last = b ? Number(b) : size - 1;
  if (b && last < first) return null;
  if (first >= size) return false;
  return [first, Math.min(last, size - 1)];
}
