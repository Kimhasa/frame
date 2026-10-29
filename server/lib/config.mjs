// Relay settings from environment variables (systemd EnvironmentFile or `node --env-file=relay.env`).
// Secrets (publisher tokens, TURN secret) only ever come from the environment or a token file, never from the repository.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const QUALITY = /^(240|360|480|720|1080|1440)p$/;
// Target bitrates of the relay-side shared encoders: must match -b:v of the same quality in deploy/mediamtx-relay.yml.
// RELAY_RENDITIONS may override one with "480p:1.8".
const RENDITION_MBPS = { '1440p': 10, '1080p': 6, '720p': 3.5, '480p': 1.8, '360p': 0.9, '240p': 0.5 };

const int = (env, name, fallback, min, max) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return n;
};
const flag = (env, name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : !/^(0|false|no|off)$/i.test(env[name]));
const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
const url = (env, name, fallback) => {
  const value = env[name] || fallback;
  const u = new URL(value);
  if (u.protocol !== 'http:') throw new Error(`${name} must be an http:// loopback URL`);
  return u.origin;
};

// One publisher (sender PC) per entry: "<token> <path> [<path> ...]". RELAY_PUBLISHER_TOKENS separates entries with commas,
// RELAY_PUBLISHER_TOKENS_FILE has one entry per line (# comments). A token may only announce, withdraw and thumbnail the
// paths listed with it; "*" allows any path (single-sender or test setups only).
// Tokens are kept only as SHA-256 digests so a heap dump or log line never contains one.
function loadTokens(env) {
  const entries = list(env.RELAY_PUBLISHER_TOKENS);
  if (env.RELAY_PUBLISHER_TOKENS_FILE) {
    for (const line of readFileSync(env.RELAY_PUBLISHER_TOKENS_FILE, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) entries.push(t);
    }
  }
  const tokens = [], paths = [];
  for (const entry of entries) {
    const [token, ...assigned] = entry.split(/\s+/);
    if (token.length < 24 || token.includes(',')) throw new Error('publisher tokens must be at least 24 characters without spaces or commas');
    if (!assigned.length) throw new Error('each publisher token needs its path(s): "<token> <path> [<path> ...]" (or "*" for any path)');
    for (const p of assigned) if (p !== '*' && !validPath(p)) throw new Error(`publisher token path "${p}" is not a valid stream path`);
    tokens.push(createHash('sha256').update(token).digest());
    paths.push(assigned.includes('*') ? null : new Set(assigned));
  }
  return { tokens, paths };
}

function renditionList(env) {
  return list(env.RELAY_RENDITIONS).map(item => {
    const [name, mbps] = item.split(':');
    if (!QUALITY.test(name)) throw new Error('RELAY_RENDITIONS entries look like 720p or 720p:3.5');
    const rate = mbps === undefined ? RENDITION_MBPS[name] : Number(mbps);
    if (!(rate > 0 && rate <= 200)) throw new Error(`RELAY_RENDITIONS ${item}: bitrate must be Mbps in 0..200`);
    return { name, height: Number.parseInt(name, 10), mbps: rate };
  });
}

