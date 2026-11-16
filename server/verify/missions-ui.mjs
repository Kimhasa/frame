// Real private viewer proposals and broadcaster mission transitions, against the separate verification API only.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { Client, api, origin, liveBroadcast } from './missions-client.mjs';

const suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url'), output = path.resolve('verification/product');
const directory = path.resolve(process.env.FRAME_MISSIONS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_MISSIONS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external mission fixture directory is required.');
const fixtureStreamKey = process.env.FRAME_MISSIONS_FIXTURE_STREAM_KEY, fixturePath = fixtureStreamKey?.split('?')[0];
if (!fixtureStreamKey || !/^obs-mission-[0-9a-f]{12}$/.test(fixturePath ?? '')) throw Error('The dedicated isolated mission stream credential is required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), 'frame-missions-ui-')), profile = path.join(browserDirectory, 'profile');
const results = [], errors = [], writes = [], confirmedCanceledInterceptions = [], interactions = [], responses = [], privateHeaders = [];
const interceptedRequests = new Map(), canceledNetworkRequests = new Set(), pendingInterceptions = new Set();
let page, nextFailure, holdMutation = false, heldMutation, pageLimit = false, responseFailure = false, committedResponse = null, submittedBody = null, offlineState = null;
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--remote-debugging-port=9550', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
await marker('browser-owner.json', { pid: browser.pid, profile });
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, parameters) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__missionQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, parameters);
  await until(async () => { try { return await page.evaluate(`window.__missionQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New mission document');
}
async function pauseWatchMedia() {
  // This verifies missions, not viewing rewards: the small publisher stays live, but no watch time is earned.
  await page.evaluate(`(() => {if(!location.pathname.includes('/watch/'))return;document.addEventListener('play',event=>{if(event.target instanceof HTMLVideoElement)event.target.pause();},true);document.querySelectorAll('video').forEach(video=>video.pause());})()`);
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); await pauseWatchMedia(); }
async function reload() { await navigateDocument('Page.reload', {}); await pauseWatchMedia(); }
async function click(selector) {
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control: ' + selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector);
}
async function button(label, scope = 'document') {
  await until(() => page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});return !!element&&!element.matches(':disabled');})()`), 'Enabled button: ' + label);
  await page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});element.dataset.missionQaTarget='true';element.scrollIntoView({block:'center'});})()`);
  await until(() => page.evaluate(`(() => {const element=document.querySelector('[data-mission-qa-target]');if(!element||element.matches(':disabled'))return false;const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===element;})()`), 'Clickable button: ' + label);
  interactions.push({ label, phase: 'before', ...(await snapshot()) }); await page.click('[data-mission-qa-target]');
  interactions.push({ label, phase: 'after', ...(await snapshot()) }); if (interactions.length > 30) interactions.splice(0, interactions.length - 30);
  await page.evaluate(`document.querySelector('[data-mission-qa-target]')?.removeAttribute('data-mission-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function snapshot() {
  return page.evaluate(`(() => {const e=document.querySelector('[data-mission-qa-target]'),r=e?.getBoundingClientRect();return {path:location.pathname,visibility:document.visibilityState,focused:document.hasFocus(),dialogOpen:!!document.querySelector('dialog[open]'),target:e?{disabled:e.matches(':disabled'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:null};})()`);
}
async function interceptionCommand(command, parameters) {
  const request = interceptedRequests.get(parameters.requestId);
  try { return await page.send(command, parameters); }
  catch (failure) {
    if (/Invalid InterceptionId\.?/.test(failure.message) && request?.networkId) {
      if (!canceledNetworkRequests.has(request.networkId)) await sleep(100);
      if (canceledNetworkRequests.has(request.networkId)) { confirmedCanceledInterceptions.push({ method: request.method, path: request.path, command, confirmedBy: 'Network.loadingFailed:canceled' }); return; }
    }
    failure.missionQaContext = { source: 'Fetch', method: request?.method ?? null, path: request?.path ?? null, command, hasNetworkId: Boolean(request?.networkId), error: failure.message }; throw failure;
  } finally { interceptedRequests.delete(parameters.requestId); }
}
async function fulfill(requestId, failure) {
  await interceptionCommand('Fetch.fulfillRequest', { requestId, responseCode: failure.status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify({ code: failure.code, detail: failure.detail })).toString('base64') });
}
async function intercept(event) {
  const { requestId, request } = event.params, url = new URL(request.url);
  const responseStage = event.params.responseStatusCode !== undefined || event.params.responseErrorReason !== undefined;
  interceptedRequests.set(requestId, { networkId: event.params.networkId, method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id'), phase: responseStage ? 'response' : 'request' });
  if (responseStage) {
    if (responseFailure && request.method === 'POST' && url.pathname === '/api/v1/missions') {
      responseFailure = false; committedResponse = { status: event.params.responseStatusCode, body: submittedBody };
      await fulfill(requestId, { status: 503, code: 'PRODUCT_UNAVAILABLE', detail: '미션 제안 결과를 확인하지 못했어요.' }); return;
    }
    await interceptionCommand('Fetch.continueRequest', { requestId }); return;
  }
  const expectedHeader = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-frame-user-id')?.[1];
  if (url.pathname.startsWith('/api/v1/me/missions') || request.method !== 'GET') privateHeaders.push(Boolean(expectedHeader));
  if (request.method !== 'GET') writes.push({ method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') });
  if (request.method === 'POST' && url.pathname === '/api/v1/missions') submittedBody = JSON.parse(request.postData);
  if (nextFailure?.matches(request.method, url)) { const failure = nextFailure; nextFailure = null; await fulfill(requestId, failure); return; }
  if (holdMutation && request.method !== 'GET') { heldMutation = requestId; return; }
  if (pageLimit && request.method === 'GET' && url.pathname === '/api/v1/me/missions') { url.searchParams.set('limit', '2'); await interceptionCommand('Fetch.continueRequest', { requestId, url: url.href }); return; }
  await interceptionCommand('Fetch.continueRequest', { requestId });
}
const failure503 = (method, endpoint, detail, cursor = false) => ({ status: 503, code: 'PRODUCT_UNAVAILABLE', detail, matches: (actual, url) => actual === method && url.pathname === '/api/v1' + endpoint && (!cursor || url.searchParams.has('cursor')) });
async function createAccount(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const email = `missions_ui_${kind}_${suffix}@example.invalid`, displayName = `미션 검증 ${kind} ${suffix}`;
  const response = await client.request('POST', '/auth/register', { email, password, displayName, ...consent });
  if (response.status !== 201) throw Error('Dedicated mission account registration returned HTTP ' + response.status);
  return { client, email, displayName, user: response.data.user, channel: response.data.channel };
}
async function login(account) {
  await page.send('Network.clearBrowserCookies'); await nav('/login'); await has('#account-email');
  await set('[name=email]', account.email); await set('[name=password]', password); await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
}
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, name), await page.screenshot()); }
async function marker(name, value) { const target = path.join(directory, name), temporary = target + '.tmp'; await writeFile(temporary, JSON.stringify(value)); await rename(temporary, target); }
async function waitMarker(name) { for (let i = 0; i < 600; i++) { try { await access(path.join(directory, name)); return; } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } await sleep(100); } throw Error('Timeout waiting for the owned source marker.'); }
function history(item, statuses, actors) {
  return item && item.version === statuses.length - 1 && item.history.length === statuses.length && item.history.length <= 3
    && item.history.every((entry, index) => entry.status === statuses[index] && entry.actor === actors[index]
      && (index === 0 || entry.createdAtMs >= item.history[index - 1].createdAtMs))
    && item.history.at(-1).status === item.status && item.deadlineAtMs === item.createdAtMs + item.durationMinutes * 60000;
}
const ownerDialog = 'document.querySelector("dialog[open]")';
try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9550, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Mission QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.loadingFailed' && event.params.canceled === true) canceledNetworkRequests.add(event.params.requestId);
    if (event.method === 'Network.responseReceived') { const url = new URL(event.params.response.url); if (url.pathname.startsWith('/api/v1/me/missions')) responses.push({ url, status: event.params.response.status }); }
    if (event.method === 'Fetch.requestPaused') { const pending = intercept(event).catch(failure => errors.push(failure.missionQaContext ?? failure.message)); pendingInterceptions.add(pending); void pending.finally(() => pendingInterceptions.delete(pending)); }
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const bootstrap = new Client(), policies = await bootstrap.request('GET', '/policies');
  if (policies.status !== 200) throw Error('Signup policies are unavailable in the isolated app.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  const owner = await createAccount('owner', consent), asker = await createAccount('asker', consent), other = await createAccount('other', consent), restricted = await createAccount('restricted', consent);
  const connection = await owner.client.request('POST', '/me/channel/connection', { streamKey: fixtureStreamKey });
  if (connection.status !== 200) throw Error('Dedicated mission stream connection returned HTTP ' + connection.status);
  await owner.client.request('PUT', '/studio', { title: `함께 도전하는 무료 미션 ${suffix}`, publisher: owner.displayName });
  await marker('ready-live.json', { path: fixturePath }); let broadcast = await liveBroadcast(fixturePath);
  const current = (client, item = broadcast, query = {}) => client.request('GET', '/missions/current?' + new URLSearchParams({ path: fixturePath, broadcastId: item.id, ...query }));
  const body = (title, description = '', durationMinutes = 15) => ({ path: fixturePath, broadcastId: broadcast.id, title, description, durationMinutes, clientRequestId: randomUUID() });
  async function submit(client, title, description = '', durationMinutes = 15) { const result = await client.request('POST', '/missions', body(title, description, durationMinutes)); if (result.status !== 201) throw Error('Real mission proposal returned HTTP ' + result.status); return result.data.item; }
  const detail = id => owner.client.request('GET', `/me/missions/${id}`);
  const patch = (item, status, reason = '') => owner.client.request('PATCH', `/me/missions/${item.id}`, { version: item.version, status, reason });
  await until(async () => (await current(owner.client)).data?.canSubmit === true, 'Real active mission broadcast');
  const invalidBodies = [{ ...body(''), title: '' }, { ...body('기한 검증'), durationMinutes: 10 }, { ...body('유료 미션 거부'), amount: 1000 }, { ...body('가'.repeat(101)) }];
  const invalidResults = await Promise.all(invalidBodies.map(input => asker.client.request('POST', '/missions', input)));
  check(invalidResults.every(result => result.status === 400 && result.data.code === 'INVALID_MISSION_INPUT') && (await current(asker.client)).data.mine.length === 0, 'Invalid titles, durations and payment fields are rejected without saving or charging a mission quota');
  const firstBody = body(`첫 번째 도전 ${suffix}`, '진행 과정도 함께 설명해 주세요.\n차근차근 도전해요.', 30);
  const duplicates = await Promise.all([asker.client.request('POST', '/missions', firstBody), asker.client.request('POST', '/missions', firstBody)]), first = duplicates.find(result => result.status === 201)?.data.item;
  check(first && duplicates.filter(result => result.status === 201).length === 1 && duplicates.filter(result => result.status === 200).length === 1 && duplicates.every(result => result.data.item.id === first.id)
    && history(first, ['received'], ['viewer']), 'Concurrent retries of the same account UUID create one received mission and one initial history event');
  const changed = await asker.client.request('POST', '/missions', { ...firstBody, title: '동일 요청의 다른 제목' });
  check(changed.status === 409 && changed.data.code === 'MISSION_REQUEST_CONFLICT', 'A request UUID cannot silently replace its original canonical mission proposal');
  const anonymous = new Client(); await anonymous.request('GET', '/session');
  const guest = await current(anonymous), foreign = await current(other.client), mine = await current(asker.client), foreignDetail = await other.client.request('GET', `/me/missions/${first.id}`), anonymousPost = await anonymous.request('POST', '/missions', body('익명 미션'));
  check(guest.status === 200 && guest.data.userId === null && guest.data.mine.length === 0 && guest.data.reason === 'login_required' && foreign.data.mine.length === 0
    && mine.data.mine.length === 1 && mine.data.mine[0].clientRequestId === firstBody.clientRequestId && foreignDetail.status === 404 && anonymousPost.status === 401
    && Object.keys(first.author).sort().join(',') === 'channelId,displayName,handle', 'Only the proposal author and channel owner receive private missions, without internal account identifiers');
  const guarded = await other.client.request('GET', '/me/missions', undefined, { expectedUserId: owner.user.id });
  const noCsrf = await asker.client.request('POST', '/missions', body('CSRF 미션'), { csrf: false });
  check(guarded.status === 409 && guarded.data.code === 'SESSION_CHANGED' && !guarded.data.items && noCsrf.status === 403, 'Private mission calls enforce expected account scope and authenticated mutations require CSRF');
  const second = await submit(asker.client, `취소할 제안 ${suffix}`), third = await submit(asker.client, `거절할 제안 ${suffix}`);
  const limited = await asker.client.request('POST', '/missions', body('네 번째 새 미션')), limitedView = (await current(asker.client)).data;
  check(limited.status === 429 && limited.data.code === 'MISSION_RATE_LIMITED' && Number(limited.headers.get('retry-after')) > 0 && limitedView.mine.length === 3
    && !limitedView.canSubmit && limitedView.reason === 'rate_limited' && limitedView.retryAfterMs > 0, 'Three accepted proposals consume the account minute quota and a fourth returns its real retry interval');
  async function settings(values) { const existing = (await owner.client.request('GET', '/me/chat/settings')).data; return owner.client.request('PATCH', '/me/chat/settings', { version: existing.version, slowMode: existing.slowMode, slowSeconds: existing.slowSeconds, followersOnly: existing.followersOnly, blockLinks: existing.blockLinks, bannedWords: existing.bannedWords, ...values }); }
  await settings({ followersOnly: true, slowMode: true, slowSeconds: 120, blockLinks: true, bannedWords: ['금칙어'] });
  const followDenied = await restricted.client.request('POST', '/missions', body('팔로우 전 미션'));
  await restricted.client.request('PUT', `/me/follows/${owner.channel.id}`, {});
  const blocked = await owner.client.request('POST', '/me/chat/blocks', { targetChannelId: restricted.channel.id, durationSeconds: null, reason: '미션 참여 권한 검증' });
  const blockDenied = await restricted.client.request('POST', '/missions', body('차단된 계정의 미션'));
  await owner.client.request('DELETE', `/me/chat/blocks/${blocked.data.item.id}?version=${blocked.data.item.version}`);
  const wordDenied = await restricted.client.request('POST', '/missions', body('제목', '금칙어가 포함된 설명'));
  const linkDenied = await restricted.client.request('POST', '/missions', body('제목', 'https://example.invalid 주소'));
  const unicodeLinkDenied = await restricted.client.request('POST', '/missions', body('제목', 'example.한국 주소'));
  const deadlineFixture = await submit(restricted.client, `기한 만료 검증 ${suffix}`), sourceFixture = await submit(restricted.client, `방송 종료 검증 ${suffix}`);
  check(followDenied.status === 403 && followDenied.data.code === 'MISSION_FOLLOW_REQUIRED' && blockDenied.status === 403 && blockDenied.data.code === 'MISSION_PARTICIPATION_BLOCKED'
    && wordDenied.status === 400 && wordDenied.data.code === 'MISSION_WORD_BLOCKED' && linkDenied.status === 400 && linkDenied.data.code === 'MISSION_LINK_BLOCKED'
    && unicodeLinkDenied.status === 400 && unicodeLinkDenied.data.code === 'MISSION_LINK_BLOCKED' && (await current(restricted.client)).data.mine.length === 2,
    'Stored follow, block, word and Unicode-link rules reject new missions without consuming quota or applying the 120-second chat slow timer');
  await settings({ followersOnly: false, slowMode: false, blockLinks: false, bannedWords: [] });
  const invalidTransition = await patch(second, 'completed', '접수 상태에서는 완료 불가'), missingReason = await patch(third, 'rejected');
  check(invalidTransition.status === 409 && invalidTransition.data.code === 'MISSION_INVALID_TRANSITION' && missingReason.status === 400 && (await detail(second.id)).data.item.version === 0,
    'The server requires terminal reasons and prevents skipping directly from received to completed');
  const running = (await patch(first, 'running')).data.item, stale = await patch(first, 'rejected', '오래된 화면');
  check(history(running, ['received', 'running'], ['viewer', 'owner']) && running.deadlineAtMs === first.deadlineAtMs && stale.status === 409 && stale.data.code === 'MISSION_CONFLICT', 'Starting a mission preserves its fixed deadline and an old version cannot overwrite the owner transition');
  const cancelRunning = await asker.client.request('POST', `/missions/${running.id}/cancel`, { version: running.version });
  const completed = (await patch(running, 'completed', `도전을 완료했어요 ${suffix}`)).data.item, terminalChange = await patch(completed, 'failed', '완료 후 변경');
  check(cancelRunning.status === 409 && terminalChange.status === 409 && history(completed, ['received', 'running', 'completed'], ['viewer', 'owner', 'owner'])
    && (await current(asker.client)).data.mine.find(item => item.id === completed.id).reason === completed.reason, 'Only the broadcaster can finish a running mission; terminal state and its three private history events remain immutable');
  const canceled = await asker.client.request('POST', `/missions/${second.id}/cancel`, { version: second.version });
  const repeatedCancel = await asker.client.request('POST', `/missions/${second.id}/cancel`, { version: canceled.data.item.version });
  const rejected = (await patch(third, 'rejected', `이번 방송에서는 진행하기 어려워요 ${suffix}`)).data.item;
  check(canceled.status === 200 && repeatedCancel.status === 409 && history(canceled.data.item, ['received', 'canceled'], ['viewer', 'viewer']) && history(rejected, ['received', 'rejected'], ['viewer', 'owner']), 'A viewer can cancel only a received proposal, while owner rejection stores a mandatory reason and exactly one terminal event');
  execFileSync(process.execPath, ['server/verify/missions-fixture.mjs', 'expire', deadlineFixture.id], { env: { ...process.env }, windowsHide: true, stdio: 'pipe', timeout: 15000 });
  const expireCommand = await patch(deadlineFixture, 'running'), expired = (await detail(deadlineFixture.id)).data.item;
  check(expireCommand.status === 409 && expireCommand.data.code === 'MISSION_EXPIRED' && history(expired, ['received', 'expired'], ['viewer', 'system'])
    && expired.history.at(-1).createdAtMs === expired.deadlineAtMs && (await detail(expired.id)).data.item.history.length === 2,
    'A controlled verify-database deadline fixture expires durably before a rejected command, with one event at the deadline; no real fifteen-minute wait is claimed');
  const sourceRunning = (await patch(sourceFixture, 'running', '실제 송출 종료 확인')).data.item;
  const oldReceived = await submit(other.client, `종료 전 접수 ${suffix}`), oldBroadcast = broadcast;
  await marker('replace-live.json', { previousBroadcastId: oldBroadcast.id }); await waitMarker('replaced-live.json'); broadcast = await liveBroadcast(fixturePath, oldBroadcast.id);
  await until(async () => (await current(owner.client)).data?.canSubmit === true, 'Replacement mission broadcast');
  const endedRunning = (await detail(sourceRunning.id)).data.item, endedReceived = (await detail(oldReceived.id)).data.item;
  const oldView = (await current(asker.client, oldBroadcast)).data, newView = (await current(asker.client)).data;
  const oldPost = await other.client.request('POST', '/missions', { ...body('종료 방송의 새 미션'), broadcastId: oldBroadcast.id });
  check(history(endedRunning, ['received', 'running', 'expired'], ['viewer', 'owner', 'system']) && history(endedReceived, ['received', 'expired'], ['viewer', 'system'])
    && !endedRunning.broadcastActive && oldView.mine.length === 3 && !oldView.canSubmit && newView.mine.length === 0 && oldPost.status === 409 && oldPost.data.code === 'MISSION_BROADCAST_UNAVAILABLE',
    'An actual stopped and replaced same-path media source expires open missions, preserves old private history and isolates the new broadcast');
  const receiptBlock = await owner.client.request('POST', '/me/chat/blocks', { targetChannelId: asker.channel.id, durationSeconds: null, reason: '기존 접수증 확인 권한 검증' });
  const oldReceipt = await asker.client.request('POST', '/missions', firstBody);
  check(oldReceipt.status === 200 && oldReceipt.data.item.id === first.id && (await current(asker.client, oldBroadcast)).data.mine.length === 3, 'An existing request UUID confirms its original receipt after broadcast closure and participant blocking without another proposal');
  await owner.client.request('DELETE', `/me/chat/blocks/${receiptBlock.data.item.id}?version=${receiptBlock.data.item.version}`);
  const invalidCursor = await owner.client.request('GET', '/me/missions?cursor=invalid'), invalidDates = await owner.client.request('GET', '/me/missions?from=2026-11-17&to=2026-11-16');
  const kstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), dated = await owner.client.request('GET', '/me/missions?' + new URLSearchParams({ status: 'completed', q: suffix, from: kstToday, to: kstToday }));
  check(invalidCursor.status === 400 && invalidCursor.data.code === 'INVALID_MISSION_CURSOR' && invalidDates.status === 400 && dated.status === 200 && dated.data.items.some(item => item.id === first.id), 'Opaque cursor and date validation reject malformed filters while an inclusive KST day finds real stored missions');
  const editorMission = await submit(owner.client, `화면에서 완료할 미션 ${suffix}`, '미션의 상태와 입력 보존을 확인해요.');
  const conflictMission = await submit(owner.client, `동시 변경 확인 ${suffix}`), editableMission = await submit(owner.client, `재시작 보존 확인 ${suffix}`);
  const wallets = await Promise.all([owner, asker, other, restricted].map(account => account.client.request('GET', '/me/points?' + new URLSearchParams({ channelId: owner.channel.id, limit: '100' }))));
  check(wallets.every(result => result.status === 200 && result.data.balance === 0 && result.data.items.length === 0), 'All real mission acceptance, rejection, cancellation, completion and expiry operations leave every account point balance and ledger empty');
  const requestPatterns = [{ urlPattern: '*api/v1/me/missions*' }, { urlPattern: '*api/v1/missions*' }];
  await page.send('Fetch.enable', { patterns: requestPatterns }); await login(owner); pageLimit = true;
  nextFailure = failure503('GET', '/me/missions', '미션 목록을 불러오지 못했어요.'); await nav('/studio/missions'); await visibleText('미션 목록을 불러오지 못했어요'); await button('목록 다시 시도');
  const rows = () => page.evaluate(`Array.from(document.querySelectorAll('table[aria-label="미션 목록"] tbody tr')).map(row=>row.dataset.missionId)`);
  await until(async () => (await rows()).length === 2, 'Two received mission rows');
  nextFailure = failure503('GET', '/me/missions', '다음 미션 목록을 확인하지 못했어요.', true); await button('더 불러오기'); await visibleText('다음 미션 목록을 확인하지 못했어요'); await button('더 불러오기 다시 시도'); await until(async () => (await rows()).length === 3, 'Real mission cursor page');
  check((await rows()).length === 3 && new Set(await rows()).size === 3, 'Owner list and cursor failures are recoverable and append actual server pages without duplicate missions');
  async function searchMission(item, status = 'received') {
    await nav('/studio/missions?' + new URLSearchParams({ tab: status })); await has('[name=mission-query]');
    const after = responses.length; await set('[name=mission-query]', item.title); await button('검색', 'document.querySelector("[name=mission-query]").form');
    await until(async () => responses.slice(after).some(response => response.status === 200 && response.url.pathname === '/api/v1/me/missions' && response.url.searchParams.get('q') === item.title && response.url.searchParams.get('status') === status)
      && await page.evaluate(`new URLSearchParams(location.search).get('q')===${JSON.stringify(item.title)}&&!document.querySelector('[aria-label="미션 목록 새로고침"]')?.disabled&&document.querySelectorAll('table tbody tr[data-mission-id]').length===1&&document.querySelector('table tbody tr')?.dataset.missionId===${JSON.stringify(item.id)}`), 'Settled real mission search');
  }
  await searchMission(editorMission);
  check((await rows())[0] === editorMission.id, 'Owner search waits for its matching real response and final row instead of filtering only the current cursor page');
  await click(`tr[data-mission-id="${editorMission.id}"] button`); await has('dialog [name=mission-reason]');
  check(await page.evaluate(`document.querySelector('dialog h2')?.textContent==='미션 상세'&&document.activeElement===document.querySelector('dialog h2')`), 'The requested mission detail opens with its heading focused');
  const beforeInvalid = writes.length; await set('dialog [name=mission-status]', 'rejected'); await button('상태 변경', ownerDialog); await visibleText('상태 변경 사유를 입력해 주세요');
  check(writes.length === beforeInvalid && await page.evaluate(`document.activeElement.name==='mission-reason'`), 'An empty terminal reason is rejected locally and focuses its field without a write');
  const startReason = `화면에서 도전을 시작해요.\n진행 과정도 공유할게요 ${suffix}`;
  await set('dialog [name=mission-status]', 'running'); await set('dialog [name=mission-reason]', startReason);
  nextFailure = failure503('PATCH', `/me/missions/${editorMission.id}`, '미션 상태를 변경하지 못했어요. 입력한 내용은 유지돼요.'); await button('상태 변경', ownerDialog); await visibleText('미션 상태를 변경하지 못했어요');
  check(await page.evaluate(`document.querySelector('dialog [name=mission-reason]').value===${JSON.stringify(startReason)}&&document.querySelector('dialog [name=mission-status]').value==='running'`), 'A failed owner write preserves the complete multiline reason and selected status');
  holdMutation = true; const beforeStart = writes.length; await button('상태 변경', ownerDialog); await until(() => Boolean(heldMutation), 'Held mission start'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeStart + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog fieldset').disabled&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'A pending owner mutation locks all controls, prevents Escape dismissal and sends only one request');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('진행 중 상태로 변경했어요');
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')&&document.activeElement.getAttribute('role')==='status'`), 'Focused start acknowledgement');
  const savedRunning = (await detail(editorMission.id)).data.item;
  check(history(savedRunning, ['received', 'running'], ['viewer', 'owner']) && savedRunning.reason === startReason, 'A confirmed owner start stores one transition and focuses the acknowledgement after closing the editor');
  await searchMission(savedRunning, 'running'); await click(`tr[data-mission-id="${savedRunning.id}"] button`); await has('dialog [name=mission-reason]');
  const terminalReason = `목표를 달성했어요.\n함께해 주셔서 감사합니다 ${suffix}`; await set('dialog [name=mission-reason]', terminalReason); await button('상태 변경', ownerDialog); await visibleText('완료 상태로 변경했어요');
  const terminal = (await detail(editorMission.id)).data.item;
  check(history(terminal, ['received', 'running', 'completed'], ['viewer', 'owner', 'owner']) && terminal.reason === terminalReason, 'The UI completes a running mission with its real reason and exactly three chronological history events');
  await screenshot('missions-owner-ui.png');
  await searchMission(conflictMission); await click(`tr[data-mission-id="${conflictMission.id}"] button`); await has('dialog [name=mission-reason]');
  const conflictDraft = `내가 작성하던 거절 사유 ${suffix}`; await set('dialog [name=mission-status]', 'rejected'); await set('dialog [name=mission-reason]', conflictDraft);
  const external = (await patch(conflictMission, 'running', '다른 창에서 수락했어요.')).data.item; await button('상태 변경', ownerDialog); await visibleText('최신 상태 불러오기');
  check(await page.evaluate(`document.querySelector('dialog [name=mission-reason]').value===${JSON.stringify(conflictDraft)}&&document.querySelector('dialog button[type=submit]').disabled`), 'A real competing version preserves the draft and prevents automatic stale resubmission');
  await button('최신 상태 불러오기', ownerDialog); await button('입력 유지', ownerDialog);
  check(await page.evaluate(`document.querySelector('dialog [name=mission-reason]').value===${JSON.stringify(conflictDraft)}`), 'Declining the latest-state confirmation retains the owner draft');
  await button('최신 상태 불러오기', ownerDialog); await button('불러오기', ownerDialog); await until(() => page.evaluate(`document.querySelector('dialog [name=mission-status]')?.value==='completed'&&document.querySelector('dialog [name=mission-reason]')?.value===''&&document.querySelectorAll('dialog [aria-label="미션 상태 변경 이력"] li').length===2`), 'Explicit latest running mission');
  check((await detail(conflictMission.id)).data.item.version === external.version, 'Only explicit confirmation replaces a conflicting draft with the latest real running state');
  for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`(() => {const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1;})()`), `The owner mission detail and fields fit the ${width}px viewport`); }
  await screenshot('missions-owner-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await button('닫기', ownerDialog); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Owner detail closes');
  check(await page.evaluate(`document.activeElement.closest('tr')?.dataset.missionId===${JSON.stringify(conflictMission.id)}`), 'Closing the mission detail returns focus to its original row action');
  const watchRoute = `/watch/${fixturePath}/${broadcast.id}`;
  await page.send('Network.clearBrowserCookies'); await nav(watchRoute); await has('[aria-label="무료 미션 열기"]'); await click('[aria-label="무료 미션 열기"]'); await has('dialog[open]');
  check(await page.evaluate(`!document.querySelector('dialog li[data-mission-id]')&&!document.querySelector('dialog').innerText.includes(${JSON.stringify(firstBody.title)})`), 'An anonymous mission panel contains no private proposal title or history');
  await button('로그인하고 미션 제안', ownerDialog); await has('#account-email');
  check(await page.evaluate(`new URLSearchParams(location.search).get('returnTo')===${JSON.stringify(watchRoute)}`), 'Mission login preserves the exact current broadcast return route');
  await login(other); await nav(watchRoute); await has('[aria-label="무료 미션 열기"]'); await click('[aria-label="무료 미션 열기"]'); await has('dialog [name=viewer-mission-title]');
  const beforeTitleError = writes.length; await set('dialog [name=viewer-mission-title]', '가'.repeat(101)); await button('미션 제안하기', ownerDialog); await visibleText('미션 제목을 1~100자로');
  check(writes.length === beforeTitleError && await page.evaluate(`document.activeElement.name==='viewer-mission-title'`), 'An oversized viewer title is rejected locally and focuses the title input');
  const viewerTitle = `함께 도전하고 싶은 미션 ${suffix}`, viewerDescription = `한 단계씩 목표를 달성해 주세요.\n진행 방법도 알려 주세요 ${suffix}`;
  await set('dialog [name=viewer-mission-title]', viewerTitle); await set('dialog [name=viewer-mission-description]', viewerDescription); await set('dialog [name=viewer-mission-duration]', '30');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await page.evaluate(`window.dispatchEvent(new Event('offline'))`);
  await until(async () => {
    offlineState = await page.evaluate(`({online:navigator.onLine,disabled:document.querySelector('dialog button[type=submit]')?.disabled,hasOfflineHint:document.querySelector('dialog').innerText.includes('인터넷 연결을 확인해 주세요.'),titleMatches:document.querySelector('dialog [name=viewer-mission-title]').value===${JSON.stringify(viewerTitle)},descriptionMatches:document.querySelector('dialog [name=viewer-mission-description]').value===${JSON.stringify(viewerDescription)},durationMatches:document.querySelector('dialog [name=viewer-mission-duration]').value==='30'})`);
    return !offlineState.online && offlineState.disabled && offlineState.hasOfflineHint;
  }, 'Committed offline send lock and guidance');
  check(!offlineState.online && offlineState.disabled && offlineState.titleMatches && offlineState.descriptionMatches && offlineState.durationMatches, 'Going offline preserves the complete viewer draft and disables sending');
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await page.evaluate(`window.dispatchEvent(new Event('online'))`); await until(() => page.evaluate(`!document.querySelector('dialog button[type=submit]')?.disabled`), 'Actual online eligibility refresh');
  nextFailure = failure503('POST', '/missions', '미션 제안 결과를 확인하지 못했어요.'); await button('미션 제안하기', ownerDialog); await visibleText('결과를 확인하지 못했어요');
  const retryBody = { ...submittedBody };
  check(await page.evaluate(`document.querySelector('dialog [name=viewer-mission-title]').value===${JSON.stringify(viewerTitle)}&&document.querySelector('dialog [name=viewer-mission-title]').readOnly&&document.querySelector('dialog [name=viewer-mission-description]').value===${JSON.stringify(viewerDescription)}&&document.querySelector('dialog [name=viewer-mission-duration]').disabled`)
    && (await current(other.client)).data.mine.length === 0, 'An unknown submission failure freezes the exact title, description and duration without inventing a receipt');
  holdMutation = true; const beforeProposal = writes.length; await button('제안 다시 확인', ownerDialog); await until(() => Boolean(heldMutation), 'Held proposal retry'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeProposal + 1 && JSON.stringify(submittedBody) === JSON.stringify(retryBody) && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'An uncertain retry sends the original body and UUID once while pending controls prevent duplicate submission or Escape');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('미션을 제안했어요');
  const firstViewer = (await current(other.client)).data.mine[0];
  check(firstViewer.title === viewerTitle && firstViewer.description === viewerDescription && firstViewer.durationMinutes === 30 && firstViewer.clientRequestId === retryBody.clientRequestId
    && await page.evaluate(`document.activeElement.getAttribute('role')==='status'&&document.querySelectorAll('dialog li[data-mission-id]').length===1`), 'A confirmed real proposal appears once in private history and focuses the acknowledgement');
  await button('미션 제안', 'document.querySelector("dialog nav")'); await has('dialog [name=viewer-mission-title]');
  const secondTitle = `응답 유실 접수 확인 ${suffix}`; await set('dialog [name=viewer-mission-title]', secondTitle); responseFailure = true;
  await page.send('Fetch.enable', { patterns: [...requestPatterns, { urlPattern: origin + '/api/v1/missions', requestStage: 'Response' }] }); await button('미션 제안하기', ownerDialog); await until(() => committedResponse !== null, 'Actual committed proposal response');
  await until(() => page.evaluate(`document.querySelectorAll('dialog li[data-mission-id]').length===2&&!document.querySelector('dialog [role=alert]')`), 'Read-after-write mission receipt'); await page.send('Fetch.enable', { patterns: requestPatterns });
  const secondBody = committedResponse.body, confirmedMine = (await current(other.client)).data.mine, secondViewer = confirmedMine.find(item => item.clientRequestId === secondBody.clientRequestId), receipt = await other.client.request('POST', '/missions', secondBody);
  check(committedResponse.status === 201 && secondViewer?.title === secondTitle && confirmedMine.length === 2 && receipt.status === 200 && receipt.data.item.id === secondViewer.id, 'An actual HTTP 201 commit followed by an injected 503 recovers its own saved receipt without duplicates');
  await click(`dialog li[data-mission-id="${firstViewer.id}"] button`); await visibleText('미션 제안 취소');
  nextFailure = failure503('POST', `/missions/${firstViewer.id}/cancel`, '취소 결과를 확인하지 못했어요.'); await button('제안 취소 확인', ownerDialog); await visibleText('취소 결과를 확인하지 못했어요');
  check(await page.evaluate(`document.querySelector('dialog h2').textContent==='미션 제안 취소'&&document.querySelector('dialog h3').textContent===${JSON.stringify(viewerTitle)}`), 'An uncertain cancellation preserves the exact confirmation target instead of dismissing the dialog');
  holdMutation = true; const beforeCancel = writes.length; await button('제안 취소 확인', ownerDialog); await until(() => Boolean(heldMutation), 'Held cancellation'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeCancel + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'Pending cancellation disables every action and cannot be sent twice or dismissed');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('미션 제안을 취소했어요');
  const finalMine = (await current(other.client)).data.mine, canceledViewer = finalMine.find(item => item.id === firstViewer.id);
  check(history(canceledViewer, ['received', 'canceled'], ['viewer', 'viewer']) && await page.evaluate(`document.activeElement.getAttribute('role')==='status'`), 'Confirmed viewer cancellation stores its actor and one terminal event and focuses the acknowledgement');
  await click(`dialog li[data-mission-id="${firstViewer.id}"] summary`); await has(`dialog li[data-mission-id="${firstViewer.id}"] ol li`);
  check(await page.evaluate(`document.querySelector('dialog li[data-mission-id="${firstViewer.id}"] ol').children.length===2&&document.querySelector('dialog li[data-mission-id="${firstViewer.id}"]').innerText.includes('제안자')`), 'Private mission detail expands its saved description, actors, times and chronological change history');
  await screenshot('missions-viewer-ui.png'); await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Viewer mission dialog closes');
  check(await page.evaluate(`document.activeElement.getAttribute('aria-label')==='무료 미션 열기'`), 'Closing the viewer mission panel returns focus to its opener');
  await reload(); await has('[aria-label="무료 미션 열기"]'); await click('[aria-label="무료 미션 열기"]'); await button('내 미션', 'document.querySelector("dialog nav")'); await has(`dialog li[data-mission-id="${secondViewer.id}"]`);
  check(await page.evaluate(`document.querySelectorAll('dialog li[data-mission-id]').length===2&&document.querySelector('dialog').innerText.includes(${JSON.stringify(viewerTitle)})`), 'Real private proposal and cancellation history survives browser reload');
  for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`(() => {const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1;})()`), `The viewer mission panel and history fit the ${width}px viewport`); }
  await screenshot('missions-viewer-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Network.clearBrowserCookies'); await page.send('Network.setCookies', { cookies: asker.client.saved().cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' })) }); await page.evaluate(`window.dispatchEvent(new Event('focus'))`);
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Cross-tab mission account reset'); await nav(watchRoute); await has('[aria-label="무료 미션 열기"]'); await click('[aria-label="무료 미션 열기"]'); await button('내 미션', 'document.querySelector("dialog nav")');
  await visibleText('아직 제안한 미션이 없어요');
  check(await page.evaluate(`document.querySelectorAll('dialog li[data-mission-id]').length===0&&!document.querySelector('dialog').innerText.includes(${JSON.stringify(viewerTitle)})`), 'A shared-cookie account change discards the previous account private mission history');
  const editableFinal = (await detail(editableMission.id)).data.item, terminalFinal = (await detail(terminal.id)).data.item;
  check(editableFinal.status === 'received' && editableFinal.version === 0 && editableFinal.broadcastActive && terminalFinal.reason === terminalReason && history(terminalFinal, ['received', 'running', 'completed'], ['viewer', 'owner', 'owner']), 'The final fixtures contain one untouched active editable mission and one durable completed mission for read-only development and restart checks');
  await Promise.all([...pendingInterceptions]); check(errors.length === 0 && privateHeaders.length > 0 && privateHeaders.every(Boolean), 'No browser runtime or unconfirmed interception errors; every private management/write call captures its account header');
  await marker('missions-checkpoint.json', { owner: owner.client.saved(), viewer: other.client.saved(), path: fixturePath, broadcastId: broadcast.id, missionId: editableMission.id, editableMissionId: editableMission.id,
    terminalMissionId: terminal.id, terminalReason, viewerMissions: finalMine.map(item => ({ id: item.id, clientRequestId: item.clientRequestId, title: item.title, status: item.status })), receiptBody: secondBody, receiptMissionId: secondViewer.id });
  await writeFile(path.join(output, 'missions-ui-result.json'), JSON.stringify({ verificationDatabaseOnly: true, origin, api, checks: results.length, passed: results.filter(result => result.pass).length,
    realSources: ['One isolated 320x180/15fps MediaMTX/FFmpeg source replaced sequentially on the same path', 'Real PostgreSQL accounts, private proposals, owner transitions and moderation rules'],
    deadlineFixture: { controlledVerificationDatabaseShift: true, actualElapsedMinutes: false, productionDataChanged: false },
    watchMedia: 'Video playback is paused during mission UI checks; the separate small live publisher continues. These checks claim no viewing reward or playback measurements.',
    paginationInstrumentation: 'Owner GET limit lowered to 2; mission rows and opaque cursors remain real server responses.',
    faultInjection: ['Owner initial/cursor GET 503', 'Owner PATCH 503/delay', 'Actual version conflict', 'Offline/online eligibility', 'Submission request-stage 503/delay', 'Submission response-stage 503 after actual HTTP 201 commit', 'Cancel 503/delay'],
    results, runtimeErrors: errors, offlineState, confirmedCanceledInterceptions }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  let failureState = null; if (page) { try { failureState = await snapshot(); } catch {} }
  await writeFile(path.join(output, 'missions-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors: errors, offlineState, confirmedCanceledInterceptions, writes, interactions, failureState }, null, 2));
  if (page) await screenshot('missions-ui-failure.png').catch(() => {}); throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); } browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
