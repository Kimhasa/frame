// FRAME internet relay web service. Serves the unchanged viewer UI (outputs/index.html) and the viewer API the UI already
// uses against FrameConsole.exe (native/src/http_server.cpp), but backed by a relay MediaMTX on this server:
//   GET  /api/broadcasts                      public list (announced and actually receiving media)
//   POST /api/broadcasts/announce             publisher token; {"v":1,"type":"announce"|"bye",...}
//   PUT  /api/broadcasts/<id>/thumbnail       publisher token; image/jpeg <= 256 KB
//   GET  /thumbnails/<id>.jpg, /<path>/info, /<path>/dvr, /<path>/dvr/media, /healthz
//   GET  /<path>/live.m3u8[?q=]               HLS multivariant playlist (every browser viewer), the same as the app's
//   GET  /<path>[/<q>|/aac]/hls/<file>        LL-HLS playlists and media of MediaMTX (shared session, no cookie, CDN-safe)
//   GET  /<path>/dvr.m3u8, /<path>/dvr/file[.mp4]?id=&f=[&s=]   the broadcast's recording as HLS (EVENT), Range support
//   GET  [/<path>]/assets/js/<file>           player scripts shipped with the UI (hls.js)
//   POST /<path>/session, PUT|DELETE /<path>/session/<sid>   viewer sessions (counting and viewer cap)
//   /<path>/b/<broadcastId>/{live.m3u8, [<q>|src|aac/]hls/<file>, dvr, dvr.m3u8, dvr/file[.mp4], session[/<sid>]}
//                                             the same routes bound to one broadcast (409 once another one has the path)
//   POST|PATCH|DELETE /<path>[/<q>]/whep[/<session>]  proxied to MediaMTX WebRTC on loopback
//   POST /<path>/stats                        anonymous playback report (sendBeacon), appended to a daily CSV
//   WebSocket /<path>/chat                    chat protocol of native/src/chat.cpp
// The MediaMTX API, playback server, RTSP publish and any start/stop action are never reachable through this service.
// Not deployed since 2026-11-10: the deployed backend is apps/api (frame-api.jar, see deploy/README.md). This file stays as
// the comparison baseline of server/verify/*.mjs (--backend node, the default there), which start it with their own environment.
import http from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { readFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { loadConfig } from './lib/config.mjs';
import { clientIp, forwardedProto, RateLimit, Gate, Counter, ActiveSet } from './lib/limits.mjs';
import { Registry, tokenIndex } from './lib/registry.mjs';
import { MediaMtx, upstream, readBody } from './lib/mediamtx.mjs';
import { Dvr } from './lib/dvr.mjs';
import { buildRecordFragment, listedBytes } from './lib/fmp4.mjs';
import { UpstreamHls, ViewerSessions, avcCodec, avcLevelIdc, hlsParams, parseRange } from './lib/hls.mjs';
import { Ladders } from './lib/ladder.mjs';
import { ChatHub } from './lib/chat.mjs';
import { WebSocketConnection, handshakeError } from './lib/websocket.mjs';
import { StatsLog, statsRow } from './lib/stats.mjs';
import { matchScoped, binding, ownMedia, ownSource } from './lib/scope.mjs';

const VERSION = '0.3.0';
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
const upstreamHls = new UpstreamHls(cfg.mediamtx.hls, log);
const sessions = new ViewerSessions({ activeMs: cfg.sessionActiveMs, perIp: cfg.limits.sessionsPerIp });
// One quality ladder per watched broadcast (lib/ladder.mjs). Once a ladder's paths are published, each variant's HLS
// muxer is opened through the shared session, so a player's first switch to a quality does not wait for it.
const ladders = new Ladders(cfg.ladder, mtx, log, (path, names) => {
  for (const name of names) (async () => {
    upstreamHls.forget(name);  // a new ladder publishes new muxers: the previous shared sessions would only get 404
    for (let i = 0; i < 75; i++) {
      if ((await mtx.list()).get(name)?.ready) return upstreamHls.session(name).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  })();
});
const HEARTBEAT_MS = 15000;
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
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-Match, Range',
  'Access-Control-Expose-Headers': 'Location, ETag, Link, Accept-Patch, Retry-After, Content-Range, Content-Length, Accept-Ranges'
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
  // A publisher session older than the broadcast (the previous broadcast still publishing) must not open the window early,
  // and a later one of the same broadcast (a sender reconnect, then a relay restart re-creating the entry) must not move
  // it: the window opens at the broadcast's start, or at its first media when that came up to 10 s before the start (the
  // announced start's clock skew); the earlier broadcast on the path ended before this one started.
  const start = entry.startedAtRelayMs || Date.now();
  const ready = p.readyMs && p.readyMs >= start - 10000 ? Math.min(p.readyMs, start) : start;
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
// The qualities the relay's own ladder encodes for the broadcast (all of the above but those the sender publishes).
const ladderList = (entry, p, paths) => renditions(entry, p, paths).filter(r => paths.get(`${entry.path}/${r.name}`)?.sourceType !== 'rtspsSession');

// Relative to <origin>/<path>/: the Opus original, and the AAC copy (relay-side audio transcode) for browsers that play
// HLS natively but not Opus in fMP4 (iPhone Safari).
const hlsVariants = () => (cfg.hls ? { opus: 'hls/index.m3u8', ...(cfg.hlsAac ? { aac: 'aac/hls/index.m3u8' } : {}) } : {});

// The HLS audio of a broadcast. The app publishes Opus first (WebRTC) and AAC-LC second (HLS, recording): MediaMTX names
// the track playlists in publish order (video1, audio2 = Opus, audio3 = AAC), and the relay's lower qualities copy both.
// A sender without an AAC track (an older app) falls back to the relay's on-demand AAC transcode path "<path>/aac"
// (RELAY_HLS_AAC=1; video copied, first audio -> AAC, so its tracks are video1 + audio2) for the original quality only:
// the relay's lower qualities copy the sender's audio and have no AAC then. Without either, HLS is video only.
function hlsAudio(entry, s) {
  const tracks = (((s.ready ? s.p : entry.seen) || {}).tracks) || [];
  const aac = tracks.indexOf('MPEG-4 Audio');
  if (aac >= 0) return { kind: 'aac', track: `audio${aac + 1}_stream.m3u8`, prefix: '' };
  if (tracks.includes('Opus') && cfg.hlsAac) return { kind: 'transcode', track: 'audio2_stream.m3u8', prefix: 'aac/' };
  return { kind: 'none', prefix: '' };
}

const AAC_BPS = 128000;
// GET /<path>/live.m3u8[?q=]: the same multivariant playlist as the app's viewer server (Streamer::HlsMultivariant):
// per quality (source first, then the lower qualities high to low) an AAC rendition group and the video playlist,
// relative to /<path>/. BANDWIDTH: the configured rate (the sender's announced bitrate, the relay encoders' rate) + AAC.
// AVERAGE-BANDWIDTH: what the path really averaged since it became ready (a quality that has not run yet uses the
// source's measured share of its rate). CODECS: the real SPS from MediaMTX, else High at the level for WxH@fps.
// ?q= limits the list to one quality (Safari's native player, manual choice). No viewer-specific data in it.
function liveMaster(path, s, quality) {
  const { entry, p, paths } = s;
  const seen = (s.ready ? p : entry.seen) || {}, audio = hlsAudio(entry, s), withAudio = audio.kind !== 'none', fps = entry.fps || 0;
  const sourceMbps = entry.bitrate || (seen.mbps ? Math.round(seen.mbps * 10) / 10 : 8);
  const list = [];
  // With the relay's qualities, the source variant is the ladder's copy (src/, same clock as the qualities). While the
  // ladder keeps failing before it publishes (lib/ladder.mjs), the list is the one without a ladder: the source path
  // itself and only qualities the sender publishes, so viewers keep playing.
  const own = new Set(ladderList(entry, p, paths).map(r => r.name)), down = own.size > 0 && ladders.failing(path);
  const ladder = audio.kind !== 'transcode' && own.size > 0 && !down;
  // A player asking for one relay quality then (?q=480p: Safari's manual choice, also on its reconnect) gets the source
  // instead of a 404 that would end its playback while the source plays fine.
  if (!quality || quality === 'source' || (down && own.has(quality)))
    list.push({ name: 'source', prefix: ladder ? 'src/' : audio.prefix, measured: path, width: entry.width || seen.width || 0, height: entry.height || seen.height || 0, mbps: sourceMbps, props: seen.videoProps });
  if (audio.kind !== 'transcode') {
    for (const r of renditions(entry, p, paths)) {
      if ((quality && quality !== r.name) || (down && own.has(r.name))) continue;
      const rp = paths.get(`${path}/${r.name}`);
      list.push({ name: r.name, prefix: r.name + '/', measured: `${path}/${r.name}`, width: r.width, height: r.height, mbps: r.mbps, props: rp?.ready ? rp.videoProps : null });
    }
  }
  if (!list.length) return '';
  // Measured inbound rates include every audio track the path carries (estimated at 128 kb/s each).
  const audioBps = (seen.tracks || []).filter(t => t === 'Opus' || t === 'MPEG-4 Audio').length * 128000;
  const measuredVideo = name => { const m = paths.get(name); return m?.ready && m.avgMbps ? Math.max(0, m.avgMbps * 1e6 - audioBps) : 0; };
  const sourceVideo = measuredVideo(path), ratio = sourceVideo > 0 && sourceMbps > 0 ? Math.min(1, sourceVideo / (sourceMbps * 1e6)) : 0;
  const out = ['#EXTM3U', '#EXT-X-VERSION:9', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const e of list) {
    const peak = e.mbps * 1e6 + (withAudio ? AAC_BPS : 0);
    let video = measuredVideo(e.measured);
    if (!video && ratio) video = e.mbps * 1e6 * ratio;
    const average = video > 0 ? Math.min(peak, video + (withAudio ? AAC_BPS : 0)) : peak;
    const codec = avcCodec(e.props) || `avc1.6400${avcLevelIdc(e.width, e.height, fps, e.mbps).toString(16).padStart(2, '0')}`;
    const group = `aac-${e.name}`;
    if (withAudio) out.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${group}",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${e.prefix}hls/${audio.track}"`);
    const attrs = [`BANDWIDTH=${Math.round(peak)}`, `AVERAGE-BANDWIDTH=${Math.round(average)}`];
    if (e.width && e.height) attrs.push(`RESOLUTION=${e.width}x${e.height}`);
    if (fps) attrs.push(`FRAME-RATE=${fps.toFixed(3)}`);
    attrs.push(`CODECS="${codec}${withAudio ? ',mp4a.40.2' : ''}"`);
    if (withAudio) attrs.push(`AUDIO="${group}"`);
    out.push('#EXT-X-STREAM-INF:' + attrs.join(','), `${e.prefix}hls/video1_stream.m3u8`);
  }
  return out.join('\n') + '\n';
}

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
    // HLS for every browser viewer (relative to /<path>/): the multivariant live playlist, and the broadcast's recording
    // as an HLS EVENT playlist. scope: the prefix (relative to /<path>/) under which master, dvr and the session routes
    // answer for this broadcast only. hlsVariants: MediaMTX's own playlists, kept for older pages.
    ...(cfg.hls ? { hls: { master: 'live.m3u8', lowLatency: true, audio: hlsAudio(entry, s).kind === 'none' ? 'none' : 'aac', dvr: dvr.hlsAvailable() ? 'dvr.m3u8' : null, scope: `b/${entry.id}/` } } : {}),
    hlsVariants: hlsVariants(), iceServers: [...cfg.iceServers, ...turnCredentials()]
  };
}

// HLS viewers of a path: active viewer sessions, plus (fallback, RELAY_HLS_COUNT_WITHOUT_SESSION) clients that fetched
// HLS media within RELAY_HLS_ACTIVE_MS without holding a session (by address + browser; a session's own page is not
// counted twice).
function hlsCount(path) {
  let n = sessions.size(path);
  if (cfg.hlsCountWithoutSession) for (const key of hlsViewers.active(path)) if (!sessions.hasKey(path, key)) n++;
  return n;
}
// WHEP offers admitted on a path whose MediaMTX reader the cached path list may not show yet: counted for the cap, so a
// burst of offers within one list refresh cannot all pass the same count.
const whepPending = new Counter();
// MediaMTX adds the reader before it answers, so a list refresh begun after the answer shows it: the second successful
// refresh from now (refreshes never overlap). While the API is down none succeeds and the slot stays counted; after
// 30 s it is released anyway (by then the list is empty or fresh).
async function whepListed(path) {
  try {
    let at = mtx.goodAt, refreshes = 0;
    for (const until = Date.now() + 30000; refreshes < 2 && Date.now() < until;) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (mtx.goodAt !== at) { at = mtx.goodAt; refreshes++; }
    }
  } finally { whepPending.add(path, -1); }
}
// Viewers of a broadcast for the per-path cap: WebRTC sessions on the path and its renditions (MediaMTX readers, plus
// offers not listed yet) plus the HLS viewers above. Media requests themselves are never refused for the cap (identical
// answers for everyone, CDN).
function viewerCount(path, paths) {
  let webrtc = whepPending.get(path);
  for (const [name, v] of paths) if (name === path || name.startsWith(path + '/')) webrtc += v.webrtcReaders;
  return webrtc + hlsCount(path);
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
// Player scripts (a few files, versioned names): kept in memory, re-read when the file changes.
const scriptCache = new Map();
async function scriptFile(name) {
  const file = join(cfg.jsDir, name), hit = scriptCache.get(name);
  if (hit && Date.now() - hit.at < 5000) return hit.body;
  const st = await stat(file);
  const body = hit && hit.mtime === st.mtimeMs ? hit.body : await readFile(file);
  scriptCache.set(name, { at: Date.now(), mtime: st.mtimeMs, body });
  return body;
}

// ---- routes -------------------------------------------------------------------------------------------------------
const P = '([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})';
const R = {
  whep: new RegExp(`^/${P}(?:/((?:240|360|480|720|1080|1440)p))?/whep(/[A-Za-z0-9_-]{1,128})?$`),
  hls: new RegExp(`^/${P}(?:/((?:240|360|480|720|1080|1440)p|aac|src))?/hls/([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\\.(?:m3u8|mp4|m4s|ts))$`),
  live: new RegExp(`^/${P}/live\\.m3u8$`), session: new RegExp(`^/${P}/session(?:/([0-9a-f]{32}))?$`),
  page: new RegExp(`^/${P}/?$`),
  font: new RegExp(`^(?:/${P})?/assets/fonts/(PretendardVariable\\.woff2|OFL\\.txt)$`),
  script: new RegExp(`^(?:/${P})?/assets/js/([A-Za-z0-9][A-Za-z0-9_.-]{0,79}\\.(?:js|txt))$`),
  info: new RegExp(`^/${P}/info$`), dvr: new RegExp(`^/${P}/dvr$`), dvrMedia: new RegExp(`^/${P}/dvr/media$`),
  dvrPlaylist: new RegExp(`^/${P}/dvr\\.m3u8$`), dvrFile: new RegExp(`^/${P}/dvr/file(?:\\.mp4)?$`),
  chat: new RegExp(`^/${P}/chat$`), stats: new RegExp(`^/${P}/stats$`), thumb: /^\/thumbnails\/([0-9a-f]{32})\.jpg$/, thumbUpload: /^\/api\/broadcasts\/([0-9a-f]{32})\/thumbnail$/
};

async function whep(req, res, m, ip) {
  const [, path, quality, session] = m;
  if (req.method === 'OPTIONS') return send(res, 204, '', '', { 'Access-Control-Max-Age': '600' });
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method) || (req.method === 'POST' && session)) return text(res, 405, 'Method not allowed');
  const s = await current(path);
  // WHEP stays path-scoped. A page that names its broadcast (?b=<id>, the React viewer's WHEP fallback) is bound like the
  // /<path>/b/<id>/ routes: another broadcast on the path -> 409, nothing -> 404, and the media of a publisher session that
  // is not this broadcast's own (lib/scope.mjs ownSource) -> wait, so an old or early link never gets another broadcast.
  const named = req.method === 'POST' ? new URL(req.url, 'http://relay').searchParams.get('b') : null;
  if (named !== null && !/^[0-9a-f]{32}$/.test(named)) return text(res, 400, 'Bad broadcast id', noStore);
  let reserved = false;
  try {
    if (req.method === 'POST') {
      const unbound = named ? binding(s.entry, named) : null;
      if (unbound) return json(res, unbound[0], { error: unbound[1] }, noStore);
      // Media briefly away (sender reconnecting): 503 + Retry-After, which the UI waits out, instead of "not running".
      if (!s.ready) return s.waiting ? busy(res, 2, 'Media is not ready yet') : text(res, 404, 'Stream is not running', noStore);
      if (named && !ownSource(s.entry, s.p)) return busy(res, 2, 'Media is not ready yet');
      if (quality && !renditions(s.entry, s.p, s.paths).some(r => r.name === quality)) return text(res, 404, 'Quality is not available', noStore);
      if (overCap(path, s.paths, res)) return;
      const wait = limits.whep.take(ip);
      if (wait) return limited(res, wait);
      // Counted from here (before any await) until MediaMTX lists the reader, or released when no session results.
      whepPending.add(path, 1); reserved = true;
      // A relay quality is published by the broadcast's ladder: start it if needed and wait for the path.
      const ladder = quality ? ladderList(s.entry, s.p, s.paths) : [];
      if (ladder.some(r => r.name === quality) && !(await ladders.ensure(path, ladder, `${path}/${quality}`, 15000))) return busy(res, 2, 'Quality is starting');
    }
    const body = await readLimited(req, 64 * 1024);
    if (body === null) return text(res, 413, 'Payload too large');
    if (!gates.whep.enter()) return busy(res, 2);
    try {
      const headers = { 'X-Forwarded-For': ip, 'Content-Length': body.length };
      for (const h of ['content-type', 'if-match']) if (req.headers[h]) headers[h] = req.headers[h];
      // The validated route (m[0]: "/<path>[/<q>]/whep[/<session>]"), never the raw request-target: one like
      // "//host:port/..." or an absolute URL parses to the same pathname but would resolve to another origin.
      // On-demand renditions wait until their encoder delivers a keyframe, hence the long timeout.
      const up = await upstream(cfg.mediamtx.webrtc, req.method, m[0], { headers, body, timeoutMs: 20000 });
      if (reserved && up.statusCode === 201) { reserved = false; whepListed(path); }  // a session exists from here
      const data = await readBody(up, 256 * 1024);
      const extra = { ...noStore };
      if (up.headers.location) extra.Location = up.headers.location.startsWith('/') ? up.headers.location : new URL(up.headers.location, 'http://x' + m[0]).pathname;  // stay on the relay
      for (const [h, name] of [['etag', 'ETag'], ['link', 'Link'], ['accept-patch', 'Accept-Patch']]) if (up.headers[h]) extra[name] = up.headers[h];
      send(res, up.statusCode, up.headers['content-type'] || '', data, extra);
      if (req.method === 'POST') log('info', `WHEP /${path}${quality ? '/' + quality : ''} from ${ip} -> ${up.statusCode}`);
    } catch (error) {
      log('warn', 'WHEP upstream failed: ' + error.message, 'whep-up');
      // Relay MediaMTX restarting (refused/timed out): a short wait the UI honours, not a hard failure.
      busy(res, 2, 'Media server is restarting');
    } finally { gates.whep.leave(); }
  } finally { if (reserved) whepPending.add(path, -1); }
}

// The address + browser of a request (an older relay's MediaMTX hlsSession cookie when a browser still sends one): the
// fallback identity of an HLS client without a viewer session, and the key a session remembers for its own page.
const cookieValue = (header, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]{1,200})`).exec(String(header || ''))?.[1] || '';
const hlsKey = (req, ip) => {
  const session = cookieValue(req.headers.cookie, 'hlsSession');
  return session ? 's:' + session : 'a:' + createHash('sha256').update(ip + ' ' + (req.headers['user-agent'] || '')).digest('base64').slice(0, 16);
};

// Upstream status of an HLS request -> the viewer's answer (never MediaMTX's own body, cookie or redirect).
function hlsFailure(res, status) {
  if (status === 404) return text(res, 404, 'Not found', noStore);
  if (status === 0) return busy(res, 2, 'Media server is restarting');  // relay MediaMTX unreachable (restart): wait briefly
  return text(res, 502, 'Upstream error', noStore);
}
// Media of the path not playable right now: briefly away (sender reconnecting, relay MediaMTX restarting, or for a scoped
// request still the previous broadcast's publisher, or a publisher session the broadcast has not announced since: see
// lib/scope.mjs ownSource) -> 503 + Retry-After the player waits out; else not running.
const notReady = (res, s, scope = null) => (s.live ? busy(res, 2, 'Media is not ready yet') : notRunning(res, scope));
// Under a broadcast prefix "not running" is always 404 {"error":"not-running"}, so a player tells it from the plain 404 of
// a quality it does not have; the path routes keep their text answer.
const notRunning = (res, scope) => (scope ? json(res, 404, { error: 'not-running' }) : text(res, 404, 'Stream is not running', noStore));
// For a scoped request after a wait (encoder start, blocking reload, upstream answer, recording scan): true after answering
// 404/409 when broadcast `id` is no longer the one on `path`.
function changed(res, path, id) {
  const bad = binding(registry.byPath(path), id);
  if (bad) json(res, bad[0], { error: bad[1] });
  return !!bad;
}
// The same after waiting for live media: also true (after a 503 + Retry-After) when the source path now carries a publisher
// session that is not the broadcast's own (a new session began during the wait and has not been announced yet). Reads the
// last path list (refreshed by every viewer request, so about a second old at most) instead of a new lookup, which would
// hold an answer already received.
function moved(res, path, id) {
  if (changed(res, path, id)) return true;
  if (ownSource(registry.byPath(path), mtx.paths.get(path))) return false;
  busy(res, 2, 'Media is not ready yet');
  return true;
}

// LL-HLS of the broadcast (or one quality, or the AAC transcode) from the loopback MediaMTX, through one shared MediaMTX
// session per path and quality (lib/hls.mjs). Responses carry no viewer-specific data and no Set-Cookie: playlists
// max-age=1 (blocking reloads keyed by _HLS_msn/_HLS_part/_HLS_skip, the only query passed on), init/parts/segments
// public max-age=60 (their names are unique per MediaMTX muxer). The viewer cap is not applied here (POST /session).
// scope ({id, s}, the /<path>/b/<id>/ prefix): the state the binding was checked on; media of a publisher session that is
// not the broadcast's own (older than it, or not announced since) is "not ready yet", and after every wait the broadcast
// and its source session must still be the same.
async function hls(req, res, m, url, ip, scope = null) {
  const [, path, variant, file] = m;
  if (!cfg.hls) return text(res, 404, 'Not found', noStore);
  const s = scope ? scope.s : await current(path);
  if (!s.ready || (scope && !ownSource(s.entry, s.p))) return notReady(res, s, scope);
  const ladder = variant && variant !== 'aac' ? ladderList(s.entry, s.p, s.paths) : [];
  if (variant === 'aac' ? !cfg.hlsAac : variant === 'src' ? !ladder.length : variant && !renditions(s.entry, s.p, s.paths).some(r => r.name === variant)) return text(res, 404, 'Not found', noStore);
  // A quality path still published from the previous broadcast's source (its encoder has not restarted yet).
  if (scope && variant && !ownMedia(s.entry, s.paths.get(`${path}/${variant}`))) return busy(res, 2, 'Media is not ready yet');
  if (cfg.hlsCountWithoutSession) hlsViewers.touch(path, hlsKey(req, ip));
  if (hlsPerIp.get(ip) >= cfg.limits.hlsPerIp) return busy(res, 2, 'Too many HLS requests from this address');
  // The source copy and the relay's qualities come from the ladder (started here if needed; cheap once published).
  if (variant === 'src' || ladder.some(r => r.name === variant)) {
    const started = await ladders.ensure(path, ladder, `${path}/${variant}`, 15000);
    if (scope && moved(res, path, scope.id)) return;
    if (!started) return busy(res, 1, 'Quality is starting');
  }
  if (!gates.hls.enter()) return busy(res, 2);
  hlsPerIp.add(ip, 1);
  const mtxPath = variant ? `${path}/${variant}` : path, params = hlsParams(url.searchParams);
  try {
    if (file.endsWith('.m3u8')) {
      // Blocking reloads are held by MediaMTX until the requested part exists; identical ones share one upstream request.
      const r = await upstreamHls.playlist(mtxPath, file, params);
      if (scope && moved(res, path, scope.id)) return;
      if (r.status !== 200) return hlsFailure(res, r.status);
      return send(res, 200, r.type || 'application/vnd.apple.mpegurl', r.body, { 'Cache-Control': 'max-age=1' });
    }
    const r = await upstreamHls.media(mtxPath, file, params);
    if (scope && moved(res, path, scope.id)) { r.res?.destroy(); return; }
    if (r.status !== 200) return hlsFailure(res, r.status);
    const up = r.res, extra = { 'Content-Type': up.headers['content-type'] || 'video/mp4', 'Cache-Control': 'public, max-age=60' };
    if (up.headers['content-length']) extra['Content-Length'] = up.headers['content-length'];
    res.writeHead(200, { ...base, ...extra });
    if (req.method === 'HEAD') { up.destroy(); res.end(); return; }
    // A preload-hinted part is streamed while MediaMTX produces it.
    await new Promise(resolve => pipeline(up, res, error => { if (error) res.destroy(); resolve(); }));
  } catch (error) {
    log('warn', 'HLS upstream failed: ' + error.message, 'hls-up');
    if (!res.headersSent) busy(res, 2, 'Media server is restarting'); else res.destroy();
  } finally { gates.hls.leave(); hlsPerIp.add(ip, -1); }
}

// POST /<path>/session -> 200 {"sid","heartbeatMs"} | 503 + Retry-After (viewer cap, or this address holds too many) |
// 404 not running; PUT /<path>/session/<sid> heartbeat, DELETE leave -> 204 | 404 (unknown or expired: open a new one).
// scope: the state a scoped POST checked the binding on (no second lookup in between).
async function viewerSession(req, res, path, sid, ip, scope = null) {
  const key = hlsKey(req, ip);
  if (sid) {
    if (req.method !== 'PUT' && req.method !== 'DELETE') return text(res, 405, 'Method not allowed');
    return send(res, sessions.touch(path, sid, key, ip, req.method === 'DELETE') ? 204 : 404, '', '', noStore);
  }
  if (req.method !== 'POST') return text(res, 405, 'Method not allowed');
  const wait = limits.session.take(ip);
  if (wait) return limited(res, wait);
  const s = scope ? scope.s : await current(path);
  if (!s.live) return json(res, 404, { error: 'not-running' });
  if (overCap(path, s.paths, res)) return;
  const id = sessions.open(path, key, ip);
  if (!id) { log('warn', `viewer sessions per address reached for ${ip}`, 'sess-ip ' + ip); return busy(res, 15, 'Too many viewers from this address'); }
  json(res, 200, { sid: id, heartbeatMs: HEARTBEAT_MS });
}

// Byte runs of a recording file; a read error resets the connection so the player sees a failed request, never a shorter body.
async function sendRuns(res, file, runs) {
  let fh;
  try {
    fh = await open(file, 'r');
    for (let [offset, length] of runs) {
      while (length > 0) {
        const n = Math.min(length, 256 * 1024), chunk = Buffer.allocUnsafe(n);
        const { bytesRead } = await fh.read(chunk, 0, n, offset);
        if (bytesRead !== n) throw new Error('short read');
        if (res.destroyed) return;
        if (!res.write(chunk)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
        offset += n; length -= n;
      }
    }
    res.end();
  } catch (error) {
    log('warn', 'recording read failed: ' + error.message, 'dvr-read');
    res.destroy();
  } finally { await fh?.close().catch(() => {}); }
}

// GET /<path>/dvr/file[.mp4]?id=<broadcast>&f=<file>[&s=<segment>]: the recording file of dvr.m3u8 with Range (the init is
// its ftyp+moov range; never bytes past what the playlist lists), or one listed media segment built from its parts.
// f is the file's recording start (epoch ms, from its name), not its place in the list, so a URL cached for an hour
// names the same bytes after a relay restart or after the retention removed older files.
// scope (/<path>/b/<id>/dvr/file): the id query must be the prefix's broadcast (409 otherwise).
async function dvrFile(req, res, path, url, ip, scope = null) {
  const q = url.searchParams, num = (v, digits) => (v !== null && v.length <= digits && /^[0-9]+$/.test(v) ? Number(v) : -1);
  const id = q.get('id') || '', file = num(q.get('f'), 15), sText = q.get('s'), segment = sText === null ? -1 : num(sText, 6);
  if (!/^[0-9a-f]{32}$/.test(id) || file < 0 || (sText !== null && segment < 0)) return json(res, 400, { error: 'bad-request' });
  if (scope && id !== scope.id) return json(res, 409, { error: 'broadcast-changed' });
  const wait = limits.dvr.take(ip);
  if (wait) return limited(res, wait);
  if (dvrPerIp.get(ip) >= cfg.limits.dvrPerIp) return busy(res, 2, 'Too many recording downloads from this address');
  const s = scope ? scope.s : await current(path);
  if (scope && file >= foreignFrom(s)) return busy(res, 2, 'Media is not ready yet');
  const [status, f] = await dvr.hlsFile(path, s.entry, s.live, id, file);
  if (scope && changed(res, path, scope.id)) return;
  if (status) return json(res, status, { error: f });
  if (!gates.dvr.enter()) return busy(res, 2);
  dvrPerIp.add(ip, 1);
  try {
    const head = req.method === 'HEAD';
    if (segment >= 0) {
      const seg = f.segments[segment];
      const frag = seg ? await buildRecordFragment(f, seg, segment + 1) : null;
      if (!frag) { if (seg) log('warn', `DVR segment ${segment} of file ${f.name} on /${path} could not be built`, 'dvr-seg'); return json(res, 404, { error: 'no-data' }); }
      // A listed segment never changes (it is cut from complete parts), so it is cached like a finished file.
      res.writeHead(200, { ...base, 'Content-Type': 'video/mp4', 'Content-Length': frag.moof.length + frag.payload, 'Accept-Ranges': 'none', 'Cache-Control': 'public, max-age=3600' });
      if (head) return res.end();
      res.write(frag.moof);
      return await sendRuns(res, f.path, frag.runs);
    }
    const limit = listedBytes(f), range = parseRange(req.headers.range, limit);
    if (range === false || !limit) return text(res, 416, 'Range not satisfiable', { ...noStore, 'Content-Range': `bytes */${limit}` });
    const [first, last] = range || [0, limit - 1];
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': last - first + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': f.complete ? 'public, max-age=3600' : 'no-cache' };
    if (range) headers['Content-Range'] = `bytes ${first}-${last}/${f.complete ? limit : '*'}`;
    res.writeHead(range ? 206 : 200, { ...base, ...headers });
    if (head) return res.end();
    await sendRuns(res, f.path, [[first, last - first + 1]]);
  } finally { gates.dvr.leave(); dvrPerIp.add(ip, -1); }
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

// GET /<path>/live.m3u8[?q=]. Its URIs are relative, so under /<path>/b/<id>/ every variant resolves under the prefix too.
async function liveRoute(res, path, url, scope = null) {
  if (!cfg.hls) return text(res, 404, 'Not found', noStore);
  const q = url.searchParams.get('q') || '';
  if (q && !/^(source|(240|360|480|720|1080|1440)p)$/.test(q)) return text(res, 404, 'Quality is not available', noStore);
  const s = scope ? scope.s : await current(path);
  if (!s.ready || (scope && !ownSource(s.entry, s.p))) return notReady(res, s, scope);
  const body = liveMaster(path, s, q);
  if (!body) return text(res, 404, 'Quality is not available', noStore);
  // Start the ladder now (no wait): the player asks for a variant right after this.
  const ladder = ladderList(s.entry, s.p, s.paths);
  if (ladder.length && hlsAudio(s.entry, s).kind !== 'transcode') ladders.ensure(path, ladder, `${path}/src`, 0).catch(() => {});
  return send(res, 200, 'application/vnd.apple.mpegurl', body, { 'Cache-Control': 'max-age=2' });
}

// For a scoped recording request: while the source path's publisher session is not the broadcast's own (lib/scope.mjs
// ownSource), the recording files that session may have written (named by their start, which comes after the session
// became ready; 2 s of slack as in lib/dvr.mjs) belong to someone else: files from this time on are not listed or served
// under the prefix (503 + Retry-After). Infinity when the session is the broadcast's own (or no media arrives).
const foreignFrom = s => (s.entry && s.p?.ready && !ownSource(s.entry, s.p) ? s.p.readyMs - 2000 : Infinity);

// GET /<path>/dvr: the JSON index of the current broadcast's recording ({"running":false} when not running). Under a prefix
// it waits while the path's publisher session is not the broadcast's own (its ranges would include that session's time).
async function dvrIndex(res, path, scope = null) {
  const s = scope ? scope.s : await current(path);
  if (scope && !s.live) return notRunning(res, scope);
  if (scope && foreignFrom(s) < Infinity) return busy(res, 2, 'Media is not ready yet');
  const value = await dvr.index(path, s.entry, s.live);
  if (scope && changed(res, path, scope.id)) return;
  return json(res, 200, value);
}

// GET /<path>/dvr.m3u8: the current broadcast's recording as HLS (its URIs are relative: dvr/file.mp4?id=&f=&s=). Under a
// prefix it waits while it would list a file of a publisher session that is not the broadcast's own.
async function dvrPlaylist(res, path, scope = null) {
  const s = scope ? scope.s : await current(path);
  if (!s.entry || !s.live) return notRunning(res, scope);
  if (!dvr.hlsAvailable()) return text(res, 404, 'No recording', noStore);
  const { body, files } = await dvr.hlsState(path, s.entry);
  if (scope && changed(res, path, scope.id)) return;
  const from = scope ? foreignFrom(s) : Infinity;
  if (files.some(f => !f.gone && f.segments.length && f.fileId >= from)) return busy(res, 2, 'Media is not ready yet');
  return send(res, 200, 'application/vnd.apple.mpegurl', body, { 'Cache-Control': 'no-cache' });
}

// /<path>/b/<broadcastId>/<route>: the routes above for one broadcast. Every answer first checks the binding on one
// resolved state (passed to the handler, never looked up twice): nothing on the path -> 404 {"error":"not-running"},
// another broadcast on it -> 409 {"error":"broadcast-changed"} (both no-store), so a link never gets the next broadcast's
// playlists, parts, segments, recording or sessions, and every cache key contains the id. Live media and recording of a
// publisher session that is not the broadcast's own (older than it, or begun after its last announcement: lib/scope.mjs
// ownSource) wait like media briefly away (503 + Retry-After). Leaving (DELETE of a session) always works; a heartbeat of
// a broadcast that is gone closes its session. Everything else under a prefix is 404.
async function scoped(req, res, sc, url, ip) {
  const { path, id, route, m } = sc;
  if (!route) return text(res, 404, 'Not found', noStore);
  if (route === 'session') {
    if (m[2] && req.method === 'DELETE') return viewerSession(req, res, path, m[2], ip);
    if (req.method !== (m[2] ? 'PUT' : 'POST')) return text(res, 405, 'Method not allowed');
  } else if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed');
  // current() reads the registry before it awaits the path list: the broadcast must also still be on the path after it.
  const s = await current(path), bad = binding(s.entry, id) || binding(registry.byPath(path), id);
  if (bad) {
    if (route === 'session' && m[2]) sessions.touch(path, m[2], hlsKey(req, ip), ip, true);
    return json(res, bad[0], { error: bad[1] });
  }
  const scope = { id, s };
  switch (route) {
    case 'live': return liveRoute(res, path, url, scope);
    case 'hls': return hls(req, res, m, url, ip, scope);
    case 'dvr': return dvrIndex(res, path, scope);
    case 'dvrPlaylist': return dvrPlaylist(res, path, scope);
    case 'dvrFile': return dvrFile(req, res, path, url, ip, scope);
    default: return viewerSession(req, res, path, m[2], ip, scope);
  }
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
  // Only a plain absolute path: "//x", "/\x", an absolute URL, "*" or control characters (which the URL parser drops)
  // would be read with an authority of their own, so a route check on the parsed path would not cover what the raw
  // target names.
  if (!/^\/(?![/\\])/.test(req.url) || /[\x00-\x20\x7f]/.test(req.url)) return text(res, 400, 'Bad request', noStore);
  const url = new URL(req.url, 'http://relay');
  const path = url.pathname, head = req.method === 'HEAD', get = req.method === 'GET' || head;
  let m;
  if ((m = R.whep.exec(path))) return whep(req, res, m, ip);
  if (req.method === 'OPTIONS') return send(res, 204, '', '', { 'Access-Control-Max-Age': '600' });
  const sc = matchScoped(path, R);
  if (sc) return scoped(req, res, sc, url, ip);
  if (path === '/api/broadcasts/announce') return announce(req, res, ip);
  if ((m = R.thumbUpload.exec(path))) return thumbnailUpload(req, res, m[1], ip);
  if ((m = R.stats.exec(path))) return statsReport(req, res, m[1], ip);
  if ((m = R.session.exec(path))) return viewerSession(req, res, m[1], m[2], ip);
  if (!get) return text(res, 405, 'Method not allowed');
  if (path === '/healthz') {
    const paths = await mtx.list();
    const entries = registry.all();
    return json(res, mtx.ok ? 200 : 503, { ok: mtx.ok, version: VERSION, mediamtx: mtx.ok, mediamtxListStale: mtx.stale, broadcasts: entries.length,
      receiving: entries.filter(e => paths.get(e.path)?.ready).length, hlsViewers: entries.reduce((n, e) => n + hlsCount(e.path), 0), hlsSessions: sessions.total,
      chatClients: hub.count, sockets, statsRows: stats.written, qualityEncoders: ladders.running().length, uptimeS: Math.round(process.uptime()) });
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
  if ((m = R.hls.exec(path))) return hls(req, res, m, url, ip);
  if ((m = R.live.exec(path))) return liveRoute(res, m[1], url);
  if ((m = R.info.exec(path))) {
    const s = await current(m[1]);
    return json(res, 200, viewerInfo(m[1], s), s.waiting ? { 'Retry-After': '2' } : {});
  }
  if ((m = R.dvr.exec(path))) return dvrIndex(res, m[1]);
  if ((m = R.dvrMedia.exec(path))) return dvrMedia(req, res, m[1], url, ip);
  if ((m = R.dvrPlaylist.exec(path))) return dvrPlaylist(res, m[1]);
  if ((m = R.dvrFile.exec(path))) return dvrFile(req, res, m[1], url, ip);
  if ((m = R.script.exec(path))) {
    const name = m[2], js = name.endsWith('.js');
    try { return send(res, 200, js ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8', await scriptFile(name), { 'Cache-Control': js ? 'public, max-age=31536000, immutable' : 'max-age=86400' }); }
    catch { return text(res, 404, 'Not found', noStore); }
  }
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
// Also stops quality ladders nobody reads any more.
setInterval(async () => {
  if (!registry.entries.size && !ladders.ladders.size) return;
  const paths = await mtx.list();
  ladders.sweep(paths);
  for (const e of registry.entries.values()) {
    const p = paths.get(e.path);
    if (!p?.ready) continue;
    observe(e, p);
    // Once per broadcast, as soon as its media arrives: start its quality ladder (see lib/ladder.mjs for why not later).
    if (cfg.hls && e.ladderFor !== e.id) {
      const s = { entry: e, p, paths, ready: true }, list = ladderList(e, p, paths);
      if (list.length && hlsAudio(e, s).kind !== 'transcode') { e.ladderFor = e.id; ladders.ensure(e.path, list, `${e.path}/src`, 0).catch(() => {}); }
    }
  }
}, 2000).unref();

server.listen(cfg.port, cfg.host, () => {
  log('info', `FRAME relay ${VERSION} listening on ${cfg.host}:${cfg.port}; UI ${cfg.uiFile}; scripts ${cfg.jsDir}; ${cfg.tokens.length} publisher token(s); renditions [${cfg.renditions.map(r => r.name).join(',')}]; DVR ${cfg.dvr ? 'on' : 'off'}; HLS ${cfg.hls ? 'on' : 'off'}${cfg.hlsAac ? ' (+AAC)' : ''}; media grace ${cfg.mediaGraceMs} ms; playback stats ${stats.enabled ? cfg.stats.dir : 'not stored (RELAY_STATS_DIR unset)'}`);
  if (!cfg.tokens.length) log('warn', 'no publisher token configured: every announcement will be refused');
  const any = cfg.tokenPaths.filter(p => !p).length;
  if (any) log('warn', `${any} publisher token(s) may announce any path ("*"): give each sender its own path(s) in production`);
  mtx.list().catch(() => {});
});
function shutdown() {
  log('info', 'shutting down');
  ladders.stopAll();
  server.close();
  for (const c of hub.clients) c.ws.close(1001);
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
