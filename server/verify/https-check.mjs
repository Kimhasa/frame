// Checks the React public web through the real Caddy of a running server/verify/https-session.mjs, on this PC: the test
// HTTPS address as phones open it (not the loopback web-proxy of web-e2e.mjs). Writes verification/caddy/https-check-result.json
// and screenshots (the test host name is written as <test-host>, the tailnet / LAN addresses as <addr>).
//   A caddy validate        the session's settings
//   B certificate           Node (its CA store), Windows (curl.exe, Schannel) and Edge (security state) trust the test host
//   C static                /_frame -> /_frame/, page addresses -> index.html (no-cache), hashed asset immutable, missing asset 404
//   D relay                 API, /info, legacy /<path> page and the list's public addresses through Caddy
//   E exposure              no internal address (loopback, LAN, tailnet, relay ports, http://) in the API, /info and playlists
//   F 503                   a relay 503 + Retry-After passes through Caddy unchanged (a broadcast announced without media)
//   G WSS                   HTTP/1.1 upgrade of the chat socket through Caddy -> 101 with a valid Sec-WebSocket-Accept
//   H browser               headless Edge on the HTTPS address: list -> video + test tone -> 480p -> 자동 -> rewind 30-60 s ->
//                           실시간 복귀; direct link reload; chat over WSS (a Node client receives once), a Caddy reload drops the
//                           socket, the page reconnects without duplicates; every request on the test origin over https/wss,
//                           no mixed content, media/DVR/session under /<path>/b/<id>/; last, the relay web service is
//                           restarted under the playing page (502 from Caddy meanwhile, then the list, playback and chat again)
// usage: node server/verify/https-check.mjs [--dir <session folder>] [--quality-repeats N]   (the session must be running; heavy: Edge + playback)
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import tls from 'node:tls';
import { start, stop, waitFor, sleep, checks, killByCommandLine, scrub } from './harness.mjs';
import { connect } from '../../tools/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; };
const DIR = resolve(arg('dir', join(process.env.LOCALAPPDATA || ROOT, 'FrameTest', 'https')));
const CONTROL = 'http://127.0.0.1:26090';
const EDGE = process.env.FRAME_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EDGE_PORT = 26222;
const QUALITY_REPEATS = Math.max(0, Math.min(30, Number(arg('quality-repeats', '0')) || 0));
const TMP = join(tmpdir(), 'frame-https-check-' + Date.now());

const S = await fetch(CONTROL + '/state').then(r => r.json()).catch(() => null);
if (!S?.origin) throw new Error('no https-session answered on ' + CONTROL);
// Evidence per backend under test (https-session.mjs --backend): the Node relay's stays in verification/caddy.
const OUT = join(ROOT, S.backend === 'spring' ? 'verification/spring/caddy' : 'verification/caddy');
// A Caddy local CA (--tls internal) is not in Node's store: run again with it as an extra CA (never a system trust change).
if (S.tls === 'internal' && !process.env.NODE_EXTRA_CA_CERTS) {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: S.caddy.rootCa } });
  process.exit(r.status ?? 1);
}
const ORIGIN = S.origin, HOST = new URL(ORIGIN).hostname, PORT = Number(new URL(ORIGIN).port || 443);
const PATH = S.broadcast.path, ID = S.broadcast.id, TITLE = S.broadcast.title, PUBLISHER = S.broadcast.publisher;
const scope = (id = ID, path = PATH) => `/${path}/b/${id}/`;
for (const d of [OUT, TMP]) mkdirSync(d, { recursive: true });

// Written files name neither the tailnet / LAN host nor its addresses.
// Broadcast and session ids are shortened (the broadcast's is in the session's local state file).
const anon = s => String(s).replaceAll(HOST, '<test-host>').replace(/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/g, '<addr>').replace(/\b192\.168\.\d+\.\d+\b/g, '<addr>').replace(/\b10\.\d+\.\d+\.\d+\b/g, '<addr>').replace(/\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/g, '<addr>')
  .replace(/\b[0-9a-f]{32}\b/g, m => m.slice(0, 6) + '…');
