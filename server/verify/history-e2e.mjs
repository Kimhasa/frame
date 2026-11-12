// Real, isolated watch-history check. Never publishes into the local OBS receiver or uses the user database.
// Prerequisites: built API JAR + production web, native verification PostgreSQL/Redis already running.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { start, stop, stopAll, waitFor, sleep, portFree, killByCommandLine } from './harness.mjs';
import { connect } from '../../tools/cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'verification/product');
const directory = join(tmpdir(), 'frame-history-e2e-' + Date.now());
const profile = join(directory, 'edge-profile');
const ports = { api: 18083, web: 5365, mtx: 29997, rtsp: 29554, hls: 29888, edge: 9494 };
const api = `http://127.0.0.1:${ports.api}`, origin = `http://127.0.0.1:${ports.web}`;
const secret = randomBytes(32).toString('hex'), id = randomBytes(16).toString('hex');
const path = 'history-screen', title = '개발 작업 라이브', publisher = '작업실';
const password = randomBytes(24).toString('base64url'), run = randomBytes(5).toString('hex');
const bin = join(root, 'dist/FrameConsole/bin');
const java = join(process.env.JAVA_HOME, 'bin/java.exe');
const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (!config.verifyDbUrl || config.verifyDbUrl === config.dbUrl || !config.verifyDbUrl.endsWith('/frame_product_verify')) throw Error('A separate verification database is required.');
const jar = join(directory, 'frame-api.jar');
const results = [], runtimeErrors = [], writes = [], browserRequests = [];
let page, apiProcess, ffmpeg, heartbeat, failFirstRecord = true, uiResult, finished = false;
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar);

function check(pass, name, detail) {
  results.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
  console.log((pass ? 'PASS ' : 'FAIL ') + name);
  if (!pass) throw Error(name);
}
async function until(fn, label, timeout = 20000) {
  const value = await waitFor(fn, timeout, 100);
  if (!value) throw Error('Timeout: ' + label);
  return value;
}
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const history = () => page.evaluate(`fetch('/api/v1/me/history').then(r=>r.json())`);
const video = () => page.evaluate(`(() => {const v=document.querySelector('video');return v?{time:v.currentTime,paused:v.paused,readyState:v.readyState,frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,height:v.videoHeight}:null})()`);
async function nav(route) { await page.send('Page.navigate', { url: origin + '/_frame' + route }); await page.send('Page.bringToFront'); }
async function set(selector, value) {
  await page.evaluate(`(() => {const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function mediaAnnouncement(type, broadcastId = id) {
  const item = { id: broadcastId, path, title, publisher, width: 320, height: 180, fps: 15,
    startedAtMs: Date.now(), sentAtMs: Date.now(), bitrate: 0.5, audio: 'system' };
  const response = await fetch(api + '/api/broadcasts/announce', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
    body: JSON.stringify(type === 'bye' ? { v: 1, type, id: broadcastId } : { v: 1, type, item }) });
  if (response.status !== 204) throw Error('Fixture announcement rejected: ' + response.status);
}
const cleanEnvironment = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const apiEnvironment = {
  ...cleanEnvironment, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: String(ports.api), RELAY_PUBLIC_BASE_URL: api,
  RELAY_PUBLISHER_TOKENS: secret + ' ' + [path, ...Array.from({ length: 53 }, (_, index) => 'history-fixture-' + String(index + 1).padStart(2, '0'))].join(' '),
  RELAY_OBS_ENABLED: 'false', RELAY_ANNOUNCE_TTL_MS: '60000', RELAY_MEDIA_GRACE_MS: '45000',
  RELAY_MEDIAMTX_API: `http://127.0.0.1:${ports.mtx}`, RELAY_MEDIAMTX_HLS: `http://127.0.0.1:${ports.hls}`,
  RELAY_MEDIAMTX_RTSP: `rtsp://127.0.0.1:${ports.rtsp}`, RELAY_HLS: 'true', RELAY_HLS_AAC: 'false', RELAY_DVR: 'false',
  RELAY_RECORD_DIR: '', RELAY_RENDITIONS: '', RELAY_FFMPEG: join(bin, 'ffmpeg.exe'), RELAY_UI_FILE: '', RELAY_STATS_DIR: '',
  FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername,
  FRAME_PRODUCT_DB_PASSWORD: config.dbPassword, FRAME_PRODUCT_REDIS_HOST: config.redisHost,
  FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:history-e2e:${run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
async function startApi(label) {
  const process = start(label, java, ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: apiEnvironment, logDir: directory });
  await until(async () => { if (!process.running) throw Error('Isolated Spring exited'); return (await fetch(api + '/healthz').catch(() => null))?.ok; }, 'Isolated Spring starts', 60000);
  return process;
}
async function intercept(event) {
  if (event.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = event.params;
  if (request.method === 'POST' && new URL(request.url).pathname === '/api/v1/me/history') {
    writes.push({ at: Date.now(), fault: failFirstRecord });
    if (failFirstRecord) {
      failFirstRecord = false;
      await page.send('Fetch.fulfillRequest', { requestId, responseCode: 503,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ code: 'PRODUCT_UNAVAILABLE', detail: '기록을 저장하지 못했어요.' })).toString('base64') });
      return;
    }
  }
  await page.send('Fetch.continueRequest', { requestId });
}

