// Runs the real app against the isolated 5364/18081 verification environment only.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5364', output = path.resolve('verification/product');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-schedule-ui-'));
const run = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url'), email = `schedule_ui_${run}@example.invalid`;
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9495', `--user-data-dir=${path.join(directory, 'profile')}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let page, failList = true, failPublic = false, nextWriteError, holdWrite = false, heldWrite;
const results = [], errors = [], writes = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = text => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), text);
async function nav(route) { await page.send('Page.navigate', { url: origin + '/_frame' + route }); }
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(text) { await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`); }
async function set(selector, value) { await page.evaluate(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)}); n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true})); })()`); }
async function fulfill(id, status, code, detail) { await page.send('Fetch.fulfillRequest', { requestId: id, responseCode: status,
  responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(JSON.stringify({ code, detail })).toString('base64') }); }
async function intercept(event) {
  if (event.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = event.params;
  if (request.method === 'GET') {
    if ((failList && request.url.endsWith('/me/schedules')) || (failPublic && /\/channels\/[^/]+\/schedule$/.test(request.url))) {
      await fulfill(requestId, 503, 'PRODUCT_UNAVAILABLE', '방송 예약을 불러오지 못했어요.'); return;
    }
  } else {
    writes.push({ method: request.method });
    if (nextWriteError) { const failure = nextWriteError; nextWriteError = null; await fulfill(requestId, failure.status, failure.code, failure.message); return; }
    if (holdWrite) { heldWrite = requestId; return; }
  }
  await page.send('Fetch.continueRequest', { requestId });
}
const rows = () => page.evaluate(`Array.from(document.querySelectorAll('table tbody tr')).map(row=>row.innerText)`);

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9495, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Browser unavailable');
  await page.send('Page.enable'); await page.send('Runtime.enable');
  page.on(event => { if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text); void intercept(event).catch(failure => errors.push(failure.message)); });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/me/schedules*' }, { urlPattern: '*api/v1/channels/*/schedule' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await nav('/login?mode=register'); await has('#account-agree-all');
  await until(() => page.evaluate(`!document.querySelector('#account-agree-all').disabled`), 'Ready signup consent');
  await set('[name=email]', email); await set('[name=displayName]', '방송 일정 검증'); await set('[name=password]', password); await set('[name=passwordConfirmation]', password);
  await click('#account-agree-all'); await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
  const handle = await page.evaluate(`fetch('/api/v1/session').then(r=>r.json()).then(s=>s.channel.handle)`);
  await nav('/studio/schedule'); await visibleText('방송 예약을 불러오지 못했어요');
  check(await page.evaluate(`!!document.querySelector('[role=alert]')&&!document.querySelector('table')`), 'List failure is displayed instead of fake empty data');
  failList = false; await button('다시 시도'); await visibleText('예정된 방송이 없어요');
  check(true, 'List retry recovers the real empty state');
  await button('예약 추가'); await has('dialog[open] input[name=title]');
  check(await page.evaluate(`document.activeElement.name==='title'`), 'New reservation focuses its title');
  await click('dialog button[type=submit]'); await visibleText('방송 제목을 입력해 주세요');
  check(await page.evaluate(`document.activeElement.name==='title'`), 'Blank title error focuses the field');
  const date = new Date(Date.now() + 9 * 3600000 + 2 * 86400000).toISOString().slice(0, 10);
  await set('dialog [name=title]', '함께 코딩해요'); await set('dialog [name=date]', date); await set('dialog [name=time]', '20:15');
  nextWriteError = { status: 503, code: 'PRODUCT_UNAVAILABLE', message: '예약을 저장하지 못했어요.' };
  await click('dialog button[type=submit]'); await visibleText('예약을 저장하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog [name=title]').value==='함께 코딩해요'`), 'Failed save keeps the dialog and entered fields');
  holdWrite = true; const countBefore = writes.length;
  await click('dialog button[type=submit]'); await until(() => Boolean(heldWrite), 'Held save');
  check(await page.evaluate(`document.querySelector('dialog fieldset').disabled&&document.querySelector('dialog [aria-label="닫기"]').disabled`), 'Pending save disables fields and close');
  await page.key('Escape'); await page.key('Enter');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')`) && writes.length === countBefore + 1, 'Pending Escape and Enter cannot close or duplicate the request');
  holdWrite = false; await page.send('Fetch.continueRequest', { requestId: heldWrite }); heldWrite = null;
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Save completes'); await visibleText('예약을 추가했어요');
  check((await rows()).some(row => row.includes('함께 코딩해요')), 'Server success adds the reservation to the table');
  await page.send('Page.reload'); await has('table tbody tr');
  check((await rows()).some(row => row.includes('함께 코딩해요')), 'Reservation survives browser reload');
  const saved = await page.evaluate(`fetch('/api/v1/me/schedules').then(r=>r.json()).then(r=>r.items[0])`);
  check(saved.at === Date.parse(date + 'T20:15+09:00'), 'Seoul date and time reach the server unchanged');
  await nav('/studio/schedule?state=empty'); await has('table tbody tr');
  check((await rows()).some(row => row.includes('함께 코딩해요')), 'Preview query parameters cannot hide real schedules');
  await button('예약 추가'); await has('dialog[open] input'); await set('dialog [name=title]', '중복 예약'); await set('dialog [name=date]', date); await set('dialog [name=time]', '20:15');
  const beforeDuplicate = writes.length; await click('dialog button[type=submit]'); await visibleText('같은 시간에 예약된 방송이 있어요');
  check(writes.length === beforeDuplicate && await page.evaluate(`document.activeElement.name==='time'`), 'Known duplicate is rejected before submission');
  await set('dialog [name=time]', '20:45'); nextWriteError = { status: 409, code: 'SCHEDULE_CONFLICT', message: '다른 창에서 같은 시간에 예약했어요.' };
  await click('dialog button[type=submit]'); await visibleText('다른 창에서 같은 시간에 예약했어요');
  await until(() => page.evaluate(`document.activeElement.name==='time'`), 'Conflict focus');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog [name=title]').value==='중복 예약'`), 'Server conflict keeps entered values and focuses time');
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Close create');
  await click('[aria-label="함께 코딩해요 예약 수정"]'); await has('dialog[open] input');
  await set('dialog [name=title]', '다음 방송 준비하기'); await set('dialog [name=time]', '21:30'); await click('dialog button[type=submit]');
  await visibleText('예약을 변경했어요');
  const edited = await page.evaluate(`fetch('/api/v1/me/schedules').then(r=>r.json()).then(r=>r.items[0])`);
  check(edited.id === saved.id && edited.title === '다음 방송 준비하기' && edited.at === Date.parse(date + 'T21:30+09:00'), 'Edit updates the same stored reservation');
  await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, 'schedule-ui.png'), await page.screenshot());
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 920, deviceScaleFactor: 1, mobile: true }); await sleep(100);
  check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'Schedule table has no horizontal overflow on mobile');
  await writeFile(path.join(output, 'schedule-mobile-ui.png'), await page.screenshot());
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Network.clearBrowserCookies'); failPublic = true;
  await nav(`/channel/${handle}?tab=schedule`); await visibleText('방송 일정을 불러오지 못했어요');
  check(await page.evaluate(`!document.body.innerText.includes('예정된 방송이 없어요')`), 'Public schedule failure is not presented as no reservations');
  failPublic = false; await button('다시 시도'); await visibleText('다음 방송 준비하기');
  check(await page.evaluate(`document.body.innerText.includes('오후 9:30')`), 'Anonymous public channel shows the real edited schedule in Seoul time');
  await writeFile(path.join(output, 'schedule-public-ui.png'), await page.screenshot());
  await nav('/studio/schedule'); await has('#account-email');
  check(await page.evaluate(`new URLSearchParams(location.search).get('returnTo')==='/studio/schedule'`), 'Anonymous studio redirects to login with a return path');
  await set('[name=email]', email); await set('[name=password]', password); await click('main form button[type=submit]'); await has('table tbody tr');
  await click('[aria-label="다음 방송 준비하기 예약 취소"]'); await has('dialog[open]');
  nextWriteError = { status: 503, code: 'PRODUCT_UNAVAILABLE', message: '예약을 취소하지 못했어요.' };
  await click('dialog button:not([aria-label]):last-child'); await visibleText('예약을 취소하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')`) && (await rows()).some(row => row.includes('다음 방송 준비하기')), 'Cancellation failure keeps the reservation and confirmation dialog');
  await click('dialog button:not([aria-label]):last-child'); await visibleText('예약을 취소했어요');
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')&&!document.querySelector('table tbody tr')`), 'Cancellation completes');
  check(await page.evaluate(`document.activeElement.textContent.includes('예약 추가')`), 'Successful cancellation removes the row and restores a valid focus target');
  await page.send('Page.reload'); await visibleText('예정된 방송이 없어요'); check(true, 'Cancellation persists after browser reload');
  await nav(`/channel/${handle}?tab=schedule`); await visibleText('예정된 방송이 없어요');
  check(await page.evaluate(`!document.body.innerText.includes('다음 방송 준비하기')`), 'Cancelled reservation disappears from the public channel');
  check(errors.length === 0, 'No browser runtime or interception errors');
  await writeFile(path.join(output, 'schedule-ui-result.json'), JSON.stringify({ origin, verificationDatabaseOnly: true, faultInjection: ['Private/public GET 503', 'Save 503', 'Server time conflict', 'Delayed POST', 'Cancel 503'], results, runtimeErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(item => item.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  await writeFile(path.join(output, 'schedule-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors: errors }, null, 2));
  if (page) await writeFile(path.join(output, 'schedule-ui-failure.png'), await page.screenshot());
  throw failure;
} finally { if (page) { await page.send('Browser.close').catch(() => {}); page.close(); } browser.kill(); }
