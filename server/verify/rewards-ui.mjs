// Real viewing earns the primary viewer balance; separate synthetic wallets exercise transaction policy only.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { Client, api, origin, liveBroadcast } from './rewards-client.mjs';

const suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url'), output = path.resolve('verification/product');
const directory = path.resolve(process.env.FRAME_REWARDS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_REWARDS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external reward fixture directory is required.');
const fixtureStreamKey = process.env.FRAME_REWARDS_FIXTURE_STREAM_KEY, fixturePath = fixtureStreamKey?.split('?')[0];
if (!fixtureStreamKey || !/^obs-reward-[0-9a-f]{12}$/.test(fixturePath ?? '')) throw Error('The dedicated isolated reward stream credential is required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), 'frame-rewards-ui-')), profile = path.join(browserDirectory, 'profile');
const results = [], errors = [], writes = [], confirmedCanceledInterceptions = [], interactions = [], watchRequests = [], watchResponses = [];
const observedWatchRequests = new Map();
const successfulOwnerQueries = new Set();
const interceptedRequests = new Map(), canceledNetworkRequests = new Set(), pendingInterceptions = new Set();
let page, nextFailure, holdMutation = false, heldMutation, pageLimit = false, responseFailure = false, committedResponse = null, submittedBody = null, submittedRewardId = null, actualWatchProof = null;
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--remote-debugging-port=9540', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
await marker('browser-owner.json', { pid: browser.pid, profile });
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, parameters) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__rewardQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, parameters);
  await until(async () => { try { return await page.evaluate(`window.__rewardQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New reward document');
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); }
async function reload() { await navigateDocument('Page.reload', {}); }
async function click(selector) {
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control: ' + selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);
  await until(() => page.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.matches(':disabled'))return false;const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(hit===e||e.contains(hit));})()`), 'Visible unobscured control: ' + selector);
  await page.click(selector);
}
async function button(label, scope = 'document') {
  await until(() => page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});return !!element&&!element.matches(':disabled');})()`), 'Enabled button: ' + label);
  await page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});element.dataset.rewardQaTarget='true';element.scrollIntoView({block:'center'});})()`);
  await until(() => page.evaluate(`(() => {const element=document.querySelector('[data-reward-qa-target]');if(!element||element.matches(':disabled'))return false;const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===element;})()`), 'Clickable button: ' + label);
  interactions.push({ label, phase: 'before', ...(await snapshot()) }); await page.click('[data-reward-qa-target]');
  interactions.push({ label, phase: 'after', ...(await snapshot()) }); if (interactions.length > 30) interactions.splice(0, interactions.length - 30);
  await page.evaluate(`document.querySelector('[data-reward-qa-target]')?.removeAttribute('data-reward-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function snapshot() {
  return page.evaluate(`(() => {const e=document.querySelector('[data-reward-qa-target]'),r=e?.getBoundingClientRect();return {path:location.pathname,visibility:document.visibilityState,focused:document.hasFocus(),dialogOpen:!!document.querySelector('dialog[open]'),target:e?{disabled:e.matches(':disabled'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:null};})()`);
}
async function interceptionCommand(command, parameters) {
  const request = interceptedRequests.get(parameters.requestId);
  try { return await page.send(command, parameters); }
  catch (failure) {
    if (/Invalid InterceptionId\.?/.test(failure.message) && request?.networkId) {
      if (!canceledNetworkRequests.has(request.networkId)) await sleep(100);
      if (canceledNetworkRequests.has(request.networkId)) { confirmedCanceledInterceptions.push({ method: request.method, path: request.path, command, confirmedBy: 'Network.loadingFailed:canceled' }); return; }
    }
    failure.rewardQaContext = { source: 'Fetch', method: request?.method ?? null, path: request?.path ?? null, command, hasNetworkId: Boolean(request?.networkId), error: failure.message }; throw failure;
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
    if (responseFailure && request.method === 'POST' && /^\/api\/v1\/rewards\/[0-9a-f-]{36}\/redemptions$/.test(url.pathname)) {
      responseFailure = false; committedResponse = { status: event.params.responseStatusCode, body: submittedBody, rewardId: submittedRewardId };
      await fulfill(requestId, { status: 503, code: 'PRODUCT_UNAVAILABLE', detail: '보상 신청 결과를 확인하지 못했어요.' }); return;
    }
    await interceptionCommand('Fetch.continueRequest', { requestId }); return;
  }
  if (request.method !== 'GET') writes.push({ method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') });
  if (request.method === 'POST' && /^\/api\/v1\/rewards\/[0-9a-f-]{36}\/redemptions$/.test(url.pathname)) { submittedBody = JSON.parse(request.postData); submittedRewardId = url.pathname.split('/')[4]; }
  if (nextFailure?.matches(request.method, url)) { const failure = nextFailure; nextFailure = null; await fulfill(requestId, failure); return; }
  if (holdMutation && request.method !== 'GET') { heldMutation = requestId; return; }
  if (pageLimit && request.method === 'GET' && ['/api/v1/me/rewards', '/api/v1/me/redemptions'].includes(url.pathname)) { url.searchParams.set('limit', '2'); await interceptionCommand('Fetch.continueRequest', { requestId, url: url.href }); return; }
  await interceptionCommand('Fetch.continueRequest', { requestId });
}
const failure503 = (method, endpoint, detail, cursor = false) => ({ status: 503, code: 'PRODUCT_UNAVAILABLE', detail, matches: (actual, url) => actual === method && url.pathname === '/api/v1' + endpoint && (!cursor || url.searchParams.has('cursor')) });
async function createAccount(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const email = `rewards_ui_${kind}_${suffix}@example.invalid`, displayName = `보상 검증 ${kind} ${suffix}`;
  const response = await client.request('POST', '/auth/register', { email, password, displayName, ...consent });
  if (response.status !== 201) throw Error('Dedicated reward account registration returned HTTP ' + response.status);
  return { client, email, displayName, user: response.data.user, channel: response.data.channel };
}
async function login(account) {
  await page.send('Network.clearBrowserCookies'); await nav('/login'); await has('#account-email');
  await set('[name=email]', account.email); await set('[name=password]', password); await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
}
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, name), await page.screenshot()); }
async function marker(name, value) { const target = path.join(directory, name), temporary = target + '.tmp'; await writeFile(temporary, JSON.stringify(value)); await rename(temporary, target); }
async function waitMarker(name) { for (let i = 0; i < 600; i++) { try { await access(path.join(directory, name)); return; } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } await sleep(100); } throw Error('Timeout waiting for the owned source marker.'); }
try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9540, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Reward QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.responseReceived' && event.params.response.status === 200) { const url = new URL(event.params.response.url); if (url.pathname === '/api/v1/me/rewards') successfulOwnerQueries.add(url.searchParams.get('q') ?? ''); }
    if (event.method === 'Network.requestWillBeSent' && new URL(event.params.request.url).pathname === '/api/v1/points/watch') {
      const input = JSON.parse(event.params.request.postData), summary = { watching: input.watching, eligibleMs: input.eligibleMs, sequence: input.sequence };
      watchRequests.push(summary); observedWatchRequests.set(event.params.requestId, summary);
    }
    if (event.method === 'Network.responseReceived' && observedWatchRequests.has(event.params.requestId)) observedWatchRequests.get(event.params.requestId).status = event.params.response.status;
    if (event.method === 'Network.loadingFinished' && observedWatchRequests.has(event.params.requestId)) {
      const summary = observedWatchRequests.get(event.params.requestId); observedWatchRequests.delete(event.params.requestId);
      const pending = page.send('Network.getResponseBody', { requestId: event.params.requestId }).then(body => {
        const result = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
        watchResponses.push({ ...summary, acceptedMs: result.acceptedMs ?? null, creditedPoints: result.creditedPoints ?? null, pendingWatchMs: result.pendingWatchMs ?? null, balance: result.balance ?? null, reason: result.reason ?? null, code: result.code ?? null });
      }).catch(() => watchResponses.push({ ...summary, responseBodyUnavailable: true }));
      pendingInterceptions.add(pending); void pending.finally(() => pendingInterceptions.delete(pending));
    }
    if (event.method === 'Network.loadingFailed' && observedWatchRequests.has(event.params.requestId)) {
      watchResponses.push({ ...observedWatchRequests.get(event.params.requestId), status: 0, canceled: event.params.canceled === true }); observedWatchRequests.delete(event.params.requestId);
    }
    if (event.method === 'Network.loadingFailed' && event.params.canceled === true) canceledNetworkRequests.add(event.params.requestId);
    if (event.method === 'Fetch.requestPaused') { const pending = intercept(event).catch(failure => errors.push(failure.rewardQaContext ?? failure.message)); pendingInterceptions.add(pending); void pending.finally(() => pendingInterceptions.delete(pending)); }
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const bootstrap = new Client(), policies = await bootstrap.request('GET', '/policies');
  if (policies.status !== 200) throw Error('Signup policies are unavailable in the isolated app.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  const owner = await createAccount('owner', consent), viewer = await createAccount('viewer', consent), policy = await createAccount('policy', consent), other = await createAccount('other', consent);
  const connection = await owner.client.request('POST', '/me/channel/connection', { streamKey: fixtureStreamKey });
  if (connection.status !== 200) throw Error('Dedicated stream ownership connection returned HTTP ' + connection.status);
  await owner.client.request('PUT', '/studio', { title: `함께 만드는 방송과 채널 보상 ${suffix}`, publisher: owner.displayName });
  await marker('ready-live.json', { path: fixturePath }); let broadcast = await liveBroadcast(fixturePath);
  const current = (client, item = broadcast, query = {}) => client.request('GET', '/rewards/current?' + new URLSearchParams({ path: fixturePath, broadcastId: item.id, ...query }));
  for (let i = 0; i < 100; i++) { const result = await current(owner.client); if (result.data?.channelId === owner.channel.id && result.data.canRedeem) break; if (i === 99) throw Error('The reward API did not expose the fresh owned source.'); await sleep(200); }
  const points = (client, limit = 100, cursor) => client.request('GET', '/me/points?' + new URLSearchParams({ channelId: owner.channel.id, limit: String(limit), ...(cursor ? { cursor } : {}) }));
  const rewardInput = (name, cost, limit = 'unlimited', enabled = true) => ({ name, points: cost, limit, enabled, clientRequestId: randomUUID() });
  async function createReward(name, cost, limit = 'unlimited', enabled = true) { const result = await owner.client.request('POST', '/me/rewards', rewardInput(name, cost, limit, enabled)); if (result.status !== 201) throw Error('Reward creation returned HTTP ' + result.status); return result.data.item; }
  async function updateReward(item, values) { const result = await owner.client.request('PATCH', `/me/rewards/${item.id}`, { version: item.version, name: item.name, points: item.points, limit: item.limit, enabled: item.enabled, ...values }); if (result.status !== 200) throw Error('Reward update returned HTTP ' + result.status); return result.data.item; }
  const redemptionBody = (reward, note = '', item = broadcast) => ({ broadcastId: item.id, path: fixturePath, note, clientRequestId: randomUUID(), rewardVersion: reward.version });
  const redeem = (client, reward, body = redemptionBody(reward)) => client.request('POST', `/rewards/${reward.id}/redemptions`, body);
  const change = (item, status, reason = '') => owner.client.request('PATCH', `/me/redemptions/${item.id}`, { version: item.version, status, reason });
  const rewardSeed = rewardInput(`작업 주제 제안 ${suffix}`, 5), createdTwice = await Promise.all([owner.client.request('POST', '/me/rewards', rewardSeed), owner.client.request('POST', '/me/rewards', rewardSeed)]);
  let basic = createdTwice.find(result => result.status === 201)?.data.item;
  check(basic && createdTwice.filter(result => result.status === 201).length === 1 && createdTwice.filter(result => result.status === 200).length === 1 && createdTwice.every(result => result.data.item.id === basic.id), 'One create request UUID produces exactly one real reward under concurrent retries');
  const once = await createReward(`다음 방송 주제 ${suffix}`, 10, 'once_per_broadcast'), expensive = await createReward(`특별한 작업 제안 ${suffix}`, 1000000), disabled = await createReward(`잠시 쉬는 보상 ${suffix}`, 1, 'unlimited', false);
  const anonymous = new Client(); await anonymous.request('GET', '/session');
  const guest = await current(anonymous), guestRedeem = await redeem(anonymous, basic), foreign = await other.client.request('GET', `/me/rewards/${basic.id}`), scope = await other.client.request('GET', '/me/rewards', undefined, { expectedUserId: owner.user.id });
  check(guest.status === 200 && guest.data.userId === null && guest.data.balance === null && guest.data.mine.length === 0 && guest.data.usedRewardIds.length === 0 && guest.data.rewards.length === 3 && guest.data.rewards.every(item => item.enabled)
    && guestRedeem.status === 401 && foreign.status === 404 && scope.status === 409 && scope.data.code === 'SESSION_CHANGED', 'The public enabled catalog exposes no private balance or requests and protects owner mutations and account scope');
  const empty = await points(viewer.client), insufficient = await redeem(viewer.client, basic);
  check(empty.data.balance === 0 && empty.data.items.length === 0 && insufficient.status === 409 && insufficient.data.code === 'POINTS_INSUFFICIENT' && (await points(viewer.client)).data.items.length === 0, 'The real-watching viewer begins with zero balance and an insufficient request cannot create a debit');
  function fund(account) { try { execFileSync(process.execPath, [path.resolve('server/verify/rewards-fixture.mjs'), 'fund', account.user.id, owner.channel.id], { windowsHide: true, stdio: 'pipe', timeout: 15000 }); } catch { throw Error('Only the dedicated empty policy fixture wallet may receive synthetic test credit.'); } }
  fund(policy); fund(other);
  const initialFixture = await points(policy.client);
  check(initialFixture.data.balance === 1000 && initialFixture.data.items.length === 1 && initialFixture.data.items[0].label === 'QA fixture credit; not actual watching', 'Synthetic policy funding is recorded separately and is never presented as actual viewing evidence');
  const duplicateBody = redemptionBody(basic, '중복 요청 한 번만 차감'), duplicates = await Promise.all([redeem(policy.client, basic, duplicateBody), redeem(policy.client, basic, duplicateBody)]);
  let duplicated = duplicates.find(result => result.status === 201)?.data.item;
  let policyLedger = (await points(policy.client)).data;
  check(duplicated && duplicates.filter(result => result.status === 201).length === 1 && duplicates.filter(result => result.status === 200).length === 1 && duplicates.every(result => result.data.item.id === duplicated.id)
    && policyLedger.balance === 995 && policyLedger.items.filter(item => item.kind === 'redemption' && item.redemptionId === duplicated.id).length === 1, 'Concurrent identical redemption UUIDs create one request and exactly one debit');
  const different = await redeem(policy.client, basic, { ...duplicateBody, note: '같은 요청의 다른 내용' });
  check(different.status === 409 && different.data.code === 'REDEMPTION_REQUEST_CONFLICT' && (await points(policy.client)).data.balance === 995, 'A reused redemption UUID with changed content cannot debit or replace the original request');
  const oldVersion = basic.version; basic = await updateReward(basic, { points: 7, name: `변경된 작업 제안 ${suffix}` });
  const stalePrice = await redeem(policy.client, basic, { ...redemptionBody(basic), rewardVersion: oldVersion });
  check(stalePrice.status === 409 && stalePrice.data.code === 'REWARD_CONFLICT' && (await points(policy.client)).data.balance === 995, 'A stale displayed reward version cannot charge a changed price without a fresh confirmation');
  basic = await updateReward(basic, { enabled: false }); const disabledNew = await redeem(policy.client, basic), disabledDirect = await redeem(policy.client, disabled), originalReceipt = await redeem(policy.client, basic, duplicateBody);
  check(disabledNew.status === 409 && disabledNew.data.code === 'REWARD_DISABLED' && disabledDirect.status === 409 && disabledDirect.data.code === 'REWARD_DISABLED'
    && originalReceipt.status === 200 && originalReceipt.data.item.id === duplicated.id && originalReceipt.data.item.points === 5 && originalReceipt.data.item.rewardName === rewardSeed.name && originalReceipt.data.balance === 995,
    'Disabled rewards reject new requests while an existing receipt retains its original price and name without another debit');
  basic = await updateReward(basic, { enabled: true, points: 5, name: rewardSeed.name });
  const onceAttempts = await Promise.all([redeem(policy.client, once), redeem(policy.client, once)]), onceItem = onceAttempts.find(result => result.status === 201)?.data.item;
  check(onceItem && onceAttempts.filter(result => result.status === 201).length === 1 && onceAttempts.some(result => result.status === 409 && result.data.code === 'REWARD_ALREADY_REDEEMED') && (await points(policy.client)).data.balance === 985, 'Different concurrent UUIDs cannot bypass the one-per-broadcast reward limit');
  const canceled = await policy.client.request('POST', `/redemptions/${onceItem.id}/cancel`, { version: onceItem.version }), onceAgain = await redeem(policy.client, once);
  check(canceled.status === 200 && canceled.data.balance === 995 && onceAgain.status === 409 && onceAgain.data.code === 'REWARD_ALREADY_REDEEMED'
    && (await current(policy.client)).data.usedRewardIds.includes(once.id), 'Canceling returns the points once and preserves the consumed broadcast limit');
  duplicated = (await change(duplicated, 'processing')).data.item;
  const refunds = await Promise.all([change(duplicated, 'rejected', '현재 방송에서는 진행하기 어려워요.'), change(duplicated, 'rejected', '동시에 누른 두 번째 처리')]);
  policyLedger = (await points(policy.client)).data;
  check(refunds.filter(result => result.status === 200).length === 1 && refunds.filter(result => result.status === 409).length === 1 && policyLedger.balance === 1000
    && policyLedger.items.filter(item => item.kind === 'refund' && item.redemptionId === duplicated.id).length === 1, 'Concurrent terminal handling produces one refund while the other stale mutation fails');
  const completeRequest = await redeem(policy.client, basic); let completeItem = completeRequest.data.item; completeItem = (await change(completeItem, 'completed', '방송에서 제안을 함께 확인했어요.')).data.item;
  const closedMutation = await change(completeItem, 'rejected', '완료 뒤 변경 시도'), privateRequest = await other.client.request('GET', `/me/redemptions/${completeItem.id}`);
  check(closedMutation.status === 409 && closedMutation.data.code === 'REDEMPTION_ALREADY_CLOSED' && privateRequest.status === 404 && (await points(policy.client)).data.balance === 995
    && !(await points(policy.client)).data.items.some(item => item.kind === 'refund' && item.redemptionId === completeItem.id), 'Completed requests are immutable, keep their debit and remain private to the requester and owner');
  async function settings(values) { const saved = (await owner.client.request('GET', '/me/chat/settings')).data; return owner.client.request('PATCH', '/me/chat/settings', { version: saved.version, slowMode: saved.slowMode, slowSeconds: saved.slowSeconds, followersOnly: saved.followersOnly, blockLinks: saved.blockLinks, bannedWords: saved.bannedWords, ...values }); }
  await settings({ followersOnly: true }); const followDenied = await redeem(other.client, basic);
  const block = await owner.client.request('POST', '/me/chat/blocks', { targetChannelId: other.channel.id, durationSeconds: null, reason: '보상 신청 권한 검증' }); const blockDenied = await redeem(other.client, basic);
  await owner.client.request('DELETE', `/me/chat/blocks/${block.data.item.id}?version=${block.data.item.version}`); await other.client.request('PUT', `/me/follows/${owner.channel.id}`, {});
  const allowedOther = await redeem(other.client, basic); await settings({ followersOnly: false });
  check(followDenied.status === 403 && followDenied.data.code === 'REWARD_FOLLOW_REQUIRED' && blockDenied.status === 403 && blockDenied.data.code === 'REWARD_PARTICIPATION_BLOCKED'
    && allowedOther.status === 201 && allowedOther.data.balance === 995 && (await current(viewer.client)).data.mine.length === 0, 'Stored follower and block policy reject unauthorized requests without charging their wallets or leaking another viewer history');
  const fixtureUa = 'frame-rewards-policy-qa', sessionResponse = await fetch(api + `/${fixturePath}/b/${broadcast.id}/session`, { method: 'POST', headers: { 'User-Agent': fixtureUa } });
  if (!sessionResponse.ok) throw Error('The separate policy media session could not be opened.');
  const fixtureSid = (await sessionResponse.json()).sid, fixtureVisit = randomUUID(), pulseOptions = { headers: { 'User-Agent': fixtureUa } };
  const pulseBody = sequence => ({ path: fixturePath, broadcastId: broadcast.id, viewerSessionId: fixtureSid, visitId: fixtureVisit, sequence, eligibleMs: 20000, watching: true });
  const baseline = await policy.client.request('POST', '/points/watch', pulseBody(0), pulseOptions), capStarted = performance.now();
  const fastPulses = await Promise.all(Array.from({ length: 8 }, (_, i) => policy.client.request('POST', '/points/watch', pulseBody(i + 1), pulseOptions))), capElapsed = performance.now() - capStarted;
  const duplicatePulse = await policy.client.request('POST', '/points/watch', pulseBody(8), pulseOptions), rivalVisit = await policy.client.request('POST', '/points/watch', { ...pulseBody(0), visitId: randomUUID() }, pulseOptions);
  check(baseline.data.reason === 'baseline' && baseline.data.acceptedMs === 0 && fastPulses.every(result => result.status === 200 && result.data.creditedPoints === 0)
    && fastPulses.reduce((sum, result) => sum + result.data.acceptedMs, 0) <= capElapsed + 50 && duplicatePulse.data.acceptedMs === 0 && rivalVisit.data.reason === 'watching_elsewhere' && rivalVisit.data.acceptedMs === 0,
    'API-only concurrent pulse claims are capped by server elapsed time, sequence deduplication and one active visit lease');
  const stopped = await policy.client.request('POST', '/points/watch', { ...pulseBody(9), watching: false }, pulseOptions), invalidSid = await policy.client.request('POST', '/points/watch', { ...pulseBody(10), viewerSessionId: '0'.repeat(32) }, pulseOptions);
  check(stopped.data.reason === 'stopped' && stopped.data.acceptedMs === 0 && invalidSid.data.reason === 'session_unavailable' && invalidSid.data.acceptedMs === 0 && (await points(policy.client)).data.balance === 995,
    'Stopped or unadmitted media sessions cannot credit points in the separate synthetic policy account');
  await fetch(api + `/${fixturePath}/b/${broadcast.id}/session/${fixtureSid}`, { method: 'DELETE', headers: { 'User-Agent': fixtureUa } });
  const requestPatterns = [{ urlPattern: '*api/v1/me/rewards*' }, { urlPattern: '*api/v1/me/redemptions*' }, { urlPattern: '*api/v1/rewards*' }, { urlPattern: '*api/v1/redemptions*' }];
  await page.send('Fetch.enable', { patterns: requestPatterns }); await login(owner); pageLimit = true;
  nextFailure = failure503('GET', '/me/rewards', '보상 목록을 불러오지 못했어요.'); await nav('/studio/rewards'); await visibleText('보상 목록을 불러오지 못했어요'); await button('목록 다시 시도');
  const rewardRows = () => page.evaluate(`Array.from(document.querySelectorAll('table[aria-label="보상 목록"] tbody tr')).map(row=>row.dataset.rewardId)`);
  await until(async () => (await rewardRows()).length === 2, 'Two real reward rows'); await button('더 불러오기'); await until(async () => (await rewardRows()).length === 4, 'Reward cursor page');
  check(new Set(await rewardRows()).size === 4, 'The owner retries a list failure and appends actual reward cursor pages without duplicates');
  await button('보상 추가'); await has('dialog [name=reward-name]'); await set('dialog [name=reward-points]', '0'); await set('dialog [name=reward-name]', '검증 보상'); const beforeInvalid = writes.length; await button('저장', 'document.querySelector("dialog")'); await visibleText('1~1,000,000');
  check(writes.length === beforeInvalid && await page.evaluate(`document.activeElement.name==='reward-points'`), 'Invalid reward cost is rejected locally with focus on the point field');
  const uiRewardName = `함께 고르는 작업 ${suffix}`; await set('dialog [name=reward-name]', uiRewardName); await set('dialog [name=reward-points]', '7'); await set('dialog [name=reward-limit]', 'unlimited');
  nextFailure = failure503('POST', '/me/rewards', '보상 저장 결과를 확인하지 못했어요.'); await button('저장', 'document.querySelector("dialog")'); await visibleText('저장 결과를 확인하지 못했어요');
  check(await page.evaluate(`document.querySelector('dialog [name=reward-name]').value===${JSON.stringify(uiRewardName)}&&document.querySelector('dialog [name=reward-points]').value==='7'&&document.querySelector('dialog [name=reward-name]').matches(':disabled')`), 'An unknown reward create result preserves and freezes the original name, price and create UUID');
  holdMutation = true; const beforeCreate = writes.length; await button('저장 다시 확인', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held reward create retry'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeCreate + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'Pending reward creation locks its dialog and prevents duplicate submission or Escape');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('보상을 추가했어요');
  let uiReward = (await owner.client.request('GET', '/me/rewards?' + new URLSearchParams({ q: uiRewardName }))).data.items[0];
  check(uiReward?.name === uiRewardName && uiReward.points === 7 && uiReward.limit === 'unlimited', 'The connected owner editor creates one real reward with its confirmed settings');
  successfulOwnerQueries.delete(uiRewardName); await set('[name=reward-query]', uiRewardName); await button('검색', 'document.querySelector("[name=reward-query]").form');
  await until(() => successfulOwnerQueries.has(uiRewardName) && page.evaluate(`new URL(location.href).searchParams.get('q')===${JSON.stringify(uiRewardName)}&&document.querySelectorAll('table[aria-label="보상 목록"] tbody tr').length===1&&!!document.querySelector('tr[data-reward-id="${uiReward.id}"]')&&!document.querySelector('[aria-label="보상 목록 새로고침"]')?.disabled`), 'The actual filtered response and its one current row');
  await click(`tr[data-reward-id="${uiReward.id}"] button`); await has('dialog [name=reward-name]');
  const editDraft = `작성 중인 보상 ${suffix}`, externalName = `최신 작업 보상 ${suffix}`;
  await set('dialog [name=reward-name]', editDraft); uiReward = await updateReward(uiReward, { name: externalName }); await button('저장', 'document.querySelector("dialog")'); await visibleText('최신 상태 불러오기');
  check(await page.evaluate(`document.querySelector('dialog [name=reward-name]').value===${JSON.stringify(editDraft)}&&Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent.trim()==='저장').disabled`), 'A real reward version conflict preserves the editor draft and blocks stale overwrite');
  await button('최신 상태 불러오기', 'document.querySelector("dialog")'); await button('입력 유지', 'document.querySelector("dialog")');
  check(await page.evaluate(`document.querySelector('dialog [name=reward-name]').value===${JSON.stringify(editDraft)}`), 'Keeping the draft in the conflict confirmation does not discard the edited reward name');
  await button('최신 상태 불러오기', 'document.querySelector("dialog")'); await button('불러오기', 'document.querySelector("dialog")'); await until(() => page.evaluate(`document.querySelector('dialog [name=reward-name]')?.value===${JSON.stringify(externalName)}`), 'Latest reward state');
  for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`(() => {const r=document.querySelector('dialog').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1&&document.querySelector('[name=reward-enabled]').getBoundingClientRect().width>=16;})()`), `The owner reward fields and custom enabled checkbox fit the ${width}px viewport`); }
  await screenshot('rewards-owner-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await button('닫기', 'document.querySelector("dialog")');
  await screenshot('rewards-owner-ui.png');
  let watchRoute = `/watch/${fixturePath}/${broadcast.id}`;
  await page.send('Network.clearBrowserCookies'); await nav(watchRoute); await has('[aria-label="채널 보상 열기"]'); await click('[aria-label="채널 보상 열기"]'); await has('dialog li[data-reward-id]');
  check(await page.evaluate(`document.querySelector('dialog [aria-label="내 채널 포인트"]').innerText.includes('로그인 필요')&&!document.querySelector('dialog li[data-redemption-id]')`), 'The anonymous reward panel shows the public catalog while keeping balances and requests private');
  await click(`dialog li[data-reward-id="${basic.id}"] button`); await has('#account-email');
  check(await page.evaluate(`new URLSearchParams(location.search).get('returnTo')===${JSON.stringify(watchRoute)}`), 'Reward login preserves the exact broadcast return route');
  await login(viewer); await nav(watchRoute);
  await until(() => page.evaluate(`(() => {const v=document.querySelector('video');return !!v&&v.videoWidth===320&&v.videoHeight===180&&!v.paused&&!v.seeking&&v.readyState>=3&&v.currentTime>0;})()`), 'Actual live source playback');
  await page.evaluate(`(() => {const v=document.querySelector('video'),state={counts:{},last:[]};window.__rewardMediaQA=state;for(const type of ['timeupdate','ratechange','pause','waiting','stalled','seeking','seeked','playing','ended','emptied','error'])v.addEventListener(type,()=>{state.counts[type]=(state.counts[type]??0)+1;state.last.push({type,at:performance.now(),media:v.currentTime,ready:v.readyState,paused:v.paused,rate:v.playbackRate});if(state.last.length>30)state.last.shift();});})()`);
  const mediaSnapshot = () => page.evaluate(`(() => {const v=document.querySelector('video'),q=v?.getVideoPlaybackQuality(),runtime=window.FrameRuntime;return {at:performance.now(),media:v?.currentTime??0,frames:q?(q.totalVideoFrames-q.droppedVideoFrames):0,paused:v?.paused,seeking:v?.seeking,ready:v?.readyState??0,width:v?.videoWidth??0,height:v?.videoHeight??0,rate:v?.playbackRate??null,muted:v?.muted??null,visible:document.visibilityState==='visible',online:navigator.onLine,transport:runtime?.transport,playerIntent:runtime?.playback.status,watchKind:runtime?.watch?.kind,viewerSessionPresent:!!runtime?.session?.sid};})()`);
  let firstSample = await mediaSnapshot(), previousSample = firstSample, lastSample = firstSample, observedMs = 0, observations = 0, observedBalance = 0; const observationStarted = Date.now();
  while (Date.now() - observationStarted < 160000) {
    await sleep(1000); const sample = await mediaSnapshot(), wall = sample.at - previousSample.at, advance = (sample.media - previousSample.media) * 1000;
    if (sample.visible && sample.online && !sample.paused && !sample.seeking && sample.ready >= 3 && sample.width === 320 && sample.height === 180 && previousSample.visible && previousSample.online && !previousSample.paused && !previousSample.seeking
      && wall > 0 && wall <= 2500 && advance > 0 && advance <= wall * 1.5 + 250) observedMs += Math.min(wall, advance);
    previousSample = sample; lastSample = sample; observations++;
    if (observations % 5 === 0) observedBalance = (await points(viewer.client)).data.balance;
    if (observations % 10 === 0) await marker('earning-progress.json', { elapsedMs: Date.now() - observationStarted, observedEligibleMs: Math.floor(observedMs), balance: observedBalance });
    if (observedMs >= 60000 && observedBalance >= 10) break;
  }
  const earnedLedger = (await points(viewer.client)).data; await page.evaluate(`document.querySelector('video').pause()`);
  const mediaEvents = await page.evaluate(`window.__rewardMediaQA??null`);
  actualWatchProof = { observedEligibleMs: Math.floor(observedMs), wallElapsedMs: Math.floor(lastSample.at - firstSample.at), mediaAdvancedMs: Math.floor((lastSample.media - firstSample.media) * 1000), decodedFrames: lastSample.frames - firstSample.frames,
    sourceWidth: lastSample.width, sourceHeight: lastSample.height, transport: lastSample.transport, observations, balance: earnedLedger.balance, watchCredits: earnedLedger.items.filter(item => item.kind === 'watch').map(item => ({ delta: item.delta, label: item.label })), syntheticTimeOrBalanceUsed: false };
  Object.assign(actualWatchProof, { lastSample, mediaEvents, pulseCount: watchRequests.length, acceptedMsTotal: watchResponses.reduce((sum, result) => sum + (result.acceptedMs ?? 0), 0),
    reasonCounts: watchResponses.reduce((counts, result) => { const key = result.code ?? result.reason ?? (result.status === 200 ? 'accepted' : String(result.status)); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}) });
  check(observedMs >= 60000 && actualWatchProof.wallElapsedMs >= 60000 && actualWatchProof.mediaAdvancedMs >= 60000 && actualWatchProof.decodedFrames > 300 && ['hls.js', 'native'].includes(lastSample.transport)
    && earnedLedger.balance === 10 && earnedLedger.items.length === 1 && earnedLedger.items[0].kind === 'watch' && earnedLedger.items[0].delta === 10 && earnedLedger.items[0].label === '방송 시청 적립',
    'At least sixty real visible online seconds of advancing decoded HLS video earn exactly ten durable points with no synthetic funding');
  const truePulses = () => watchRequests.filter(input => input.watching).length;
  await sleep(250); const pausedPulses = truePulses(); await sleep(11000);
  check(truePulses() === pausedPulses && watchRequests.some(input => !input.watching) && (await points(viewer.client)).data.balance === 10, 'Pausing actual playback sends a release and prevents earning pulses over the next full heartbeat interval');
  await page.evaluate(`document.querySelector('video').play()`); await until(() => page.evaluate(`!document.querySelector('video').paused`), 'Playback resumes');
  const blank = await page.send('Target.createTarget', { url: 'about:blank' }); await page.send('Target.activateTarget', { targetId: blank.targetId }); await until(() => page.evaluate(`document.visibilityState==='hidden'`), 'A real background tab');
  await sleep(250); const hiddenPulses = truePulses(); await sleep(11000);
  check(truePulses() === hiddenPulses, 'A genuinely hidden browser tab does not send positive earning claims over a full heartbeat interval');
  await page.send('Target.closeTarget', { targetId: blank.targetId }); await page.send('Page.bringToFront'); await until(() => page.evaluate(`document.visibilityState==='visible'`), 'Visible media tab restored');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await until(() => page.evaluate(`!navigator.onLine`), 'Browser is actually offline');
  await sleep(250); const offlinePulses = truePulses(); await sleep(11000);
  check(truePulses() === offlinePulses, 'The offline browser does not report positive earning time while media may still be buffered');
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await until(() => page.evaluate(`navigator.onLine`), 'Browser online restored'); await page.evaluate(`document.querySelector('video').pause()`); await sleep(250);
  const oldBroadcast = broadcast; await marker('replace-live.json', { previousBroadcastId: oldBroadcast.id }); await waitMarker('replaced-live.json'); broadcast = await liveBroadcast(fixturePath, oldBroadcast.id); watchRoute = `/watch/${fixturePath}/${broadcast.id}`;
  const oldRequest = await redeem(other.client, basic, redemptionBody(basic, '종료된 방송 신규 신청', oldBroadcast));
  check(oldRequest.status === 409 && oldRequest.data.code === 'REWARD_BROADCAST_UNAVAILABLE' && (await points(viewer.client)).data.balance === 10, 'A real broadcast replacement rejects old-link requests while channel point balances persist');
  await nav(watchRoute); await has('[aria-label="채널 보상 열기"]'); await until(() => page.evaluate(`(() => {const v=document.querySelector('video');return v?.videoWidth===320&&v.readyState>=3&&!v.paused;})()`), 'Replacement source is actually playing'); await page.evaluate(`document.querySelector('video').pause()`); await click('[aria-label="채널 보상 열기"]'); await has(`dialog li[data-reward-id="${basic.id}"]`);
  check(await page.evaluate(`document.querySelector('dialog [aria-label="내 채널 포인트"]').innerText.includes('10 P')&&document.querySelector('dialog li[data-reward-id=${JSON.stringify(expensive.id)}] button').disabled`), 'The viewer sees only its confirmed earned balance and an unaffordable reward remains disabled');
  await click(`dialog li[data-reward-id="${basic.id}"] button`); await has('dialog [name=viewer-reward-note]');
  const viewerNote = `다음 작업의 구성과 구현 순서를 함께 골라 주세요.\n궁금한 부분도 방송에서 이야기할게요. ${suffix}`;
  await set('dialog [name=viewer-reward-note]', viewerNote); nextFailure = failure503('POST', `/rewards/${basic.id}/redemptions`, '신청 결과를 확인하지 못했어요.'); await button('신청하기', 'document.querySelector("dialog")'); await visibleText('결과를 확인하지 못했어요');
  const retryBody = { ...submittedBody };
  check(await page.evaluate(`document.querySelector('dialog [name=viewer-reward-note]').value===${JSON.stringify(viewerNote)}&&document.querySelector('dialog [name=viewer-reward-note]').readOnly`) && (await points(viewer.client)).data.balance === 10,
    'An unknown viewer request preserves and freezes its note without optimistic point subtraction');
  holdMutation = true; const beforeRedeem = writes.length; await button('신청 다시 확인', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held real redemption'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeRedeem + 1 && submittedBody.clientRequestId === retryBody.clientRequestId && submittedBody.rewardVersion === basic.version && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'The uncertain request reuses its price version and UUID while pending controls prevent another debit or Escape');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('보상을 신청했어요');
  const firstViewer = (await current(viewer.client)).data.mine.find(item => item.clientRequestId === retryBody.clientRequestId);
  check(firstViewer?.points === 5 && firstViewer.note === viewerNote && (await points(viewer.client)).data.balance === 5 && await page.evaluate(`document.activeElement.getAttribute('role')==='status'`), 'A server-confirmed request charges exactly five earned points and focuses its acknowledgement');
  await button('보상', 'document.querySelector("dialog nav")'); await click(`dialog li[data-reward-id="${basic.id}"] button`); await has('dialog [name=viewer-reward-note]');
  const secondNote = `다음 방송에서도 함께 작업을 정하고 싶어요 ${suffix}`; await set('dialog [name=viewer-reward-note]', secondNote); responseFailure = true;
  await page.send('Fetch.enable', { patterns: [...requestPatterns, { urlPattern: origin + `/api/v1/rewards/${basic.id}/redemptions`, requestStage: 'Response' }] });
  await button('신청하기', 'document.querySelector("dialog")'); await until(() => committedResponse !== null, 'Actually committed redemption response'); await until(() => page.evaluate(`document.querySelector('dialog h2')?.textContent==='채널 포인트'&&!document.querySelector('dialog [role=alert]')`), 'Read-after-write redemption receipt'); await page.send('Fetch.enable', { patterns: requestPatterns });
  const secondBody = committedResponse.body, confirmedMine = (await current(viewer.client)).data.mine, secondViewer = confirmedMine.find(item => item.clientRequestId === secondBody.clientRequestId), repeatReceipt = await redeem(viewer.client, basic, secondBody);
  let viewerLedger = (await points(viewer.client)).data;
  check(committedResponse.status === 201 && secondViewer?.note === secondNote && confirmedMine.length === 2 && viewerLedger.balance === 0 && repeatReceipt.status === 200 && repeatReceipt.data.item.id === secondViewer.id
    && viewerLedger.items.filter(item => item.kind === 'redemption').length === 2 && await page.evaluate(`document.querySelectorAll('dialog li[data-redemption-id]').length===2`), 'A real debit committed before an injected 503 is recovered by its own receipt without a duplicate charge or stale failure');
  await screenshot('rewards-viewer-requests-ui.png');
  await click(`dialog li[data-redemption-id="${firstViewer.id}"] button`); await until(() => page.evaluate(`document.querySelector('dialog h2')?.textContent==='신청 취소'`), 'Correct cancel confirmation');
  nextFailure = failure503('POST', `/redemptions/${firstViewer.id}/cancel`, '취소 결과를 확인하지 못했어요.'); await button('신청 취소 확인', 'document.querySelector("dialog")'); await visibleText('취소 결과를 확인하지 못했어요');
  check(await page.evaluate(`document.querySelector('dialog h2')?.textContent==='신청 취소'`) && (await points(viewer.client)).data.balance === 0, 'A failed cancellation keeps its confirmation and does not invent a refund');
  holdMutation = true; const beforeCancel = writes.length; await button('신청 취소 확인', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held viewer cancellation'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeCancel + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'Pending viewer cancellation prevents a second refund attempt or dialog dismissal');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('신청을 취소하고 포인트를 돌려받았어요'); viewerLedger = (await points(viewer.client)).data;
  check(viewerLedger.balance === 5 && viewerLedger.items.filter(item => item.kind === 'refund' && item.redemptionId === firstViewer.id).length === 1, 'The actual pending-request cancel stores one five-point refund');
  await button('포인트 내역', 'document.querySelector("dialog nav")'); await has('dialog li[data-ledger-id]');
  check(await page.evaluate(`document.querySelectorAll('dialog li[data-ledger-id]').length===4&&document.querySelector('dialog [aria-label="내 포인트 내역"]').innerText.includes('방송 시청 적립')`), 'The private point ledger displays the real earned credit, two debits and one refund');
  for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`(() => {const r=document.querySelector('dialog').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1;})()`), `The viewer wallet and ledger fit the ${width}px viewport`); }
  await screenshot('rewards-viewer-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await page.key('Escape');
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Viewer rewards close');
  check(await page.evaluate(`document.activeElement.getAttribute('aria-label')==='채널 보상 열기'`), 'Closing the wallet returns focus to its original opener');
  await login(owner); await nav('/studio/rewards?tab=requests'); await has('table[aria-label="보상 교환 요청 목록"]');
  await until(() => page.evaluate(`!!document.querySelector('tr[data-redemption-id="${secondViewer.id}"]')`), 'The real viewer request is in the owner list'); await click(`tr[data-redemption-id="${secondViewer.id}"] button`); await has('dialog [name=redemption-status]');
  await set('dialog [name=redemption-status]', 'rejected'); const beforeReason = writes.length; await button('처리 저장', 'document.querySelector("dialog")'); await visibleText('거절·취소 사유는 필수');
  check(writes.length === beforeReason && await page.evaluate(`document.activeElement.name==='redemption-reason'`), 'Owner rejection requires a reason and focuses its field without a mutation');
  const ownerReason = `현재 방송에서는 진행하기 어려워요.\n다음 기회에 함께할게요. ${suffix}`; await set('dialog [name=redemption-reason]', ownerReason);
  const processing = await change(secondViewer, 'processing', '다른 창에서 먼저 확인했어요.'); if (processing.status !== 200) throw Error('The real concurrent owner update failed.');
  await button('처리 저장', 'document.querySelector("dialog")'); await visibleText('최신 상태 불러오기');
  check(await page.evaluate(`document.querySelector('dialog [name=redemption-reason]').value===${JSON.stringify(ownerReason)}&&document.querySelector('dialog [name=redemption-status]').value==='rejected'&&Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent.trim()==='처리 저장').disabled`), 'A real request-version conflict retains the selected status and complete reason while blocking stale processing');
  await button('최신 상태 불러오기', 'document.querySelector("dialog")'); await button('입력 유지', 'document.querySelector("dialog")'); check(await page.evaluate(`document.querySelector('dialog [name=redemption-reason]').value===${JSON.stringify(ownerReason)}`), 'The owner can keep a conflicting processing draft instead of discarding it');
  await button('최신 상태 불러오기', 'document.querySelector("dialog")'); await button('불러오기', 'document.querySelector("dialog")'); await until(() => page.evaluate(`document.querySelector('dialog [name=redemption-reason]')?.value==='다른 창에서 먼저 확인했어요.'`), 'Latest processing version');
  await set('dialog [name=redemption-status]', 'rejected'); await set('dialog [name=redemption-reason]', ownerReason);
  nextFailure = failure503('PATCH', `/me/redemptions/${secondViewer.id}`, '교환 요청을 처리하지 못했어요. 입력한 내용은 유지돼요.'); await button('처리 저장', 'document.querySelector("dialog")'); await visibleText('교환 요청을 처리하지 못했어요');
  check(await page.evaluate(`document.querySelector('dialog [name=redemption-reason]').value===${JSON.stringify(ownerReason)}&&document.querySelector('dialog [name=redemption-status]').value==='rejected'`) && (await points(viewer.client)).data.balance === 5, 'Owner processing 503 preserves the reason and selected status without optimistic refund');
  for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`(() => {const r=document.querySelector('dialog').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1;})()`), `The owner request details and processing fields fit the ${width}px viewport`); }
  await screenshot('rewards-owner-request-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  holdMutation = true; const beforeRefund = writes.length; await button('처리 저장', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held actual terminal refund'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeRefund + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog fieldset').disabled&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'Pending terminal handling locks its controls and prevents duplicate refund writes');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('교환 요청을 처리하고 포인트를 돌려줬어요');
  viewerLedger = (await points(viewer.client)).data; const finalRedemption = (await owner.client.request('GET', `/me/redemptions/${secondViewer.id}`)).data.item;
  check(finalRedemption.status === 'rejected' && finalRedemption.reason === ownerReason && viewerLedger.balance === 10 && viewerLedger.items.length === 5
    && viewerLedger.items.filter(item => item.kind === 'refund' && item.redemptionId === secondViewer.id).length === 1, 'The real owner rejection returns the remaining five points exactly once and stores the reason');
  const ledgerFirst = await points(viewer.client, 2), ledgerSecond = await points(viewer.client, 2, ledgerFirst.data.nextCursor);
  check(ledgerFirst.data.nextCursor && ledgerSecond.status === 200 && new Set([...ledgerFirst.data.items, ...ledgerSecond.data.items].map(item => item.id)).size === 4 && ledgerSecond.data.balance === 10, 'Private point ledger pagination uses actual server cursors and keeps the authoritative total balance');
  await screenshot('rewards-owner-requests-ui.png');
  await Promise.all([...pendingInterceptions]); check(errors.length === 0, 'No browser runtime or unconfirmed interception errors');
  await marker('rewards-checkpoint.json', { owner: owner.client.saved(), viewer: viewer.client.saved(), policy: policy.client.saved(), path: fixturePath, broadcastId: broadcast.id, channelId: owner.channel.id,
    rewardId: uiReward.id, redemptionId: secondViewer.id, reason: ownerReason, expectedBalance: 10, ledger: viewerLedger.items.map(item => ({ id: item.id, kind: item.kind, delta: item.delta, balanceAfter: item.balanceAfter })),
    requestBody: secondBody, requestRewardId: basic.id, canceledRedemptionId: firstViewer.id, actualWatchProof });
  await writeFile(path.join(output, 'rewards-ui-result.json'), JSON.stringify({ verificationDatabaseOnly: true, origin, api, checks: results.length, passed: results.filter(result => result.pass).length,
    actualWatchProof, syntheticFunding: { accounts: ['policy', 'other'], pointsEach: 1000, label: 'QA fixture credit; not actual watching', primaryViewerFunded: false },
    paginationInstrumentation: 'Owner catalog/request GET limits are lowered to 2; all rows and opaque cursors are real server responses. Ledger cursor checks call the actual API with limit 2.',
    faultInjection: ['Owner catalog GET 503', 'Reward create request-stage 503/delay', 'Redemption request-stage 503/delay', 'Redemption response-stage 503 after actual HTTP 201 debit', 'Cancellation request-stage 503/delay', 'Owner terminal PATCH 503/delay'],
    limits: ['Single PC and loopback only', 'Headless Edge; mobile viewports, no physical mobile devices', 'No Caddy HTTPS/WSS, external network, load or capacity coverage', 'Playback observations are test evidence; server time/session caps do not prove human viewing'],
    results, runtimeErrors: errors, confirmedCanceledInterceptions }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  let failureState=null;if(page){try{failureState=await snapshot();}catch{}}
  let mediaDiagnostics=null;if(page){try{mediaDiagnostics=await page.evaluate(`(() => {const v=document.querySelector('video'),r=window.FrameRuntime;return {nativeEvents:window.__rewardMediaQA??null,media:v?{currentTime:v.currentTime,readyState:v.readyState,paused:v.paused,seeking:v.seeking,playbackRate:v.playbackRate,muted:v.muted}:null,runtime:{watchKind:r?.watch?.kind,playerIntent:r?.playback.status,viewerSessionPresent:!!r?.session?.sid}};})()`);}catch{}}
  await writeFile(path.join(output,'rewards-ui-failure.json'),JSON.stringify({results,failure:failure.message,runtimeErrors:errors,confirmedCanceledInterceptions,writes,interactions,failureState,actualWatchProof,watchRequests,watchResponses,mediaDiagnostics},null,2));
  if(page)await screenshot('rewards-ui-failure.png').catch(()=>{});throw failure;
} finally {
  if(page){await Promise.race([page.send('Browser.close').catch(()=>{}),sleep(1000)]);page.close();}browser.kill();
  const literal=profile.replaceAll("'","''");
  try{execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`],{windowsHide:true,stdio:'ignore',timeout:10000});}catch{}
}
