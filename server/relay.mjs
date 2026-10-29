// FRAME internet relay web service. Serves the unchanged viewer UI (outputs/index.html) and the viewer API the UI already
// uses against FrameConsole.exe (native/src/http_server.cpp), but backed by a relay MediaMTX on this server:
//   GET  /api/broadcasts                      public list (announced and actually receiving media)
//   POST /api/broadcasts/announce             publisher token; {"v":1,"type":"announce"|"bye",...}
//   PUT  /api/broadcasts/<id>/thumbnail       publisher token; image/jpeg <= 256 KB
//   GET  /thumbnails/<id>.jpg, /<path>/info, /<path>/dvr, /<path>/dvr/media, /<path>[/<q>|/aac]/hls/<file>, /healthz
//   POST|PATCH|DELETE /<path>[/<q>]/whep[/<session>]  proxied to MediaMTX WebRTC on loopback
//   POST /<path>/stats                        anonymous playback report (sendBeacon), appended to a daily CSV
//   WebSocket /<path>/chat                    chat protocol of native/src/chat.cpp
// The MediaMTX API, playback server, RTSP publish and any start/stop action are never reachable through this service.
// Run: node --env-file=deploy/relay.env server/relay.mjs   (see deploy/README.md)
import http from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { loadConfig } from './lib/config.mjs';
import { clientIp, forwardedProto, RateLimit, Gate, Counter, ActiveSet } from './lib/limits.mjs';
import { Registry, tokenIndex } from './lib/registry.mjs';
import { MediaMtx, upstream, readBody, hlsAgent } from './lib/mediamtx.mjs';
import { Dvr } from './lib/dvr.mjs';
import { ChatHub } from './lib/chat.mjs';
import { WebSocketConnection, handshakeError } from './lib/websocket.mjs';
import { StatsLog, statsRow } from './lib/stats.mjs';

const VERSION = '0.2.0';
const cfg = loadConfig();
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const quiet = new Map();
// One line per event for journald; never tokens, SDP bodies or chat text. `key` collapses repeats to one per minute.
function log(level, message, key) {
  if ((levels[level] || 20) < (levels[cfg.logLevel] || 20)) return;
  if (key) { const last = quiet.get(key) || 0; if (Date.now() - last < 60000) return; quiet.set(key, Date.now()); if (quiet.size > 5000) quiet.clear(); }
  console.log(`${new Date().toISOString()} ${level.toUpperCase()} ${message}`);
}

const mtx = new MediaMtx(cfg.mediamtx, log);
const dvr = new Dvr(cfg, log);
const limits = Object.fromEntries(Object.entries(cfg.rates).map(([k, r]) => [k, new RateLimit(r.burst, r.perSecond)]));
const gates = { whep: new Gate(cfg.limits.whepInflight), dvr: new Gate(cfg.limits.dvrStreams), hls: new Gate(cfg.limits.hlsInflight) };
const chatPerIp = new Counter(), dvrPerIp = new Counter(), hlsPerIp = new Counter();
const hlsViewers = new ActiveSet(cfg.hlsActiveMs);
const stats = new StatsLog({ ...cfg.stats, log });
const hub = new ChatHub({ sendLimit: limits.chatSend, log });
const registry = new Registry({
  ttlMs: cfg.announceTtlMs, maxEntries: cfg.limits.broadcasts, holdMs: cfg.mediaGraceMs,
  allowed: (token, path) => { const paths = cfg.tokenPaths[token]; return !paths || paths.has(path); },
  onStart: e => { hub.open(e.path, e.id); log('info', `broadcast ${e.id} on /${e.path} announced`); },
  onEnd: (e, reason) => { if (hub.room(e.path)?.broadcastId === e.id) hub.close(e.path, reason); log('info', `broadcast ${e.id} on /${e.path} ended: ${reason}`); }
});

