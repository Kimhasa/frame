// Uses the private verification DB and a unique Redis namespace. No OBS publishing, reboot or production accounts.
// Build apps/api and apps/web first, then run: node server/verify/channel-profile-e2e.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'verification/product');
const directory = join(tmpdir(), 'frame-channel-profile-e2e-' + Date.now());
const api = 'http://127.0.0.1:18083', origin = 'http://127.0.0.1:5365';
const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:\d+\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate verification database is required.');
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
const jar = join(directory, 'frame-api.jar');
copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar);
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = {
  ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: '18083', RELAY_OBS_ENABLED: 'false', RELAY_DVR: 'false',
  RELAY_MEDIAMTX_API: 'http://127.0.0.1:29997', RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:29888', RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '',
  FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername,
  FRAME_PRODUCT_DB_PASSWORD: config.dbPassword, FRAME_PRODUCT_REDIS_HOST: config.redisHost,
  FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: 'frame:product:channel-e2e:' + randomBytes(6).toString('hex') + ':sessions',
  FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
const results = [];
let apiProcess, complete = false;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function startApi(name) {
  const child = start(name, join(process.env.JAVA_HOME, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory });
  for (let attempt = 0; attempt < 180; attempt++) {
    if (!child.running) throw Error('Isolated API exited. See its private local verification log.');
    // MediaMTX is deliberately absent: product/Redis readiness is independent of the media health status.
    if ((await fetch(api + '/api/v1/policies').catch(() => null))?.ok && (await fetch(api + '/api/v1/session').catch(() => null))?.ok) return child;
    await sleep(250);
  }
  throw Error('Isolated API did not become ready.');
}

try {
  for (const port of [18083, 5365, 5366, 9496, 9497]) if (!await portFree(port)) throw Error('Verification port is already in use: ' + port);
  apiProcess = await startApi('spring');
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (!web.running) throw Error('Verification web exited.');
    if ((await fetch(origin + '/_frame/').catch(() => null))?.ok) { ready = true; break; }
    await sleep(100);
  }
  if (!ready) throw Error('Verification web did not become ready.');
  const ui = start('channel-profile-ui', process.execPath, [join(root, 'server/verify/channel-profile-ui.mjs')],
    { cwd: root, env: { FRAME_PROFILE_TEST_DIR: directory }, logDir: directory });
  const uiCode = await ui.exited;
  const uiReport = join(output, 'channel-profile-ui-result.json');
  const report = existsSync(uiReport) ? JSON.parse(readFileSync(uiReport, 'utf8')) : null;
  check(uiCode === 0 && report?.results?.length > 0 && report.results.every(item => item.pass), 'Profile editor, channel details, sharing and reporting pass browser verification');

  const checkpointFile = join(directory, 'channel-profile-checkpoint.json');
  if (!existsSync(checkpointFile)) throw Error('The private restart checkpoint is missing.');
  const checkpoint = JSON.parse(readFileSync(checkpointFile, 'utf8'));
  const dev = start('web-dev', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5366', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  let devReady = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (!dev.running) throw Error('Verification development web exited.');
    if ((await fetch('http://127.0.0.1:5366/_frame/').catch(() => null))?.ok) { devReady = true; break; }
    await sleep(100);
  }
  if (!devReady) throw Error('Verification development web did not become ready.');
  const devUi = start('channel-profile-dev-ui', process.execPath, [join(root, 'server/verify/channel-profile-dev-ui.mjs')],
    { cwd: root, env: { FRAME_CHANNEL_TEST_HANDLE: checkpoint.target.handle }, logDir: directory });
  const devUiCode = await devUi.exited;
  const devReportFile = join(output, 'channel-profile-dev-result.json');
  const devReport = existsSync(devReportFile) ? JSON.parse(readFileSync(devReportFile, 'utf8')) : null;
  check(devUiCode === 0 && devReport?.results?.length > 0 && devReport.results.every(item => item.pass), 'Development StrictMode, clipboard denial and cancelled Web Share recover correctly');
  await stop(dev);
  await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  const cookies = checkpoint.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const sessionResponse = await fetch(api + '/api/v1/session', { headers: { Cookie: cookies } });
  const session = await sessionResponse.json();
  check(sessionResponse.status === 200 && Boolean(session.user), 'Redis login survives the API restart');
  const response = await fetch(api + '/api/v1/channel-ids/' + checkpoint.target.id);
  const channel = await response.json();
  check(response.status === 200 && channel.id === checkpoint.target.id && channel.handle === checkpoint.target.handle
    && channel.description === checkpoint.target.description && channel.countryCode === checkpoint.target.countryCode
    && channel.createdAtMs === checkpoint.target.createdAtMs && JSON.stringify(channel.links) === JSON.stringify(checkpoint.target.links), 'Stored channel profile and stable ID survive the API restart');
  const oldHandle = checkpoint.target.originalHandle ?? checkpoint.oldHandle;
  if (oldHandle) {
    const old = await (await fetch(api + '/api/v1/channels/' + oldHandle)).json();
    check(old.id === channel.id && old.handle === channel.handle, 'The previous handle still resolves to the same channel after restart');
  }
  const duplicate = await fetch(api + '/api/v1/channels/' + channel.id + '/reports', { method: 'POST',
    headers: { Cookie: cookies, Origin: origin, 'X-CSRF-TOKEN': session.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(checkpoint.report) });
  const duplicateBody = await duplicate.json();
  check(duplicate.status === 409 && duplicateBody.code === 'REPORT_ALREADY_RECEIVED', 'Received reports persist and duplicate submissions remain blocked after restart');
  complete = true;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  writeFileSync(join(output, 'channel-profile-e2e-result.json'), JSON.stringify({ verificationDatabaseOnly: true, productionUserDataUntouched: true,
    mediaReceiverUntouched: true, rebootRequired: false, complete, results,
    limits: ['Single PC, loopback and headless Edge', 'No native mobile browser or Caddy HTTPS verification', 'Clipboard and Web Share payloads are checked with browser spies; no external messages are sent', 'No global video/view counters or operator report review UI'] }, null, 2));
  await stopAll(); console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length }));
}
