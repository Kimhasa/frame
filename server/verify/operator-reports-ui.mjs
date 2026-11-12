// Real operator report UI checks run only against the isolated verification app, never the user's API.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5365', api = 'http://127.0.0.1:18083';
const output = path.resolve('verification/product'), directory = await mkdtemp(path.join(tmpdir(), 'frame-operator-reports-ui-'));
const profile = path.join(directory, 'profile'), suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url');
const results = [], errors = [], writes = [], network = [];
const interceptedRequests = new Map(), canceledNetworkRequests = new Set(), pendingInterceptions = new Set(), confirmedCanceledInterceptions = [];
let page, failList = false, failDetail = false, nextPatchFailure, holdPatch = false, heldPatch, operator, revoked = false;
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9498', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });

function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, params) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__operatorQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, params);
  await until(async () => { try { return await page.evaluate(`window.__operatorQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New operator document');
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); }
async function reload() { await navigateDocument('Page.reload', {}); }
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label, scope = 'document') {
  await page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!element)throw Error('Missing button: '+${JSON.stringify(label)});element.dataset.operatorQaTarget='true';element.scrollIntoView({block:'center'});})()`);
  await page.click('[data-operator-qa-target="true"]'); await page.evaluate(`document.querySelector('[data-operator-qa-target]')?.removeAttribute('data-operator-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input: '+${JSON.stringify(selector)});const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function fulfill(requestId, status, code, detail) {
  await interceptionCommand('Fetch.fulfillRequest', { requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify({ code, detail })).toString('base64') });
}
async function interceptionCommand(command, parameters) {
  const request = interceptedRequests.get(parameters.requestId);
  try { return await page.send(command, parameters); }
  catch (failure) {
    if (/Invalid InterceptionId\.?/.test(failure.message) && request?.networkId) {
      // AbortController may cancel the network request before Chromium accepts our Fetch continuation.
      // Give the corresponding Network event one bounded turn to arrive; unrelated protocol errors still fail.
      if (!canceledNetworkRequests.has(request.networkId)) await sleep(100);
      if (canceledNetworkRequests.has(request.networkId)) {
        confirmedCanceledInterceptions.push({ method: request.method, path: request.path, command, confirmedBy: 'Network.loadingFailed:canceled' });
        return;
      }
    }
    failure.operatorQaContext = { source: 'Fetch', method: request?.method ?? null, path: request?.path ?? null,
      command, hasNetworkId: Boolean(request?.networkId), error: failure.message };
    throw failure;
  } finally { interceptedRequests.delete(parameters.requestId); }
}
async function intercept(event) {
  if (event.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = event.params, url = new URL(request.url);
  interceptedRequests.set(requestId, { networkId: event.params.networkId, method: request.method,
    path: url.pathname.replace(/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?=\/|$)/gi, '/:id') });
  if (request.method === 'GET') {
    if (failList && url.pathname === '/api/v1/admin/reports') { failList = false; await fulfill(requestId, 503, 'PRODUCT_UNAVAILABLE', '신고 목록을 불러오지 못했어요.'); return; }
    if (failDetail && /^\/api\/v1\/admin\/reports\/[^/]+$/.test(url.pathname)) { failDetail = false; await fulfill(requestId, 503, 'PRODUCT_UNAVAILABLE', '신고 상세를 불러오지 못했어요.'); return; }
  }
  if (request.method === 'PATCH') {
    writes.push({ method: request.method });
    if (nextPatchFailure) { const error = nextPatchFailure; nextPatchFailure = null; await fulfill(requestId, error.status, error.code, error.detail); return; }
    if (holdPatch) { heldPatch = requestId; return; }
  }
  await interceptionCommand('Fetch.continueRequest', { requestId });
}
class Client {
  constructor() { this.cookies = new Map(); this.csrf = ''; }
  async request(method, route, body) {
    const headers = { Accept: 'application/json', Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
    if (method !== 'GET') { headers.Origin = origin; if (this.csrf) headers['X-CSRF-TOKEN'] = this.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + '/api/v1' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'manual' });
    for (const raw of response.headers.getSetCookie()) {
      const first = raw.split(';')[0], split = first.indexOf('='), name = first.slice(0, split), value = first.slice(split + 1);
      if (/max-age=0(?:;|$)/i.test(raw) || !value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    let data; try { data = await response.json(); } catch { data = null; }
    if (typeof data?.csrfToken === 'string') this.csrf = data.csrfToken;
    return { status: response.status, data, headers: response.headers };
  }
}
async function createAccount(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const email = kind === 'operator' ? `operator_ui_${suffix}@example.invalid` : `operator_ui_${kind}_${suffix}@example.invalid`, displayName = `운영 검증 ${kind} ${suffix}`;
  const response = await client.request('POST', '/auth/register', { email, password, displayName, ...consent });
  if (response.status !== 201) throw Error(`Dedicated ${kind} signup returned HTTP ${response.status}`);
  return { client, email, displayName, user: response.data.user, channel: response.data.channel };
}
async function login(account) {
  await page.send('Network.clearBrowserCookies'); await nav('/login'); await has('#account-email');
  await set('[name=email]', account.email); await set('[name=password]', password); await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
  return page.evaluate(`fetch('/api/v1/session').then(response=>response.json())`);
}
async function browserRequest(method, route, body) {
  return page.evaluate(`fetch('/api/v1/session').then(r=>r.json()).then(session=>fetch('/api/v1'+${JSON.stringify(route)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json','X-CSRF-TOKEN':session.csrfToken},${body === undefined ? '' : 'body:JSON.stringify(' + JSON.stringify(body) + '),'}})).then(async response=>({status:response.status,data:await response.json().catch(()=>null)}))`);
}
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, name), await page.screenshot()); }
function permission(action, id) {
  if (!['grant', 'revoke'].includes(action) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw Error('Invalid isolated fixture permission request.');
  try { execFileSync(process.execPath, [path.resolve('server/verify/operator-fixture.mjs'), action, id], { windowsHide: true, stdio: 'pipe', timeout: 15000 }); }
  catch { throw Error('Isolated fixture permission ' + action + ' failed.'); }
}
function privateData(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /email|password|token|csrf|secret|credential/i.test(key) || privateData(child));
}

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9498, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Operator reports QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.loadingFailed' && event.params.canceled === true) canceledNetworkRequests.add(event.params.requestId);
    if (event.method === 'Network.responseReceived' && event.params.response.url.includes('/api/v1/admin/reports')) network.push({ status: event.params.response.status });
    if (event.method === 'Fetch.requestPaused') {
      const pending = intercept(event).catch(failure => errors.push(failure.operatorQaContext ?? failure.message));
      pendingInterceptions.add(pending); void pending.finally(() => pendingInterceptions.delete(pending));
    }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/admin/reports*' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const bootstrap = new Client(), policies = await bootstrap.request('GET', '/policies');
  if (policies.status !== 200) throw Error('Signup policies are unavailable in the verification app.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  const owner = await createAccount('owner', consent), reporter = await createAccount('reporter', consent);
  operator = await createAccount('operator', consent);
  check(owner.user.isOperator === false && reporter.user.isOperator === false && operator.user.isOperator === false, 'All real signups begin without operator privileges');
  const reasons = ['spam', 'impersonation', 'harassment', 'inappropriate', 'other'], seeded = [];
  for (const [actor, target] of [[owner, operator], [reporter, owner], [operator, owner]]) {
    for (const reason of reasons) {
      const response = await actor.client.request('POST', `/channels/${target.channel.id}/reports`, { reason, details: `운영 검증 ${suffix} ${actor.displayName} ${reason}` });
      if (response.status !== 201) throw Error('Dedicated report fixture returned HTTP ' + response.status);
      seeded.push({ ...response.data, target: target.channel, reporter: actor.user, reason });
    }
  }
  check(seeded.length === 15, 'Three independent accounts create fifteen real reports without bypassing per-account limits');
  const ownReport = seeded.find(report => report.target.id === owner.channel.id), sample = ownReport.id;
  const anonymous = new Client(); await anonymous.request('GET', '/session');
  const unauthenticated = await Promise.all([anonymous.request('GET', '/admin/reports'), anonymous.request('GET', `/admin/reports/${sample}`), anonymous.request('PATCH', `/admin/reports/${sample}`, { status: 'resolved', reviewNote: '권한 없는 조치', version: 0 })]);
  check(unauthenticated.every(response => response.status === 401 && !privateData(response.data)), 'Anonymous list, detail and review requests are denied with 401');
  const forbidden = await Promise.all([owner.client.request('GET', '/admin/reports'), owner.client.request('GET', `/admin/reports/${sample}`), owner.client.request('PATCH', `/admin/reports/${sample}`, { status: 'resolved', reviewNote: '권한 없는 조치', version: 0 })]);
  check(forbidden.every(response => response.status === 403 && response.data.code === 'OPERATOR_REQUIRED' && !privateData(response.data)), 'A channel owner cannot read or review even a report targeting their own channel');
  await login(owner); await click('[aria-label="내 계정"]');
  check(await page.evaluate(`!document.querySelector('a[href="/_frame/admin/reports"]')`), 'A normal account has no operator report management menu');
  await nav('/admin/reports'); await visibleText('운영자만 접근할 수 있어요');
  check(await page.evaluate(`!document.querySelector('table')&&!document.querySelector('dialog[open]')`), 'Direct operator navigation gives a normal user no report rows or details');
  permission('grant', operator.user.id);
  const promoted = await operator.client.request('GET', '/session');
  check(promoted.data.user.isOperator === true, 'An existing Redis session observes the explicit database operator grant');
  const collected = []; let cursor = '';
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const query = new URLSearchParams({ q: suffix, limit: '2', ...(cursor ? { cursor } : {}) });
    const response = await operator.client.request('GET', '/admin/reports?' + query);
    if (response.status !== 200) throw Error('Operator keyset page returned HTTP ' + response.status);
    collected.push(...response.data.items);
    cursor = response.data.nextCursor;
    if (!cursor) break;
  }
  check(collected.length === seeded.length && new Set(collected.map(item => item.id)).size === seeded.length && seeded.every(report => collected.some(item => item.id === report.id)), 'Real two-row cursor pages return all fifteen fixtures once without duplicates');
  const firstDetail = await operator.client.request('GET', `/admin/reports/${sample}`);
  check(!privateData(collected) && !privateData(firstDetail.data) && collected.every(item => !Object.hasOwn(item, 'reviewNote') && !Object.hasOwn(item, 'reviewedBy')), 'List and detail expose no emails, credentials or tokens, and private review notes stay out of list rows');
  const filtered = await operator.client.request('GET', '/admin/reports?' + new URLSearchParams({ q: suffix, reason: 'spam', status: 'received' }));
  check(filtered.status === 200 && filtered.data.items.length === 3 && filtered.data.items.every(item => item.status === 'received' && item.reason === 'spam'), 'Combined server query, status and reason filters select only matching real reports');
  const operatorSession = await login(operator); await click('[aria-label="내 계정"]');
  check(operatorSession.user.isOperator && await page.evaluate(`!!document.querySelector('a[href="/_frame/admin/reports"]')`), 'The operator session exposes report management in the profile menu');
  const route = '/admin/reports?' + new URLSearchParams({ q: suffix });
  const rows = () => page.evaluate(`Array.from(document.querySelectorAll('table tbody tr')).map(row=>({id:row.dataset.reportId,text:row.innerText}))`);
  const openReport = async id => { await click(`[aria-label="신고 ${id} 상세 보기"]`); await has('dialog[open]'); };
  const closeReport = async () => { await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Report dialog closes'); };
  failList = true; await nav(route); await visibleText('신고 목록을 불러오지 못했어요');
  check(await page.evaluate(`!!document.querySelector('[role=alert]')&&!document.querySelector('table')&&!document.body.innerText.includes('조건에 맞는 신고가 없어요')`), 'List 503 is a retryable error rather than a misleading empty state');
  await button('목록 다시 시도'); await until(async () => (await rows()).length === 15, 'Stored report rows');
  check((await rows()).every(row => seeded.some(report => report.id === row.id)), 'List retry displays the fifteen stored reports without fixture or preview substitutions');
  await set('[name=report-reason-filter]', 'spam'); await set('[name=report-status-filter]', 'received');
  await until(async () => (await rows()).length === 3, 'Combined UI filters'); await reload();
  await until(async () => (await rows()).length === 3, 'Reloaded UI filters');
  check(await page.evaluate(`new URLSearchParams(location.search).get('q')===${JSON.stringify(suffix)}&&new URLSearchParams(location.search).get('reason')==='spam'&&new URLSearchParams(location.search).get('status')==='received'&&document.querySelector('[name=report-reason-filter]').value==='spam'`), 'UI search, status and reason filters persist in the URL and survive reload');
  await set('[name=report-reason-filter]', 'all'); await set('[name=report-status-filter]', 'all');
  await until(async () => (await rows()).length === 15, 'Reset UI filters');
  await set('[name=report-query]', owner.channel.handle); await click('form[aria-label="신고 검색"] button[type=submit]');
  await until(async () => (await rows()).length === 10, 'Channel name search');
  check((await rows()).every(row => row.text.includes(owner.displayName)), 'Handle search submits to the server and selects reports for the requested channel');
  await set('[name=report-query]', suffix); await click('form[aria-label="신고 검색"] button[type=submit]');
  await until(async () => (await rows()).length === 15, 'Restore fixture search');
  check(await page.evaluate(`!document.querySelector('main').innerText.includes('@example.invalid')&&Array.from(document.querySelectorAll('table a[target="_blank"]')).every(link=>link.relList.contains('noopener')&&link.relList.contains('noreferrer'))`), 'Rendered rows reveal no emails and channel links open with safe relation attributes');
  await page.evaluate('scrollTo(0,0)'); await screenshot('operator-reports-ui.png');
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); await page.evaluate('scrollTo(0,0)');
    check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Operator filters and report rows fit the ${width}px viewport`);
  }
  await screenshot('operator-reports-mobile-ui.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const primaryId = collected[0].id;
  failDetail = true; await openReport(primaryId); await visibleText('신고 상세를 불러오지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog [role=alert]')&&!document.querySelector('dialog form')&&!document.querySelector('dialog [aria-label="접수된 신고 내용"]')`), 'Detail 503 shows no stale report body or editable review form');
  await button('상세 다시 시도', 'document.querySelector("dialog")'); await has('dialog [name=review-status]');
  check(await page.evaluate(`document.querySelector('dialog').innerText.includes(${JSON.stringify(primaryId)})&&document.querySelector('dialog').innerText.includes(${JSON.stringify(collected[0].details)})&&document.querySelector('dialog [name=review-status]').value==='reviewing'`), 'Detail retry opens the selected real report with the expected initial transition');
  await set('dialog [name=review-status]', 'resolved'); const beforeBlank = writes.length; await click('dialog button[type=submit]');
  await visibleText('검토 결과를 기록해 주세요');
  check(writes.length === beforeBlank && await page.evaluate(`document.activeElement.name==='review-note'`), 'Terminal review requires a note and focuses the note before any write');
  const reviewingNote = `검토를 시작합니다 ${suffix}`;
  await set('dialog [name=review-status]', 'reviewing'); await set('dialog [name=review-note]', reviewingNote);
  nextPatchFailure = { status: 503, code: 'PRODUCT_UNAVAILABLE', detail: '검토 결과를 저장하지 못했어요.' };
  await click('dialog button[type=submit]'); await visibleText('검토 결과를 저장하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog [name=review-status]').value==='reviewing'&&document.querySelector('dialog [name=review-note]').value===${JSON.stringify(reviewingNote)}`), 'Review PATCH 503 preserves the selected transition, note and open dialog');
  holdPatch = true; const beforePending = writes.length; await click('dialog button[type=submit]'); await until(() => Boolean(heldPatch), 'Held review write');
  await page.key('Escape'); await page.key('Enter'); await page.evaluate(`document.querySelector('dialog form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  check(writes.length === beforePending + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog fieldset').disabled&&document.querySelector('[aria-label="신고 상세 닫기"]').disabled&&document.querySelector('dialog button[type=submit]').disabled`), 'Pending review locks its controls and Escape, Enter or resubmit cannot close or duplicate it');
  holdPatch = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldPatch }); heldPatch = null;
  await visibleText('검토 결과를 저장했어요');
  const reviewing = await operator.client.request('GET', `/admin/reports/${primaryId}`);
  check(reviewing.data.status === 'reviewing' && reviewing.data.version === 1 && reviewing.data.reviewNote === reviewingNote && reviewing.data.reviewedBy.id === operator.user.id, 'Actual received-to-reviewing update persists its version, note and server-selected operator');
  const terminalNote = `신고 내용을 확인하여 검토를 마쳤습니다 ${suffix}`;
  await set('dialog [name=review-status]', 'resolved'); await set('dialog [name=review-note]', terminalNote); await click('dialog button[type=submit]');
  await has('dialog [aria-label="저장된 검토 결과"]');
  const resolved = await operator.client.request('GET', `/admin/reports/${primaryId}`);
  check(resolved.data.status === 'resolved' && resolved.data.version === 2 && resolved.data.reviewNote === terminalNote && await page.evaluate(`!document.querySelector('dialog form')&&document.querySelector('dialog [aria-label="저장된 검토 결과"]').innerText.includes(${JSON.stringify(terminalNote)})`), 'Reviewing-to-resolved persists once and the closed report has no editable review form');
  await screenshot('operator-reports-resolved-ui.png'); await closeReport(); await reload();
  await until(async () => (await rows()).length === 15, 'Resolved report reload'); await openReport(primaryId); await has('dialog [aria-label="저장된 검토 결과"]');
  check(await page.evaluate(`document.querySelector('dialog [aria-label="저장된 검토 결과"]').innerText.includes(${JSON.stringify(terminalNote)})`), 'The terminal review note survives a full browser reload');
  await closeReport();
  const dismissedId = collected[1].id;
  await openReport(dismissedId); await has('dialog [name=review-status]'); await set('dialog [name=review-status]', 'dismissed');
  const dismissedNote = `신고 근거를 확인할 수 없어 기각합니다 ${suffix}`;
  await set('dialog [name=review-note]', dismissedNote); await click('dialog button[type=submit]'); await has('dialog [aria-label="저장된 검토 결과"]');
  const dismissed = await operator.client.request('GET', `/admin/reports/${dismissedId}`);
  check(dismissed.data.status === 'dismissed' && dismissed.data.version === 1 && dismissed.data.reviewNote === dismissedNote, 'Received-to-dismissed persists an independent terminal outcome');
  await closeReport();
  const conflictId = collected[2].id;
  await openReport(conflictId); await has('dialog [name=review-status]');
  const changedElsewhere = await operator.client.request('PATCH', `/admin/reports/${conflictId}`, { status: 'reviewing', reviewNote: `다른 창에서 검토를 시작했어요 ${suffix}`, version: 0 });
  if (changedElsewhere.status !== 200) throw Error('Concurrent operator fixture update returned HTTP ' + changedElsewhere.status);
  const unsavedNote = `이전 화면의 입력을 유지해 주세요 ${suffix}`;
  await set('dialog [name=review-status]', 'resolved'); await set('dialog [name=review-note]', unsavedNote);
  const beforeConflict = writes.length; await click('dialog button[type=submit]'); await has('dialog [role=alert]');
  await until(() => network.some(response => response.status === 409), 'Real stale version conflict');
  check(writes.length === beforeConflict + 1 && await page.evaluate(`document.querySelector('dialog [name=review-note]').value===${JSON.stringify(unsavedNote)}&&document.querySelector('dialog button[type=submit]').disabled&&document.querySelector('dialog [name=review-status]').disabled`), 'Actual stale-version 409 preserves the unsaved note and requires explicit refresh without auto-resubmitting');
  await button('최신 내용으로 새로고침', 'document.querySelector("dialog")'); await has('dialog [name=review-status]');
  await until(() => page.evaluate(`document.querySelector('dialog [name=review-note]')?.value===${JSON.stringify(changedElsewhere.data.reviewNote)}`), 'Latest detail refresh');
  check(await page.evaluate(`!document.querySelector('dialog button[type=submit]').disabled&&document.querySelector('dialog [name=review-status]').value==='resolved'`) && writes.length === beforeConflict + 1, 'Explicit conflict refresh loads the latest server version and re-enables a deliberate next action');
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true });
    check(await page.evaluate(`(() => {const dialog=document.querySelector('dialog'),rect=dialog.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&rect.left>=-1&&rect.right<=innerWidth+1&&dialog.scrollWidth<=dialog.clientWidth+1;})()`), `Report details and review controls fit the ${width}px viewport`);
  }
  await screenshot('operator-reports-detail-mobile-ui.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  permission('revoke', operator.user.id); revoked = true;
  await set('dialog [name=review-note]', `권한 회수 뒤에는 저장되면 안 돼요 ${suffix}`); await click('dialog button[type=submit]');
  await until(() => page.evaluate(`document.body.innerText.includes('운영자만 접근할 수 있어요')||document.body.innerText.includes('운영자 권한이 필요해요')`), 'Revoked operator screen');
  check(await page.evaluate(`!document.querySelector('table')&&!document.querySelector('dialog[open]')&&!document.querySelector('main').innerText.includes(${JSON.stringify(collected[2].details)})&&!document.querySelector('a[href="/_frame/admin/reports"]')`), 'Permission revocation clears existing private rows and dialog and removes operator navigation');
  const revokedSession = await operator.client.request('GET', '/session'), revokedDetail = await operator.client.request('GET', `/admin/reports/${conflictId}`);
  check(revokedSession.data.user.isOperator === false && revokedDetail.status === 403 && revokedDetail.data.code === 'OPERATOR_REQUIRED', 'The same existing API session immediately loses DB-backed operator authority');
  permission('grant', operator.user.id); revoked = false; await reload();
  await until(async () => (await rows()).length === 15, 'Restored operator verification access');
  const notChanged = await operator.client.request('GET', `/admin/reports/${conflictId}`);
  check(notChanged.data.version === 1 && notChanged.data.reviewNote === changedElsewhere.data.reviewNote, 'The rejected revoked write leaves the previously stored version and note unchanged');
  const publicChannel = await bootstrap.request('GET', `/channel-ids/${owner.channel.id}`);
  check(publicChannel.status === 200 && publicChannel.data.id === owner.channel.id, 'Report review changes only moderation records and does not fabricate a channel ban');
  await Promise.all([...pendingInterceptions]);
  check(errors.length === 0, 'No browser runtime or request interception errors');
  if (process.env.FRAME_OPERATOR_TEST_DIR) {
    const checkpointDirectory = path.resolve(process.env.FRAME_OPERATOR_TEST_DIR), relative = path.relative(path.resolve('.'), checkpointDirectory);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('Operator checkpoint must stay outside the repository.');
    const cookieState = await page.send('Network.getCookies', { urls: [origin] }), session = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json())`);
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(path.join(checkpointDirectory, 'operator-reports-checkpoint.json'), JSON.stringify({
      cookies: cookieState.cookies.filter(cookie => cookie.domain === '127.0.0.1').map(({ name, value }) => ({ name, value })),
      csrfToken: session.csrfToken, operatorId: operator.user.id, operatorEmail: operator.email, query: suffix,
      reportId: primaryId, reviewNote: terminalNote, version: resolved.data.version,
      target: { id: owner.channel.id, handle: owner.channel.handle },
    }));
  }
  await writeFile(path.join(output, 'operator-reports-ui-result.json'), JSON.stringify({ origin, api, verificationDatabaseOnly: true,
    checks: results.length, passed: results.filter(result => result.pass).length, seededReports: seeded.length,
    faultInjection: ['List GET 503', 'Detail GET 503', 'Review PATCH 503', 'Delayed review PATCH'],
    realEdges: ['Stale version HTTP 409', 'DB operator revocation HTTP 403', 'Anonymous HTTP 401', 'Channel owner HTTP 403'],
    results, runtimeErrors: errors, confirmedCanceledInterceptions }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'operator-reports-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors: errors, confirmedCanceledInterceptions }, null, 2));
  if (page) await screenshot('operator-reports-ui-failure.png').catch(() => {});
  throw failure;
} finally {
  if (revoked && operator) { try { permission('grant', operator.user.id); } catch {} }
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
