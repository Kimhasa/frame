// End-to-end check of the internet relay on one PC (loopback, ports 24000-24999): relay MediaMTX with deploy/mediamtx-relay.yml
// (only environment overrides: ports, password hashes, certificate), server/relay.mjs serving outputs/index.html, a sender
// side like FrameConsole.exe (local MediaMTX + FFmpeg publisher + the app-style FFmpeg forwarder to the relay over RTSPS,
// restarted with backoff), per-sender publish accounts, announcements, playback reports and headless Edge pages using the
// unchanged UI: list, playback, quality switch, chat between pages, DVR, HLS, and the same over HTTPS/WSS through
// server/tls-front.mjs. Evidence: deploy/verification/e2e-result.json, *.png, logs/ (secrets masked).
// Usage: node server/verify/e2e.mjs [--keep]
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { start, stop, stopAll, waitFor, sleep, checks, ffprobe, killByCommandLine, portFree } from './harness.mjs';
import { connect } from '../../tools/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'deploy/verification');
const TMP = join(tmpdir(), 'frame-relay-e2e-' + Date.now());
const BIN = join(ROOT, 'dist/FrameConsole/bin');
const FFMPEG = join(BIN, 'ffmpeg.exe'), MEDIAMTX = join(BIN, 'mediamtx.exe');
const FFPROBE = join(ROOT, 'build/third_party/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OPENSSL = ['C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'].find(existsSync);
const PORT = { rtsp: 24554, rtsps: 24322, rtp: 24000, rtcp: 24001, webrtc: 24889, ice: 24189, hls: 24888, api: 24997, playback: 24996, metrics: 24998, relay: 24080,
  relayLimits: 24081, apiProxy: 24990, tls: 24443, edge: 24222, senderRtsp: 24654, senderApi: 24697 };
const RELAY = `http://127.0.0.1:${PORT.relay}`, HTTPS = `https://127.0.0.1:${PORT.tls}`;
// The deploy yml's two example sender accounts: frame-sender-01 may publish only screen-01, frame-sender-02 only screen-02.
const PATH = 'screen-01', PATH_B = 'screen-02', USER_A = 'frame-sender-01', USER_B = 'frame-sender-02';
const NOMEDIA = 'nomedia';  // announced by sender A's token, never receives media

for (const d of [TMP, OUT, join(OUT, 'logs')]) mkdirSync(d, { recursive: true });
const { list, check } = checks();
const result = { startedAt: new Date().toISOString(), host: { name: process.env.COMPUTERNAME || '', logicalCpus: cpus().length }, tools: {}, ports: PORT, checks: list, notes: [] };
const secret = () => randomBytes(18).toString('hex');
const PASS_A = secret(), PASS_B = secret(), WRONG_PASS = secret(), TOKEN_A = secret() + secret(), TOKEN_B = secret() + secret(), TURN_SECRET = secret();
const SECRETS = [PASS_A, PASS_B, WRONG_PASS, TOKEN_A, TOKEN_B, TURN_SECRET];
// Every saved log and the result file go through this: known secrets and any user:password@ in a URL become ***.
const mask = s => SECRETS.reduce((t, x) => t.replaceAll(x, '***'), String(s)).replace(/(rtsps?:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1***@');
const BROADCAST_ID = randomBytes(16).toString('hex');
const sha = s => createHash('sha256').update(s).digest('base64');
const STATS_DIR = join(TMP, 'stats');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';  // self-signed local test certificate only (this process)

// Host load while the checks run (whole PC, all processes): the PC is shared, so timings are only comparable with this.
const cpuSamples = [];
let cpuPrev = cpus();
const cpuTimer = setInterval(() => {
  const now = cpus(); let idle = 0, total = 0;
  now.forEach((c, i) => { const p = cpuPrev[i].times, t = c.times; const d = k => t[k] - p[k]; idle += d('idle'); total += d('user') + d('nice') + d('sys') + d('irq') + d('idle'); });
  cpuPrev = now; if (total > 0) cpuSamples.push(Math.round(100 * (1 - idle / total)));
}, 5000);
cpuTimer.unref();
const safeProbe = file => { try { return ffprobe(FFPROBE, file); } catch (error) { return { error: String(error.message).split('\n')[0] } } };
const getJson = async (url, init) => { const r = await fetch(url, init); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };

let edge, mediamtx, mediamtxFirst, sender, relay, front, publisher, announcer, forwarder, apiProxy;
async function main() {
  // A port still held by an earlier run would make this run talk to stale processes: stop instead.
  const busyPorts = [];
  for (const p of Object.values(PORT)) if (!(await portFree(p))) busyPorts.push(p);
  if (busyPorts.length) throw new Error('ports in use: ' + busyPorts.join(','));
  result.tools = {
    node: process.version, mediamtx: execFileSync(MEDIAMTX, ['--version']).toString().trim(),
    ffmpeg: execFileSync(FFMPEG, ['-version']).toString().split('\n')[0].trim(), edge: (() => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${EDGE}').VersionInfo.ProductVersion`]).toString().trim(); } catch { return 'unknown'; } })()
  };
  try { result.host.otherProcesses = execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process ffmpeg,mediamtx,msedge,FrameConsole -ErrorAction SilentlyContinue | Group-Object ProcessName | ForEach-Object { $_.Name + '=' + $_.Count }"]).toString().trim().split(/\s+/); } catch {}

  // ---- certificate (RTSPS and the HTTPS front) ----
  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', join(TMP, 'key.pem'), '-out', join(TMP, 'cert.pem')], { stdio: 'ignore' });

  // ---- relay MediaMTX: the deploy file as is, ports/password hashes/cert from environment ----
  const mtxDir = join(TMP, 'mediamtx'); mkdirSync(mtxDir, { recursive: true });
  copyFileSync(join(ROOT, 'deploy/mediamtx-relay.yml'), join(mtxDir, 'mediamtx.yml'));
  const mtxEnv = {
    MTX_AUTHINTERNALUSERS_1_PASS: 'sha256:' + sha(PASS_A), MTX_AUTHINTERNALUSERS_2_PASS: 'sha256:' + sha(PASS_B),
    MTX_RTSPADDRESS: `127.0.0.1:${PORT.rtsp}`, MTX_RTSPSADDRESS: `127.0.0.1:${PORT.rtsps}`,
    MTX_RTPADDRESS: `127.0.0.1:${PORT.rtp}`, MTX_RTCPADDRESS: `127.0.0.1:${PORT.rtcp}`, MTX_RTSPSERVERKEY: join(TMP, 'key.pem'), MTX_RTSPSERVERCERT: join(TMP, 'cert.pem'),
    MTX_WEBRTCADDRESS: `127.0.0.1:${PORT.webrtc}`, MTX_WEBRTCLOCALUDPADDRESS: `127.0.0.1:${PORT.ice}`, MTX_WEBRTCLOCALTCPADDRESS: `127.0.0.1:${PORT.ice}`,
    MTX_WEBRTCADDITIONALHOSTS: '127.0.0.1', MTX_HLSADDRESS: `127.0.0.1:${PORT.hls}`, MTX_APIADDRESS: `127.0.0.1:${PORT.api}`, MTX_PLAYBACKADDRESS: `127.0.0.1:${PORT.playback}`,
    MTX_METRICSADDRESS: `127.0.0.1:${PORT.metrics}`, PATH: BIN + ';' + process.env.PATH  // "ffmpeg" in runOnDemand resolves to the bundled build
  };
  mediamtx = start('mediamtx', MEDIAMTX, ['mediamtx.yml'], { cwd: mtxDir, env: mtxEnv, logDir: TMP });
  check('mediamtx starts with deploy yml', await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT.api}/v3/paths/list`)).ok, 15000), { log: mediamtx.lines.slice(0, 3) });

  // ---- relay web service ----
  const relayEnv = port => ({
    RELAY_PORT: String(port), RELAY_PUBLISHER_TOKENS: `${TOKEN_A} ${PATH} ${NOMEDIA},${TOKEN_B} ${PATH_B}`, RELAY_MEDIAMTX_API: `http://127.0.0.1:${PORT.api}`,
    RELAY_MEDIAMTX_WEBRTC: `http://127.0.0.1:${PORT.webrtc}`, RELAY_MEDIAMTX_HLS: `http://127.0.0.1:${PORT.hls}`, RELAY_MEDIAMTX_PLAYBACK: `http://127.0.0.1:${PORT.playback}`,
    RELAY_RECORD_DIR: join(mtxDir, 'recordings'), RELAY_RENDITIONS: '480p', RELAY_HLS_AAC: '1', RELAY_TURN_URLS: 'turn:turn.example.invalid:3478?transport=udp',
    RELAY_TURN_SECRET: TURN_SECRET, RELAY_TURN_TTL_S: '600', RELAY_LOG_LEVEL: 'info', RELAY_STATS_DIR: STATS_DIR
  });
  relay = start('relay', process.execPath, [join(ROOT, 'server/relay.mjs')], { logDir: TMP, env: relayEnv(PORT.relay) });
  check('relay /healthz ok', await waitFor(async () => (await (await fetch(RELAY + '/healthz')).json()).mediamtx, 15000));

  // ---- publishing: certificate, credentials, per-sender accounts ----
  // FFmpeg 9 verifies the RTSPS certificate by default; the local self-signed one is trusted explicitly with -ca_file.
  const tls = ['-ca_file', join(TMP, 'cert.pem')];
  const pubArgs = (url, tlsArgs = tls) => ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-bf', '0', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-b:v', '3M', '-maxrate', '3M', '-bufsize', '3M', '-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp', '-pkt_size', '1190', ...(url.startsWith('rtsps:') ? tlsArgs : []), url];
  const tryPublish = async (name, url, tlsArgs) => {
    const p = start(name, FFMPEG, pubArgs(url, tlsArgs), { logDir: TMP });
    const code = await Promise.race([p.exited, sleep(8000).then(() => 'running')]);
    if (code === 'running') await stop(p);
    return { code, refused: code !== 'running', reason: mask(p.lines.find(l => /40[13]|refused|failed|certificate/i.test(l)) || '') };
  };
  const rtsps = (user, pass, path) => `rtsps://${user ? `${user}:${pass}@` : ''}127.0.0.1:${PORT.rtsps}/${path}`;
  const untrusted = await tryPublish('publish-untrusted-cert', rtsps(USER_A, PASS_A, PATH), []);
  check('publisher refuses an untrusted relay certificate', untrusted.refused && /certificate/i.test(untrusted.reason), untrusted);
  const noCreds = await tryPublish('publish-nocreds', rtsps('', '', PATH));
  check('publish without credentials refused', noCreds.refused && /401/.test(noCreds.reason), noCreds);
  const wrong = await tryPublish('publish-wrong', rtsps(USER_A, WRONG_PASS, PATH));
  check('publish with wrong password refused', wrong.refused && /401/.test(wrong.reason), wrong);
  const loop = await tryPublish('publish-loopback-plain', `rtsp://127.0.0.1:${PORT.rtsp}/${PATH}`);
  check('anonymous loopback publish to source path refused', loop.refused && /401/.test(loop.reason), loop);
  const bOnA = await tryPublish('publish-b-on-a', rtsps(USER_B, PASS_B, PATH));
  const aOnB = await tryPublish('publish-a-on-b', rtsps(USER_A, PASS_A, PATH_B));
  check('per-sender accounts: a sender cannot publish another sender\'s path', bOnA.refused && aOnB.refused && /40[13]/.test(bOnA.reason) && /40[13]/.test(aOnB.reason), { bOnA, aOnB });
  const relayPath = async name => (await (await fetch(`http://127.0.0.1:${PORT.api}/v3/paths/get/${encodeURIComponent(name)}`)).json());
  // Sender B publishing its own path directly (the "second FFmpeg output" style), accepted.
  const direct = start('publish-b-own', FFMPEG, pubArgs(rtsps(USER_B, PASS_B, PATH_B)), { logDir: TMP });
  const directReady = await waitFor(async () => (await relayPath(PATH_B)).ready, 20000);
  const directInfo = await relayPath(PATH_B);
  check('sender B publishes its own path over RTSPS', directReady && direct.running, { source: directInfo.source?.type, tracks2: directInfo.tracks2?.map(t => t.codec) });
  await stop(direct);

  // ---- sender PC as FrameConsole.exe runs it: local MediaMTX (loopback, no auth, writeQueueSize 4096) + FFmpeg publisher,
  // and the app's own FFmpeg forwarder (copy, RTSPS, -pkt_size 1190, -ca_file for a self-signed relay) restarted with backoff.
  const sendDir = join(TMP, 'sender'); mkdirSync(sendDir, { recursive: true });
  writeFileSync(join(sendDir, 'mediamtx.yml'), [
    'logLevel: info', 'logDestinations: [stdout]', 'writeQueueSize: 4096', 'authInternalUsers:', '  - user: any', '    pass:', "    ips: ['127.0.0.1', '::1']", '    permissions:', '      - action: publish', '      - action: read', '      - action: api',
    'api: true', `apiAddress: 127.0.0.1:${PORT.senderApi}`, 'rtsp: true', 'rtspTransports: [tcp]', `rtspAddress: 127.0.0.1:${PORT.senderRtsp}`, 'rtmp: false', 'hls: false', 'srt: false', 'moq: false', 'webrtc: false', 'playback: false',
    'paths:', `  ${PATH}:`, '    source: publisher', ''].join('\n'));
  sender = start('sender-mediamtx', MEDIAMTX, ['mediamtx.yml'], { cwd: sendDir, logDir: TMP });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT.senderApi}/v3/paths/list`)).ok, 15000);
  publisher = start('publisher', FFMPEG, pubArgs(`rtsp://127.0.0.1:${PORT.senderRtsp}/${PATH}`), { logDir: TMP });
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${PORT.senderApi}/v3/paths/get/${PATH}`)).json()).ready, 20000);
  const localReady = async () => !!(await (await fetch(`http://127.0.0.1:${PORT.senderApi}/v3/paths/get/${PATH}`)).json()).ready;

  forwarder = startForwarder(rtsps(USER_A, WRONG_PASS, PATH));
  await sleep(6000);
  const wrongFwd = { relayReady: !!(await relayPath(PATH)).ready, localReady: await localReady(), publisherRunning: publisher.running, attempts: forwarder.attempts,
    lastError: mask(forwarder.lines.filter(l => /401|Unauthorized|error/i.test(l)).slice(-1)[0] || '') };
  check('forwarder with wrong password: relay refuses, local stream unaffected, app retries', !wrongFwd.relayReady && wrongFwd.localReady && wrongFwd.publisherRunning && wrongFwd.attempts >= 2, wrongFwd);
  await forwarder.stop();
  const f0 = Date.now();
  forwarder = startForwarder(rtsps(USER_A, PASS_A, PATH));
  const ready = await waitFor(async () => (await relayPath(PATH)).ready, 25000, 100);
  const pathInfo = await relayPath(PATH);
  check('app-style FFmpeg forwarder (copy, RTSPS, -ca_file) reaches the relay', ready, { readyAfterMs: ready ? Date.now() - f0 : null, source: pathInfo.source?.type, tracks2: pathInfo.tracks2?.map(t => t.codec), attempts: forwarder.attempts });
  result.passwordInMediamtxLogs = SECRETS.some(s => sender.lines.some(l => l.includes(s)) || mediamtx.lines.some(l => l.includes(s)));
  check('publish passwords never appear in MediaMTX logs', !result.passwordInMediamtxLogs);
  result.notes.push('FFmpeg forwarder output mentions the password: ' + SECRETS.some(s => forwarder.allLines.some(l => l.includes(s))) + ' (saved logs are masked either way; the password is on the FFmpeg command line of the sender PC)');
  const second = await tryPublish('publish-second', rtsps(USER_A, PASS_A, PATH));
  second.mediamtx = mediamtx.lines.filter(l => /already publishing/i.test(l)).slice(-1)[0] || '';
  check('second publisher on a live path refused (same account)', second.refused && (await relayPath(PATH)).ready, second);

  // ---- announcements (contract v1 of the app) ----
  // The sender's clock runs 60 s ahead of the relay's: sentAtMs lets the relay put startedAtMs on its own clock.
  const SKEW = 60000, senderNow = () => Date.now() + SKEW;
  const appRenditions = [{ name: '480p', width: 852, height: 480, mbps: 1.5, fps: 30, codec: 'H.264' }];  // the sender's own local renditions
  const startedAtSender = senderNow() - 3000;
  const item = { id: BROADCAST_ID, title: '중계 검증 방송', publisher: 'RELAY-TEST', host: '192.168.0.10', port: 8889, path: PATH, width: 1280, height: 720, fps: 30, startedAtMs: startedAtSender, bitrate: 3, audio: 'system', renditions: appRenditions };
  const announce = (token, body, base = RELAY) => fetch(base + '/api/broadcasts/announce', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  const msg = () => ({ v: 1, type: 'announce', item: { ...item, sentAtMs: senderNow() } });
  let r = await announce('', msg()); check('announce without token -> 401', r.status === 401, { status: r.status, wwwAuthenticate: r.headers.get('www-authenticate') });
  r = await announce('x'.repeat(48), msg()); check('announce with wrong token -> 401', r.status === 401, { status: r.status });
  r = await announce(TOKEN_A, { v: 1, type: 'announce', item: { ...item, title: '' } }); check('announce with invalid item -> 400', r.status === 400, { status: r.status, body: await r.text() });
  r = await announce(TOKEN_A, msg()); check('announce with token -> 204, media ready', r.status === 204 && r.headers.get('x-frame-media-ready') === '1', { status: r.status, mediaReady: r.headers.get('x-frame-media-ready') });
  r = await announce(TOKEN_B, { v: 1, type: 'announce', item: { ...item, id: randomBytes(16).toString('hex') } });
  const bOnPath = { status: r.status, body: await r.text() };
  r = await announce(TOKEN_A, { v: 1, type: 'announce', item: { ...item, id: randomBytes(16).toString('hex'), path: PATH_B } });
  check('path ownership: a token may only announce its own path(s)', bOnPath.status === 403 && r.status === 403, { tokenBOnA: bOnPath, tokenAOnB: { status: r.status, body: await r.text() } });
  r = await announce(TOKEN_B, { v: 1, type: 'bye', id: BROADCAST_ID }); check('bye with other token -> 403', r.status === 403, { status: r.status });
  r = await announce(TOKEN_A, { v: 1, type: 'announce', item: { ...item, audio: 'stereo', sentAtMs: senderNow() } });
  check('invalid optional field dropped, not refused', r.status === 204 && r.headers.get('x-frame-ignored') === 'audio', { status: r.status, ignored: r.headers.get('x-frame-ignored') });
  announcer = setInterval(() => announce(TOKEN_A, msg()).catch(() => {}), 2000);
  await announce(TOKEN_A, msg());

  // ---- thumbnail ----
  const thumb = join(TMP, 'thumb.jpg');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=1', '-frames:v', '1', '-q:v', '5', '-y', thumb]);
  const jpeg = readFileSync(thumb);
  const put = (token, body, type = 'image/jpeg', base = RELAY) => fetch(`${base}/api/broadcasts/${BROADCAST_ID}/thumbnail`, { method: 'PUT', headers: { 'Content-Type': type, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body });
  r = await put('', jpeg); check('thumbnail without token -> 401', r.status === 401, { status: r.status });
  r = await put(TOKEN_A, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(300 * 1024)])); check('thumbnail > 256 KB -> 413', r.status === 413, { status: r.status });
  r = await put(TOKEN_A, jpeg, 'image/png'); check('thumbnail wrong type -> 415', r.status === 415, { status: r.status });
  r = await put(TOKEN_B, jpeg); check('thumbnail with other token -> 403', r.status === 403, { status: r.status });
  r = await put(TOKEN_A, jpeg); check('thumbnail upload -> 204', r.status === 204, { status: r.status, bytes: jpeg.length });
  r = await fetch(`${RELAY}/thumbnails/${BROADCAST_ID}.jpg`);
  const got = Buffer.from(await r.arrayBuffer());
  check('thumbnail served', r.status === 200 && got.equals(jpeg), { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), bytes: got.length });

  // ---- viewer API ----
  const listJson = await (await fetch(RELAY + '/api/broadcasts')).json();
  const listed = listJson.items.find(i => i.id === BROADCAST_ID);
  check('list contains broadcast with relay baseUrl', listed && listed.baseUrl === RELAY && listed.thumbnailUrl === `${RELAY}/thumbnails/${BROADCAST_ID}.jpg`, { item: listed });
  const infoRes = await getJson(`${RELAY}/${PATH}/info`), info = infoRes.body || {};
  const masked = i => ({ ...i, iceServers: (i.iceServers || []).map(s => ({ urls: s.urls, username: s.username, credential: s.credential ? '(hmac)' : undefined })) });
  check('info running, mediaReady, TURN credentials', info.running && info.mediaReady === true && info.broadcastId === BROADCAST_ID && !infoRes.headers.get('retry-after') && (info.iceServers || []).some(s => s.username && s.credential), { info: masked(info) });
  // The relay serves its own 480p encoder (scale=-2:480 -> 854 wide, 1.8 Mbps per the yml), not the sender's local 852x480 one.
  const r480 = (info.renditions || []).find(x => x.name === '480p');
  check('info renditions carry name,width,height,mbps,fps,codec (relay encoder: 854x480)', r480 && r480.width === 854 && r480.height === 480 && r480.mbps === 1.8 && r480.fps === 30 && r480.codec === 'H.264', { renditions: info.renditions });
  check('info advertises hlsVariants (Opus, AAC)', info.hlsVariants?.opus === 'hls/index.m3u8' && info.hlsVariants?.aac === 'aac/hls/index.m3u8', { hlsVariants: info.hlsVariants });
  const expectStart = Date.now() - info.elapsedMs;
  check('sentAtMs corrects a sender clock 60 s ahead', info.elapsedMs >= 2000 && info.elapsedMs < 30000 && Math.abs(info.startedAtMs - expectStart) < 2000 && Math.abs(info.startedAtMs - (startedAtSender - SKEW)) < 3000,
    { elapsedMs: info.elapsedMs, startedAtMs: info.startedAtMs, senderStartedAtMs: startedAtSender, skewMs: SKEW });
  const offline = await (await fetch(`${RELAY}/nothing/info`)).json();
  check('info for unknown path -> running:false', offline.running === false, offline);
  for (const [url, method] of [[`/v3/paths/list`, 'GET'], [`/v3/config/global/get`, 'GET'], [`/${PATH}/whip`, 'POST'], [`/list?path=${PATH}`, 'GET'], [`/${PATH}/dvr/../../v3/paths/list`, 'GET']]) {
    r = await fetch(RELAY + url, { method, body: method === 'POST' ? 'v=0' : undefined });
    const body = await r.text();
    check(`not exposed: ${method} ${url}`, r.status === 404 || r.status === 405 || (r.status === 200 && body.startsWith('<!doctype html')), { status: r.status });
  }

  // ---- playback reports (POST /<path>/stats) ----
  result.stats = await statsChecks();

  // ---- DVR index and one chunk ----
  await sleep(6000);
  const index = await (await fetch(`${RELAY}/${PATH}/dvr`)).json();
  check('DVR index has the current broadcast', index.dvr && index.id === BROADCAST_ID && index.ranges?.length > 0 && index.segments?.length > 0,
    { ranges: index.ranges, segments: index.segments?.length, behindMs: index.nowMs - index.ranges?.at(-1)?.endMs });
  const chunkStart = (index.segments?.[0] || Date.now() - 5000) + 2;
  r = await fetch(`${RELAY}/${PATH}/dvr/media?id=${BROADCAST_ID}&start=${chunkStart.toFixed(3)}&duration=3000`);
  const chunk = Buffer.from(await r.arrayBuffer());
  writeFileSync(join(TMP, 'dvr-chunk.mp4'), chunk);
  const probe = r.status === 200 ? safeProbe(join(TMP, 'dvr-chunk.mp4')) : { skipped: 'status ' + r.status };
  check('DVR chunk is playable fMP4 (H.264 + Opus)', r.status === 200 && r.headers.get('transfer-encoding') === 'chunked' && probe.streams?.some(s => s.codec_name === 'h264') && probe.streams?.some(s => s.codec_name === 'opus'),
    { status: r.status, te: r.headers.get('transfer-encoding'), bytes: chunk.length, probe });
  r = await fetch(`${RELAY}/${PATH}/dvr/media?id=${'0'.repeat(32)}&start=${chunkStart}&duration=3000`); check('DVR chunk for another broadcast id -> 409', r.status === 409, { status: r.status, body: await r.json().catch(() => null) });
  r = await fetch(`${RELAY}/${PATH}/dvr/media?id=${BROADCAST_ID}&start=${chunkStart - 600000}&duration=3000`); check('DVR chunk before this broadcast -> 404', r.status === 404, { status: r.status, body: await r.json().catch(() => null) });
  r = await fetch(`${RELAY}/${PATH}/dvr/media?id=${BROADCAST_ID}&start=${chunkStart}&duration=60000`); check('DVR chunk too long -> 400', r.status === 400, { status: r.status });
  r = await fetch(`${RELAY}/${PATH}/dvr/media?id=${BROADCAST_ID}&start=${Date.now() + 5000}&duration=3000`); check('DVR chunk past live edge -> 404 no-data', r.status === 404, { status: r.status, body: await r.json().catch(() => null) });

  // ---- HLS (with MediaMTX's cookie check), both advertised variants ----
  const hls = await hlsCheck(`${RELAY}/${PATH}/${info.hlsVariants?.opus || 'hls/index.m3u8'}`, 'hls-opus');
  check('HLS (LL, fMP4) served via relay', hls.ok && /avc1/.test(hls.master) && /opus/.test(hls.master), hls.summary);
  const hlsAac = await hlsCheck(`${RELAY}/${PATH}/${info.hlsVariants?.aac || 'aac/hls/index.m3u8'}`, 'hls-aac');
  check('HLS AAC variant (relay-side audio transcode)', hlsAac.ok && /mp4a/.test(hlsAac.master), hlsAac.summary);

  // ---- chat protocol rules over raw WebSockets ----
  result.chatRules = await chatRules(`ws://127.0.0.1:${PORT.relay}/${PATH}/chat`);

  // ---- browsers ----
  front = start('tls-front', process.execPath, [join(ROOT, 'server/tls-front.mjs'), '--listen', `127.0.0.1:${PORT.tls}`, '--upstream', `127.0.0.1:${PORT.relay}`, '--cert', join(TMP, 'cert.pem'), '--key', join(TMP, 'key.pem')], { logDir: TMP });
  await waitFor(async () => (await fetch(HTTPS + '/healthz')).ok, 10000);
  edge = start('edge', EDGE, ['--headless=new', `--remote-debugging-port=${PORT.edge}`, `--user-data-dir=${join(TMP, 'edge')}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors', '--disable-features=msEdgeSidebarV2,EdgeCollections', '--window-size=1440,900', 'about:blank'], { logDir: TMP });
  check('headless Edge DevTools up', await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT.edge}/json/version`)).ok, 30000));
  await browserChecks();

  // The UI pages report playback every 15 s: their rows are in the same CSV (no address in it).
  const csv = readStats();
  const uiRows = csv.rows.filter(row => !row.session.startsWith('e2e'));
  check('UI pages\' playback reports reach the daily CSV', uiRows.length > 0 && uiRows.some(row => row.transport === 'webrtc'), { uiRows: uiRows.length, sample: uiRows.slice(0, 2) });

  // ---- after the browsers: relay state and resource use ----
  const t75 = await waitFor(async () => { const i = await (await fetch(`${RELAY}/${PATH}/dvr`)).json(); return i.segments?.length >= 2 && i.ranges.at(-1).endMs - i.segments[1] > 3000 ? i : null; }, 90000, 1000);
  const span = t75 ? { ranges: t75.ranges.length, recordedS: +((t75.ranges.at(-1).endMs - t75.ranges[0].startMs) / 1000).toFixed(1), segments: t75.segments.length, behindLiveMs: Math.round(t75.nowMs - t75.ranges.at(-1).endMs) } : null;
  let cross = null;
  if (t75) {
    const res = await fetch(`${RELAY}/${PATH}/dvr/media?id=${BROADCAST_ID}&start=${(t75.segments[1] - 2000 + 2).toFixed(3)}&duration=4000`);
    const b = Buffer.from(await res.arrayBuffer()); writeFileSync(join(TMP, 'dvr-cross.mp4'), b);
    cross = { status: res.status, bytes: b.length, probe: res.status === 200 ? safeProbe(join(TMP, 'dvr-cross.mp4')).format || { error: 'not mp4' } : { skipped: true } };
  }
  check('DVR spans the 60 s segment boundary as one range', span && span.ranges === 1 && span.recordedS > 62 && cross?.status === 200 && Number(cross.probe?.duration) > 3.5, { span, crossBoundaryChunk: cross });
  result.healthz = await (await fetch(RELAY + '/healthz')).json();
  // MediaMTX warnings worth knowing: RTP repacketising (publisher packets above udpMaxPayloadSize) and LL-HLS part-duration
  // changes on the AAC variant (MediaMTX says iOS clients may reject them; no iPhone was available to check).
  result.mediamtxWarnings = { rtpRepacketised: mediamtx.lines.filter(l => /RTP packets are too big/.test(l)), llhlsPartDurationChanged: mediamtx.lines.filter(l => /part duration changed/.test(l)).length,
    errors: mediamtx.lines.filter(l => / ERR /.test(l) && !/path not found|no recording segments/.test(l)).map(mask) };
  check('no RTP repacketising with -pkt_size 1190', result.mediamtxWarnings.rtpRepacketised.filter(l => l.includes(`[path ${PATH}]`)).length === 0, { lines: result.mediamtxWarnings.rtpRepacketised });
  result.senderMediamtxErrors = sender.lines.filter(l => / ERR /.test(l)).map(mask);
  result.mediamtxPath = await relayPath(PATH);

  // ---- relay MediaMTX restart (upgrade, crash): media gap of several seconds ----
  // Viewers must not be told the broadcast ended: /info stays running (mediaReady false) and WHEP answers 503 + Retry-After.
  // The app's forwarder restarts with backoff; sender B can neither publish nor announce A's path in the meantime.
  mediamtxFirst = mediamtx;
  const attemptsBefore = forwarder.attempts;
  const gap = { samples: 0, runningFalse: 0, mediaNotReady: 0, retryAfter: new Set(), whep: null };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const res = await getJson(`${RELAY}/${PATH}/info`);
        gap.samples++; if (!res.body?.running) gap.runningFalse++;
        if (res.body?.running && res.body.mediaReady === false) { gap.mediaNotReady++; gap.retryAfter.add(res.headers.get('retry-after'));
          if (!gap.whep) { const w = await fetch(`${RELAY}/${PATH}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' }); gap.whep = { status: w.status, retryAfter: w.headers.get('retry-after') }; } }
      } catch {}
      await sleep(250);
    }
  })();
  await stop(mediamtx);
  const r0 = Date.now();
  mediamtx = start('mediamtx-restarted', MEDIAMTX, ['mediamtx.yml'], { cwd: mtxDir, env: mtxEnv, logDir: TMP });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT.api}/v3/paths/list`)).ok, 15000, 100);
  const hijack = { aReadyAtAttempt: !!(await relayPath(PATH)).ready };
  const hijackPublish = await tryPublish('publish-b-hijack', rtsps(USER_B, PASS_B, PATH));
  r = await announce(TOKEN_B, { v: 1, type: 'announce', item: { ...item, id: randomBytes(16).toString('hex'), sentAtMs: Date.now() } });
  Object.assign(hijack, { publishRefused: hijackPublish.refused, reason: hijackPublish.reason, announceStatus: r.status });
  const back = await waitFor(async () => (await relayPath(PATH)).ready, 60000, 250);
  const backMs = back ? Date.now() - r0 : null;
  await sleep(1500); sampling = false; await sampler;
  const listedAgain = back && await waitFor(async () => (await (await fetch(RELAY + '/api/broadcasts')).json()).items.some(i => i.id === BROADCAST_ID), 10000);
  const dvrAfter = await waitFor(async () => { const i = await (await fetch(`${RELAY}/${PATH}/dvr`)).json(); return i.ranges?.length && i.ranges.at(-1).endMs > r0 + 3000 ? i : null; }, 25000, 500) || {};
  check('relay MediaMTX restart: forwarder restarts with backoff, listed again, DVR keeps earlier part', back && listedAgain && forwarder.attempts > attemptsBefore && dvrAfter.ranges?.[0]?.startMs < r0 - 30000 && dvrAfter.ranges.at(-1).endMs > r0 + 3000,
    { backAfterMs: backMs, forwarderStarts: forwarder.attempts - attemptsBefore, restartDelaysMs: forwarder.delays.slice(-6), ranges: dvrAfter.ranges?.map(x => ({ startMs: x.startMs, s: +((x.endMs - x.startMs) / 1000).toFixed(1) })) });
  const gapOut = { ...gap, retryAfter: [...gap.retryAfter] };
  check('media gap: /info stays running (mediaReady:false + Retry-After), WHEP 503 + Retry-After', gap.samples > 5 && gap.runningFalse === 0 && gap.mediaNotReady > 0 && gapOut.retryAfter.includes('2') && gap.whep?.status === 503 && gap.whep.retryAfter, gapOut);
  check('while A reconnects, sender B can neither publish nor announce A\'s path', hijack.publishRefused && /40[13]/.test(hijack.reason) && hijack.announceStatus === 403, hijack);
  r = await announce(TOKEN_A, { v: 1, type: 'bye', id: BROADCAST_ID }); clearInterval(announcer);
  const afterBye = await (await fetch(RELAY + '/api/broadcasts')).json();
  const infoAfterBye = await (await fetch(`${RELAY}/${PATH}/info`)).json();
  check('bye removes the broadcast at once (no grace after bye)', r.status === 204 && !afterBye.items.some(i => i.id === BROADCAST_ID) && infoAfterBye.running === false, { status: r.status, items: afterBye.items.length, info: infoAfterBye });
}

