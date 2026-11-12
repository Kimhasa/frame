// Test front for the React public web (apps/web, Vite base /_frame/) in front of a FRAME relay, as Caddy does in production
// (deploy/Caddyfile.example) but on loopback and with fault injection. Used by server/verify/web-e2e.mjs; also usable by
// hand to look at a production build against a running relay.
//   /_frame/*        apps/web/dist: hashed assets (public, immutable), index.html for page addresses (SPA fallback,
//                    no-cache), 404 for a missing asset (never index.html in its place)
//   everything else  passed to the relay unchanged, WebSocket upgrades included. The Host header is kept, so the relay's
//                    list (baseUrl, thumbnailUrl) names this origin.
// Control API on its own loopback port (JSON):
//   GET    /healthz
//   GET    /rules                 the active fault rules
//   POST   /rules                 {method?, pathRegex, queryRegex?, status, retryAfter?, count?, body?, delayMs?} -> rule
//                                 The first matching rule answers the request itself instead of the relay: status 0 drops
//                                 the connection, any other status answers with that status (JSON body unless `body`),
//                                 Cache-Control no-store and Retry-After when given. count: how many requests it answers
//                                 (default: until removed). pathRegex is tested on the pathname, queryRegex on the query.
//   DELETE /rules[/<id>]          remove all rules, or one
//   GET    /log?since=<ms>&path=<regex>   every request seen: {n, t, end, method, path, query, status, retryAfter, cache,
//                                 ws, static, fault, dropped, aborted, upstreamError} (t/end epoch ms)
//   DELETE /log
//   POST   /drop-websockets {pathRegex?} -> {dropped}   cut proxied WebSockets abruptly (a network drop for the page)
// Usage: node server/verify/web-proxy.mjs [--port 25080] [--control 25081] [--relay http://127.0.0.1:8080] [--dist apps/web/dist]
import http from 'node:http';
import net from 'node:net';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, join, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; };
const HOST = '127.0.0.1';
const PORT = Number(arg('port', '25080')), CONTROL = Number(arg('control', '25081'));
const RELAY = new URL(arg('relay', 'http://127.0.0.1:8080'));
const DIST = resolve(arg('dist', join(ROOT, 'apps/web/dist')));
const BASE = '/_frame/';
if (RELAY.protocol !== 'http:') throw new Error('--relay must be an http:// URL');
const RELAY_PORT = Number(RELAY.port || 80), RELAY_HOST = RELAY.hostname;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};
// Hop-by-hop headers are not forwarded in either direction (RFC 9110 7.6.1); Node sets its own framing.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- request log ----------------------------------------------------------------------------------------------------
const LOG_MAX = 100000;
const log = [];
let seq = 0;
function record(req, extra = {}) {
  let path = req.url, query = '';
  try { const u = new URL(req.url, 'http://proxy'); path = u.pathname; query = u.search; } catch {}
  const e = { n: ++seq, t: Date.now(), end: null, method: req.method, path, query, status: null, ...extra };
  log.push(e);
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  return e;
}

// ---- fault rules ----------------------------------------------------------------------------------------------------
const rules = new Map();
let ruleSeq = 0;
function addRule(r) {
  if (!r || typeof r.pathRegex !== 'string' || !r.pathRegex) throw new Error('pathRegex (string) is required');
  const status = Number(r.status);
  if (!Number.isInteger(status) || !(status === 0 || (status >= 200 && status <= 599))) throw new Error('status must be 0 (drop) or 200..599');
  const count = r.count === undefined || r.count === null ? Infinity : Number(r.count);
  if (!(count >= 1)) throw new Error('count must be >= 1');
  const rule = {
    id: ++ruleSeq, method: r.method ? String(r.method).toUpperCase() : null, pathRegex: r.pathRegex, re: new RegExp(r.pathRegex),
    queryRegex: typeof r.queryRegex === 'string' ? r.queryRegex : null, qre: typeof r.queryRegex === 'string' ? new RegExp(r.queryRegex) : null,
    status, retryAfter: r.retryAfter === undefined || r.retryAfter === null ? null : String(r.retryAfter), count,
    body: typeof r.body === 'string' ? r.body : null, delayMs: Math.max(0, Number(r.delayMs) || 0), hits: 0, createdAt: Date.now()
  };
  rules.set(rule.id, rule);
  return rule;
}
function match(method, path, query) {
  for (const r of rules.values()) {
    if (r.method && r.method !== method) continue;
    if (!r.re.test(path) || (r.qre && !r.qre.test(query))) continue;
    r.hits++;
    if (--r.count <= 0) rules.delete(r.id);
    return r;
  }
  return null;
}
const ruleView = r => ({ id: r.id, method: r.method, pathRegex: r.pathRegex, queryRegex: r.queryRegex, status: r.status, retryAfter: r.retryAfter,
  remaining: Number.isFinite(r.count) ? r.count : null, hits: r.hits, delayMs: r.delayMs, createdAt: r.createdAt });

