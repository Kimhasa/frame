// Stand-in for FRAME Console's viewer server (native/src/http_server.cpp + chat.cpp) in front of a standalone MediaMTX.
// It answers the same URLs with the same message shapes so the load runner's media, chat and DVR clients and the real
// viewer UI can be exercised without the app. It is a protocol stand-in for testing the tools: its numbers say nothing
// about the C++ server's capacity (thread per connection and the connection / request / chat limits are only imitated,
// with the app's "503 Busy + Retry-After" answers). GET /api/stats follows the app statistics contract (v 1): per path
// ready/readers/bytes, WebRTC session count and cumulative bytes, HTTP threads/requests/refused, chat clients/refused,
// HLS viewer sessions. With o.hls it also serves the app's HLS contract: live.m3u8 (built like Streamer::HlsMultivariant),
// /<path>[/<q>]/hls/<file> through one shared MediaMTX session per path (the relay's lib/hls.mjs, so no cookie reaches a
// client), /<path>/session (POST/PUT/DELETE, optional cap) and /assets/js (hls.js for the real page). Unlike the app it
// keeps HLS connections alive by default (o.hlsConnection 'close' sends Connection: close like http_server.cpp).
import { createServer } from 'node:http';
import { pipeline } from 'node:stream';
import { UpstreamHls, ViewerSessions, avcLevelIdc, hlsParams } from '../../../server/lib/hls.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repo } from './common.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(opcode, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | opcode, p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([head, p]);
}

