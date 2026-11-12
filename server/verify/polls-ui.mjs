// Real broadcaster polls and member voting, against the separate verification API only.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { Client, api, origin, liveBroadcast } from './polls-client.mjs';

const suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url'), output = path.resolve('verification/product');
const directory = path.resolve(process.env.FRAME_POLLS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_POLLS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external poll fixture directory is required.');
const fixtureStreamKey = process.env.FRAME_POLLS_FIXTURE_STREAM_KEY, fixturePath = fixtureStreamKey?.split('?')[0];
if (!fixtureStreamKey || !/^obs-poll-[0-9a-f]{12}$/.test(fixturePath ?? '')) throw Error('The dedicated isolated poll stream credential is required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), 'frame-polls-ui-')), profile = path.join(browserDirectory, 'profile');
const results = [], errors = [], writes = [], confirmedCanceledInterceptions = [], interactions = [];
const interceptedRequests = new Map(), canceledNetworkRequests = new Set(), pendingInterceptions = new Set();
let page, nextFailure, holdMutation = false, heldMutation, pageLimit = false;
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--remote-debugging-port=9520', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
await marker('browser-owner.json', { pid: browser.pid, profile });
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, parameters) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__pollQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, parameters);
  await until(async () => { try { return await page.evaluate(`window.__pollQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New chat management document');
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); }
async function reload() { await navigateDocument('Page.reload', {}); }
async function click(selector) {
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control: ' + selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector);
}
async function button(label, scope = 'document') {
  await until(() => page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});return !!element&&!element.matches(':disabled');})()`), 'Enabled button: ' + label);
  await page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});element.dataset.pollQaTarget='true';element.scrollIntoView({block:'center'});})()`);
  await until(() => page.evaluate(`(() => {const element=document.querySelector('[data-poll-qa-target]');if(!element||element.matches(':disabled'))return false;const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===element;})()`), 'Clickable button: ' + label);
  interactions.push({ label, phase: 'before', ...(await snapshot()) }); await page.click('[data-poll-qa-target]');
  interactions.push({ label, phase: 'after', ...(await snapshot()) }); if (interactions.length > 30) interactions.splice(0, interactions.length - 30);
  await page.evaluate(`document.querySelector('[data-poll-qa-target]')?.removeAttribute('data-poll-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function snapshot() {
  return page.evaluate(`(() => {const e=document.querySelector('[data-poll-qa-target]'),r=e?.getBoundingClientRect();return {path:location.pathname,visibility:document.visibilityState,focused:document.hasFocus(),dialogOpen:!!document.querySelector('dialog[open]'),target:e?{disabled:e.matches(':disabled'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:null};})()`);
}
async function interceptionCommand(command, parameters) {
  const request = interceptedRequests.get(parameters.requestId);
  try { return await page.send(command, parameters); }
  catch (failure) {
    if (/Invalid InterceptionId\.?/.test(failure.message) && request?.networkId) {
      if (!canceledNetworkRequests.has(request.networkId)) await sleep(100);
      if (canceledNetworkRequests.has(request.networkId)) { confirmedCanceledInterceptions.push({ method: request.method, path: request.path, command, confirmedBy: 'Network.loadingFailed:canceled' }); return; }
    }
    failure.pollQaContext = { source: 'Fetch', method: request?.method ?? null, path: request?.path ?? null, command, hasNetworkId: Boolean(request?.networkId), error: failure.message }; throw failure;
  } finally { interceptedRequests.delete(parameters.requestId); }
}
async function fulfill(requestId, failure) {
  await interceptionCommand('Fetch.fulfillRequest', { requestId, responseCode: failure.status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify({ code: failure.code, detail: failure.detail })).toString('base64') });
}
async function intercept(event) {
  const { requestId, request } = event.params, url = new URL(request.url);
  interceptedRequests.set(requestId, { networkId: event.params.networkId, method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') });
  if (request.method !== 'GET') writes.push({ method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') });
  if (nextFailure?.matches(request.method, url)) { const failure = nextFailure; nextFailure = null; await fulfill(requestId, failure); return; }
  if (holdMutation && request.method !== 'GET') { heldMutation = requestId; return; }
  if (pageLimit && request.method === 'GET' && url.pathname === '/api/v1/me/polls') { url.searchParams.set('limit', '2'); await interceptionCommand('Fetch.continueRequest', { requestId, url: url.href }); return; }
  await interceptionCommand('Fetch.continueRequest', { requestId });
}
const failure503 = (method, endpoint, detail, cursor = false) => ({ status: 503, code: 'PRODUCT_UNAVAILABLE', detail, matches: (actual, url) => actual === method && url.pathname === '/api/v1' + endpoint && (!cursor || url.searchParams.has('cursor')) });
async function createAccount(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const email = `polls_ui_${kind}_${suffix}@example.invalid`, displayName = `투표 검증 ${kind} ${suffix}`;
  const response = await client.request('POST', '/auth/register', { email, password, displayName, ...consent });
  if (response.status !== 201) throw Error('Dedicated chat account registration returned HTTP ' + response.status);
  return { client, email, displayName, user: response.data.user, channel: response.data.channel };
}
async function login(account) {
  await page.send('Network.clearBrowserCookies'); await nav('/login'); await has('#account-email');
  await set('[name=email]', account.email); await set('[name=password]', password); await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
}
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, name), await page.screenshot()); }
async function marker(name, value) { const target = path.join(directory, name), temporary = target + '.tmp'; await writeFile(temporary, JSON.stringify(value)); await rename(temporary, target); }
async function waitMarker(name) { for (let i = 0; i < 600; i++) { try { await access(path.join(directory, name)); return; } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } await sleep(100); } throw Error('Timeout waiting for the owned source marker.'); }
function expire(poll) {
  try { execFileSync(process.execPath, [path.resolve('server/verify/polls-fixture.mjs'), 'expire', poll.id], { windowsHide: true, stdio: 'pipe', timeout: 15000 }); }
  catch { throw Error('The exact isolated poll expiry fixture could not be advanced.'); }
}

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9520, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Poll QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.loadingFailed' && event.params.canceled === true) canceledNetworkRequests.add(event.params.requestId);
    if (event.method === 'Fetch.requestPaused') { const pending = intercept(event).catch(failure => errors.push(failure.pollQaContext ?? failure.message)); pendingInterceptions.add(pending); void pending.finally(() => pendingInterceptions.delete(pending)); }
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const bootstrap = new Client(), policies = await bootstrap.request('GET', '/policies');
  if (policies.status !== 200) throw Error('Signup policies are unavailable in the isolated app.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  const owner = await createAccount('owner', consent), voter = await createAccount('voter', consent), second = await createAccount('second', consent), restricted = await createAccount('restricted', consent);
  let response = await owner.client.request('POST', '/me/channel/connection', { streamKey: fixtureStreamKey });
  if (response.status !== 200) throw Error('Dedicated stream ownership connection returned HTTP ' + response.status);
  await owner.client.request('PUT', '/studio', { title: `함께 정하는 다음 작업 ${suffix}`, publisher: owner.displayName });
  await marker('ready-live.json', { path: fixturePath }); let broadcast = await liveBroadcast(fixturePath);
  async function context() {
    for (let i = 0; i < 100; i++) { const result = await owner.client.request('GET', '/me/polls?limit=1'); if (result.status === 200 && result.data.currentBroadcast?.id === broadcast.id) return result.data; await sleep(200); }
    throw Error('The owner poll API did not expose the fresh owned source.');
  }
  await context();
  const choices = ['화면 개선', '새 기능', '오류 수정'];
  const makeBody = question => ({ question, options: choices, durationSeconds: 600, broadcastId: broadcast.id, path: fixturePath });
  async function create(question) { const result = await owner.client.request('POST', '/me/polls', makeBody(question)); if (result.status !== 201) throw Error('Real poll creation returned HTTP ' + result.status); return result.data.poll; }
  const publicPoll = (client, item = broadcast) => client.request('GET', '/polls/current?' + new URLSearchParams({ path: fixturePath, broadcastId: item.id }));
  const vote = (client, poll, optionId, item = broadcast) => client.request('POST', `/polls/${poll.id}/votes`, { optionId, broadcastId: item.id, path: fixturePath });
  const first = await create(`API 실제 투표 ${suffix}`), another = await owner.client.request('POST', '/me/polls', makeBody('동시 활성 금지'));
  check(another.status === 409 && another.data.code === 'POLL_ACTIVE_EXISTS' && first.totalVotes === 0 && first.status === 'active', 'One real active poll is created for the owned broadcast and a second active slot is rejected');
  const anonymous = new Client(); await anonymous.request('GET', '/session');
  const publicAnonymous = await publicPoll(anonymous), anonymousVote = await vote(anonymous, first, first.options[0].id);
  const foreign = await second.client.request('GET', `/me/polls/${first.id}`), scopeChanged = await second.client.request('GET', '/me/polls', undefined, { expectedUserId: owner.user.id });
  check(publicAnonymous.status === 200 && publicAnonymous.data.userId === null && publicAnonymous.data.poll.myOptionId === null && anonymousVote.status === 401 && foreign.status === 404 && scopeChanged.status === 409,
    'Public aggregates allow anonymous reads while votes, owner history and account scope remain protected');
  const ownerVote = await vote(owner.client, first, first.options[0].id);
  const concurrent = await Promise.all([vote(voter.client, first, first.options[1].id), vote(voter.client, first, first.options[2].id)]);
  const winning = concurrent.find(result => result.status === 200)?.data.poll.myOptionId;
  check(ownerVote.status === 200 && concurrent.filter(result => result.status === 200).length === 1 && concurrent.filter(result => result.status === 409 && result.data.code === 'POLL_ALREADY_VOTED').length === 1 && winning,
    'The owner may vote and concurrent different choices from one account create exactly one accepted vote');
  const repeated = await vote(voter.client, first, winning), secondVote = await vote(second.client, first, first.options[2].id);
  check(repeated.status === 200 && repeated.data.poll.totalVotes === 2 && secondVote.status === 200 && secondVote.data.poll.totalVotes === 3, 'Same-choice retries are idempotent and a different account adds one separate vote');
  const settings = (await owner.client.request('GET', '/me/chat/settings')).data;
  await owner.client.request('PATCH', '/me/chat/settings', { version: settings.version, slowMode: true, slowSeconds: 120, followersOnly: true, blockLinks: true, bannedWords: ['기능'] });
  const followers = await vote(restricted.client, first, first.options[1].id);
  const block = await owner.client.request('POST', '/me/chat/blocks', { targetChannelId: restricted.channel.id, durationSeconds: null, reason: '투표 참여 권한 검증' });
  const blocked = await vote(restricted.client, first, first.options[1].id); await owner.client.request('DELETE', `/me/chat/blocks/${block.data.item.id}?version=${block.data.item.version}`);
  await restricted.client.request('PUT', `/me/follows/${owner.channel.id}`, {}); const eligible = await vote(restricted.client, first, first.options[1].id);
  check(followers.status === 403 && followers.data.code === 'POLL_FOLLOW_REQUIRED' && blocked.status === 403 && blocked.data.code === 'POLL_PARTICIPATION_BLOCKED' && eligible.status === 200 && eligible.data.poll.totalVotes === 4,
    'Stored follower and block policies control voting, while chat slow/link/banned-word rules do not consume or reject a ballot');
  const voterView = await publicPoll(voter.client), secondView = await publicPoll(second.client);
  check(voterView.data.userId === voter.user.id && voterView.data.poll.myOptionId === winning && secondView.data.poll.myOptionId === first.options[2].id && Number.isSafeInteger(voterView.data.serverNowMs), 'Each account receives only its own selected option with a real server clock');
  const wrongVersion = await owner.client.request('POST', `/me/polls/${first.id}/close`, { version: first.version + 1 });
  const manual = await owner.client.request('POST', `/me/polls/${first.id}/close`, { version: first.version });
  const receipt = await vote(voter.client, first, winning);
  check(wrongVersion.status === 409 && wrongVersion.data.code === 'POLL_CONFLICT' && manual.status === 200 && manual.data.poll.closeReason === 'manual' && manual.data.poll.totalVotes === 4 && receipt.status === 200 && receipt.data.poll.totalVotes === 4,
    'Versioned manual closure preserves four votes and later same-choice receipt retries add no vote');
  const oldBroadcast = broadcast, old = await create(`이전 방송 보호 ${suffix}`);
  await marker('replace-live.json', { previousBroadcastId: broadcast.id }); await waitMarker('replaced-live.json'); broadcast = await liveBroadcast(fixturePath, oldBroadcast.id); await context();
  const ended = await publicPoll(voter.client, oldBroadcast), oldVote = await vote(second.client, old, old.options[0].id, oldBroadcast);
  check(ended.status === 200 && ended.data.poll.id === old.id && ended.data.poll.status === 'closed' && ended.data.poll.closeReason === 'broadcast_ended' && oldVote.status === 409 && oldVote.data.code === 'POLL_CLOSED', 'Replacing the actual source closes the old poll and rejects a new old-broadcast vote');
  const expiring = await create(`자동 마감 확인 ${suffix}`); expire(expiring); const expired = await publicPoll(voter.client), expiredVote = await vote(second.client, expiring, expiring.options[0].id);
  check(expired.data.poll.id === expiring.id && expired.data.poll.status === 'closed' && expired.data.poll.closeReason === 'expired' && expiredVote.status === 409, 'The real expiry path closes an elapsed fixture deadline and refuses a first vote after expiry');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/me/polls*' }, { urlPattern: '*api/v1/polls/*' }] });
  const rows = () => page.evaluate(`Array.from(document.querySelectorAll('table[aria-label="투표 목록"] tbody tr')).map(row=>row.innerText)`);
  await login(owner); pageLimit = true; nextFailure = failure503('GET', '/me/polls', '투표 목록을 불러오지 못했어요.'); await nav('/studio/polls'); await visibleText('투표 목록을 불러오지 못했어요');
  check((await rows()).length === 0 && await page.evaluate(`!!document.querySelector('main [role=alert]')`), 'Owner list 503 displays an error rather than fake poll history');
  await button('목록 다시 시도'); await until(async () => (await rows()).length === 2, 'First real poll history page'); await button('더 불러오기'); await until(async () => (await rows()).length === 3, 'Second real poll history page'); pageLimit = false;
  check(new Set(await rows()).size === 3, 'Actual two-row server cursor pages append the three independent closed polls once');
  await button('투표 만들기'); await has('dialog [name=poll-question]'); const beforeInvalid = writes.length; await button('투표 시작', 'document.querySelector("dialog")'); await visibleText('질문을 1~100자로');
  check(writes.length === beforeInvalid && await page.evaluate(`document.activeElement.name==='poll-question'`), 'Blank question is rejected locally and focuses its field');
  const uiQuestion = `다음 방송에서 무엇을 만들까요 ${suffix}`, uiOptions = choices.join('\n');
  await set('dialog [name=poll-question]', uiQuestion); await set('dialog [name=poll-options]', uiOptions); await set('dialog [name=poll-duration]', '600');
  nextFailure = failure503('POST', '/me/polls', '투표를 시작하지 못했어요. 입력한 내용은 유지돼요.'); await button('투표 시작', 'document.querySelector("dialog")'); await visibleText('투표를 시작하지 못했어요');
  check(await page.evaluate(`document.querySelector('dialog [name=poll-question]').value===${JSON.stringify(uiQuestion)}&&document.querySelector('dialog [name=poll-options]').value===${JSON.stringify(uiOptions)}&&document.querySelector('dialog [name=poll-duration]').value==='600'`), 'Create 503 retains question, multiline options and selected duration');
  holdMutation = true; const beforeCreate = writes.length; await button('투표 시작', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held poll create'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeCreate + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))&&document.querySelector('dialog fieldset').disabled`), 'Pending poll creation locks its modal and guards Escape and duplicate submission');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null;
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Real UI poll created'); await until(async () => (await rows()).some(row => row.includes(uiQuestion)), 'Created poll row');
  const created = (await owner.client.request('GET', '/me/polls?status=active')).data.items[0];
  check(created.question === uiQuestion && created.broadcastId === broadcast.id && created.options.length === 3, 'The owner modal creates the real poll bound to the current replacement broadcast');
  const displayedRemainingSeconds = await page.evaluate(`(() => {const row=Array.from(document.querySelectorAll('table[aria-label="투표 목록"] tbody tr')).find(row=>row.querySelector('th strong')?.textContent===${JSON.stringify(uiQuestion)});const match=row?.querySelector('[data-label="상태"] small')?.textContent.match(/^(\\d+):([0-5]\\d) 남음$/);return match?Number(match[1])*60+Number(match[2]):null;})()`);
  check(Number.isInteger(displayedRemainingSeconds) && displayedRemainingSeconds > 0 && displayedRemainingSeconds <= Math.ceil((created.endsAtMs - created.createdAtMs) / 1000), 'The active owner countdown never exceeds the poll duration returned by the server');
  await screenshot('polls-owner-ui.png');
  for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Owner poll history and controls fit the ${width}px viewport`); }
  await screenshot('polls-owner-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const watchRoute = `/watch/${fixturePath}/${broadcast.id}`; await page.send('Network.clearBrowserCookies'); await nav(watchRoute); await has(`[data-poll-id="${created.id}"] [aria-label="시청자 투표 열기"]`); await click('[aria-label="시청자 투표 열기"]'); await has('dialog[data-poll-id]');
  check(await page.evaluate(`Array.from(document.querySelectorAll('dialog button,a')).some(element=>element.textContent.trim()==='로그인하고 투표')`), 'Anonymous viewers can read a real poll result and receive an account-login action');
  await button('로그인하고 투표', 'document.querySelector("dialog")'); await has('#account-email');
  check(await page.evaluate(`new URLSearchParams(location.search).get('returnTo')===${JSON.stringify(watchRoute)}`), 'Voting login preserves the exact broadcast return path');
  await login(restricted); await nav(watchRoute); await has('[aria-label="시청자 투표 열기"]'); await click('[aria-label="시청자 투표 열기"]'); await has('dialog [name=poll-option]');
  const choice = created.options[1].id; await click(`dialog label:has(input[name="poll-option"][value="${choice}"])`);
  nextFailure = failure503('POST', `/polls/${created.id}/votes`, '투표하지 못했어요. 선택한 항목은 유지돼요.'); await button('투표하기', 'document.querySelector("dialog")'); await visibleText('투표하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog [name=poll-option]:checked')?.value===${JSON.stringify(choice)}`) && (await publicPoll(restricted.client)).data.poll.totalVotes === 0, 'Vote 503 preserves the selected option and modal without inventing a vote');
  holdMutation = true; const beforeVote = writes.length; await button('투표하기', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held real ballot'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeVote + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))&&document.querySelector('dialog fieldset').disabled`), 'Pending vote disables its modal and prevents a second ballot or Escape dismissal');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('투표했어요');
  check(await page.evaluate(`document.querySelector('dialog [data-poll-option-id=${JSON.stringify(choice)}]')?.innerText.includes('내 선택')`) && (await publicPoll(restricted.client)).data.poll.totalVotes === 1, 'A server-confirmed vote displays its own choice and exactly one aggregate vote');
  await screenshot('polls-viewer-ui.png'); await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Poll result closes'); await reload(); await has('[aria-label="시청자 투표 열기"]'); await click('[aria-label="시청자 투표 열기"]'); await has(`dialog [data-poll-option-id="${choice}"]`);
  check(await page.evaluate(`document.querySelector('dialog [data-mine="true"]')?.dataset.pollOptionId===${JSON.stringify(choice)}&&!document.querySelector('dialog [name=poll-option]')`), 'The account choice survives reload and the UI offers results instead of changing the vote');
  for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`(() => {const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1;})()`), `Viewer poll result modal fits the ${width}px viewport`); }
  await screenshot('polls-viewer-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await page.key('Escape');
  await login(owner); await nav('/studio/polls'); await has(`[aria-label="${uiQuestion} 투표 마감"]`); await click(`[aria-label="${uiQuestion} 투표 마감"]`); await has('dialog[open]');
  check(await page.evaluate(`document.querySelector('dialog h2')?.textContent==='투표를 마감할까요?'`), 'The owner close action opens the intended close confirmation');
  nextFailure = failure503('POST', `/me/polls/${created.id}/close`, '투표를 마감하지 못했어요.'); await button('투표 마감', 'document.querySelector("dialog")'); await visibleText('투표를 마감하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog').innerText.includes(${JSON.stringify(uiQuestion)})`), 'Manual-close 503 preserves the actual result and confirmation');
  await owner.client.request('POST', `/me/polls/${created.id}/close`, { version: created.version }); const beforeCloseConflict = writes.length; await button('투표 마감', 'document.querySelector("dialog")'); await visibleText('최신 결과 불러오기');
  check(writes.length === beforeCloseConflict + 1 && await page.evaluate(`Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent.trim()==='투표 마감')?.disabled`), 'Actual concurrent closure returns 409 and disables stale automatic resubmission');
  await button('최신 결과 불러오기', 'document.querySelector("dialog")'); await until(() => page.evaluate(`document.querySelector('dialog h2')?.textContent==='투표 결과'`), 'Latest closed result'); await button('닫기', 'document.querySelector("dialog")');
  const closing = await create(`마감 저장 확인 ${suffix}`); await button('새로고침'); await has(`[aria-label="${closing.question} 투표 마감"]`); await click(`[aria-label="${closing.question} 투표 마감"]`); await has('dialog[open]');
  holdMutation = true; const beforeClosing = writes.length; await button('투표 마감', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held actual close'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeClosing + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'Pending manual closure locks the confirmation and prevents duplicate writes');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('투표를 마감했어요');
  check((await owner.client.request('GET', `/me/polls/${closing.id}`)).data.poll.closeReason === 'manual', 'The management close action persists a real manual closed state'); await button('닫기', 'document.querySelector("dialog")');
  const finalPoll = await create(`재시작 보존 확인 ${suffix}`), ownerOptionId = finalPoll.options[0].id, viewerOptionId = finalPoll.options[2].id;
  await vote(owner.client, finalPoll, ownerOptionId); await vote(restricted.client, finalPoll, viewerOptionId); const finalView = await publicPoll(restricted.client);
  check(finalView.data.poll.totalVotes === 2 && finalView.data.poll.myOptionId === viewerOptionId, 'The final live poll stores two real account votes for restart verification');
  await Promise.all([...pendingInterceptions]); check(errors.length === 0, 'No browser runtime or unconfirmed interception errors');
  await marker('polls-checkpoint.json', { owner: owner.client.saved(), viewer: restricted.client.saved(), path: fixturePath, broadcastId: broadcast.id,
    activePoll: { id: finalPoll.id, totalVotes: 2 }, ownerOptionId, viewerOptionId, closedPollId: first.id });
  await writeFile(path.join(output, 'polls-ui-result.json'), JSON.stringify({ verificationDatabaseOnly: true, origin, api, checks: results.length, passed: results.filter(result => result.pass).length,
    realSources: ['One isolated MediaMTX/FFmpeg source replaced sequentially on the same path', 'Real PostgreSQL account votes and channel policies'],
    fixtureExpiry: 'Only one recent polls_ui_* poll ends_at_ms is shortened to created_at_ms+1, an already elapsed timestamp; closure itself is performed by the API.',
    paginationInstrumentation: 'Initial owner history GET limit is lowered to 2; rows and opaque cursors are actual server responses.',
    faultInjection: ['Owner GET 503', 'Create POST 503/delay', 'Vote POST 503/delay', 'Close POST 503/delay'], results, runtimeErrors: errors, confirmedCanceledInterceptions }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  let failureState=null;if(page){try{failureState=await snapshot();}catch{}}
  await writeFile(path.join(output,'polls-ui-failure.json'),JSON.stringify({results,failure:failure.message,runtimeErrors:errors,confirmedCanceledInterceptions,writes,interactions,failureState},null,2));
  if(page)await screenshot('polls-ui-failure.png').catch(()=>{});throw failure;
} finally {
  if(page){await Promise.race([page.send('Browser.close').catch(()=>{}),sleep(1000)]);page.close();}browser.kill();
  const literal=profile.replaceAll("'","''");
  try{execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`],{windowsHide:true,stdio:'ignore',timeout:10000});}catch{}
}
