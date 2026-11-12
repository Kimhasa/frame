// Metadata fixtures exercise history UI on the isolated verification app; real HLS playback is verified separately.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5365', api = 'http://127.0.0.1:18083';
const token = process.env.FRAME_HISTORY_FIXTURE_TOKEN;
if (!token || token.length < 24) throw Error('A dedicated history fixture token is required.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-history-ui-'));
const profile = path.join(directory, 'profile'), output = path.resolve('verification/product');
const suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9495', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let page, failList = false, failMore = false, mutationFailure = false, holdMutation = false, heldMutation;
const results = [], errors = [], mutations = [], fixtures = [];
const title = index => `기록 검증 ${String(index).padStart(2, '0')}`;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const text = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, params) {
  const marker = randomBytes(8).toString('hex');
  await page.evaluate(`window.__historyQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, params);
  await until(async () => {
    try { return await page.evaluate(`window.__historyQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); }
    catch { return false; }
  }, 'New history document');
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); }
async function reload() { await navigateDocument('Page.reload', {}); }
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label, scope = 'document') {
  await page.evaluate(`Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`);
}
async function set(selector, value) {
  await page.evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
const rows = () => page.evaluate(`Array.from(document.querySelectorAll('section[aria-labelledby="history-title"] article')).map(row=>row.getAttribute('aria-label'))`);
async function fulfill(requestId, status = 503, code = 'PRODUCT_UNAVAILABLE', detail = '시청 기록을 처리하지 못했어요.') {
  await page.send('Fetch.fulfillRequest', { requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify({ code, detail })).toString('base64') });
}
async function intercept(event) {
  if (event.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = event.params, url = new URL(request.url);
  if (request.method === 'GET') {
    if (failList || (failMore && url.searchParams.has('cursor'))) { await fulfill(requestId); return; }
  } else if (request.method === 'DELETE' || url.pathname.endsWith('/history/delete')) {
    mutations.push({ method: request.method, all: request.method === 'DELETE' && url.pathname.endsWith('/history') });
    if (mutationFailure) { mutationFailure = false; await fulfill(requestId); return; }
    if (holdMutation) { heldMutation = requestId; return; }
  }
  await page.send('Fetch.continueRequest', { requestId });
}
async function announce(message) {
  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await fetch(api + '/api/broadcasts/announce', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(message), signal: AbortSignal.timeout(10000) });
    if (response.status === 204) return;
    if (response.status !== 429) throw Error('Fixture announcement returned HTTP ' + response.status);
    const wait = Number(response.headers.get('retry-after')) || 1; await sleep(Math.min(5000, Math.max(250, wait * 1000)));
  }
  throw Error('Fixture announcement rate limit did not recover.');
}
async function record(fixture) {
  const status = await page.evaluate(`fetch('/api/v1/session').then(r=>r.json()).then(session=>fetch('/api/v1/me/history',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-TOKEN':session.csrfToken},body:JSON.stringify(${JSON.stringify({ broadcastId: fixture.id, path: fixture.path })})})).then(r=>r.status)`);
  if (status !== 204) throw Error('Personal metadata fixture returned HTTP ' + status);
}

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9495, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('History QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable');
  page.on(event => { if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text); void intercept(event).catch(failure => errors.push(failure.message)); });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/me/history*' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await nav('/login?mode=register'); await has('#account-agree-all');
  await until(() => page.evaluate(`!document.querySelector('#account-agree-all').disabled`), 'Signup policies');
  await set('[name=email]', `history_ui_${suffix}@example.invalid`); await set('[name=displayName]', '시청 기록 검증');
  await set('[name=password]', password); await set('[name=passwordConfirmation]', password); await click('#account-agree-all');
  await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
  for (let index = 1; index <= 53; index++) {
    const fixture = { id: randomBytes(16).toString('hex'), path: `history-fixture-${String(index).padStart(2, '0')}`, title: title(index) };
    const now = Date.now();
    await announce({ v: 1, type: 'announce', item: { ...fixture, publisher: '작업실', width: 320, height: 180, fps: 15, startedAtMs: now, sentAtMs: now, audio: 'system' } });
    await record(fixture); fixtures.push(fixture);
  }
  check(fixtures.length === 53, 'Dedicated account receives 53 explicit metadata fixtures');
  failList = true; await nav('/history'); await text('시청 기록을 불러오지 못했어요');
  check((await rows()).length === 0 && await page.evaluate(`!document.body.innerText.includes('아직 시청 기록이 없어요')`), 'List 503 is an error instead of a false empty state');
  failList = false; await button('다시 시도'); await until(async () => (await rows()).length === 50, 'First cursor page');
  check((await rows()).includes(title(53)) && !(await rows()).includes(title(1)), 'First page shows the newest 50 stored records');
  failMore = true; await button('더 보기'); await text('시청 기록을 처리하지 못했어요');
  check((await rows()).length === 50, 'Pagination failure preserves the existing page');
  failMore = false; await button('다시 시도'); await until(async () => (await rows()).length === 53, 'Retry cursor page');
  check(new Set(await rows()).size === 53 && await page.evaluate(`!Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='더 보기')`), 'Pagination retry appends the final three without duplicates');
  await page.evaluate('document.fonts.ready'); await page.evaluate('scrollTo(0,0)');
  await writeFile(path.join(output, 'history-ui.png'), await page.screenshot());
  await nav('/history'); await until(async () => (await rows()).length === 50, 'Reset to first page');
  await set('[aria-label="시청 기록 검색"]', title(1)); await click('form[aria-label="시청 기록"] button[type=submit]');
  await until(async () => (await rows()).length === 1, 'Off-page search');
  check((await rows())[0] === title(1), 'Server search finds a record outside the first loaded page');
  await button('다시보기'); await text('조건에 맞는 시청 기록이 없어요');
  check((await rows()).length === 0, 'Unsupported recording kinds truthfully have no history');
  await button('필터 초기화'); await until(async () => (await rows()).length === 50, 'Reset filters');
  await nav('/history?state=empty'); await until(async () => (await rows()).length === 50, 'Preview query isolation');
  check((await rows()).includes(title(53)), 'Preview empty-state query cannot override stored data');
  await announce({ v: 1, type: 'bye', id: fixtures[52].id }); await reload();
  await until(async () => (await rows()).length === 50, 'Ended record refresh');
  check(await page.evaluate(`(() => {const row=Array.from(document.querySelectorAll('article')).find(row=>row.getAttribute('aria-label')===${JSON.stringify(title(53))});return !!row&&row.innerText.includes('방송 종료')&&!!row.querySelector('strong')&&!row.querySelector('a[class*="entryTitle"]');})()`), 'Ended broadcast keeps its title and has no misleading replay link');
  await writeFile(path.join(output, 'history-ui-ended.png'), await page.screenshot());
  mutationFailure = true; await click(`[aria-label="${title(53)} 시청 기록에서 삭제"]`); await text('시청 기록을 처리하지 못했어요');
  check((await rows()).includes(title(53)), 'Failed individual delete preserves its row');
  await click(`[aria-label="${title(53)} 시청 기록에서 삭제"]`); await until(async () => !(await rows()).includes(title(53)), 'Single deletion');
  check((await rows()).length === 49, 'Individual deletion appears only after server success');
  await reload(); await until(async () => (await rows()).length === 50, 'Single delete persists');
  check(!(await rows()).includes(title(53)), 'Individual deletion survives reload');
  await button('선택'); await click(`[aria-label="${title(52)} 선택"]`); await click(`[aria-label="${title(51)} 선택"]`);
  check(await page.evaluate(`document.querySelectorAll('article input[type=checkbox]:checked').length===2&&Array.from(document.querySelectorAll('article input[type=checkbox]')).every(input=>getComputedStyle(input).opacity==='0')`), 'Selection uses the custom checkbox and keeps the selected count');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 920, deviceScaleFactor: 1, mobile: true }); await page.evaluate('scrollTo(0,0)');
  check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'History selection fits the mobile viewport');
  await writeFile(path.join(output, 'history-ui-mobile.png'), await page.screenshot());
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await button('삭제'); await has('dialog[open]'); mutationFailure = true;
  await click('dialog button[type=submit]'); await text('시청 기록을 처리하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelectorAll('article input:checked').length===2`) && (await rows()).length === 50, 'Failed selected delete keeps the dialog, selection and rows');
  await click('dialog button[type=submit]'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Selected deletion');
  check(!(await rows()).includes(title(52)) && !(await rows()).includes(title(51)), 'Selected delete removes only the confirmed records');
  // Recreate two explicit metadata fixtures to make clear-all cover records outside the first page too.
  await record(fixtures[51]); await record(fixtures[50]); await reload();
  await until(async () => (await rows()).length === 50, 'Clear-all pagination setup');
  check(await page.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='더 보기')`), 'Clear-all setup includes unloaded records');
  await button('기록 관리'); await has('dialog[open]');
  check(await page.evaluate(`document.querySelector('dialog').innerText.includes('계정의 시청 기록')`), 'Clear confirmation explains account-wide deletion');
  holdMutation = true; const beforeClear = mutations.length; await click('dialog button[type=submit]');
  await until(() => Boolean(heldMutation), 'Held clear-all');
  await page.key('Escape'); await page.key('Enter');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.disabled)`) && mutations.length === beforeClear + 1, 'Pending clear locks the dialog and prevents duplicate submission');
  await fulfill(heldMutation); heldMutation = null; holdMutation = false; await text('시청 기록을 처리하지 못했어요');
  check((await rows()).length === 50 && await page.evaluate(`!!document.querySelector('dialog[open]')`), 'Clear failure preserves records and confirmation');
  await click('dialog button[type=submit]'); await text('시청 기록을 모두 삭제했어요');
  await until(async () => (await rows()).length === 0, 'Clear succeeds');
  check(await page.evaluate(`!Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='실행 취소')`), 'Real hard deletion has no fabricated undo action');
  await reload(); await text('아직 시청 기록이 없어요');
  const empty = await page.evaluate(`fetch('/api/v1/me/history').then(r=>r.json()).then(data=>data.items.length===0&&data.nextCursor===null)`);
  check(empty, 'Account-wide clear deletes unloaded records and survives reload');
  check(errors.length === 0, 'No browser runtime or interception errors');
  await writeFile(path.join(output, 'history-ui-result.json'), JSON.stringify({ origin, verificationDatabaseOnly: true, metadataFixtures: true, realPlaybackProof: 'separate history playback verification', faultInjection: ['History GET 503', 'Cursor GET 503', 'Individual delete 503', 'Selected delete 503', 'Delayed clear and 503'], results, runtimeErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'history-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors: errors }, null, 2));
  if (page) await writeFile(path.join(output, 'history-ui-failure.png'), await page.screenshot()).catch(() => {});
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
