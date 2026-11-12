// Read-only development/StrictMode check of the isolated account's real chat settings and block editor.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5366', port = 9511, output = path.resolve('verification/product');
const fixtureDirectory = process.env.FRAME_CHAT_TEST_DIR;
if (!fixtureDirectory) throw Error('A private isolated chat fixture directory is required.');
const relative = path.relative(path.resolve('.'), path.resolve(fixtureDirectory));
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('The fixture checkpoint must remain outside the repository.');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(path.join(fixtureDirectory, 'chat-moderation-checkpoint.json'), 'utf8')); }
catch { throw Error('The private chat fixture checkpoint could not be read.'); }
const owner = checkpoint.owner, uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (!owner || !Array.isArray(owner.cookies) || !owner.cookies.length || typeof owner.userId !== 'string' || !uuid.test(owner.userId)) throw Error('The private owner fixture is incomplete.');
const cookies = owner.cookies.filter(cookie => typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
  .map(cookie => ({ name: cookie.name, value: cookie.value, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' }));
if (!cookies.length || cookies.length !== owner.cookies.length) throw Error('Only the dedicated local owner cookies may be installed.');
const probe = createServer();
if (!await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); })) throw Error('Dedicated chat development QA browser port is in use.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-chat-moderation-dev-ui-')), profile = path.join(directory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const results = [], errors = [], writes = [], ownerHeaders = [], successfulReads = new Set();
let page, blockedWrites = 0, chatSockets = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label, scope = 'document') {
  await page.evaluate(`(() => {const button=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing moderation action');button.dataset.devQaTarget='true';button.scrollIntoView({block:'center'});})()`);
  await page.click('[data-dev-qa-target]'); await page.evaluate(`document.querySelector('[data-dev-qa-target]')?.removeAttribute('data-dev-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function tab(label) {
  await button(label, 'document.querySelector("nav[aria-label=\\"채팅 관리 메뉴\\"]")');
  await until(() => page.evaluate(`Array.from(document.querySelectorAll('nav[aria-label="채팅 관리 메뉴"] button')).some(button=>button.textContent.trim()===${JSON.stringify(label)}&&button.getAttribute('aria-current')==='page')`), 'Moderation tab changes');
  if (label === '차단 목록') { await has('[name="block-status-filter"]'); await until(() => page.evaluate(`!document.body.innerText.includes('차단 목록을 불러오는 중이에요.')`), 'Actual block list loads'); }
}
async function viewport(width) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: width < 600 }); await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`); }
const dialogGone = () => until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Dialog closes');

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 100; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Chat development QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params.request, pathname = new URL(request.url).pathname;
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) writes.push(request.method);
      if (['/api/v1/me/chat/settings', '/api/v1/me/chat/blocks'].includes(pathname)) ownerHeaders.push(Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-frame-user-id')?.[1] === owner.userId);
    }
    if (event.method === 'Network.responseReceived' && event.params.response.status === 200) {
      const pathname = new URL(event.params.response.url).pathname;
      if (['/api/v1/me/chat/settings', '/api/v1/me/chat/blocks'].includes(pathname)) successfulReads.add(pathname);
    }
    if (event.method === 'Network.webSocketCreated' && new URL(event.params.url).pathname.endsWith('/chat')) chatSockets++;
    if (event.method === 'Fetch.requestPaused') {
      const { requestId, request } = event.params, changing = !['GET', 'HEAD'].includes(request.method);
      if (changing) blockedWrites++;
      void page.send(changing ? 'Fetch.failRequest' : 'Fetch.continueRequest', changing ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
    }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/*' }] });
  try { await page.send('Network.setCookies', { cookies }); } catch { throw Error('The dedicated owner cookies could not be installed.'); }
  await viewport(1440); await page.send('Page.navigate', { url: origin + '/_frame/studio/moderation' });
  await has('[name="banned-words"]'); await sleep(2000);
  const ownerMatches = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json()).then(session=>session.user?.id===${JSON.stringify(owner.userId)})`);
  const source = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
  check(ownerMatches && source.includes('StrictMode') && successfulReads.has('/api/v1/me/chat/settings') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&document.querySelectorAll('[name="banned-words"]').length===1&&!document.querySelector('[role="alert"]')`),
    'Real development StrictMode loads the captured owner’s actual settings once without a duplicate editor or error');
  const original = await page.evaluate(`document.querySelector('[name="banned-words"]').value`), draft = '로컬검증' + randomBytes(3).toString('hex');
  await set('[name="banned-words"]', draft); await tab('차단 목록'); await has('[name="block-status-filter"]'); await tab('설정');
  const retained = await page.evaluate(`document.querySelector('[name="banned-words"]').value===${JSON.stringify(draft)}&&document.body.innerText.includes('저장하지 않은 변경')`);
  await button('변경 취소');
  check(retained && await page.evaluate(`document.querySelector('[name="banned-words"]').value===${JSON.stringify(original)}`), 'Unsaved settings survive tab changes and local cancellation restores the server snapshot without saving');
  await tab('차단 목록'); await has('[name="block-status-filter"]'); await button('참여 제한 추가'); await has('dialog[open]'); await sleep(2000);
  const focused = await page.evaluate(`document.activeElement===document.querySelector('dialog h2')&&document.querySelectorAll('dialog[open]').length===1`);
  await set('[name="block-handle"]', '@local-only'); await set('[name="block-reason"]', '저장하지 않는 로컬 입력');
  await button('취소', 'document.querySelector("dialog[open]")'); await dialogGone();
  const cancelFocus = await page.evaluate(`document.activeElement?.textContent.trim()==='참여 제한 추가'`);
  await button('참여 제한 추가'); await has('dialog[open]'); const fresh = await page.evaluate(`document.querySelector('[name="block-handle"]').value===''&&document.querySelector('[name="block-reason"]').value===''`);
  await page.key('Escape'); await dialogGone();
  check(focused && cancelFocus && fresh && await page.evaluate(`document.activeElement?.textContent.trim()==='참여 제한 추가'`), 'The add dialog survives effect replay, cancels draft input and restores its opener after Cancel and Escape');
  await viewport(390); await tab('설정'); await page.evaluate('scrollTo(0,0)');
  const settingsFit = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`);
  await writeFile(path.join(output, 'chat-moderation-dev-settings.png'), await page.screenshot());
  await viewport(320); await tab('차단 목록'); await has('[name="block-status-filter"]'); const blocksFit = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`);
  await button('참여 제한 추가'); await has('dialog[open]');
  check(settingsFit && blocksFit && await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth`), 'Settings fit 390px and the block list and add dialog fit 320px');
  await writeFile(path.join(output, 'chat-moderation-dev-dialog.png'), await page.screenshot());
  await page.key('Escape'); await dialogGone();
  check(errors.length === 0 && writes.length === 0 && blockedWrites === 0 && chatSockets === 0 && ownerHeaders.length > 0 && ownerHeaders.every(Boolean)
    && successfulReads.has('/api/v1/me/chat/settings') && successfulReads.has('/api/v1/me/chat/blocks') && await page.evaluate(`!document.querySelector('[role="alert"]')`),
    'Both real management reads carry the captured owner, with no writes, chat sockets or runtime errors');
  await writeFile(path.join(output, 'chat-moderation-dev-result.json'), JSON.stringify({ origin, developmentStrictMode: true, readOnly: true, dedicatedFixtureCookiesOnly: true,
    results, runtimeErrors: errors, dataChangingRequests: writes.length, blockedWrites, chatSockets, ownerHeadersMatched: true, complete: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length, dataChangingRequests: writes.length }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'chat-moderation-dev-result.json'), JSON.stringify({ origin, readOnly: true, results, failure: failure.message, runtimeErrors: errors,
    dataChangingRequests: writes.length, blockedWrites, chatSockets, ownerHeadersMatched: ownerHeaders.length > 0 && ownerHeaders.every(Boolean), complete: false }, null, 2));
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
