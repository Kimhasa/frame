// A long-running FRAME test broadcast behind a real Caddy (HTTPS/WSS), for checking the React public web on this PC and on
// phones (FRAME_DESIGN.md 5.4, 1단계 후속). Runs until stopped:
//   FFmpeg test publisher (1280x720 30 fps: test pattern + wall clock + elapsed time; audio: a short 880 Hz beep every
//   second, 1320 Hz on every 10th second; H.264 + Opus + AAC over RTSPS as the app publishes)
//   -> relay MediaMTX (deploy/mediamtx-relay.yml, environment overrides only, loopback ports 26xxx)
//   -> server/relay.mjs (RELAY_RENDITIONS=480p, RELAY_PUBLIC_BASE_URL = the test HTTPS address)
//   -> Caddy (deploy/test/Caddyfile.https-test): apps/web/dist at /_frame/, everything else to the relay.
// Separate from production and from the e2e runs: own ports (26000-26999), own folder outside the repository
// (default %LOCALAPPDATA%/FrameTest/https), secrets made per run and kept in memory only (logs are masked).
//
// usage
//   node server/verify/https-session.mjs --host <name> --tls tailscale|internal [--bind <ip>] [--port 443] [--caddy <caddy.exe>]
//        [--dir <folder>] [--backend node|spring]
//     --backend spring: the Spring Boot port (apps/api/build/libs/frame-api.jar; JAVA_HOME or FRAME_JAVA = a JDK 21) in place of
//                server/relay.mjs, with the same RELAY_* environment plus RELAY_UI_FILE=outputs/index.html.
//     tailscale: `tailscale cert` for <name> (a *.ts.net name; HTTPS certificates must be enabled in the tailnet), bound to
//                this PC's Tailscale IPv4 unless --bind; a publicly trusted (Let's Encrypt) certificate.
//     internal:  Caddy's local CA (its root stays in <folder>/caddy-data, never installed into a trust store).
//   node server/verify/https-session.mjs --stop [--dir <folder>]      stop a running session (bye, then every process)
// Control (loopback only, port 26090; https-check.mjs uses it):
//   GET  /state                 addresses, broadcast, processes (no secrets)
//   POST /validate              caddy validate with the session's settings -> {code, output}
//   POST /waiting               announce a second broadcast on screen-02 with no media (the relay answers 503 + Retry-After
//                               for it during RELAY_MEDIA_GRACE_MS); POST /waiting/bye withdraws it
//   POST /reload-caddy          caddy reload --force (Caddy closes proxied WebSockets on a reload: a server-side chat drop)
//   POST /restart-relay         stops the relay web service (killed, as a crash) and starts it again with the same settings ->
//                               {stopMs, upAfterMs}: what a restart of the service looks like to viewers behind Caddy
//   POST /stop
// Heavy: MediaMTX, the relay, an FFmpeg publisher, the relay's 480p encoder and Caddy. Run alone, not next to an e2e run.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, createWriteStream, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import tls from 'node:tls';
import { start, stop, waitFor, sleep, portFree } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; };
const DIR = resolve(arg('dir', join(process.env.LOCALAPPDATA || ROOT, 'FrameTest', 'https'))).replace(/\\/g, '/');
const CONTROL_PORT = 26090;

