// WHEP signalling tap: a loopback HTTP relay between the generator MediaMTX and the target's WHEP endpoint. Only the
// signalling requests pass through it (OPTIONS / POST offer / PATCH / DELETE); the media flows directly between the peers
// because the ICE candidates come from the target's SDP answer. It exists because MediaMTX's WHEP client logs neither
// the HTTP status nor Retry-After of a refused request: the tap records both per viewer (e.g. the app's "503 Busy,
// Retry-After: 2"), the time the offer was answered, and keeps the per-viewer URL so PATCH/DELETE stay attributed.
// URL scheme: http://127.0.0.1:<port>/<viewer>/<stream path>/whep[/<session>] -> <upstream origin>/<stream path>/whep[...]
import { createServer } from 'node:http';

export class WhepTap {
  constructor({ port, upstream, bind = '127.0.0.1', timeoutMs = 20000 }) {
    this.port = port;
    this.upstream = new URL(upstream).origin;
    this.bind = bind;
    this.timeoutMs = timeoutMs;
    this.viewers = new Map();  // viewer -> { posts, firstPostAt, answers: [{ at, status, ms, retryAfter }], okAt }
    this.events = [];          // { t, method, status } (rolling windows for the 503-share stop rule), trimmed to 10 min
    this.total = { requests: 0, byMethodStatus: {}, retryAfter: {}, upstreamErrors: 0, upstreamErrorKinds: {} };
  }

  urlFor(viewer, upstreamUrl) {
    const u = new URL(upstreamUrl);
    if (u.origin !== this.upstream) throw new Error(`WHEP tap relays ${this.upstream} only, not ${u.origin}`);
    return `http://127.0.0.1:${this.port}/${encodeURIComponent(viewer)}${u.pathname}${u.search}`;
  }

  viewer(name) {
    let v = this.viewers.get(name);
    if (!v) { v = { posts: 0, firstPostAt: null, okAt: null, answers: [] }; this.viewers.set(name, v); }
    return v;
  }

  count(method, status, retryAfter) {
    const k = `${method} ${status}`;
    this.total.requests++;
    this.total.byMethodStatus[k] = (this.total.byMethodStatus[k] || 0) + 1;
    if (retryAfter !== null && retryAfter !== undefined) this.total.retryAfter[retryAfter] = (this.total.retryAfter[retryAfter] || 0) + 1;
    const t = Date.now();
    this.events.push({ t, method, status, retryAfter });
    if (this.events.length > 50000 || (this.events.length && t - this.events[0].t > 600000)) this.events = this.events.filter(e => t - e.t <= 600000);
  }

  // Counters since `from` (ms epoch): offers (POST), their statuses, 503 share and the Retry-After values seen.
  window(from, to = Date.now()) {
    const out = { posts: 0, postStatus: {}, otherStatus: {}, status503: 0, retryAfter: {}, share503: null };
    for (const e of this.events) {
      if (e.t < from || e.t > to) continue;
      if (e.status === 503) { out.status503++; if (e.retryAfter !== null && e.retryAfter !== undefined) out.retryAfter[e.retryAfter] = (out.retryAfter[e.retryAfter] || 0) + 1; }
      if (e.method === 'POST') { out.posts++; out.postStatus[e.status] = (out.postStatus[e.status] || 0) + 1; }
      else out.otherStatus[`${e.method} ${e.status}`] = (out.otherStatus[`${e.method} ${e.status}`] || 0) + 1;
    }
    const posts503 = out.postStatus[503] || 0;
    out.share503 = out.posts ? Math.round(posts503 / out.posts * 10000) / 10000 : null;
    return out;
  }

  async start() {
    this.server = createServer((req, res) => this.relay(req, res));
    this.server.keepAliveTimeout = 5000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.bind, resolve); });
    return this;
  }

  async relay(req, res) {
    const t0 = Date.now();
    const m = req.url.match(/^\/([^/]+)(\/.*)$/);
    if (!m) { res.writeHead(404).end(); return; }
    const name = decodeURIComponent(m[1]), rest = m[2];
    const v = this.viewer(name);
    if (req.method === 'POST') { v.posts++; v.firstPostAt ??= t0; }
    const parts = [];
    for await (const p of req) parts.push(p);
    const headers = {};
    for (const h of ['content-type', 'if-match', 'authorization', 'user-agent', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
    let r;
    try {
      r = await fetch(this.upstream + rest, { method: req.method, headers, body: ['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(parts), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual' });
    } catch (e) {
      const kind = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.name || 'error');
      this.total.upstreamErrors++;
      this.total.upstreamErrorKinds[kind] = (this.total.upstreamErrorKinds[kind] || 0) + 1;
      this.count(req.method, 'upstream-error', null);
      if (req.method === 'POST') v.answers.push({ at: Date.now(), status: 'upstream-error', ms: Date.now() - t0, retryAfter: null, kind });
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('tap: upstream ' + kind);
      return;
    }
    const body = Buffer.from(await r.arrayBuffer());
    const retryAfter = r.headers.get('retry-after');
    this.count(req.method, r.status, retryAfter);
    if (req.method === 'POST') {
      v.answers.push({ at: Date.now(), status: r.status, ms: Date.now() - t0, retryAfter });
      if (v.answers.length > 20) v.answers.splice(1, 1);  // keep the first answer and the most recent ones
      if (r.status === 201 && v.okAt === null) v.okAt = Date.now();
    }
    const out = { 'Content-Length': body.length };
    for (const [h, name2] of [['content-type', 'Content-Type'], ['etag', 'ETag'], ['link', 'Link'], ['accept-patch', 'Accept-Patch'], ['retry-after', 'Retry-After'],
      ['access-control-allow-methods', 'Access-Control-Allow-Methods'], ['access-control-allow-headers', 'Access-Control-Allow-Headers'], ['access-control-expose-headers', 'Access-Control-Expose-Headers']]) {
      const val = r.headers.get(h);
      if (val) out[name2] = val;
    }
    let loc = r.headers.get('location');
    if (loc) {
      // Keep PATCH/DELETE on this tap and attributed to the viewer: absolute -> path, then prefix the viewer segment.
      if (/^https?:/i.test(loc)) { const u = new URL(loc); loc = u.pathname + u.search; }
      if (loc.startsWith('/')) loc = `/${encodeURIComponent(name)}${loc}`;
      out.Location = loc;
    }
    res.writeHead(r.status, out);
    res.end(body);
  }

  summary() {
    const perViewer = [...this.viewers.values()];
    return { ...this.total, viewers: perViewer.length, viewersWith503: perViewer.filter(v => v.answers.some(a => a.status === 503)).length,
      viewersWithoutAnswer201: perViewer.filter(v => v.posts && v.okAt === null).length, retriedViewers: perViewer.filter(v => v.posts > 1).length };
  }

  close() { return new Promise(resolve => { if (!this.server) return resolve(); this.server.closeAllConnections?.(); this.server.close(() => resolve()); }); }
}
