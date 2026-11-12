// The real Windows sender (dist/FrameConsole/FrameConsole.exe) against the Spring Boot backend (apps/api), on isolated
// loopback ports 27000-27999: the app's relay copy (RTSPS) and its announcements go to a relay MediaMTX
// (deploy/mediamtx-relay.yml, environment overrides only) and to frame-api.jar; the React production build (apps/web/dist,
// served by server/verify/web-proxy.mjs in front of Spring, as Caddy does) lists and plays the app's broadcast in headless Edge.
//   1 the app announces to Spring (list shows its broadcast while its media reaches the relay MediaMTX)
//   2 /_frame/live shows the card; the watch page plays the app's video through Spring's HLS routes (hls.js, frames advance,
//     every media request under /<path>/b/<id>/, a viewer session first)
//   3 stopping the broadcast in the app withdraws it (bye): the list empties, /info says running:false
// The app's own config/frame-console.json and frame-console.secrets.json are backed up first and always restored; the
// relay settings and a per-run publisher token / MediaMTX password exist only for this run (results and logs are masked).
// Needs: the app with its bin/ (FFmpeg, MediaMTX), apps/api/build/libs/frame-api.jar, JAVA_HOME (JDK 21), apps/web/dist
// (corepack yarn build), Microsoft Edge, Git for Windows' openssl. Heavy (the app captures and encodes): run it alone.
// usage: node server/verify/spring-app-check.mjs
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { start, stop, stopAll, waitFor, sleep, checks, killByCommandLine, portFree, scrub } from './harness.mjs';
import { connect } from '../../tools/cdp.mjs';
import { app as appPage, selectWindow } from '../../tools/app-flow.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'verification/spring');
const TMP = join(tmpdir(), 'frame-spring-app-' + Date.now());
const APP_DIR = join(ROOT, 'dist/FrameConsole'), APP = join(APP_DIR, 'FrameConsole.exe'), CONFIG_DIR = join(APP_DIR, 'config');
const FFMPEG = join(APP_DIR, 'bin/ffmpeg.exe'), MEDIAMTX = join(APP_DIR, 'bin/mediamtx.exe');
const JAVA = process.env.FRAME_JAVA || join(process.env.JAVA_HOME || '', 'bin', 'java.exe');
const API_JAR = join(ROOT, 'apps/api/build/libs/frame-api.jar'), DIST = join(ROOT, 'apps/web/dist');
const EDGE = process.env.FRAME_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OPENSSL = ['C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'].find(existsSync);
const PORT = { rtsp: 27554, rtsps: 27322, rtp: 27000, rtcp: 27001, webrtc: 27889, ice: 27189, hls: 27888, api: 27997, playback: 27996, metrics: 27998,
  spring: 27070, web: 27080, control: 27081, edge: 27222 };