async function answerFault(req, res, rule, entry) {
  entry.fault = rule.id;
  req.resume();  // the request body is not used
  if (rule.delayMs) await sleep(rule.delayMs);
  if (rule.status === 0) { entry.status = 0; entry.end = Date.now(); req.socket.destroy(); return; }
  const empty = rule.status === 204 || rule.status === 304 || req.method === 'HEAD';
  const body = rule.body ?? JSON.stringify({ error: 'injected', status: rule.status });
  const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After', 'X-Frame-Fault': String(rule.id) };
  if (!empty) { headers['Content-Type'] = rule.body === null ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'; headers['Content-Length'] = Buffer.byteLength(body); }
  if (rule.retryAfter !== null) headers['Retry-After'] = rule.retryAfter;
  res.writeHead(rule.status, headers);
  res.end(empty ? undefined : body);
  entry.status = rule.status; entry.retryAfter = rule.retryAfter ?? undefined; entry.end = Date.now();
}

// ---- static web -----------------------------------------------------------------------------------------------------
function plain(res, entry, status, message, extra = {}) {
  entry.status = status; entry.end = Date.now();
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(message), 'Cache-Control': 'no-store', ...extra });
  res.end(message);
}
async function serveStatic(req, res, url, entry) {
  entry.static = true;
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, entry, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice(BASE.length)); } catch { return plain(res, entry, 400, 'Bad request'); }
  if (rel.includes('\0')) return plain(res, entry, 400, 'Bad request');
  const file = resolve(DIST, rel || 'index.html');
  if (file !== DIST && !file.startsWith(DIST + sep)) return plain(res, entry, 404, 'Not found');
  let target = file, st = await stat(file).catch(() => null);
  if (!st?.isFile()) {
    // A page address (no file extension, or an HTML navigation outside assets/) is the SPA's: index.html. A missing asset
    // stays a 404 so a stale hashed name is never answered with HTML.
    const last = rel.split('/').pop() || '';
    const page = !rel.startsWith('assets/') && (!extname(last) || /\btext\/html\b/.test(req.headers.accept || ''));
    if (!page) return plain(res, entry, 404, 'Not found');
    target = join(DIST, 'index.html');
    st = await stat(target).catch(() => null);
    if (!st?.isFile()) return plain(res, entry, 404, 'apps/web/dist/index.html is missing (corepack yarn build)');
  }
  const html = target.endsWith('.html');
  const cache = html ? 'no-cache' : rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  entry.status = 200;
  res.writeHead(200, { 'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') { entry.end = Date.now(); return res.end(); }
  const stream = createReadStream(target);
  stream.on('error', () => res.destroy());
  res.on('finish', () => { entry.end = Date.now(); });
  stream.pipe(res);
}

// ---- relay pass-through ---------------------------------------------------------------------------------------------
const agent = new http.Agent({ keepAlive: true, maxSockets: 512, keepAliveMsecs: 10000 });
function pass(req, res, entry, ctx = null) {
  const retry = !ctx;
  ctx ??= { up: null };
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const up = http.request({ host: RELAY_HOST, port: RELAY_PORT, method: req.method, path: req.url, headers, agent });
  up.on('response', r => {
    entry.status = r.statusCode;
    if (r.headers['retry-after'] !== undefined) entry.retryAfter = r.headers['retry-after'];
    if (r.headers['cache-control'] !== undefined) entry.cache = r.headers['cache-control'];
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(r.statusCode, out);
    r.on('error', () => res.destroy());
    r.pipe(res);
  });
  up.on('error', error => {
    // A kept-alive socket to a relay that restarted is dead: a GET/HEAD is sent once more on a new connection.
    if (retry && up.reusedSocket && !res.headersSent && !res.destroyed && (req.method === 'GET' || req.method === 'HEAD') && error.code === 'ECONNRESET') {
      entry.retried = true;
      return pass(req, res, entry, ctx);
    }
    entry.upstreamError = error.code || error.message;
    if (!res.headersSent) plain(res, entry, 502, 'Relay unreachable');
    else res.destroy();
  });
  if (retry) {
    res.on('finish', () => { entry.end = Date.now(); });
    // The page went away (cancelled request, LL-HLS blocking reload abandoned): stop the upstream request too.
    res.on('close', () => { if (!res.writableFinished) { entry.aborted = true; entry.end = Date.now(); ctx.up?.destroy(); } });
  }
  ctx.up = up;
  if (retry) req.pipe(up); else up.end();
}

async function handle(req, res) {
  const entry = record(req);
  if (!/^\/(?![/\\])/.test(req.url) || /[\x00-\x20\x7f]/.test(req.url)) return plain(res, entry, 400, 'Bad request');
  const url = new URL(req.url, 'http://proxy');
  const rule = match(req.method, url.pathname, url.search);
  if (rule) return answerFault(req, res, rule, entry);
  if (url.pathname === '/_frame') { entry.static = true; return plain(res, entry, 301, 'Moved', { Location: BASE + url.search }); }
  if (url.pathname.startsWith(BASE)) return serveStatic(req, res, url, entry);
  pass(req, res, entry);
}