// ---- helpers ------------------------------------------------------------------------------------------------------
const base = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-Match', 'Access-Control-Expose-Headers': 'Location, ETag, Link, Accept-Patch, Retry-After'
};
const noStore = { 'Cache-Control': 'no-store' };
function send(res, status, type, body = '', extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { ...base, ...(type ? { 'Content-Type': type } : {}), 'Content-Length': data.length, ...extra });
  res.end(data);
}
const json = (res, status, value, extra = {}) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), { ...noStore, ...extra });
const text = (res, status, message, extra = {}) => send(res, status, 'text/plain; charset=utf-8', message, extra);
const busy = (res, seconds, message = 'Server busy') => text(res, 503, message, { ...noStore, 'Retry-After': String(seconds) });
const limited = (res, seconds) => text(res, 429, 'Too many requests', { ...noStore, 'Retry-After': String(seconds) });

// The public origin viewers use: fixed by RELAY_PUBLIC_BASE_URL in production, else taken from the (proxy's) request.
function publicBase(req) {
  if (cfg.publicBase) return cfg.publicBase;
  const trusted = cfg.trustedProxies.has((req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
  const host = String((trusted && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
  const safe = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(:\d{1,5})?$/.test(host) ? host : `${cfg.host}:${cfg.port}`;
  return `${forwardedProto(req, cfg.trustedProxies)}://${safe}`;
}

async function readLimited(req, limit) {
  if (Number(req.headers['content-length'] || 0) > limit) return null;
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) return null; chunks.push(c); }
  return Buffer.concat(chunks);
}

// Entry on `path` plus the MediaMTX state of its source path:
//   ready    announced and the relay receives its media;
//   waiting  announced, media not arriving right now but seen (or announced) within RELAY_MEDIA_GRACE_MS: a sender
//            reconnecting or a relay MediaMTX restart. Viewers are told {"running":true,"mediaReady":false} and wait.
// The first time the path is seen receiving media for this broadcast fixes the start of its DVR window (relay clock).
async function current(path) {
  const entry = registry.byPath(path);
  const paths = await mtx.list();
  const p = paths.get(path);
  const ready = !!(entry && p?.ready);
  if (ready) observe(entry, p);
  const waiting = !!entry && !ready && Date.now() - Math.max(entry.lastReadyMs, entry.firstSeenMs) <= cfg.mediaGraceMs;
  return { entry, p, paths, ready, waiting, live: ready || waiting };
}
function observe(entry, p) {
  // A publisher session older than the broadcast (the previous broadcast still publishing) must not open the window early.
  const ready = p.readyMs && p.readyMs >= entry.startedAtRelayMs - 10000 ? p.readyMs : Math.max(p.readyMs || 0, entry.startedAtRelayMs || Date.now());
  entry.dvrFromMs = entry.dvrFromMs ? Math.min(entry.dvrFromMs, ready) : ready;
  // A stale list (MediaMTX API slow or down) is not proof the media still arrives: it does not extend the grace period.
  if (!mtx.stale) entry.lastReadyMs = Date.now();
  // What the relay last measured, so /info stays complete while the media is briefly away.
  entry.seen = { width: p.width, height: p.height, mbps: p.mbps, tracks: p.tracks };
}

function turnCredentials() {
  if (!cfg.turn.secret || !cfg.turn.urls.length) return [];
  // TURN REST convention (coturn use-auth-secret): short-lived username "expiry:frame", HMAC-SHA1 credential.
  const username = `${Math.floor(Date.now() / 1000) + cfg.turn.ttlS}:frame`;
  return [{ urls: cfg.turn.urls, username, credential: createHmac('sha1', cfg.turn.secret).update(username).digest('base64') }];
}

// Width FFmpeg gives for scale=-2:H (the relay encoders in mediamtx-relay.yml): av_rescale(H, W, srcH*2)*2, rounded to
// nearest. 1280x720 -> 480p is 854 (the sender's own encoder computes 852 and announces that).
const scaledWidth =(srcW, srcH, h) => (srcW && srcH ? Math.round(h * srcW / (srcH * 2)) * 2 : 0);

// Lower qualities this relay really serves for the broadcast, each {name,width,height,mbps,fps,codec}:
//   - renditions the sender itself publishes to the relay (announced and receiving): the sender's own description;
//   - otherwise the relay-side shared encoders (RELAY_RENDITIONS, mediamtx-relay.yml): scale=-2:H, the yml bitrate,
//     the source frame rate, H.264.
function renditions(entry, p, paths) {
  const seen = entry.seen || {};
  const width = entry.width || p?.width || seen.width || 0, height = entry.height || p?.height || seen.height || 0;
  if (!height) return [];
  const out = new Map();
  for (const r of cfg.renditions) if (r.height < height) out.set(r.name, { name: r.name, width: scaledWidth(width, height, r.height), height: r.height, mbps: r.mbps, fps: entry.fps || 0, codec: 'H.264' });
  for (const r of entry.renditions || []) {
    // Only a path the sender itself publishes (RTSPS from outside); the same path fed by the relay's own on-demand
    // encoder (plain RTSP on loopback) keeps the relay encoder's description.
    const rp = paths.get(entry.path + '/' + r.name);
    if (r.height >= height || !rp?.ready || rp.sourceType !== 'rtspsSession') continue;
    out.set(r.name, { name: r.name, width: r.width || scaledWidth(width, height, r.height), height: r.height, mbps: r.mbps || out.get(r.name)?.mbps || 0, fps: r.fps || entry.fps || 0, codec: r.codec || 'H.264' });
  }
  return [...out.values()].sort((a, b) => b.height - a.height);
}

// Relative to <origin>/<path>/: the Opus original, and the AAC copy (relay-side audio transcode) for browsers that play
// HLS natively but not Opus in fMP4 (iPhone Safari).
const hlsVariants = () => (cfg.hls ? { opus: 'hls/index.m3u8', ...(cfg.hlsAac ? { aac: 'aac/hls/index.m3u8' } : {}) } : {});

function viewerInfo(path, s) {
  const { entry, p, paths, ready, waiting } = s;
  if (!ready && !waiting) return { running: false, path };
  const seen = (ready ? p : entry.seen) || {}, tracks = seen.tracks || [];
  const audio = entry.audio || (!tracks.length ? 'none' : tracks.includes('Opus') || tracks.includes('MPEG-4 Audio') ? 'system' : 'none');
  const mbps = entry.bitrate || (seen.mbps ? Math.round(seen.mbps * 10) / 10 : 8);
  return {
    running: true, mediaReady: ready, path, width: entry.width || seen.width || 0, height: entry.height || seen.height || 0, fps: entry.fps, bitrate: mbps, audio,
    codec: tracks.includes('H265') ? 'H.265' : 'H.264', elapsedMs: Math.max(0, Date.now() - entry.startedAtRelayMs), startedAtMs: entry.startedAtRelayMs,
    broadcastId: entry.id, dvr: cfg.dvr, title: entry.title, publisher: entry.publisher, renditions: renditions(entry, p, paths),
    hlsVariants: hlsVariants(), iceServers: [...cfg.iceServers, ...turnCredentials()]
  };
}

// Viewers of a broadcast for the per-path cap: WebRTC sessions on the path and its renditions (MediaMTX readers) plus
// HLS clients active within RELAY_HLS_ACTIVE_MS (this process counts them; MediaMTX has no per-client HLS reader).
function viewerCount(path, paths) {
  let webrtc = 0;
  for (const [name, v] of paths) if (name === path || name.startsWith(path + '/')) webrtc += v.webrtcReaders;
  return webrtc + hlsViewers.size(path);
}
function overCap(path, paths, res) {
  if (viewerCount(path, paths) < cfg.limits.viewersPerPath) return false;
  log('warn', `viewer limit ${cfg.limits.viewersPerPath} reached on /${path}`, 'cap ' + path);
  busy(res, 15, 'Viewer limit reached');
  return true;
}

let uiCache = { at: 0, mtime: 0, body: null };
async function uiPage() {
  if (Date.now() - uiCache.at > 2000) {
    const st = await stat(cfg.uiFile);
    if (st.mtimeMs !== uiCache.mtime || !uiCache.body) uiCache = { at: Date.now(), mtime: st.mtimeMs, body: await readFile(cfg.uiFile) };
    else uiCache.at = Date.now();
  }
  return uiCache.body;
}

// ---- routes -------------------------------------------------------------------------------------------------------
const P = '([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})';
const R = {
  whep: new RegExp(`^/${P}(?:/((?:240|360|480|720|1080|1440)p))?/whep(/[A-Za-z0-9_-]{1,128})?$`),
  hls: new RegExp(`^/${P}(?:/((?:240|360|480|720|1080|1440)p|aac))?/hls/([A-Za-z0-9_.-]{1,128}\\.(?:m3u8|mp4|m4s|ts))$`),
  page: new RegExp(`^/${P}/?$`),
  font: new RegExp(`^(?:/${P})?/assets/fonts/(PretendardVariable\\.woff2|OFL\\.txt)$`),
  info: new RegExp(`^/${P}/info$`), dvr: new RegExp(`^/${P}/dvr$`), dvrMedia: new RegExp(`^/${P}/dvr/media$`),
  chat: new RegExp(`^/${P}/chat$`), stats: new RegExp(`^/${P}/stats$`), thumb: /^\/thumbnails\/([0-9a-f]{32})\.jpg$/, thumbUpload: /^\/api\/broadcasts\/([0-9a-f]{32})\/thumbnail$/
};

async function whep(req, res, m, ip) {
  const [, path, quality, session] = m;
  if (req.method === 'OPTIONS') return send(res, 204, '', '', { 'Access-Control-Max-Age': '600' });
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method) || (req.method === 'POST' && session)) return text(res, 405, 'Method not allowed');
  const s = await current(path);
  if (req.method === 'POST') {
    // Media briefly away (sender reconnecting): 503 + Retry-After, which the UI waits out, instead of "not running".
    if (!s.ready) return s.waiting ? busy(res, 2, 'Media is not ready yet') : text(res, 404, 'Stream is not running', noStore);
    if (quality && !renditions(s.entry, s.p, s.paths).some(r => r.name === quality)) return text(res, 404, 'Quality is not available', noStore);
    if (overCap(path, s.paths, res)) return;
    const wait = limits.whep.take(ip);
    if (wait) return limited(res, wait);
  }
  const body = await readLimited(req, 64 * 1024);
  if (body === null) return text(res, 413, 'Payload too large');
  if (!gates.whep.enter()) return busy(res, 2);
  try {
    const headers = { 'X-Forwarded-For': ip, 'Content-Length': body.length };
    for (const h of ['content-type', 'if-match']) if (req.headers[h]) headers[h] = req.headers[h];
    // On-demand renditions wait until their encoder delivers a keyframe, hence the long timeout.
    const up = await upstream(cfg.mediamtx.webrtc, req.method, req.url.split('?')[0], { headers, body, timeoutMs: 20000 });
    const data = await readBody(up, 256 * 1024);
    const extra = { ...noStore };
    if (up.headers.location) extra.Location = up.headers.location.startsWith('/') ? up.headers.location : new URL(up.headers.location, 'http://x' + req.url).pathname;  // stay on the relay
    for (const [h, name] of [['etag', 'ETag'], ['link', 'Link'], ['accept-patch', 'Accept-Patch']]) if (up.headers[h]) extra[name] = up.headers[h];
    send(res, up.statusCode, up.headers['content-type'] || '', data, extra);
    if (req.method === 'POST') log('info', `WHEP /${path}${quality ? '/' + quality : ''} from ${ip} -> ${up.statusCode}`);
  } catch (error) {
    log('warn', 'WHEP upstream failed: ' + error.message, 'whep-up');
    // Relay MediaMTX restarting (refused/timed out): a short wait the UI honours, not a hard failure.
    busy(res, 2, 'Media server is restarting');
  } finally { gates.whep.leave(); }
}

