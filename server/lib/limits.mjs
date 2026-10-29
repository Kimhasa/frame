// Client addresses, per-IP rate limits and concurrency gates.
// Limits answer with 429/503 and Retry-After so browsers and the publisher back off instead of seeing dropped sockets.

const plain = ip => (ip || '').replace(/^::ffff:/, '');

// The browser's address: X-Forwarded-For is believed only when the socket comes from a configured proxy (Caddy on
// loopback), and then the right-most address that is not itself a trusted proxy is the client.
export function clientIp(req, trusted) {
  const peer = plain(req.socket.remoteAddress);
  if (!trusted.has(peer)) return peer;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => plain(s.trim())).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) if (!trusted.has(chain[i])) return chain[i];
  return peer;
}

export function forwardedProto(req, trusted) {
  if (trusted.has(plain(req.socket.remoteAddress))) {
    const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (p === 'https' || p === 'http') return p;
  }
  return req.socket.encrypted ? 'https' : 'http';
}

// Token bucket per key: `burst` requests at once, refilled at `perSecond`. Idle buckets are swept.
export class RateLimit {
  constructor(burst, perSecond) {
    this.burst = burst; this.perSecond = perSecond; this.buckets = new Map();
    this.sweeper = setInterval(() => this.sweep(), 30000).unref();
  }
  take(key, cost = 1) {
    const b = this.bucket(key);
    if (b.tokens < cost) return Math.max(1, Math.ceil((cost - b.tokens) / this.perSecond));  // seconds to wait
    b.tokens -= cost;
    return 0;
  }
  // Seconds to wait if take() would refuse now, without spending anything (0 when allowed).
  peek(key, cost = 1) {
    if (!this.buckets.has(key)) return 0;
    const b = this.bucket(key);
    return b.tokens < cost ? Math.max(1, Math.ceil((cost - b.tokens) / this.perSecond)) : 0;
  }
  bucket(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.burst, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    return b;
  }
  sweep() {
    const now = Date.now();
    for (const [key, b] of this.buckets) if (b.tokens + ((now - b.at) / 1000) * this.perSecond >= this.burst) this.buckets.delete(key);
  }
}

// Counts work in flight (upstream WHEP negotiations, DVR chunk streams); enter() fails instead of queueing without bound.
export class Gate {
  constructor(max) { this.max = max; this.active = 0; }
  enter() { if (this.active >= this.max) return false; this.active++; return true; }
  leave() { if (this.active > 0) this.active--; }
}

export class Counter {
  constructor() { this.map = new Map(); }
  get(key) { return this.map.get(key) || 0; }
  add(key, n) { const v = this.get(key) + n; if (v <= 0) this.map.delete(key); else this.map.set(key, v); return v; }
}

// Clients seen per path within a sliding window (HLS viewers have no server-side session the relay could count, so a
// viewer is a MediaMTX HLS session cookie, or address + browser when there is none). Pruned every 2 s; size() is the count.
export class ActiveSet {
  constructor(windowMs) {
    this.windowMs = windowMs; this.byPath = new Map();
    this.sweeper = setInterval(() => this.prune(), 2000).unref();
  }
  touch(path, key) { let m = this.byPath.get(path); if (!m) this.byPath.set(path, (m = new Map())); m.set(key, Date.now()); }
  delete(path, key) { const m = this.byPath.get(path); if (m) { m.delete(key); if (!m.size) this.byPath.delete(path); } }
  has(path, key) { const t = this.byPath.get(path)?.get(key); return !!t && Date.now() - t < this.windowMs; }
  size(path) { return this.byPath.get(path)?.size || 0; }
  prune() {
    const old = Date.now() - this.windowMs;
    for (const [path, m] of this.byPath) { for (const [k, t] of m) if (t < old) m.delete(k); if (!m.size) this.byPath.delete(path); }
  }
}
