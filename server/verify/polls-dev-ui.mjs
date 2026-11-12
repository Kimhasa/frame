// Read-only development/StrictMode smoke of the isolated owner's real poll list and results.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5366', port = 9521, output = path.resolve('verification/product');
const fixtureDirectory = process.env.FRAME_POLLS_TEST_DIR;
if (!fixtureDirectory) throw Error('A private isolated poll fixture directory is required.');
const relative = path.relative(path.resolve('.'), path.resolve(fixtureDirectory));
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('The poll checkpoint must remain outside the repository.');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(path.join(fixtureDirectory, 'polls-checkpoint.json'), 'utf8')); }
catch { throw Error('The private poll checkpoint could not be read.'); }
const owner = checkpoint.owner, closedPollId = checkpoint.closedPollId, uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (!owner || !Array.isArray(owner.cookies) || !owner.cookies.length || !uuid.test(owner.userId ?? '') || !uuid.test(closedPollId ?? '')) throw Error('The isolated poll owner and closed result fixture are required.');
const cookies = owner.cookies.filter(cookie => typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
  .map(cookie => ({ name: cookie.name, value: cookie.value, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' }));
if (!cookies.length || cookies.length !== owner.cookies.length) throw Error('Only the dedicated local poll owner cookies may be installed.');
const probe = createServer();
if (!await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); })) throw Error('The dedicated poll development browser port is in use.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-polls-dev-ui-')), profile = path.join(directory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
await writeFile(path.join(fixtureDirectory, 'browser-dev-owner.json'), JSON.stringify({ pid: browser.pid, profile }));
const results = [], errors = [], ownerHeaders = [], successfulReads = new Set(), listFilters = [], listResponses = [];
let page, writes = 0, blockedWrites = 0, chatSockets = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), 'Poll UI element appears');
async function button(label, scope = 'document', byAria = false) {
  await page.evaluate(`(() => {const target=Array.from(${scope}.querySelectorAll('button')).find(button=>${byAria ? 'button.getAttribute("aria-label")' : 'button.textContent.trim()'}===${JSON.stringify(label)});if(!target)throw Error('Missing poll action');target.dataset.devQaTarget='true';target.scrollIntoView({block:'center'});})()`);
  await page.click('[data-dev-qa-target]');
  await page.evaluate(`document.querySelector('[data-dev-qa-target]')?.removeAttribute('data-dev-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function viewport(width) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: width < 600 });
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
}
const gone = () => until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'The poll results dialog closes');
const detailPath = `/api/v1/me/polls/${closedPollId}`;

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 100; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('The poll development browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params.request, url = new URL(request.url);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) writes++;
      if (url.pathname === '/api/v1/me/polls' || url.pathname.startsWith('/api/v1/me/polls/')) {
        ownerHeaders.push(Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-frame-user-id')?.[1] === owner.userId);
        if (url.pathname === '/api/v1/me/polls') listFilters.push({ status: url.searchParams.get('status'), q: url.searchParams.get('q') });
      }
    }
    if (event.method === 'Network.responseReceived' && event.params.response.status === 200) {
      const url = new URL(event.params.response.url), pathname = url.pathname;
      if (pathname === '/api/v1/me/polls' || pathname === detailPath) successfulReads.add(pathname);
      if (pathname === '/api/v1/me/polls') listResponses.push({ status: url.searchParams.get('status'), q: url.searchParams.get('q') });
    }
    if (event.method === 'Network.webSocketCreated' && new URL(event.params.url).pathname.endsWith('/chat')) chatSockets++;
    if (event.method === 'Fetch.requestPaused') {
      const { requestId, request } = event.params, changing = !['GET', 'HEAD'].includes(request.method);
      if (changing) blockedWrites++;
      void page.send(changing ? 'Fetch.failRequest' : 'Fetch.continueRequest', changing ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
    }
  });
  // Defense in depth: this smoke cannot save settings, close a poll or cast a vote.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/*' }] });
  try { await page.send('Network.setCookies', { cookies }); } catch { throw Error('The dedicated poll owner cookies could not be installed.'); }
  await viewport(1440); await page.send('Page.navigate', { url: origin + '/_frame/studio/polls?status=closed' });
  await has('table[aria-label="투표 목록"]'); await sleep(2000);
  const ownerMatches = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json()).then(session=>session.user?.id===${JSON.stringify(owner.userId)})`);
  const source = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
  check(ownerMatches && source.includes('StrictMode') && successfulReads.has('/api/v1/me/polls') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&document.querySelectorAll('#polls-title').length===1&&document.querySelectorAll('table[aria-label="투표 목록"]').length===1&&!document.querySelector('[role="alert"]')`),
    'Real development StrictMode retains one actual owner poll list without duplicate UI or errors');

  const fixture = await page.evaluate(`fetch(${JSON.stringify(detailPath)},{headers:{'X-FRAME-USER-ID':${JSON.stringify(owner.userId)}}}).then(async response=>{if(!response.ok)throw Error('Closed fixture unavailable');const result=await response.json();if(result.userId!==${JSON.stringify(owner.userId)}||result.poll?.id!==${JSON.stringify(closedPollId)}||result.poll.status!=='closed')throw Error('Closed fixture mismatch');return {question:result.poll.question,totalVotes:result.poll.totalVotes};})`);
  if (!fixture || typeof fixture.question !== 'string' || !fixture.question || !Number.isSafeInteger(fixture.totalVotes)) throw Error('The closed poll fixture was malformed.');
  await set('[name="poll-query"]', fixture.question); await button('검색', 'document.querySelector("form[aria-label=\\"투표 검색\\"]")');
  await until(() => listResponses.some(filter => filter.status === 'closed' && filter.q === fixture.question)
    && page.evaluate(`new URL(location.href).searchParams.get('q')===${JSON.stringify(fixture.question)}&&Array.from(document.querySelectorAll('table[aria-label="투표 목록"] button')).some(button=>button.getAttribute('aria-label')===${JSON.stringify(fixture.question + ' 결과')})`), 'The real server search returns the closed poll');
  check(listFilters.some(filter => filter.status === 'closed' && filter.q === fixture.question) && await page.evaluate(`document.querySelector('[name="poll-status-filter"]').value==='closed'&&JSON.stringify(Array.from(document.querySelector('[name="poll-status-filter"]').options).map(option=>[option.value,option.text]))===JSON.stringify([['all','전체 상태'],['active','진행 중'],['closed','마감']])&&document.querySelector('[name="poll-query"]').value===${JSON.stringify(fixture.question)}`),
    'Search and the labeled status filter query the server while retaining the closed fixture');

  await button(fixture.question + ' 결과', 'document', true); await has('dialog[open]');
  await until(() => page.evaluate(`document.querySelector('dialog')?.innerText.includes('최근 확인')`), 'The result dialog refreshes its real detail');
  await sleep(2000);
  const modalStable = await page.evaluate(`document.querySelectorAll('dialog[open]').length===1&&document.querySelector('dialog h2').textContent==='투표 결과'&&document.activeElement===document.querySelector('dialog h2')&&document.querySelector('dialog h3').textContent===${JSON.stringify(fixture.question)}&&document.querySelectorAll('dialog ul[aria-label="선택지별 투표 결과"] li').length>=2&&!Array.from(document.querySelectorAll('dialog button')).some(button=>button.textContent.trim()==='투표 마감')&&!document.querySelector('dialog [role="alert"]')`);
  await page.key('Escape'); await gone();
  check(modalStable && successfulReads.has(detailPath) && await page.evaluate(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(fixture.question + ' 결과')}`),
    'A closed result survives effect replay with heading focus and Escape restores its exact opener');

  await viewport(390); await page.evaluate('scrollTo(0,0)');
  const listFits = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[name="poll-status-filter"]').getBoundingClientRect().width>0`);
  await writeFile(path.join(output, 'polls-dev-list.png'), await page.screenshot());
  await viewport(320); await button(fixture.question + ' 결과', 'document', true); await has('dialog[open]');
  await until(() => page.evaluate(`document.querySelector('dialog')?.innerText.includes('최근 확인')`), 'The mobile result refreshes');
  const modalFits = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth&&Array.from(document.querySelectorAll('dialog ul[aria-label="선택지별 투표 결과"] li > div > span')).every(span=>span.scrollWidth<=span.clientWidth+1)&&!document.querySelector('[role="alert"]')`);
  check(listFits && modalFits, 'The owner filters and list fit 390px and readable result choices fit a 320px dialog');
  await writeFile(path.join(output, 'polls-dev-results.png'), await page.screenshot());
  await page.key('Escape'); await gone();
  check(errors.length === 0 && writes === 0 && blockedWrites === 0 && chatSockets === 0 && ownerHeaders.length > 0 && ownerHeaders.every(Boolean)
    && successfulReads.has('/api/v1/me/polls') && successfulReads.has(detailPath),
    'Every actual poll read carries the captured owner with no writes, chat sockets or runtime errors');
  await writeFile(path.join(output, 'polls-dev-result.json'), JSON.stringify({ origin, developmentStrictMode: true, readOnly: true, dedicatedFixtureCookiesOnly: true,
    results, runtimeErrors: errors, dataChangingRequests: writes, blockedWrites, chatSockets, ownerHeadersMatched: true, complete: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length, dataChangingRequests: writes }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'polls-dev-result.json'), JSON.stringify({ origin, readOnly: true, results, failure: failure.message, runtimeErrors: errors,
    dataChangingRequests: writes, blockedWrites, chatSockets, ownerHeadersMatched: ownerHeaders.length > 0 && ownerHeaders.every(Boolean), complete: false }, null, 2));
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
