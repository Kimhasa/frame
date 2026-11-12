// Light LL-HLS viewer for the load runner (receiver "hls"). One viewer does what a player's loaders do, without decoding:
// live.m3u8 (multivariant) -> the variant of its planned quality -> init -> parts (or whole segments) of the video and the
// AAC rendition, each followed with blocking playlist reloads (_HLS_msn/_HLS_part) -> bytes, first media, stalls and an
// estimated delay from EXT-X-PROGRAM-DATE-TIME. Optional viewer session (POST /<path>/session, PUT heartbeat, DELETE).
// A Host holds the viewers of one worker thread (lib/hls-worker.mjs) or of the runner itself (workers: 0).
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const UA = 'frame-load-hls/1';

// ---------- HTTP ----------
function makeAgents(o) {
  const a = { keepAlive: o.keepAlive !== false, keepAliveMsecs: 1000, maxSockets: Infinity, maxFreeSockets: 8192, scheduling: 'lifo' };
  return { 'http:': new http.Agent(a), 'https:': new https.Agent({ ...a, rejectUnauthorized: !o.insecure }) };
}
const errCode = e => (e && (e.code || (e.message === 'timeout' ? 'timeout' : e.message))) || 'error';
export function retryAfterSec(h) {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : null;
}

// Never rejects: { status (0 = no answer), headers, body (Buffer when keep), bytes, ttfbMs, ms, error }.
function request(agents, url, { method = 'GET', body = null, timeoutMs = 10000, keep = false, headers = {}, onData = null, live = null } = {}) {
  const t0 = performance.now();
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: 0, error: 'bad-url', bytes: 0, ms: 0, ttfbMs: null }); return; }
    let done = false, ttfb = null, bytes = 0, req = null;
    const chunks = [];
    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      live?.delete(req);
      resolve({ headers: {}, body: null, ...r, bytes, ttfbMs: ttfb, ms: performance.now() - t0 });
    };
    const lib = u.protocol === 'https:' ? https : http;
    const h = { 'User-Agent': UA, Accept: '*/*', ...headers };
    if (body !== null) h['Content-Length'] = Buffer.byteLength(body);
    req = lib.request(u, { method, headers: h, agent: agents[u.protocol] }, res => {
      ttfb = performance.now() - t0;
      res.on('data', c => { bytes += c.length; if (keep) chunks.push(c); if (onData) onData(c.length); });
      res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: keep ? Buffer.concat(chunks) : null }));
      res.on('error', e => finish({ status: 0, error: req.__aborted ? 'aborted' : 'body-' + errCode(e), partialStatus: res.statusCode }));
      res.on('close', () => { if (!res.complete) finish({ status: 0, error: req.__aborted ? 'aborted' : 'incomplete', partialStatus: res.statusCode }); });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('error', e => finish({ status: 0, error: req.__aborted ? 'aborted' : errCode(e) }));
    live?.add(req);
    req.end(body ?? undefined);
  });
}

// ---------- playlists ----------
function attrs(s) {
  const out = {}, re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}
const abs = (uri, base) => new URL(uri, base).href;

export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/), audio = {}, variants = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(l.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) (audio[a['GROUP-ID']] ||= []).push({ default: a.DEFAULT === 'YES', url: abs(a.URI, baseUrl), uri: a.URI });
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      const uri = (lines[j] || '').trim();
      if (uri) {
        const [w, h] = String(a.RESOLUTION || '').split('x').map(Number);
        variants.push({ bandwidth: Number(a.BANDWIDTH) || 0, average: Number(a['AVERAGE-BANDWIDTH']) || null, width: w || 0, height: h || 0, fps: Number(a['FRAME-RATE']) || null,
          codecs: a.CODECS || '', audioGroup: a.AUDIO || null, uri, url: abs(uri, baseUrl) });
      }
      i = j;
    }
  }
  for (const v of variants) { const g = v.audioGroup ? audio[v.audioGroup] : null; v.audioUrl = g ? (g.find(x => x.default) || g[0]).url : null; }
  return variants;
}