// Client frames are masked; returns [frames, rest] or null on a protocol violation (unmasked or oversized, as chat.cpp).
function wsParse(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 0x7f, pos = off + 2;
    if (!(b1 & 0x80)) return null;
    if (len === 126) { if (buf.length < pos + 2) break; len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { if (buf.length < pos + 8) break; len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
    if (len > 16 * 1024) return null;
    if (buf.length < pos + 4 + len) break;
    const mask = buf.subarray(pos, pos + 4), payload = Buffer.from(buf.subarray(pos + 4, pos + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload });
    off = pos + 4 + len;
  }
  return [frames, buf.subarray(off)];
}

export function startShim(o) {
  // Limits default to the app source of 2026-10-28 (http_server.cpp kMaxThreads 2600 / kMaxRequests 400, chat.cpp kMaxClients 2000).
  // chatNames 'app': a name is taken only when another machine holds it (ChatHub::NameTaken; every loopback socket is one
  // machine, so a single generator PC never collides); 'strict': every socket is its own machine (collisions show locally).
  const { port, bind = '127.0.0.1', path, webrtcPort, playbackPort, apiPort, maxHttp = 2600, maxRequests = 400, maxChat = 2000, chatNames = 'app' } = o;
  const broadcastId = randomBytes(16).toString('hex');
  const startedAtMs = Date.now();
  const clients = new Set();
  const history = [];
  let nextMessage = 0, active = 0, inflight = 0, dvrCache = null, dvrCacheAt = 0, socketSeq = 0;
  const stats = { http: 0, httpRejected: 0, requestRejected: 0, chatRejected: 0, chatPeak: 0, chatNameTaken: 0, whep: 0, dvrIndex: 0, dvrMedia: 0, apiStats: 0 };
  const hlsUp = o.hls ? new UpstreamHls(`http://127.0.0.1:${o.hlsPort}`, () => { stats.hlsUpstreamWarnings++; }) : null;
  const sessions = new ViewerSessions({ activeMs: 30000, perIp: 1e9 });
  Object.assign(stats, { hlsPlaylists: 0, hlsMedia: 0, hlsUpstreamWarnings: 0, sessionsOpened: 0, sessionsRefused: 0 });
  const busy = (seconds, body = 'Busy') => `HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${seconds}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`;

  // /api/stats: counters are cumulative since the shim started. MediaMTX lists only open WebRTC sessions, so the bytes of
  // closed sessions are kept from their last poll (bytes after that last poll are missed: a small undercount).
  const sessionBytes = new Map();
  let closedSent = 0, closedRecv = 0, statsCache = null, statsAt = 0, statsBusy = null;
  async function appStats() {
    if (statsCache && Date.now() - statsAt < 500) return statsCache;
    if (statsBusy) return statsBusy;
    statsBusy = (async () => {
      const api = `http://127.0.0.1:${apiPort}`;
      const paths = {};
      const pl = await (await fetch(`${api}/v3/paths/list?itemsPerPage=1000`, { signal: AbortSignal.timeout(3000) })).json();
      for (const p of pl.items || []) paths[p.name] = { ready: !!p.ready, readers: (p.readers || []).length, bytesReceived: p.inboundBytes ?? p.bytesReceived ?? 0, bytesSent: p.outboundBytes ?? p.bytesSent ?? 0 };
      const seen = new Set();
      let sent = 0, recv = 0;
      for (let page = 0, pages = 1; page < pages; page++) {
        const r = await (await fetch(`${api}/v3/webrtcsessions/list?itemsPerPage=1000&page=${page}`, { signal: AbortSignal.timeout(3000) })).json();
        pages = r.pageCount || 1;
        for (const s of r.items || []) {
          const b = { out: s.outboundBytes ?? s.bytesSent ?? 0, in: s.inboundBytes ?? s.bytesReceived ?? 0 };
          seen.add(s.id); sessionBytes.set(s.id, b); sent += b.out; recv += b.in;
        }
      }
      for (const [id, b] of sessionBytes) if (!seen.has(id)) { closedSent += b.out; closedRecv += b.in; sessionBytes.delete(id); }
      // mediaDiscardWarnings: target MediaMTX "reader is too slow, discarding N frames" lines (as streamer.cpp counts them).
      statsCache = { v: 1, timeMs: Date.now(), running: true, paths, webrtc: { sessions: seen.size, bytesSent: sent + closedSent, bytesReceived: recv + closedRecv },
        mediaDiscardWarnings: typeof o.discardWarnings === 'function' ? o.discardWarnings() : 0,
        http: { threads: active, requests: inflight, refused: stats.httpRejected + stats.requestRejected },
        chat: { clients: clients.size, joined: [...clients].filter(c => c.joined).length, refused: stats.chatRejected }, hls: { sessions: sessions.total } };
      statsAt = Date.now();
      return statsCache;
    })().finally(() => { statsBusy = null; });
    return statsBusy;
  }
  const ui = join(repo, 'dist', 'FrameConsole', 'ui');

  const info = () => ({ running: true, path, width: o.width, height: o.height, fps: o.fps, bitrate: o.mbps, audio: 'system', codec: 'H.264',
    elapsedMs: Date.now() - startedAtMs, startedAtMs, broadcastId, dvr: !!o.record, title: '부하 시험 대상', publisher: 'load-target',
    renditions: (o.renditionList || []).map(r => ({ name: r.name, width: r.width, height: r.height, mbps: r.mbps, fps: o.fps, codec: 'H.264' })), iceServers: [],
    ...(o.hls ? { hls: { master: 'live.m3u8', lowLatency: true, audio: o.audio === 'none' ? 'none' : 'aac', dvr: null } } : {}), audio: o.audio === 'none' ? 'none' : 'system' });

  // live.m3u8 as Streamer::HlsMultivariant: source first, then the qualities high to low; BANDWIDTH = configured rate +
  // AAC (CBR clip: AVERAGE-BANDWIDTH the same); CODECS level from size, rate and bitrate; the AAC rendition per quality.
  function liveMaster(quality) {
    const aac = o.audio !== 'none' && o.audio !== 'opus';
    const list = [{ name: 'source', prefix: '', width: o.width, height: o.height, mbps: o.mbps }, ...[...(o.renditionList || [])].sort((a, b) => b.height - a.height).map(r => ({ ...r, prefix: r.name + '/' }))]
      .filter(e => !quality || quality === e.name);
    if (!list.length) return '';
    const out = ['#EXTM3U', '#EXT-X-VERSION:9', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const e of list) {
      const bw = Math.round(e.mbps * 1e6 + (aac ? 128000 : 0)), group = `aac-${e.name}`;
      if (aac) out.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${group}",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${e.prefix}hls/audio3_stream.m3u8"`);
      out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${bw},RESOLUTION=${e.width}x${e.height},FRAME-RATE=${Number(o.fps).toFixed(3)},CODECS="avc1.6400${avcLevelIdc(e.width, e.height, o.fps, e.mbps).toString(16).padStart(2, '0')}${aac ? ',mp4a.40.2' : ''}"${aac ? `,AUDIO="${group}"` : ''}`, `${e.prefix}hls/video1_stream.m3u8`);
    }
    return out.join('\n') + '\n';
  }
  const hlsHeaders = extra => ({ 'Access-Control-Allow-Origin': '*', ...(o.hlsConnection === 'close' ? { Connection: 'close' } : {}), ...extra });
  function sendHls(res, code, type, body, extra = {}) {
    const data = Buffer.from(body ?? '');
    res.writeHead(code, hlsHeaders({ 'Content-Type': type, 'Content-Length': data.length, ...extra }));
    res.end(data);
  }
  async function hls(req, res, mtxPath, file, q) {
    const params = hlsParams(q);
    if (file.endsWith('.m3u8')) {
      stats.hlsPlaylists++;
      const r = await hlsUp.playlist(mtxPath, file, params);
      if (r.status !== 200) return sendHls(res, r.status === 404 ? 404 : 502, 'text/plain; charset=utf-8', r.status === 404 ? 'Not found' : 'Upstream error', { 'Cache-Control': 'no-store' });
      return sendHls(res, 200, r.type || 'application/vnd.apple.mpegurl', r.body, { 'Cache-Control': 'max-age=1' });
    }
    stats.hlsMedia++;
    const r = await hlsUp.media(mtxPath, file, params);
    if (r.status !== 200) return sendHls(res, r.status === 404 ? 404 : 502, 'text/plain; charset=utf-8', r.status === 404 ? 'Not found' : 'Upstream error', { 'Cache-Control': 'no-store' });
    const up = r.res;
    res.writeHead(200, hlsHeaders({ 'Content-Type': up.headers['content-type'] || 'video/mp4', 'Cache-Control': 'public, max-age=60', ...(up.headers['content-length'] ? { 'Content-Length': up.headers['content-length'] } : {}) }));
    if (req.method === 'HEAD') { up.destroy(); return res.end(); }
    await new Promise(resolve => pipeline(up, res, () => resolve()));
  }
  // POST /<path>/session -> {sid, heartbeatMs} (503 + Retry-After past o.sessionCap); PUT/DELETE /<path>/session/<sid> -> 204 | 404.
  function session(req, res, sid) {
    const ip = String(req.socket.remoteAddress || '');
    if (sid) {
      if (req.method !== 'PUT' && req.method !== 'DELETE') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return send(res, sessions.touch(path, sid, ip, ip, req.method === 'DELETE') ? 204 : 404, '', '', { 'Cache-Control': 'no-store' });
    }
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if (o.sessionCap > 0 && sessions.size(path) >= o.sessionCap) { stats.sessionsRefused++; return send(res, 503, 'application/json; charset=utf-8', JSON.stringify({ error: 'busy' }), { 'Retry-After': '5', 'Cache-Control': 'no-store' }); }
    stats.sessionsOpened++;
    return json(res, 200, { sid: sessions.open(path, ip, ip), heartbeatMs: 15000 });
  }

  function send(res, code, type, body, extra = {}) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    res.writeHead(code, { ...(type ? { 'Content-Type': type } : {}), 'Content-Length': data.length, Connection: 'close', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, If-Match, Range',
      'Access-Control-Expose-Headers': 'Location, ETag, Link, Accept-Patch', ...extra });
    res.end(data);
  }
  const json = (res, code, value) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(value), { 'Cache-Control': 'no-store' });

  async function body(req) { const parts = []; for await (const p of req) parts.push(p); return Buffer.concat(parts); }

  async function whep(req, res, upstreamPath) {
    stats.whep++;
    const headers = {};
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers['if-match']) headers['If-Match'] = req.headers['if-match'];
    try {
      const r = await fetch(`http://127.0.0.1:${webrtcPort}${upstreamPath}`, { method: req.method, headers, body: req.method === 'DELETE' ? undefined : await body(req), signal: AbortSignal.timeout(20000) });
      const extra = { 'Cache-Control': 'no-store' };
      for (const [name, header] of [['location', 'Location'], ['etag', 'ETag'], ['link', 'Link'], ['accept-patch', 'Accept-Patch']]) {
        let v = r.headers.get(name);
        if (!v) continue;
        if (name === 'location' && /^https?:/.test(v)) v = new URL(v).pathname;  // keep the client on this server (as http_server.cpp)
        extra[header] = v;
      }
      send(res, r.status, r.headers.get('content-type') || '', Buffer.from(await r.arrayBuffer()), extra);
    } catch {
      send(res, 502, 'text/plain; charset=utf-8', 'Upstream error', { 'Cache-Control': 'no-store' });
    }
  }

  async function dvrIndex() {
    if (dvrCache && Date.now() - dvrCacheAt < 1000) return dvrCache;
    const ranges = [];
    try {
      const r = await fetch(`http://127.0.0.1:${playbackPort}/list?path=${path}`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) for (const e of await r.json()) { const s = Date.parse(e.start); if (Number.isFinite(s) && e.duration > 0) ranges.push({ startMs: s, endMs: s + e.duration * 1000 }); }
    } catch {}
    dvrCache = { running: true, id: broadcastId, dvr: true, recording: true, ranges, segments: [], gopMs: 1000, nowMs: Date.now() };
    dvrCacheAt = Date.now();
    return dvrCache;
  }

  async function dvrMedia(req, res, q) {
    stats.dvrMedia++;
    const start = Number(q.get('start')), duration = Number(q.get('duration'));
    if (q.get('id') !== broadcastId) return json(res, 409, { error: 'broadcast-changed' });
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < 200 || duration > 30000) return json(res, 400, { error: 'bad-range' });
    const target = `http://127.0.0.1:${playbackPort}/get?path=${path}&start=${encodeURIComponent(new Date(start).toISOString())}&duration=${(duration / 1000).toFixed(3)}&format=fmp4`;
    let r;
    try { r = await fetch(target, { signal: AbortSignal.timeout(30000) }); } catch { return json(res, 502, { error: 'upstream' }); }
    if (r.status !== 200) return json(res, r.status === 404 ? 404 : 502, { error: r.status === 404 ? 'no-data' : 'upstream' });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', Connection: 'close', 'Access-Control-Allow-Origin': '*' });
    try { for await (const chunk of r.body) res.write(chunk); res.end(); } catch { res.destroy(); }  // no final chunk on an upstream break
  }

  // Chat room, same messages as ChatHub (join -> state + history, name, send -> message to all + ack, 8 per 10 s).
  function chat(req, socket) {
    if (clients.size >= maxChat) { stats.chatRejected++; socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
    const key = req.headers['sec-websocket-key'];
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    const ip = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
    const machine = chatNames === 'strict' ? `socket-${++socketSeq}` : /^127\.|^::1$/.test(ip) ? 'local' : ip;
    const c = { socket, machine, joined: false, name: '', recent: [], open: true, send(obj) { if (this.open) socket.write(wsFrame(1, JSON.stringify(obj))); } };
    clients.add(c);
    stats.chatPeak = Math.max(stats.chatPeak, clients.size);
    socket.setTimeout(75000, () => socket.destroy());
    let buf = Buffer.alloc(0), text = '';
    socket.on('data', d => {
      const parsed = wsParse(Buffer.concat([buf, d]));
      if (!parsed) return socket.destroy();
      [, buf] = parsed;
      for (const f of parsed[0]) {
        if (f.opcode === 8) return socket.end(wsFrame(8, Buffer.from([3, 232])));
        if (f.opcode === 9) { socket.write(wsFrame(10, f.payload)); continue; }
        if (f.opcode === 10) continue;
        if (f.opcode === 1 || f.opcode === 0) { text += f.payload.toString('utf8'); if (f.fin) { handle(c, text); text = ''; } continue; }
        return socket.destroy();
      }
    });
    const close = () => { c.open = false; clients.delete(c); };
    socket.on('close', close);
    socket.on('error', close);
  }

  function handle(c, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'join') {
      if (msg.broadcastId !== broadcastId) { c.send({ type: 'state', connected: false, canSend: false, broadcastId: msg.broadcastId, error: '방송이 종료되었거나 다른 방송으로 바뀌었습니다.' }); return c.socket.end(); }
      c.joined = true;
      const name = typeof msg.name === 'string' ? msg.name.trim() : '';
      let nameError = '';
      if ([...name].length >= 1 && [...name].length <= 20) {
        if (nameTaken(name, c)) { nameError = '이미 사용 중인 이름입니다. 다른 이름을 설정하십시오.'; stats.chatNameTaken++; } else c.name = name;
      }
      c.send({ type: 'state', connected: true, canSend: true, broadcastId, displayName: c.name, error: nameError });
      c.send({ type: 'history', messages: history.slice(-100) });
      return;
    }
    if (!c.joined) return;
    if (msg.type === 'name') {
      const name = String(msg.name || '').trim().slice(0, 20);
      if (!name || nameTaken(name, c)) { if (name) stats.chatNameTaken++; return c.send({ type: 'name', ok: false, displayName: c.name, error: name ? '이미 사용 중인 이름입니다. 다른 이름을 설정하십시오.' : '이름을 확인하십시오.' }); }
      c.name = name;
      return c.send({ type: 'name', ok: true, displayName: c.name });
    }
    if (msg.type === 'send') {
      const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : '';
      const nack = error => c.send({ type: 'ack', clientId, ok: false, error });
      if (!c.name) return nack('이름을 먼저 설정하십시오.');
      const body = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!body || [...body].length > 1000) return nack('메시지를 확인하십시오.');
      const now = Date.now();
      c.recent = c.recent.filter(t => now - t <= 10000);
      if (c.recent.length >= 8) return nack('메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내십시오.');
      c.recent.push(now);
      const m = { type: 'message', id: `${broadcastId.slice(0, 8)}-${++nextMessage}`, broadcastId, author: c.name, text: body, ts: now };
      history.push(m);
      if (history.length > 200) history.shift();
      for (const other of clients) if (other.joined) other.send(m);
      c.send({ type: 'ack', clientId, ok: true, id: m.id });
    }
  }

  function nameTaken(name, except) {
    const wanted = name.toLowerCase();
    for (const other of clients) if (other !== except && other.joined && other.name && other.machine !== except.machine && other.name.toLowerCase() === wanted) return true;
    return false;
  }

  const pinger = setInterval(() => { for (const c of clients) if (c.open) c.socket.write(wsFrame(9, Buffer.alloc(0))); }, 25000);
  const esc = path.replace(/[-/]/g, '\\$&');
  const whepRe = new RegExp(`^/${esc}(/(?:240|360|480|720|1080|1440)p)?/whep(/[A-Za-z0-9_-]{1,128})?$`);
  const hlsRe = new RegExp(`^/${esc}(/(?:240|360|480|720|1080|1440)p)?/hls/([A-Za-z0-9_][A-Za-z0-9_.-]{0,79})$`);
  const sessionRe = new RegExp(`^/${esc}/session(?:/([0-9a-f]{32}))?$`);
  const scriptRe = /^(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\/assets\/js\/([A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:js|txt))$/;

  const server = createServer(async (req, res) => {
    stats.http++;
    // Ordinary requests in progress, as http_server.cpp RequestSlot (the request itself included).
    inflight++;
    res.once('close', () => inflight--);
    if (inflight > maxRequests) { stats.requestRejected++; return send(res, 503, 'text/plain; charset=utf-8', 'Busy', { 'Retry-After': '1', 'Cache-Control': 'no-store' }); }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/api/stats' && (req.method === 'GET' || req.method === 'HEAD')) {
      stats.apiStats++;
      try { return json(res, 200, await appStats()); } catch (e) { return json(res, 502, { error: 'stats-unavailable', detail: String(e.message).slice(0, 100) }); }
    }
    if (whepRe.test(p)) {
      if (req.method === 'OPTIONS') return send(res, 204, '', '', { 'Access-Control-Max-Age': '600' });
      if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return whep(req, res, p);
    }
    let m;
    if (o.hls && (m = sessionRe.exec(p)) && req.method !== 'OPTIONS') return session(req, res, m[1]);
    if (p === `/${path}/stats` && req.method === 'POST') { for await (const _ of req); return send(res, 204, '', ''); }  // the page's stats beacon
    if (req.method === 'OPTIONS') return send(res, 204, '', '');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if (o.hls && (m = hlsRe.exec(p))) {
      try { return await hls(req, res, path + (m[1] || ''), m[2], url.searchParams); } catch { if (!res.headersSent) return send(res, 502, 'text/plain; charset=utf-8', 'Upstream error'); return res.destroy(); }
    }
    if (o.hls && p === `/${path}/live.m3u8`) {
      const q = url.searchParams.get('q') || '';
      const body = /^(|source|(240|360|480|720|1080|1440)p)$/.test(q) ? liveMaster(q) : '';
      return body ? sendHls(res, 200, 'application/vnd.apple.mpegurl', body, { 'Cache-Control': 'max-age=1' }) : send(res, 404, 'text/plain; charset=utf-8', 'Quality is not available');
    }
    if ((m = scriptRe.exec(p)) && existsSync(join(ui, 'assets', 'js', m[1]))) return send(res, 200, m[1].endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8', readFileSync(join(ui, 'assets', 'js', m[1])), { 'Cache-Control': 'public, max-age=31536000, immutable' });
    if (p === '/api/broadcasts') return json(res, 200, [{ id: broadcastId, path, title: '부하 시험 대상', viewerUrl: `/${path}`, live: true }]);
    if (p === `/${path}/info`) return json(res, 200, info());
    if (p === `/${path}/dvr`) { stats.dvrIndex++; return json(res, 200, o.record ? await dvrIndex() : { running: true, id: broadcastId, dvr: false }); }
    if (p === `/${path}/dvr/media`) return o.record ? dvrMedia(req, res, url.searchParams) : json(res, 404, { error: 'no-dvr' });
    const font = p.match(/^(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\/assets\/fonts\/(PretendardVariable\.woff2|OFL\.txt)$/);
    if (font && existsSync(join(ui, 'assets', 'fonts', font[1]))) return send(res, 200, font[1].endsWith('.txt') ? 'text/plain; charset=utf-8' : 'font/woff2', readFileSync(join(ui, 'assets', 'fonts', font[1])), { 'Cache-Control': 'max-age=86400' });
    if ((p === '/' || /^\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/?$/.test(p)) && existsSync(join(ui, 'index.html'))) return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(ui, 'index.html')), { 'Cache-Control': 'no-store' });
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  });
  // Past the connection limit the app answers "503 Busy, Retry-After: 2" right after accept and closes (AcceptLoop).
  server.on('connection', s => { if (active >= maxHttp) { stats.httpRejected++; s.end(busy(2)); return; } active++; s.once('close', () => active--); });
  server.on('upgrade', (req, socket) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p !== `/${path}/chat` || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) return socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    chat(req, socket);
  });
  server.keepAliveTimeout = 65000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve({ broadcastId, stats, limits: { maxHttp, maxRequests, maxChat, chatNames }, chatClients: () => clients.size, close: () => { clearInterval(pinger); for (const c of clients) c.socket.destroy(); server.closeAllConnections?.(); server.close(); } }));
  });
}
