// Real viewer questions and broadcaster answers, against the separate verification API only.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { Client, api, origin, liveBroadcast } from './questions-client.mjs';

const suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url'), output = path.resolve('verification/product');
const directory = path.resolve(process.env.FRAME_QUESTIONS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_QUESTIONS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external question fixture directory is required.');
const fixtureStreamKey = process.env.FRAME_QUESTIONS_FIXTURE_STREAM_KEY, fixturePath = fixtureStreamKey?.split('?')[0];
if (!fixtureStreamKey || !/^obs-question-[0-9a-f]{12}$/.test(fixturePath ?? '')) throw Error('The dedicated isolated question stream credential is required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), 'frame-questions-ui-')), profile = path.join(browserDirectory, 'profile');
const results = [], errors = [], writes = [], confirmedCanceledInterceptions = [], interactions = [];
const interceptedRequests = new Map(), canceledNetworkRequests = new Set(), pendingInterceptions = new Set();
let page, nextFailure, holdMutation = false, heldMutation, pageLimit = false, responseFailure = false, committedResponse = null, submittedBody = null;
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--remote-debugging-port=9530', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
await marker('browser-owner.json', { pid: browser.pid, profile });
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, parameters) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__questionQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, parameters);
  await until(async () => { try { return await page.evaluate(`window.__questionQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New question document');
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); }
async function reload() { await navigateDocument('Page.reload', {}); }
async function click(selector) {
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control: ' + selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector);
}
async function button(label, scope = 'document') {
  await until(() => page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});return !!element&&!element.matches(':disabled');})()`), 'Enabled button: ' + label);
  await page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});element.dataset.questionQaTarget='true';element.scrollIntoView({block:'center'});})()`);
  await until(() => page.evaluate(`(() => {const element=document.querySelector('[data-question-qa-target]');if(!element||element.matches(':disabled'))return false;const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===element;})()`), 'Clickable button: ' + label);
  interactions.push({ label, phase: 'before', ...(await snapshot()) }); await page.click('[data-question-qa-target]');
  interactions.push({ label, phase: 'after', ...(await snapshot()) }); if (interactions.length > 30) interactions.splice(0, interactions.length - 30);
  await page.evaluate(`document.querySelector('[data-question-qa-target]')?.removeAttribute('data-question-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function snapshot() {
  return page.evaluate(`(() => {const e=document.querySelector('[data-question-qa-target]'),r=e?.getBoundingClientRect();return {path:location.pathname,visibility:document.visibilityState,focused:document.hasFocus(),dialogOpen:!!document.querySelector('dialog[open]'),target:e?{disabled:e.matches(':disabled'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:null};})()`);
}
async function interceptionCommand(command, parameters) {
  const request = interceptedRequests.get(parameters.requestId);
  try { return await page.send(command, parameters); }
  catch (failure) {
    if (/Invalid InterceptionId\.?/.test(failure.message) && request?.networkId) {
      if (!canceledNetworkRequests.has(request.networkId)) await sleep(100);
      if (canceledNetworkRequests.has(request.networkId)) { confirmedCanceledInterceptions.push({ method: request.method, path: request.path, command, confirmedBy: 'Network.loadingFailed:canceled' }); return; }
    }
    failure.questionQaContext = { source: 'Fetch', method: request?.method ?? null, path: request?.path ?? null, command, hasNetworkId: Boolean(request?.networkId), error: failure.message }; throw failure;
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
    if (responseFailure && request.method === 'POST' && url.pathname === '/api/v1/questions') {
      responseFailure = false; committedResponse = { status: event.params.responseStatusCode, body: submittedBody };
      await fulfill(requestId, { status: 503, code: 'PRODUCT_UNAVAILABLE', detail: '질문 전송 결과를 확인하지 못했어요.' }); return;
    }
    await interceptionCommand('Fetch.continueRequest', { requestId }); return;
  }
  if (request.method !== 'GET') writes.push({ method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') });
  if (request.method === 'POST' && url.pathname === '/api/v1/questions') submittedBody = JSON.parse(request.postData);
  if (nextFailure?.matches(request.method, url)) { const failure = nextFailure; nextFailure = null; await fulfill(requestId, failure); return; }
  if (holdMutation && request.method !== 'GET') { heldMutation = requestId; return; }
  if (pageLimit && request.method === 'GET' && url.pathname === '/api/v1/me/questions') { url.searchParams.set('limit', '2'); await interceptionCommand('Fetch.continueRequest', { requestId, url: url.href }); return; }
  await interceptionCommand('Fetch.continueRequest', { requestId });
}
const failure503 = (method, endpoint, detail, cursor = false) => ({ status: 503, code: 'PRODUCT_UNAVAILABLE', detail, matches: (actual, url) => actual === method && url.pathname === '/api/v1' + endpoint && (!cursor || url.searchParams.has('cursor')) });
async function createAccount(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const email = `questions_ui_${kind}_${suffix}@example.invalid`, displayName = `질문 검증 ${kind} ${suffix}`;
  const response = await client.request('POST', '/auth/register', { email, password, displayName, ...consent });
  if (response.status !== 201) throw Error('Dedicated question account registration returned HTTP ' + response.status);
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
  for (let i = 0; i < 60; i++) { try { page = await connect(9530, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Question QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.loadingFailed' && event.params.canceled === true) canceledNetworkRequests.add(event.params.requestId);
    if (event.method === 'Fetch.requestPaused') { const pending = intercept(event).catch(failure => errors.push(failure.questionQaContext ?? failure.message)); pendingInterceptions.add(pending); void pending.finally(() => pendingInterceptions.delete(pending)); }
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const bootstrap = new Client(), policies = await bootstrap.request('GET', '/policies');
  if (policies.status !== 200) throw Error('Signup policies are unavailable in the isolated app.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  const owner = await createAccount('owner', consent), asker = await createAccount('asker', consent), other = await createAccount('other', consent), restricted = await createAccount('restricted', consent);
  const connection = await owner.client.request('POST', '/me/channel/connection', { streamKey: fixtureStreamKey });
  if (connection.status !== 200) throw Error('Dedicated stream ownership connection returned HTTP ' + connection.status);
  await owner.client.request('PUT', '/studio', { title: `함께 나누는 질문과 답변 ${suffix}`, publisher: owner.displayName });
  await marker('ready-live.json', { path: fixturePath }); let broadcast = await liveBroadcast(fixturePath);
  async function context() {
    for (let i = 0; i < 100; i++) { const result = await owner.client.request('GET', '/me/questions?limit=1'); if (result.status === 200 && result.data.currentBroadcast?.id === broadcast.id) return result.data; await sleep(200); }
    throw Error('The owner question API did not expose the fresh owned source.');
  }
  await context();
  const publicQuestions = (client, item = broadcast, query = {}) => client.request('GET', '/questions/current?' + new URLSearchParams({ path: fixturePath, broadcastId: item.id, ...query }));
  const makeBody = text => ({ path: fixturePath, broadcastId: broadcast.id, text, clientRequestId: randomUUID() });
  async function ask(client, text) { const result = await client.request('POST', '/questions', makeBody(text)); if (result.status !== 201) throw Error('Real question submission returned HTTP ' + result.status); return result.data.item; }
  const detail = id => owner.client.request('GET', `/me/questions/${id}`);
  const patch = (item, body) => owner.client.request('PATCH', `/me/questions/${item.id}`, { version: item.version, ...body });
  const firstBody = makeBody(`개발은 어떤 순서로 진행하나요 ${suffix}`), duplicate = await Promise.all([asker.client.request('POST', '/questions', firstBody), asker.client.request('POST', '/questions', firstBody)]);
  const first = duplicate.find(result => result.status === 201)?.data.item;
  check(first && duplicate.filter(result => result.status === 201).length === 1 && duplicate.filter(result => result.status === 200).length === 1 && duplicate.every(result => result.data.item.id === first.id), 'Concurrent retries of one account request UUID create exactly one real private question');
  const changed = await asker.client.request('POST', '/questions', { ...firstBody, text: '같은 요청의 다른 질문' });
  check(changed.status === 409 && changed.data.code === 'QUESTION_REQUEST_CONFLICT', 'Reusing a request UUID with different content is rejected instead of silently replacing a question');
  const anonymous = new Client(); await anonymous.request('GET', '/session');
  const guestView = await publicQuestions(anonymous), foreignView = await publicQuestions(other.client), ownView = await publicQuestions(asker.client);
  const foreignDetail = await other.client.request('GET', `/me/questions/${first.id}`), anonymousAsk = await anonymous.request('POST', '/questions', makeBody('익명 전송'));
  check(guestView.status === 200 && guestView.data.userId === null && guestView.data.pinned === null && guestView.data.mine.length === 0 && guestView.data.reason === 'login_required'
    && foreignView.data.mine.length === 0 && foreignView.data.pinned === null && ownView.data.mine.length === 1 && ownView.data.mine[0].clientRequestId === firstBody.clientRequestId && foreignDetail.status === 404 && anonymousAsk.status === 401,
    'Waiting questions are visible only to their author and channel owner, while anonymous and other viewers receive no private rows');
  const guarded = await other.client.request('GET', '/me/questions', undefined, { expectedUserId: owner.user.id });
  check(guarded.status === 409 && guarded.data.code === 'SESSION_CHANGED' && !guarded.data.items, 'Private question management rejects an unexpected account scope before returning rows');
  const waiting = await ask(asker.client, `다음 방송 일정은 언제인가요 ${suffix}`); await ask(asker.client, `작업 도구도 소개해 주세요 ${suffix}`);
  const limited = await asker.client.request('POST', '/questions', makeBody('네 번째 새 질문'));
  const limitedView = (await publicQuestions(asker.client)).data;
  check(limited.status === 429 && limited.data.code === 'QUESTION_RATE_LIMITED' && Number(limited.headers.get('retry-after')) > 0 && limitedView.mine.length === 3 && !limitedView.canSubmit && limitedView.reason === 'rate_limited' && limitedView.retryAfterMs > 0, 'Only three accepted questions consume the account minute limit and the fourth returns a real retry interval');
  async function settings(values) { const current = (await owner.client.request('GET', '/me/chat/settings')).data; return owner.client.request('PATCH', '/me/chat/settings', { version: current.version, slowMode: current.slowMode, slowSeconds: current.slowSeconds, followersOnly: current.followersOnly, blockLinks: current.blockLinks, bannedWords: current.bannedWords, ...values }); }
  await settings({ followersOnly: true, slowMode: true, slowSeconds: 120, blockLinks: true, bannedWords: ['금칙어'] });
  const followDenied = await restricted.client.request('POST', '/questions', makeBody('참여할 수 있나요'));
  await restricted.client.request('PUT', `/me/follows/${owner.channel.id}`, {});
  const blockedRow = await owner.client.request('POST', '/me/chat/blocks', { targetChannelId: restricted.channel.id, durationSeconds: null, reason: '질문 권한 검증' });
  const blockDenied = await restricted.client.request('POST', '/questions', makeBody('차단된 계정 질문'));
  await owner.client.request('DELETE', `/me/chat/blocks/${blockedRow.data.item.id}?version=${blockedRow.data.item.version}`);
  const wordDenied = await restricted.client.request('POST', '/questions', makeBody('금칙어 포함 질문')), linkDenied = await restricted.client.request('POST', '/questions', makeBody('https://example.invalid 연결'));
  const unicodeLinkDenied = await restricted.client.request('POST', '/questions', makeBody('example.한국 주소를 포함한 질문'));
  check(unicodeLinkDenied.status === 400 && unicodeLinkDenied.data.code === 'QUESTION_LINK_BLOCKED', 'Stored link blocking rejects a real question containing a Unicode top-level domain');
  const acceptedRestricted = await ask(restricted.client, `규칙을 지킨 질문 ${suffix}`);
  check(followDenied.status === 403 && followDenied.data.code === 'QUESTION_FOLLOW_REQUIRED' && blockDenied.status === 403 && blockDenied.data.code === 'QUESTION_PARTICIPATION_BLOCKED'
    && wordDenied.status === 400 && wordDenied.data.code === 'QUESTION_WORD_BLOCKED' && linkDenied.status === 400 && linkDenied.data.code === 'QUESTION_LINK_BLOCKED' && acceptedRestricted.id && (await publicQuestions(restricted.client)).data.mine.length === 1,
    'Stored follow, block, word and link rules protect new questions without charging rejected submissions or applying chat slow mode');
  await settings({ followersOnly: false, slowMode: false, blockLinks: false, bannedWords: [] });
  const answerText = `화면부터 만든 뒤 실제 저장과 권한을 연결해요. ${suffix}`;
  let answered = (await patch(first, { answer: answerText })).data.item;
  check(answered.answer === answerText && answered.answeredAtMs > 0 && (await publicQuestions(other.client)).data.pinned === null && (await publicQuestions(asker.client)).data.mine.find(item => item.id === first.id).answer === answerText,
    'An unpinned answer is stored for its author and owner without exposing the private answer to other viewers');
  const pinnedWaiting = await patch(waiting, { pinned: true }), publicWaiting = (await publicQuestions(anonymous)).data;
  check(pinnedWaiting.status === 200 && publicWaiting.pinned?.id === waiting.id && publicWaiting.pinned.answer === null && !('clientRequestId' in publicWaiting.pinned)
    && Object.keys(publicWaiting.pinned.author).sort().join(',') === 'channelId,displayName,handle', 'The owner can publicly pin an unanswered question without exposing its request UUID or private account identifier');
  answered = (await patch(answered, { pinned: true })).data.item;
  const replaced = (await detail(waiting.id)).data.item, publicReplaced = (await publicQuestions(other.client)).data;
  check(publicReplaced.pinned?.id === first.id && publicReplaced.pinned.answer === answerText && !replaced.pinned && replaced.version > pinnedWaiting.data.item.version,
    'Pin replacement atomically exposes one question and increments the displaced question version');
  const stalePin = await patch(pinnedWaiting.data.item, { pinned: false });
  check(stalePin.status === 409 && stalePin.data.code === 'QUESTION_CONFLICT', 'An editor holding the displaced pin version cannot overwrite a newer atomic pin replacement');
  answered = (await patch(answered, { pinned: false })).data.item;
  check((await publicQuestions(anonymous)).data.pinned === null && (await publicQuestions(asker.client)).data.mine.find(item => item.id === first.id).answer === answerText, 'Unpinning immediately removes the public card while preserving the private answer history');
  answered = (await patch(answered, { pinned: true })).data.item;
  const oldBroadcast = broadcast; await marker('replace-live.json', { previousBroadcastId: oldBroadcast.id }); await waitMarker('replaced-live.json'); broadcast = await liveBroadcast(fixturePath, oldBroadcast.id); await context();
  const oldView = await publicQuestions(asker.client, oldBroadcast), freshView = await publicQuestions(anonymous);
  const oldSubmit = await other.client.request('POST', '/questions', { ...makeBody('종료된 방송의 신규 질문'), broadcastId: oldBroadcast.id });
  const oldOwner = (await detail(first.id)).data.item, oldAnswer = await patch(oldOwner, { answer: `방송 종료 후에도 답변은 남아요 ${suffix}` });
  const oldPin = await patch(oldAnswer.data.item, { pinned: true });
  check(oldView.data.pinned === null && oldView.data.mine.length === 3 && !oldView.data.canSubmit && freshView.data.pinned === null && oldSubmit.status === 409 && oldSubmit.data.code === 'QUESTION_BROADCAST_UNAVAILABLE'
    && oldAnswer.status === 200 && oldPin.status === 409 && oldPin.data.code === 'QUESTION_BROADCAST_UNAVAILABLE', 'A real same-path broadcast replacement removes public pins and new submission access while preserving old private history and owner answers');
  const oldReceipt = await asker.client.request('POST', '/questions', firstBody);
  check(oldReceipt.status === 200 && oldReceipt.data.item.id === first.id && (await publicQuestions(asker.client, oldBroadcast)).data.mine.length === 3, 'A saved request UUID confirms its original receipt after broadcast closure without creating another private question');
  const editorQuestion = await ask(owner.client, `답변 편집 확인 ${suffix}`);
  const requestPatterns = [{ urlPattern: '*api/v1/me/questions*' }, { urlPattern: '*api/v1/questions*' }];
  await page.send('Fetch.enable', { patterns: requestPatterns });
  await login(owner); pageLimit = true;
  nextFailure = failure503('GET', '/me/questions', '질문 목록을 불러오지 못했어요.'); await nav('/studio/polls?tab=questions'); await visibleText('질문 목록을 불러오지 못했어요'); await button('목록 다시 시도');
  const rows = () => page.evaluate(`Array.from(document.querySelectorAll('table[aria-label="시청자 질문 목록"] tbody tr')).map(row=>row.dataset.questionId)`);
  await until(async () => (await rows()).length === 2, 'Two real question rows'); await button('더 불러오기'); await until(async () => (await rows()).length === 4, 'Actual question cursor page');
  check((await rows()).length === 4 && new Set(await rows()).size === 4, 'The management list retries a real GET failure and appends an actual server cursor page without duplicate rows');
  await set('[name=question-query]', editorQuestion.text); await button('검색', 'document.querySelector("[name=question-query]").form'); await until(async () => (await rows()).length === 1, 'Server question filter');
  check((await rows())[0] === editorQuestion.id, 'Question search is applied by the real owner API instead of filtering only the loaded page');
  await click(`tr[data-question-id="${editorQuestion.id}"] button`); await has('dialog [name=question-answer]');
  check(await page.evaluate(`document.querySelector('dialog h2')?.textContent==='질문 답변'&&document.activeElement===document.querySelector('dialog h2')`), 'The intended question editor opens with its heading focused');
  const beforeInvalid = writes.length; await set('dialog [name=question-answer]', '가'.repeat(1001)); await button('저장', 'document.querySelector("dialog")'); await visibleText('답변을 1~1,000자로');
  check(writes.length === beforeInvalid && await page.evaluate(`document.activeElement.name==='question-answer'`), 'Oversized owner answers are rejected locally and focus their field');
  const uiAnswer = `질문을 모아서 차근차근 답변할게요.\n다음 방송에서도 이어가요. ${suffix}`;
  await set('dialog [name=question-answer]', uiAnswer); await click('dialog label:has(input[name=question-pinned])');
  nextFailure = failure503('PATCH', `/me/questions/${editorQuestion.id}`, '답변과 고정 상태를 저장하지 못했어요. 입력한 내용은 유지돼요.'); await button('저장', 'document.querySelector("dialog")'); await visibleText('답변과 고정 상태를 저장하지 못했어요');
  check(await page.evaluate(`document.querySelector('dialog [name=question-answer]').value===${JSON.stringify(uiAnswer)}&&document.querySelector('dialog [name=question-pinned]').checked`), 'Owner save 503 retains the complete multiline answer and public-pin choice');
  holdMutation = true; const beforeSave = writes.length; await button('저장', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held real answer save'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeSave + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog fieldset').disabled&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'Pending answer saving locks every control and prevents Escape dismissal or a duplicate mutation');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('답변과 고정 상태를 저장했어요');
  let savedEditor = (await detail(editorQuestion.id)).data.item;
  check(savedEditor.answer === uiAnswer && savedEditor.pinned && (await publicQuestions(anonymous)).data.pinned?.id === editorQuestion.id && await page.evaluate(`document.activeElement.getAttribute('role')==='status'`), 'A confirmed owner save persists its answer and public pin and focuses success feedback');
  await screenshot('questions-owner-ui.png');
  const conflictingDraft = `내가 작성하던 답변은 그대로 남아야 해요 ${suffix}`, externalAnswer = `다른 창에서 저장한 최신 답변 ${suffix}`;
  await set('dialog [name=question-answer]', conflictingDraft); await patch(savedEditor, { answer: externalAnswer }); await button('저장', 'document.querySelector("dialog")'); await visibleText('최신 상태 불러오기');
  check(await page.evaluate(`document.querySelector('dialog [name=question-answer]').value===${JSON.stringify(conflictingDraft)}&&Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent.trim()==='저장').disabled`), 'An actual version conflict preserves the owner draft and disables stale automatic resubmission');
  await button('최신 상태 불러오기', 'document.querySelector("dialog")'); await button('입력 유지', 'document.querySelector("dialog")');
  check(await page.evaluate(`document.querySelector('dialog [name=question-answer]').value===${JSON.stringify(conflictingDraft)}`), 'Declining the latest-state confirmation leaves the conflicting draft intact');
  await button('최신 상태 불러오기', 'document.querySelector("dialog")'); await button('불러오기', 'document.querySelector("dialog")'); await until(() => page.evaluate(`document.querySelector('dialog [name=question-answer]')?.value===${JSON.stringify(externalAnswer)}`), 'Explicit latest answer');
  check((await detail(editorQuestion.id)).data.item.answer === externalAnswer, 'The latest server answer replaces a draft only after explicit confirmation');
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true });
    check(await page.evaluate(`(() => {const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1;})()`), `The owner answer editor fits the ${width}px viewport`);
  }
  await screenshot('questions-owner-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await button('닫기', 'document.querySelector("dialog")'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Answer editor closed');
  check(await page.evaluate(`document.activeElement.closest('tr')?.dataset.questionId===${JSON.stringify(editorQuestion.id)}`), 'Closing the owner editor returns focus to its original question action');
  const watchRoute = `/watch/${fixturePath}/${broadcast.id}`;
  await page.send('Network.clearBrowserCookies'); await nav(watchRoute); await has('[aria-label="시청자 질문 열기"]'); await click('[aria-label="시청자 질문 열기"]'); await has('dialog[open]');
  check(await page.evaluate(`!!document.querySelector('dialog [aria-label="고정된 질문"]')&&!document.querySelector('dialog [aria-label="내 질문"]')&&document.querySelector('dialog').innerText.includes(${JSON.stringify(externalAnswer)})`), 'Anonymous viewers can see the deliberately pinned answer without receiving another account private history');
  await button('로그인하고 질문', 'document.querySelector("dialog")'); await has('#account-email');
  check(await page.evaluate(`new URLSearchParams(location.search).get('returnTo')===${JSON.stringify(watchRoute)}`), 'Question login preserves the exact current broadcast return route');
  await login(other); await nav(watchRoute); await has('[aria-label="시청자 질문 열기"]'); await click('[aria-label="시청자 질문 열기"]'); await has('dialog [name=viewer-question-text]');
  const viewerText = `방송에서 사용한 구성과 작업 순서가 궁금해요.\n자세히 설명해 주실 수 있나요? ${suffix}`;
  await set('dialog [name=viewer-question-text]', viewerText); nextFailure = failure503('POST', '/questions', '질문 전송 결과를 확인하지 못했어요.'); await button('질문 보내기', 'document.querySelector("dialog")'); await visibleText('전송 결과를 확인하지 못했어요');
  const retryBody = { ...submittedBody };
  check(await page.evaluate(`document.querySelector('dialog [name=viewer-question-text]').value===${JSON.stringify(viewerText)}&&document.querySelector('dialog [name=viewer-question-text]').readOnly`) && (await publicQuestions(other.client)).data.mine.length === 0,
    'An unknown submission failure retains and freezes the original draft without inventing a private question');
  holdMutation = true; const beforeQuestion = writes.length; await button('전송 다시 확인', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held question retry'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeQuestion + 1 && submittedBody.clientRequestId === retryBody.clientRequestId && submittedBody.text === retryBody.text && await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog textarea').readOnly&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`),
    'An uncertain retry reuses the exact request UUID and text while pending controls prevent duplicate send or Escape');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null; await visibleText('질문을 보냈어요');
  const firstViewer = (await publicQuestions(other.client)).data.mine[0];
  check(firstViewer.text === viewerText && firstViewer.clientRequestId === retryBody.clientRequestId && await page.evaluate(`document.querySelector('dialog textarea').value===''&&document.activeElement.getAttribute('role')==='status'`), 'The real submission is stored once, clears its confirmed draft and focuses the acknowledgement');
  const secondText = `다음에도 실시간으로 구현 과정을 볼 수 있을까요 ${suffix}`;
  await set('dialog [name=viewer-question-text]', secondText); responseFailure = true;
  await page.send('Fetch.enable', { patterns: [...requestPatterns, { urlPattern: origin + '/api/v1/questions', requestStage: 'Response' }] });
  await button('질문 보내기', 'document.querySelector("dialog")'); await until(() => committedResponse !== null, 'Real committed question response');
  await until(() => page.evaluate(`document.querySelector('dialog textarea')?.value===''&&!document.querySelector('dialog [role=alert]')`), 'Read-after-write question receipt');
  await page.send('Fetch.enable', { patterns: requestPatterns });
  const secondBody = committedResponse.body, confirmedMine = (await publicQuestions(other.client)).data.mine, secondViewer = confirmedMine.find(item => item.clientRequestId === secondBody.clientRequestId);
  const confirmedReceipt = await other.client.request('POST', '/questions', secondBody);
  check(committedResponse.status === 201 && secondViewer?.text === secondText && confirmedMine.length === 2 && confirmedReceipt.status === 200 && confirmedReceipt.data.item.id === secondViewer.id
    && await page.evaluate(`document.querySelectorAll('dialog [aria-label="내 질문"] li[data-question-id]').length===2&&!document.querySelector('dialog [role=alert]')`),
    'A real server commit followed by an injected 503 is recovered from its own receipt without duplicate rows or a stale failure message');
  await screenshot('questions-viewer-ui.png'); await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Viewer question dialog closes');
  check(await page.evaluate(`document.activeElement.getAttribute('aria-label')==='시청자 질문 열기'`), 'Closing the viewer dialog returns focus to its question opener');
  await reload(); await has('[aria-label="시청자 질문 열기"]'); await click('[aria-label="시청자 질문 열기"]'); await has(`dialog li[data-question-id="${secondViewer.id}"]`);
  check(await page.evaluate(`document.querySelectorAll('dialog [aria-label="내 질문"] li[data-question-id]').length===2&&document.querySelector('dialog').innerText.includes(${JSON.stringify(viewerText)})`), 'The actual account private question history survives browser reload');
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true });
    check(await page.evaluate(`(() => {const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1;})()`), `The viewer question composer and private history fit the ${width}px viewport`);
    check(await page.evaluate(`(() => {const section=document.querySelector('dialog [aria-label="고정된 질문"]'),heading=section?.querySelector('h3'),handle=heading?.parentElement.querySelector(':scope > span');if(!heading||!handle)return false;const style=getComputedStyle(heading),lineHeight=Number.parseFloat(style.lineHeight)||Number.parseFloat(style.fontSize)*1.2,r=heading.getBoundingClientRect(),h=handle.getBoundingClientRect(),s=section.getBoundingClientRect();return heading.textContent.trim()==='고정된 질문'&&r.height<=lineHeight*1.2&&handle.textContent.trim()===${JSON.stringify('@' + owner.channel.handle)}&&handle.textContent.trim().length>=24&&h.left>=s.left-1&&h.right<=s.right+1&&handle.scrollWidth<=handle.clientWidth+1;})()`), `The pinned label stays on one line and its real long channel handle stays inside the ${width}px dialog`);
  }
  await screenshot('questions-viewer-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Network.clearBrowserCookies'); await page.send('Network.setCookies', { cookies: asker.client.saved().cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' })) }); await page.evaluate(`window.dispatchEvent(new Event('focus'))`);
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Cross-tab account scope reset');
  await nav(watchRoute); await has('[aria-label="시청자 질문 열기"]'); await click('[aria-label="시청자 질문 열기"]'); await has('dialog [aria-label="내 질문"]');
  check(await page.evaluate(`document.querySelectorAll('dialog li[data-question-id]').length===0&&!document.querySelector('dialog').innerText.includes(${JSON.stringify(viewerText)})`), 'A shared-cookie account switch clears the previous account private questions instead of applying another owner response');
  await login(owner); await nav('/studio/polls?tab=questions'); await has('table[aria-label="시청자 질문 목록"]');
  const finalEditor = (await detail(editorQuestion.id)).data.item;
  check(finalEditor.answer === externalAnswer && finalEditor.pinned && (await publicQuestions(other.client)).data.mine.length === 2, 'Final persisted answers and private submissions remain unchanged after navigation and account switching');
  await Promise.all([...pendingInterceptions]); check(errors.length === 0, 'No browser runtime or unconfirmed interception errors');
  await marker('questions-checkpoint.json', { owner: owner.client.saved(), viewer: other.client.saved(), path: fixturePath, broadcastId: broadcast.id,
    answeredQuestionId: editorQuestion.id, pinnedQuestionId: editorQuestion.id, answer: externalAnswer,
    viewerQuestions: confirmedMine.map(item => ({ id: item.id, clientRequestId: item.clientRequestId, text: item.text })), receiptBody: secondBody, receiptQuestionId: secondViewer.id });
  await writeFile(path.join(output, 'questions-ui-result.json'), JSON.stringify({ verificationDatabaseOnly: true, origin, api, checks: results.length, passed: results.filter(result => result.pass).length,
    realSources: ['One isolated MediaMTX/FFmpeg source replaced sequentially on the same path', 'Real PostgreSQL account submissions, owner answers and channel policies'],
    paginationInstrumentation: 'Owner question GET limit is lowered to 2; rows and opaque cursors are actual server responses.',
    faultInjection: ['Owner GET 503', 'Owner PATCH 503/delay', 'Submission request-stage 503/delay', 'Submission response-stage 503 after actual HTTP 201 server commit'],
    results, runtimeErrors: errors, confirmedCanceledInterceptions }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  let failureState=null;if(page){try{failureState=await snapshot();}catch{}}
  await writeFile(path.join(output,'questions-ui-failure.json'),JSON.stringify({results,failure:failure.message,runtimeErrors:errors,confirmedCanceledInterceptions,writes,interactions,failureState},null,2));
  if(page)await screenshot('questions-ui-failure.png').catch(()=>{});throw failure;
} finally {
  if(page){await Promise.race([page.send('Browser.close').catch(()=>{}),sleep(1000)]);page.close();}browser.kill();
  const literal=profile.replaceAll("'","''");
  try{execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`],{windowsHide:true,stdio:'ignore',timeout:10000});}catch{}
}
