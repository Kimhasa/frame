// Actual archive-history verification. All credentials, media, browser profiles and process logs stay in private temp.
// Requires one approved, exclusive heavy-verification slot and current API JAR / production web build.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree, killByCommandLine } from './harness.mjs';
import { Client, api, origin, liveBroadcast } from './missions-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, 'verification/product');
const run = randomBytes(6).toString('hex'), directory = join(tmpdir(), 'frame-archive-history-' + run), streamPath = 'obs-history-' + run;
const recordRoot = join(directory, 'recordings'), vodRoot = join(directory, 'vod'), clipRoot = join(directory, 'clips');
const bin = join(root, 'dist/FrameConsole/bin'), token = randomBytes(32).toString('hex'), password = randomBytes(24).toString('base64url');
const ports = { api: 18083, web: 5365, dev: 5366, rtmp: 2935, rtsp: 29554, mtx: 29997, hls: 29888, playback: 29996, browser: 9550, devBrowser: 9551 };
const java = process.env.FRAME_JAVA || join(process.env.JAVA_HOME || '', 'bin/java.exe');
if (!existsSync(java)) throw Error('A current Java 21 installation is required through JAVA_HOME or FRAME_JAVA; no process was started.');
const configFile = resolve(process.env.FRAME_PRODUCT_TEST_CONFIG || join(process.env.LOCALAPPDATA, 'Frame/product-docker/config.json'));
if (!relative(root, configFile).startsWith('..' + sep)) throw Error('Private verification configuration must remain outside the repository.');
let config; try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { throw Error('Private verification configuration could not be read; no values were printed.'); }
if (config.verifyDbUrl === config.dbUrl || !/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '')) throw Error('Only a separate loopback verification database is allowed.');
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), jar = join(directory, 'frame-api.jar');
copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar); const jarHash = sha(readFileSync(jar));
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = {
  ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: String(ports.api), RELAY_OBS_ENABLED: 'true', RELAY_OBS_SERVER_URL: 'rtmp://127.0.0.1:' + ports.rtmp,
  RELAY_PUBLISHER_TOKENS: token + ' ' + streamPath, RELAY_MEDIA_GRACE_MS: '5000', RELAY_PUBLIC_BASE_URL: api,
  RELAY_MEDIAMTX_API: 'http://127.0.0.1:' + ports.mtx, RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:' + ports.hls,
  RELAY_MEDIAMTX_RTSP: 'rtsp://127.0.0.1:' + ports.rtsp, RELAY_MEDIAMTX_PLAYBACK: 'http://127.0.0.1:' + ports.playback,
  RELAY_DVR: 'true', RELAY_RECORD_DIR: recordRoot, RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '', RELAY_FFMPEG: join(bin, 'ffmpeg.exe'),
  FRAME_PRODUCT_VOD_DIR: vodRoot, FRAME_PRODUCT_CLIP_DIR: clipRoot, FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl,
  FRAME_PRODUCT_DB_USERNAME: config.dbUsername, FRAME_PRODUCT_DB_PASSWORD: config.dbPassword, FRAME_PRODUCT_REDIS_HOST: config.redisHost,
  FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: 'frame:product:archive-history:' + run + ':sessions', FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
const results = [], observations = [], limits = ['One PC loopback and headless Edge only; 320/390px are emulated viewports', 'No physical-device, Caddy HTTPS, external-network, long-run or load/capacity claim', 'Direct API CAS fixtures are separate from measured browser playback evidence'];
let apiProcess, publisher, complete = false, checkpoint;
function check(pass, name, detail) { results.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(fn, label, ms = 60000) { for (const end = Date.now() + ms; Date.now() < end;) { const value = await fn(); if (value) return value; await sleep(200); } throw Error('Timeout: ' + label); }
async function ready(url, child) { await until(async () => { if (!child.running) throw Error('An isolated verification process exited; its log remains private.'); return (await fetch(url).catch(() => null))?.ok; }, 'isolated process readiness', 45000); }
async function exitCode(child, ms) { await until(() => !child.running, 'bounded browser verification completion', ms); return child.exited; }
async function startApi(label) { const child = start(label, java, ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory }); await ready(api + '/api/v1/session', child); return child; }
async function account(kind, consent) { const client = new Client(); await client.request('GET', '/session'); const r = await client.request('POST', '/auth/register', { email: 'archive_history_' + kind + '_' + run + '@example.invalid', password, displayName: '시청 기록 검증 ' + kind, ...consent }); if (r.status !== 201) throw Error('Dedicated verification account registration failed.'); return client; }
const historyRoute = (kind, id) => '/me/history/media/' + kind + '/' + id;
const snapshot = (state, positionMs = 1500, completed = false) => ({ epoch: state.epoch, id: state.item?.id ?? null, version: state.item?.version ?? 0, positionMs, completed });
async function state(client, kind, id) { const r = await client.request('GET', historyRoute(kind, id)); if (r.status !== 200) throw Error('Private archive history returned HTTP ' + r.status); return r.data; }
async function own(client, kind, id) { const r = await client.request('GET', '/me/' + (kind === 'vod' ? 'vods' : 'clips') + '/' + id); if (r.status !== 200) throw Error('Private archive metadata returned HTTP ' + r.status); return r.data.item; }
async function visibility(client, kind, id, value) { const item = await own(client, kind, id); const r = await client.request('PATCH', '/me/' + (kind === 'vod' ? 'vods' : 'clips') + '/' + id, { version: item.version, title: item.title, description: item.description, visibility: value }); if (r.status !== 200) throw Error('Dedicated fixture visibility change failed.'); return r.data.item; }
async function prepared(client, kind, id) { return until(async () => { const item = await own(client, kind, id); if (item.status === 'failed') throw Error('Actual archive preparation failed; diagnostics remain private.'); return item.published ? item : null; }, 'actual ' + kind + ' preparation', 90000); }
function scoped(file) { const selected = resolve(file), part = relative(realpathSync(directory), selected); if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw Error('Refusing a fixture file mutation outside the exact private directory.'); return selected; }
function cleanupBrowser(name, prefix) { const marker = join(directory, name); if (!existsSync(marker)) return; const saved = JSON.parse(readFileSync(marker, 'utf8')), profile = typeof saved.profile === 'string' ? resolve(saved.profile) : ''; if (!profile || !isAbsolute(saved.profile) || basename(profile) !== 'profile' || !basename(dirname(profile)).startsWith(prefix) || dirname(dirname(profile)).toLowerCase() !== resolve(tmpdir()).toLowerCase()) throw Error('Browser cleanup scope is invalid.'); killByCommandLine(profile); }
function report(failure) { try { writeFileSync(join(directory, 'private-failure.json'), JSON.stringify({ message: failure.message, stack: failure.stack }, null, 2)); } catch {} console.error(failure.code ? 'Private fixture operation failed; diagnostics remain outside the repository.' : failure.message.replaceAll(directory, '<private-fixture>').replaceAll(root, '<repo>')); }

try {
  for (const port of Object.values(ports)) if (!await portFree(port)) throw Error('Dedicated verification port is occupied: ' + port);
  const yaml = ['logLevel: warn', 'logDestinations: [stdout]', 'authMethod: internal', 'authInternalUsers:', '  - user: any', "    ips: ['127.0.0.1', '::1']", '    permissions:', '      - action: read', '      - action: api', '      - action: playback', '      - action: publish', 'api: true', 'apiAddress: 127.0.0.1:' + ports.mtx, 'rtsp: true', 'rtspTransports: [tcp]', 'rtspEncryption: "no"', 'rtspAddress: 127.0.0.1:' + ports.rtsp, 'rtmp: true', 'rtmpAddress: 127.0.0.1:' + ports.rtmp, 'webrtc: false', 'srt: false', 'moq: false', 'hls: true', 'hlsAddress: 127.0.0.1:' + ports.hls, 'hlsVariant: lowLatency', 'hlsSegmentDuration: 1s', 'hlsPartDuration: 200ms', 'playback: true', 'playbackAddress: 127.0.0.1:' + ports.playback, 'pathDefaults:', '  source: publisher', '  overridePublisher: false', '  record: false', 'paths:', '  ' + streamPath + ':', '    runOnAvailable: ffmpeg -hide_banner -nostdin -loglevel warning -rtsp_transport tcp -i rtsp://127.0.0.1:' + ports.rtsp + '/' + streamPath + ' -map 0:v:0 -map 0:a:0? -c copy -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:' + ports.rtsp + '/' + streamPath + '/rec', '    runOnAvailableRestart: true', '  ' + streamPath + '/rec:', '    record: true', '    recordPath: ' + JSON.stringify(join(recordRoot, '%path', '%Y-%m-%d_%H-%M-%S-%f%z').replaceAll('\\', '/')), '    recordFormat: fmp4', '    recordPartDuration: 1s', '    recordSegmentDuration: 12s', '    recordDeleteAfter: 6h', ''].join('\n');
  writeFileSync(join(directory, 'mediamtx.yml'), yaml);
  const receiver = start('mediamtx', join(bin, 'mediamtx.exe'), [join(directory, 'mediamtx.yml')], { cwd: directory, env: { PATH: bin + ';' + process.env.PATH }, logDir: directory });
  await ready('http://127.0.0.1:' + ports.mtx + '/v3/paths/list', receiver); apiProcess = await startApi('spring');
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', String(ports.web), '--strictPort'], { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory }); await ready(origin + '/_frame/', web);
  const anonymous = new Client(), policies = await anonymous.request('GET', '/policies'), consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  const owner = await account('owner', consent), viewer = await account('viewer', consent), other = await account('other', consent), session = await owner.request('GET', '/session'), channel = session.data.channel;
  if (!channel?.handle) throw Error('The dedicated fixture owning channel is missing.');
  check((await owner.request('POST', '/me/channel/connection', { streamKey: streamPath + '?user=' + streamPath + '&pass=' + token })).status === 200, 'The private actual-media fixture belongs to the dedicated publisher');
  const needle = 'HISTORY ' + run, title = '저장한 작업실 · ' + needle, description = '실제 재생으로 확인하는 비공개 시청 기록';
  await owner.request('PUT', '/studio', { title, publisher: '시청 기록 검증' });
  publisher = start('publisher', join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-f', 'flv', '-flvflags', 'no_duration_filesize', 'rtmp://127.0.0.1:' + ports.rtmp + '/' + streamPath], { logDir: directory });
  const live = await liveBroadcast(streamPath);
  const source = await until(async () => { const r = await owner.request('GET', '/me/recordings?limit=100'); if (r.status === 503) return null; if (r.status !== 200) throw Error('Actual recording catalog failed.'); return r.data.items.find(item => item.readyPlayable && item.durationMs >= 10000); }, 'one actual finalized twelve-second recording', 100000);
  const published = await owner.request('POST', '/me/vods', { recordingId: source.id, title, description }); if (published.status !== 202) throw Error('Actual VOD publication failed.');
  const vod = await prepared(owner, 'vod', published.data.item.id);
  check((await owner.request('POST', '/me/history', { broadcastId: live.id, path: live.path })).status === 204, 'Legacy live history still accepts its original two-field request');
  await stop(publisher); publisher = null;
  const clipCreated = await owner.request('POST', '/me/clips', { sourceVodId: vod.id, startMs: 2000, endMs: 8000, title: '잘라낸 순간 · ' + needle, description, clientRequestId: randomUUID() });
  if (![200, 202].includes(clipCreated.status)) throw Error('Actual six-second clip preparation request failed.');
  const clip = await prepared(owner, 'clip', clipCreated.data.item.id);
  const media = [];
  for (const [kind, item, folder] of [['vod', vod, vodRoot], ['clip', clip, clipRoot]]) { const bytes = readFileSync(scoped(join(folder, item.id + '.mp4'))), r = await fetch(api + '/api/v1/' + (kind === 'vod' ? 'vods' : 'clips') + '/' + item.id + '/media'); const publicBytes = Buffer.from(await r.arrayBuffer()); media.push({ kind, durationMs: item.durationMs, bytes: bytes.length, sha256: sha(bytes) }); check(r.status === 200 && publicBytes.equals(bytes) && item.durationMs >= (kind === 'vod' ? 10000 : 5800), 'The actual ' + kind + ' fixture serves its independently archived MP4 bytes'); }
  observations.push(...media);
  for (const [kind, item] of [['vod', vod], ['clip', clip]]) {
    const route = historyRoute(kind, item.id), empty = await state(owner, kind, item.id);
    check(empty.userId === owner.userId && empty.item === null && Number.isInteger(empty.epoch) && (await owner.request('GET', '/me/history')).data.items.length === (kind === 'vod' ? 1 : 2), kind + ' metadata GET does not fabricate history');
    check((await anonymous.request('GET', route)).status === 401 && (await owner.request('PUT', route, snapshot(empty), { csrf: false })).status === 403 && (await owner.request('PUT', route, snapshot(empty), { origin: 'https://outside.invalid' })).status === 403, kind + ' progress requires a private session, CSRF and trusted Origin');
    const switched = await other.request('GET', route, undefined, { expectedUserId: owner.userId });
    check(switched.status === 409 && switched.data.code === 'SESSION_CHANGED', kind + ' progress rejects a previous account cookie scope');
    const bad = [];
    for (const change of [{ positionMs: -1 }, { positionMs: 1.5 }, { positionMs: Math.ceil(item.durationMs) + 1 }, { positionMs: 0, completed: true }, { title: 'client supplied metadata' }]) bad.push(await owner.request('PUT', route, { ...snapshot(empty), ...change }));
    check(bad.every(r => r.status === 400 || r.status === 409), kind + ' progress rejects invalid positions, premature completion and client metadata');
    const saved = await owner.request('PUT', route, snapshot(empty));
    check(saved.status === 200 && saved.data.item.kind === kind && saved.data.item.mediaId === item.id && saved.data.item.title === item.title && saved.data.item.publisher === channel.displayName && saved.data.item.durationMs === item.durationMs && saved.data.item.positionMs === 1500 && !saved.data.item.completed && saved.data.item.version === 0, kind + ' progress stores trusted public metadata and an authoritative version');
    const stale = await owner.request('PUT', route, snapshot(empty, 2200));
    check(stale.status === 409 && stale.data.code === 'HISTORY_CONFLICT', kind + ' stale create cannot overwrite an accepted visit');
    const ended = await owner.request('PUT', route, snapshot(saved.data, Math.floor(item.durationMs), true));
    const replay = await owner.request('PUT', route, snapshot(ended.data, 1200));
    check(ended.status === 200 && ended.data.item.completed && ended.data.item.positionMs === ended.data.item.durationMs && replay.status === 200 && !replay.data.item.completed && replay.data.item.positionMs === 1200 && replay.data.item.id === saved.data.item.id, kind + ' completion and replay preserve one row and accept a lower replay position');
  }
  const all = await owner.request('GET', '/me/history?limit=1'), next = await owner.request('GET', '/me/history?limit=1&cursor=' + encodeURIComponent(all.data.nextCursor));
  check(all.data.nextCursor && all.data.items[0].id !== next.data.items[0].id, 'History cursor pages contain distinct real live and archived rows');
  for (const kind of ['live', 'vod', 'clip']) { const page = await owner.request('GET', '/me/history?kind=' + kind); check(page.status === 200 && page.data.items.length === 1 && page.data.items[0].kind === kind, 'The ' + kind + ' history filter returns only that stored kind'); }
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), dated = await owner.request('GET', '/me/history?from=' + today + '&to=' + today + '&q=' + encodeURIComponent(needle));
  check(dated.status === 200 && dated.data.items.length === 3 && (await owner.request('GET', '/me/history?cursor=invalid')).status === 400, 'History query and inclusive Seoul calendar dates apply to all stored kinds with controlled cursor validation');
  const beforeDelete = await state(owner, 'vod', vod.id), missingCreate = await state(other, 'vod', vod.id);
  check((await owner.request('DELETE', '/me/history/' + beforeDelete.item.id)).status === 204, 'An archived history row can be individually deleted');
  const late = await owner.request('PUT', historyRoute('vod', vod.id), snapshot(beforeDelete, 2300));
  check(late.status === 409 && (await state(owner, 'vod', vod.id)).item === null, 'A late save cannot resurrect an individually deleted archive row');
  check((await other.request('DELETE', '/me/history')).status === 204, 'Clearing an empty history remains a successful explicit deletion');
  const lateCreate = await other.request('PUT', historyRoute('vod', vod.id), snapshot(missingCreate));
  check(lateCreate.status === 409 && (await state(other, 'vod', vod.id)).item === null, 'Clear-all advances the epoch even when empty and rejects an older unsaved visit');
  const clipState = await state(owner, 'clip', clip.id); await visibility(owner, 'vod', vod.id, 'private');
  const unavailable = (await owner.request('GET', '/me/history?kind=clip')).data.items[0];
  check(!unavailable.available && unavailable.title === clip.title && (await owner.request('GET', historyRoute('clip', clip.id))).status === 404 && (await owner.request('PUT', historyRoute('clip', clip.id), snapshot(clipState, 2000))).status === 404, 'Private parent VOD retains a clip history snapshot and blocks new progress reads and writes');
  await visibility(owner, 'vod', vod.id, 'public'); await visibility(owner, 'clip', clip.id, 'private');
  check(!(await owner.request('GET', '/me/history?kind=clip')).data.items[0].available && (await owner.request('GET', historyRoute('clip', clip.id))).status === 404, 'A clip own withdrawal also makes its stored history unavailable');
  await visibility(owner, 'clip', clip.id, 'public');
  const file = scoped(join(clipRoot, clip.id + '.mp4')), held = scoped(file + '.history-held'); renameSync(file, held);
  try { check(!(await owner.request('GET', '/me/history?kind=clip')).data.items[0].available && (await owner.request('GET', historyRoute('clip', clip.id))).status === 404, 'An actually missing clip file cannot be resumed through its retained snapshot'); }
  finally { renameSync(held, file); }
  checkpoint = { owner: owner.saved(), viewer: viewer.saved(), other: other.saved(), channel, streamPath, needle, vodId: vod.id, clipId: clip.id, vodTitle: vod.title, clipTitle: clip.title, vodDurationMs: vod.durationMs, clipDurationMs: clip.durationMs, testedJarSha256: jarHash };
  writeFileSync(join(directory, 'archive-history-checkpoint.json'), JSON.stringify(checkpoint));
  const ui = start('archive-history-ui', process.execPath, [join(root, 'server/verify/archive-history-ui.mjs')], { cwd: root, env: { FRAME_ARCHIVE_HISTORY_TEST_DIR: directory }, logDir: directory });
  check(await exitCode(ui, 360000) === 0 && JSON.parse(readFileSync(join(output, 'archive-history-ui-result.json'), 'utf8')).complete, 'Actual browser progression, resume, recovery, races, account isolation and mobile history pass');
  const expected = (await viewer.request('GET', '/me/history')).data.items;
  await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  const persisted = await viewer.request('GET', '/me/history');
  check((await viewer.request('GET', '/session')).data.user?.id === viewer.userId && persisted.status === 200 && persisted.data.items.length === expected.length && expected.every(item => persisted.data.items.some(nextItem => nextItem.id === item.id && nextItem.positionMs === item.positionMs && nextItem.version === item.version)), 'Actual browser-saved positions and Redis login survive the isolated API restart');
  const dev = start('web-dev', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', String(ports.dev), '--strictPort'], { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory }); await ready('http://127.0.0.1:' + ports.dev + '/_frame/', dev);
  const devUi = start('archive-history-dev-ui', process.execPath, [join(root, 'server/verify/archive-history-ui.mjs')], { cwd: root, env: { FRAME_ARCHIVE_HISTORY_TEST_DIR: directory, FRAME_ARCHIVE_HISTORY_DEV_SMOKE: '1' }, logDir: directory });
  check(await exitCode(devUi, 75000) === 0 && JSON.parse(readFileSync(join(output, 'archive-history-dev-result.json'), 'utf8')).complete, 'Development StrictMode reads actual archive history without any mutation');
  check(sha(readFileSync(jar)) === jarHash, 'The exact tested JAR stays immutable throughout media preparation and verification'); complete = true;
} catch (failure) { report(failure); process.exitCode = 1; }
finally {
  await stopAll();
  try { cleanupBrowser('browser-owner.json', 'frame-archive-history-ui-'); cleanupBrowser('browser-dev-owner.json', 'frame-archive-history-dev-ui-'); } catch (failure) { complete = false; process.exitCode = 1; report(failure); }
  writeFileSync(join(output, 'archive-history-e2e-result.json'), JSON.stringify({ complete, verificationDatabaseOnly: true, productionUserDataUntouched: true, nativeObsReceiverUntouched: true, testedJarSha256: jarHash, ports, recordingSegmentDurationSeconds: 12, productionSegmentDurationSeconds: 60, fixture: 'One dedicated 320x180 15fps H.264/AAC source, a finalized VOD and an independently encoded six-second clip', results, observations, limits }, null, 2));
  console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(result => result.pass).length }));
}
