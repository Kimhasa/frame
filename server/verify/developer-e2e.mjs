// Dedicated local developer integration verification. Build once before running; the copied JAR is immutable.
// Credentials, receiver bodies, cookies, browser profiles and process logs stay under LOCALAPPDATA/Frame/verification.
// FRAME_DEVELOPER_PHASE=api runs the first short API pass; the default all also exercises production/dev UI and restart.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree } from './harness.mjs';
import { Client, api, origin, liveBroadcast } from './chat-moderation-client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, 'verification/product');
const phase = process.env.FRAME_DEVELOPER_PHASE ?? 'all';
if (!['api', 'all'].includes(phase)) throw Error('Unknown developer verification phase.');
const run = randomBytes(6).toString('hex'), directory = join(process.env.LOCALAPPDATA, 'Frame/verification', 'developer-' + run);
const configFile = resolve(process.env.FRAME_PRODUCT_TEST_CONFIG ?? join(process.env.LOCALAPPDATA, 'Frame/product-docker/config.json'));
if (configFile.toLowerCase().startsWith(root.toLowerCase() + '\\')) throw Error('Verification configuration must remain external.');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate guarded local verification database is required.');
const javaHome = join(process.env.LOCALAPPDATA, 'FrameTools/jdk-21.0.13+9');
if (!existsSync(join(javaHome, 'bin/java.exe'))) throw Error('Verification JDK unavailable.');
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
const jar = join(directory, 'frame-api.jar'); copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar);
const jarHash = createHash('sha256').update(readFileSync(jar)).digest('hex');
const hookUrl = 'http://127.0.0.1:19090/frame-test-hook';
const streamPath = 'obs-dev-' + run, token = randomBytes(32).toString('hex'), bin = join(root, 'dist/FrameConsole/bin');
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = { ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: '18083', RELAY_OBS_ENABLED: phase === 'all' ? 'true' : 'false', RELAY_OBS_SERVER_URL: 'rtmp://127.0.0.1:2935', RELAY_DVR: 'false',
  RELAY_PUBLISHER_TOKENS: `${token} ${streamPath}`, RELAY_PUBLIC_BASE_URL: api, RELAY_MEDIA_GRACE_MS: '5000',
  RELAY_MEDIAMTX_API: 'http://127.0.0.1:29997', RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:29888', RELAY_MEDIAMTX_RTSP: 'rtsp://127.0.0.1:29554',
  RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '', RELAY_RECORD_DIR: '', RELAY_FFMPEG: join(bin, 'ffmpeg.exe'),
  FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername, FRAME_PRODUCT_DB_PASSWORD: config.dbPassword,
  FRAME_PRODUCT_REDIS_HOST: config.redisHost, FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:developer-e2e:${run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
  FRAME_PRODUCT_WEBHOOK_LOCAL_TEST_URL: hookUrl };
const results = [], received = [], sockets = new Set();
let apiProcess, publisher, fixture, complete = false, receiverMode = 'ok', receiver;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label, duration = 45000) { const end = Date.now() + duration; while (Date.now() < end) { const value = await test(); if (value) return value; await sleep(100); } throw Error(label); }
async function ready(url, process) { await until(async () => { if (!process.running) throw Error('Owned verification process exited; see its private local log.'); return (await fetch(url).catch(() => null))?.ok; }, 'Verification service readiness timed out.'); }
async function startApi(name) { const child = start(name, join(javaHome, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory }); await ready(api + '/api/v1/session', child); return child; }
async function account(kind, consent) { const client = new Client(); await client.request('GET', '/session'); const response = await client.request('POST', '/auth/register', { email: `developer_${kind}_${run}@example.invalid`, password: randomBytes(24).toString('base64url'), displayName: '개발자 검증 ' + kind, ...consent }); if (response.status !== 201) throw Error('Dedicated account registration failed.'); return { client, user: response.data.user, channel: response.data.channel }; }
async function bearer(secret, route, { method = 'GET', body, cookie } = {}) { const response = await fetch(api + '/api/v1/integrations/' + route, { method, headers: { Authorization: 'Bearer ' + secret, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15000) }); let data; try { data = await response.json(); } catch {} return { status: response.status, data, headers: response.headers }; }
async function delivery(client, id, requestId) { return until(async () => { const response = await client.request('GET', `/me/developer/webhooks/${id}/tests/${requestId}`); const item = response.data?.item; return response.status === 200 && item && ['succeeded', 'failed', 'cancelled'].includes(item.status) ? item : null; }, 'Real webhook delivery did not reach a terminal state.', 30000); }
async function sendTest(client, id) { const clientRequestId = randomUUID(); const response = await client.request('POST', `/me/developer/webhooks/${id}/tests`, { clientRequestId }); check(response.status === 202 && response.data.item?.id, 'A real webhook test is accepted into its persisted delivery queue'); return { clientRequestId, response, item: await delivery(client, id, clientRequestId) }; }
function signed(capture, secret) { const timestamp = capture?.headers['x-frame-timestamp'], signature = capture?.headers['x-frame-signature']; if (!/^\d+$/.test(timestamp ?? '') || !/^sha256=[a-f0-9]{64}$/.test(signature ?? '')) return false; const expected = 'sha256=' + createHmac('sha256', Buffer.from(secret, 'hex')).update(timestamp + '.').update(capture.raw).digest('hex'); let payload; try { payload = JSON.parse(capture.raw); } catch { return false; } return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - Number(timestamp)) < 120 && capture.headers['content-type']?.startsWith('application/json') && capture.headers['x-frame-event-id'] === payload.id && capture.headers['x-frame-event'] === payload.event; }
async function browser(mode) { writeFileSync(join(directory, 'developer-checkpoint.json'), JSON.stringify({ owner: fixture.owner.client.saved(), other: fixture.other.client.saved(), channelId: fixture.owner.channel.id, hookUrl })); const child = start('developer-ui-' + mode, process.execPath, [join(root, 'server/verify/developer-ui.mjs'), mode], { cwd: root, env: { FRAME_DEVELOPER_TEST_DIR: directory }, logDir: directory }); await until(() => !child.running, 'Developer browser verification timed out.', 240000); const reportFile = join(output, 'developer-' + mode + '-result.json'), report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null; check(await child.exited === 0 && report?.complete && report.results?.length > 0 && report.results.every(item => item.pass), mode + ' developer browser verification passes'); }