// quality: "source" (highest), "<h>p", or "lowest".
export function chooseVariant(variants, quality) {
  if (!variants.length) return null;
  const sorted = [...variants].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  if (!quality || quality === 'source') return sorted[0];
  if (quality === 'lowest') return sorted[sorted.length - 1];
  const h = parseInt(quality, 10);
  return variants.find(v => v.uri.startsWith(quality + '/')) || variants.find(v => v.height === h) || null;
}

export function parseMedia(text, baseUrl) {
  const pl = { msn: 0, skipped: 0, targetDuration: 1, partTarget: null, canBlock: false, partHoldBack: null, holdBack: null, canSkip: false,
    map: null, segments: [], tail: [], tailPdt: null, tailMsn: 0, endList: false, isMedia: false };
  let cur = { parts: [], duration: null, pdt: null, gap: false };
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l[0] !== '#') {
      if (cur.duration === null) continue;
      pl.segments.push({ uri: l, url: abs(l, baseUrl), duration: cur.duration, pdt: cur.pdt, parts: cur.parts, gap: cur.gap });
      cur = { parts: [], duration: null, pdt: null, gap: false };
      continue;
    }
    if (l.startsWith('#EXTINF:')) { cur.duration = parseFloat(l.slice(8)); pl.isMedia = true; }
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { const t = Date.parse(l.slice(25)); cur.pdt = Number.isFinite(t) ? t : null; }
    else if (l.startsWith('#EXT-X-PART:')) { const a = attrs(l.slice(12)); if (a.URI) cur.parts.push({ uri: a.URI, url: abs(a.URI, baseUrl), duration: parseFloat(a.DURATION) || 0, independent: a.INDEPENDENT === 'YES', gap: a.GAP === 'YES' }); }
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) pl.msn = parseInt(l.slice(22), 10) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) pl.targetDuration = parseFloat(l.slice(22)) || 1;
    else if (l.startsWith('#EXT-X-PART-INF:')) pl.partTarget = parseFloat(attrs(l.slice(16))['PART-TARGET']) || null;
    else if (l.startsWith('#EXT-X-SERVER-CONTROL:')) {
      const a = attrs(l.slice(22));
      pl.canBlock = a['CAN-BLOCK-RELOAD'] === 'YES'; pl.partHoldBack = parseFloat(a['PART-HOLD-BACK']) || null; pl.holdBack = parseFloat(a['HOLD-BACK']) || null; pl.canSkip = !!a['CAN-SKIP-UNTIL'];
    } else if (l.startsWith('#EXT-X-MAP:')) { const a = attrs(l.slice(11)); if (a.URI) pl.map = { uri: a.URI, url: abs(a.URI, baseUrl), byterange: a.BYTERANGE || null }; }
    else if (l.startsWith('#EXT-X-SKIP:')) pl.skipped = parseInt(attrs(l.slice(12))['SKIPPED-SEGMENTS'], 10) || 0;
    else if (l === '#EXT-X-GAP') cur.gap = true;  // MediaMTX fills a young playlist with placeholder segments (gap.mp4)
    else if (l === '#EXT-X-ENDLIST') pl.endList = true;
  }
  const first = pl.msn + pl.skipped;
  pl.segments.forEach((s, i) => { s.msn = first + i; });
  pl.tail = cur.parts;
  pl.tailPdt = cur.pdt;
  pl.tailMsn = first + pl.segments.length;
  pl.firstMsn = first;
  return pl;
}

// Flat list of the playable units of a playlist: parts where listed (parts mode), otherwise whole segments, each with its
// media start time from PROGRAM-DATE-TIME (earlier tags of the same playlist or of earlier reloads fill gaps).
function unitsOf(pl, partsMode, pdtByMsn) {
  const out = [];
  let prevEnd = null;
  const segs = [...pl.segments.map(s => ({ ...s, complete: true })), ...(pl.tail.length ? [{ msn: pl.tailMsn, parts: pl.tail, pdt: pl.tailPdt, duration: pl.tail.reduce((a, p) => a + p.duration, 0), complete: false }] : [])];
  for (const s of segs) {
    if (s.gap) { prevEnd = null; continue; }  // no media to fetch
    let pdt = Number.isFinite(s.pdt) ? s.pdt : pdtByMsn.get(s.msn) ?? prevEnd;
    if (Number.isFinite(pdt)) pdtByMsn.set(s.msn, pdt);
    if (partsMode && s.parts.length) {
      let t = pdt;
      s.parts.forEach((p, k) => { if (!p.gap) out.push({ msn: s.msn, part: k, url: p.url, dur: p.duration, independent: p.independent || k === 0, pdt: t, kind: 'part' }); if (Number.isFinite(t)) t += p.duration * 1000; });
    } else if (s.complete) out.push({ msn: s.msn, part: -1, url: s.url, dur: s.duration, independent: true, pdt, kind: 'segment' });
    prevEnd = Number.isFinite(pdt) ? pdt + s.duration * 1000 : null;
  }
  if (pdtByMsn.size > 200) for (const k of [...pdtByMsn.keys()].slice(0, pdtByMsn.size - 100)) pdtByMsn.delete(k);
  return out;
}
const after = (u, c) => u.msn > c.msn || (u.msn === c.msn && (u.part === -1 ? c.part <= 0 : u.part >= c.part));