export function loadConfig(env = process.env) {
  const ui = resolve(env.RELAY_UI_FILE || resolve(here, '../../outputs/index.html'));
  const iceServers = env.RELAY_ICE_SERVERS ? JSON.parse(env.RELAY_ICE_SERVERS) : [];
  if (!Array.isArray(iceServers)) throw new Error('RELAY_ICE_SERVERS must be a JSON array');
  const publicBase = env.RELAY_PUBLIC_BASE_URL ? new URL(env.RELAY_PUBLIC_BASE_URL) : null;
  if (publicBase && !['http:', 'https:'].includes(publicBase.protocol)) throw new Error('RELAY_PUBLIC_BASE_URL must be http(s)');
  const { tokens, paths: tokenPaths } = loadTokens(env);
  return {
    host: env.RELAY_LISTEN_HOST || '127.0.0.1',
    port: int(env, 'RELAY_PORT', 8080, 1, 65535),
    publicBase: publicBase ? publicBase.origin : '',
    trustedProxies: new Set(list(env.RELAY_TRUSTED_PROXIES ?? '127.0.0.1,::1')),
    uiFile: ui,
    fontsDir: resolve(env.RELAY_FONTS_DIR || resolve(dirname(ui), 'assets/fonts')),
    tokens, tokenPaths,
    mediamtx: {
      api: url(env, 'RELAY_MEDIAMTX_API', 'http://127.0.0.1:9997'),
      webrtc: url(env, 'RELAY_MEDIAMTX_WEBRTC', 'http://127.0.0.1:8889'),
      hls: url(env, 'RELAY_MEDIAMTX_HLS', 'http://127.0.0.1:8888'),
      playback: url(env, 'RELAY_MEDIAMTX_PLAYBACK', 'http://127.0.0.1:9996'),
      apiUser: env.RELAY_MEDIAMTX_API_USER || '',
      apiPass: env.RELAY_MEDIAMTX_API_PASS || '',
      // A failing or slow API keeps the last good path list this long (marked stale) instead of showing every broadcast offline.
      staleMs: int(env, 'RELAY_MEDIAMTX_STALE_MS', 15000, 0, 300000)
    },
    recordDir: env.RELAY_RECORD_DIR ? resolve(env.RELAY_RECORD_DIR) : '',
    dvr: flag(env, 'RELAY_DVR', true),
    hls: flag(env, 'RELAY_HLS', true),
    hlsAac: flag(env, 'RELAY_HLS_AAC', false),
    renditions: renditionList(env),
    iceServers,
    turn: { urls: list(env.RELAY_TURN_URLS), secret: env.RELAY_TURN_SECRET || '', ttlS: int(env, 'RELAY_TURN_TTL_S', 3600, 60, 86400) },
    // An announced broadcast lives this long after its last announcement (the sender announces every 2 s).
    announceTtlMs: int(env, 'RELAY_ANNOUNCE_TTL_MS', 15000, 3000, 60000),
    // While announced, a broadcast whose media stopped arriving (sender reconnecting, relay MediaMTX restart) stays
    // {"running":true,"mediaReady":false} this long after media was last seen, so viewers wait instead of ending playback.
    mediaGraceMs: int(env, 'RELAY_MEDIA_GRACE_MS', 15000, 0, 120000),
    // HLS viewers count against the viewer cap while they requested anything in this window.
    hlsActiveMs: int(env, 'RELAY_HLS_ACTIVE_MS', 12000, 3000, 60000),
    stats: {
      dir: env.RELAY_STATS_DIR ? resolve(env.RELAY_STATS_DIR) : '',
      maxBytes: int(env, 'RELAY_STATS_MAX_MB', 50, 1, 10000) * 1024 * 1024,
      keepDays: int(env, 'RELAY_STATS_KEEP_DAYS', 30, 0, 3650)
    },
    limits: {
      sockets: int(env, 'RELAY_MAX_SOCKETS', 4000, 10, 100000),
      chat: int(env, 'RELAY_MAX_CHAT', 2000, 1, 100000),
      chatPerIp: int(env, 'RELAY_MAX_CHAT_PER_IP', 50, 1, 10000),
      viewersPerPath: int(env, 'RELAY_MAX_VIEWERS_PER_PATH', 1000, 1, 100000),
      whepInflight: int(env, 'RELAY_MAX_WHEP_INFLIGHT', 64, 1, 10000),
      dvrStreams: int(env, 'RELAY_MAX_DVR_STREAMS', 200, 1, 10000),
      dvrPerIp: int(env, 'RELAY_MAX_DVR_PER_IP', 16, 1, 10000),
      hlsInflight: int(env, 'RELAY_MAX_HLS_INFLIGHT', 3000, 1, 100000),
      hlsPerIp: int(env, 'RELAY_MAX_HLS_PER_IP', 300, 1, 100000),
      broadcasts: int(env, 'RELAY_MAX_BROADCASTS', 64, 1, 256)
    },
    // Per-IP token buckets "burst/perSecond". Mobile carriers put many phones behind one address (CGNAT), so the
    // defaults only stop floods; raise them if one shared address legitimately hosts many viewers.
    rates: {
      publishIp: rate(env, 'RELAY_RATE_PUBLISH_IP', '60/10'), announce: rate(env, 'RELAY_RATE_ANNOUNCE', '30/5'), authFail: rate(env, 'RELAY_RATE_AUTH_FAIL', '10/0.1667'),
      chatConnect: rate(env, 'RELAY_RATE_CHAT_CONNECT', '60/5'), chatSend: rate(env, 'RELAY_RATE_CHAT_SEND', '60/6'), whep: rate(env, 'RELAY_RATE_WHEP', '60/2'),
      dvr: rate(env, 'RELAY_RATE_DVR', '120/20'), stats: rate(env, 'RELAY_RATE_STATS', '120/20'),
      // One playback report per page (session id) every 4 s; the UI sends one every 15 s.
      statsClient: { burst: 1, perSecond: 0.25 }
    },
    logLevel: env.RELAY_LOG_LEVEL || 'info'
  };
}

function rate(env, name, fallback) {
  const [burst, perSecond] = String(env[name] || fallback).split('/').map(Number);
  if (!(burst >= 1 && perSecond > 0)) throw new Error(`${name} must look like 30/5 (burst/perSecond)`);
  return { burst, perSecond };
}

export const validPath = p => typeof p === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(p);
export const validQuality = q => typeof q === 'string' && QUALITY.test(q);