// The sender app's forwarder: its own FFmpeg per broadcast, exactly this command, restarted with backoff when it exits.
function startForwarder(dest) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-rtsp_transport', 'tcp', '-i', `rtsp://127.0.0.1:${PORT.senderRtsp}/${PATH}`, '-map', '0', '-c', 'copy',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', '-pkt_size', '1190', '-ca_file', join(TMP, 'cert.pem'), dest];
  const steps = [1000, 2000, 3000, 5000, 8000];
  const f = { attempts: 0, delays: [], lines: [], allLines: [], stopped: false, proc: null };
  (async () => {
    let failures = 0;
    while (!f.stopped) {
      const t = Date.now();
      f.attempts++;
      f.proc = start('forwarder', FFMPEG, args, { logDir: TMP });
      await f.proc.exited;
      f.allLines.push(...f.proc.lines); f.lines = f.proc.lines;
      if (f.stopped) break;
      failures = Date.now() - t > 15000 ? 0 : failures + 1;   // a long run resets the backoff
      const delay = steps[Math.min(failures, steps.length) - 1] || steps[0];
      f.delays.push(delay);
      await sleep(delay);
    }
  })();
  f.stop = async () => { f.stopped = true; await stop(f.proc); };
  return f;
}

async function statsChecks() {
  const out = {}, url = `${RELAY}/${PATH}/stats`;
  const beacon = (body, type = 'text/plain;charset=UTF-8', path = PATH) => fetch(`${RELAY}/${path}/stats`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const report = sid => ({ sid, broadcast: BROADCAST_ID, transport: 'webrtc', mode: 'auto', quality: '720p', height: 720, fps: 29.9, lossPct: 0.12, jitterMs: 14, freezes: 0, mbps: 2.9, abrSwitches: 1, lastSwitch: '720p>480p loss, "x"', event: '=HYPERLINK("x")', device: 'desktop' });
  const s1 = await beacon(report('e2e1'));
  const s1again = await beacon(report('e2e1'));
  const s2 = await beacon(report('e2e2'), 'application/json');
  const big = await beacon({ ...report('e2e3'), event: 'x'.repeat(2100) });
  const wrongType = await beacon(report('e2e4'), 'application/xml');
  const unknown = await beacon(report('e2e5'), 'text/plain', 'nobody');
  const noSid = await beacon({ transport: 'webrtc' });
  out.statuses = { first: s1.status, sameSessionWithin4s: s1again.status, retryAfter: s1again.headers.get('retry-after'), json: s2.status, over2KB: big.status, wrongType: wrongType.status, unknownPath: unknown.status, noSid: noSid.status };
  check('stats beacon: 204, 1 per 4 s per page (429), JSON or text/plain, <= 2 KB, 415/404/400', s1.status === 204 && s1again.status === 429 && s1again.headers.get('retry-after') && s2.status === 204 && big.status === 413 && wrongType.status === 415 && unknown.status === 404 && noSid.status === 400, out.statuses);
  const csv = readStats();
  out.csv = { file: csv.name, header: csv.header, rows: csv.rows.length, containsLoopbackAddress: csv.raw.includes('127.0.0.1'), sample: csv.rows.find(r => r.session === 'e2e1') };
  const expected = 'time,path,session,broadcast,transport,mode,quality,height,fps,loss_pct,jitter_ms,freezes,mbps,abr_switches,last_switch,event,device';
  const row = out.csv.sample;
  check('stats CSV: daily file, exact columns, no IP address, formula text neutralised', csv.header === expected && csv.rows.filter(r => r.session.startsWith('e2e')).length === 2 && !out.csv.containsLoopbackAddress && row?.path === PATH && row.loss_pct === '0.12' && row.event.startsWith("'="),
    out.csv);
  return out;
}
function readStats() {
  const name = `stats-${new Date().toISOString().slice(0, 10)}.csv`, file = join(STATS_DIR, name);
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = parseCsv(raw);
  const header = lines[0]?.join(',') || '', cols = lines[0] || [];
  return { name, raw, header, rows: lines.slice(1).map(l => Object.fromEntries(cols.map((c, i) => [c, l[i] ?? '']))) };
}
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else field += ch;
  }
  return rows;
}