const { list, check } = checks();
// Something this run cannot test (e.g. browser trust of a Caddy local CA): recorded as not run, counted neither way.
const notRun = (name, why, detail = {}) => { list.push({ name, ok: null, notRun: why, ...detail }); console.log('SKIP ' + name.padEnd(46) + why); };
const result = {
  startedAt: new Date().toISOString(), kind: 'real Caddy on this PC (HTTPS/WSS), headless Edge; not the loopback web-e2e.mjs run',
  origin: ORIGIN, tls: S.tls, backend: S.backend || 'node', session: { startedAt: S.startedAt, broadcastStartedAt: new Date(S.broadcast.startedAtMs).toISOString(), testSignal: S.testSignal },
  host: { otherProcesses: null }, checks: list, notes: [], pages: {},
  notConfirmed: [
    'inbound reachability from another tailnet device: this PC reaches its own Tailscale IP on a local path that neither crosses the Tailscale adapter nor Windows Defender Firewall (a firewall rule for caddy.exe or a Tailscale ACL can still block phones)',
    'iPhone Safari and Android Chrome on real devices (verification/caddy/RESULTS.md)',
    'HTTP/3: off in the test Caddy (protocols h1 h2; tailnet MTU 1280 does not fit a QUIC initial packet); production keeps h1 h2 h3 and HTTP/3 to phones is not verified'
  ]
};
try { result.host.otherProcesses = execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process MapleStory,ffmpeg,mediamtx,caddy,msedge -ErrorAction SilentlyContinue | Group-Object ProcessName | ForEach-Object { $_.Name + '=' + $_.Count }"]).toString().trim().split(/\s+/).filter(Boolean); } catch {}

// ---- HTTP helpers ------------------------------------------------------------------------------------------------------------
const parse = t => { try { return JSON.parse(t); } catch { return null; } };
async function raw(url, init = {}) {
  try {
    const r = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    const h = name => r.headers.get(name);
    return { status: r.status, type: h('content-type'), cache: h('cache-control'), retryAfter: h('retry-after'), location: h('location'), hsts: h('strict-transport-security'), server: h('server'), setCookie: h('set-cookie'), text, json: parse(text) };
  } catch (error) { return { status: 0, error: error.cause?.code || error.message, text: '' }; }
}
const lines = t => String(t).split('\n').map(l => l.trim()).filter(Boolean);
const uris = t => lines(t).filter(l => !l.startsWith('#'));
// Loopback, private LAN, tailnet (CGNAT) addresses, a host:port in the session's loopback range and plain http:// URLs. The
// test origin itself (RELAY_PUBLIC_BASE_URL, in baseUrl/thumbnailUrl) is removed first: it may be a LAN or tailnet IP.
const INTERNAL = /\b127\.0\.0\.1\b|\blocalhost\b|\[::1\]|\b10\.\d+\.\d+\.\d+\b|\b192\.168\.\d+\.\d+\b|\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b|\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b|(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):26\d{3}\b|http:\/\//gi;
const internalIn = text => [...new Set(String(text).replaceAll(ORIGIN, '<origin>').match(INTERNAL) || [])];

// ---- A. caddy validate --------------------------------------------------------------------------------------------------------
const validate = await (await fetch(CONTROL + '/validate', { method: 'POST' })).json();
check('A caddy validate: deploy/test/Caddyfile.https-test with the session settings', validate.code === 0 && /Valid configuration/i.test(validate.output), { code: validate.code, last: anon(validate.output.split('\n').at(-1)) });

// ---- B. certificate -------------------------------------------------------------------------------------------------------------
const peer = await new Promise(done => {
  const s = tls.connect({ host: HOST, port: PORT, servername: HOST, ALPNProtocols: ['h2', 'http/1.1'] }, () => {
    const c = s.getPeerCertificate();
    done({ authorized: s.authorized, error: s.authorizationError || null, protocol: s.getProtocol(), alpn: s.alpnProtocol, subject: c.subject?.CN ?? null, issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(' / '),
      san: c.subjectaltname, validFrom: c.valid_from, validTo: c.valid_to,
      // Edge's --ignore-certificate-errors-spki-list takes the SHA-256 of the DER SubjectPublicKeyInfo (c.pubkey is the raw key).
      spki: c.raw ? createHash('sha256').update(new X509Certificate(c.raw).publicKey.export({ type: 'spki', format: 'der' })).digest('base64') : null });
    s.end();
  });
  s.on('error', error => done({ authorized: false, error: error.code || error.message }));
  s.setTimeout(15000, () => { s.destroy(); done({ authorized: false, error: 'timeout' }); });
});
let curl = null;
try { curl = execFileSync('C:/Windows/System32/curl.exe', ['-sS', '-o', 'NUL', '-w', '%{http_code} %{http_version} %{ssl_verify_result}', `${ORIGIN}/healthz`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).toString().trim(); }
catch (error) { curl = 'failed: ' + anon(String(error.stderr || error.message).trim()).slice(0, 200); }
const certDetail = { tlsMode: S.tls, node: { authorized: peer.authorized, error: peer.error, protocol: peer.protocol, alpn: peer.alpn },
  cert: { subject: peer.subject && anon(peer.subject), issuer: peer.issuer, san: anon(peer.san), validFrom: peer.validFrom, validTo: peer.validTo }, curl: anon(curl) };
if (S.tls === 'internal') notRun('B1 certificate: Node, Windows (curl.exe, Schannel) and Edge trust the test host', 'Caddy local CA (--tls internal): no publicly trusted certificate; needs the tailscale certificate', certDetail);
else check('B1 certificate: Node (Mozilla CA store) and Windows (curl.exe, Schannel) trust the test host', peer.authorized && /^200 /.test(curl), certDetail);

// ---- C. static ------------------------------------------------------------------------------------------------------------------
const html = { Accept: 'text/html' };
const bare = await raw(ORIGIN + '/_frame', { headers: html });
const live = await raw(ORIGIN + '/_frame/live', { headers: html });
const watch = await raw(`${ORIGIN}/_frame/watch/${PATH}/${ID}`, { headers: html });
const missing = await raw(`${ORIGIN}/_frame/assets/missing-${randomBytes(4).toString('hex')}.js`);
const assetPath = /src="(\/_frame\/assets\/[^"]+\.js)"/.exec(live.text)?.[1];
const asset = assetPath ? await raw(ORIGIN + assetPath) : { status: 0 };
const isIndex = r => r.status === 200 && /text\/html/.test(r.type || '') && r.text.includes('id="root"');
check('C static: /_frame -> 308 /_frame/; /_frame/live and a direct watch link -> index.html (no-cache); hashed asset immutable; missing asset 404 (not index.html); HSTS, no Server header',
  bare.status === 308 && bare.location === '/_frame/' && isIndex(live) && live.cache === 'no-cache' && isIndex(watch) && watch.cache === 'no-cache'
    && asset.status === 200 && /immutable/.test(asset.cache || '') && /javascript/.test(asset.type || '') && missing.status === 404 && !missing.text.includes('id="root"')
    && /max-age=\d+/.test(live.hsts || '') && !live.server,
  { bare: { status: bare.status, location: bare.location }, live: { status: live.status, type: live.type, cache: live.cache }, watch: { status: watch.status, cache: watch.cache },
    asset: { path: assetPath, status: asset.status, cache: asset.cache, type: asset.type }, missingAsset: { status: missing.status, cache: missing.cache, type: missing.type }, hsts: live.hsts, server: live.server });

// ---- D. relay through Caddy ------------------------------------------------------------------------------------------------------
const api = await raw(ORIGIN + '/api/broadcasts');
const mine = api.json?.items?.find(i => i.id === ID);
const info = await raw(`${ORIGIN}/${PATH}/info`);
const legacy = await raw(`${ORIGIN}/${PATH}`, { headers: html });
const health = await raw(ORIGIN + '/healthz');
const publicUrls = mine ? Object.entries(mine).filter(([, v]) => typeof v === 'string' && /^(https?|wss?):\/\//.test(v)) : [];
check('D relay: /api/broadcasts lists the broadcast with public addresses on the test origin, /info names it, the legacy /<path> page and /healthz answer through Caddy',
  api.status === 200 && !!mine && publicUrls.every(([, v]) => v.startsWith(ORIGIN)) && info.status === 200 && info.json?.broadcastId === ID && info.json?.hls?.scope === `b/${ID}/`
    && legacy.status === 200 && /text\/html/.test(legacy.type || '') && health.status === 200,
  { api: api.status, listed: !!mine, publicUrls: publicUrls.map(([k, v]) => `${k}=${anon(v)}`), info: { status: info.status, isBroadcast: info.json?.broadcastId === ID, scope: info.json?.hls?.scope, mediaReady: info.json?.mediaReady },
    legacy: { status: legacy.status, type: legacy.type }, healthz: health.status });

// ---- E. internal addresses in what the page reads ------------------------------------------------------------------------------
const bodies = { 'api/broadcasts': api.text, info: info.text };
const master = await raw(ORIGIN + scope() + 'live.m3u8');
bodies['live.m3u8'] = master.text;
bodies['live.m3u8?q=480p'] = (await raw(ORIGIN + scope() + 'live.m3u8?q=480p')).text;
for (const u of uris(master.text).slice(0, 2)) bodies[u] = (await raw(ORIGIN + scope() + u)).text;
bodies.dvr = (await raw(ORIGIN + scope() + 'dvr')).text;
bodies['dvr.m3u8'] = (await raw(ORIGIN + scope() + 'dvr.m3u8')).text;
const exposed = Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, internalIn(v)]).filter(([, v]) => v.length));
check('E exposure: no loopback / LAN / tailnet address, relay port or http:// URL in the API, /info, live and DVR playlists',
  master.status === 200 && Object.keys(exposed).length === 0, { scanned: Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, v.length])), exposed: JSON.parse(anon(JSON.stringify(exposed))) });