try {
  for (const port of [18083, 5365, 19090, 9550, 9551, ...(phase === 'all' ? [2935, 29554, 29997, 29888, 29996] : [])]) if (!await portFree(port)) throw Error('A dedicated verification port is occupied: ' + port);
  receiver = createServer(async (request, response) => { if (request.url !== '/frame-test-hook' || request.method !== 'POST') { response.writeHead(404).end(); return; } const chunks = []; let length = 0; for await (const chunk of request) { length += chunk.length; if (length > 65536) { response.writeHead(413).end(); return; } chunks.push(chunk); } received.push({ headers: request.headers, raw: Buffer.concat(chunks), mode: receiverMode }); if (receiverMode === 'timeout') return; if (receiverMode === 'redirect') { response.writeHead(302, { Location: hookUrl + '?redirected=1' }).end(); return; } response.writeHead(receiverMode === 'reject' ? 422 : receiverMode === 'invalid' ? 600 : 200, { 'Content-Type': 'text/plain' }).end('fixture'); });
  receiver.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { receiver.once('error', reject); receiver.listen(19090, '127.0.0.1', resolve); });
  apiProcess = await startApi('spring');
  const policies = await new Client().request('GET', '/policies'); if (policies.status !== 200) throw Error('Registration policies unavailable.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  fixture = { owner: await account('owner', consent), other: await account('other', consent) };
  const owner = fixture.owner.client, other = fixture.other.client, anonymous = new Client(); await anonymous.request('GET', '/session');
  const defaults = await owner.request('GET', '/me/developer/keys'), hooks = await owner.request('GET', '/me/developer/webhooks');
  check(defaults.status === 200 && defaults.data.userId === fixture.owner.user.id && defaults.data.items.length === 0 && hooks.status === 200 && hooks.data.items.length === 0 && defaults.headers.get('cache-control')?.includes('no-store'), 'New developer settings are private no-store empty server results');
  check((await anonymous.request('GET', '/me/developer/keys')).status === 401 && (await owner.request('GET', '/me/developer/keys', undefined, { expectedUserId: fixture.other.user.id })).status === 409, 'Anonymous and changed-account private developer reads are rejected');
  const keyBody = { name: '실제 통합 검증 키', scopes: ['broadcast:read', 'analytics:read', 'chat:manage'], clientRequestId: randomUUID() };
  check((await owner.request('POST', '/me/developer/keys', keyBody, { csrf: false })).status === 403 && (await owner.request('POST', '/me/developer/keys', keyBody, { origin: 'https://untrusted.example.invalid' })).status === 403, 'Key issuance requires the actual CSRF token and exact owning browser Origin');
  for (const change of [{ scopes: [] }, { scopes: ['admin'] }, { name: '' }, { clientRequestId: 'bad' }]) check((await owner.request('POST', '/me/developer/keys', { ...keyBody, ...change })).status === 400, 'Invalid API-key fields are rejected before issuance (' + Object.keys(change)[0] + ')');
  const issued = await owner.request('POST', '/me/developer/keys', keyBody), secret = issued.data?.secret, key = issued.data?.item;
  check(issued.status === 201 && typeof secret === 'string' && secret.length >= 32 && key?.scopes.length === 3 && !JSON.stringify(key).includes(secret), 'API issuance returns a usable secret once and separate public metadata');
  const duplicate = await owner.request('POST', '/me/developer/keys', keyBody), receipt = await owner.request('GET', '/me/developer/keys/receipts/' + keyBody.clientRequestId), list = await owner.request('GET', '/me/developer/keys');
  check(duplicate.status === 409 && duplicate.data.code === 'ISSUE_ALREADY_PROCESSED' && receipt.status === 200 && !JSON.stringify(receipt.data).includes(secret) && !JSON.stringify(list.data).includes(secret) && list.data.items.length === 1, 'Repeated issuance reconciles one metadata-only receipt without replaying the secret');
  check((await other.request('DELETE', `/me/developer/keys/${key.id}?version=${key.version}&requestId=${randomUUID()}`)).status === 404 && (await other.request('GET', '/me/developer/keys')).data.items.length === 0, 'Another real owner cannot read or revoke the issued key');
  const broadcast = await bearer(secret, 'broadcast'), analytics = await bearer(secret, 'analytics'), chat = await bearer(secret, 'chat/settings');
  check(broadcast.status === 200 && broadcast.data.channel.id === fixture.owner.channel.id && analytics.status === 200 && chat.status === 200 && chat.data.channelId === fixture.owner.channel.id, 'The issued key authenticates three real scoped endpoints without a session cookie');
  const chatBody = { version: chat.data.version, slowMode: true, slowSeconds: 7, followersOnly: false, blockLinks: true, bannedWords: ['검증단어'] };
  const changedChat = await bearer(secret, 'chat/settings', { method: 'PATCH', body: chatBody });
  check(changedChat.status === 200 && changedChat.data.slowSeconds === 7 && (await owner.request('GET', '/me/chat/settings')).data.blockLinks, 'A scoped Bearer-only chat write changes the owning channel settings');
  const otherIssued = await other.request('POST', '/me/developer/keys', { name: '다른 소유자 통합 검증', scopes: ['broadcast:read', 'chat:manage'], clientRequestId: randomUUID() }), otherBroadcast = await bearer(otherIssued.data.secret, 'broadcast'), otherChat = await bearer(otherIssued.data.secret, 'chat/settings');
  check(otherIssued.status === 201 && otherBroadcast.status === 200 && otherBroadcast.data.channel.id === fixture.other.channel.id && otherChat.status === 200 && otherChat.data.channelId === fixture.other.channel.id && otherChat.data.blockLinks === false, 'A separately issued other-owner key remains bound to its own channel and unchanged moderation settings');
  check((await bearer(secret, 'chat/settings', { method: 'PATCH', body: chatBody })).status === 409, 'Scoped chat writes preserve the existing settings CAS contract');
  const cookie = owner.saved().cookies.map(item => `${item.name}=${item.value}`).join('; ');
  check((await bearer('invalid-key', 'broadcast', { cookie })).status === 401, 'An invalid API key never falls back to a valid session cookie');
  const cookieOnly = await fetch(api + '/api/v1/integrations/broadcast', { headers: { Cookie: cookie }, redirect: 'manual' }); await cookieOnly.arrayBuffer();
  const bearerManagement = await fetch(api + '/api/v1/me/developer/keys', { headers: { Authorization: 'Bearer ' + secret }, redirect: 'manual' }); await bearerManagement.arrayBuffer();
  check(cookieOnly.status === 401 && bearerManagement.status === 401, 'Integration authentication requires a Bearer key while credential management requires its own browser session');
  const narrow = await owner.request('POST', '/me/developer/keys', { name: '방송 전용 검증', scopes: ['broadcast:read'], clientRequestId: randomUUID() });
  check(narrow.status === 201 && (await bearer(narrow.data.secret, 'broadcast')).status === 200 && (await bearer(narrow.data.secret, 'analytics')).status === 403 && (await bearer(narrow.data.secret, 'chat/settings')).status === 403, 'A broadcast-only issued key cannot cross into analytics or chat scopes');
  const hookBody = { name: '실제 로컬 수신 검증', url: hookUrl, events: ['broadcast.started', 'broadcast.ended'], enabled: true, clientRequestId: randomUUID() };
  for (const url of ['http://127.0.0.1:19090/other', 'http://localhost:19090/frame-test-hook', 'http://169.254.169.254/latest/meta-data', 'https://user:pass@example.invalid/hook', 'file:///tmp/hook']) check((await owner.request('POST', '/me/developer/webhooks', { ...hookBody, url, clientRequestId: randomUUID() })).status === 400, 'Forbidden webhook target is rejected before queueing (' + new URL(url).protocol + ')');
  const registered = await owner.request('POST', '/me/developer/webhooks', hookBody); let hook = registered.data?.item; const signingSecret = registered.data?.signingSecret;
  check(registered.status === 201 && /^[a-f0-9]{64}$/.test(signingSecret ?? '') && hook?.url === hookUrl, 'An explicitly trusted local webhook registers with a one-time 256-bit signing secret');
  const hookReceipt = await owner.request('GET', '/me/developer/webhooks/receipts/' + hookBody.clientRequestId), hookList = await owner.request('GET', '/me/developer/webhooks');
  check((await owner.request('POST', '/me/developer/webhooks', hookBody)).status === 409 && hookReceipt.status === 200 && !JSON.stringify(hookReceipt.data).includes(signingSecret) && !JSON.stringify(hookList.data).includes(signingSecret), 'Webhook registration retries and ordinary reads never disclose the signing secret again');
  check((await other.request('GET', `/me/developer/webhooks/${hook.id}/deliveries`)).status === 404 && (await other.request('POST', `/me/developer/webhooks/${hook.id}/tests`, { clientRequestId: randomUUID() })).status === 404, 'Another real owner cannot test the webhook or inspect its private delivery history');
  const first = await sendTest(owner, hook.id), capture = received.at(-1);
  check(first.item.status === 'succeeded' && first.item.httpStatus === 200 && signed(capture, signingSecret), 'The actual receiver observes the raw body, event ID, timestamp and valid HMAC signature before persisted HTTP 200 success');
  const sentCount = received.length, repeatedTest = await owner.request('POST', `/me/developer/webhooks/${hook.id}/tests`, { clientRequestId: first.clientRequestId }); await sleep(250);
  check(repeatedTest.status === 202 && repeatedTest.data.item.id === first.item.id && received.length === sentCount, 'Repeating one test request returns its original delivery without sending another callback');
  receiverMode = 'reject'; const rejected = await sendTest(owner, hook.id);
  check(rejected.item.status === 'failed' && rejected.item.httpStatus === 422 && rejected.item.errorCode === 'HTTP_ERROR', 'An actual receiver HTTP 422 is persisted as delivery failure');
  receiverMode = 'invalid'; const invalidResponse = await sendTest(owner, hook.id);
  check(invalidResponse.item.status === 'failed' && invalidResponse.item.httpStatus === null && invalidResponse.item.errorCode === 'INVALID_RESPONSE', 'An actual invalid HTTP 600 response is persisted as a bounded invalid-response failure');
  receiverMode = 'ok'; const afterInvalidResponse = await sendTest(owner, hook.id);
  check(afterInvalidResponse.item.status === 'succeeded' && afterInvalidResponse.item.httpStatus === 200, 'The same delivery worker accepts the next real HTTP 200 after an invalid response');
  receiverMode = 'redirect'; const beforeRedirect = received.length, redirected = await sendTest(owner, hook.id); await sleep(250);
  check(redirected.item.status === 'failed' && redirected.item.httpStatus === 302 && received.length === beforeRedirect + 1, 'An actual receiver HTTP 302 is recorded without following its redirect');
  receiverMode = 'timeout'; const timed = await sendTest(owner, hook.id);
  check(timed.item.status === 'failed' && timed.item.errorCode === 'TIMEOUT', 'A real receiver that withholds its response reaches the bounded delivery timeout');
  for (const socket of sockets) socket.destroy(); receiverMode = 'ok';
  const disabled = await owner.request('PATCH', `/me/developer/webhooks/${hook.id}`, { ...hookBody, version: hook.version, enabled: false, clientRequestId: randomUUID() });
  check(disabled.status === 200 && !disabled.data.item.enabled, 'Webhook disable persists through the real versioned update API'); const oldHook = hook; hook = disabled.data.item;
  const stale = await owner.request('PATCH', `/me/developer/webhooks/${hook.id}`, { ...hookBody, version: oldHook.version, clientRequestId: randomUUID() });
  check(stale.status === 409 && stale.data.code === 'DEVELOPER_CONFLICT', 'A stale webhook version cannot overwrite a newer configuration');
  check([400, 409].includes((await owner.request('POST', `/me/developer/webhooks/${hook.id}/tests`, { clientRequestId: randomUUID() })).status), 'Disabled webhook tests are refused before outbound delivery');
  const enabled = await owner.request('PATCH', `/me/developer/webhooks/${hook.id}`, { ...hookBody, version: hook.version, clientRequestId: randomUUID() }); check(enabled.status === 200 && enabled.data.item.enabled, 'A webhook can be re-enabled with its current version'); hook = enabled.data.item;
  receiverMode = 'timeout'; const blockingId = randomUUID();
  check((await owner.request('POST', `/me/developer/webhooks/${hook.id}/tests`, { clientRequestId: blockingId })).status === 202, 'An owned receiver can hold one real in-flight request for queue cancellation checks');
  await until(() => received.at(-1)?.mode === 'timeout' && JSON.parse(received.at(-1).raw).id !== timed.item.eventId, 'Cancellation fixture did not start its held delivery.');
  const queuedId = randomUUID(), queued = await owner.request('POST', `/me/developer/webhooks/${hook.id}/tests`, { clientRequestId: queuedId });
  check(queued.status === 202 && queued.data.item.status === 'pending', 'A second real webhook test remains durably queued behind the held delivery');
  const disabledQueued = await owner.request('PATCH', `/me/developer/webhooks/${hook.id}`, { ...hookBody, version: hook.version, enabled: false, clientRequestId: randomUUID() });
  const cancelled = await delivery(owner, hook.id, queuedId);
  check(disabledQueued.status === 200 && cancelled.status === 'cancelled' && !received.some(item => JSON.parse(item.raw).id === queued.data.item.eventId), 'Disabling the webhook cancels its queued delivery before any receiver request');
  hook = disabledQueued.data.item; for (const socket of sockets) socket.destroy(); receiverMode = 'ok';
  await delivery(owner, hook.id, blockingId);
  const reenabled = await owner.request('PATCH', `/me/developer/webhooks/${hook.id}`, { ...hookBody, version: hook.version, clientRequestId: randomUUID() }); check(reenabled.status === 200, 'Queue-cancelled webhook can be enabled again with its current version'); hook = reenabled.data.item;
  const deleteFixture = await owner.request('POST', '/me/developer/webhooks', { ...hookBody, name: '삭제 대기열 검증', clientRequestId: randomUUID() });
  check(deleteFixture.status === 201, 'A second owned webhook is registered solely for the queued-delete scenario');
  receiverMode = 'timeout'; const deleteBlock = randomUUID(), beforeDeleteBlock = received.length;
  check((await owner.request('POST', `/me/developer/webhooks/${hook.id}/tests`, { clientRequestId: deleteBlock })).status === 202, 'One owned request holds the worker while deletion is tested');
  await until(() => received.length > beforeDeleteBlock, 'Queued-delete blocker did not arrive at the owned receiver.');
  const deletedHook = deleteFixture.data.item, deleteQueuedId = randomUUID(), deleteQueued = await owner.request('POST', `/me/developer/webhooks/${deletedHook.id}/tests`, { clientRequestId: deleteQueuedId });
  const deleteRequest = randomUUID(), deleted = await owner.request('DELETE', `/me/developer/webhooks/${deletedHook.id}?version=${deletedHook.version}&requestId=${deleteRequest}`), deletedDelivery = await delivery(owner, deletedHook.id, deleteQueuedId);
  check(deleteQueued.status === 202 && deleteQueued.data.item.status === 'pending' && deleted.status === 200 && deleted.data.item.revokedAtMs && deletedDelivery.status === 'cancelled' && !received.some(item => JSON.parse(item.raw).id === deleteQueued.data.item.eventId), 'Deleting a webhook cancels its queued delivery before any outbound callback');
  check((await owner.request('GET', `/me/developer/webhooks/${deletedHook.id}/mutations/${deleteRequest}`)).status === 200 && (await owner.request('POST', `/me/developer/webhooks/${deletedHook.id}/tests`, { clientRequestId: randomUUID() })).status === 409, 'Deleted webhook mutation receipts remain available while new tests stay blocked');
  for (const socket of sockets) socket.destroy(); receiverMode = 'ok'; await delivery(owner, hook.id, deleteBlock);
  check((await owner.request('DELETE', `/me/developer/keys/${key.id}?version=${key.version + 1}&requestId=${randomUUID()}`)).status === 409, 'A stale API-key revocation version cannot revoke the active key');
  const revokeId = randomUUID(), revoked = await owner.request('DELETE', `/me/developer/keys/${key.id}?version=${key.version}&requestId=${revokeId}`);
  check(revoked.status === 200 && revoked.data.item.revokedAtMs && (await bearer(secret, 'broadcast', { cookie })).status === 401, 'Revocation immediately rejects the previously working key even alongside a valid cookie');
  check((await owner.request('GET', `/me/developer/keys/${key.id}/mutations/${revokeId}`)).status === 200, 'An uncertain key revocation has a metadata-only mutation receipt');
  fixture.persistedHook = hook;
  if (phase === 'all') {
    writeFileSync(join(directory, 'mediamtx.yml'), `logLevel: warn\nlogDestinations: [stdout]\nauthMethod: internal\nauthInternalUsers:\n  - user: any\n    ips: ['127.0.0.1', '::1']\n    permissions:\n      - action: read\n      - action: api\n      - action: publish\napi: true\napiAddress: 127.0.0.1:29997\nrtsp: true\nrtspTransports: [tcp]\nrtspEncryption: "no"\nrtspAddress: 127.0.0.1:29554\nrtmp: true\nrtmpAddress: 127.0.0.1:2935\nwebrtc: false\nsrt: false\nmoq: false\nhls: true\nhlsAddress: 127.0.0.1:29888\nhlsVariant: lowLatency\nhlsSegmentDuration: 1s\nhlsPartDuration: 200ms\npathDefaults:\n  source: publisher\n  record: false\npaths:\n  all_others:\n`);
    const media = start('mediamtx', join(bin, 'mediamtx.exe'), [join(directory, 'mediamtx.yml')], { cwd: directory, logDir: directory }); await ready('http://127.0.0.1:29997/v3/paths/list', media);
    check((await owner.request('POST', '/me/channel/connection', { streamKey: `${streamPath}?user=${streamPath}&pass=${token}` })).status === 200 && (await owner.request('PUT', '/studio', { title: '개발자 웹훅 실제 방송 검증', publisher: '개발자 검증 방송자' })).status === 200, 'Only the dedicated owner connects to the isolated media source');
    const beforeLive = received.length;
    publisher = start('publisher', join(bin, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-f', 'flv', '-flvflags', 'no_duration_filesize', `rtmp://127.0.0.1:2935/${streamPath}`], { logDir: directory });
    await liveBroadcast(streamPath);
    const started = await until(() => received.slice(beforeLive).find(item => item.headers['x-frame-event'] === 'broadcast.started'), 'Actual source start did not produce an owner webhook.');
    check(signed(started, signingSecret), 'One actual low-resolution source produces an HMAC-signed owning-channel broadcast.started callback');
    await stop(publisher); publisher = null;
    const ended = await until(() => received.slice(beforeLive).find(item => item.headers['x-frame-event'] === 'broadcast.ended'), 'Actual source stop did not produce an owner webhook.', 45000);
    check(signed(ended, signingSecret) && started.headers['x-frame-event-id'] !== ended.headers['x-frame-event-id'], 'Stopping that actual source produces a separately identified signed broadcast.ended callback');
    const web = start('web-production', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'], { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory }); await ready(origin + '/_frame/', web); await browser('production'); await stop(web);
    const dev = start('web-development', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'], { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory }); await ready(origin + '/_frame/', dev); await browser('dev'); await stop(dev);
  }
  await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  const restored = await owner.request('GET', '/me/developer/webhooks'), restoredKeys = await owner.request('GET', '/me/developer/keys');
  check(restored.status === 200 && restored.data.items.some(item => item.id === hook.id && item.url === hook.url && item.version === hook.version) && restoredKeys.data.items.some(item => item.id === key.id && item.revokedAtMs), 'Redis login, webhook settings and revoked-key state survive restart of the identical JAR');
  check((await bearer(narrow.data.secret, 'broadcast')).status === 200 && (await bearer(secret, 'broadcast')).status === 401, 'Stored active-key authentication and immediate revocation remain correct after restart');
  const restoredLogs = await owner.request('GET', `/me/developer/webhooks/${hook.id}/deliveries`);
  check(restoredLogs.status === 200 && restoredLogs.data.items.some(item => item.id === first.item.id && item.status === 'succeeded') && restoredLogs.data.items.some(item => item.id === timed.item.id && item.errorCode === 'TIMEOUT') && !JSON.stringify(restoredLogs.data).includes(signingSecret), 'Actual success and timeout delivery logs survive restart without secrets or raw callback bodies');
  check(createHash('sha256').update(readFileSync(jar)).digest('hex') === jarHash, 'Every API lifecycle uses the same immutable copied JAR');
  complete = true;
} catch (failure) { writeFileSync(join(directory, 'failure.txt'), failure.stack ?? String(failure)); console.error(failure.message); if (!results.some(item => item.name === failure.message && !item.pass)) results.push({ name: failure.message, pass: false }); process.exitCode = 1; }
finally { if (publisher) await stop(publisher); await stopAll(); for (const socket of sockets) socket.destroy(); if (receiver) await new Promise(resolve => receiver.close(resolve)); writeFileSync(join(output, 'developer-' + (phase === 'api' ? 'api' : 'e2e') + '-result.json'), JSON.stringify({ complete, phase, verificationDatabaseOnly: true, productionUserDataUntouched: true, currentReceiverUntouched: true, singleImmutableJar: true, trustedReceiver: hookUrl, results, actualReceiverRequestCount: received.length, limits: ['Single Windows PC and loopback only', 'Receiver requests use only the exact explicitly configured local test endpoint', 'DNS classification, DNS pinning and rebinding defenses require the separate sender unit checks', 'API key hashing at rest requires the separate guarded database inspection', ...(phase === 'api' ? ['This incremental phase does not run browser or real broadcast-event verification'] : ['Mobile viewports are emulated; no physical device or public HTTPS provider tested'])] }, null, 2)); console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length })); }
