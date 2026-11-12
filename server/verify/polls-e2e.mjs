// Isolated poll verification: one immutable JAR, one tiny media source and sequential browser checks.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree, killByCommandLine } from './harness.mjs';
import { api, origin, liveBroadcast } from './polls-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, 'verification/product');
const run = randomBytes(6).toString('hex'), directory = join(tmpdir(), 'frame-polls-e2e-' + run), path = `obs-poll-${run}`;
const token = randomBytes(32).toString('hex'), bin = join(root, 'dist/FrameConsole/bin');
const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate native local verification database is required.');
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
const jar = join(directory, 'frame-api.jar'); copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar);
const jarHash = createHash('sha256').update(readFileSync(jar)).digest('hex');
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = {
  ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: '18083', RELAY_OBS_ENABLED: 'true', RELAY_OBS_SERVER_URL: 'rtmp://127.0.0.1:2935', RELAY_DVR: 'false',
  RELAY_PUBLISHER_TOKENS: `${token} ${path}`, RELAY_MEDIA_GRACE_MS: '5000', RELAY_PUBLIC_BASE_URL: api,
  RELAY_MEDIAMTX_API: 'http://127.0.0.1:29997', RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:29888', RELAY_MEDIAMTX_RTSP: 'rtsp://127.0.0.1:29554',
  RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '', RELAY_RECORD_DIR: '', RELAY_FFMPEG: join(bin, 'ffmpeg.exe'),
  FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername, FRAME_PRODUCT_DB_PASSWORD: config.dbPassword,
  FRAME_PRODUCT_REDIS_HOST: config.redisHost, FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:polls-e2e:${run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
const results = []; let apiProcess, publisher, complete = false;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function ready(url, child) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (!child.running) throw Error('Verification process exited; its log stays in the private fixture directory.');
    if ((await fetch(url).catch(() => null))?.ok) return;
    await sleep(150);
  }
  throw Error('Verification process did not become ready.');
}
async function startApi(name) {
  const child = start(name, join(process.env.JAVA_HOME, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory });
  await ready(api + '/api/v1/session', child); return child;
}
function startPublisher(name) {
  return start(name, join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-bf', '0', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-f', 'flv', '-flvflags', 'no_duration_filesize', `rtmp://127.0.0.1:2935/${path}`], { logDir: directory });
}
async function waitBroadcastEnd(id) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(api + '/api/obs/' + encodeURIComponent(path), { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('The owned OBS fixture status returned HTTP ' + response.status);
    const status = await response.json();
    // The public directory hides an unready source during its reconnect grace period; that is not registry closure.
    if (status.broadcastId === null) return;
    if (status.broadcastId !== id) throw Error('The owned OBS fixture changed broadcast identity before replacement.');
    await sleep(200);
  }
  throw Error('The owned stopped source did not end before replacement.');
}
function cleanupOwnedBrowser(markerName, prefix) {
  const markerPath = join(directory, markerName); if (!existsSync(markerPath)) return;
  const owner = JSON.parse(readFileSync(markerPath, 'utf8')), profile = typeof owner.profile === 'string' ? resolve(owner.profile) : '';
  if (!profile || !isAbsolute(owner.profile) || basename(profile) !== 'profile' || !basename(dirname(profile)).startsWith(prefix)
    || dirname(dirname(profile)).toLowerCase() !== resolve(tmpdir()).toLowerCase()) throw Error('Refusing cleanup outside the exact private browser profile scope.');
  killByCommandLine(profile);
}
try {
  for (const port of [18083, 5365, 5366, 2935, 29554, 29997, 29888, 9520, 9521]) if (!await portFree(port)) throw Error('Verification port is already occupied: ' + port);
  writeFileSync(join(directory, 'mediamtx.yml'), `logLevel: warn
logDestinations: [stdout]
authMethod: internal
authInternalUsers:
  - user: any
    ips: ['127.0.0.1', '::1']
    permissions:
      - action: read
      - action: api
      - action: publish
api: true
apiAddress: 127.0.0.1:29997
rtsp: true
rtspTransports: [tcp]
rtspEncryption: "no"
rtspAddress: 127.0.0.1:29554
rtmp: true
rtmpAddress: 127.0.0.1:2935
webrtc: false
srt: false
moq: false
hls: true
hlsAddress: 127.0.0.1:29888
hlsVariant: lowLatency
hlsSegmentDuration: 1s
hlsPartDuration: 200ms
pathDefaults:
  source: publisher
  record: false
paths:
  all_others:
`);
  const media = start('mediamtx', join(bin, 'mediamtx.exe'), [join(directory, 'mediamtx.yml')], { cwd: directory, logDir: directory });
  await ready('http://127.0.0.1:29997/v3/paths/list', media); apiProcess = await startApi('spring');
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready(origin + '/_frame/', web);
  const ui = start('polls-ui', process.execPath, [join(root, 'server/verify/polls-ui.mjs')], { cwd: root, env: {
    FRAME_POLLS_TEST_DIR: directory, FRAME_POLLS_FIXTURE_STREAM_KEY: `${path}?user=${path}&pass=${token}`,
  }, logDir: directory });
  let startedLive = false, replacedLive = false; const deadline = Date.now() + 300000;
  while (ui.running) {
    if (Date.now() > deadline) throw Error('Poll browser verification timed out.');
    if (!startedLive && existsSync(join(directory, 'ready-live.json'))) {
      startedLive = true;
      publisher = startPublisher('publisher-first');
    }
    if (!replacedLive && existsSync(join(directory, 'replace-live.json'))) {
      const replacement = JSON.parse(readFileSync(join(directory, 'replace-live.json'), 'utf8'));
      if (!/^[0-9a-f]{32}$/.test(replacement.previousBroadcastId ?? '')) throw Error('Invalid private source replacement request.');
      replacedLive = true; await stop(publisher); await waitBroadcastEnd(replacement.previousBroadcastId);
      publisher = startPublisher('publisher-replaced'); const current = await liveBroadcast(path, replacement.previousBroadcastId);
      writeFileSync(join(directory, 'replaced-live.json'), JSON.stringify({ broadcastId: current.id }));
    }
    await sleep(100);
  }
  const code = await ui.exited, reportPath = join(output, 'polls-ui-result.json');
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  check(code === 0 && report?.results?.length > 0 && report.results.every(item => item.pass), 'Real poll voting and management UI verification pass');
  check(startedLive && replacedLive && publisher?.running, 'One low-resolution source is replaced sequentially to verify old broadcast protection');
  const dev = start('web-dev', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5366', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready('http://127.0.0.1:5366/_frame/', dev);
  const devUi = start('polls-dev-ui', process.execPath, [join(root, 'server/verify/polls-dev-ui.mjs')], { cwd: root, env: { FRAME_POLLS_TEST_DIR: directory }, logDir: directory });
  const devCode = await devUi.exited, devPath = join(output, 'polls-dev-result.json'), devReport = existsSync(devPath) ? JSON.parse(readFileSync(devPath, 'utf8')) : null;
  check(devCode === 0 && devReport?.results?.length > 0 && devReport.results.every(item => item.pass), 'Read-only development StrictMode management UI verification passes');
  await stop(dev);
  await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  const verification = start('polls-restart', process.execPath, [join(root, 'server/verify/polls-restart.mjs')], { cwd: root, env: { FRAME_POLLS_TEST_DIR: directory }, logDir: directory });
  check(await verification.exited === 0, 'Poll results, choices and broadcast closure persist after restart');
  check(createHash('sha256').update(readFileSync(jar)).digest('hex') === jarHash, 'The tested private JAR stays immutable throughout verification');
  complete = true;
} catch (failure) { console.error(failure.message); process.exitCode = 1; }
finally {
  await stopAll();
  try { cleanupOwnedBrowser('browser-owner.json', 'frame-polls-ui-'); cleanupOwnedBrowser('browser-dev-owner.json', 'frame-polls-dev-ui-'); }
  catch (failure) { complete = false; process.exitCode = 1; console.error(failure.message); }
  writeFileSync(join(output, 'polls-e2e-result.json'), JSON.stringify({ verificationDatabaseOnly: true, productionUserDataUntouched: true, nativeObsReceiverUntouched: true,
    complete, testedJarSha256: jarHash, results, fixture: 'Dedicated MediaMTX + 320x180 15fps H.264/AAC FFmpeg source + immutable Spring JAR + production React + headless Edge',
    limits: ['Single PC and loopback only', 'No Caddy HTTPS/WSS or physical mobile device coverage', 'No load or capacity claim'] }, null, 2));
  console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length }));
}
