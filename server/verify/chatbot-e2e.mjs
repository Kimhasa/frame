// Isolated product chatbot verification. Private fixtures, logs and credentials stay outside the repository and Temp.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree, killByCommandLine } from './harness.mjs';
import { Client, api, origin, openSocket, joinAccount, sendMessage, liveBroadcast } from './chat-moderation-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, 'verification/product');
const captureOnly = process.env.FRAME_CHATBOT_CAPTURE_ONLY === '1';
const run = randomBytes(6).toString('hex'), directory = join(process.env.LOCALAPPDATA, 'Frame/verification', 'chatbot-' + run);
const streamPath = `obs-chat-${run}`, token = randomBytes(32).toString('hex'), bin = join(root, 'dist/FrameConsole/bin');
const configFile = resolve(process.env.FRAME_PRODUCT_TEST_CONFIG ?? join(process.env.LOCALAPPDATA, 'Frame/product-docker/config.json'));
if (configFile.toLowerCase().startsWith(root.toLowerCase() + '\\')) throw Error('The verification configuration must stay outside the repository.');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate local verification database is required.');
const javaHome = join(process.env.LOCALAPPDATA, 'FrameTools/jdk-21.0.13+9');
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
  FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:chatbot-e2e:${run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
const ports = [18083, 5365, 2935, 29554, 29997, 29888, 29996, 9550, 9551], results = [], sockets = [];
let apiProcess, publisher, mediaStarts = 0, complete = false, settings, fixture;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function ready(url, child) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (!child.running) throw Error('A verification process exited; its private log stays outside the repository.');
    if ((await fetch(url).catch(() => null))?.ok) return;
    await sleep(150);
  }
  throw Error('A verification service did not become ready.');
}
async function startApi(name) {
  const child = start(name, join(javaHome, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory });
  await ready(api + '/api/v1/session', child); return child;
}
function publish() {
  if (publisher?.running) throw Error('Only one dedicated tiny source may run.');
  mediaStarts++;
  publisher = start('publisher-' + mediaStarts, join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-bf', '0', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-f', 'flv', '-flvflags', 'no_duration_filesize',
    `rtmp://127.0.0.1:2935/${streamPath}`], { logDir: directory });
}
async function account(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const response = await client.request('POST', '/auth/register', { email: `chatbot_${kind}_${run}@example.invalid`, password: randomBytes(24).toString('base64url'),
    displayName: kind === 'owner' ? '챗봇 검증 방송자' : '챗봇 검증 시청자', ...consent });
  if (response.status !== 201) throw Error('Isolated chatbot registration returned HTTP ' + response.status);
  return { client, user: response.data.user, channel: response.data.channel };
}
const body = (value, changes = {}) => ({ version: value.version, enabled: value.enabled, commands: value.commands, ...changes });
const rule = (command, response, enabled = true, cooldownSeconds = 5) => ({ id: randomUUID(), command, response, enabled, cooldownSeconds });
async function save(changes) {
  const result = await fixture.owner.client.request('PATCH', '/me/chat/bot', body(settings, changes));
  if (result.status !== 200) throw Error('Real chatbot update returned HTTP ' + result.status + ' ' + result.data?.code);
  settings = result.data; return settings;
}
async function joined(client, broadcast) { const result = await joinAccount(client, broadcast); sockets.push(result.socket); return result; }
async function noBot(socket, milliseconds = 1200) { return !await socket.wait(event => event.type === 'message' && event.isBot === true, milliseconds); }
async function browser(mode) {
  writeFileSync(join(directory, 'chatbot-checkpoint.json'), JSON.stringify({ owner: fixture.owner.client.saved(), viewer: fixture.viewer.client.saved(), channelId: fixture.owner.channel.id, streamPath, broadcast: fixture.broadcast }));
  const child = start('chatbot-ui-' + mode, process.execPath, [join(root, 'server/verify/chatbot-ui.mjs'), mode], { cwd: root,
    env: { FRAME_CHATBOT_TEST_DIR: directory }, logDir: directory });
  const end = Date.now() + 300000;
  while (child.running) { if (Date.now() > end) throw Error('Chatbot browser verification timed out.'); await sleep(100); }
  const reportFile = join(output, 'chatbot-' + mode + '-result.json'), report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  check(await child.exited === 0 && report?.complete && report.results?.length > 0 && report.results.every(item => item.pass), mode + ' chatbot management and chat browser verification passes');
}