async function hlsCheck(url, name, jar = new Map()) {
  const get = async u => {
    const res = await fetch(u, { redirect: 'manual', headers: jar.size ? { Cookie: [...jar].map(([k, v]) => k + '=' + v).join('; ') } : {} });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
    return res;
  };
  const t0 = Date.now();
  let res = await get(url), hops = 0;
  while (res.status === 302 && hops++ < 3) res = await get(new URL(res.headers.get('location'), url).href);
  if (res.status !== 200) return { ok: false, status: res.status, retryAfter: res.headers.get('retry-after'), summary: { status: res.status, body: (await res.text()).slice(0, 200), hops } };
  const master = await res.text(), firstMs = Date.now() - t0;
  const videoUri = master.split('\n').find(l => l && !l.startsWith('#'));
  const media = await (await get(new URL(videoUri, url).href)).text();
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(media)?.[1];
  const seg = media.split('\n').filter(l => l && !l.startsWith('#')).at(-1);
  const parts = [];
  for (const u of [init, seg]) if (u) { const b = await get(new URL(u, url).href); parts.push(Buffer.from(await b.arrayBuffer())); }
  const file = join(TMP, name + '.mp4');
  writeFileSync(file, Buffer.concat(parts));
  const probe = safeProbe(file);
  if (!name.startsWith('cap-')) writeFileSync(join(OUT, name + '-master.m3u8'), master);
  return { ok: !!(init && seg && probe.streams?.length), status: 200, master, jar, summary: { firstPlaylistMs: firstMs, cookies: [...jar.keys()], master: master.split('\n').filter(l => l.startsWith('#EXT-X-STREAM-INF')), partTarget: /PART-INF:PART-TARGET=([\d.]+)/.exec(media)?.[1], segment: seg, probe } };
}