// ---------- metrics shared by the viewers of one host ----------
class Reservoir {
  constructor(cap = 3000) { this.cap = cap; this.v = []; this.n = 0; }
  add(x) { if (!Number.isFinite(x)) return; this.n++; if (this.v.length < this.cap) this.v.push(x); else { const i = Math.floor(Math.random() * this.n); if (i < this.cap) this.v[i] = x; } }
  take() { const v = this.v; this.v = []; this.n = 0; return v; }
}

export class Host {
  constructor(o = {}) {
    this.o = { partsMode: true, audio: true, session: false, skip: true, startBehindSec: 1.5, segmentStartBehindSec: 3, liveSyncSec: 1.5, catchUpRate: 1.1,
      stallMs: 3000, playlistTimeoutMs: 10000, mediaTimeoutMs: 20000, maxBusyWaits: 6, maxRestarts: 20, keepAlive: true, insecure: false, ...o };
    this.agents = makeAgents(this.o);
    this.viewers = new Map();
    this.totals = { requests: 0, bytes: 0, playlistBytes: 0, mediaBytes: 0, byKind: {}, status: {}, errors: {}, busy: 0, retryAfter: {}, sessionOpened: 0, sessionRefused: 0 };
    this.metrics = { unitMs: new Reservoir(), holdMs: new Reservoir(), recvDelayMs: new Reservoir(), masterMs: new Reservoir() };
    this.errorKinds = {};
  }
  note(kind, r, extra = {}) {
    const t = this.totals;
    if (r.error === 'aborted') { t.aborted = (t.aborted || 0) + 1; return; }  // ended by the viewer itself (leave, switch, restart)
    t.requests++;
    t.bytes += r.bytes || 0;
    if (kind === 'playlist' || kind === 'master') t.playlistBytes += r.bytes || 0; else if (kind !== 'session') t.mediaBytes += r.bytes || 0;
    t.byKind[kind] = (t.byKind[kind] || 0) + 1;
    const key = `${kind} ${r.status || r.error}`;
    t.status[key] = (t.status[key] || 0) + 1;
    if (!r.status) t.errors[r.error] = (t.errors[r.error] || 0) + 1;
    if (r.status === 429 || r.status === 503) {
      t.busy++;
      const ra = r.headers?.['retry-after'];
      if (ra !== undefined) t.retryAfter[ra] = (t.retryAfter[ra] || 0) + 1;
    }
    if (extra.hold) this.metrics.holdMs.add(r.ms);
  }
  kind(text) { const k = String(text).slice(0, 120); this.errorKinds[k] = (this.errorKinds[k] || 0) + 1; }
  add(name, spec) { const v = new Viewer(this, name, spec); this.viewers.set(name, v); return v.start(); }
  async remove(name) { const v = this.viewers.get(name); if (!v) return false; this.viewers.delete(name); await v.stop(); return true; }
  async setQuality(name, quality) { const v = this.viewers.get(name); return v ? v.switchTo(quality) : { ok: false, status: 0, apiMs: 0, error: 'no viewer' }; }
  snapshot() {
    const now = Date.now(), items = [];
    for (const v of this.viewers.values()) items.push(v.item(now));
    const m = {};
    for (const [k, r] of Object.entries(this.metrics)) m[k] = r.take();
    return { items, totals: this.totals, metrics: m, errorKinds: this.errorKinds };
  }
  async stopAll() { await Promise.all([...this.viewers.keys()].map(n => this.remove(n))); }
}

