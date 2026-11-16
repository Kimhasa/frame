// Isolated browser-source verification. Main application processes and user data are never selected or stopped.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree } from './harness.mjs';
import { api, origin } from './chat-moderation-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, 'verification/product');
const run = randomBytes(6).toString('hex'), directory = join(tmpdir(), 'frame-chat-overlay-e2e-' + run), streamPath = `obs-chat-${run}`;
const token = randomBytes(32).toString('hex'), bin = join(root, 'dist/FrameConsole/bin');
const configFile = process.env.FRAME_PRODUCT_TEST_CONFIG ?? join(process.env.LOCALAPPDATA, 'Frame/product-docker/config.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate local verification database is required.');
const javaHome = process.env.JAVA_HOME ?? join(process.env.LOCALAPPDATA, 'FrameTools/jdk-21.0.13+9');
if (!existsSync(join(javaHome, 'bin/java.exe'))) throw Error('The verification JDK is unavailable.');
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
const jar = join(directory, 'frame-api.jar'); copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar);
const jarHash = createHash('sha256').update(readFileSync(jar)).digest('hex');
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = {
  ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: '18083', RELAY_OBS_ENABLED: 'true', RELAY_OBS_SERVER_URL: 'rtmp://127.0.0.1:2935', RELAY_DVR: 'false',
  RELAY_PUBLISHER_TOKENS: `${token} ${streamPath}`, RELAY_MEDIA_GRACE_MS: '5000', RELAY_PUBLIC_BASE_URL: api,
  RELAY_MEDIAMTX_API: 'http://127.0.0.1:29997', RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:29888', RELAY_MEDIAMTX_RTSP: 'rtsp://127.0.0.1:29554',
  RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '', RELAY_RECORD_DIR: '', RELAY_FFMPEG: join(bin, 'ffmpeg.exe'),
  FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername, FRAME_PRODUCT_DB_PASSWORD: config.dbPassword,
  FRAME_PRODUCT_REDIS_HOST: config.redisHost, FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:chat-overlay-e2e:${run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
const ports = [18083, 5365, 5366, 2935, 29554, 29997, 29888, 29996, 9550, 9551], results = [];
let publisher, complete = false, mediaStarts = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function ready(url, process) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (!process.running) throw Error('A verification process exited; its private log remains outside the repository.');
    if ((await fetch(url).catch(() => null))?.ok) return;
    await sleep(150);
  }
  throw Error('A verification service did not become ready.');
}
function publish() {
  if (publisher?.running) throw Error('Only one dedicated media source may run.');
  mediaStarts++;
  publisher = start('publisher-' + mediaStarts, join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-bf', '0', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-f', 'flv', '-flvflags', 'no_duration_filesize',
    `rtmp://127.0.0.1:2935/${streamPath}`], { logDir: directory });
}
async function browser(mode) {
  const ui = start('chat-overlay-ui-' + mode, process.execPath, [join(root, 'server/verify/chat-overlay-ui.mjs'), mode], { cwd: root, env: {
    FRAME_CHAT_OVERLAY_TEST_DIR: directory, FRAME_CHAT_OVERLAY_STREAM_KEY: `${streamPath}?user=${streamPath}&pass=${token}`,
  }, logDir: directory });
  const handled = new Set(), deadline = Date.now() + 240000;
  while (ui.running) {
    if (Date.now() > deadline) throw Error('Overlay browser verification timed out.');
    for (const command of mode === 'production' ? ['start-live', 'end-live', 'restart-live'] : []) {
      if (handled.has(command) || !existsSync(join(directory, command + '.json'))) continue;
      handled.add(command);
      if (command === 'end-live') await stop(publisher); else publish();
      writeFileSync(join(directory, command + '-done.json'), '{}');
    }
    await sleep(100);
  }
  const reportFile = join(output, 'chat-overlay-' + mode + '-result.json');
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  check(await ui.exited === 0 && report?.complete && report.results.length > 0 && report.results.every(item => item.pass), mode === 'dev'
    ? 'Development StrictMode overlay and management checks pass' : 'Production management and anonymous live overlay checks pass');
}
try {
  for (const port of ports) if (!await portFree(port)) throw Error('A dedicated verification port is occupied: ' + port);
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
  const spring = start('spring', join(javaHome, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory });
  await ready(api + '/api/v1/session', spring);
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready(origin + '/_frame/', web); await browser('production');
  check(mediaStarts === 2 && publisher?.running, 'One tiny media source ends and restarts as a distinct broadcast on the same path');
  // Product chat pins its exact Origin. Reuse the owned preview's port for dev instead of weakening Origin validation.
  await stop(web);
  const dev = start('web-dev', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready(origin + '/_frame/', dev); await browser('dev');
  check(createHash('sha256').update(readFileSync(jar)).digest('hex') === jarHash, 'The existing backend JAR remains immutable throughout verification');
  complete = true;
} catch (failure) { console.error(failure.message); process.exitCode = 1; }
finally {
  await stopAll();
  const cleanup = [];
  for (const port of ports) cleanup.push({ port, free: await portFree(port) });
  if (cleanup.some(item => !item.free)) { complete = false; process.exitCode = 1; }
  writeFileSync(join(output, 'chat-overlay-e2e-result.json'), JSON.stringify({ complete, verificationDatabaseOnly: true, productionUserDataUntouched: true,
    nativeObsReceiverUntouched: true, testedJarSha256: jarHash, results, ports: cleanup,
    fixture: 'Dedicated MediaMTX + one 320x180 15fps H.264/AAC FFmpeg source + immutable Spring JAR + React production and StrictMode development + headless Edge',
    limits: ['OBS CEF rendering was not exercised', 'Single PC and loopback only', 'No physical mobile device or load/capacity coverage'] }, null, 2));
  console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length, portsFree: cleanup.every(item => item.free) }));
}