try {
  for (const [name, port] of Object.entries(ports)) if (!await portFree(port)) throw Error(`Isolated ${name} port is in use: ${port}`);
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
apiAddress: 127.0.0.1:${ports.mtx}
rtsp: true
rtspTransports: [tcp]
rtspEncryption: "no"
rtspAddress: 127.0.0.1:${ports.rtsp}
rtmp: false
webrtc: false
srt: false
moq: false
hls: true
hlsAddress: 127.0.0.1:${ports.hls}
hlsEncryption: false
hlsVariant: lowLatency
hlsSegmentCount: 7
hlsSegmentDuration: 1s
hlsPartDuration: 200ms
pathDefaults:
  source: publisher
  record: false
paths:
  all_others:
`);
  const mtx = start('mediamtx', join(bin, 'mediamtx.exe'), [join(directory, 'mediamtx.yml')], { cwd: directory, logDir: directory });
  await until(async () => mtx.running && (await fetch(`http://127.0.0.1:${ports.mtx}/v3/paths/list`).catch(() => null))?.ok, 'Isolated MediaMTX starts');
  apiProcess = await startApi('spring');
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', String(ports.web), '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await until(async () => web.running && (await fetch(origin + '/_frame/').catch(() => null))?.ok, 'Built production web starts');
  start('edge', process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--remote-debugging-port=' + ports.edge, '--user-data-dir=' + profile, 'about:blank'], { logDir: directory });
  page = await until(() => connect(ports.edge, target => !target.url.startsWith('edge://')).catch(() => null), 'Edge CDP');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') runtimeErrors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') browserRequests.push({ method: event.params.request.method, path: new URL(event.params.request.url).pathname });
    void intercept(event).catch(error => runtimeErrors.push(error.message));
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/me/history*' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await nav('/login?mode=register'); await has('#account-agree-all');
  await until(() => page.evaluate(`!document.querySelector('#account-agree-all').disabled`), 'Consent policies load');
  await set('[name=email]', `history_play_${run}@example.invalid`); await set('[name=displayName]', '시청 기록 검증');
  await set('[name=password]', password); await set('[name=passwordConfirmation]', password);
  await page.click('#account-agree-all'); await page.click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
  check((await history()).items.length === 0, 'New account has no fabricated history');
  await mediaAnnouncement('announce'); heartbeat = setInterval(() => { void mediaAnnouncement('announce').catch(() => {}); }, 10000);
  await nav(`/watch/${path}/${id}`); await has('video'); await sleep(2200);
  const waiting = await video();
  check(writes.length === 0 && (await history()).items.length === 0 && waiting.paused, 'Opening a waiting broadcast does not create history', waiting);
  ffmpeg = start('publisher', join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0',
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${ports.rtsp}/${path}`], { logDir: directory });
  await page.send('Page.bringToFront');
  await until(async () => { const current = await video(); return current && !current.paused && current.frames > 10 && writes.length === 1; }, 'Actual HLS progress and injected first save failure', 90000);
  const before = await video(); await sleep(1100); const after = await video();
  check(after.time > before.time && after.frames > before.frames && (await history()).items.length === 0, 'A history save failure does not interrupt video playback', { before, after });
  await until(async () => (await history()).items?.length === 1, 'Bounded retry saves watched broadcast', 15000);
  let item = (await history()).items[0];
  check(item.broadcastId === id && item.path === path && item.title === title && item.publisher === publisher && item.available, 'Advancing real HLS video saves server broadcast metadata', { width: after.width, height: after.height });
  check(writes.length === 2 && writes[1].at - writes[0].at >= 4900, 'Transient failure retries after cooldown instead of every media event', { attempts: writes.length, retryAfterMs: writes[1].at - writes[0].at });
  await sleep(1500); check(writes.length === 2, 'Successful watch visit does not send repeated writes');
  const deleted = await page.evaluate(`fetch('/api/v1/session').then(r=>r.json()).then(s=>fetch('/api/v1/me/history/${item.id}',{method:'DELETE',headers:{'X-CSRF-TOKEN':s.csrfToken}})).then(r=>r.status)`);
  check(deleted === 204, 'The saved record can be deleted while the player stays mounted');
  await sleep(1600);
  check((await history()).items.length === 0 && writes.length === 2 && !(await video()).paused, 'Continuing playback does not recreate a deleted record');
  await nav('/history'); await until(() => page.evaluate(`document.body.innerText.includes('시청 기록이 없어요')`), 'Real empty history screen');
  await nav(`/watch/${path}/${id}`); await has('video');
  await until(async () => (await history()).items?.length === 1, 'A new actual viewing visit records history again', 30000);
  item = (await history()).items[0];
  check(writes.length === 3 && item.title === title, 'Revisiting and playing the broadcast creates a new watched visit');
  await nav('/history'); await until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(title)})`), 'Saved history UI');
  await page.send('Page.reload'); await until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(title)})`), 'Reloaded history UI');
  check((await history()).items.length === 1, 'Stored history survives browser reload');
  clearInterval(heartbeat); heartbeat = null; await mediaAnnouncement('bye'); await stop(ffmpeg);
  const ended = (await history()).items[0];
  check(!ended.available && ended.title === title, 'Broadcast ending preserves history and marks it unavailable');
  await page.send('Page.reload'); await until(() => page.evaluate(`document.body.innerText.includes('방송 종료')`), 'Ended history row');
  check(await page.evaluate(`!Array.from(document.querySelectorAll('article a')).some(a=>a.href.includes('/watch/'))`), 'Ended history is not linked to another broadcast on the same path');
  writeFileSync(join(output, 'history-ended-ui.png'), await page.screenshot());
  await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  await page.send('Page.reload'); await until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(title)})`), 'History after API restart');
  check((await history()).items.length === 1 && !(await history()).items[0].available, 'PostgreSQL history and Redis login survive API restart');
  check(runtimeErrors.length === 0, 'No browser runtime or interception errors during actual playback');
  check(!browserRequests.some(request => /\/whep$/.test(request.path)), 'Actual watch-history check uses HLS without WHEP fallback');
  await page.send('Browser.close').catch(() => {}); page.close(); page = null; killByCommandLine(profile);
  const uiFile = join(root, 'server/verify/history-ui.mjs');
  if (!existsSync(uiFile)) throw Error('History UI verification script is missing.');
  const ui = start('history-ui', process.execPath, [uiFile], { cwd: root, env: { FRAME_HISTORY_FIXTURE_TOKEN: secret }, logDir: directory });
  const uiCode = await ui.exited;
  uiResult = existsSync(join(output, 'history-ui-result.json')) ? JSON.parse(readFileSync(join(output, 'history-ui-result.json'), 'utf8')) : null;
  check(uiCode === 0 && uiResult?.results?.every(result => result.pass), 'History UI pagination, filters, deletion and mobile checks pass', { checks: uiResult?.results?.length || 0 });
  finished = true;
} catch (error) {
  if (page) {
    writeFileSync(join(output, 'history-playback-failure.png'), await page.screenshot().catch(() => Buffer.alloc(0)));
    const state = await page.evaluate('({url:location.pathname,text:document.body.innerText.slice(-3000)})').catch(() => null);
    console.error(JSON.stringify({ failure: error.message, state }));
  } else console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  writeFileSync(join(output, 'history-e2e-result.json'), JSON.stringify({ startedWith: 'Isolated Spring + MediaMTX + FFmpeg + production React + headless Edge', verificationDatabaseOnly: true,
    nativeObsReceiverUntouched: true, productionUserDataUntouched: true, ports, fixture: { video: '320x180 15fps H.264 + AAC', path },
    faultInjection: ['First history POST 503'], results, runtimeErrors, complete: finished,
    limits: ['Single PC, loopback and headless Edge only', 'No iPhone/Android physical-device, Caddy HTTPS/WSS or load verification', 'Metadata-only fixtures are used separately for history pagination UI'] }, null, 2));
  if (page) { await page.send('Browser.close').catch(() => {}); page.close(); }
  killByCommandLine(profile); await stopAll();
  console.log(JSON.stringify({ complete: finished, checks: results.length, passed: results.filter(result => result.pass).length }));
}