// ---------- one viewer ----------
class Viewer {
  constructor(host, name, spec) {
    this.host = host; this.o = host.o; this.name = name; this.spec = spec;
    this.quality = spec.quality; this.live = new Set();
    this.stopped = false; this.epoch = 0; this.timers = new Set();
    this.bytes = 0; this.playlistBytes = 0; this.requests = 0;
    this.state = 'starting'; this.readyAt = null; this.variant = null; this.variants = null; this.tracks = [];
    this.stallEvents = 0; this.stallMs = 0; this.lastMediaAt = null; this.rebufferMs = 0; this.fellBehind = 0; this.restarts = 0; this.skippedUnits = 0;
    this.first = null; this.sid = null; this.heartbeatMs = 15000; this.sessionStatus = null; this.lastError = null;
    this.play = null;  // virtual playhead { pdt, at, rate }
  }
  get(url, kind, opts = {}) {
    this.requests++;
    return request(this.host.agents, url, { live: kind === 'session' ? null : this.live, ...opts }).then(r => {
      this.host.note(kind, r, opts);
      if (!r.status && !this.stopped && r.error !== 'aborted') this.lastError = `${kind} ${r.error}`;
      else if (r.status >= 400 && !this.stopped) this.lastError = `${kind} ${r.status}`;
      return r;
    });
  }
  sleep(ms) { return new Promise(res => { const t = setTimeout(() => { this.timers.delete(t); res(); }, ms); this.timers.add(t); }); }
  abortAll() { for (const r of [...this.live]) { r.__aborted = true; r.destroy(); } }
  busyWait(r) {
    const s = retryAfterSec(r.headers?.['retry-after']);
    return Math.min(30, Math.max(1, s ?? 2)) * 1000 * (0.8 + Math.random() * 0.4);
  }
  base() { return (this.spec.base || new URL(this.spec.master).origin).replace(/\/$/, ''); }

  // Resolves with the add result as soon as live.m3u8 answered (or failed for good); playback continues in the background.
  start() {
    this.t0 = Date.now();
    return new Promise(resolve => { this.addResolve = resolve; this.run().catch(e => { this.host.kind('viewer crashed: ' + e.message); this.lastError = e.message; this.settle({ ok: false, status: 0, apiMs: Date.now() - this.t0, error: e.message }); }); });
  }
  settle(r) { if (this.addResolve) { const f = this.addResolve; this.addResolve = null; f(r); } }

  async run() {
    // As the page: a viewer cap (503/429 after the bounded waits) or 401/403 ends the attempt; no session endpoint = play anyway.
    if (this.o.session && !this.sid && !(await this.openSession())) {
      if (!this.stopped) this.settle({ ok: false, status: typeof this.sessionStatus === 'number' ? this.sessionStatus : 0, apiMs: Date.now() - this.t0, error: `session ${this.sessionStatus}` });
      return;
    }
    if (this.stopped) return;
    for (let busy = 0; !this.stopped; ) {
      const r = await this.get(this.spec.master, 'master', { keep: true, timeoutMs: this.o.playlistTimeoutMs });
      this.host.metrics.masterMs.add(r.ms);
      if (r.status === 200) {
        this.variants = parseMaster(r.body.toString('utf8'), this.spec.master);
        if (!this.variants.length) {
          // A media playlist given as the URL: one variant without separate audio.
          const pl = parseMedia(r.body.toString('utf8'), this.spec.master);
          if (pl.isMedia) this.variants = [{ width: 0, height: 0, bandwidth: 0, average: null, uri: '', url: this.spec.master, audioUrl: null }];
        }
        const v = chooseVariant(this.variants, this.quality);
        if (!v) { this.state = 'no-variant'; this.settle({ ok: false, status: 404, apiMs: Date.now() - this.t0, error: `quality ${this.quality} not in live.m3u8` }); return; }
        // First-media components of the viewer's first playback only (restarts and switches keep them).
        if (this.first?.masterMs === undefined) this.first = { masterMs: r.ms, sessionMs: this.first?.sessionMs ?? null };
        this.settle({ ok: true, status: 200, apiMs: Date.now() - this.t0, error: null, variants: this.variants.map(x => ({ height: x.height, bandwidth: x.bandwidth, average: x.average })) });
        this.begin(v);
        return;
      }
      if ((r.status === 429 || r.status === 503) && busy++ < this.o.maxBusyWaits) { await this.sleep(this.busyWait(r)); continue; }
      if (r.status === 401 || r.status === 403) { this.state = 'denied'; this.settle({ ok: false, status: r.status, apiMs: Date.now() - this.t0, error: 'denied' }); return; }
      this.state = r.status === 404 ? 'not-running' : 'master-failed';
      this.settle({ ok: false, status: r.status, apiMs: Date.now() - this.t0, error: r.error || `status ${r.status}` });
      // Keep trying within the page's 45 s window (not-running, network): a viewer that never gets media is a timeout.
      if (Date.now() - this.t0 > 45000) return;
      await this.sleep(2000);
    }
  }