async function chatRules(url) {
  const out = {};
  const info = await (await fetch(`${RELAY}/${PATH}/info`)).json();
  const client = (name, broadcastId = info.broadcastId) => {
    const ws = new WebSocket(url), events = [];
    const c = { ws, events, send: o => ws.send(JSON.stringify(o)), wait: async (test, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const i = events.findIndex(test); if (i >= 0) return events.splice(i, 1)[0]; await sleep(30); } return null; } };
    ws.addEventListener('message', e => events.push(JSON.parse(e.data)));
    ws.addEventListener('close', () => events.push({ type: '_closed' }));
    c.ready = new Promise((resolve, reject) => { ws.addEventListener('open', () => { c.send({ type: 'join', broadcastId, name }); resolve(); }); ws.addEventListener('error', reject); });
    return c;
  };
  const stale = client('예전 방송', '0'.repeat(32)); await stale.ready;
  const staleState = await stale.wait(e => e.type === 'state');
  out.staleRoom = { connected: staleState?.connected, error: staleState?.error, closed: !!(await stale.wait(e => e.type === '_closed')) };
  check('chat: stale broadcast id refused and closed', staleState && !staleState.connected && out.staleRoom.closed, out.staleRoom);
  const A = client('  검증   사용자  '); await A.ready;
  const sA = await A.wait(e => e.type === 'state'); await A.wait(e => e.type === 'history');
  const B = client('검증 사용자'); await B.ready;
  const sB = await B.wait(e => e.type === 'state'); await B.wait(e => e.type === 'history');
  out.join = { a: sA?.displayName, b: sB?.displayName, bError: sB?.error };
  check('chat: name normalised, same address may share it', sA?.displayName === '검증 사용자' && sB?.displayName === '검증 사용자', out.join);
  out.names = {};
  for (const [label, name] of [['empty', '   '], ['21 chars', '가'.repeat(21)], ['20 chars', '가'.repeat(20)], ['reserved', 'Admin'], ['control', 'a\u0007b'], ['zero width', 'a\u200bb'], ['html', '<b>굵게</b>']]) {
    A.send({ type: 'name', name }); const res = await A.wait(e => e.type === 'name'); out.names[label] = { ok: res?.ok, displayName: res?.displayName, error: res?.error };
  }
  check('chat: name rules match native', !out.names.empty.ok && !out.names['21 chars'].ok && out.names['20 chars'].ok && !out.names.reserved.ok && !out.names.control.ok && !out.names['zero width'].ok && out.names.html.ok, out.names);
  A.send({ type: 'name', name: '검증 A' }); await A.wait(e => e.type === 'name');
  const sendA = async text => { const id = 'c' + Math.random().toString(36).slice(2); A.send({ type: 'send', clientId: id, text }); return A.wait(e => e.type === 'ack' && e.clientId === id); };
  const t0 = performance.now();
  const ack = await sendA('<img src=x onerror=alert(1)> 한글 메시지');
  const recv = await B.wait(e => e.type === 'message');
  out.message = { ackOk: ack?.ok, received: recv?.text, author: recv?.author, roundTripMs: Math.round(performance.now() - t0) };
  check('chat: message delivered as text with ack', ack?.ok && recv?.text === '<img src=x onerror=alert(1)> 한글 메시지' && recv?.author === '검증 A', out.message);
  out.limits = { '1000 chars': (await sendA('x'.repeat(1000)))?.ok, '1001 chars': (await sendA('x'.repeat(1001)))?.ok, empty: (await sendA('  \n ')) ?.ok, control: (await sendA('a\u0001b'))?.ok };
  check('chat: text limits match native', out.limits['1000 chars'] && !out.limits['1001 chars'] && !out.limits.empty && !out.limits.control, out.limits);
  await sleep(10500);  // let the per-connection window (8 / 10 s) empty
  let accepted = 0, refused = 0;
  for (let i = 0; i < 12; i++) { const a = await sendA('빠른 메시지 ' + i); if (a?.ok) accepted++; else refused++; }
  out.rate = { accepted, refused };
  check('chat: 8 messages / 10 s per connection', accepted === 8 && refused === 4, out.rate);
  A.ws.close(); B.ws.close(); await sleep(300);
  const C = client('늦은 참가'); await C.ready; await C.wait(e => e.type === 'state');
  out.lateHistory = (await C.wait(e => e.type === 'history'))?.messages.length;
  check('chat: late joiner gets history', out.lateHistory >= 10, { messages: out.lateHistory });
  C.ws.close();
  // RFC 6455 edge cases: an unmasked frame and an oversized frame close the connection.
  const raw = await rawWs(url);
  out.rfc6455 = raw;
  check('websocket: unmasked/oversized rejected, fragments+ping handled', raw.unmaskedClosed && raw.oversizeClosed && raw.badKeyStatus === 400 && raw.badVersionStatus === 426 && raw.fragmentedJoin && raw.pong, raw);
  return out;
}