try {
  for (const port of ports) if (!await portFree(port)) throw Error('A dedicated verification port is occupied: ' + port);
  writeFileSync(join(directory, 'mediamtx.yml'), `logLevel: warn\nlogDestinations: [stdout]\nauthMethod: internal\nauthInternalUsers:\n  - user: any\n    ips: ['127.0.0.1', '::1']\n    permissions:\n      - action: read\n      - action: api\n      - action: publish\napi: true\napiAddress: 127.0.0.1:29997\nrtsp: true\nrtspTransports: [tcp]\nrtspEncryption: "no"\nrtspAddress: 127.0.0.1:29554\nrtmp: true\nrtmpAddress: 127.0.0.1:2935\nwebrtc: false\nsrt: false\nmoq: false\nhls: true\nhlsAddress: 127.0.0.1:29888\nhlsVariant: lowLatency\nhlsSegmentDuration: 1s\nhlsPartDuration: 200ms\npathDefaults:\n  source: publisher\n  record: false\npaths:\n  all_others:\n`);
  if (!captureOnly) {
    const media = start('mediamtx', join(bin, 'mediamtx.exe'), [join(directory, 'mediamtx.yml')], { cwd: directory, logDir: directory });
    await ready('http://127.0.0.1:29997/v3/paths/list', media);
  }
  apiProcess = await startApi('spring');
  const policies = await new Client().request('GET', '/policies');
  if (policies.status !== 200) throw Error('Isolated registration policies were unavailable.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  fixture = { owner: await account('owner', consent), viewer: await account('viewer', consent) };
  check((await fixture.owner.client.request('POST', '/me/channel/connection', { streamKey: `${streamPath}?user=${streamPath}&pass=${token}` })).status === 200, 'Only the isolated owner channel is connected to the dedicated source');
  check((await fixture.owner.client.request('PUT', '/studio', { title: '실제 챗봇 연동 검증', publisher: '챗봇 검증 방송자' })).status === 200, 'The real isolated channel can configure a broadcast before going live');
  settings = (await fixture.owner.client.request('GET', '/me/chat/bot')).data;
  check(settings.userId === fixture.owner.user.id && settings.channelId === fixture.owner.channel.id && settings.version === 0 && settings.updatedAtMs === 0 && !settings.enabled && settings.commands.length === 0, 'A new channel has persisted-scope chatbot defaults while offline');
  if (captureOnly) {
    await save({ enabled: true, commands: [rule('!정보', '채널 안내를 확인해 주세요.'), rule('!방송', '즐거운 방송 함께해요.'), rule('!안내', '서로를 배려하며 대화해 주세요.')] });
    const preview = start('web-capture', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
      { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
    await ready(origin + '/_frame/', preview); await browser('capture');
  } else {
  const owner = fixture.owner.client, viewer = fixture.viewer.client, anonymous = new Client(); await anonymous.request('GET', '/session');
  const defaults = await owner.request('GET', '/me/chat/bot'), other = await viewer.request('GET', '/me/chat/bot');
  check(defaults.headers.get('cache-control')?.includes('no-store') && other.data.userId === fixture.viewer.user.id && other.data.channelId !== settings.channelId, 'Private no-store configuration is scoped to each real account');
  const denied = [await anonymous.request('GET', '/me/chat/bot'), await anonymous.request('PATCH', '/me/chat/bot', body(settings)),
    await owner.request('PATCH', '/me/chat/bot', body(settings), { csrf: false }), await owner.request('PATCH', '/me/chat/bot', body(settings), { origin: 'https://untrusted.example.invalid' }),
    await viewer.request('GET', '/me/chat/bot', undefined, { expectedUserId: fixture.owner.user.id })];
  check(denied[0].status === 401 && denied[1].status === 401 && denied[2].status === 403 && denied[3].status === 403 && denied[4].status === 409 && denied[4].data.code === 'SESSION_CHANGED', 'Anonymous, missing CSRF, foreign Origin and changed-account operations are rejected');
  const information = rule('!정보', '실제 서버 응답 <img src=x onerror=attack>'), chain = rule('!chain', '!정보'), once = rule('!once', '한 번 응답');
  const second = rule('!second', '두 번째 응답'), deniedRule = rule('!deny', '공식 응답'), disabledRule = rule('!disabled', '비활성 응답', false);
  const commands = [information, chain, once, second, deniedRule, disabledRule];
  const invalid = [
    { version: -1 }, { enabled: 'true' }, { commands: Array.from({ length: 21 }, (_, index) => rule('!n' + index, '응답')) },
    { commands: [information, { ...information }] }, { commands: [rule('!UPPER', 'a'), rule('!upper', 'b')] },
    { commands: [rule('!a b', 'a')] }, { commands: [rule('!bad', ' ')] }, { commands: [rule('!bad', 'x'.repeat(501))] },
    { commands: [rule('!bad', 'a\u0000b')] }, { commands: [rule('!bad', 'a', true, 4)] }, { commands: [rule('!bad', 'a', true, 3601)] },
    { commands: [{ ...information, id: 'client-number' }] }, { unexpected: true },
  ];
  for (const change of invalid) {
    const rejected = await owner.request('PATCH', '/me/chat/bot', body(settings, change));
    check(rejected.status === 400, 'Malformed chatbot input is rejected without a version write (case ' + (invalid.indexOf(change) + 1) + ')');
  }
  const privateHeaders = { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-TOKEN': owner.csrf, 'X-FRAME-USER-ID': owner.userId,
    Cookie: [...owner.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
  for (const [payload, contentType, expectedStatus, label] of [
    ['{', 'application/json', 400, 'Malformed JSON'], [JSON.stringify(body(settings)), 'text/plain', 415, 'A non-JSON body'],
    [JSON.stringify({ ...body(settings), extra: 'x'.repeat(65537) }), 'application/json', 413, 'An oversized configuration body'],
  ]) {
    const response = await fetch(api + '/api/v1/me/chat/bot', { method: 'PATCH', headers: { ...privateHeaders, 'Content-Type': contentType }, body: payload, signal: AbortSignal.timeout(15000) });
    await response.arrayBuffer(); check(response.status === expectedStatus, label + ' is refused by the real bounded HTTP parser');
  }
  const wrongMethod = await owner.request('POST', '/me/chat/bot', body(settings));
  check([404, 405].includes(wrongMethod.status), 'POST cannot create or mutate chatbot configuration outside the GET/PATCH contract');
  check((await owner.request('GET', '/me/chat/bot')).data.version === 0, 'Rejected configuration writes leave the original row and version intact');
  const normalized = rule('  !UPPER  ', ' 첫째\n 둘째\t 셋째 ', true, 3600);
  await save({ enabled: true, commands: [...commands, normalized] });
  check(settings.version === 1 && settings.commands.at(-1).command === '!upper' && settings.commands.at(-1).response === '첫째 둘째 셋째'
    && settings.commands.at(-1).id === normalized.id, 'Offline saving normalizes command and response while preserving stable UUIDs and allowed cooldown');
  const stale = await owner.request('PATCH', '/me/chat/bot', { version: 0, enabled: false, commands: [] });
  check(stale.status === 409 && stale.data.code === 'CHAT_BOT_SETTINGS_CONFLICT' && (await owner.request('GET', '/me/chat/bot')).data.enabled, 'Whole-configuration CAS refuses a stale version without overwriting a saved rule');
  await save({ commands }); publish(); fixture.broadcast = await liveBroadcast(streamPath);
  const observer = (await joined(owner, fixture.broadcast)).socket, sender = (await joined(viewer, fixture.broadcast)).socket;
  const guest = await openSocket(streamPath); sockets.push(guest); guest.send({ type: 'join', broadcastId: fixture.broadcast.id });
  const guestState = await guest.wait(event => event.type === 'state');
  check(guestState?.connected && !guestState.authenticated && !guestState.canSend, 'The public read socket joins anonymously and has no send authority');
  const accepted = await sendMessage(sender, '  !정보  ', { isBot: true, isOwner: true, author: '가짜 봇' });
  const human = await observer.wait(event => event.type === 'message' && event.text === '!정보' && event.isBot !== true);
  const bot = await observer.wait(event => event.type === 'message' && event.isBot === true && event.text === information.response);
  check(accepted?.ok && human?.authorChannelId === fixture.viewer.channel.id && !human.isBot && human.isOwner === false && bot?.author === 'FRAME 봇'
    && !['isOwner', 'authorChannelId', 'authorHandle', 'userId'].some(key => Object.hasOwn(bot, key)), 'Accepted authenticated human chat gets its own ack and a distinct server-only bot identity');
  check((await guest.wait(event => event.type === 'message' && event.id === bot.id))?.isBot === true, 'The real anonymous WebSocket receives the same authoritative bot event');
  observer.events.length = 0; check((await sendMessage(sender, '!정보 extra'))?.ok && await noBot(observer), 'A command with extra text is accepted as human chat without matching the exact command');
  observer.events.length = 0; check((await sendMessage(guest, '!정보'))?.code === 'CHAT_LOGIN_REQUIRED' && await noBot(observer), 'An anonymous rejected send never triggers a bot response');
  await sleep(1100); observer.events.length = 0;
  check((await sendMessage(sender, '!CHAIN'))?.ok && (await observer.wait(event => event.type === 'message' && event.isBot && event.text === '!정보')) && await noBot(observer), 'Case-insensitive exact matching returns command-like text once without a recursive bot loop');
  observer.events.length = 0; check((await sendMessage(sender, '!chain'))?.ok && await noBot(observer), 'Per-rule cooldown suppresses another accepted trigger');
  await sleep(5100); observer.events.length = 0;
  const duplicateId = randomBytes(10).toString('hex'); sender.send({ type: 'send', clientId: duplicateId, text: '!once' });
  const firstAck = await sender.wait(event => event.type === 'ack' && event.clientId === duplicateId);
  check(firstAck?.ok && await observer.wait(event => event.type === 'message' && event.isBot && event.text === once.response), 'A fresh command emits one real response after cooldown');
  await sleep(5100); observer.events.length = 0; sender.send({ type: 'send', clientId: duplicateId, text: '!once' });
  const duplicateAck = await sender.wait(event => event.type === 'ack' && event.clientId === duplicateId);
  check(duplicateAck?.ok && typeof firstAck.id === 'string' && duplicateAck.id === firstAck.id && await noBot(observer), 'An accepted clientId replay returns the original ack without another bot after cooldown');
  sender.send({ type: 'send', clientId: duplicateId, text: '!second' });
  check((await sender.wait(event => event.type === 'ack' && event.clientId === duplicateId))?.ok === false && await noBot(observer), 'Reusing an accepted clientId with different text is rejected without bot output');
  await sleep(1100); observer.events.length = 0;
  const guardA = await sendMessage(sender, '!정보'), guardB = await sendMessage(sender, '!second');
  const guarded = await observer.wait(event => event.type === 'message' && event.isBot);
  check(guardA?.ok && guardB?.ok && guarded?.text === information.response && await noBot(observer), 'The room-wide spam guard suppresses a different rule sent within one second');
  await save({ enabled: false }); observer.events.length = 0;
  check((await sendMessage(sender, '!second'))?.ok && await noBot(observer), 'Disabling the global setting immediately stops live responses');
  await save({ enabled: true, commands: commands.filter(value => value.id !== second.id) }); observer.events.length = 0;
  check((await sendMessage(sender, '!second'))?.ok && await noBot(observer), 'Removing a saved rule immediately stops that command');
  check((await sendMessage(sender, '!disabled'))?.ok && await noBot(observer), 'A disabled individual rule never responds');
  const policy = (await owner.request('GET', '/me/chat/settings')).data;
  const policyBody = { version: policy.version, slowMode: false, slowSeconds: policy.slowSeconds, followersOnly: false, blockLinks: false, bannedWords: ['!deny'] };
  check((await owner.request('PATCH', '/me/chat/settings', policyBody)).status === 200, 'The real moderation policy is applied to the isolated channel');
  observer.events.length = 0; check((await sendMessage(sender, '!deny'))?.code === 'CHAT_WORD_BLOCKED' && await noBot(observer), 'Rejected banned-word commands never reach bot dispatch');
  const block = await owner.request('POST', '/me/chat/blocks', { targetChannelId: fixture.viewer.channel.id, durationSeconds: 600, reason: '챗봇 검증' });
  observer.events.length = 0; check(block.status === 201 && (await sendMessage(sender, '!once'))?.code === 'CHAT_BLOCKED' && await noBot(observer), 'A stored account block prevents human acceptance and bot dispatch');
  check((await owner.request('DELETE', `/me/chat/blocks/${block.data.item.id}?version=${block.data.item.version}`)).status === 200, 'The exact isolated account block is removed');
  const currentPolicy = (await owner.request('GET', '/me/chat/settings')).data;
  await owner.request('PATCH', '/me/chat/settings', { ...policyBody, version: currentPolicy.version, bannedWords: [] });
  const replay = await joined(viewer, fixture.broadcast), history = await replay.socket.wait(event => event.type === 'history');
  check(history?.messages?.some(value => value.id === bot.id && value.isBot === true) && history.messages.some(value => value.id === human.id && !value.isBot), 'A new authenticated reader receives authoritative human and bot history together');
  await save({ enabled: true, commands: [information, chain, once] });
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready(origin + '/_frame/', web); await browser('production'); await stop(web);
  const dev = start('web-dev', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready(origin + '/_frame/', dev); await browser('dev'); await stop(dev);
  const previousBroadcast = fixture.broadcast.id;
  await stop(publisher);
  check((await observer.wait(event => event.type === 'closed', 20000))?.type === 'closed', 'Ending the actual source closes the old room and its bot lifecycle');
  let ended = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(api + '/api/obs/' + streamPath, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
    if (response.ok && (await response.json()).broadcastId === null) { ended = true; break; }
    await sleep(150);
  }
  check(ended, 'The dedicated broadcast registry completes its stopped-source grace period');
  publish(); fixture.broadcast = await liveBroadcast(streamPath);
  check(fixture.broadcast.id !== previousBroadcast, 'Replacing the tiny source on the same path creates a distinct broadcast');
  const replacement = await joined(viewer, fixture.broadcast), replacementHistory = await replacement.socket.wait(event => event.type === 'history');
  check(replacementHistory?.messages?.length === 0, 'The replacement room starts without prior human or bot history');
  check((await sendMessage(replacement.socket, '!정보'))?.ok && await replacement.socket.wait(event => event.type === 'message' && event.isBot && event.text === information.response), 'Saved rules respond in the replacement room with a fresh room cooldown');
  check(mediaStarts === 2 && publisher.running, 'Only one tiny FFmpeg source runs at a time across lifecycle replacement');
  const beforeRestart = (await owner.request('GET', '/me/chat/bot')).data;
  await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  const afterRestart = await owner.request('GET', '/me/chat/bot');
  check(afterRestart.status === 200 && JSON.stringify(afterRestart.data) === JSON.stringify(beforeRestart), 'Saved configuration, stable UUIDs and CAS version survive an actual API restart');
  check(createHash('sha256').update(readFileSync(jar)).digest('hex') === jarHash, 'The tested backend JAR remains immutable throughout verification');
  }
  complete = true;
} catch (failure) { console.error(failure.message); process.exitCode = 1; }
finally {
  for (const socket of sockets) { socket.close(); socket.destroy(); }
  await stopAll();
  for (const mode of ['production', 'dev', 'capture']) { const profile = join(directory, 'browser-' + mode, 'profile'); killByCommandLine(profile); }
  const cleanup = []; for (const port of ports) cleanup.push({ port, free: await portFree(port) });
  if (cleanup.some(item => !item.free)) { complete = false; process.exitCode = 1; }
  writeFileSync(join(output, captureOnly ? 'chatbot-capture-e2e-result.json' : 'chatbot-e2e-result.json'), JSON.stringify({ complete, verificationDatabaseOnly: true, productionUserDataUntouched: true,
    nativeObsReceiverUntouched: true, testedJarSha256: jarHash, results, ports: cleanup, sourceStarts: mediaStarts,
    fixture: captureOnly ? 'Dedicated isolated Spring API + production React preview + headless Edge; no media publisher' : 'Dedicated MediaMTX + one 320x180 15fps H.264/AAC FFmpeg source + immutable Spring JAR + production and StrictMode React + headless Edge',
    limits: ['OBS CEF rendering was not exercised', 'Single PC and loopback only', 'No physical mobile device or load/capacity coverage'] }, null, 2));
  console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length, portsFree: cleanup.every(item => item.free) }));
}