  async openSession() {
    const url = `${this.base()}/${this.spec.path}/session`, t = Date.now();
    for (let busy = 0; !this.stopped; ) {
      const r = await this.get(url, 'session', { method: 'POST', body: '', keep: true, timeoutMs: 5000 });
      this.sessionStatus = r.status || r.error;
      if (r.status === 200) {
        try { const b = JSON.parse(r.body.toString('utf8')); if (typeof b.sid === 'string') { this.sid = b.sid; this.heartbeatMs = Math.min(30000, Math.max(5000, Number(b.heartbeatMs) || 15000)); } } catch {}
        this.host.totals.sessionOpened++;
        if (!this.first) this.first = { sessionMs: Date.now() - t };
        this.heartbeat();
        return true;
      }
      if (r.status === 429 || r.status === 503) {
        this.host.totals.sessionRefused++;
        if (busy++ < this.o.maxBusyWaits) { await this.sleep(this.busyWait(r)); continue; }
        this.state = 'refused';
        return false;
      }
      if (r.status === 401 || r.status === 403) { this.state = 'denied'; return false; }
      // 404 (a server without the endpoint) or no answer: play without a session, as the page does.
      this.first = { sessionMs: Date.now() - t };
      return true;
    }
    return false;
  }
  heartbeat() {
    clearInterval(this.hb);
    this.hb = setInterval(async () => {
      if (this.stopped || !this.sid) return;
      const r = await this.get(`${this.base()}/${this.spec.path}/session/${this.sid}`, 'session', { method: 'PUT', body: '', timeoutMs: 5000 });
      if (r.status === 404 && !this.stopped) { this.sid = null; clearInterval(this.hb); this.openSession().catch(() => {}); }
    }, this.heartbeatMs);
    this.hb.unref?.();
  }

  // Starts the video (and audio) followers of a variant; a new epoch makes every older loop end.
  begin(v) {
    const epoch = ++this.epoch;
    this.variant = v;
    this.state = 'loading';
    this.readyAt = null;
    this.play = null;
    this.sessionStart = Date.now();
    this.tracks = [new Track(this, 'video', v.url, epoch)];
    if (this.o.audio && v.audioUrl) this.tracks.push(new Track(this, 'audio', v.audioUrl, epoch));
    for (const t of this.tracks) t.loop().catch(e => { if (!this.stopped && epoch === this.epoch) { this.host.kind(`${t.kind} loop: ${e.message}`); this.restart('loop-error'); } });
  }
  async restart(reason) {
    if (this.stopped || this.restarting) return;
    this.restarting = true;
    this.epoch++;
    this.restarts++;
    this.lastError = reason;
    this.host.kind('restart: ' + reason);
    this.state = 'restarting';
    this.readyAt = null;
    this.abortAll();
    await this.sleep(Math.min(8000, 1000 * 2 ** Math.min(3, this.restarts - 1)));
    this.restarting = false;
    if (this.stopped || this.restarts > this.o.maxRestarts) { if (!this.stopped) this.state = 'gave-up'; return; }
    this.t0r = Date.now();
    await this.run();
  }
  async switchTo(quality) {
    const t = Date.now();
    if (!this.variants) return { ok: false, status: 0, apiMs: 0, error: 'not started' };
    const v = chooseVariant(this.variants, quality);
    if (!v) return { ok: false, status: 404, apiMs: Date.now() - t, error: `quality ${quality} not in live.m3u8` };
    this.quality = quality;
    this.abortAll();
    this.lastMediaAt = null;  // a level switch keeps the old picture on screen (hls.js): its gap is the switch time, not a stall
    this.begin(v);
    return { ok: true, status: 200, apiMs: Date.now() - t, error: null };
  }