if (process.argv.includes('--stop')) {
  let pids = [];
  try {
    pids = Object.entries((await (await fetch(`http://127.0.0.1:${CONTROL_PORT}/state`)).json()).processes || {});
    await fetch(`http://127.0.0.1:${CONTROL_PORT}/stop`, { method: 'POST' });
  } catch (error) { console.log('no session answered on the control port:', error.message); process.exit(0); }
  // Stopped = state.json has stoppedAt and none of the session's processes is alive (60 s at most).
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = Date.now() + 60000;
  for (;;) {
    let st = null; try { st = JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8')); } catch {}
    const left = pids.filter(([, pid]) => alive(pid));
    if (st?.stoppedAt && !left.length) { console.log('stopped', st.stoppedAt); process.exit(0); }
    if (Date.now() > until) { console.log('still running:', left.map(([n, pid]) => `${n}:${pid}`).join(', ') || '(state.json not updated)'); process.exit(1); }
    await new Promise(r => setTimeout(r, 500));
  }
}

const HOST = arg('host')?.toLowerCase();
const TLS_MODE = arg('tls', 'tailscale');
const HTTPS_PORT = Number(arg('port', '443'));
// Never fall back to the Node relay by accident: "--backend" without a value and "--backend=spring" are refused.
if (process.argv.some(a => a.startsWith('--backend=')) || (process.argv.includes('--backend') && !arg('backend'))) throw new Error('usage: --backend node|spring');
const BACKEND = arg('backend', 'node');
if (!['node', 'spring'].includes(BACKEND)) throw new Error('--backend must be node or spring');
const JAVA = process.env.FRAME_JAVA || join(process.env.JAVA_HOME || '', 'bin', 'java.exe');
const API_JAR = join(ROOT, 'apps/api/build/libs/frame-api.jar');
if (!HOST || !/^[A-Za-z0-9.-]+$/.test(HOST)) throw new Error('--host <name or IP> is required');
if (!['tailscale', 'internal'].includes(TLS_MODE)) throw new Error('--tls must be tailscale or internal');
const ORIGIN = `https://${HOST}${HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT}`;
const BIN = join(ROOT, 'dist/FrameConsole/bin');
const FFMPEG = join(BIN, 'ffmpeg.exe'), MEDIAMTX = join(BIN, 'mediamtx.exe');
const CADDY = resolve(arg('caddy', join(process.env.LOCALAPPDATA || ROOT, 'FrameTest', 'caddy', 'caddy.exe')));
const TAILSCALE = 'C:/Program Files/Tailscale/tailscale.exe';
const OPENSSL = ['C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'].find(existsSync);
const CADDYFILE = join(ROOT, 'deploy/test/Caddyfile.https-test');
const DIST = join(ROOT, 'apps/web/dist').replace(/\\/g, '/');
const PORT = { rtsp: 26554, rtsps: 26322, rtp: 26000, rtcp: 26001, webrtc: 26889, ice: 26189, hls: 26888, api: 26997, playback: 26996, metrics: 26998,
  relay: 26070, caddyAdmin: 26019, control: CONTROL_PORT };
const RELAY = `http://127.0.0.1:${PORT.relay}`, MTX_API = `http://127.0.0.1:${PORT.api}`;
const PATH = 'screen-01', WAITING_PATH = 'screen-02', USER = 'frame-sender-01';
const TITLE = 'FRAME HTTPS 시험 방송', PUBLISHER = 'HTTPS-TEST';
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const RUN = join(DIR, 'runs', stamp).replace(/\\/g, '/');
for (const d of [DIR, RUN, join(DIR, 'certs'), join(DIR, 'caddy-data')]) mkdirSync(d, { recursive: true });

// ---- secrets (memory only) and masked logging -------------------------------------------------------------------------
const secret = () => randomBytes(18).toString('hex');
const PASS = secret(), PASS_OTHER = secret(), TOKEN = secret() + secret();
const mask = s => [PASS, PASS_OTHER, TOKEN].reduce((t, x) => t.replaceAll(x, '***'), String(s)).replace(/(rtsps?:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1***@');
const sha = s => createHash('sha256').update(s).digest('base64');
const logFile = createWriteStream(join(RUN, 'session.log'), { flags: 'a' });
const say = (...parts) => { const line = `${new Date().toISOString()} ${mask(parts.join(' '))}`; console.log(line); logFile.write(line + '\n'); };
// Every process log of the run is written masked (harness.start keeps raw lines in memory; files are written here).
const procs = [];
// Whatever ends this process (a failed start-up step included: a rejected top-level await exits with code 1), the processes
// it started are killed by their own PIDs, never left behind.
process.on('exit', () => {
  for (const p of procs) if (p.running) try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
});
// A failed start-up step (top-level await rejections arrive here too) is written to this run's session.log and to
// state.json, which the next launch's stderr redirect would otherwise overwrite. After start-up, the session shuts down.
let started = false, shutdownHook = null;
process.on('uncaughtException', error => {
  if (started && shutdownHook) { say('error:', error.stack || error.message); shutdownHook('error'); return; }
  try {
    const line = `${new Date().toISOString()} ${mask('start-up failed: ' + (error.stack || error.message))}`;
    console.error(line);
    appendFileSync(join(RUN, 'session.log'), line + '\n');
    writeFileSync(join(DIR, 'state.json'), JSON.stringify({ run: RUN, failedAt: new Date().toISOString(), error: mask(error.message) }, null, 2));
  } catch {}
  process.exit(1);
});
function run(name, cmd, args, opts = {}) {
  const p = start(name, cmd, args, { ...opts, logDir: undefined });
  const file = createWriteStream(join(RUN, name + '.log'), { flags: 'a' });
  for (const s of [p.child.stdout, p.child.stderr]) s.on('data', d => file.write(mask(d.toString())));
  p.child.on('exit', code => { file.end(`\n[exit ${code}]\n`); });
  procs.push(p);
  return p;
}

const BROADCAST_ID = randomBytes(16).toString('hex');
const state = {
  startedAt: new Date().toISOString(), origin: ORIGIN, tls: TLS_MODE, backend: BACKEND, dir: DIR, run: RUN,
  urls: { list: `${ORIGIN}/_frame/live`, watch: `${ORIGIN}/_frame/watch/${PATH}/${BROADCAST_ID}`, legacy: `${ORIGIN}/${PATH}` },
  broadcast: { path: PATH, id: BROADCAST_ID, title: TITLE, publisher: PUBLISHER, startedAtMs: null },
  testSignal: {
    video: '1280x720 30 fps H.264 2.5 Mbps (GOP 1 s): test pattern, wall clock (HH:MM:SS, this PC) and elapsed time since the publisher started',
    audio: 'AAC + Opus 48 kHz stereo: a 0.15 s beep every second, 880 Hz, and 1320 Hz on every 10th second (silence in between)',
    qualities: ['source 720p (src)', '480p (relay ladder)']
  },
  ports: { https: HTTPS_PORT, ...PORT }, processes: {}, caddy: { binary: CADDY, config: CADDYFILE, validate: null, rootCa: null },
  waiting: null, stopping: false
};
const saveState = () => { state.processes = Object.fromEntries(procs.filter(p => p.running).map(p => [p.name, p.pid])); writeFileSync(join(DIR, 'state.json'), JSON.stringify(state, null, 2)); };

// ---- checks before starting ---------------------------------------------------------------------------------------------
for (const [what, file] of [['FFmpeg', FFMPEG], ['MediaMTX', MEDIAMTX], ['Caddy', CADDY], ['web build (corepack yarn build)', join(DIST, 'index.html')], ['openssl (Git for Windows)', OPENSSL || ''],
  ...(BACKEND === 'spring' ? [['the Spring backend (cd apps/api && ./gradlew bootJar)', API_JAR], ['Java (JAVA_HOME or FRAME_JAVA, JDK 21)', JAVA]] : [])])
  if (!file || !existsSync(file)) throw new Error(`${what} not found: ${file}`);
const busy = [];
for (const [name, p] of Object.entries(PORT)) if (!(await portFree(p))) busy.push(`${name}:${p}`);
if (busy.length) throw new Error('ports in use (another session or e2e run?): ' + busy.join(', '));

// The address Caddy listens on: this PC's Tailscale IPv4 for a tailnet name (never the LAN), else what --bind says.
let BIND = arg('bind');
if (!BIND && TLS_MODE === 'tailscale') BIND = execFileSync(TAILSCALE, ['ip', '-4']).toString().trim().split(/\s+/)[0];
if (!BIND) BIND = /^\d+\.\d+\.\d+\.\d+$/.test(HOST) ? HOST : '127.0.0.1';
state.bind = BIND;

// ---- certificates -------------------------------------------------------------------------------------------------------
// RTSPS between the test publisher and MediaMTX (loopback only): a throwaway self-signed certificate.
execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', join(RUN, 'rtsps-key.pem'), '-out', join(RUN, 'rtsps-cert.pem')], { stdio: 'ignore' });
let TLS_DIRECTIVE = 'internal';
if (TLS_MODE === 'tailscale') {
  const crt = join(DIR, 'certs', HOST + '.crt').replace(/\\/g, '/'), key = join(DIR, 'certs', HOST + '.key').replace(/\\/g, '/');
  try {
    const out = execFileSync(TAILSCALE, ['cert', '--cert-file', crt, '--key-file', key, HOST], { stdio: ['ignore', 'pipe', 'pipe'] });
    say('tailscale cert:', out.toString().trim());
  } catch (error) {
    throw new Error(`tailscale cert failed (HTTPS certificates enabled in the tailnet's DNS settings?): ${(error.stderr || error.message).toString().trim()}`);
  }
  TLS_DIRECTIVE = `${crt} ${key}`;
}
const caddyEnv = {
  FRAME_TEST_HOST: HOST, FRAME_TEST_PORT: String(HTTPS_PORT), FRAME_TEST_BIND: BIND, FRAME_TEST_TLS: TLS_DIRECTIVE, FRAME_TEST_DIST: DIST,
  FRAME_TEST_RELAY: `127.0.0.1:${PORT.relay}`, FRAME_TEST_DIR: DIR, FRAME_TEST_ADMIN: `127.0.0.1:${PORT.caddyAdmin}`,
  // Caddy's own data and config folders (instance.uuid, autosave) inside the test folder, not %AppData%\Caddy.
  XDG_DATA_HOME: join(DIR, 'caddy-home', 'data').replace(/\\/g, '/'), XDG_CONFIG_HOME: join(DIR, 'caddy-home', 'config').replace(/\\/g, '/')
};
function caddyCli(args) {
  const r = { code: 0, output: '' };
  try { r.output = execFileSync(CADDY, args, { env: { ...process.env, ...caddyEnv }, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
  catch (error) { r.code = error.status ?? 1; r.output = `${error.stdout || ''}${error.stderr || error.message}`; }
  r.output = r.output.trim().split(/\r?\n/).slice(-12).join('\n');
  return r;
}
const validate = () => caddyCli(['validate', '--config', CADDYFILE, '--adapter', 'caddyfile']);
state.caddy.validate = validate();
say('caddy validate:', state.caddy.validate.code, state.caddy.validate.output.split('\n').at(-1));
if (state.caddy.validate.code !== 0) { saveState(); throw new Error('caddy validate failed:\n' + state.caddy.validate.output); }

// ---- relay MediaMTX + relay -----------------------------------------------------------------------------------------------
const mtxDir = join(RUN, 'mediamtx');
mkdirSync(mtxDir, { recursive: true });
copyFileSync(join(ROOT, 'deploy/mediamtx-relay.yml'), join(mtxDir, 'mediamtx.yml'));
const mtxEnv = {
  MTX_AUTHINTERNALUSERS_1_PASS: 'sha256:' + sha(PASS), MTX_AUTHINTERNALUSERS_2_PASS: 'sha256:' + sha(PASS_OTHER),
  MTX_RTSPADDRESS: `127.0.0.1:${PORT.rtsp}`, MTX_RTSPSADDRESS: `127.0.0.1:${PORT.rtsps}`, MTX_RTPADDRESS: `127.0.0.1:${PORT.rtp}`, MTX_RTCPADDRESS: `127.0.0.1:${PORT.rtcp}`,
  MTX_RTSPSERVERKEY: join(RUN, 'rtsps-key.pem'), MTX_RTSPSERVERCERT: join(RUN, 'rtsps-cert.pem'),
  MTX_WEBRTCADDRESS: `127.0.0.1:${PORT.webrtc}`, MTX_WEBRTCLOCALUDPADDRESS: `127.0.0.1:${PORT.ice}`, MTX_WEBRTCLOCALTCPADDRESS: `127.0.0.1:${PORT.ice}`, MTX_WEBRTCADDITIONALHOSTS: '127.0.0.1',
  MTX_HLSADDRESS: `127.0.0.1:${PORT.hls}`, MTX_APIADDRESS: `127.0.0.1:${PORT.api}`, MTX_PLAYBACKADDRESS: `127.0.0.1:${PORT.playback}`, MTX_METRICSADDRESS: `127.0.0.1:${PORT.metrics}`,
  PATH: BIN + ';' + process.env.PATH
};
const mediamtx = run('mediamtx', MEDIAMTX, ['mediamtx.yml'], { cwd: mtxDir, env: mtxEnv });
if (!(await waitFor(async () => (await fetch(MTX_API + '/v3/paths/list')).ok, 15000))) throw new Error('relay MediaMTX did not start (see mediamtx.log)');
const startRelay = () => run('relay', ...(BACKEND === 'spring' ? [JAVA, ['-Xms64m', '-jar', API_JAR]] : [process.execPath, [join(ROOT, 'server/relay.mjs')]]), { env: {
  ...(BACKEND === 'spring' ? { RELAY_UI_FILE: join(ROOT, 'outputs/index.html') } : {}),
  RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: String(PORT.relay), RELAY_PUBLIC_BASE_URL: ORIGIN, RELAY_TRUSTED_PROXIES: '127.0.0.1,::1',
  RELAY_PUBLISHER_TOKENS: `${TOKEN} ${PATH} ${WAITING_PATH}`, RELAY_PUBLISHER_TOKENS_FILE: '',
  RELAY_MEDIAMTX_API: MTX_API, RELAY_MEDIAMTX_WEBRTC: `http://127.0.0.1:${PORT.webrtc}`, RELAY_MEDIAMTX_HLS: `http://127.0.0.1:${PORT.hls}`,
  RELAY_MEDIAMTX_PLAYBACK: `http://127.0.0.1:${PORT.playback}`, RELAY_RECORD_DIR: join(mtxDir, 'recordings'), RELAY_DVR: '1', RELAY_HLS: '1', RELAY_HLS_AAC: '0',
  RELAY_RENDITIONS: '480p', RELAY_FFMPEG: FFMPEG, RELAY_MEDIAMTX_RTSP: `rtsp://127.0.0.1:${PORT.rtsp}`,
  // Phones come and go during a test: keep the quality ladder up for an hour without viewers (production default 5 min),
  // so a phone opening the page later does not wait for a cold ladder (about 8 s).
  RELAY_LADDER_IDLE_MS: '3600000',
  RELAY_ICE_SERVERS: '[]', RELAY_TURN_URLS: '', RELAY_TURN_SECRET: '', RELAY_STATS_DIR: '', RELAY_LOG_LEVEL: 'info'
} });
let relay = startRelay(), relayRestarting = false;
if (!(await waitFor(async () => (await (await fetch(RELAY + '/healthz')).json()).mediamtx, 30000))) throw new Error('relay did not start (see relay.log)');

// ---- test publisher ---------------------------------------------------------------------------------------------------------
copyFileSync('C:/Windows/Fonts/consola.ttf', join(RUN, 'consola.ttf'));
writeFileSync(join(RUN, 'clock.txt'), '%{localtime:%X}');
writeFileSync(join(RUN, 'elapsed.txt'), 'FRAME HTTPS TEST  %{pts:hms}');
const VIDEO = 'testsrc2=size=1280x720:rate=30,drawbox=x=0:y=0:w=iw:h=150:color=black@0.7:t=fill,' +
  'drawtext=fontfile=consola.ttf:fontsize=64:fontcolor=white:x=40:y=18:textfile=clock.txt,' +
  'drawtext=fontfile=consola.ttf:fontsize=40:fontcolor=yellow:x=40:y=96:textfile=elapsed.txt';
const AUDIO = "aevalsrc='0.25*sin(2*PI*if(eq(mod(floor(t),10),0),1320,880)*t)*lt(mod(t,1),0.15)':s=48000:c=stereo";
const pubArgs = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', VIDEO, '-f', 'lavfi', '-i', AUDIO,
  '-map', '0:v', '-map', '1:a', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-bf', '0', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
  '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '2500k', '-c:a:0', 'libopus', '-b:a:0', '96k', '-c:a:1', 'aac', '-b:a:1', '128k', '-ac', '2',
  '-f', 'rtsp', '-rtsp_transport', 'tcp', '-pkt_size', '1190', '-ca_file', join(RUN, 'rtsps-cert.pem'), `rtsps://${USER}:${PASS}@127.0.0.1:${PORT.rtsps}/${PATH}`];
let stopping = false, publisher = null, publisherStarts = 0;
const publisherLoop = (async () => {
  let failures = 0;
  while (!stopping) {
    const t = Date.now();
    publisherStarts++;
    publisher = run(`publisher-${publisherStarts}`, FFMPEG, pubArgs, { cwd: RUN });
    saveState();
    await publisher.exited;
    if (stopping) break;
    failures = Date.now() - t > 15000 ? 1 : failures + 1;
    say(`publisher exited, restart ${publisherStarts + 1} in ${[1, 2, 3, 5][Math.min(failures, 4) - 1]} s`);
    await sleep([1000, 2000, 3000, 5000][Math.min(failures, 4) - 1]);
  }
})();
if (!(await waitFor(async () => (await (await fetch(`${MTX_API}/v3/paths/get/${PATH}`)).json()).ready, 30000, 250))) throw new Error('the test publisher did not reach MediaMTX (see publisher-1.log)');

// ---- announcements (contract v1: every 2 s) and the list thumbnail ---------------------------------------------------------
const announce = body => fetch(RELAY + '/api/broadcasts/announce', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
state.broadcast.startedAtMs = Date.now();
const item = { id: BROADCAST_ID, title: TITLE, publisher: PUBLISHER, path: PATH, width: 1280, height: 720, fps: 30, startedAtMs: state.broadcast.startedAtMs, bitrate: 2.5, audio: 'system' };
const announceStatus = {};
let inflight = Promise.resolve();
const announceOnce = () => (inflight = (async () => {
  let status = 0;
  try { status = (await announce({ v: 1, type: 'announce', item: { ...item, sentAtMs: Date.now() } })).status; } catch {}
  announceStatus[status] = (announceStatus[status] || 0) + 1;
  if (status !== 204 && (announceStatus[status] === 1 || announceStatus[status] % 30 === 0)) say('announce answered', status);
})());
await announceOnce();
const announceTimer = setInterval(() => { if (!stopping) announceOnce(); }, 2000);
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', VIDEO.replace('rate=30', 'rate=1'), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', 'thumb.jpg'], { cwd: RUN });
// Uploaded again every 60 s: an announcement gap over the relay's TTL (15 s) makes the next announcement a new entry
// without a thumbnail (and a fresh chat room).
const putThumb = async () => { try { return (await fetch(`${RELAY}/api/broadcasts/${BROADCAST_ID}/thumbnail`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + TOKEN }, body: readFileSync(join(RUN, 'thumb.jpg')), signal: AbortSignal.timeout(5000) })).status; } catch { return 0; } };
state.broadcast.thumbnailUpload = await putThumb();
const thumbTimer = setInterval(() => { if (!stopping) putThumb().then(status => { if (status !== 204) say('thumbnail upload answered', status); }); }, 60000);

// ---- Caddy ---------------------------------------------------------------------------------------------------------------
const caddy = run('caddy', CADDY, ['run', '--config', CADDYFILE, '--adapter', 'caddyfile'], { env: caddyEnv });
// The admin API refuses fetch() (its Sec-Fetch-Mode header triggers Caddy's origin check): a plain http.get.
const adminGet = path => new Promise(done => {
  const r = http.get({ host: '127.0.0.1', port: PORT.caddyAdmin, path }, res => { res.resume(); done(res.statusCode); });
  r.on('error', () => done(0)); r.setTimeout(3000, () => { r.destroy(); done(0); });
});
// Up: the admin API answers and the HTTPS address completes a TLS handshake for the test host.
const handshake = () => new Promise(done => {
  const s = tls.connect({ host: BIND, port: HTTPS_PORT, servername: HOST, rejectUnauthorized: false }, () => { const c = s.getPeerCertificate(); s.end(); done({ issuer: c.issuer?.CN || c.issuer?.O, validTo: c.valid_to }); });
  s.on('error', () => done(null)); s.setTimeout(5000, () => { s.destroy(); done(null); });
});
const caddyUp = await waitFor(async () => (await adminGet('/config/')) === 200 && await handshake(), 30000, 500);
if (!caddyUp) throw new Error('Caddy did not start (see caddy.log)');
state.caddy.certificate = caddyUp;
if (TLS_MODE === 'internal') state.caddy.rootCa = join(DIR, 'caddy-data/pki/authorities/local/root.crt').replace(/\\/g, '/');

// ---- control (loopback) ------------------------------------------------------------------------------------------------------
let waitingTimer = null;
async function waitingBye() {
  if (!state.waiting) return null;
  clearTimeout(waitingTimer);
  const id = state.waiting.id;
  let status = 0;
  try { status = (await announce({ v: 1, type: 'bye', id })).status; } catch {}
  state.waiting = null; saveState();
  return { bye: status, id };
}
const control = http.createServer(async (req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  // Local tools only (https-check.mjs, --stop): a web page on this PC sends an Origin header (a simple cross-site POST needs
  // no preflight), and a DNS-rebinding page has another Host. Both are refused.
  if (req.headers.host !== `127.0.0.1:${PORT.control}` || req.headers.origin !== undefined) return reply(403, { error: 'forbidden' });
  try {
    if (req.method === 'GET' && req.url === '/state') { saveState(); return reply(200, { ...state, announceStatus, publisherStarts }); }
    if (req.method !== 'POST') return reply(405, { error: 'method' });
    if (req.url === '/validate') return reply(200, validate());
    if (req.url === '/reload-caddy') return reply(200, caddyCli(['reload', '--config', CADDYFILE, '--adapter', 'caddyfile', '--address', `127.0.0.1:${PORT.caddyAdmin}`, '--force']));
    if (req.url === '/waiting') {
      await waitingBye();
      const id = randomBytes(16).toString('hex');
      const status = (await announce({ v: 1, type: 'announce', item: { id, title: 'FRAME HTTPS 대기 시험', publisher: PUBLISHER, path: WAITING_PATH, width: 1280, height: 720, fps: 30, startedAtMs: Date.now(), sentAtMs: Date.now(), bitrate: 1, audio: 'none' } })).status;
      state.waiting = { path: WAITING_PATH, id, announcedAt: new Date().toISOString(), status };
      waitingTimer = setTimeout(() => { waitingBye().catch(() => {}); }, 30000);
      saveState();
      return reply(200, state.waiting);
    }
    if (req.url === '/waiting/bye') return reply(200, await waitingBye());
    if (req.url === '/restart-relay') {
      if (relayRestarting) return reply(409, { error: 'restarting' });
      relayRestarting = true;
      try {
        const t = Date.now();
        await stop(relay);
        const downAt = Date.now();
        say('relay stopped for a restart test');
        relay = startRelay();
        const up = await waitFor(async () => (await (await fetch(RELAY + '/healthz')).json()).mediamtx, 60000, 100);
        saveState();
        return reply(200, { stopMs: downAt - t, upAfterMs: up ? Date.now() - downAt : null });
      } finally { relayRestarting = false; }
    }
    if (req.url === '/stop') { reply(202, { stopping: true }); setTimeout(() => shutdown('control /stop'), 50); return; }
    return reply(404, { error: 'unknown' });
  } catch (error) { return reply(500, { error: error.message }); }
});
await new Promise((resolve, reject) => control.once('error', reject).listen(PORT.control, '127.0.0.1', resolve));

saveState();
say(`session up: ${state.urls.list}  (watch: ${state.urls.watch})  bind ${BIND}:${HTTPS_PORT}, tls ${TLS_MODE}, run folder ${RUN}`);

// ---- watchdog and shutdown ----------------------------------------------------------------------------------------------------
// A tick much later than 5 s (sleep / resume, a stalled machine) is recorded: the relay may have ended the broadcast's
// entry meanwhile (chat history reset, a new list entry).
state.events = [];
let lastTick = Date.now();
const watchdog = setInterval(() => {
  const gap = Date.now() - lastTick; lastTick = Date.now();
  if (gap > 15000) { say(`clock gap ${Math.round(gap / 1000)} s (sleep/resume or a stall)`); state.events.push({ at: new Date().toISOString(), gapS: Math.round(gap / 1000) }); }
  for (const p of [mediamtx, relay, caddy]) if (!p.running && !stopping && !(p === relay && relayRestarting)) { say(`${p.name} exited unexpectedly; stopping the session`); shutdown(p.name + ' exited'); return; }
  saveState();
}, 5000);

let finishing = null;
function shutdown(why) {
  if (finishing) return finishing;
  finishing = (async () => {
    stopping = true; state.stopping = true;
    say('stopping:', why);
    clearInterval(announceTimer); clearInterval(watchdog); clearInterval(thumbTimer);
    await inflight.catch(() => {});
    await waitingBye().catch(() => {});
    try { say('bye', (await announce({ v: 1, type: 'bye', id: BROADCAST_ID })).status); } catch {}
    for (const p of [publisher, caddy, relay, mediamtx]) await stop(p);
    await Promise.race([publisherLoop, sleep(5000)]);
    for (const p of procs) await stop(p);
    control.close();
    state.stoppedAt = new Date().toISOString(); state.processes = {};
    writeFileSync(join(DIR, 'state.json'), JSON.stringify(state, null, 2));
    say('stopped');
    logFile.end();
    setTimeout(() => process.exit(0), 200);
  })();
  return finishing;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
shutdownHook = shutdown;
started = true;