// ---- WebSocket upgrades: a byte tunnel to the relay -----------------------------------------------------------------
const tunnels = new Set();
function upgrade(req, socket, head) {
  const entry = record(req, { ws: true });
  socket.on('error', () => {});
  let url;
  try { url = new URL(req.url, 'http://proxy'); } catch { socket.destroy(); return; }
  const rule = match(req.method, url.pathname, url.search);
  if (rule) {
    entry.fault = rule.id; entry.status = rule.status; entry.end = Date.now();
    if (rule.status === 0) { socket.destroy(); return; }
    socket.end(`HTTP/1.1 ${rule.status} Injected\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n${rule.retryAfter !== null ? `Retry-After: ${rule.retryAfter}\r\n` : ''}\r\n`);
    return;
  }
  const up = net.connect(RELAY_PORT, RELAY_HOST);
  const tunnel = { socket, up, path: url.pathname, entry };
  tunnels.add(tunnel);
  const done = () => { if (tunnels.delete(tunnel)) entry.end = Date.now(); };
  tunnel.drop = () => { done(); entry.dropped = true; socket.destroy(); up.destroy(); };
  up.on('error', error => {
    entry.upstreamError = error.code || error.message;
    if (entry.status === null) { entry.status = 502; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); }
  });
  socket.on('close', () => { done(); up.destroy(); });
  // Let what the relay sent last (its "closed" message, the close frame) reach the page before the socket goes.
  up.on('close', () => { done(); socket.end(); setTimeout(() => socket.destroy(), 2000).unref(); });
  up.on('connect', () => {
    let lines = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(lines + '\r\n');
    if (head?.length) up.write(head);
    up.once('data', chunk => { entry.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(chunk.toString('latin1', 0, Math.min(chunk.length, 32)))?.[1]) || null; });
    up.pipe(socket);
    socket.pipe(up);
  });
}

// ---- control API ----------------------------------------------------------------------------------------------------
async function readJson(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > 65536) throw new Error('body too large'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}
async function controlHandle(req, res) {
  const url = new URL(req.url, 'http://control');
  const reply = (status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  try {
    const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : null;
    const p = url.pathname;
    if (p === '/healthz') return reply(200, { ok: true, port: PORT, relay: RELAY.origin, dist: DIST, rules: rules.size, logged: log.length, websockets: tunnels.size });
    if (p === '/rules') {
      if (req.method === 'GET') return reply(200, [...rules.values()].map(ruleView));
      if (req.method === 'POST') return reply(200, ruleView(addRule(body)));
      if (req.method === 'DELETE') { const cleared = rules.size; rules.clear(); return reply(200, { cleared }); }
    }
    const m = /^\/rules\/(\d+)$/.exec(p);
    if (m && req.method === 'DELETE') return reply(200, { removed: rules.delete(Number(m[1])) });
    if (p === '/log') {
      if (req.method === 'GET') {
        const since = Number(url.searchParams.get('since')) || 0, re = url.searchParams.get('path') ? new RegExp(url.searchParams.get('path')) : null;
        return reply(200, log.filter(e => e.t >= since && (!re || re.test(e.path))));
      }
      if (req.method === 'DELETE') { const cleared = log.length; log.length = 0; return reply(200, { cleared }); }
    }
    if (p === '/drop-websockets' && req.method === 'POST') {
      const re = body?.pathRegex ? new RegExp(body.pathRegex) : null;
      let dropped = 0;
      for (const t of [...tunnels]) if (!re || re.test(t.path)) { t.drop(); dropped++; }
      return reply(200, { dropped });
    }
    return reply(404, { error: 'not found' });
  } catch (error) { return reply(400, { error: error.message }); }
}

// ---- servers --------------------------------------------------------------------------------------------------------
function webServer() {
  const s = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      console.error(`proxy error ${req.method} ${req.url}: ${error.message}`);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Proxy error'); } else res.destroy();
    });
  });
  s.on('upgrade', upgrade);
  s.on('clientError', (error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); });
  s.keepAliveTimeout = 65000; s.headersTimeout = 70000; s.requestTimeout = 0;
  return s;
}
// 127.0.0.1, plus ::1 when the host has IPv6 loopback, so http://localhost:<port> works whichever address a client tries
// first (the e2e's second page uses it as a second origin).
const server = webServer(), server6 = webServer(), control = http.createServer((req, res) => { controlHandle(req, res); });
server.on('error', error => { console.error('listen failed: ' + error.message); process.exit(1); });
control.on('error', error => { console.error('control listen failed: ' + error.message); process.exit(1); });
server6.on('error', error => console.log('IPv6 loopback not used: ' + error.code));
server.listen(PORT, HOST, () => {
  server6.listen(PORT, '::1');
  control.listen(CONTROL, HOST, () => console.log(`web-proxy http://${HOST}:${PORT}${BASE} (dist ${DIST}) -> relay ${RELAY.origin}; control http://${HOST}:${CONTROL}`));
});
function shutdown() {
  for (const t of [...tunnels]) t.drop();
  server.close(); server6.close(); control.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
