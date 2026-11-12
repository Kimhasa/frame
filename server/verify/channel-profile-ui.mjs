// Exercises real account/profile/report persistence only on the isolated 5365/18083 verification app.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5365', api = 'http://127.0.0.1:18083';
const directory = await mkdtemp(path.join(tmpdir(), 'frame-channel-profile-ui-'));
const profile = path.join(directory, 'profile'), output = path.resolve('verification/product');
const suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9496', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const results = [], errors = [], writes = [], reportResponses = [];
let page, profileFailure = false, reportFailure = false, holdProfile = false, heldProfile;
const profileName = '채널 프로필 검증', newHandle = `profile-${suffix}`;
const description = '오래 머물고 싶은 작은 작업실입니다. 함께 만들고 배우며, 완성하는 과정을 나눕니다.\n'.repeat(5) + '소개 마지막 문장도 확인해요.';
const links = [{ title: '포트폴리오', url: 'https://example.org/portfolio?from=frame' }, { title: '작업 노트', url: 'https://example.net/notes' }];

function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, params) {
  const marker = randomBytes(8).toString('hex');
  await page.evaluate(`window.__channelProfileQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, params);
  await until(async () => {
    try { return await page.evaluate(`window.__channelProfileQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); }
    catch { return false; }
  }, 'New channel profile document');
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); }
async function reload() { await navigateDocument('Page.reload', {}); }
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label, scope = 'document') {
  const selector = await page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!element)throw Error('Missing button: '+${JSON.stringify(label)});element.dataset.channelQaTarget='true';element.scrollIntoView({block:'center'});return '[data-channel-qa-target="true"]';})()`);
  await page.click(selector); await page.evaluate(`document.querySelector('[data-channel-qa-target]')?.removeAttribute('data-channel-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input: '+${JSON.stringify(selector)});const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function fulfill(requestId, status, code, detail) {
  await page.send('Fetch.fulfillRequest', { requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify({ code, detail })).toString('base64') });
}
async function intercept(event) {
  if (event.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = event.params, url = new URL(request.url);
  const profileWrite = request.method === 'PATCH' && url.pathname === '/api/v1/me/channel';
  const reportWrite = request.method === 'POST' && /^\/api\/v1\/channels\/[^/]+\/reports$/.test(url.pathname);
  if (profileWrite || reportWrite) writes.push({ kind: profileWrite ? 'profile' : 'report', method: request.method });
  if (profileWrite && profileFailure) { profileFailure = false; await fulfill(requestId, 503, 'PRODUCT_UNAVAILABLE', '채널 정보를 저장하지 못했어요.'); return; }
  if (profileWrite && holdProfile) { heldProfile = requestId; return; }
  if (reportWrite && reportFailure) { reportFailure = false; await fulfill(requestId, 503, 'PRODUCT_UNAVAILABLE', '신고를 접수하지 못했어요.'); return; }
  await page.send('Fetch.continueRequest', { requestId });
}
async function signup(email, name, route = '/login?mode=register') {
  if (route) await nav(route); await has('#account-agree-all');
  await until(() => page.evaluate(`!document.querySelector('#account-agree-all').disabled`), 'Signup policies');
  await set('[name=email]', email); await set('[name=displayName]', name);
  await set('[name=password]', password); await set('[name=passwordConfirmation]', password); await click('#account-agree-all');
  await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
  return page.evaluate(`fetch('/api/v1/session').then(response=>response.json())`);
}
async function anonymous(route) { await page.send('Network.clearBrowserCookies'); await nav(route); }
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, name), await page.screenshot()); }
async function closeDialog() { await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Dialog closes'); }
const countWrites = kind => writes.filter(write => write.kind === kind).length;

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9496, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Channel profile QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.responseReceived' && /\/api\/v1\/channels\/[^/]+\/reports(?:\?|$)/.test(event.params.response.url)) reportResponses.push(event.params.response.status);
    void intercept(event).catch(failure => errors.push(failure.message));
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/me/channel' }, { urlPattern: '*api/v1/channels/*/reports' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // The concrete field and dialog checks below intentionally target the product UI, not test-only fixture routes.
  const owner = await signup(`channel_profile_owner_${suffix}@example.invalid`, profileName);
  check(Boolean(owner.user?.id && owner.channel?.id), 'Owner signs up through the real consent and registration form');
  check(owner.channel.videoCount === null && owner.channel.totalViewCount === null && Number.isSafeInteger(owner.channel.createdAtMs), 'New channel exposes a real creation timestamp and unknown video metrics as null');

  const originalHandle = owner.channel.handle;
  await nav('/studio/channel'); await has('[name=handle]');
  await set('[name=displayName]', profileName); await set('[name=description]', description);
  await click('[name=handle]'); await set('[name=handle]', '@' + newHandle.toUpperCase()); await click('[name=displayName]');
  await set('[name=countryCode]', 'KR'); await set('[name=notice]', '매주 화요일 저녁에 만나요.');
  await button('링크 추가'); await has('[name="link-title-0"]');
  await set('[name="link-title-0"]', links[0].title); await set('[name="link-url-0"]', 'javascript:alert(1)');
  const beforeUnsafe = countWrites('profile'); await click('main form button[type=submit]');
  await visibleText('http:// 또는 https://');
  check(countWrites('profile') === beforeUnsafe && await page.evaluate(`document.querySelector('[name="link-url-0"]').value==='javascript:alert(1)'`), 'Unsafe link scheme is rejected before submission without erasing entered fields');
  await set('[name="link-url-0"]', links[0].url); await button('링크 추가'); await has('[name="link-title-1"]');
  await set('[name="link-title-1"]', links[1].title); await set('[name="link-url-1"]', links[1].url);
  check(await page.evaluate(`document.querySelector('[name=handle]').value===${JSON.stringify(newHandle)}`), 'Pasted mixed-case @handle normalizes to the canonical lowercase handle');
  await click('[aria-label="링크 1 아래로 이동"]');
  check(await page.evaluate(`document.querySelector('[name="link-title-0"]').value===${JSON.stringify(links[1].title)}&&document.querySelector('[name="link-title-1"]').value===${JSON.stringify(links[0].title)}`), 'Reordering public links keeps each title paired with its URL');
  await click('[aria-label="링크 2 위로 이동"]');
  profileFailure = true; await click('main form button[type=submit]'); await visibleText('채널 정보를 저장하지 못했어요');
  check(await page.evaluate(`document.querySelector('[name=description]').value===${JSON.stringify(description)}&&document.querySelector('[name=handle]').value===${JSON.stringify(newHandle)}&&document.querySelector('[name=countryCode]').value==='KR'&&document.querySelector('[name="link-url-1"]').value===${JSON.stringify(links[1].url)}`), 'Profile 503 preserves description, handle, country and all links');
  check(await page.evaluate(`fetch('/api/v1/session').then(r=>r.json()).then(s=>s.channel.handle===${JSON.stringify(originalHandle)}&&s.channel.description==='')`), 'Failed profile save does not change the persisted channel');
  holdProfile = true; const beforePending = countWrites('profile'); await click('main form button[type=submit]');
  await until(() => Boolean(heldProfile), 'Held profile save');
  check(await page.evaluate(`document.querySelector('main form fieldset').disabled&&document.querySelector('main form button[type=submit]').matches(':disabled')`), 'Pending save disables editable controls and the submit action');
  await page.key('Enter'); await page.evaluate(`document.querySelector('main form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  check(countWrites('profile') === beforePending + 1, 'Pending Enter and repeated submit cannot create duplicate writes');
  holdProfile = false; await page.send('Fetch.continueRequest', { requestId: heldProfile }); heldProfile = null;
  await visibleText('채널 정보를 저장했어요');
  check(await page.evaluate(`document.querySelector('main form button[type=submit]').disabled&&!document.querySelector('main form fieldset').disabled`), 'Real save returns the editor to its clean, editable state');
  await reload(); await has('[name=handle]');
  check(await page.evaluate(`document.querySelector('[name=description]').value===${JSON.stringify(description)}&&document.querySelector('[name=handle]').value===${JSON.stringify(newHandle)}&&document.querySelector('[name=countryCode]').value==='KR'&&document.querySelector('[name="link-url-0"]').value===${JSON.stringify(links[0].url)}&&document.querySelector('[name="link-url-1"]').value===${JSON.stringify(links[1].url)}`), 'Saved profile and ordered links survive a full browser reload');
  const updated = await page.evaluate(`fetch('/api/v1/session').then(r=>r.json()).then(s=>s.channel)`);
  check(updated.id === owner.channel.id && updated.handle === newHandle && updated.countryCode === 'KR' && JSON.stringify(updated.links) === JSON.stringify(links), 'Profile changes retain the immutable channel UUID and reach the real backend');
  await page.evaluate('scrollTo(0,0)'); await screenshot('channel-profile-editor-ui.png');
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); await page.evaluate('scrollTo(0,0)');
    check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Channel editor has no horizontal overflow at ${width}px`);
  }
  await screenshot('channel-profile-editor-mobile-ui.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const resolved = await page.evaluate(`Promise.all([fetch('/api/v1/channels/'+${JSON.stringify(originalHandle)}).then(r=>r.json()),fetch('/api/v1/channel-ids/'+${JSON.stringify(owner.channel.id)}).then(r=>r.json())])`);
  check(resolved.every(channel => channel.id === owner.channel.id && channel.handle === newHandle), 'Retired handle and immutable UUID endpoints resolve the same current channel');
  await nav(`/channel/${originalHandle}?tab=about#profile`); await visibleText('@' + newHandle);
  check(await page.evaluate(`location.pathname===${JSON.stringify('/_frame/channel/' + newHandle)}&&location.search==='?tab=about'&&location.hash==='#profile'`), 'Retired handle route canonicalizes without losing tab or fragment');
  await nav(`/channel/id/${owner.channel.id}?tab=about`); await visibleText('@' + newHandle);
  check(await page.evaluate(`location.pathname===${JSON.stringify('/_frame/channel/' + newHandle)}&&location.search==='?tab=about'`), 'Immutable channel route opens the same canonical channel');

  await click('[aria-label="채널 정보 더보기"]'); await has('dialog[open]');
  check(await page.evaluate(`document.activeElement===document.querySelector('dialog h2')&&document.querySelector('dialog').innerText.includes('소개 마지막 문장도 확인해요.')`), 'Details dialog receives focus and exposes the complete stored description');
  check(await page.evaluate(`(() => {const d=document.querySelector('dialog');const expectedCountry=new Intl.DisplayNames(['ko'],{type:'region'}).of('KR');return d.innerText.includes(expectedCountry)&&d.querySelector('time')?.dateTime===${JSON.stringify(new Date(updated.createdAtMs).toISOString())}&&!Array.from(d.querySelectorAll('dt')).some(node=>/동영상 수|누적 조회수/.test(node.textContent));})()`), 'Details show the stored country and actual join date while hiding unknown video metrics');
  check(await page.evaluate(`Array.from(document.querySelectorAll('dialog a[target="_blank"]')).length===2&&Array.from(document.querySelectorAll('dialog a[target="_blank"]')).every(a=>a.relList.contains('noopener')&&a.relList.contains('noreferrer')&&['http:','https:'].includes(new URL(a.href).protocol))&&!Array.from(document.querySelectorAll('dialog button')).some(button=>button.textContent.trim()==='채널 신고')`), 'Public links open safely and an owner has no report-own-channel action');
  await screenshot('channel-profile-details-ui.png');
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true });
    check(await page.evaluate(`(() => {const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=-1&&r.right<=innerWidth+1&&d.scrollWidth<=d.clientWidth+1;})()`), `Channel details fit and remain readable at ${width}px`);
  }
  await screenshot('channel-profile-details-mobile-ui.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await closeDialog();
  check(await page.evaluate(`document.activeElement?.getAttribute('aria-label')==='채널 정보 더보기'`), 'Escape closes the details and restores focus to the opening control');

  const publicRoute = `/channel/${newHandle}?tab=about`;
  await anonymous(publicRoute); await has('[aria-label="채널 정보 더보기"]');
  await click('[aria-label="채널 정보 더보기"]'); await has('dialog[open]');
  check(await page.evaluate(`!location.pathname.endsWith('/login')&&!!document.querySelector('dialog time')&&document.querySelector('dialog').innerText.includes('소개 마지막 문장도 확인해요.')`), 'Anonymous visitors can read the complete real channel profile');
  await closeDialog();
  await page.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__channelQaClipboard=value;}}});Object.defineProperty(navigator,'share',{configurable:true,value:async value=>{window.__channelQaShare=value;}});`);
  await click('[aria-label="채널 공유"]'); await has('[name="channel-share-url"]');
  const stableUrl = `${origin}/_frame/channel/id/${owner.channel.id}`;
  await click('[aria-label="채널 링크 복사"]'); await visibleText('링크를 복사했어요');
  check(await page.evaluate(`document.querySelector('[name="channel-share-url"]').value===${JSON.stringify(stableUrl)}&&window.__channelQaClipboard===${JSON.stringify(stableUrl)}`), 'Anonymous copy shares the immutable channel URL rather than a renameable handle');
  await button('다른 앱으로 공유', 'document.querySelector("dialog")');
  check(await page.evaluate(`window.__channelQaShare?.url===${JSON.stringify(stableUrl)}&&window.__channelQaShare.title===${JSON.stringify(profileName + ' · FRAME')}`), 'Web Share receives the canonical channel title and stable URL without launching an OS app');
  await click('[aria-label="채널 정보로 돌아가기"]'); await button('채널 신고', 'document.querySelector("dialog")');
  await has('#account-email');
  check(await page.evaluate(`new URLSearchParams(location.search).get('returnTo')===${JSON.stringify(publicRoute)}&&!new URLSearchParams(location.search).has('follow')&&!document.querySelector('dialog[open]')`), 'Anonymous reporting opens login with the exact return path and no accidental follow request');
  await click('nav[aria-label="계정 안내"] a'); await has('#account-agree-all');
  const reporter = await signup(`channel_profile_reporter_${suffix}@example.invalid`, '신고 검증 사용자', null);
  await has('[aria-label="채널 정보 더보기"]');
  check(reporter.user.id !== owner.user.id && await page.evaluate(`location.pathname===${JSON.stringify('/_frame/channel/' + newHandle)}&&location.search==='?tab=about'`), 'A separately registered account returns to the intended channel after authentication');
  await click('[aria-label="채널 정보 더보기"]'); await has('dialog[open]'); await button('채널 신고', 'document.querySelector("dialog")');
  await has('dialog [name="report-reason"]');
  const beforeInvalidReport = countWrites('report');
  await click('dialog button[type=submit]'); await visibleText('신고 사유를 선택해 주세요');
  await click('dialog [name="report-reason"][value=other]'); await click('dialog button[type=submit]'); await visibleText('신고 내용을 입력해 주세요');
  check(countWrites('report') === beforeInvalidReport && await page.evaluate(`document.activeElement.name==='report-details'`), 'Report validation requires a reason and details for Other before any request');
  const reportDetails = '채널 정보에서 확인한 내용을 검토해 주세요. 검증을 위한 독립 계정 신고입니다.';
  await set('dialog [name="report-details"]', reportDetails); reportFailure = true;
  await click('dialog button[type=submit]'); await visibleText('신고를 접수하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog [name="report-reason"][value=other]').checked&&document.querySelector('dialog [name="report-details"]').value===${JSON.stringify(reportDetails)}`), 'Report 503 preserves the open form, selected reason and entered details');
  await click('dialog button[type=submit]'); await visibleText('신고가 접수됐어요');
  await until(() => reportResponses.includes(201), 'Real report receipt');
  check(await page.evaluate(`document.querySelector('dialog h2').textContent==='신고 접수'&&!document.querySelector('dialog form')&&document.activeElement===document.querySelector('dialog h2')`), 'Real HTTP 201 replaces the form with the accessible received receipt');
  await screenshot('channel-profile-report-ui.png'); await button('확인', 'document.querySelector("dialog")');
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Receipt closes');
  await click('[aria-label="채널 정보 더보기"]'); await has('dialog[open]'); await button('채널 신고', 'document.querySelector("dialog")');
  await click('dialog [name="report-reason"][value=other]'); await set('dialog [name="report-details"]', reportDetails); await click('dialog button[type=submit]');
  await until(() => reportResponses.includes(409), 'Real duplicate report conflict');
  check(await page.evaluate(`!!document.querySelector('dialog [role=alert]')&&document.querySelector('dialog [name="report-details"]').value===${JSON.stringify(reportDetails)}&&!document.querySelector('dialog').innerText.includes('신고가 접수됐어요')`), 'Real duplicate HTTP 409 remains a recoverable form error instead of a second success');
  check(errors.length === 0, 'No browser runtime or request interception errors');
  if (process.env.FRAME_PROFILE_TEST_DIR) {
    const checkpointDirectory = path.resolve(process.env.FRAME_PROFILE_TEST_DIR), repository = path.resolve('.');
    const relative = path.relative(repository, checkpointDirectory);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('Private QA checkpoint must stay outside the repository.');
    const cookieState = await page.send('Network.getCookies', { urls: [origin] });
    const session = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json())`);
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(path.join(checkpointDirectory, 'channel-profile-checkpoint.json'), JSON.stringify({
      cookies: cookieState.cookies.filter(cookie => cookie.domain === '127.0.0.1').map(({ name, value }) => ({ name, value })),
      csrfToken: session.csrfToken,
      target: { id: updated.id, handle: updated.handle, originalHandle, description: updated.description, countryCode: updated.countryCode, links: updated.links, createdAtMs: updated.createdAtMs },
      report: { reason: 'other', details: reportDetails },
    }));
  }
  await writeFile(path.join(output, 'channel-profile-ui-result.json'), JSON.stringify({ origin, api, verificationDatabaseOnly: true,
    checks: results.length, passed: results.filter(result => result.pass).length,
    faultInjection: ['Profile PATCH 503', 'Delayed profile PATCH', 'Report POST 503'],
    actualReportStatuses: reportResponses, results, runtimeErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'channel-profile-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors: errors }, null, 2));
  if (page) await screenshot('channel-profile-ui-failure.png').catch(() => {});
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