  // Media of the current epoch arrived on one track.
  media(track, unit, r, at) {
    const gap = this.lastMediaAt !== null && track.kind === 'video' ? at - this.lastMediaAt : 0;
    if (gap > this.o.stallMs) { this.stallEvents++; this.stallMs += gap; }
    if (track.kind === 'video') this.lastMediaAt = at;
    if (Number.isFinite(unit.pdt)) this.host.metrics.recvDelayMs.add(at - (unit.pdt + unit.dur * 1000));
    this.host.metrics.unitMs.add(r.ms);
    if (this.readyAt === null && this.tracks.every(t => t.units > 0)) {
      this.readyAt = at;
      this.state = 'playing';
      if (this.first && this.first.firstMediaMs === undefined) this.first.firstMediaMs = at - this.t0;
      // The virtual player starts at the media position of the first unit it holds of every track.
      const starts = this.tracks.map(t => t.startPdt).filter(Number.isFinite);
      if (starts.length) this.play = { pdt: Math.max(...starts), at, rate: 1 };
    }
    this.advance(at);
  }
  // Virtual playback: the position moves with the clock while media is buffered (catching up at up to catchUpRate when more
  // than liveSync + 0.5 s is buffered, as the page's hls.js does), and stops at the buffer end (rebuffering).
  advance(now) {
    const p = this.play;
    if (!p) return;
    const end = Math.min(...this.tracks.map(t => (Number.isFinite(t.bufEnd) ? t.bufEnd : Infinity)));
    let next = p.pdt + (now - p.at) * p.rate;
    if (Number.isFinite(end) && next > end) { this.rebufferMs += next - end; next = Math.max(p.pdt, end); }
    p.pdt = next; p.at = now;
    p.rate = Number.isFinite(end) && end - next > (this.o.liveSyncSec + 0.5) * 1000 ? this.o.catchUpRate : 1;
  }
  item(now) {
    this.advance(now);
    const inStall = this.lastMediaAt !== null && now - this.lastMediaAt > this.o.stallMs;
    const ends = this.tracks.map(t => t.bufEnd).filter(Number.isFinite);
    return { name: this.name, ready: this.readyAt !== null, tracks: this.readyAt !== null ? this.tracks.map(t => t.kind) : [], inboundBytes: this.bytes,
      readyTime: this.readyAt !== null ? new Date(this.readyAt).toISOString() : null,
      hls: { state: this.state, variant: this.variant ? `${this.variant.width}x${this.variant.height}` : null, quality: this.quality, delayMs: this.play ? Math.round(now - this.play.pdt) : null,
        stallEvents: this.stallEvents, stallMs: this.stallMs, inStall, rebufferMs: Math.round(this.rebufferMs), fellBehind: this.fellBehind, skippedUnits: this.skippedUnits, restarts: this.restarts,
        playlistBytes: this.playlistBytes, requests: this.requests, sid: !!this.sid, sessionStatus: this.sessionStatus, first: this.first, lastError: this.lastError, bufferMs: this.play && ends.length ? Math.round(Math.min(...ends) - this.play.pdt) : null } };
  }
  async stop() {
    this.stopped = true;
    this.epoch++;
    clearInterval(this.hb);
    for (const t of this.timers) clearTimeout(t);
    this.abortAll();
    this.settle({ ok: false, status: 0, apiMs: Date.now() - this.t0, error: 'removed' });
    if (this.sid) { const sid = this.sid; this.sid = null; await request(this.host.agents, `${this.base()}/${this.spec.path}/session/${sid}`, { method: 'DELETE', timeoutMs: 3000 }).then(r => this.host.note('session', r)); }
  }
}

