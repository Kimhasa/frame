// Isolated real RTMP source + durable notifications + production web. Never uses the native OBS receiver/user DB.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'verification/product'), directory = join(tmpdir(), 'frame-notifications-e2e-' + Date.now());
const api = 'http://127.0.0.1:18083', origin = 'http://127.0.0.1:5365';
const token = randomBytes(32).toString('hex'), run = randomBytes(6).toString('hex'), bin = join(root, 'dist/FrameConsole/bin');
const path = `obs-notification-${run}`;
const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:\d+\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate verification database is required.');
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
const jar = join(directory, 'frame-api.jar'); copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar);
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = {
  ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: '18083', RELAY_OBS_ENABLED: 'true', RELAY_OBS_SERVER_URL: 'rtmp://127.0.0.1:2935', RELAY_DVR: 'false',
  RELAY_PUBLISHER_TOKENS: `${token} ${path}`, RELAY_MEDIA_GRACE_MS: '5000', RELAY_PUBLIC_BASE_URL: api,
  RELAY_MEDIAMTX_API: 'http://127.0.0.1:29997', RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:29888', RELAY_MEDIAMTX_RTSP: 'rtsp://127.0.0.1:29554',
  RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '', RELAY_RECORD_DIR: '', RELAY_FFMPEG: join(bin, 'ffmpeg.exe'),
  FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername,
  FRAME_PRODUCT_DB_PASSWORD: config.dbPassword, FRAME_PRODUCT_REDIS_HOST: config.redisHost,
  FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:notifications-e2e:${run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
const results = [];
let apiProcess, publisher, complete = false;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function ready(url, child, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (!child.running) throw Error('Verification process exited. See its private local log.');
    if ((await fetch(url).catch(() => null))?.ok) return;
    await sleep(150);
  }
  throw Error('Verification process did not become ready.');
}
async function startApi(name) {
  const child = start(name, join(process.env.JAVA_HOME, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory });
  await ready(api + '/api/v1/session', child); return child;
}
function marker(name, value) { writeFileSync(join(directory, name + '.json'), JSON.stringify(value)); }
const hasMarker = name => existsSync(join(directory, name + '.json'));
try {
  for (const port of [18083, 5365, 5366, 2935, 29554, 29997, 29888, 9500, 9501]) if (!await portFree(port)) throw Error('Verification port is already in use: ' + port);
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
  await ready('http://127.0.0.1:29997/v3/paths/list', media);
  apiProcess = await startApi('spring');
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready(origin + '/_frame/', web);
  const ui = start('notifications-ui', process.execPath, [join(root, 'server/verify/notifications-ui.mjs')], { cwd: root, env: {
    FRAME_NOTIFICATION_TEST_DIR: directory, FRAME_NOTIFICATION_FIXTURE_STREAM_KEY: `${path}?user=${path}&pass=${token}`,
  }, logDir: directory });
  let startedLive = false, restartedLive = false, stoppedLive = false;
  const deadline = Date.now() + 240000;
  while (ui.running) {
    if (Date.now() > deadline) throw Error('Notifications browser verification timed out.');
    if (!startedLive && hasMarker('ready-live')) {
      startedLive = true;
      publisher = start('publisher', join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-bf', '0', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-f', 'flv', '-flvflags', 'no_duration_filesize', `rtmp://127.0.0.1:2935/${path}`], { logDir: directory });
      console.log('Started the isolated RTMP fixture after channel connection and notification opt-in.');
    }
    if (!restartedLive && hasMarker('restart-live-api')) {
      restartedLive = true; await stop(apiProcess); apiProcess = await startApi('spring-live-restarted');
      marker('restarted-live-api', { ready: true, samePublisherProcess: Boolean(publisher?.running) });
    }
    if (!stoppedLive && hasMarker('stop-live')) { stoppedLive = true; await stop(publisher); marker('stopped-live', { stopped: true }); }
    await sleep(100);
  }
  const code = await ui.exited, reportFile = join(output, 'notifications-ui-result.json');
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  check(code === 0 && report?.results?.length > 0 && report.results.every(item => item.pass), 'Notification inbox and real source-session delivery pass browser verification');
  check(startedLive && restartedLive && stoppedLive, 'Real RTMP start, API restart with the same publisher and source cleanup complete');
  const checkpoint = JSON.parse(readFileSync(join(directory, 'notifications-checkpoint.json'), 'utf8'));
  const headers = { Cookie: checkpoint.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'X-FRAME-USER-ID': checkpoint.userId };
  const dev = start('web-dev', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5366', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready('http://127.0.0.1:5366/_frame/', dev);
  const devUi = start('notifications-dev-ui', process.execPath, [join(root, 'server/verify/notifications-dev-ui.mjs')],
    { cwd: root, env: { FRAME_NOTIFICATION_TEST_DIR: directory }, logDir: directory });
  const devCode = await devUi.exited, devFile = join(output, 'notifications-dev-result.json');
  const devReport = existsSync(devFile) ? JSON.parse(readFileSync(devFile, 'utf8')) : null;
  check(devCode === 0 && devReport?.results?.length > 0 && devReport.results.every(item => item.pass), 'Read-only development StrictMode and mobile notification dialogs pass');
  await stop(dev);
  await stop(apiProcess); apiProcess = await startApi('spring-final-restarted');
  const sessionResponse = await fetch(api + '/api/v1/session', { headers }), session = await sessionResponse.json();
  check(sessionResponse.status === 200 && session.user?.id === checkpoint.userId, 'Recipient authentication survives API restart');
  const response = await fetch(api + '/api/v1/me/notifications', { headers }), list = await response.json();
  const saved = list.items?.find(item => item.id === checkpoint.notificationId);
  check(response.status === 200 && list.userId === checkpoint.userId && saved && saved.readAtMs !== null && saved.kind === 'report' && list.unreadCount === 0 && list.items.length === 1,
    'New result notification, stored read state and prior deletions persist after restart');
  complete = true;
} catch (failure) { console.error(failure.message); process.exitCode = 1; }
finally {
  writeFileSync(join(output, 'notifications-e2e-result.json'), JSON.stringify({ verificationDatabaseOnly: true, productionUserDataUntouched: true, nativeObsReceiverUntouched: true,
    complete, results, fixture: 'Dedicated MediaMTX + 320x180 15fps H.264/AAC FFmpeg RTMP source + Spring + production React + headless Edge',
    limits: ['Single PC and loopback only', 'No browser/OS push, email, external messaging or Caddy HTTPS/WSS', 'No mobile physical device or capacity verification'] }, null, 2));
  await stopAll(); console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length }));
}
