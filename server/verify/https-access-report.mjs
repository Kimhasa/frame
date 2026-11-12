// Per-device summary of the test Caddy's access log (server/verify/https-session.mjs, deploy/test/Caddyfile.https-test):
// what each phone or browser actually requested through Caddy, for recording iPhone Safari / Android Chrome results without
// developer tools on the phone.
//   device          from the User-Agent (iPhone/iPad Safari, Chrome on iOS, Android Chrome, desktop Edge/Chrome, ...)
//   transport hint  media requested by AppleCoreMedia (iOS's own player) = native HLS; by the browser itself = hls.js (MSE or
//                   ManagedMediaSource); a POST .../whep = WebRTC
//   qualities       which variant playlists it loaded (src = source, 480p, ...) and when it switched
//   DVR, sessions   dvr / dvr.m3u8 / dvr/file requests, viewer session POST/PUT/DELETE
//   chat            WebSocket requests (HTTP/1.1 101, or HTTP/2+ CONNECT 200) and how long each stayed open
//   protocols       HTTP/1.1, HTTP/2.0, HTTP/3.0
//   problems        every 4xx/5xx with time, path and Retry-After; media outside /<path>/b/<id>/
// Addresses are not printed (clients are numbered); broadcast ids are shortened.
// usage: node server/verify/https-access-report.mjs [--dir <session folder>] [--since 2026-11-09T09:00] [--until ...] [--out file.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; };
const DIR = resolve(arg('dir', join(process.env.LOCALAPPDATA || ROOT, 'FrameTest', 'https')));
const since = arg('since') ? Date.parse(arg('since')) / 1000 : 0, until = arg('until') ? Date.parse(arg('until')) / 1000 : Infinity;
const file = join(DIR, 'caddy-access.log');
if (!existsSync(file)) throw new Error('no access log: ' + file);
const rows = readFileSync(file, 'utf8').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(r => r && r.request && r.ts >= since && r.ts <= until);