// One media playlist followed like a player's loader: initial load, init, start position, then (parts mode) blocking
// reloads for the next part and the parts as they appear; segments mode reloads every target duration.
class Track {
  constructor(viewer, kind, url, epoch) {
    Object.assign(this, { viewer, kind, url, epoch });
    this.o = viewer.o; this.units = 0; this.startPdt = null; this.bufEnd = null; this.pdtByMsn = new Map(); this.failures = 0; this.busy = 0;
  }
  get alive() { return !this.viewer.stopped && this.epoch === this.viewer.epoch; }
  async playlist(cursor, pl) {
    const v = this.viewer;
    let url = this.url, hold = false;
    if (cursor && pl?.canBlock && this.o.partsMode) {
      // The next part of the segment in progress, unless its parts already add up to a whole segment (as long as the last
      // complete one): then part 0 of the next segment. MediaMTX holds a request for a part index past the end of a
      // segment until the FOLLOWING segment is complete (measured ~1 s), which would deliver parts in 1 s bursts.
      let { msn, part } = cursor;
      if (msn === pl.tailMsn && pl.tail.length && part >= pl.tail.length) {
        const tailSec = pl.tail.reduce((a, p) => a + p.duration, 0), segSec = pl.segments.length ? pl.segments[pl.segments.length - 1].duration : pl.targetDuration;
        if (tailSec >= segSec - (pl.partTarget || 0.2) / 2) { msn++; part = 0; }
      }
      const q = new URL(url);
      q.searchParams.set('_HLS_msn', String(msn));
      q.searchParams.set('_HLS_part', String(Math.max(0, part)));
      if (this.o.skip && pl.canSkip) q.searchParams.set('_HLS_skip', 'YES');
      url = q.href; hold = true;
    }
    const r = await v.get(url, 'playlist', { keep: true, timeoutMs: this.o.playlistTimeoutMs, hold });
    v.playlistBytes += r.bytes || 0;
    return r;
  }
  // Non-200 answers: true = try again (after waiting), false = the viewer restarts.
  async failed(r, what) {
    const v = this.viewer;
    if (r.status === 429 || r.status === 503) { if (this.busy++ >= this.o.maxBusyWaits) { v.restart(`${this.kind} ${what} busy`); return false; } await v.sleep(v.busyWait(r)); return true; }
    if (r.status === 401 || r.status === 403) { v.state = 'denied'; v.epoch++; return false; }
    if (r.status === 404) { v.restart(`${this.kind} ${what} 404`); return false; }
    if (++this.failures > 3) { v.restart(`${this.kind} ${what} ${r.status || r.error}`); return false; }
    await v.sleep(500 * this.failures);
    return true;
  }
  startCursor(pl, units) {
    // Video: the last independent unit at least startBehind before the newest media end. Audio: aligned to the video start.
    const last = units[units.length - 1];
    const edge = last && Number.isFinite(last.pdt) ? last.pdt + last.dur * 1000 : null;
    const behind = (this.o.partsMode ? this.o.startBehindSec : this.o.segmentStartBehindSec) * 1000;
    const video = this.viewer.tracks.find(t => t.kind === 'video');
    const want = this.kind === 'audio' && Number.isFinite(video?.startPdt) ? video.startPdt : edge !== null ? edge - behind : null;
    let pick = null;
    if (want !== null) for (const u of units) if ((u.independent || this.kind === 'audio') && Number.isFinite(u.pdt) && u.pdt <= want + 1) pick = u;
    if (!pick) {
      // No PDT: count back by duration.
      let acc = 0;
      for (let i = units.length - 1; i >= 0; i--) { acc += units[i].dur * 1000; if (acc >= behind && (units[i].independent || this.kind === 'audio')) { pick = units[i]; break; } }
      pick ||= units.find(u => u.independent) || units[0];
    }
    return pick ? { msn: pick.msn, part: pick.part } : { msn: pl.tailMsn, part: 0 };
  }
  // A completed segment whose parts were all taken -> next segment; a segment no longer listed by parts (fallen behind)
  // -> its remainder is skipped.
  normalize(cursor, pl) {
    for (;;) {
      const s = pl.segments.find(x => x.msn === cursor.msn);
      if (!s) return cursor;
      if (this.o.partsMode && s.parts.length && cursor.part >= s.parts.length) { cursor = { msn: cursor.msn + 1, part: 0 }; continue; }
      if (!s.parts.length && cursor.part > 0) { this.viewer.skippedUnits++; cursor = { msn: cursor.msn + 1, part: 0 }; continue; }
      return cursor;
    }
  }
  async loop() {
    const v = this.viewer;
    let r, pl = null, units = [];
    // Initial playlist (also the first wait of an on-demand quality whose encoder starts now).
    while (this.alive) {
      r = await this.playlist(null, null);
      if (!this.alive) return;
      if (r.status === 200) { pl = parseMedia(r.body.toString('utf8'), this.url); units = unitsOf(pl, this.o.partsMode, this.pdtByMsn); if (units.length) break; await v.sleep(300); continue; }
      if (!(await this.failed(r, 'playlist'))) return;
    }
    if (!this.alive) return;
    if (v.first && this.kind === 'video' && v.first.playlistMs === undefined) v.first.playlistMs = Date.now() - v.t0;
    if (pl.map) {
      for (;;) {
        const opts = { timeoutMs: this.o.mediaTimeoutMs, onData: n => { if (this.alive) v.bytes += n; } };
        if (pl.map.byterange) { const [len, off = 0] = pl.map.byterange.split('@').map(Number); opts.headers = { Range: `bytes=${off}-${off + len - 1}` }; }
        r = await v.get(pl.map.url, 'init', opts);
        if (!this.alive) return;
        if (r.status === 200 || r.status === 206) break;
        if (!(await this.failed(r, 'init'))) return;
      }
      if (v.first && this.kind === 'video' && v.first.initMs === undefined) v.first.initMs = Date.now() - v.t0;
    }
    // Audio starts where the video starts (its first unit decides the media position), as a player aligns them.
    const video = v.tracks.find(t => t.kind === 'video');
    for (let i = 0; this.kind === 'audio' && video && video.startPdt === null && i < 100 && this.alive; i++) await v.sleep(50);
    if (!this.alive) return;
    let cursor = this.startCursor(pl, units);
    while (this.alive) {
      cursor = this.normalize(cursor, pl);
      if (cursor.msn < pl.firstMsn) {
        // The window moved past the next unit: back to the live edge (a gap in the media).
        v.fellBehind++;
        cursor = this.startCursor(pl, units);
      }
      const next = units.filter(u => after(u, cursor));
      for (const u of next) {
        if (!this.alive) return;
        const opts = { timeoutMs: this.o.mediaTimeoutMs, onData: n => { if (this.alive) v.bytes += n; } };
        r = await v.get(u.url, u.kind, opts);
        if (!this.alive) return;
        if (r.status !== 200) { if (!(await this.failed(r, u.kind))) return; break; }
        this.failures = 0; this.busy = 0;
        const at = Date.now();
        if (this.units++ === 0) this.startPdt = u.pdt;
        if (Number.isFinite(u.pdt)) this.bufEnd = Math.max(this.bufEnd ?? -Infinity, u.pdt + u.dur * 1000);
        cursor = u.part === -1 ? { msn: u.msn + 1, part: 0 } : { msn: u.msn, part: u.part + 1 };
        v.media(this, u, r, at);
      }
      if (!this.alive) return;
      if (pl.endList) { await v.sleep(1000); }
      else if (!(this.o.partsMode && pl.canBlock)) await v.sleep(Math.max(100, (this.o.partsMode && pl.partTarget ? pl.partTarget : pl.targetDuration || 1) * 1000 * (next.length ? 1 : 0.5)));
      // Reload (blocking for the next part in parts mode). The cursor is normalised first: after the last part of a segment
      // that is already complete the next request is part 0 of the following segment.
      cursor = this.normalize(cursor, pl);
      for (;;) {
        r = await this.playlist(cursor, pl);
        if (!this.alive) return;
        if (r.status === 200) break;
        if (!(await this.failed(r, 'playlist'))) return;
      }
      const np = parseMedia(r.body.toString('utf8'), this.url);
      if (np.isMedia || np.tail.length) {
        this.failures = 0; this.busy = 0;
        if (!np.map) np.map = pl.map;
        pl = np;
        units = unitsOf(pl, this.o.partsMode, this.pdtByMsn);
      }
    }
  }
}