const SPRING = `http://127.0.0.1:${PORT.spring}`, WEB = `http://127.0.0.1:${PORT.web}`, MTX_API = `http://127.0.0.1:${PORT.api}`;
const PATH = 'screen-01', USER = 'frame-sender-01', WINDOW = 'FRAME 모션 테스트';
const secret = () => randomBytes(18).toString('hex');
const PASS = secret(), PASS_OTHER = secret(), TOKEN = secret() + secret();
const mask = s => [PASS, PASS_OTHER, TOKEN].reduce((t, x) => t.replaceAll(x, '***'), String(s)).replace(/(rtsps?:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1***@');
const sha = s => createHash('sha256').update(s).digest('base64');
for (const d of [TMP, OUT, join(OUT, 'logs')]) mkdirSync(d, { recursive: true });

const { list, check } = checks();
const result = { startedAt: new Date().toISOString(), kind: 'real FrameConsole.exe -> Spring Boot backend (apps/api), loopback ports 27xxx', ports: PORT, checks: list, notes: [] };
const getJson = async url => { try { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); return { status: r.status, body: await r.json().catch(() => null) }; } catch (e) { return { status: 0, body: null, error: e.message }; } };

// ---- the app's configuration: backed up, changed for this run, always restored ----------------------------------------
const CONFIG = join(CONFIG_DIR, 'frame-console.json'), SECRETS = join(CONFIG_DIR, 'frame-console.secrets.json');
const backup = { config: readFileSync(CONFIG), secrets: existsSync(SECRETS) ? readFileSync(SECRETS) : null };
copyFileSync(CONFIG, join(TMP, 'frame-console.json.bak'));
function restoreConfig() {
  writeFileSync(CONFIG, backup.config);
  if (backup.secrets) writeFileSync(SECRETS, backup.secrets); else rmSync(SECRETS, { force: true });
}

// The app and the capture window are started visible (Start-Process), not hidden like the helper processes: a hidden window
// cannot be captured. Both are stopped by their own PIDs (the Edge window by its profile folder) at the end.
function launchVisible(file, args, envPs = '') {
  const q = v => `'${String(v).replace(/'/g, "''")}'`;
  const cmd = `${envPs}$p = Start-Process -FilePath ${q(file)} ${args.length ? '-ArgumentList ' + args.map(q).join(',') : ''} -WorkingDirectory ${q(dirname(file))} -PassThru; $p.Id`;
  return Number(execFileSync('powershell', ['-NoProfile', '-Command', cmd]).toString().trim());
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
let appPid = 0, edge = null, page = null;
// Ctrl+C or a closed console must not leave the test relay settings in the app's configuration: the app is stopped by its
// PID, the browser of this run by its profile folder, and the original files (kept in memory) are written back.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => {
  try { if (appPid) execFileSync('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { killByCommandLine(TMP); } catch {}
  try { restoreConfig(); } catch {}
  process.exit(130);
});
const t0 = Date.now();
try {
  for (const [what, file] of [['the app', APP], ['FFmpeg', FFMPEG], ['MediaMTX', MEDIAMTX], ['frame-api.jar (cd apps/api && ./gradlew bootJar)', API_JAR], ['Java (JAVA_HOME)', JAVA],
    ['apps/web/dist (corepack yarn build)', join(DIST, 'index.html')], ['Edge', EDGE], ['openssl', OPENSSL || '']])
    if (!file || !existsSync(file)) throw new Error(`missing ${what}: ${file}`);
  const busy = [];
  for (const p of Object.values(PORT)) if (!(await portFree(p))) busy.push(p);
  if (busy.length) throw new Error('ports in use: ' + busy.join(','));
  if (execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-Process FrameConsole -ErrorAction SilentlyContinue).Count"]).toString().trim() !== '0')
    throw new Error('FrameConsole.exe is already running: close it first');

  // RTSPS certificate of the relay MediaMTX (the app's FFmpeg copy trusts it through relayCaFile).
  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(TMP, 'key.pem'), '-out', join(TMP, 'cert.pem')], { stdio: 'ignore' });
  const mtxDir = join(TMP, 'mediamtx');
  mkdirSync(mtxDir, { recursive: true });
  copyFileSync(join(ROOT, 'deploy/mediamtx-relay.yml'), join(mtxDir, 'mediamtx.yml'));
  const mediamtx = start('mediamtx', MEDIAMTX, ['mediamtx.yml'], { cwd: mtxDir, logDir: TMP, env: {
    MTX_AUTHINTERNALUSERS_1_PASS: 'sha256:' + sha(PASS), MTX_AUTHINTERNALUSERS_2_PASS: 'sha256:' + sha(PASS_OTHER),
    MTX_RTSPADDRESS: `127.0.0.1:${PORT.rtsp}`, MTX_RTSPSADDRESS: `127.0.0.1:${PORT.rtsps}`, MTX_RTPADDRESS: `127.0.0.1:${PORT.rtp}`, MTX_RTCPADDRESS: `127.0.0.1:${PORT.rtcp}`,
    MTX_RTSPSERVERKEY: join(TMP, 'key.pem'), MTX_RTSPSERVERCERT: join(TMP, 'cert.pem'),
    MTX_WEBRTCADDRESS: `127.0.0.1:${PORT.webrtc}`, MTX_WEBRTCLOCALUDPADDRESS: `127.0.0.1:${PORT.ice}`, MTX_WEBRTCLOCALTCPADDRESS: `127.0.0.1:${PORT.ice}`, MTX_WEBRTCADDITIONALHOSTS: '127.0.0.1',
    MTX_HLSADDRESS: `127.0.0.1:${PORT.hls}`, MTX_APIADDRESS: `127.0.0.1:${PORT.api}`, MTX_PLAYBACKADDRESS: `127.0.0.1:${PORT.playback}`, MTX_METRICSADDRESS: `127.0.0.1:${PORT.metrics}`,
    PATH: join(APP_DIR, 'bin') + ';' + process.env.PATH } });
  if (!(await waitFor(async () => (await fetch(MTX_API + '/v3/paths/list')).ok, 15000))) throw new Error('relay MediaMTX did not start');
  const spring = start('spring', JAVA, ['-Xms64m', '-jar', API_JAR], { logDir: TMP, env: {
    RELAY_PORT: String(PORT.spring), RELAY_PUBLISHER_TOKENS: `${TOKEN} ${PATH}`, RELAY_MEDIAMTX_API: MTX_API, RELAY_MEDIAMTX_HLS: `http://127.0.0.1:${PORT.hls}` } });
  const up = await waitFor(async () => (await getJson(SPRING + '/healthz')).body?.mediamtx, 30000, 250);
  check('setup: Spring backend up (relay MediaMTX reachable), web-proxy serving apps/web/dist in front of it', !!up, { healthz: (await getJson(SPRING + '/healthz')).body });
  if (!up) throw new Error('Spring did not start');
  start('web-proxy', process.execPath, [join(ROOT, 'server/verify/web-proxy.mjs'), '--port', String(PORT.web), '--control', String(PORT.control), '--relay', SPRING, '--dist', DIST], { logDir: TMP });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT.control}/healthz`)).ok, 10000);

  // The app's relay settings for this run.
  const config = JSON.parse(backup.config.toString('utf8'));
  Object.assign(config, { relayApiUrl: SPRING, relayPublishUrl: `rtsps://127.0.0.1:${PORT.rtsps}`, relayCaFile: join(TMP, 'cert.pem'), streamPath: PATH,
    publisherName: 'APP-TEST' });  // a fixed name: an empty one makes the app announce this PC's machine name, which then shows in the list screenshot
  writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  writeFileSync(SECRETS, JSON.stringify({ relayUser: USER, relayPassword: PASS, relayToken: TOKEN }, null, 2));
  result.app = { resolution: config.resolution, fps: config.fps, audio: config.audio, encoder: config.encoder, renditions: config.renditions };

  // The capture source and the app (DevTools on 9222 for its UI).
  launchVisible(EDGE, [`--app=file:///${join(ROOT, 'tools/motion-test.html').replace(/\\/g, '/')}`, `--user-data-dir=${join(TMP, 'edge-motion')}`,
    '--disable-backgrounding-occluded-windows', '--no-first-run', '--window-size=1280,720']);
  appPid = launchVisible(APP, [], "$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; ");
  result.appPid = appPid;
  if (!(await waitFor(async () => (await fetch('http://127.0.0.1:9222/json/version')).ok, 40000, 500))) throw new Error('the app UI (DevTools 9222) did not come up');
  await sleep(3000);
  const ui = await appPage();
  await ui.evaluate(`document.getElementById('tab-sender').click()`);
  await selectWindow(ui, WINDOW);
  const tStart = Date.now();
  await ui.evaluate(`document.getElementById('start-button').click()`);
  const started = await waitFor(() => ui.evaluate(`document.getElementById('start-button').innerText.includes('종료')`), 30000, 250);

  // 1 the app's announcement reaches Spring, with its media on the relay MediaMTX
  const listed = await waitFor(async () => (await getJson(SPRING + '/api/broadcasts')).body?.items?.find(i => i.path === PATH), 60000, 500);
  const info = listed ? (await getJson(`${SPRING}/${PATH}/info`)).body : null;
  const mtxPath = (await getJson(`${MTX_API}/v3/paths/get/${PATH}`)).body;
  check('1 register: the app publishes over RTSPS and announces to Spring -> /api/broadcasts lists its broadcast, /info names it',
    !!started && !!listed && /^[0-9a-f]{32}$/.test(listed.id) && info?.running === true && info?.mediaReady === true && info?.broadcastId === listed.id && info?.hls?.scope === `b/${listed.id}/`,
    { started: !!started, listedAfterMs: listed ? Date.now() - tStart : null, item: listed && { id: listed.id, title: listed.title, publisher: listed.publisher, width: listed.width, height: listed.height, fps: listed.fps, baseUrl: listed.baseUrl },
      info: info && { running: info.running, mediaReady: info.mediaReady, audio: info.audio, codec: info.codec, bitrate: info.bitrate, scope: info.hls?.scope, hlsAudio: info.hls?.audio },
      relayPath: mtxPath && { ready: mtxPath.ready, source: mtxPath.source?.type, tracks: (mtxPath.tracks2 || []).map(t => t.codec) } });
  if (!listed) throw new Error('the app\'s broadcast never appeared in the Spring list');
  const id = listed.id, scope = `/${PATH}/b/${id}/`;

  // 2 React lists and plays it
  edge = start('edge', EDGE, ['--headless=new', `--remote-debugging-port=${PORT.edge}`, `--user-data-dir=${join(TMP, 'edge')}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-timer-throttling', '--window-size=1920,1080', 'about:blank'], { logDir: TMP });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT.edge}/json/version`)).ok, 30000);
  const target = (await (await fetch(`http://127.0.0.1:${PORT.edge}/json`)).json()).find(t => t.type === 'page');
  page = await connect(PORT.edge, t => t.id === target.id);
  const net = [];
  page.on(msg => {
    if (msg.method === 'Network.requestWillBeSent') { try { const u = new URL(msg.params.request.url); if (u.protocol.startsWith('http')) net.push({ t: Date.now(), method: msg.params.request.method, path: u.pathname, id: msg.params.requestId, status: null }); } catch {} }
    if (msg.method === 'Network.responseReceived') { const e = net.find(x => x.id === msg.params.requestId); if (e) e.status = msg.params.response.status; }
  });
  await page.send('Network.enable', { maxTotalBufferSize: 2000000, maxResourceBufferSize: 200000 });
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: WEB + '/_frame/live' });
  const href = `/_frame/watch/${PATH}/${id}`;
  const card = await waitFor(() => page.evaluate(`!!document.querySelector('a[href="${href}"]')`), 20000, 200);
  await sleep(500);
  writeFileSync(join(OUT, 'app-list.png'), await page.screenshot());
  const tOpen = Date.now();
  if (card) await page.evaluate(`document.querySelector('a[href="${href}"]').click()`);
  const opened = await waitFor(async () => (await page.evaluate('location.pathname')) === href, 10000, 100);
  const read = () => page.evaluate(`(() => { const v = document.querySelector('[data-testid="watch-video"]'); const rt = window.FrameRuntime; const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    return v ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, frames: q ? q.totalVideoFrames : null, transport: rt && rt.transport, broadcastId: rt && rt.watch && rt.watch.broadcastId, latency: rt && rt.playback && rt.playback.latency } : null; })()`);
  const first = await waitFor(async () => { const s = await read(); return s && s.w > 0 && s.t > 0 ? s : null; }, 30000, 200);
  const firstFrameMs = first ? Date.now() - tOpen : null;
  const a = await read(); await sleep(4000); const b = await read();
  const playing = !!(a && b && b.t - a.t > 2 && (b.frames === null || b.frames > a.frames));
  writeFileSync(join(OUT, 'app-playing.png'), await page.screenshot());
  const mine = net.filter(e => e.t >= tOpen && e.path.startsWith(`/${PATH}/`));
  const media = mine.filter(e => /\/(live\.m3u8|hls\/)/.test(e.path)), outside = mine.filter(e => !/\/(info|chat|stats)$/.test(e.path) && !e.path.startsWith(scope));
  const session = mine.find(e => e.method === 'POST' && e.path === scope + 'session');
  // The playlists as the browser gets them through the front: no Content-Disposition, no charset added, the cache values.
  const head = async url => { const r = await fetch(url); await r.arrayBuffer(); return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), disposition: r.headers.get('content-disposition') }; };
  const masterHeaders = await head(`${WEB}${scope}live.m3u8`), mediaHeaders = await head(`${WEB}${scope}hls/video1_stream.m3u8`);
  const plainPlaylists = [masterHeaders, mediaHeaders].every(h => h.status === 200 && !h.disposition && /mpegurl/i.test(h.type || '') && !/charset/i.test(h.type || ''))
    && masterHeaders.cache === 'max-age=2' && mediaHeaders.cache === 'max-age=1';
  check('2 play: /_frame/live shows the app\'s card, the watch page plays its video through Spring (hls.js, frames advance, media and session under /<path>/b/<id>/)',
    !!card && !!opened && playing && b?.transport === 'hls.js' && b?.broadcastId === id && media.length > 0 && outside.length === 0 && session?.status === 200 && plainPlaylists,
    { cardShown: !!card, opened: !!opened, firstFrameMs, size: b && `${b.w}x${b.h}`, advancedS: a && b ? +(b.t - a.t).toFixed(2) : null, frames: a && b && b.frames !== null ? b.frames - a.frames : null,
      transport: b?.transport, latencyS: b?.latency, mediaRequests: media.length, mediaStatuses: [...new Set(media.map(e => e.status))], outsideScope: outside.slice(0, 5).map(e => e.path), session: session && `${session.method} ${session.status}`,
      playlistHeaders: { master: masterHeaders, media: mediaHeaders } });

  // 3 stopping in the app withdraws the broadcast
  const tStop = Date.now();
  await ui.evaluate(`document.getElementById('tab-sender').click()`);
  await ui.evaluate(`document.getElementById('start-button').click()`); await sleep(400);
  await ui.evaluate(`document.getElementById('confirm-stop').click()`);
  const gone = await waitFor(async () => { const l = (await getJson(SPRING + '/api/broadcasts')).body?.items; return l && !l.some(i => i.id === id) ? true : null; }, 20000, 250);
  const after = (await getJson(`${SPRING}/${PATH}/info`)).body;
  check('3 stop: stopping the broadcast in the app withdraws it from Spring (bye): list empty, /info running:false',
    !!gone && after?.running === false, { goneAfterMs: gone ? Date.now() - tStop : null, info: after });
  ui.close();
} catch (error) {
  check('run', false, { error: mask(String(error?.stack || error)).split('\n').slice(0, 4).join(' | ') });
} finally {
  try { page?.close(); } catch {}
  if (appPid && alive(appPid)) {
    // Closing the window stops a running broadcast and the app's own MediaMTX and FFmpeg; a forced tree kill only if it hangs.
    try { execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${appPid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow(); $null = $p.WaitForExit(15000) }`]); } catch {}
    if (alive(appPid)) { try { execFileSync('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' }); } catch {} result.notes.push('the app did not close in 15 s: killed by PID'); }
  }
  restoreConfig();  // first, right after the app has closed: nothing below may keep the test settings in place
  await stopAll();
  let left = [];
  try { left = killByCommandLine(TMP); } catch {}
  if (left.length) result.notes.push('stopped leftover processes of this run: ' + left.join(','));
  result.configRestored = readFileSync(CONFIG).equals(backup.config) && (backup.secrets ? readFileSync(SECRETS).equals(backup.secrets) : !existsSync(SECRETS));
  result.finishedAt = new Date().toISOString(); result.durationS = Math.round((Date.now() - t0) / 1000);
  result.passed = list.filter(c => c.ok).length; result.failed = list.filter(c => !c.ok).length;
  try {
    for (const name of ['spring', 'mediamtx', 'web-proxy', 'app']) if (existsSync(join(TMP, name + '.log'))) writeFileSync(join(OUT, 'logs', `app-check-${name}.log`), scrub(mask(readFileSync(join(TMP, name + '.log'), 'utf8')), ROOT).split('\n').slice(-300).join('\n'));
  } catch {}
  writeFileSync(join(OUT, 'app-check-result.json'), scrub(mask(JSON.stringify(result, null, 2)), ROOT));
  console.log(`\n${result.passed} passed, ${result.failed} failed in ${result.durationS} s; app config restored: ${result.configRestored} -> verification/spring/app-check-result.json`);
  for (const c of list.filter(x => !x.ok)) console.log('  FAIL ' + c.name);
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.exit(result.failed ? 1 : 0);