const ua = r => (r.request.headers?.['User-Agent'] || [''])[0];
function device(agent) {
  if (/AppleCoreMedia/.test(agent)) return { family: /iPad/.test(agent) ? 'iPad' : 'iPhone', app: 'AppleCoreMedia (iOS player)', os: (/OS ([\d_]+)/.exec(agent)?.[1] || '').replace(/_/g, '.') };
  if (/iPhone|iPad/.test(agent)) return { family: /iPad/.test(agent) ? 'iPad' : 'iPhone', app: /CriOS/.test(agent) ? 'Chrome (iOS)' : /EdgiOS/.test(agent) ? 'Edge (iOS)' : 'Safari', os: (/OS ([\d_]+)/.exec(agent)?.[1] || '').replace(/_/g, '.') };
  if (/Android/.test(agent)) return { family: 'Android', app: /SamsungBrowser/.test(agent) ? 'Samsung Internet' : /EdgA/.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : 'other', os: /Android ([\d.]+)/.exec(agent)?.[1] || '', model: /Android [\d.]+; ([^;)]+)/.exec(agent)?.[1]?.trim() };
  if (/Headless/.test(agent)) return { family: 'desktop', app: 'headless Edge/Chrome (PC check)' };
  if (/Edg\//.test(agent)) return { family: 'desktop', app: 'Edge' };
  if (/Chrome\//.test(agent)) return { family: 'desktop', app: 'Chrome' };
  if (/Firefox\//.test(agent)) return { family: 'desktop', app: 'Firefox' };
  if (/node|undici|curl/i.test(agent)) return { family: 'tool', app: agent.split('/')[0] };
  return { family: 'other', app: agent.slice(0, 40) };
}
const short = s => String(s).replace(/[0-9a-f]{32}/g, m => m.slice(0, 6) + '…');
const t = ts => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
const media = p => /\/(?:live\.m3u8|(?:[a-z0-9]+\/)?hls\/|dvr)/.test(p);

// One client = one address and device family; the iOS player (AppleCoreMedia) of an iPhone shares its Safari's address and
// family, so its media requests land in the same client.
const clients = new Map();
for (const r of rows) {
  const key = `${r.request.client_ip || r.request.remote_ip}|${device(ua(r)).family}`;
  if (!clients.has(key)) clients.set(key, { n: clients.size + 1, rows: [] });
  clients.get(key).rows.push(r);
}
const report = { log: 'caddy-access.log', window: { from: rows.length ? t(rows[0].ts) : null, to: rows.length ? t(rows.at(-1).ts) : null }, rows: rows.length, clients: [] };
for (const c of clients.values()) {
  const agents = [...new Set(c.rows.map(ua))];
  const devices = agents.map(device);
  const path = r => r.request.uri.split('?')[0];
  const variants = {}, switches = [];
  let last = null;
  for (const r of c.rows) {
    const m = /\/b\/[0-9a-f]{32}\/([a-z0-9]+)\/hls\/[^/]+\.m3u8$/.exec(path(r)) || /^\/[^/]+\/([a-z0-9]+)\/hls\/[^/]+\.m3u8$/.exec(path(r));
    if (!m || r.status !== 200) continue;
    variants[m[1]] = (variants[m[1]] || 0) + 1;
    if (m[1] !== last) { switches.push(`${t(r.ts)} ${m[1]}`); last = m[1]; }
  }
  const mediaRows = c.rows.filter(r => media(path(r)));
  const byPlayer = mediaRows.reduce((o, r) => { const k = /AppleCoreMedia/.test(ua(r)) ? 'AppleCoreMedia' : 'browser'; o[k] = (o[k] || 0) + 1; return o; }, {});
  const whep = c.rows.filter(r => r.request.method === 'POST' && /\/whep$/.test(path(r)));
  const chat = c.rows.filter(r => /\/chat$/.test(path(r))).map(r => ({ at: t(r.ts), proto: r.request.proto, method: r.request.method, status: r.status, openS: Math.round(r.duration) }));
  const sessions = c.rows.filter(r => /\/session(\/[0-9a-f]{32})?$/.test(path(r))).reduce((o, r) => { const k = `${r.request.method} ${r.status}`; o[k] = (o[k] || 0) + 1; return o; }, {});
  const dvr = c.rows.filter(r => /\/dvr/.test(path(r))).reduce((o, r) => { const k = `${/dvr\/file/.test(path(r)) ? 'dvr/file' : /dvr\.m3u8/.test(path(r)) ? 'dvr.m3u8' : 'dvr'} ${r.status}`; o[k] = (o[k] || 0) + 1; return o; }, {});
  const pages = c.rows.filter(r => r.request.method === 'GET' && (/^\/_frame\/(live|watch\/)/.test(path(r)) || /^\/[a-z0-9][a-z0-9_-]*$/i.test(path(r))) && /text\/html/.test((r.resp_headers?.['Content-Type'] || [''])[0]))
    .map(r => `${t(r.ts)} ${short(path(r))} ${r.status}`);
  const problems = c.rows.filter(r => r.status >= 400).map(r => ({ at: t(r.ts), method: r.request.method, path: short(path(r)), status: r.status, retryAfter: r.resp_headers?.['Retry-After']?.[0] ?? null }));
  // The React page asks for media only under /<path>/b/<id>/; path routes (/<path>/live.m3u8 ...) come from the legacy page.
  const unscoped = mediaRows.filter(r => !/\/b\/[0-9a-f]{32}\//.test(path(r))).length;
  report.clients.push({
    client: c.n, devices: devices.filter((d, i, a) => a.findIndex(x => JSON.stringify(x) === JSON.stringify(d)) === i), from: t(c.rows[0].ts), to: t(c.rows.at(-1).ts), requests: c.rows.length,
    protocols: c.rows.reduce((o, r) => (o[r.request.proto] = (o[r.request.proto] || 0) + 1, o), {}),
    transportHint: whep.length ? 'webrtc (WHEP POST seen)' : byPlayer.AppleCoreMedia ? 'native HLS (iOS player requested the media)' : byPlayer.browser ? 'hls.js (the browser requested the media: MSE / ManagedMediaSource)' : 'no media',
    mediaRequestsBy: byPlayer, variants, qualitySwitches: switches.slice(0, 30), pages: pages.slice(0, 20), dvr, sessions, chat: chat.slice(-10), unscopedMedia: unscoped, problems: problems.slice(-40)
  });
}
const out = arg('out');
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