// An HLS viewer is MediaMTX's hlsSession cookie (set on its first playlist answer, after the cookieCheck redirect), or
// address + browser for a client that keeps no cookies.
const cookieValue = (header, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]{1,200})`).exec(String(header || ''))?.[1] || '';
const hlsKey = (req, ip) => {
  const session = cookieValue(req.headers.cookie, 'hlsSession');
  return session ? 's:' + session : 'a:' + createHash('sha256').update(ip + ' ' + (req.headers['user-agent'] || '')).digest('base64').slice(0, 16);
};

async function hls(req, res, m, ip) {
  const [, path, variant, file] = m;
  if (!cfg.hls) return text(res, 404, 'Not found');
  const s = await current(path);
  if (!s.ready) return s.waiting ? busy(res, 2, 'Media is not ready yet') : text(res, 404, 'Stream is not running', noStore);
  if (variant === 'aac' ? !cfg.hlsAac : variant && !renditions(s.entry, s.p, s.paths).some(r => r.name === variant)) return text(res, 404, 'Not found', noStore);
  // A client already playing is never cut off by the cap; a new one counts against it like a WebRTC viewer.
  const key = hlsKey(req, ip);
  if (!hlsViewers.has(path, key) && overCap(path, s.paths, res)) return;
  if (hlsPerIp.get(ip) >= cfg.limits.hlsPerIp) return busy(res, 2, 'Too many HLS requests from this address');
  if (!gates.hls.enter()) return busy(res, 2);
  hlsPerIp.add(ip, 1);
  const mtxPath = variant ? `${path}/${variant}` : path, query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  try {
    // LL-HLS blocking playlist reloads are held by MediaMTX until the next part exists; MediaMTX's session cookie passes through.
    const up = await upstream(cfg.mediamtx.hls, 'GET', `/${mtxPath}/${file}${query}`, { headers: req.headers.cookie ? { Cookie: req.headers.cookie } : {}, timeoutMs: 15000, agent: hlsAgent });
    const extra = {};
    for (const [h, name] of [['content-type', 'Content-Type'], ['cache-control', 'Cache-Control'], ['content-length', 'Content-Length'], ['set-cookie', 'Set-Cookie']]) if (up.headers[h]) extra[name] = up.headers[h];
    if (up.headers.location) extra.Location = up.headers.location.replace(`/${mtxPath}/`, `/${mtxPath}/hls/`);  // MediaMTX's cookie-check redirect
    const issued = (up.headers['set-cookie'] || []).map(c => cookieValue(c, 'hlsSession')).find(Boolean);
    // A new session cookie replacing the one the client sent is the same viewer, not a second one.
    if (issued) { if (key !== 's:' + issued) hlsViewers.delete(path, key); hlsViewers.touch(path, 's:' + issued); }
    else if (up.statusCode === 200 && (key.startsWith('s:') || !up.headers['set-cookie'])) hlsViewers.touch(path, key);
    res.writeHead(up.statusCode, { ...base, ...extra });
    if (req.method === 'HEAD') { up.destroy(); res.end(); return; }
    await new Promise(resolve => pipeline(up, res, error => { if (error) res.destroy(); resolve(); }));
  } catch (error) {
    log('warn', 'HLS upstream failed: ' + error.message, 'hls-up');
    if (!res.headersSent) busy(res, 2, 'Media server is restarting'); else res.destroy();
  } finally { gates.hls.leave(); hlsPerIp.add(ip, -1); }
}

async function dvrMedia(req, res, path, url, ip) {
  const wait = limits.dvr.take(ip);
  if (wait) return limited(res, wait);
  if (dvrPerIp.get(ip) >= cfg.limits.dvrPerIp) return busy(res, 2, 'Too many recording downloads from this address');
  const s = await current(path);
  const q = url.searchParams, num = v => (v !== null && /^-?[0-9.]{1,32}$/.test(v) ? Number(v) : NaN);
  const [status, target] = dvr.target(path, s.entry, s.live, q.get('id') || '', num(q.get('start')), num(q.get('duration')));
  if (status) return json(res, status, { error: target });
  if (!gates.dvr.enter()) return busy(res, 2);
  dvrPerIp.add(ip, 1);
  try {
    // Below the front proxy's response_header_timeout (Caddyfile.example: 45 s), so the relay answers first.
    const up = await upstream(cfg.mediamtx.playback, 'GET', target, { timeoutMs: 20000 });
    if (up.statusCode !== 200) {
      up.resume();
      // 404: nothing recorded at that time yet (past the live edge) or a gap where the publisher was away.
      const code = up.statusCode === 404 ? 404 : 502;
      if (code === 502) log('warn', `DVR chunk failed (${up.statusCode})`, 'dvr-up');
      return json(res, code, { error: code === 404 ? 'no-data' : 'upstream' });
    }
    // Chunked: a transfer that breaks off upstream reaches the browser as an error (no final chunk), never as a shorter
    // but apparently complete file, exactly as the native server does.
    res.writeHead(200, { ...base, 'Content-Type': 'video/mp4', ...noStore });
    if (req.method === 'HEAD') { up.destroy(); res.end(); return; }
    await new Promise(resolve => pipeline(up, res, error => { if (error) { res.destroy(); log('warn', 'DVR chunk interrupted: ' + error.code, 'dvr-cut'); } resolve(); }));
  } catch (error) {
    if (!res.headersSent) json(res, 502, { error: 'upstream' }); else res.destroy();
    log('warn', 'DVR upstream failed: ' + error.message, 'dvr-up');
  } finally { gates.dvr.leave(); dvrPerIp.add(ip, -1); }
}

// Publisher requests (announce, thumbnail): the per-address limits run before the token is compared, so while an address
// is limited a correct token is refused exactly like a wrong one and guessing gains nothing. Returns the token index, or
// -1 after answering.
function publisher(req, res, ip, what) {
  let wait = limits.publishIp.take(ip) || limits.authFail.peek(ip);
  if (wait) { limited(res, wait); return -1; }
  const token = tokenIndex(cfg.tokens, req.headers.authorization);
  if (token < 0) {
    limits.authFail.take(ip);
    log('warn', `${what} with a missing or wrong token from ${ip}`, 'auth ' + ip);
    text(res, 401, 'Publisher token required', { 'WWW-Authenticate': 'Bearer realm="frame-relay"' });
    return -1;
  }
  wait = limits.announce.take('t' + token);
  if (wait) { limited(res, wait); return -1; }
  return token;
}

async function announce(req, res, ip) {
  if (req.method !== 'POST') return text(res, 405, 'Method not allowed');
  const token = publisher(req, res, ip, 'announce');
  if (token < 0) return;
  const body = await readLimited(req, 4096);
  if (body === null) return text(res, 413, 'Payload too large');
  let message;
  try { message = JSON.parse(body.toString('utf8')); } catch { return text(res, 400, 'Bad request'); }
  const [status, reason, ignored] = registry.announce(message, token);
  if (status !== 204) {
    log('info', `announce refused (${status} ${reason}) from ${ip}`, `ann ${ip} ${reason}`);
    return text(res, status, reason, status === 503 ? { 'Retry-After': '30' } : {});
  }
  const path = message.type === 'announce' ? message.item.path : '';
  const ready = path ? !!(await mtx.list()).get(path)?.ready : false;
  // The sender can tell "listed" from "announced but no media reaches the relay" without any extra endpoint, and sees
  // which optional fields were dropped as invalid.
  send(res, 204, '', '', { 'X-Frame-Media-Ready': ready ? '1' : '0', ...(ignored?.length ? { 'X-Frame-Ignored': ignored.join(',') } : {}) });
}

async function thumbnailUpload(req, res, id, ip) {
  if (req.method !== 'PUT' && req.method !== 'POST') return text(res, 405, 'Method not allowed');
  const token = publisher(req, res, ip, 'thumbnail');
  if (token < 0) return;
  if (!/^image\/jpeg\b/i.test(req.headers['content-type'] || '')) return text(res, 415, 'image/jpeg required');
  const body = await readLimited(req, 256 * 1024);
  if (body === null) return text(res, 413, 'Thumbnail larger than 256 KB');
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) return text(res, 400, 'Not a JPEG image');
  const status = registry.setThumbnail(id, token, body);
  if (status === 204) send(res, 204); else text(res, status, status === 404 ? 'Unknown broadcast' : 'Not your broadcast');
}

// Playback report from a viewer page (navigator.sendBeacon: text/plain; or fetch with application/json), <= 2 KB,
// one per page every 4 s. Anonymous: no address is stored; see lib/stats.mjs for the CSV columns.
async function statsReport(req, res, path, ip) {
  if (req.method !== 'POST') return text(res, 405, 'Method not allowed');
  let wait = limits.stats.take(ip);
  if (wait) return limited(res, wait);
  if (!/^(application\/json|text\/plain)\b/i.test(req.headers['content-type'] || '')) return text(res, 415, 'application/json or text/plain required');
  const body = await readLimited(req, 2048);
  if (body === null) return text(res, 413, 'Report larger than 2 KB');
  if (!registry.known(path)) return text(res, 404, 'Stream is not running', noStore);
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch { return text(res, 400, 'Bad request'); }
  const { row, session, error } = statsRow(path, value);
  if (!row) return text(res, 400, error);
  wait = limits.statsClient.take(ip + ' ' + session);
  if (wait) return limited(res, wait);
  if (stats.enabled) {
    try { await stats.append(row); }
    catch (e) { log('warn', 'playback stats not written: ' + e.message, 'stats-write'); }
  }
  send(res, 204, '', '', noStore);
}

async function handle(req, res) {
  const ip = clientIp(req, cfg.trustedProxies);
  if (req.socket.overLimit) return text(res, 503, 'Server busy', { ...noStore, 'Retry-After': '5', Connection: 'close' });
  const url = new URL(req.url, 'http://relay');
  const path = url.pathname, head = req.method === 'HEAD', get = req.method === 'GET' || head;
  let m;
  if ((m = R.whep.exec(path))) return whep(req, res, m, ip);
  if (req.method === 'OPTIONS') return send(res, 204, '', '', { 'Access-Control-Max-Age': '600' });
  if (path === '/api/broadcasts/announce') return announce(req, res, ip);
  if ((m = R.thumbUpload.exec(path))) return thumbnailUpload(req, res, m[1], ip);
  if ((m = R.stats.exec(path))) return statsReport(req, res, m[1], ip);
  if (!get) return text(res, 405, 'Method not allowed');
  if (path === '/healthz') {
    const paths = await mtx.list();
    const entries = registry.all();
    return json(res, mtx.ok ? 200 : 503, { ok: mtx.ok, version: VERSION, mediamtx: mtx.ok, mediamtxListStale: mtx.stale, broadcasts: entries.length,
      receiving: entries.filter(e => paths.get(e.path)?.ready).length, hlsViewers: entries.reduce((n, e) => n + hlsViewers.size(e.path), 0),
      chatClients: hub.count, sockets, statsRows: stats.written, uptimeS: Math.round(process.uptime()) });
  }
  if (path === '/api/broadcasts') {
    const paths = await mtx.list(), origin = publicBase(req);
    const items = registry.all().filter(e => paths.get(e.path)?.ready).map(e => {
      observe(e, paths.get(e.path));
      return { id: e.id, title: e.title, publisher: e.publisher, baseUrl: origin, path: e.path, thumbnailUrl: `${origin}/thumbnails/${e.id}.jpg`,
        width: e.width || paths.get(e.path).width, height: e.height || paths.get(e.path).height, fps: e.fps, running: true, startedAtMs: e.startedAtRelayMs };
    });
    return json(res, 200, { items });
  }
  if ((m = R.thumb.exec(path))) {
    const e = registry.get(m[1]);
    if (!e || !e.thumbnail) return text(res, 404, 'Not found', noStore);
    return send(res, 200, 'image/jpeg', e.thumbnail, { 'Cache-Control': 'max-age=4' });
  }
  if ((m = R.hls.exec(path))) return hls(req, res, m, ip);
  if ((m = R.info.exec(path))) {
    const s = await current(m[1]);
    return json(res, 200, viewerInfo(m[1], s), s.waiting ? { 'Retry-After': '2' } : {});
  }
  if ((m = R.dvr.exec(path))) { const s = await current(m[1]); return json(res, 200, await dvr.index(m[1], s.entry, s.live)); }
  if ((m = R.dvrMedia.exec(path))) return dvrMedia(req, res, m[1], url, ip);
  if ((m = R.chat.exec(path))) return text(res, 400, 'WebSocket upgrade required');
  if ((m = R.font.exec(path))) {
    try { return send(res, 200, m[2] === 'OFL.txt' ? 'text/plain; charset=utf-8' : 'font/woff2', await readFile(join(cfg.fontsDir, m[2])), { 'Cache-Control': 'max-age=86400' }); }
    catch { return text(res, 404, 'Not found'); }
  }
  if (path === '/' || R.page.test(path)) {
    try { return send(res, 200, 'text/html; charset=utf-8', await uiPage(), { ...noStore, 'X-Frame-Options': 'DENY' }); }
    catch { return text(res, 404, 'UI files are missing'); }
  }
  return text(res, 404, 'Not found');
}

// ---- chat upgrade -------------------------------------------------------------------------------------------------
function refuseUpgrade(socket, status, message, extra = {}) {
  const reason = { 400: 'Bad Request', 404: 'Not Found', 426: 'Upgrade Required', 429: 'Too Many Requests', 503: 'Service Unavailable' }[status] || 'Error';
  const headers = Object.entries({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(message), Connection: 'close', ...extra }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${headers}\r\n${message}`);
}
function upgrade(req, socket, head) {
  socket.on('error', () => socket.destroy());
  const ip = clientIp(req, cfg.trustedProxies);
  const m = R.chat.exec(new URL(req.url, 'http://relay').pathname);
  if (!m) return refuseUpgrade(socket, 404, 'Not found');
  const bad = handshakeError(req);
  if (bad) return refuseUpgrade(socket, bad[0], bad[1], bad[0] === 426 ? { 'Sec-WebSocket-Version': '13' } : {});
  if (socket.overLimit || hub.count >= cfg.limits.chat) { log('warn', 'chat connection limit reached', 'chat-cap'); return refuseUpgrade(socket, 503, 'Chat is full', { 'Retry-After': '10' }); }
  if (chatPerIp.get(ip) >= cfg.limits.chatPerIp) return refuseUpgrade(socket, 503, 'Too many chat connections from this address', { 'Retry-After': '10' });
  const wait = limits.chatConnect.take(ip);
  if (wait) return refuseUpgrade(socket, 429, 'Too many requests', { 'Retry-After': String(wait) });
  if (!registry.byPath(m[1])) return refuseUpgrade(socket, 404, 'Stream is not running');
  chatPerIp.add(ip, 1);
  hub.attach(m[1], ip, ({ onText, onClose }) => new WebSocketConnection(req, socket, head, { onText, onClose: () => { chatPerIp.add(ip, -1); onClose(); } }));
}

