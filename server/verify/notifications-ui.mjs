// Real private inbox UI checks target only the isolated verification app. No OS push or external messages are sent.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5365', api = 'http://127.0.0.1:18083';
const output = path.resolve('verification/product'), directory = await mkdtemp(path.join(tmpdir(), 'frame-notifications-ui-'));
const profile = path.join(directory, 'profile'), suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url');
const results = [], errors = [], writes = [], confirmedCanceledInterceptions = [];
const interactions = [], latestCountResponses = [];
const interceptedRequests = new Map(), canceledNetworkRequests = new Set(), pendingInterceptions = new Set();
let page, nextFailure, holdMutation = false, heldMutation, limitOverride = false;
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9500', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });

function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, params) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__notificationQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, params);
  await until(async () => { try { return await page.evaluate(`window.__notificationQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New notifications document');
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); }
async function reload() { await navigateDocument('Page.reload', {}); }
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label, scope = 'document') {
  await until(() => page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});return !!element&&!element.matches(':disabled');})()`), 'Enabled button: ' + label);
  await page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!element)throw Error('Missing button: '+${JSON.stringify(label)});element.dataset.notificationQaTarget='true';element.scrollIntoView({block:'center'});})()`);
  await until(() => page.evaluate(`(() => {const element=document.querySelector('[data-notification-qa-target="true"]');if(!element||element.matches(':disabled'))return false;const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('button')===element;})()`), 'Clickable button: ' + label);
  interactions.push({ label, phase: 'before', ...(await interactionSnapshot()) });
  await page.click('[data-notification-qa-target="true"]');
  interactions.push({ label, phase: 'after', ...(await interactionSnapshot()) });
  if (interactions.length > 40) interactions.splice(0, interactions.length - 40);
  await page.evaluate(`document.querySelector('[data-notification-qa-target]')?.removeAttribute('data-notification-qa-target')`);
}
async function interactionSnapshot() {
  return page.evaluate(`(() => {const element=document.querySelector('[data-notification-qa-target="true"]');const all=Array.from(document.querySelectorAll('main button')).find(button=>button.textContent.trim()==='모두 읽기');const describe=button=>{if(!button)return null;const rect=button.getBoundingClientRect();return {disabled:button.matches(':disabled'),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},centerHitsButton:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('button')===button};};return {visibility:document.visibilityState,focused:document.hasFocus(),path:location.pathname,unreadBadge:document.querySelector('.notification-unread-badge')?.textContent??null,rows:document.querySelectorAll('main [data-notification-id]').length,inboxBusy:document.querySelector('section[aria-labelledby="notifications-title"]')?.getAttribute('aria-busy')??null,target:describe(element),readAll:describe(all)};})()`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input: '+${JSON.stringify(selector)});const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function interceptionCommand(command, parameters) {
  const request = interceptedRequests.get(parameters.requestId);
  try { return await page.send(command, parameters); }
  catch (failure) {
    if (/Invalid InterceptionId\.?/.test(failure.message) && request?.networkId) {
      if (!canceledNetworkRequests.has(request.networkId)) await sleep(100);
      if (canceledNetworkRequests.has(request.networkId)) {
        confirmedCanceledInterceptions.push({ method: request.method, path: request.path, command, confirmedBy: 'Network.loadingFailed:canceled' }); return;
      }
    }
    failure.notificationQaContext = { source: 'Fetch', method: request?.method ?? null, path: request?.path ?? null, command, hasNetworkId: Boolean(request?.networkId), error: failure.message };
    throw failure;
  } finally { interceptedRequests.delete(parameters.requestId); }
}
async function fulfill(requestId, failure) {
  await interceptionCommand('Fetch.fulfillRequest', { requestId, responseCode: failure.status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify({ code: failure.code, detail: failure.detail })).toString('base64') });
}
async function intercept(event) {
  const { requestId, request } = event.params, url = new URL(request.url);
  interceptedRequests.set(requestId, { networkId: event.params.networkId, method: request.method,
    path: url.pathname.replace(/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?=\/|$)/gi, '/:id') });
  if (request.method !== 'GET') writes.push({ method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') });
  if (nextFailure?.matches(request.method, url)) { const failure = nextFailure; nextFailure = null; await fulfill(requestId, failure); return; }
  if (holdMutation && request.method !== 'GET') { heldMutation = requestId; return; }
  if (limitOverride && request.method === 'GET' && url.pathname === '/api/v1/me/notifications') {
    url.searchParams.set('limit', '2');
    await interceptionCommand('Fetch.continueRequest', { requestId, url: url.href }); return;
  }
  await interceptionCommand('Fetch.continueRequest', { requestId });
}
class Client {
  constructor(saved) { this.cookies = new Map(saved?.cookies?.map(({ name, value }) => [name, value]) ?? []); this.csrf = saved?.csrfToken ?? ''; }
  async request(method, route, body, options = {}) {
    const headers = { Accept: 'application/json', Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
    if (options.expectedUserId) headers['X-FRAME-USER-ID'] = options.expectedUserId;
    if (method !== 'GET') { headers.Origin = origin; if (this.csrf) headers['X-CSRF-TOKEN'] = this.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + '/api/v1' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'manual' });
    for (const raw of response.headers.getSetCookie()) {
      const first = raw.split(';')[0], split = first.indexOf('='), name = first.slice(0, split), value = first.slice(split + 1);
      if (/max-age=0(?:;|$)/i.test(raw) || !value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    let data; try { data = await response.json(); } catch { data = null; }
    if (typeof data?.csrfToken === 'string') this.csrf = data.csrfToken;
    if (typeof data?.unreadCount === 'number') {
      latestCountResponses.push({ method, path: route.split('?')[0].replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id'), status: response.status, unreadCount: data.unreadCount, userIdPresent: typeof data.userId === 'string' });
      if (latestCountResponses.length > 10) latestCountResponses.shift();
    }
    return { status: response.status, data, headers: response.headers };
  }
}
async function createAccount(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const email = kind === 'operator' ? `operator_ui_notifications_${suffix}@example.invalid` : `notifications_ui_${kind}_${suffix}@example.invalid`, displayName = `알림 검증 ${kind} ${suffix}`;
  const response = await client.request('POST', '/auth/register', { email, password, displayName, ...consent });
  if (response.status !== 201) throw Error(`Dedicated ${kind} signup returned HTTP ${response.status}`);
  return { client, email, displayName, user: response.data.user, channel: response.data.channel };
}
async function login(account) {
  await page.send('Network.clearBrowserCookies'); await nav('/login'); await has('#account-email');
  await set('[name=email]', account.email); await set('[name=password]', password); await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
  return page.evaluate(`fetch('/api/v1/session').then(response=>response.json())`);
}
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, name), await page.screenshot()); }
function permission(action, id) {
  if (!['grant', 'revoke'].includes(action) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw Error('Invalid isolated fixture permission request.');
  try { execFileSync(process.execPath, [path.resolve('server/verify/operator-fixture.mjs'), action, id], { windowsHide: true, stdio: 'pipe', timeout: 15000 }); }
  catch { throw Error('Isolated fixture permission ' + action + ' failed.'); }
}
function privateDirectory() {
  if (!process.env.FRAME_NOTIFICATION_TEST_DIR) throw Error('An external private notification fixture directory is required.');
  const target = path.resolve(process.env.FRAME_NOTIFICATION_TEST_DIR), relative = path.relative(path.resolve('.'), target);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('Notification fixture data must stay outside the repository.');
  return target;
}
async function marker(name, value = {}) {
  const target = path.join(privateDirectory(), name), temporary = target + '.tmp';
  await writeFile(temporary, JSON.stringify(value)); await rename(temporary, target);
}
async function waitMarker(name) {
  const target = path.join(privateDirectory(), name);
  for (let i = 0; i < 600; i++) { try { await access(target); return; } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } await sleep(100); }
  throw Error('Timeout waiting for isolated harness marker: ' + name);
}
async function waitInbox(client, test, label) {
  for (let i = 0; i < 100; i++) {
    const response = await client.request('GET', '/me/notifications');
    if (response.status === 200 && test(response.data)) return response.data;
    if (![200, 503].includes(response.status)) throw Error(label + ' returned HTTP ' + response.status);
    await sleep(300);
  }
  throw Error('Timeout: ' + label);
}

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9500, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Notifications QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.loadingFailed' && event.params.canceled === true) canceledNetworkRequests.add(event.params.requestId);
    if (event.method === 'Fetch.requestPaused') {
      const pending = intercept(event).catch(failure => errors.push(failure.notificationQaContext ?? failure.message));
      pendingInterceptions.add(pending); void pending.finally(() => pendingInterceptions.delete(pending));
    }
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const checkpointDirectory = privateDirectory(); await mkdir(checkpointDirectory, { recursive: true });
  const fixtureStreamKey = process.env.FRAME_NOTIFICATION_FIXTURE_STREAM_KEY;
  const fixturePath = fixtureStreamKey?.split('?')[0];
  if (!fixtureStreamKey || !/^obs-notification-[0-9a-f]{12}$/.test(fixturePath ?? '')) throw Error('The dedicated isolated notification stream credential is required.');
  const bootstrap = new Client(), policies = await bootstrap.request('GET', '/policies');
  if (policies.status !== 200) throw Error('Signup policies are unavailable in the verification app.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  const owner = await createAccount('owner', consent), recipient = await createAccount('recipient', consent), emptyAccount = await createAccount('empty', consent), operator = await createAccount('operator', consent);
  permission('grant', operator.user.id);
  let response = await owner.client.request('POST', '/me/channel/connection', { streamKey: fixtureStreamKey });
  if (response.status !== 200) throw Error('Isolated stream ownership connection returned HTTP ' + response.status);
  const liveTitle = `함께 만드는 작은 작업실 ${suffix}`;
  response = await owner.client.request('PUT', '/studio', { title: liveTitle, publisher: owner.displayName });
  if (response.status !== 200) throw Error('Isolated broadcast metadata returned HTTP ' + response.status);
  response = await recipient.client.request('PUT', `/me/follows/${owner.channel.id}`, { notificationsOn: true });
  check(response.status === 200 && response.data.following && response.data.notificationsOn, 'A real recipient follows the broadcaster with live notifications enabled before publishing');
  await marker('ready-live.json', { channelId: owner.channel.id, handle: owner.channel.handle, path: fixturePath, publisher: owner.displayName, title: liveTitle });
  const reportReasons = ['spam', 'impersonation', 'harassment', 'inappropriate'], privateNotes = [], reportIds = [];
  async function reportResult(reason, index) {
    const receipt = await recipient.client.request('POST', `/channels/${owner.channel.id}/reports`, { reason, details: `알림 결과 검증 ${suffix} ${reason}` });
    if (receipt.status !== 201) throw Error('Real notification report fixture returned HTTP ' + receipt.status);
    const reviewNote = `PRIVATE_OPERATOR_NOTE_${suffix}_${index}`, status = index % 2 ? 'dismissed' : 'resolved';
    privateNotes.push(reviewNote); reportIds.push(receipt.data.id);
    const reviewed = await operator.client.request('PATCH', `/admin/reports/${receipt.data.id}`, { status, reviewNote, version: 0 });
    if (reviewed.status !== 200) throw Error('Real notification review fixture returned HTTP ' + reviewed.status);
    return { id: receipt.data.id, status };
  }
  for (const [index, reason] of reportReasons.entries()) await reportResult(reason, index);
  const initialInbox = await waitInbox(recipient.client, inbox => inbox.items.length === 5 && inbox.items.filter(item => item.kind === 'live').length === 1 && inbox.items.filter(item => item.kind === 'report').length === 4, 'Actual media-ready and terminal report notifications');
  const live = initialInbox.items.find(item => item.kind === 'live');
  check(initialInbox.userId === recipient.user.id && initialInbox.unreadCount === 5 && live.target.available && live.target.channelId === owner.channel.id && live.body.includes(liveTitle), 'Actual MediaMTX-ready streaming and four terminal reviews create five unread notifications for the authenticated account');
  check(initialInbox.items.filter(item => item.kind === 'report').every(item => item.target === null && ['resolved', 'dismissed'].includes(item.report.status) && reportIds.includes(item.report.id))
    && privateNotes.every(note => !JSON.stringify(initialInbox).includes(note)) && !JSON.stringify(initialInbox).includes(operator.displayName), 'Reporter notifications show generic outcomes without leaking operator notes or identity');
  const pages = []; let cursor = '';
  for (let index = 0; index < 10; index++) {
    const pageResult = await recipient.client.request('GET', '/me/notifications?' + new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) }));
    if (pageResult.status !== 200 || pageResult.data.userId !== recipient.user.id) throw Error('Notification keyset page returned the wrong HTTP status or account identity.');
    pages.push(...pageResult.data.items); cursor = pageResult.data.nextCursor; if (!cursor) break;
  }
  check(pages.length === 5 && new Set(pages.map(item => item.id)).size === 5 && initialInbox.items.every(item => pages.some(row => row.id === item.id)), 'Real two-row keyset pages return every notification once');
  const emptyInbox = await emptyAccount.client.request('GET', '/me/notifications'), emptyCount = await emptyAccount.client.request('GET', '/me/notifications/unread-count');
  const foreignRead = await emptyAccount.client.request('PATCH', `/me/notifications/${live.id}/read`), foreignDelete = await emptyAccount.client.request('DELETE', `/me/notifications/${live.id}`);
  check(emptyInbox.data.userId === emptyAccount.user.id && emptyInbox.data.items.length === 0 && emptyCount.data.userId === emptyAccount.user.id && emptyCount.data.unreadCount === 0 && foreignRead.status === 404 && foreignDelete.status === 404, 'An independent account has its own empty inbox and cannot read or delete a foreign notification');
  const staleIdentity = await emptyAccount.client.request('GET', '/me/notifications', undefined, { expectedUserId: recipient.user.id });
  check(staleIdentity.status === 409 && staleIdentity.data.code === 'SESSION_CHANGED' && !Object.hasOwn(staleIdentity.data, 'items'), 'A cookie account change with an old expected identity is rejected before another account inbox can be returned');
  await marker('restart-live-api.json', { liveNotificationId: live.id }); await waitMarker('restarted-live-api.json'); await sleep(5500);
  const afterRestart = await waitInbox(recipient.client, inbox => inbox.items.length === 5 && inbox.items.find(item => item.id === live.id)?.target.available === false, 'Persisted inbox after isolated API restart');
  check(afterRestart.items.filter(item => item.kind === 'live').length === 1 && afterRestart.unreadCount === 5, 'Restarting only the API during the same live source preserves inbox state and does not duplicate a live notification');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/me/notifications*' }] });
  const rows = () => page.evaluate(`Array.from(document.querySelectorAll('main [data-notification-id]')).map(row=>({id:row.dataset.notificationId,read:row.querySelector('article')?.dataset.read==='true',text:row.innerText}))`);
  const readControl = id => `[aria-label="알림 ${id} 읽음 처리"]`, deleteControl = id => `[aria-label="알림 ${id} 삭제"]`;
  const readFilter = async filter => click(`[aria-label="알림 읽음 상태"] button:nth-child(${filter === 'unread' ? 2 : 1})`);
  const badge = expected => until(() => page.evaluate(expected === 0 ? `!document.querySelector('.notification-unread-badge')` : `document.querySelector('.notification-unread-badge')?.textContent===${JSON.stringify(String(expected))}`), 'Header unread count ' + expected);
  const notificationFailure = (method, detail, cursorOnly = false) => ({ status: 503, code: 'PRODUCT_UNAVAILABLE', detail,
    matches: (actual, url) => actual === method && (method === 'GET' ? url.pathname === '/api/v1/me/notifications' && (!cursorOnly || url.searchParams.has('cursor')) : method === 'PATCH' ? /\/notifications\/[^/]+\/read$/.test(url.pathname) : method === 'POST' ? url.pathname.endsWith('/notifications/read-all') : true) });
  await login(recipient); limitOverride = true; nextFailure = notificationFailure('GET', '알림 목록을 불러오지 못했어요.');
  await nav('/notifications'); await visibleText('알림을 불러오지 못했어요');
  check((await rows()).length === 0 && await page.evaluate(`!!document.querySelector('main [role=alert]')&&!document.querySelector('main').innerText.includes('아직 받은 알림이 없어요')`), 'Inbox GET 503 is a retryable error rather than an empty inbox');
  await button('다시 시도'); await until(async () => (await rows()).length === 2, 'First actual two-row UI page'); await badge(5);
  check((await rows()).every(row => initialInbox.items.some(item => item.id === row.id)), 'List retry uses real server notifications and the authoritative five-unread header badge');
  nextFailure = notificationFailure('GET', '다음 알림 목록을 불러오지 못했어요.', true); await button('더 보기'); await visibleText('다음 알림 목록을 불러오지 못했어요');
  check((await rows()).length === 2, 'Pagination 503 retains already loaded notification rows');
  await button('다음 알림 다시 시도'); await until(async () => (await rows()).length === 4, 'Second actual UI page'); await button('더 보기');
  await until(async () => (await rows()).length === 5, 'Final actual UI page');
  check(new Set((await rows()).map(row => row.id)).size === 5 && await page.evaluate(`!Array.from(document.querySelectorAll('main button')).some(button=>button.textContent.trim()==='더 보기')`), 'Retry and final pagination append all five once and remove the exhausted cursor action');
  limitOverride = false;
  check(await page.evaluate(`!document.querySelector('main').innerText.includes('PRIVATE_OPERATOR_NOTE_')&&!document.querySelector('main').innerText.includes(${JSON.stringify(operator.displayName)})`), 'Visible notification content excludes operator identity and private review notes');
  await page.evaluate('scrollTo(0,0)'); await screenshot('notifications-inbox-ui.png');
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); await page.evaluate('scrollTo(0,0)');
    check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Notification filters, rows and actions fit the ${width}px viewport`);
  }
  await screenshot('notifications-mobile-ui.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const firstReport = initialInbox.items.find(item => item.kind === 'report');
  nextFailure = notificationFailure('PATCH', '알림 읽음 상태를 저장하지 못했어요.');
  await click(`[data-notification-id="${firstReport.id}"] button[aria-label$="알림 열기"]`); await has('dialog[open]'); await visibleText('알림 읽음 상태를 저장하지 못했어요');
  check((await rows()).find(row => row.id === firstReport.id)?.read === false && await page.evaluate(`document.querySelector('dialog h2').textContent==='신고 검토 결과'&&document.querySelector('dialog').innerText.includes(${JSON.stringify(firstReport.report.id)})&&!document.querySelector('dialog').innerText.includes('PRIVATE_OPERATOR_NOTE_')`), 'A failed read preserves the unread report row and its generic result dialog');
  await badge(5); await screenshot('notifications-report-result-ui.png'); await page.key('Escape');
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Close report result');
  check(await page.evaluate(`document.activeElement.closest('[data-notification-id]')?.dataset.notificationId===${JSON.stringify(firstReport.id)}`), 'Escape closes the result dialog and restores focus to its notification');
  await click(readControl(firstReport.id)); await visibleText('읽음으로 표시했어요'); await badge(4);
  let stored = await recipient.client.request('GET', '/me/notifications');
  check(stored.data.userId === recipient.user.id && Number.isSafeInteger(stored.data.items.find(item => item.id === firstReport.id)?.readAtMs) && stored.data.unreadCount === 4, 'Successful individual read saves its server timestamp and updates the global unread count');
  await readFilter('unread'); await until(async () => (await rows()).length === 4, 'Unread inbox filter');
  await set('[name=notification-kind]', 'report'); await until(async () => (await rows()).length === 3, 'Unread report kind filter'); await badge(4);
  check((await rows()).every(row => !row.read && row.id !== firstReport.id && row.id !== live.id) && await page.evaluate(`new URLSearchParams(location.search).get('filter')==='unread'&&new URLSearchParams(location.search).get('kind')==='report'`), 'Unread and report-kind filters combine while the header count remains account-wide');
  await reload(); await until(async () => (await rows()).length === 3, 'Reloaded unread report filters');
  check(await page.evaluate(`document.querySelector('[name=notification-kind]').value==='report'&&document.querySelector('[aria-label="알림 읽음 상태"] button:nth-child(2)').getAttribute('aria-pressed')==='true'`), 'Read-state and kind filters survive a full reload');
  await readFilter('all'); await set('[name=notification-kind]', 'all'); await until(async () => (await rows()).length === 5, 'Restore all stored notifications');
  const endedHref = `/_frame/channel/id/${owner.channel.id}`;
  check(await page.evaluate(`document.querySelector('[data-notification-id="${live.id}"] a')?.getAttribute('href')===${JSON.stringify(endedHref)}&&document.querySelector('[data-notification-id="${live.id}"]').innerText.includes('채널 보기')`), 'An old live notification points to the immutable channel instead of another broadcast on the reused path');
  await click(`[data-notification-id="${live.id}"] a`); await visibleText('@' + owner.channel.handle);
  stored = await waitInbox(recipient.client, inbox => Number.isSafeInteger(inbox.items.find(item => item.id === live.id)?.readAtMs), 'Live notification navigation read'); await badge(3);
  check(stored.unreadCount === 3 && await page.evaluate(`location.pathname===${JSON.stringify('/_frame/channel/' + owner.channel.handle)}`), 'Following the ended-live fallback marks the notification read and opens the correct channel with the updated badge');
  await nav('/notifications'); await until(async () => (await rows()).length === 5, 'Return to inbox');
  nextFailure = notificationFailure('POST', '알림을 모두 읽음으로 표시하지 못했어요.'); await button('모두 읽기'); await visibleText('알림을 모두 읽음으로 표시하지 못했어요');
  check((await rows()).filter(row => !row.read).length === 3, 'Read-all 503 preserves each existing read state'); await badge(3);
  holdMutation = true; const beforeReadAll = writes.length; await button('모두 읽기'); await until(() => Boolean(heldMutation), 'Held read-all write');
  await page.key('Enter'); await page.evaluate(`Array.from(document.querySelectorAll('main button')).find(button=>button.textContent.trim()==='모두 읽기').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  check(writes.length === beforeReadAll + 1 && await page.evaluate(`Array.from(document.querySelectorAll('main button')).find(button=>button.textContent.trim()==='모두 읽기').disabled&&document.querySelector('[name=notification-kind]').disabled`), 'Pending read-all disables controls and blocks duplicate activation');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null;
  await visibleText('알림을 모두 읽음으로 표시했어요'); await badge(0); await reload(); await until(async () => (await rows()).length === 5, 'Read-all reload');
  check((await rows()).every(row => row.read) && (await recipient.client.request('GET', '/me/notifications/unread-count')).data.unreadCount === 0, 'Read-all saves all read states and zero unread count across reload');
  nextFailure = notificationFailure('DELETE', '알림을 삭제하지 못했어요.'); await click(deleteControl(firstReport.id)); await visibleText('알림을 삭제하지 못했어요');
  check((await rows()).some(row => row.id === firstReport.id) && (await rows()).length === 5, 'Individual delete 503 keeps the notification in the inbox');
  await click(deleteControl(firstReport.id)); await visibleText('알림을 삭제했어요'); await reload();
  await until(async () => (await rows()).length === 4, 'Individual delete persists');
  check(!(await rows()).some(row => row.id === firstReport.id), 'Successful individual deletion survives reload');
  await click('[aria-label="알림 모두 삭제"]'); await has('dialog[open]');
  check(await page.evaluate(`document.querySelector('dialog').innerText.includes('현재 필터와 관계없이 계정의 알림을 모두 삭제')&&document.activeElement===document.querySelector('dialog h2')`), 'Clear-all confirmation explains account-wide scope and receives focus');
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Cancel clear-all');
  check((await rows()).length === 4 && await page.evaluate(`document.activeElement.getAttribute('aria-label')==='알림 모두 삭제'`), 'Cancelling clear-all preserves notifications and restores its opening control');
  await click('[aria-label="알림 모두 삭제"]'); await has('dialog[open]');
  holdMutation = true; const beforeClear = writes.length; await button('모두 삭제', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held clear-all write');
  await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeClear + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.disabled)`), 'Pending clear-all locks confirmation and rejects Escape or duplicate Enter');
  holdMutation = false; await fulfill(heldMutation, { status: 503, code: 'PRODUCT_UNAVAILABLE', detail: '알림을 모두 삭제하지 못했어요.' }); heldMutation = null;
  await visibleText('알림을 모두 삭제하지 못했어요');
  check((await rows()).length === 4 && await page.evaluate(`!!document.querySelector('dialog[open]')`), 'Clear-all 503 preserves the inbox and open confirmation for retry');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 920, deviceScaleFactor: 1, mobile: true });
  check(await page.evaluate(`(() => {const dialog=document.querySelector('dialog'),rect=dialog.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&rect.left>=-1&&rect.right<=innerWidth+1;})()`), 'Clear-all confirmation fits the 320px viewport');
  await screenshot('notifications-clear-mobile-ui.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await button('모두 삭제', 'document.querySelector("dialog")'); await visibleText('아직 받은 알림이 없어요'); await badge(0);
  check((await rows()).length === 0 && await page.evaluate(`!document.querySelector('dialog[open]')&&document.activeElement!==document.body`), 'Successful clear-all empties the inbox and leaves focus on a meaningful page control');
  await sleep(5500); const afterClear = await recipient.client.request('GET', '/me/notifications');
  check(afterClear.data.userId === recipient.user.id && afterClear.data.items.length === 0 && afterClear.data.unreadCount === 0, 'Deleted notifications stay deleted while the same actual live source continues');
  await marker('stop-live.json'); await waitMarker('stopped-live.json');
  const finalReport = await reportResult('other', 4);
  const finalInbox = await waitInbox(recipient.client, inbox => inbox.items.length === 1 && inbox.items[0].report?.id === finalReport.id, 'Fresh report notification after clear-all');
  await click('[aria-label="알림 새로고침"]'); await until(async () => (await rows()).length === 1, 'Fresh stored notification UI'); await badge(1);
  check((await rows())[0].id === finalInbox.items[0].id && !(await rows())[0].read, 'A fresh terminal report creates a new unread notification after the previous inbox was cleared');
  const browserCookies = [...emptyAccount.client.cookies].map(([name, value]) => ({ name, value, url: origin, httpOnly: true, sameSite: 'Lax' }));
  await page.send('Network.clearBrowserCookies'); await page.send('Network.setCookies', { cookies: browserCookies }); await page.evaluate(`window.dispatchEvent(new Event('focus'))`);
  await visibleText('아직 받은 알림이 없어요');
  await until(() => page.evaluate(`document.querySelector('nav[aria-label="내 계정 메뉴"] strong')?.textContent===${JSON.stringify(emptyAccount.displayName)}`), 'Passively refreshed second account');
  check((await rows()).length === 0 && await page.evaluate(`!document.querySelector('.notification-unread-badge')&&location.pathname==='/_frame/notifications'&&!document.querySelector('main').innerText.includes(${JSON.stringify(finalInbox.items[0].id)})`), 'A cross-tab cookie account change clears old rows and unread badge and passively shows the second account without a login redirect');
  await login(recipient); await nav('/notifications'); await until(async () => (await rows()).length === 1, 'Original account inbox restored'); await badge(1);
  await click(readControl(finalInbox.items[0].id)); await visibleText('읽음으로 표시했어요'); await badge(0); await reload();
  await until(async () => (await rows()).length === 1 && (await rows())[0].read, 'Final read notification reload');
  const finalStored = await recipient.client.request('GET', '/me/notifications'), last = finalStored.data.items[0];
  check(finalStored.data.userId === recipient.user.id && finalStored.data.unreadCount === 0 && last.id === finalInbox.items[0].id && Number.isSafeInteger(last.readAtMs), 'Returning to the original account restores only its final persisted read notification');
  await Promise.all([...pendingInterceptions]); check(errors.length === 0, 'No browser runtime or unconfirmed interception errors');
  const cookieState = await page.send('Network.getCookies', { urls: [origin] }), session = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json())`);
  await marker('notifications-checkpoint.json', {
    cookies: cookieState.cookies.filter(cookie => cookie.domain === '127.0.0.1').map(({ name, value }) => ({ name, value })),
    csrfToken: session.csrfToken, userId: recipient.user.id, notificationId: last.id, readAtMs: last.readAtMs, unreadCount: 0,
    deletedIds: initialInbox.items.map(item => item.id), liveNotificationId: live.id, target: { channelId: owner.channel.id, handle: owner.channel.handle },
  });
  await writeFile(path.join(output, 'notifications-ui-result.json'), JSON.stringify({ origin, api, verificationDatabaseOnly: true,
    checks: results.length, passed: results.filter(result => result.pass).length,
    realSources: ['Dedicated MediaMTX RTMP H264/AAC source', 'Live-source API restart', 'Actual public report and terminal review transactions'],
    paginationInstrumentation: 'Only the first inbox UI pagination requests lower limit to 2; all rows and cursors are actual server responses.',
    faultInjection: ['Inbox GET 503', 'Cursor GET 503', 'Read PATCH 503', 'Read-all POST 503', 'Individual DELETE 503', 'Delayed read-all POST', 'Delayed clear DELETE and 503'],
    results, runtimeErrors: errors, confirmedCanceledInterceptions }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  let failureState = null;
  if (page) { try { failureState = await interactionSnapshot(); } catch {} }
  await writeFile(path.join(output, 'notifications-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors: errors, confirmedCanceledInterceptions,
    writes, latestCountResponses, interactions, failureState, pendingFault: nextFailure ? { status: nextFailure.status, code: nextFailure.code, detail: nextFailure.detail } : null }, null, 2));
  if (page) await screenshot('notifications-ui-failure.png').catch(() => {});
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