// ---- F. a relay 503 through Caddy -------------------------------------------------------------------------------------------------
const w = await (await fetch(CONTROL + '/waiting', { method: 'POST' })).json();
const RELAY = `http://127.0.0.1:${S.ports.relay}`;
const whepInit = { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' };
const pair = async (path, init) => { const via = await raw(ORIGIN + path, init), direct = await raw(RELAY + path, init); return { caddy: { status: via.status, retryAfter: via.retryAfter, cache: via.cache }, relay: { status: direct.status, retryAfter: direct.retryAfter, cache: direct.cache } }; };
const wInfo = await raw(`${ORIGIN}/${w.path}/info`);
const wLive = await pair(scope(w.id, w.path) + 'live.m3u8');
const wWhep = await pair(`/${w.path}/whep?b=${w.id}`, whepInit);
const bye = await (await fetch(CONTROL + '/waiting/bye', { method: 'POST' })).json();
const same = p => p.caddy.status === p.relay.status && p.caddy.retryAfter === p.relay.retryAfter;
check('F 503: a broadcast announced without media -> the relay\'s 503 + Retry-After passes through Caddy unchanged (scoped live.m3u8 and WHEP ?b=)',
  w.status === 204 && wInfo.json?.running === true && wInfo.json?.mediaReady === false && wLive.caddy.status === 503 && !!wLive.caddy.retryAfter && wWhep.caddy.status === 503 && !!wWhep.caddy.retryAfter && same(wLive) && same(wWhep),
  { announce: w.status, info: { status: wInfo.status, running: wInfo.json?.running, mediaReady: wInfo.json?.mediaReady, retryAfterHeader: wInfo.retryAfter }, scopedLive: wLive, whep: wWhep, bye: bye?.bye });

// ---- G. WSS upgrade over HTTP/1.1 -----------------------------------------------------------------------------------------------
const upgrade = await new Promise(done => {
  const key = randomBytes(16).toString('base64');
  const expect = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const s = tls.connect({ host: HOST, port: PORT, servername: HOST, ALPNProtocols: ['http/1.1'] }, () => {
    s.write(`GET /${PATH}/chat HTTP/1.1\r\nHost: ${HOST}${PORT === 443 ? '' : ':' + PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n\r\n`);
  });
  let buf = '';
  s.on('data', d => {
    buf += d.toString('latin1');
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const head = buf.slice(0, end).split('\r\n');
    const accept = head.find(h => /^sec-websocket-accept:/i.test(h))?.split(':')[1]?.trim();
    done({ alpn: s.alpnProtocol, statusLine: head[0], acceptValid: accept === expect, headers: head.slice(1).filter(h => /^(upgrade|connection|sec-websocket-accept|strict-transport-security|server):/i.test(h)) });
    s.destroy();
  });
  s.on('error', error => done({ error: error.code || error.message }));
  s.setTimeout(15000, () => { s.destroy(); done({ error: 'timeout' }); });
});
check('G WSS: the chat socket upgrade over HTTP/1.1 through Caddy -> 101 Switching Protocols with a valid Sec-WebSocket-Accept', /^HTTP\/1\.1 101/.test(upgrade.statusLine || '') && upgrade.acceptValid, upgrade);

// ---- H. browser ------------------------------------------------------------------------------------------------------------------
const PROBE = `(() => {
  if (window.__e2e) return;
  const e2e = window.__e2e = { pcs: 0 };
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const P = window[name];
    if (typeof P !== 'function') continue;
    const W = function (...args) { e2e.pcs++; return new P(...args); };
    W.prototype = P.prototype; Object.setPrototypeOf(W, P);
    try { window[name] = W; } catch {}
  }
  e2e.setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  e2e.labelled = text => { const l = [...document.querySelectorAll('label')].find(x => x.htmlFor && x.textContent.trim() === text); return l ? document.getElementById(l.htmlFor) : null; };
  e2e.button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text) || null;
  e2e.overlay = () => { const s = document.querySelector('[data-testid="watch-player"] [role="status"] strong'); return s ? s.textContent.trim() : ''; };
})();`;
let edge = null, page = null, legacyTab = null;
// Every CDP call is bounded: tools/cdp.mjs never rejects a call whose answer does not come (renderer crash, target gone).
const bounded = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' timed out')), ms); })]).finally(() => clearTimeout(timer)); };
const ev = (c, expression, ms = 15000) => bounded(c.evaluate(expression), ms, 'evaluate');
const cmd = (c, method, params = {}, ms = 15000) => bounded(c.send(method, params), ms, method);
async function shot(c, name) { try { await cmd(c, 'Page.bringToFront'); await sleep(200); writeFileSync(join(OUT, name + '.png'), await bounded(c.screenshot(), 20000, 'screenshot')); } catch (error) { result.notes.push(`screenshot ${name}: ${error.message}`); } }
function track(c) {
  Object.assign(c, { net: [], ws: [], frames: [], console: [], issues: [], security: [] });
  const byId = new Map(), wsById = new Map();
  const header = (h, name) => { for (const k of Object.keys(h || {})) if (k.toLowerCase() === name) return h[k]; return undefined; };
  c.on(msg => {
    const p = msg.params || {};
    switch (msg.method) {
      case 'Network.requestWillBeSent': {
        let u; try { u = new URL(p.request.url); } catch { return; }
        if (u.protocol === 'data:' || u.protocol === 'blob:') return;
        const e = { t: Date.now(), method: p.request.method, scheme: u.protocol, origin: u.origin, path: u.pathname, query: u.search, type: p.type || '', status: null };
        byId.set(p.requestId, e); c.net.push(e);
        break;
      }
      case 'Network.responseReceived': {
        const e = byId.get(p.requestId), r = p.response || {};
        if (!e) break;
        Object.assign(e, { status: r.status, protocol: r.protocol, remote: r.remoteIPAddress, tr: Date.now(), securityState: r.securityState });
        const ra = header(r.headers, 'retry-after'); if (ra !== undefined) e.retryAfter = ra;
        break;
      }
      case 'Network.loadingFailed': { const e = byId.get(p.requestId); if (e) { e.failed = p.errorText; e.canceled = !!p.canceled; e.blocked = p.blockedReason; } break; }
      case 'Network.webSocketCreated': { const x = { id: p.requestId, url: p.url, t: Date.now(), status: null, closedAt: null }; wsById.set(p.requestId, x); c.ws.push(x); break; }
      case 'Network.webSocketHandshakeResponseReceived': { const x = wsById.get(p.requestId); if (x) { x.status = p.response?.status ?? null; x.statusText = p.response?.statusText; } break; }
      case 'Network.webSocketClosed': { const x = wsById.get(p.requestId); if (x) x.closedAt = Date.now(); break; }
      case 'Network.webSocketFrameReceived': case 'Network.webSocketFrameSent': {
        const m = parse(p.response?.payloadData || '');
        if (!m || typeof m !== 'object') break;
        const f = { t: Date.now(), ws: p.requestId, dir: msg.method.endsWith('Sent') ? 'out' : 'in', type: m.type };
        if (m.type === 'history') f.ids = (m.messages || []).map(x => x.id);
        else if (m.type === 'message') f.id = m.id;
        else if (m.type === 'ack') Object.assign(f, { clientId: m.clientId, ok: m.ok, id: m.id });
        else if (m.type === 'send') f.clientId = m.clientId;
        else if (m.type === 'join') f.broadcastId = m.broadcastId;
        else if (m.type === 'state') Object.assign(f, { connected: m.connected });
        c.frames.push(f);
        break;
      }
      case 'Audits.issueAdded': c.issues.push({ t: Date.now(), code: p.issue?.code, details: anon(JSON.stringify(p.issue?.details || {})).slice(0, 300) }); break;
      case 'Security.visibleSecurityStateChanged': c.security.push({ t: Date.now(), state: p.visibleSecurityState?.securityState, cert: !!p.visibleSecurityState?.certificateSecurityState }); break;
      case 'Runtime.exceptionThrown': c.console.push({ t: Date.now(), level: 'exception', text: anon(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '')).slice(0, 300) }); break;
      case 'Runtime.consoleAPICalled': if (p.type === 'error' || p.type === 'warning') c.console.push({ t: Date.now(), level: p.type, text: anon((p.args || []).map(a => a.value ?? a.description ?? '').join(' ')).slice(0, 300) }); break;
      case 'Log.entryAdded': if (['error', 'warning'].includes(p.entry?.level)) c.console.push({ t: Date.now(), level: 'log-' + p.entry.level, source: p.entry.source, text: anon(String(p.entry.text || '')).slice(0, 300) }); break;
    }
  });
}
async function openTab(name) {
  const known = await (await fetch(`http://127.0.0.1:${EDGE_PORT}/json`)).json();
  const id = (!page ? known.find(t => t.type === 'page')?.id : null) || (await (await fetch(`http://127.0.0.1:${EDGE_PORT}/json/new?about:blank`, { method: 'PUT' })).json()).id;
  const c = await bounded(connect(EDGE_PORT, t => t.id === id), 15000, 'DevTools connect');
  c.name = name;
  track(c);
  for (const d of ['Runtime.enable', 'Page.enable', 'Log.enable', 'Audits.enable', 'Security.enable']) await cmd(c, d).catch(() => {});
  await cmd(c, 'Network.enable', { maxTotalBufferSize: 2000000, maxResourceBufferSize: 200000 });
  await cmd(c, 'Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cmd(c, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cmd(c, 'Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  return c;
}
async function go(c, url, waitPath) {
  await ev(c, 'window.__old = true', 3000).catch(() => {});
  await cmd(c, 'Page.navigate', { url });
  return !!(await waitFor(() => ev(c, `!window.__old && document.readyState === 'complete'${waitPath ? ` && location.pathname === ${JSON.stringify(waitPath)}` : ''}`, 3000), 25000, 100));
}
async function press(c, finder) {
  const box = await ev(c, `(() => { const el = ${finder}; if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  if (!box || !box.w) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cmd(c, 'Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}
const view = c => ev(c, `(() => {
  const v = document.querySelector('[data-testid="watch-video"]');
  let rt = null; try { rt = window.FrameRuntime || null; } catch {}
  const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  const copy = o => (o && typeof o === 'object' ? JSON.parse(JSON.stringify(o)) : o ?? null);
  return { path: location.pathname, overlay: window.__e2e ? window.__e2e.overlay() : '', soundButton: !!(window.__e2e && window.__e2e.button('소리 켜기')), pcs: window.__e2e ? window.__e2e.pcs : null,
    video: v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(3), muted: v.muted, frames: q ? q.totalVideoFrames : null, audioBytes: typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : null } : null,
    rt: rt ? { adapter: rt.adapter, transport: rt.transport, watch: copy(rt.watch), playback: copy(rt.playback), session: copy(rt.session), chat: copy(rt.chat) } : null };
})()`);
async function playing(c, ms = 3000) {
  const a = await view(c); await sleep(ms); const b = await view(c);
  const ok = !!(a.video && b.video && b.video.w > 0 && b.video.t - a.video.t > ms / 2000 && (b.video.frames === null || b.video.frames > a.video.frames));
  return { ok, advancedS: a.video && b.video ? +(b.video.t - a.video.t).toFixed(2) : 0, audioBytes: a.video && b.video && b.video.audioBytes !== null ? b.video.audioBytes - a.video.audioBytes : null, first: a, second: b };
}
async function waitPlaying(c, ms = 30000) {
  let last = null;
  const ok = await waitFor(async () => {
    const s = await view(c);
    if (s.soundButton) { result.notes.push(`${c.name}: autoplay with sound blocked, pressed 소리 켜기`); await press(c, `window.__e2e.button('소리 켜기')`); }
    if (!(s.video?.w > 0)) return null;
    last = await playing(c, 1500);
    return last.ok && !last.second.overlay ? last : null;
  }, ms, 200);
  return ok || { ...(last || {}), ok: false };  // never a sample that missed the condition (an overlay still shown)
}
async function chooseQuality(c, pick) {
  await ev(c, `(() => { const b = document.querySelector('[data-testid="watch-controls"] button[aria-label="화질"]'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return !!b; })()`);
  const options = await waitFor(() => ev(c, `(() => { const g = document.querySelector('[role="group"][aria-label="화질 선택"]'); return g ? [...g.querySelectorAll('label')].map(l => { const i = l.querySelector('input[type="radio"]'); return { value: i ? i.value : null, text: l.textContent.trim() }; }) : null; })()`), 6000, 100);
  if (!options) return { options: null, chosen: null };
  const index = options.findIndex(o => (pick === 'auto' ? o.value === 'auto' || o.text.startsWith('자동') : o.value !== 'auto' && o.text.includes(pick)));
  if (index < 0) return { options, chosen: null };
  await ev(c, `(() => { const g = document.querySelector('[role="group"][aria-label="화질 선택"]'); g.querySelectorAll('label')[${index}].querySelector('input[type="radio"]').click(); return true; })()`);
  return { options, chosen: options[index] };
}
const NICK = 'button[aria-label^="채팅 닉네임"]';
async function setNickname(c, name) {
  if (!(await waitFor(() => ev(c, `(() => { const b = document.querySelector('${NICK}'); return !!b && !b.disabled; })()`), 20000, 100))) return { ok: false, reason: 'chat not connected' };
  if ((await ev(c, `document.querySelector('${NICK}').getAttribute('aria-label')`)).endsWith('현재 ' + name)) return { ok: true };
  await ev(c, `document.querySelector('${NICK}').click(); true`);
  if (!(await waitFor(() => ev(c, `!!window.__e2e.labelled('닉네임')`), 5000, 100))) return { ok: false, reason: 'no nickname dialog' };
  await ev(c, `window.__e2e.setValue(window.__e2e.labelled('닉네임'), ${JSON.stringify(name)}); true`);
  await sleep(100);
  await ev(c, `window.__e2e.labelled('닉네임').form.querySelector('button[type="submit"]').click(); true`);
  return { ok: !!(await waitFor(() => ev(c, `(() => { const b = document.querySelector('${NICK}'); return !!b && b.getAttribute('aria-label').endsWith(${JSON.stringify('현재 ' + name)}) && !document.querySelector('dialog[open]'); })()`), 10000, 100)) };
}
const countText = text => `[...document.querySelectorAll('[role="log"] li')].filter(li => li.textContent.includes(${JSON.stringify(text)})).length`;
async function sendChat(c, text) {
  if (!(await waitFor(() => ev(c, `(() => { const t = window.__e2e.labelled('채팅 메시지 입력'); return !!t && !t.readOnly; })()`), 15000, 100))) return { ok: false, reason: 'composer not ready' };
  await ev(c, `window.__e2e.setValue(window.__e2e.labelled('채팅 메시지 입력'), ${JSON.stringify(text)}); true`);
  await sleep(50);
  const t0 = Date.now();
  const clicked = await ev(c, `(() => { const b = [...window.__e2e.labelled('채팅 메시지 입력').form.querySelectorAll('button[type="submit"]')].find(x => x.textContent.trim() === '보내기'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  const shown = await waitFor(() => ev(c, `(() => { const t = window.__e2e.labelled('채팅 메시지 입력'); const b = t.form.querySelector('button[type="submit"]'); const n = ${countText(text)}; return n >= 1 && b.textContent.trim() === '보내기' && t.value === '' ? n : 0; })()`), 10000, 50);
  const sent = c.frames.find(f => f.dir === 'out' && f.type === 'send' && f.t >= t0);
  const ack = sent && c.frames.find(f => f.dir === 'in' && f.type === 'ack' && f.clientId === sent.clientId);
  return { ok: !!(clicked && shown && ack?.ok), ackMs: shown ? Date.now() - t0 : null, id: ack?.id ?? null };
}
// A second chat client (Node, WSS through Caddy) joined to the broadcast: collects what it receives.
function chatClient() {
  const c = { messages: [], history: null, state: null, closed: false };
  c.ready = new Promise(resolve => {
    const ws = new WebSocket(`wss://${HOST}${PORT === 443 ? '' : ':' + PORT}/${PATH}/chat`);
    c.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', broadcastId: ID, name: '' }));
    ws.onmessage = e => { const m = parse(e.data); if (!m) return; if (m.type === 'state') c.state = { connected: m.connected }; if (m.type === 'history') { c.history = (m.messages || []).map(x => x.id); resolve(true); } if (m.type === 'message') c.messages.push({ id: m.id, text: m.text }); };
    ws.onerror = () => resolve(false);
    ws.onclose = () => { c.closed = true; resolve(false); };
    setTimeout(() => resolve(false), 10000);
  });
  return c;
}
let pageProtocols = null;  // H8's tally of the page's HTTP versions, written next to the Caddy log's
const isMedia = p => new RegExp(`^/${PATH}/(?:b/[0-9a-f]{32}/)?(?:live\\.m3u8|(?:[a-z0-9]+/)?hls/|dvr)`).test(p);
const isSession = p => /\/session(?:\/[0-9a-f]{32})?$/.test(p);
const EXEMPT = new RegExp(`^/${PATH}/(?:info|chat|stats)$`);

async function browser() {
  edge = start('edge', EDGE, ['--headless=new', `--remote-debugging-port=${EDGE_PORT}`, `--user-data-dir=${join(TMP, 'edge')}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(S.tls === 'internal' && peer.spki ? [`--ignore-certificate-errors-spki-list=${peer.spki}`] : []), '--window-size=1920,1080', 'about:blank'], { logDir: TMP });
  if (!(await waitFor(async () => (await fetch(`http://127.0.0.1:${EDGE_PORT}/json/version`)).ok, 30000))) throw new Error('Edge DevTools did not come up');
  page = await openTab('page');

  // H1 list -> card -> watch page
  const opened0 = await go(page, ORIGIN + '/_frame/live', '/_frame/live');
  const sel = `a[aria-label=${JSON.stringify(`${TITLE}, ${PUBLISHER} 방송 시청하기`)}]`, want = `/_frame/watch/${PATH}/${ID}`;
  const card = await waitFor(() => ev(page, `!!document.querySelector(${JSON.stringify(sel)})`), 20000, 100);
  await sleep(800);
  await shot(page, 'https-list');
  const tOpen = Date.now();
  const pressed = card ? await press(page, `document.querySelector(${JSON.stringify(sel)})`) : false;
  const opened = await waitFor(async () => (await ev(page, 'location.pathname')) === want, 10000, 50);
  const secure = page.security.at(-1)?.state;
  check('H1 list: /_frame/live on the HTTPS address shows the test broadcast; its card opens /_frame/watch/<path>/<id>', opened0 && card && pressed && opened,
    { loaded: opened0, cardShown: !!card, opened: !!opened });
  if (S.tls === 'internal') notRun('H1b Edge security state "secure" without any certificate flag', 'Caddy local CA: Edge trusts it only through --ignore-certificate-errors-spki-list', { securityState: secure });
  else check('H1b Edge security state: "secure" with no certificate flag (the default trust store)', secure === 'secure', { securityState: secure });

  // H2 playback with the test tone
  const first = await waitPlaying(page, 30000);
  const firstFrameMs = first.ok ? Date.now() - tOpen : null;
  const hd = await waitFor(async () => { const s = await view(page); return s.video?.h === 720 ? s : null; }, 45000, 250);
  const play = await playing(page, 4000);
  const s2 = play.second;
  check('H2 playback: hls.js, 1280x720, test tone decoded, no RTCPeerConnection', first.ok && hd && play.ok && s2.video?.w === 1280 && s2.video?.h === 720 && play.audioBytes > 0 && s2.rt?.transport === 'hls.js' && s2.pcs === 0 && s2.rt?.watch?.broadcastId === ID,
    { firstFrameMs, size: s2.video && `${s2.video.w}x${s2.video.h}`, audioBytes: play.audioBytes, transport: s2.rt?.transport, pcs: s2.pcs, latencyS: s2.rt?.playback?.latency, level: s2.rt?.playback?.level });
  await shot(page, 'https-playing');

  // H3 direct link reload
  const tReload = Date.now();
  await ev(page, 'window.__old = true', 3000).catch(() => {});
  await cmd(page, 'Page.reload', { ignoreCache: true });
  const reloaded = await waitFor(() => ev(page, `!window.__old && document.readyState === 'complete' && location.pathname === ${JSON.stringify(want)}`, 3000), 25000, 100);
  const again = reloaded ? await waitPlaying(page, 30000) : { ok: false };
  const doc = page.net.filter(e => e.t >= tReload && e.type === 'Document').at(-1);
  check('H3 direct link: reloading /_frame/watch/<path>/<id> (index.html from Caddy) plays the same broadcast again', !!reloaded && again.ok && again.second?.rt?.watch?.broadcastId === ID && doc?.status === 200,
    { document: doc && { status: doc.status, protocol: doc.protocol }, playsAgainAfterMs: again.ok ? Date.now() - tReload : null });

  // H4 quality: 480p, then 자동
  const pick = await chooseQuality(page, '480p');
  const tq = Date.now();
  const to480 = await waitFor(async () => (await view(page)).video?.h === 480, 15000, 100);
  const q480 = await playing(page, 3000);
  check('H4a quality: 480p from the menu -> 480 lines, keeps playing', !!pick.chosen && to480 && q480.ok && q480.second.video?.h === 480,
    { options: pick.options?.map(o => o.text), switchMs: to480 ? Date.now() - tq - 3000 : null, height: q480.second.video?.h, advancedSIn3s: q480.advancedS, activeQualityLabel: q480.second.rt?.playback?.activeQualityLabel });
  const pickAuto = await chooseQuality(page, 'auto');
  const ta = Date.now();
  const back = await waitFor(async () => (await view(page)).video?.h === 720, 45000, 200);
  const qa = await playing(page, 2000);
  check('H4b quality: 자동 -> back to 720', !!pickAuto.chosen && back && qa.ok && qa.second.video?.h === 720, { backMs: back ? Date.now() - ta - 2000 : null, quality: qa.second.rt?.playback?.quality });
  // --quality-repeats N: the same switch N more times, recorded only (how far the video advances in the 3 s after each
  // switch to 480p). The 480p encoder runs on this PC next to the browser, so a single switch can stall under load.
  for (let i = 0; i < QUALITY_REPEATS; i++) {
    await chooseQuality(page, '480p');
    const t = Date.now();
    const reached = await waitFor(async () => (await view(page)).video?.h === 480, 15000, 100);
    const to480Ms = reached ? Date.now() - t : null;
    const after = await playing(page, 3000);
    await chooseQuality(page, 'auto');
    const backAgain = await waitFor(async () => (await view(page)).video?.h === 720, 45000, 200);
    await playing(page, 2000);
    (result.qualityRepeats ||= []).push({ to480Ms, advancedSIn3s: after.advancedS, ok: !!reached && after.ok, backTo720: !!backAgain });
  }
  if (result.qualityRepeats) console.log('quality repeats: ' + JSON.stringify(result.qualityRepeats.map(r => r.advancedSIn3s)) + ' stalled ' + result.qualityRepeats.filter(r => !r.ok).length + '/' + result.qualityRepeats.length);

  // H5 rewind 30-60 s, then 실시간 복귀
  const range = await waitFor(async () => {
    const r = await ev(page, `(() => { const i = document.querySelector('input[aria-label="재생 위치"]'); return i && !i.disabled ? { min: Number(i.min), max: Number(i.max) } : null; })()`);
    return r && r.max - r.min >= 65000 ? r : null;
  }, 120000, 1000);
  if (!range) check('H5a rewind 45 s', false, { reason: 'timeline shorter than 65 s' });
  else {
    const td = Date.now();
    const target = await ev(page, `(() => { const i = document.querySelector('input[aria-label="재생 위치"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, String(Number(i.max) - 45000)); const v = Number(i.value); i.dispatchEvent(new Event('input', { bubbles: true })); return v; })()`);
    const hist = await waitFor(async () => { const r = await playing(page, 1000); return r.ok && r.second.rt?.playback?.mode === 'history' ? r : null; }, 25000, 100);
    const pb = hist?.first?.rt?.playback;
    const offset = pb && Number.isFinite(pb.positionMs) ? pb.positionMs - target : null;
    const behind = pb && Number.isFinite(pb.liveMs) && Number.isFinite(pb.positionMs) ? Math.round((pb.liveMs - pb.positionMs) / 1000) : null;
    const dvr = page.net.filter(e => e.t >= td && /\/dvr/.test(e.path));
    check('H5a rewind: 45 s before live -> history mode within ~5 s of the target, recording from /<path>/b/<id>/dvr*', !!hist && offset !== null && Math.abs(offset) <= 5000 && dvr.length > 0 && dvr.every(e => e.path.startsWith(scope())),
      { range: { spanS: Math.round((range.max - range.min) / 1000) }, offsetMs: offset, behindLiveS: behind, toHistoryMs: hist ? Date.now() - td : null, dvrRequests: dvr.length, audioBytes: hist?.audioBytes });
    await shot(page, 'https-history');
    const tl = Date.now();
    const pressedLive = await ev(page, `(() => { const b = window.__e2e.button('실시간 복귀'); if (b) b.click(); return !!b; })()`);
    const liveAgain = await waitFor(async () => { const s = await view(page); const p = s.rt?.playback; return p?.mode === 'live' && Number.isFinite(p.latency) && p.latency < 4 && s.video?.w > 0 ? s : null; }, 20000, 200);
    const lp = await playing(page, 2000);
    check('H5b 실시간 복귀: live again, latency < 4 s', pressedLive && !!liveAgain && lp.ok && lp.second.rt?.playback?.mode === 'live', { backMs: liveAgain ? Date.now() - tl - 2000 : null, latencyS: liveAgain?.rt?.playback?.latency });
  }

  // H6 chat over WSS, a Node client on the same broadcast receives once
  const node = chatClient();
  const nodeReady = await node.ready;
  const nick = await setNickname(page, 'HTTPS 시험');
  const text = `HTTPS 채팅 확인 ${randomBytes(3).toString('hex')}`;
  const tc = Date.now();
  const sent = await sendChat(page, text);
  const got = await waitFor(() => node.messages.filter(m => m.text === text).length ? Date.now() : 0, 10000, 50);
  await sleep(1500);
  const pageSockets = page.ws.filter(x => /\/chat$/.test(x.url));
  check('H6 chat: WSS through Caddy, nickname, send + ack; a second client on the broadcast receives it exactly once',
    nodeReady && nick.ok && sent.ok && node.messages.filter(m => m.text === text).length === 1 && pageSockets.length >= 1 && pageSockets.every(x => x.url.startsWith(`wss://${HOST}`)) && [101, 200].includes(pageSockets[0].status),
    { nodeClient: { joined: nodeReady, received: node.messages.filter(m => m.text === text).length, afterMs: got ? got - tc : null }, ackMs: sent.ackMs, pageSocket: pageSockets.map(x => ({ url: anon(x.url), handshakeStatus: x.status, statusText: x.statusText })) });

  // H7 a Caddy reload drops the socket; the page reconnects and redraws the history without duplicates
  const tr = Date.now();
  const reload = await (await fetch(CONTROL + '/reload-caddy', { method: 'POST' })).json();
  const dropped = await waitFor(() => page.ws.some(x => /\/chat$/.test(x.url) && x.closedAt && x.closedAt >= tr) ? true : null, 15000, 100);
  const reconnected = await waitFor(async () => { const n = page.ws.filter(x => /\/chat$/.test(x.url) && x.t >= tr); const s = await view(page); return n.length && s.rt?.chat?.status === 'connected' ? n : null; }, 30000, 200);
  await sleep(1500);
  const historyAfter = page.frames.filter(f => f.dir === 'in' && f.type === 'history' && f.t >= tr).at(-1);
  const times = await ev(page, countText(text));
  const ids = historyAfter?.ids || [];
  const stillPlaying = await playing(page, 2000);
  check('H7 chat drop: caddy reload --force closes the WSS; the page reconnects, redraws the history once (message shown once, no duplicate ids) and keeps playing',
    reload.code === 0 && !!dropped && !!reconnected && !!historyAfter && ids.includes(sent.id) && new Set(ids).size === ids.length && times === 1 && stillPlaying.ok,
    { reload: { code: reload.code }, droppedAfterMs: dropped ? (page.ws.find(x => /\/chat$/.test(x.url) && x.closedAt >= tr)?.closedAt - tr) : null, reconnectedAfterMs: reconnected ? reconnected[0].t - tr : null,
      newSocketStatus: reconnected?.[0]?.status, historyIds: ids.length, duplicates: ids.length - new Set(ids).size, shownTimes: times, nodeClientClosed: node.closed, playing: stillPlaying.ok });
  try { node.ws.close(); } catch {}

  // H8 every request of the page: the test origin over https / wss, no mixed content, scoped media/DVR/session
  const all = page.net;
  const foreign = all.filter(e => e.origin !== ORIGIN);
  const plain = all.filter(e => e.scheme !== 'https:');
  const mixed = [...page.console.filter(x => /mixed content/i.test(x.text)), ...page.issues.filter(x => /MixedContent/i.test(x.code || ''))];
  const protocols = pageProtocols = all.reduce((o, e) => (e.protocol ? (o[e.protocol] = (o[e.protocol] || 0) + 1, o) : o), {});
  const remotes = [...new Set(all.map(e => e.remote).filter(Boolean))];
  const media = all.filter(e => isMedia(e.path)), sessions = all.filter(e => isSession(e.path));
  const outside = all.filter(e => e.path.startsWith(`/${PATH}/`) && !EXEMPT.test(e.path) && !e.path.startsWith(scope()));
  check('H8 network: every request on the test origin over https (sockets wss), no mixed content, media/DVR/session only under /<path>/b/<id>/',
    all.length > 0 && foreign.length === 0 && plain.length === 0 && mixed.length === 0 && page.ws.every(x => x.url.startsWith(`wss://${HOST}`)) && media.length > 0 && sessions.length > 0 && outside.length === 0,
    { requests: all.length, foreign: foreign.slice(0, 5).map(e => anon(e.origin + e.path)), plainHttp: plain.length, mixedContent: mixed.slice(0, 5), protocols, remoteAddresses: remotes.map(anon),
      mediaRequests: media.length, sessionRequests: sessions.map(e => `${e.method} ${e.path.replace(ID, '<id>')} ${e.status}`).slice(0, 6), outsideScope: outside.slice(0, 5).map(e => e.path),
      consoleErrors: page.console.filter(x => x.level !== 'warning').slice(0, 10).map(x => ({ ...x, text: anon(x.text) })) });
  await shot(page, 'https-after');

  // H9 the legacy viewer at /<path> through Caddy (relay-served page): loads and plays
  legacyTab = await openTab('legacy');
  const legacyLoaded = await go(legacyTab, `${ORIGIN}/${PATH}`, `/${PATH}`);
  const legacyPlay = await waitFor(async () => {
    const a = await ev(legacyTab, `(() => { const v = document.querySelector('video'); return v ? v.currentTime : -1; })()`);
    await sleep(1500);
    const b = await ev(legacyTab, `(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, w: v.videoWidth } : null; })()`);
    return b && b.w > 0 && b.t - a > 0.7 ? b : null;
  }, 40000, 500);
  check('H9 legacy /<path> page through Caddy: loads over https and its video advances', legacyLoaded && !!legacyPlay && legacyTab.net.every(e => e.origin === ORIGIN),
    { loaded: legacyLoaded, videoWidth: legacyPlay?.w ?? null, requests: legacyTab.net.length, foreign: legacyTab.net.filter(e => e.origin !== ORIGIN).slice(0, 3).map(e => anon(e.origin)) });

  // H10 the relay web service restarts under a playing page (a deploy; here the process is killed and started again). Its
  // broadcast list and chat rooms are in memory, so the sender's next announcement (every 2 s) lists the broadcast again.
  // Measured: how long Caddy answers 502, when the list has the broadcast again, whether the open watch page plays again
  // by itself (and what it showed meanwhile), and that a fresh page load plays. The Spring backend answers "not ready yet"
  // for 5 s after a start (its start-up grace), so there the open page must wait and continue by itself with its chat; the
  // Node relay (the comparison backend) says "not running" at once, which ends the open page: recorded, not required.
  await cmd(page, 'Page.bringToFront');
  const beforeRestart = await waitPlaying(page, 20000);
  const t10 = Date.now();
  const restarting = fetch(CONTROL + '/restart-relay', { method: 'POST' }).then(r => r.json()).catch(e => ({ error: e.message }));
  const seen = { statuses: {}, overlays: [], kinds: [] };
  const sample = async () => { const s = await view(page).catch(() => null); if (!s) return; if (s.overlay && !seen.overlays.includes(s.overlay)) seen.overlays.push(s.overlay); const k = s.rt?.watch?.kind; if (k && seen.kinds.at(-1) !== k) seen.kinds.push(k); };
  let first502 = null, last502 = null, listedAt = null, restartDone = null;
  restarting.then(v => { restartDone = v; });
  while (Date.now() - t10 < 60000) {
    const [h, l] = await Promise.all([raw(ORIGIN + '/healthz').catch(() => ({ status: 0 })), raw(ORIGIN + '/api/broadcasts').catch(() => ({ status: 0 }))]);
    seen.statuses[h.status] = (seen.statuses[h.status] || 0) + 1;
    if (h.status === 502) { first502 ??= Date.now(); last502 = Date.now(); }
    let listed = false;
    try { listed = l.status === 200 && JSON.parse(l.text).items.some(i => i.id === ID); } catch {}
    await sample();
    if (restartDone && listed) { listedAt = Date.now(); break; }
    await sleep(restartDone ? 150 : 20);  // dense while the service is down: the Node relay is back within about 0.1 s
  }
  const restart = await restarting;
  // What the open page shows is sampled until it plays again (ready, no overlay, the video advancing) or for 45 s more; the
  // time is taken at that moment, before the checks that follow.
  // A page that only plays on from its buffer has not recovered yet: it counts once it has left "ready" and come back, or
  // (it never noticed the restart) after 10 s of steady playback, timed from the start of that steady stretch.
  let selfRecovered = { ok: false }, recoveredMs = null, steadySince = null;
  for (const until = Date.now() + 45000; Date.now() < until && recoveredMs === null;) {
    await sample();
    const p = await playing(page, 1000);
    if (!(p.ok && !p.second.overlay && p.second.rt?.watch?.kind === 'ready')) { steadySince = null; continue; }
    steadySince ??= Date.now();
    const leftReady = seen.kinds.length > 1;
    if (leftReady || Date.now() - steadySince >= 10000) { selfRecovered = p; recoveredMs = (leftReady ? Date.now() : steadySince) - t10; }
  }
  await sample();
  const afterView = await view(page);
  const chatBack = await waitFor(async () => (await view(page)).rt?.chat?.status === 'connected' ? true : null, 20000, 250);
  const legacyAgain = await waitFor(async () => {
    const a = await ev(legacyTab, `(() => { const v = document.querySelector('video'); return v ? v.currentTime : -1; })()`).catch(() => -1);
    await sleep(1500);
    const b = await ev(legacyTab, `(() => { const v = document.querySelector('video'); return v ? v.currentTime : -1; })()`).catch(() => -1);
    return b - a > 0.7 ? true : null;
  }, 30000, 500);
  const fresh = await openTab('after-restart');
  const freshLoaded = await go(fresh, `${ORIGIN}/_frame/watch/${PATH}/${ID}`, `/_frame/watch/${PATH}/${ID}`);
  const freshPlay = freshLoaded ? await waitPlaying(fresh, 40000) : { ok: false };
  check('H10 relay web service restart: Caddy answers 502 meanwhile, then the broadcast is listed again, a fresh watch page plays' + (S.backend === 'spring' ? ', and the open page continues by itself with its chat' : ''),
    !restart.error && restart.upAfterMs !== null && first502 !== null && !!listedAt && !!freshPlay.ok && (S.backend !== 'spring' || (!!selfRecovered.ok && !!chatBack && !seen.kinds.includes('ended'))),
    { backend: S.backend || 'node', stopMs: restart.stopMs, serviceUpAfterMs: restart.upAfterMs, caddy502ForMs: first502 !== null ? last502 - first502 : null, listedAgainAfterMs: listedAt ? listedAt - t10 : null,
      statusesViaCaddy: seen.statuses, playingBefore: !!beforeRestart.ok,
      openPage: { playsAgainByItself: !!selfRecovered.ok, afterMs: recoveredMs, leftReady: seen.kinds.length > 1, overlaysSeen: seen.overlays, watchKinds: seen.kinds, finalKind: afterView.rt?.watch?.kind ?? null, finalOverlay: afterView.overlay, chatReconnected: !!chatBack },
      legacyPagePlaysAgainByItself: !!legacyAgain,
      freshPage: { loaded: freshLoaded, plays: !!freshPlay.ok, kind: freshPlay.second?.rt?.watch?.kind ?? null } });
  await shot(page, 'https-after-restart');
}

const t0 = Date.now();
// A hang (a CDP call that never answers), a watchdog expiry or Ctrl+C all end in the same cleanup: Edge stopped by PID, the
// result written. Never leaves a headless Edge running on the shared PC.
let finished = null;
const WATCHDOG_MS = 15 * 60 * 1000;
const watchdog = setTimeout(() => { check('H browser run finished within 15 min', false, { error: 'watchdog' }); finish().then(() => process.exit(1)); }, WATCHDOG_MS);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { result.notes.push('interrupted: ' + sig); finish().then(() => process.exit(130)); });
try { await browser(); }
catch (error) { check('H browser run', false, { error: anon(error.stack || error.message).slice(0, 600) }); }
finally { await finish(); clearTimeout(watchdog); }
// A failed check is a failed run for whoever called this (a shell, a wrapper script).
process.exit(result.failed ? 1 : 0);

function finish() {
  if (finished) return finished;
  finished = finishRun();
  return finished;
}
async function finishRun() {
  for (const c of [page, legacyTab].filter(Boolean)) result.pages[c.name] = { requests: c.net.length, sockets: c.ws.map(x => ({ url: anon(x.url), status: x.status, t: x.t, closedAt: x.closedAt })), console: c.console.slice(-30).map(x => ({ ...x, text: anon(x.text) })), issues: c.issues.slice(-10), security: c.security.slice(-3) };
  for (const c of [page, legacyTab].filter(Boolean)) try { c.close(); } catch {}
  await stop(edge);
  const left = killByCommandLine(TMP);
  if (left.length) result.notes.push('stopped leftover Edge processes: ' + left.join(','));
  // Caddy access log of this run: protocols and statuses as Caddy saw them (WebSocket upgrades, 503s).
  try {
    const since = t0 / 1000 - 600;
    const rows = readFileSync(join(DIR, 'caddy-access.log'), 'utf8').split('\n').map(parse).filter(r => r && r.ts >= since);
    const tally = (f) => rows.reduce((o, r) => { const k = f(r); o[k] = (o[k] || 0) + 1; return o; }, {});
    result.caddyLog = { rows: rows.length, byProto: tally(r => r.request?.proto), pageProtocols, chat: rows.filter(r => /\/chat$/.test(r.request?.uri || '')).map(r => ({ proto: r.request.proto, method: r.request.method, status: r.status })).slice(-10),
      retryAfter503: rows.filter(r => r.status === 503).map(r => ({ uri: anon(String(r.request?.uri).replace(/[0-9a-f]{32}/g, '<id>')), retryAfter: r.resp_headers?.['Retry-After']?.[0] ?? null })).slice(-6) };
  } catch (error) { result.notes.push('caddy access log not read: ' + error.message); }
  result.finishedAt = new Date().toISOString(); result.durationS = Math.round((Date.now() - t0) / 1000);
  result.passed = list.filter(c => c.ok === true).length; result.failed = list.filter(c => c.ok === false).length; result.notRun = list.filter(c => c.ok === null).length;
  writeFileSync(join(OUT, 'https-check-result.json'), scrub(anon(JSON.stringify(result, null, 2)), ROOT));
  console.log(`\n${result.passed} passed, ${result.failed} failed, ${result.notRun} not run in ${result.durationS} s -> ${S.backend === 'spring' ? 'verification/spring/caddy' : 'verification/caddy'}/https-check-result.json`);
  for (const c of list.filter(x => x.ok === false)) console.log('  FAIL ' + c.name);
  for (const c of list.filter(x => x.ok === null)) console.log('  NOT RUN ' + c.name + ' (' + c.notRun + ')');
  try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}  // the Edge profile of this run
}