// ---- server -------------------------------------------------------------------------------------------------------
let sockets = 0;
const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    log('error', `${req.method} ${req.url.split('?')[0]}: ${error.stack || error.message}`, 'err ' + error.message);
    if (!res.headersSent) text(res, 500, 'Internal error'); else res.destroy();
  });
});
// Over the socket limit a connection is still answered (503 + Retry-After, then closed), never silently dropped.
server.on('connection', socket => {
  sockets++;
  socket.overLimit = sockets > cfg.limits.sockets;
  socket.on('close', () => sockets--);
});
server.on('upgrade', upgrade);
server.on('clientError', (error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); });
// Idle keep-alive outlives the proxy's own idle pool (Caddy keepalive 60s), so the proxy never reuses a socket Node just closed.
server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 65000; server.timeout = 120000; server.maxHeadersCount = 64;

// Keep the MediaMTX view (and each broadcast's DVR start) current even when nobody is watching.
setInterval(async () => {
  if (!registry.entries.size) return;
  const paths = await mtx.list();
  for (const e of registry.entries.values()) { const p = paths.get(e.path); if (p?.ready) observe(e, p); }
}, 2000).unref();

server.listen(cfg.port, cfg.host, () => {
  log('info', `FRAME relay ${VERSION} listening on ${cfg.host}:${cfg.port}; UI ${cfg.uiFile}; ${cfg.tokens.length} publisher token(s); renditions [${cfg.renditions.map(r => r.name).join(',')}]; DVR ${cfg.dvr ? 'on' : 'off'}; HLS ${cfg.hls ? 'on' : 'off'}${cfg.hlsAac ? ' (+AAC)' : ''}; media grace ${cfg.mediaGraceMs} ms; playback stats ${stats.enabled ? cfg.stats.dir : 'not stored (RELAY_STATS_DIR unset)'}`);
  if (!cfg.tokens.length) log('warn', 'no publisher token configured: every announcement will be refused');
  const any = cfg.tokenPaths.filter(p => !p).length;
  if (any) log('warn', `${any} publisher token(s) may announce any path ("*"): give each sender its own path(s) in production`);
  mtx.list().catch(() => {});
});
function shutdown() {
  log('info', 'shutting down');
  server.close();
  for (const c of hub.clients) c.ws.close(1001);
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