// Hand-made handshakes and frames, to see the server enforce the protocol rather than trusting the browser.
async function rawWs(url) {
  const u = new URL(url);
  const handshake = (key = randomBytes(16).toString('base64'), version = '13') => new Promise(resolve => {
    const s = net.connect(Number(u.port), u.hostname, () => s.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: ${version}\r\n\r\n`));
    let data = Buffer.alloc(0);
    s.on('data', d => { data = Buffer.concat([data, d]); if (data.includes('\r\n\r\n')) resolve({ s, status: Number(/^HTTP\/1\.1 (\d+)/.exec(data.toString())?.[1]) }); });
    s.on('error', () => resolve({ s, status: 0 }));
  });
  const closedAfter = (s, frameBuf) => new Promise(resolve => { let done = false; s.on('close', () => { done = true; resolve(true); }); s.write(frameBuf); setTimeout(() => resolve(done), 5000); });
  const a = await handshake();
  const unmaskedClosed = a.status === 101 && await closedAfter(a.s, Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]));
  const b = await handshake();
  const big = Buffer.alloc(14); big[0] = 0x81; big[1] = 0x80 | 127; big.writeBigUInt64BE(1n << 20n, 2);
  const oversizeClosed = b.status === 101 && await closedAfter(b.s, big);
  // A join split over two fragments with a ping in between: the server answers the ping and then the reassembled join.
  const masked = (fin, opcode, text) => { const p = Buffer.from(text), m = randomBytes(4), h = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | p.length]); return Buffer.concat([h, m, Buffer.from(p.map((x, i) => x ^ m[i & 3]))]); };
  const e = await handshake();
  const replies = [];
  e.s.on('data', d => replies.push(d));
  const info = await (await fetch(u.href.replace(/^ws/, 'http').replace(/chat$/, 'info'))).json();
  const join = JSON.stringify({ type: 'join', broadcastId: info.broadcastId, name: '조각 테스트' });
  e.s.write(Buffer.concat([masked(false, 0x1, join.slice(0, 20)), masked(true, 0x9, 'ping'), masked(true, 0x0, join.slice(20))]));
  await waitFor(() => Buffer.concat(replies).includes(Buffer.from('"connected":true')), 3000, 100);
  const all = Buffer.concat(replies);
  const fragmentedJoin = all.includes(Buffer.from('"type":"state"')) && all.includes(Buffer.from('"connected":true'));
  const pong = all.includes(Buffer.from([0x8a, 4])) && all.includes(Buffer.from('ping'));
  e.s.destroy();
  const c = await handshake('short'); c.s.destroy();
  const d = await handshake(undefined, '8'); d.s.destroy();
  return { unmaskedClosed, oversizeClosed, badKeyStatus: c.status, badVersionStatus: d.status, fragmentedJoin, pong };
}

// A TCP pass-through in front of the relay MediaMTX API that can be made to stall (connections held, nothing answered),
// to see the relay keep its last good path list when the API is slow.
function stallProxy(listenPort, targetPort) {
  const pairs = new Set(), held = new Set();
  const p = { stalled: false };
  p.server = net.createServer(socket => {
    socket.on('error', () => {});
    if (p.stalled) { held.add(socket); socket.on('close', () => held.delete(socket)); return; }
    const up = net.connect(targetPort, '127.0.0.1');
    up.on('error', () => socket.destroy()); socket.on('close', () => { up.destroy(); pairs.delete(pair); });
    const pair = { socket, up }; pairs.add(pair);
    socket.pipe(up).pipe(socket);
  }).listen(listenPort, '127.0.0.1');
  p.stall = () => { p.stalled = true; for (const { socket, up } of pairs) { socket.unpipe(up); up.unpipe(socket); socket.pause(); } };  // existing keep-alive sockets go quiet too
  p.resume = () => { p.stalled = false; for (const { socket, up } of pairs) { socket.destroy(); up.destroy(); } pairs.clear(); for (const s of held) s.destroy(); held.clear(); };
  p.close = () => new Promise(resolve => { p.resume(); p.server.close(() => resolve()); });
  return p;
}

// Second relay on the same MediaMTX with tiny limits: caps answer instead of dropping, HLS viewers count against the viewer
// cap, the media grace period ends, a stalled MediaMTX API keeps the last good list, and the per-address limiter runs before
// the token comparison.
async function limitChecks() {
  const port = PORT.relayLimits, base = `http://127.0.0.1:${port}`, out = {};
  // WebRTC viewers already on the path (page 1): the cap is set one above, so exactly one HLS viewer still fits.
  const webrtcNow = async () => { const p = await (await fetch(`http://127.0.0.1:${PORT.api}/v3/paths/list`)).json(); return p.items.filter(i => i.name === PATH || i.name.startsWith(PATH + '/')).reduce((n, i) => n + i.readers.filter(x => /webrtc/i.test(x.type)).length, 0); };
  let w = 0;
  for (let i = 0; i < 20; i++) { const a = await webrtcNow(); await sleep(500); const b = await webrtcNow(); if (a === b && a >= 1) { w = a; break; } }
  out.webrtcViewers = w;
  apiProxy = stallProxy(PORT.apiProxy, PORT.api);
  const small = start('relay-limits', process.execPath, [join(ROOT, 'server/relay.mjs')], { logDir: TMP, env: {
    RELAY_PORT: String(port), RELAY_PUBLISHER_TOKENS: `${TOKEN_A} ${PATH} ${NOMEDIA}`, RELAY_MEDIAMTX_API: `http://127.0.0.1:${PORT.apiProxy}`, RELAY_MEDIAMTX_WEBRTC: `http://127.0.0.1:${PORT.webrtc}`,
    RELAY_MEDIAMTX_HLS: `http://127.0.0.1:${PORT.hls}`, RELAY_MEDIAMTX_PLAYBACK: `http://127.0.0.1:${PORT.playback}`, RELAY_RECORD_DIR: join(TMP, 'mediamtx', 'recordings'),
    RELAY_MAX_VIEWERS_PER_PATH: String(Math.max(1, w) + 1), RELAY_MAX_CHAT: '2', RELAY_MAX_SOCKETS: '20', RELAY_MEDIA_GRACE_MS: '3000' } });
  await waitFor(async () => (await fetch(base + '/healthz')).ok, 10000);
  const ann = (path = PATH, id = BROADCAST_ID, token = TOKEN_A) => fetch(base + '/api/broadcasts/announce', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'announce', item: { id, title: '제한 검증', publisher: 'RELAY-TEST', path, width: 1280, height: 720, fps: 30, startedAtMs: Date.now(), sentAtMs: Date.now() } }) });
  await ann();
  const keep = setInterval(() => ann().catch(() => {}), 2000);

  // HLS viewers against the cap: viewer 1 fits (w WebRTC + 0 HLS < w+1), then WHEP and a second HLS viewer are refused,
  // while viewer 1 (its MediaMTX session cookie) keeps playing.
  const h1 = await hlsCheck(`${base}/${PATH}/hls/index.m3u8`, 'cap-hls-1');
  const whep = await fetch(`${base}/${PATH}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' });
  const h2 = await hlsCheck(`${base}/${PATH}/hls/index.m3u8`, 'cap-hls-2');
  const h1again = await hlsCheck(`${base}/${PATH}/hls/index.m3u8`, 'cap-hls-1b', h1.jar || new Map());
  const health = await (await fetch(base + '/healthz')).json();
  out.hlsCap = { cap: Math.max(1, w) + 1, hls1: h1.status, whep: whep.status, whepRetryAfter: whep.headers.get('retry-after'), hls2: h2.status, hls2RetryAfter: h2.retryAfter, hls1Again: h1again.status, hlsViewers: health.hlsViewers, cookies: h1.summary?.cookies };
  check('HLS viewers count against the viewer cap (503 + Retry-After), an active HLS viewer is kept', h1.ok && whep.status === 503 && whep.headers.get('retry-after') && h2.status === 503 && h2.retryAfter && h1again.ok && health.hlsViewers === 1, out.hlsCap);

  // Chat cap and socket cap.
  const sockets = [];
  for (let i = 0; i < 3; i++) { const ws = new WebSocket(`ws://127.0.0.1:${port}/${PATH}/chat`); const o = await new Promise(res => { ws.onopen = () => res('open'); ws.onerror = () => res('error'); }); sockets.push([ws, o]); }
  const request = ['GET /' + PATH + '/chat HTTP/1.1', 'Host: x', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: ' + randomBytes(16).toString('base64'), 'Sec-WebSocket-Version: 13', '', ''].join('\r\n');
  const raw = await new Promise(resolve => { const s = net.connect(port, '127.0.0.1', () => s.write(request)); let d = ''; const head = () => d.split('\r\n\r\n')[0]; s.on('data', x => { d += x; }); s.on('close', () => resolve(head())); setTimeout(() => { s.destroy(); resolve(head()); }, 4000); });
  out.chatCap = { opened: sockets.map(x => x[1]), thirdUpgradeResponse: raw };
  check('chat cap reached -> 503 + Retry-After', sockets.filter(x => x[1] === 'open').length === 2 && /^HTTP\/1\.1 503/.test(raw) && /Retry-After: 10/i.test(raw), out.chatCap);
  for (const [ws] of sockets) ws.close();
  await sleep(500);
  const idle = await Promise.all(Array.from({ length: 22 }, () => new Promise(res => { const s = net.connect(port, '127.0.0.1', () => res(s)); s.on('error', () => res(null)); })));
  let r = await fetch(base + '/api/broadcasts').catch(e => ({ status: 'error ' + e.message, headers: new Headers() }));
  out.socketCap = { idleSockets: idle.filter(Boolean).length, status: r.status, retryAfter: r.headers.get('retry-after') };
  check('socket cap reached -> 503 + Retry-After (not a dropped socket)', r.status === 503 && r.headers.get('retry-after') === '5', out.socketCap);
  for (const s of idle) s?.destroy();
  await sleep(800);

  // Start-up/media grace on a path that never receives media (grace 3 s on this relay): first running + mediaReady:false
  // with Retry-After, WHEP/HLS 503 + Retry-After, an empty DVR index; after the grace running:false and WHEP 404.
  const nomediaId = randomBytes(16).toString('hex');
  r = await ann(NOMEDIA, nomediaId);
  const i1 = await getJson(`${base}/${NOMEDIA}/info`);
  const w1 = await fetch(`${base}/${NOMEDIA}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' });
  const hl1 = await fetch(`${base}/${NOMEDIA}/hls/index.m3u8`);
  const d1 = await getJson(`${base}/${NOMEDIA}/dvr`);
  await sleep(3800);
  await ann(NOMEDIA, nomediaId);  // still announced: only the media is missing
  const i2 = await getJson(`${base}/${NOMEDIA}/info`);
  const w2 = await fetch(`${base}/${NOMEDIA}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' });
  out.grace = { announce: r.status, during: { running: i1.body?.running, mediaReady: i1.body?.mediaReady, retryAfter: i1.headers.get('retry-after'), broadcastId: i1.body?.broadcastId === nomediaId, whep: w1.status, whepRetryAfter: w1.headers.get('retry-after'), hls: hl1.status, dvrRanges: d1.body?.ranges?.length, dvrRecording: d1.body?.recording },
    after: { running: i2.body?.running, whep: w2.status } };
  check('media grace: running+mediaReady:false+Retry-After, WHEP/HLS 503, then running:false after the grace', r.status === 204 && i1.body?.running === true && i1.body.mediaReady === false && i1.headers.get('retry-after') === '2' && w1.status === 503 && w1.headers.get('retry-after') && hl1.status === 503 && d1.body?.ranges?.length === 0 && i2.body?.running === false && w2.status === 404, out.grace);

  // Stalled MediaMTX API (connections held, refresh times out after 3 s): the relay keeps the last good list (stale).
  await waitFor(async () => (await (await fetch(`${base}/${PATH}/info`)).json()).mediaReady === true, 5000);
  apiProxy.stall();
  const t0 = Date.now(), seen = { samples: 0, notReady: 0, notListed: 0, staleSeen: false, slowestMs: 0 };
  while (Date.now() - t0 < 7000) {
    const q0 = Date.now();
    const [info, lst, h] = await Promise.all([getJson(`${base}/${PATH}/info`), getJson(`${base}/api/broadcasts`), getJson(`${base}/healthz`)]);
    seen.slowestMs = Math.max(seen.slowestMs, Date.now() - q0);
    seen.samples++; if (!(info.body?.running && info.body.mediaReady)) seen.notReady++; if (!lst.body?.items?.some(i => i.path === PATH)) seen.notListed++;
    if (h.body?.mediamtxListStale && h.body.mediamtx === false) seen.staleSeen = true;
    await sleep(400);
  }
  apiProxy.resume();
  const recovered = await waitFor(async () => { const h = await (await fetch(base + '/healthz')).json(); return h.mediamtx && !h.mediamtxListStale; }, 10000, 250);
  out.staleList = { ...seen, recovered: !!recovered };
  check('stalled MediaMTX API: last good list kept (marked stale), no viewer sees the broadcast offline', seen.samples >= 5 && seen.notReady === 0 && seen.notListed === 0 && seen.staleSeen && recovered, out.staleList);

  // Floods. Announce: per-token bucket. Wrong tokens: 10 x 401, then 429 - and then a correct token from the same address
  // is refused too (the per-address limiter runs before the token comparison), for announce and thumbnail alike.
  clearInterval(keep);
  await sleep(500);
  const statuses = [];
  for (let i = 0; i < 45; i++) statuses.push((await ann()).status);
  out.announceRate = { sent: 45, accepted: statuses.filter(s => s === 204).length, limited: statuses.filter(s => s === 429).length };
  check('announce flood from one token -> 429', out.announceRate.limited > 0 && out.announceRate.accepted >= 25, out.announceRate);
  await sleep(1500);  // the per-token announce bucket (5/s) refills; the address's wrong-token budget (1 per 6 s) is untouched
  const bad = [];
  for (let i = 0; i < 14; i++) bad.push((await fetch(base + '/api/broadcasts/announce', { method: 'POST', headers: { Authorization: 'Bearer ' + 'y'.repeat(40) }, body: '{}' })).status);
  const goodAfter = await ann();
  const thumbAfter = await fetch(`${base}/api/broadcasts/${BROADCAST_ID}/thumbnail`, { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKEN_A, 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) });
  // Retry-After of several seconds: the wrong-token budget (1 per 6 s) refused it, not the per-token bucket (1 s).
  out.authFailures = { statuses: bad.join(','), correctTokenAfter: goodAfter.status, thumbnailAfter: thumbAfter.status, retryAfterS: Number(goodAfter.headers.get('retry-after')) };
  check('repeated wrong tokens -> 429 after 10', bad.slice(0, 10).every(s => s === 401) && bad.slice(10).every(s => s === 429), out.authFailures);
  check('limiter before token comparison: a correct token is refused (429) while the address is limited', goodAfter.status === 429 && thumbAfter.status === 429 && out.authFailures.retryAfterS >= 3, out.authFailures);
  await stop(small);
  await apiProxy.close(); apiProxy = null;
  return out;
}

async function newPage(url) {
  const t = await (await fetch(`http://127.0.0.1:${PORT.edge}/json/new?${url}`, { method: 'PUT' })).json();
  const c = await connect(PORT.edge, x => x.id === t.id);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return c;
}
const shot = async (c, name) => writeFileSync(join(OUT, name + '.png'), await c.screenshot());
const playerState = c => c.evaluate(`(() => { const v = document.querySelector('#viewer-preview video'); return v ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused, muted: v.muted, src: v.src ? 'blob' : (v.srcObject ? 'webrtc' : ''), status: document.getElementById('viewer-status')?.textContent.trim(), quality: document.getElementById('player-quality-label')?.textContent.trim() } : null; })()`);
async function playing(c, ms = 3000) {
  const a = await playerState(c); await sleep(ms); const b = await playerState(c);
  return { first: a, second: b, advancedS: a && b ? +(b.t - a.t).toFixed(2) : 0, ok: !!(a && b && b.w > 0 && b.t - a.t > ms / 1000 * 0.5) };
}
async function openFromList(c, name) {
  await c.evaluate(`localStorage.setItem('frame.chatName', ${JSON.stringify(name)}); true`);
  const card = await waitFor(() => c.evaluate(`document.querySelectorAll('#broadcast-grid .broadcast-card').length`), 20000);
  const cardText = await c.evaluate(`document.querySelector('#broadcast-grid .broadcast-card')?.innerText || ''`);
  const t0 = Date.now();
  await c.click('#broadcast-grid .broadcast-card');
  const first = await waitFor(async () => (await playerState(c))?.w > 0, 30000, 50);
  return { cards: card, cardText, firstFrameMs: first ? Date.now() - t0 : null };
}

async function browserChecks() {
  // Page 1: list -> click -> live WebRTC through the relay.
  const p1 = await newPage(RELAY + '/');
  await sleep(1500); await p1.evaluate('document.fonts.ready.then(() => true)');
  const o1 = await openFromList(p1, '시청자가');
  await shot(p1, 'relay-http-list-opened');
  const play1 = await playing(p1);
  check('Edge(HTTP): card listed, click plays WebRTC video', o1.cards > 0 && play1.ok && play1.second.src === 'webrtc', { ...o1, ...play1 });
  const stats = await p1.evaluate(`(async () => ({ thumbnailShown: !!document.querySelector('#broadcast-grid img'), fps: document.getElementById('info-fps')?.textContent, bitrate: document.getElementById('info-bitrate')?.textContent, resolution: document.getElementById('info-resolution')?.textContent }))()`);
  result.page1 = { ...o1, ...play1, stats };
  await shot(p1, 'relay-http-playing');

  // Quality switch through the UI's own menu to the relay-side 480p encoder, then back to the source.
  const q0 = Date.now();
  await p1.evaluate(`document.getElementById('player-settings').click(); true`); await sleep(300);
  await p1.evaluate(`[...document.querySelectorAll('#player-quality-menu .quality-menu-option')].find(b => b.textContent.includes('480p'))?.click(); true`);
  const to480 = await waitFor(async () => (await playerState(p1))?.h === 480, 30000, 100);
  const play480 = await playing(p1, 2000);
  check('Edge: switch to relay 480p rendition plays 480 lines', to480 && play480.ok, { switchMs: to480 ? Date.now() - q0 : null, ...play480 });
  await p1.evaluate(`document.getElementById('player-settings').click(); true`); await sleep(300);
  await p1.evaluate(`[...document.querySelectorAll('#player-quality-menu .quality-menu-option')].find(b => b.querySelector('.quality-option-copy span')?.textContent.trim() === '720p')?.click(); true`);
  const back = await waitFor(async () => (await playerState(p1))?.h === 720, 20000, 100);
  check('Edge: back to source quality', !!back, { state: await playerState(p1) });

  result.limits = await limitChecks();

  // Page 2 over HTTPS/WSS through the TLS front.
  const p2 = await newPage(HTTPS + '/');
  await sleep(1500);
  const list2 = await p2.evaluate(`fetch('/api/broadcasts').then(r => r.json())`);
  const o2 = await openFromList(p2, '시청자나');
  const play2 = await playing(p2);
  check('Edge(HTTPS): list baseUrl is https origin, WHEP plays', list2.items[0]?.baseUrl === HTTPS && play2.ok, { baseUrl: list2.items[0]?.baseUrl, ...o2, ...play2 });
  await shot(p2, 'relay-https-playing');
  result.page2 = { ...o2, ...play2 };

  // Chat in the UI: page 1 (ws://) and page 2 (wss://) see each other's messages.
  const chatReady = async c => waitFor(() => c.evaluate(`!document.getElementById('chat-message').disabled && !!document.getElementById('chat-send') && true`), 15000);
  await chatReady(p1); await chatReady(p2);
  const say = (c, text) => c.evaluate(`(() => { const t = document.getElementById('chat-message'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-form').requestSubmit(); return true; })()`);
  const seen = (c, text) => waitFor(() => c.evaluate(`document.getElementById('chat-messages').innerText.includes(${JSON.stringify(text)})`), 10000, 50);
  let t0 = Date.now(); await say(p1, 'HTTP 페이지에서 보낸 메시지');
  const m1 = await seen(p2, 'HTTP 페이지에서 보낸 메시지'), m1ms = Date.now() - t0;
  t0 = Date.now(); await say(p2, 'HTTPS(WSS) 페이지에서 보낸 메시지');
  const m2 = await seen(p1, 'HTTPS(WSS) 페이지에서 보낸 메시지'), m2ms = Date.now() - t0;
  const wsUrls = { p1: (await p1.evaluate('location.origin')).replace(/^http/, 'ws') + '/' + PATH + '/chat', p2: (await p2.evaluate('location.origin')).replace(/^http/, 'ws') + '/' + PATH + '/chat' };
  check('Edge chat round trip ws <-> wss', m1 && m2, { httpToHttpsMs: m1 ? m1ms : null, httpsToHttpMs: m2 ? m2ms : null, wsUrls });
  await shot(p2, 'relay-https-chat');

  // DVR through the UI: seek 8 s before the live edge (MediaSource playback of relay recording chunks), then back to live.
  const dvrIndex = await (await fetch(`${RELAY}/${PATH}/dvr`)).json();
  const target = (dvrIndex.ranges?.at(-1)?.endMs || Date.now()) - 8000;
  await p1.evaluate(`document.dispatchEvent(new CustomEvent('frame:seek', { detail: { positionMs: ${target} } })); true`);
  const inHistory = await waitFor(async () => { const s = await playerState(p1); return s?.src === 'blob' && s.w > 0 ? s : null; }, 20000, 100);
  const playDvr = await playing(p1, 3000);
  check('Edge: DVR seek plays recorded chunks (MSE)', inHistory && playDvr.ok && playDvr.second.src === 'blob', { recordedMs: dvrIndex.ranges?.length ? dvrIndex.ranges.at(-1).endMs - dvrIndex.ranges[0].startMs : null, ...playDvr });
  await shot(p1, 'relay-dvr-history');
  await p1.evaluate(`document.dispatchEvent(new CustomEvent('frame:live')); true`);
  const live = await waitFor(async () => (await playerState(p1))?.src === 'webrtc', 20000, 100);
  check('Edge: return to live after DVR', !!live, { state: await playerState(p1) });
  // Let at least one 15 s playback report go out from both pages before they close.
  await sleep(Math.max(0, 16000 - (Date.now() - q0)));

  // Native HLS in this Edge build (informational: iPhone Safari is the real target and is not available here).
  result.edgeHls = await p2.evaluate(`(async () => { const v = document.createElement('video'); const can = v.canPlayType('application/vnd.apple.mpegurl'); if (!can) return { canPlayType: '' };
    v.muted = true; v.src = '/${PATH}/hls/index.m3u8'; document.body.append(v); try { await v.play(); } catch (e) {} await new Promise(r => setTimeout(r, 6000)); const out = { canPlayType: can, w: v.videoWidth, t: v.currentTime, error: v.error?.code || 0 }; v.remove(); return out; })()`);
  result.notes.push('Edge native HLS: ' + JSON.stringify(result.edgeHls));

  // Leave and close: sessions must disappear from MediaMTX (no leaked readers).
  for (const c of [p1, p2]) await c.send('Page.navigate', { url: 'about:blank' });
  const cleared = await waitFor(async () => { const p = await (await fetch(`http://127.0.0.1:${PORT.api}/v3/paths/list`)).json(); return p.items.every(i => !i.readers.some(r => /webrtc/i.test(r.type))) ? p.items.map(i => ({ name: i.name, readers: i.readers.length })) : null; }, 20000, 500);
  check('WebRTC readers released after pages close', !!cleared, { paths: cleared });
  const released = await waitFor(async () => { const h = await (await fetch(RELAY + '/healthz')).json(); return h.chatClients === 0 ? h : null; }, 15000);
  check('chat sockets released after pages close', !!released, { healthz: released });
  p1.close(); p2.close();
}

const t0 = Date.now();
try { await main(); }
catch (error) { check('script error', false, { error: error.stack }); }
finally {
  clearInterval(announcer); clearInterval(cpuTimer);
  if (forwarder) { forwarder.stopped = true; }
  if (apiProxy) await apiProxy.close().catch(() => {});
  result.finishedAt = new Date().toISOString(); result.durationS = Math.round((Date.now() - t0) / 1000);
  result.host.cpuLoadPct = cpuSamples.length ? { samples: cpuSamples.length, min: Math.min(...cpuSamples), avg: Math.round(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length), max: Math.max(...cpuSamples) } : null;
  result.passed = list.filter(c => c.ok).length; result.failed = list.filter(c => !c.ok).length;
  const logs = [relay, mediamtxFirst, mediamtx, sender, front, publisher].filter(Boolean).map(p => [p.name, p.lines]);
  if (forwarder) logs.push(['forwarder', forwarder.allLines.concat(forwarder.proc?.running ? forwarder.proc.lines : [])]);
  for (const [name, lines] of logs) writeFileSync(join(OUT, 'logs', name + '.log'), mask(lines.join('\n')));
  const csv = readStats();
  if (csv.raw) writeFileSync(join(OUT, 'stats-sample.csv'), csv.raw.split('\n').slice(0, 12).join('\n') + '\n');
  writeFileSync(join(OUT, 'e2e-result.json'), mask(JSON.stringify(result, null, 2)));
  console.log(`\n${result.passed} passed, ${result.failed} failed in ${result.durationS} s (host CPU ${JSON.stringify(result.host.cpuLoadPct)}) -> deploy/verification/e2e-result.json`);
  await stopAll();
  const leftovers = killByCommandLine(TMP);
  if (leftovers.length) console.log('stopped leftover processes of this run:', leftovers.join(','));
  if (!process.argv.includes('--keep')) try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(result.failed ? 1 : 0);
}
