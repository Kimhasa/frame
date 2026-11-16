// Isolated analytics observation: real tiny source, scoped HLS session and immutable application JAR.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree, killByCommandLine } from './harness.mjs';
import { Client, api, origin, liveBroadcast } from './missions-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, 'verification/product');
const run = randomBytes(6).toString('hex'), directory = join(tmpdir(), 'frame-analytics-e2e-' + run), path = `obs-analytics-${run}`;
const token = randomBytes(32).toString('hex'), password = randomBytes(20).toString('base64url'), bin = join(root, 'dist/FrameConsole/bin');
const configFile = resolve(process.env.FRAME_PRODUCT_TEST_CONFIG || join(process.env.LOCALAPPDATA, 'Frame/product-docker/config.json'));
if (configFile.toLowerCase().startsWith(root.toLowerCase() + '\\')) throw Error('Private verification configuration must remain outside the repository.');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate local verification database is required.');
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
  FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:analytics-e2e:${run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
const results = [], observations = []; let apiProcess, publisher, heartbeat, complete = false;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(fn, label, ms = 45000) { for (const deadline = Date.now() + ms; Date.now() < deadline;) { const value = await fn(); if (value) return value; await sleep(250); } throw Error('Timeout: ' + label); }
async function ready(url, child) { await until(async () => { if (!child.running) throw Error('Verification process exited; its log remains private.'); return (await fetch(url).catch(() => null))?.ok; }, 'Verification process ready'); }
async function exitCode(child, ms) { await until(() => !child.running, 'Bounded browser verification completion', ms); return child.exited; }
async function startApi(name) { const child = start(name, join(process.env.JAVA_HOME, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory }); await ready(api + '/api/v1/session', child); return child; }
function startPublisher(name) {
  return start(name, join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-bf', '0', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-f', 'flv', '-flvflags', 'no_duration_filesize', `rtmp://127.0.0.1:2935/${path}`], { logDir: directory });
}
async function account(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const response = await client.request('POST', '/auth/register', { email: `analytics_${kind}_${run}@example.invalid`, password, displayName: `방송 분석 ${kind}`, ...consent });
  if (response.status !== 201) throw Error('Dedicated analytics account registration failed.'); return { client, user: response.data.user };
}
const query = '/me/analytics?period=7';
async function rows(client, extra = '') { const response = await client.request('GET', query + extra); if (response.status !== 200) throw Error('Analytics GET returned HTTP ' + response.status); return response.data; }
function cleanupBrowser(name, prefix) {
  const marker = join(directory, name); if (!existsSync(marker)) return;
  const saved = JSON.parse(readFileSync(marker, 'utf8')), profile = typeof saved.profile === 'string' ? resolve(saved.profile) : '';
  if (!profile || !isAbsolute(saved.profile) || basename(profile) !== 'profile' || !basename(dirname(profile)).startsWith(prefix)
    || dirname(dirname(profile)).toLowerCase() !== resolve(tmpdir()).toLowerCase()) throw Error('Browser cleanup scope is invalid.');
  killByCommandLine(profile);
}
try {
  for (const port of [18083, 5365, 5366, 2935, 29554, 29997, 29888, 9550, 9551]) if (!await portFree(port)) throw Error('Verification port occupied: ' + port);
  writeFileSync(join(directory, 'mediamtx.yml'), `logLevel: warn\nlogDestinations: [stdout]\nauthMethod: internal\nauthInternalUsers:\n  - user: any\n    ips: ['127.0.0.1', '::1']\n    permissions:\n      - action: read\n      - action: api\n      - action: publish\napi: true\napiAddress: 127.0.0.1:29997\nrtsp: true\nrtspTransports: [tcp]\nrtspEncryption: "no"\nrtspAddress: 127.0.0.1:29554\nrtmp: true\nrtmpAddress: 127.0.0.1:2935\nwebrtc: false\nsrt: false\nmoq: false\nhls: true\nhlsAddress: 127.0.0.1:29888\nhlsVariant: lowLatency\nhlsSegmentDuration: 1s\nhlsPartDuration: 200ms\npathDefaults:\n  source: publisher\n  record: false\npaths:\n  all_others:\n`);
  const media = start('mediamtx', join(bin, 'mediamtx.exe'), [join(directory, 'mediamtx.yml')], { cwd: directory, logDir: directory });
  await ready('http://127.0.0.1:29997/v3/paths/list', media); apiProcess = await startApi('spring');
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'], { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready(origin + '/_frame/', web);
  const anonymous = new Client(), policy = await anonymous.request('GET', '/policies');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policy.data.terms.version, privacyVersion: policy.data.privacy.version };
  const owner = await account('owner', consent), other = await account('other', consent);
  // Retain only this run's dedicated account cookies privately so an interrupted verification can be diagnosed.
  writeFileSync(join(directory, 'analytics-checkpoint.json'), JSON.stringify({ owner: owner.client.saved(), other: other.client.saved(), path }));
  const anon = await anonymous.request('GET', query), empty = await rows(owner.client);
  check(anon.status === 401 && empty.items.length === 0 && empty.summary.broadcastCount === 0, 'Anonymous analytics are denied and a fresh owning account has no fabricated broadcasts');
  const connection = await owner.client.request('POST', '/me/channel/connection', { streamKey: `${path}?user=${path}&pass=${token}` });
  check(connection.status === 200, 'Only the dedicated verification source is connected to its real product channel');
  const mismatched = await other.client.request('GET', query, undefined, { expectedUserId: owner.user.id });
  check(mismatched.status === 409 && mismatched.data.code === 'SESSION_CHANGED' && !mismatched.data.items, 'Expected owner identity rejects a shared-cookie account change without private metrics');
  const bad = await Promise.all(['period=8', 'period=7&from=2026-02-30', 'period=7&from=2000-01-01', 'period=7&cursor=invalid', 'period=7&limit=0'].map(value => owner.client.request('GET', '/me/analytics?' + value)));
  check(bad.every(response => response.status === 400), 'Unsupported periods, invalid/out-of-period dates, cursors and limits return 400');
  const title1 = `차근차근 만드는 작업실 ${run}`, title2 = `다음 화면을 완성해요 ${run}`;
  await owner.client.request('PUT', '/studio', { title: title1, publisher: '방송 분석 검증' }); publisher = startPublisher('publisher-first');
  const first = await liveBroadcast(path), sessionRoute = `/${path}/b/${first.id}/session`, userAgent = 'Frame-Analytics-Verification/' + run;
  const opened = await fetch(api + sessionRoute, { method: 'POST', headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(10000) });
  const session = await opened.json(); check(opened.ok && /^[0-9a-f]{32}$/.test(session.sid), 'A real scoped HLS viewing session is admitted on the tiny live source');
  heartbeat = setInterval(() => { void fetch(api + sessionRoute + '/' + session.sid, { method: 'PUT', headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(5000) }).catch(() => {}); }, 5000);
  const manifest = await fetch(api + `/${path}/b/${first.id}/live.m3u8`, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(15000) });
  check(manifest.ok && (await manifest.text()).startsWith('#EXTM3U'), 'The scoped live source serves an actual HLS manifest independently of analytics');
  const firstMeasured = await until(async () => { const data = await rows(owner.client), row = data.items.find(item => item.broadcastId === first.id); return row?.observedDurationMs >= 10000 && row.averageConcurrent > 0 && row.peakConcurrent >= 1 ? row : null; }, 'At least two real observation intervals');
  observations.push({ stage: 'first-live', observedDurationMs: firstMeasured.observedDurationMs, averageConcurrent: firstMeasured.averageConcurrent, peakConcurrent: firstMeasured.peakConcurrent });
  const firstResponse = await owner.client.request('GET', query), foreign = await rows(other.client);
  check(firstResponse.headers.get('cache-control')?.includes('no-store') && firstResponse.data.userId === owner.user.id && foreign.items.length === 0 && foreign.summary.broadcastCount === 0, 'Private measured aggregates are no-store and another real account sees no owning-channel rows');
  check(firstResponse.data.daily.length === 7 && firstResponse.data.summary.observedDurationMs >= firstMeasured.observedDurationMs && firstMeasured.broadcastDurationMs >= firstMeasured.observedDurationMs, 'Daily and summary metrics aggregate measured intervals rather than synthetic viewing history');
  clearInterval(heartbeat); heartbeat = null; await fetch(api + sessionRoute + '/' + session.sid, { method: 'DELETE', headers: { 'User-Agent': userAgent } });
  await stop(publisher); publisher = null;
  await until(async () => { const response = await fetch(api + '/api/obs/' + path, { headers: { Authorization: 'Bearer ' + token } }); return (await response.json()).broadcastId === null; }, 'Actual source registry closure');
  const ended = await until(async () => (await rows(owner.client)).items.find(item => item.id === firstMeasured.id && item.status === 'ended'), 'Persisted first source closure');
  await owner.client.request('PUT', '/studio', { title: title2, publisher: '방송 분석 검증' }); publisher = startPublisher('publisher-second');
  const second = await liveBroadcast(path, first.id);
  const secondMeasured = await until(async () => { const data = await rows(owner.client), row = data.items.find(item => item.broadcastId === second.id); return row?.observedDurationMs >= 5000 ? row : null; }, 'Second independently measured broadcast');
  const firstPage = await owner.client.request('GET', query + '&limit=1'), nextPage = await owner.client.request('GET', query + '&limit=1&cursor=' + encodeURIComponent(firstPage.data.nextCursor));
  check(firstPage.data.items.length === 1 && firstPage.data.nextCursor && nextPage.data.items.length === 1 && firstPage.data.items[0].id !== nextPage.data.items[0].id, 'Real opaque cursor pagination separates two broadcasts from the same source path');
  const scopeCursor = await owner.client.request('GET', query + '&limit=1&q=changed&cursor=' + encodeURIComponent(firstPage.data.nextCursor));
  check(scopeCursor.status === 400, 'A cursor cannot be reused with changed search filters');
  await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  check((await owner.client.request('GET', '/session')).data.user?.id === owner.user.id, 'The real Redis login session survives an API process restart');
  const restored = await until(async () => { const data = await rows(owner.client); return data.items.some(item => item.id === secondMeasured.id && item.status === 'interrupted') && data.items.length >= 3 ? data : null; }, 'Persistent previous instance and new live observation');
  const oldFirst = restored.items.find(item => item.id === ended.id), interrupted = restored.items.find(item => item.id === secondMeasured.id);
  check(JSON.stringify(oldFirst) === JSON.stringify(ended) && interrupted.observedDurationMs >= secondMeasured.observedDurationMs && interrupted.endedAtMs === interrupted.lastObservedAtMs && restored.items.filter(item => item.status === 'live').length === 1, 'Ended metrics remain immutable and API restart closes the old active observation at its last actual sample');
  observations.push({ stage: 'restart-interrupted', observedDurationMs: interrupted.observedDurationMs, averageConcurrent: interrupted.averageConcurrent, peakConcurrent: interrupted.peakConcurrent });
  writeFileSync(join(directory, 'analytics-checkpoint.json'), JSON.stringify({ owner: owner.client.saved(), other: other.client.saved(), titles: [title1, title2], firstRowId: ended.id, path }));
  const ui = start('analytics-ui', process.execPath, [join(root, 'server/verify/analytics-ui.mjs')], { cwd: root, env: { FRAME_ANALYTICS_TEST_DIR: directory }, logDir: directory });
  check(await exitCode(ui, 180000) === 0 && JSON.parse(readFileSync(join(output, 'analytics-ui-result.json'), 'utf8')).results.every(item => item.pass), 'Real production analytics UI, failure recovery, filters, pagination and mobile checks pass');
  const dev = start('web-dev', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5366', '--strictPort'], { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready('http://127.0.0.1:5366/_frame/', dev);
  const devUi = start('analytics-dev-ui', process.execPath, [join(root, 'server/verify/analytics-ui.mjs')], { cwd: root, env: { FRAME_ANALYTICS_TEST_DIR: directory, FRAME_ANALYTICS_DEV_SMOKE: '1' }, logDir: directory });
  check(await exitCode(devUi, 60000) === 0, 'The same actual owning-channel aggregates render in development StrictMode without mutation');
  check(createHash('sha256').update(readFileSync(jar)).digest('hex') === jarHash, 'The tested private JAR remains immutable throughout source replacement and restart'); complete = true;
} catch (failure) { console.error(failure.message); process.exitCode = 1; }
finally {
  clearInterval(heartbeat); await stopAll();
  try { cleanupBrowser('browser-owner.json', 'frame-analytics-ui-'); cleanupBrowser('browser-dev-owner.json', 'frame-analytics-dev-ui-'); } catch (failure) { complete = false; process.exitCode = 1; console.error(failure.message); }
  writeFileSync(join(output, 'analytics-e2e-result.json'), JSON.stringify({ verificationDatabaseOnly: true, productionUserDataUntouched: true, nativeObsReceiverUntouched: true, complete, testedJarSha256: jarHash, databaseRuntime: config.runtime, results, observations,
    fixture: 'Dedicated MediaMTX + one sequential 320x180 15fps H.264/AAC FFmpeg source + scoped HLS session + immutable Spring JAR + production React + headless Edge',
    limits: ['Connection estimates are not unique persons or proof of actual playback time', 'Single PC loopback and emulated mobile viewports only', 'No Caddy HTTPS/WSS, physical phones or load/capacity verification'] }, null, 2));
  console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length }));
}
