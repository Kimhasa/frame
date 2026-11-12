// Browser checks use only the separate verification API/database behind the 5364 preview.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5364';
const output = path.resolve('verification/product');
const temp = await mkdtemp(path.join(tmpdir(), 'frame-auth-ui-'));
const run = randomBytes(5).toString('hex');
const password = randomBytes(20).toString('base64url');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9496',
  `--user-data-dir=${path.join(temp, 'profile')}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let page, failPolicies = false, policyFailureStatus = 401, staleNext = false, holdSignup = false, heldRequest;
let policySentCookie = false;
let policyLoads = 0;
const results = [], errors = [], registrationConsents = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 100; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
async function click(selector) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
  await page.click(selector);
}
async function set(selector, value) {
  await page.evaluate(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)}); n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
}
async function fulfill(requestId, status, body) {
  await page.send('Fetch.fulfillRequest', { requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify(body)).toString('base64') });
}
async function intercept(event) {
  if (event.method !== 'Fetch.requestPaused') return;
  const { request, requestId } = event.params;
  if (request.url.endsWith('/policies')) {
    policyLoads++;
    policySentCookie ||= Object.keys(request.headers).some(key => key.toLowerCase() === 'cookie');
    if (failPolicies) { await fulfill(requestId, policyFailureStatus, policyFailureStatus === 401
      ? { code: 'UNAUTHENTICATED', detail: '로그인이 필요해요.' }
      : { code: 'PRODUCT_UNAVAILABLE', detail: '약관을 불러오지 못했어요.' }); return; }
  } else if (request.url.endsWith('/auth/register')) {
    const body = JSON.parse(request.postData);
    registrationConsents.push({ termsAccepted: body.termsAccepted, privacyAccepted: body.privacyAccepted, termsVersion: body.termsVersion, privacyVersion: body.privacyVersion });
    if (staleNext) { staleNext = false; await fulfill(requestId, 400, { code: 'CONSENT_VERSION_CHANGED', detail: '약관 내용이 변경되었어요. 최신 내용을 확인한 뒤 다시 동의해 주세요.' }); return; }
    if (holdSignup) { heldRequest = requestId; return; }
  }
  await page.send('Fetch.continueRequest', { requestId });
}

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9496, t => !t.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Browser unavailable');
  await page.send('Page.enable'); await page.send('Runtime.enable');
  page.on(event => { if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text); void intercept(event).catch(error => errors.push(error.message)); });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/policies' }, { urlPattern: '*api/v1/auth/register' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: origin + '/_frame/login' }); await has('#account-remember');
  await page.evaluate('document.fonts.ready');
  check(await page.evaluate(`!document.body.innerText.includes('이메일과 비밀번호로 로그인해 주세요.')&&!document.body.innerText.includes('처음 오셨나요')`), 'Login intro and conversational footer removed');
  check(await page.evaluate(`Array.from(document.querySelector('nav[aria-label="계정 안내"]').children).map(n=>n.textContent).join('|')==='회원가입|ID 찾기|비밀번호 찾기'`), 'Login has exactly the three requested links');
  check(await page.evaluate(`Array.from(document.querySelector('nav[aria-label="계정 안내"]').children).every(n=>Number(getComputedStyle(n).fontWeight)>=650&&!['"|"','""'].includes(getComputedStyle(n,'::before').content)&&getComputedStyle(n,'::before').borderLeftWidth==='0px')`), 'Account links are bold and have no separator lines');
  check(await page.evaluate(`parseFloat(getComputedStyle(document.querySelector('main img').parentElement).marginBottom)>=44`), 'Logo has more space above the login form');
  check(await page.evaluate(`getComputedStyle(document.querySelector('#account-remember')).opacity==='0'&&document.querySelector('#account-remember').nextElementSibling.getBoundingClientRect().width===22`), 'Remember checkbox uses the custom control');
  await page.evaluate(`document.querySelector('#account-remember').focus()`); await page.key(' ', 'Space');
  check(await page.evaluate(`document.querySelector('#account-remember').checked&&getComputedStyle(document.querySelector('#account-remember').nextElementSibling).outlineStyle==='solid'`), 'Remember checkbox supports Space and visible keyboard focus');
  await set('#account-password', password); await click('[aria-label="비밀번호 표시"]');
  check(await page.evaluate(`document.querySelector('#account-password').type==='text'`), 'Password visibility toggles without clearing input');
  await click('[aria-label="비밀번호 숨기기"]');
  await writeFile(path.join(output, 'auth-login-ui.png'), await page.screenshot());
  await click('nav[aria-label="계정 안내"] button'); await has('dialog[open]');
  check(await page.evaluate(`document.querySelector('dialog').innerText.includes('이메일이 로그인 ID')`), 'ID link explains the existing email ID');
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog')`), 'Close ID dialog');
  check(await page.evaluate(`document.activeElement.textContent==='ID 찾기'&&document.querySelector('#account-password').value.length>0`), 'Dialog close restores focus and keeps input');
  await click('nav[aria-label="계정 안내"] button:last-child'); await has('dialog[open]');
  check(await page.evaluate(`document.querySelector('dialog').innerText.includes('아직 준비 중')`), 'Password recovery is honest about its unconnected state');
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog')`), 'Close recovery dialog');

  failPolicies = true;
  await click('nav[aria-label="계정 안내"] a'); await has('#account-agree-all');
  await until(() => page.evaluate(`!!Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='다시 시도')`), 'Policy failure');
  check(await page.evaluate(`document.querySelector('main form button[type=submit]').disabled&&document.querySelector('#account-agree-all').disabled`), 'Policy fetch failure blocks signup and agreement');
  check(await page.evaluate(`!document.body.innerText.includes('로그인이 필요')&&document.body.innerText.includes('약관을 불러오지 못')`), 'A policy 401 never asks an anonymous signup user to log in');
  policyFailureStatus = 503;
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='다시 시도').click()`);
  await until(() => page.evaluate(`!!Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='다시 시도')&&!document.body.innerText.includes('불러오는 중')`), 'Policy 503');
  check(await page.evaluate(`document.querySelector('main form button[type=submit]').disabled&&document.body.innerText.includes('약관을 불러오지 못')`), 'Policy outage remains an honest error instead of allowing signup');
  failPolicies = false;
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='다시 시도').click()`);
  await until(() => page.evaluate(`!document.querySelector('#account-agree-all').disabled`), 'Policy retry');
  check(policyLoads >= 2, 'Policy retry loads server documents');
  check(!policySentCookie, 'Public policy requests do not send the account cookie');
  check(await page.evaluate(`getComputedStyle(document.querySelector('h1')).textAlign==='center'&&!document.body.innerText.includes('계정을 만들고 나만의 채널을 시작하세요.')`), 'Signup title centered and intro removed');
  await set('[name=email]', 'auth_' + run + '@example.invalid'); await set('[name=displayName]', '가입 화면 검증');
  check(await page.evaluate(`!document.querySelector('[name=handle]')&&document.querySelector('#account-agree-all').closest('label').parentElement.tagName==='FIELDSET'`), 'Signup has no channel ID field or extra agreement card wrapper');
  await set('[name=password]', password); await set('[name=passwordConfirmation]', password);
  await click('main form button[type=submit]'); await has('#account-consent-error');
  check(await page.evaluate(`document.activeElement.id==='account-terms'&&document.querySelector('#account-terms').getAttribute('aria-invalid')==='true'`) && registrationConsents.length === 0, 'Missing consent focuses first unchecked item without an API call');
  await click('#account-terms');
  check(await page.evaluate(`document.querySelector('#account-agree-all').indeterminate&&!document.querySelector('#account-agree-all').checked`), 'One accepted document shows the mixed selection state');
  await click('main form button[type=submit]');
  check(await page.evaluate(`document.activeElement.id==='account-privacy'`), 'Only missing privacy consent receives focus');
  await click('#account-agree-all');
  check(await page.evaluate(`document.querySelector('#account-terms').checked&&document.querySelector('#account-privacy').checked&&!document.querySelector('#account-consent-error')`), 'Agree all selects both and clears the error');
  await click('#account-agree-all');
  check(await page.evaluate(`!document.querySelector('#account-terms').checked&&!document.querySelector('#account-privacy').checked`), 'Agree all can clear both consents');
  await click('[aria-label="이용약관 보기"]'); await has('dialog[open]');
  check(await page.evaluate(`document.querySelector('dialog').innerText.includes('시행일')&&document.querySelectorAll('dialog section').length===3`), 'Terms dialog shows the server document and version');
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog')`), 'Close terms');
  check(await page.evaluate(`!document.querySelector('#account-terms').checked&&document.activeElement.getAttribute('aria-label')==='이용약관 보기'`), 'Reading or closing terms does not silently consent');
  await click('[aria-label="개인정보 수집·이용 내용 보기"]'); await has('dialog[open]');
  check(await page.evaluate(`document.querySelectorAll('dialog section').length===4&&document.querySelector('dialog').innerText.includes('보유·이용 기간')`), 'Privacy dialog explains the collected data and retention');
  await writeFile(path.join(output, 'auth-privacy-ui.png'), await page.screenshot());
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog')`), 'Close privacy');
  await click('#account-agree-all'); staleNext = true;
  const loadsBefore = policyLoads;
  await click('main form button[type=submit]');
  await until(() => page.evaluate(`document.body.innerText.includes('약관 내용이 변경')&&!document.querySelector('#account-agree-all').disabled&&!document.querySelector('#account-terms').checked`), 'Stale document recovery');
  check(policyLoads > loadsBefore && await page.evaluate(`!document.querySelector('#account-privacy').checked&&document.querySelector('[name=displayName]').value==='가입 화면 검증'`), 'Stale consent reloads documents and resets consent while keeping entered fields');
  await click('#account-agree-all');
  check(await page.evaluate(`!document.body.innerText.includes('약관 내용이 변경')`), 'Changed-document notice clears after renewed consent');
  await page.evaluate('scrollTo(0,0)'); await writeFile(path.join(output, 'auth-signup-ui.png'), await page.screenshot());
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true });
    await page.evaluate('scrollTo(0,0)'); await sleep(100);
    check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('h1').getBoundingClientRect().left>=0`), `Signup has no horizontal overflow at ${width}px`);
    if (width === 390) await writeFile(path.join(output, 'auth-signup-mobile-ui.png'), await page.screenshot());
  }
  const attemptsBeforeExpiry = registrationConsents.length;
  await page.send('Network.setCookie', { name: 'FRAME_SESSION', value: Buffer.from('00000000-0000-4000-8000-000000000001').toString('base64'), url: origin, path: '/', httpOnly: true, sameSite: 'Lax' });
  await click('main form button[type=submit]');
  await until(() => page.evaluate(`document.body.innerText.includes('연결이 만료되어 다시 확인')&&!document.querySelector('fieldset').disabled`), 'Expired signup session recovery');
  check(registrationConsents.length === attemptsBeforeExpiry + 1 && await page.evaluate(`document.querySelector('[name=displayName]').value==='가입 화면 검증'&&document.querySelector('#account-privacy').checked`), 'Expired session refresh keeps inputs and consent without replaying signup');
  holdSignup = true;
  await click('main form button[type=submit]'); await until(() => Boolean(heldRequest), 'Held signup request');
  check(await page.evaluate(`document.querySelector('fieldset').disabled&&document.querySelector('nav[aria-label="계정 안내"] a').getAttribute('aria-disabled')==='true'&&Array.from(document.querySelectorAll('nav[aria-label="계정 안내"] button')).every(b=>b.disabled)&&document.querySelector('a[aria-label="이전 화면으로"]').getAttribute('aria-disabled')==='true'`), 'Pending signup disables fields, helpers, back and mode switching');
  await page.send('Fetch.continueRequest', { requestId: heldRequest }); heldRequest = null;
  await has('button[aria-label="내 계정"]');
  check(true, 'Real browser signup succeeds with required consent');
  check(registrationConsents.every(c => c.termsAccepted === true && c.privacyAccepted === true && c.termsVersion && c.privacyVersion), 'Browser sends both booleans and fetched policy versions');
  await page.send('Page.reload'); await has('button[aria-label="내 계정"]');
  check(await page.evaluate(`fetch('/api/v1/session').then(r=>r.json()).then(s=>!!s.user&&s.user.email===${JSON.stringify('auth_' + run + '@example.invalid')}&&/^ch-[a-f0-9]{20}$/.test(s.channel.handle))`), 'Signup identity and server-generated channel ID survive reload');
  check(errors.length === 0, 'No browser runtime or interception errors');
  await writeFile(path.join(output, 'auth-ui-result.json'), JSON.stringify({ origin, verificationDatabaseOnly: true, faultInjection: ['Policy GET 401 and 503', 'Stale consent response', 'Expired session cookie', 'Delayed signup request'], results, runtimeErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(r => r.pass).length, runtimeErrors: errors.length }));
} catch (error) {
  await writeFile(path.join(output, 'auth-ui-failure.json'), JSON.stringify({ results, failure: error.message, runtimeErrors: errors }, null, 2));
  if (page) await writeFile(path.join(output, 'auth-ui-failure.png'), await page.screenshot());
  throw error;
} finally {
  if (page) { await page.send('Browser.close').catch(() => {}); page.close(); }
  browser.kill();
}
