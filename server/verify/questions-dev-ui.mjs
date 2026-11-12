// Read-only development/StrictMode smoke of the isolated owner's question editor and poll navigation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5366', port = 9531, output = path.resolve('verification/product');
const fixtureDirectory = process.env.FRAME_QUESTIONS_TEST_DIR;
if (!fixtureDirectory) throw Error('A private isolated question fixture directory is required.');
const relative = path.relative(path.resolve('.'), path.resolve(fixtureDirectory));
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('The question checkpoint must remain outside the repository.');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(path.join(fixtureDirectory, 'questions-checkpoint.json'), 'utf8')); }
catch { throw Error('The private question checkpoint could not be read.'); }
const owner = checkpoint.owner, questionId = checkpoint.answeredQuestionId, uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (!owner || !Array.isArray(owner.cookies) || !owner.cookies.length || !uuid.test(owner.userId ?? '') || !uuid.test(questionId ?? '')) throw Error('The isolated question owner and answered fixture are required.');
const cookies = owner.cookies.filter(cookie => typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
  .map(cookie => ({ name: cookie.name, value: cookie.value, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' }));
if (!cookies.length || cookies.length !== owner.cookies.length) throw Error('Only the dedicated local question owner cookies may be installed.');
const probe = createServer();
if (!await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); })) throw Error('The dedicated question development browser port is in use.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-questions-dev-ui-')), profile = path.join(directory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
await writeFile(path.join(fixtureDirectory, 'browser-dev-owner.json'), JSON.stringify({ pid: browser.pid, profile }));
const results = [], errors = [], ownerHeaders = [], successfulReads = new Set(), successfulQueries = new Set();
let page, writes = 0, blockedWrites = 0, chatSockets = 0;
const detailPath = `/api/v1/me/questions/${questionId}`, rowSelector = `tr[data-question-id="${questionId}"]`;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), 'The question UI appears');
async function button(label, scope = 'document') {
  await page.evaluate(`(() => {const target=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!target)throw Error('Missing question action');target.dataset.devQaTarget='true';target.scrollIntoView({block:'center'});})()`);
  await page.click('[data-dev-qa-target]'); await page.evaluate(`document.querySelector('[data-dev-qa-target]')?.removeAttribute('data-dev-qa-target')`);
}
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function tab(label) {
  await page.evaluate(`(() => {const target=Array.from(document.querySelectorAll('nav[aria-label="투표 및 질문 관리 메뉴"] a')).find(link=>link.textContent.trim()===${JSON.stringify(label)});if(!target)throw Error('Missing participation navigation');target.dataset.devQaTarget='true';target.scrollIntoView({block:'center'});})()`);
  await page.click('[data-dev-qa-target]'); await page.evaluate(`document.querySelector('[data-dev-qa-target]')?.removeAttribute('data-dev-qa-target')`);
  await until(() => page.evaluate(`Array.from(document.querySelectorAll('nav[aria-label="투표 및 질문 관리 메뉴"] a')).some(link=>link.textContent.trim()===${JSON.stringify(label)}&&link.getAttribute('aria-current')==='page')`), 'The participation tab changes');
}
async function viewport(width) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: width < 600 });
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
}
const gone = () => until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'The question editor closes');
async function openEditor() { await has(rowSelector); await click(rowSelector + ' button'); await has('dialog[open] [name="question-answer"]'); }
async function searchQuestion(text) {
  successfulQueries.delete(text); await set('[name="question-query"]', text); await button('검색', 'document.querySelector("form[aria-label=\\"질문 검색\\"]")');
  await until(() => successfulQueries.has(text) && page.evaluate(`new URL(location.href).searchParams.get('q')===${JSON.stringify(text)}&&!!document.querySelector(${JSON.stringify(rowSelector)})`), 'The server search returns the answered question');
}
async function fixtureSnapshot() {
  return page.evaluate(`fetch(${JSON.stringify(detailPath)},{headers:{'X-FRAME-USER-ID':${JSON.stringify(owner.userId)}}}).then(async response=>{if(!response.ok)throw Error('Answered fixture unavailable');const result=await response.json();if(result.userId!==${JSON.stringify(owner.userId)}||result.item?.id!==${JSON.stringify(questionId)}||typeof result.item.answer!=='string')throw Error('Answered fixture mismatch');return {text:result.item.text,answer:result.item.answer,pinned:result.item.pinned,broadcastActive:result.item.broadcastActive,version:result.item.version};})`);
}

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 100; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('The question development browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params.request, pathname = new URL(request.url).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) writes++;
      if (pathname === '/api/v1/me/questions' || pathname.startsWith('/api/v1/me/questions/') || pathname === '/api/v1/me/polls') ownerHeaders.push(Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-frame-user-id')?.[1] === owner.userId);
    }
    if (event.method === 'Network.responseReceived' && event.params.response.status === 200) {
      const url = new URL(event.params.response.url), pathname = url.pathname;
      if (['/api/v1/me/questions', '/api/v1/me/polls', detailPath].includes(pathname)) successfulReads.add(pathname);
      if (pathname === '/api/v1/me/questions') successfulQueries.add(url.searchParams.get('q') ?? '');
    }
    if (event.method === 'Network.webSocketCreated' && new URL(event.params.url).pathname.endsWith('/chat')) chatSockets++;
    if (event.method === 'Fetch.requestPaused') {
      const { requestId, request } = event.params, changing = !['GET', 'HEAD'].includes(request.method);
      if (changing) blockedWrites++;
      void page.send(changing ? 'Fetch.failRequest' : 'Fetch.continueRequest', changing ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
    }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/*' }] });
  try { await page.send('Network.setCookies', { cookies }); } catch { throw Error('The dedicated question owner cookies could not be installed.'); }
  await viewport(1440); await page.send('Page.navigate', { url: origin + '/_frame/studio/polls?tab=questions' });
  await has('table[aria-label="시청자 질문 목록"]'); await sleep(2000);
  const ownerMatches = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json()).then(session=>session.user?.id===${JSON.stringify(owner.userId)})`);
  const source = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
  check(ownerMatches && source.includes('StrictMode') && successfulReads.has('/api/v1/me/questions') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&document.querySelectorAll('#questions-title').length===1&&document.querySelectorAll('table[aria-label="시청자 질문 목록"]').length===1&&!document.querySelector('[role="alert"]')`),
    'Development StrictMode retains one actual owner question list without duplicate UI or errors');

  const original = await fixtureSnapshot();
  // A question may be 500 characters while the management search accepts 120.
  const query = [...(original.text.split(/[\r\n\t]/).find(part => part.trim()) ?? original.text).trim()].slice(0, 50).join('');
  await searchQuestion(query);
  await openEditor(); await sleep(2000);
  const stable = await page.evaluate(`document.querySelectorAll('dialog[open]').length===1&&document.activeElement===document.querySelector('dialog h2')&&document.querySelector('dialog h2').textContent==='질문 답변'&&document.querySelector('[name="question-answer"]').value===${JSON.stringify(original.answer)}&&!document.querySelector('dialog [role="alert"]')`);
  await set('[name="question-answer"]', '저장하지 않는 로컬 답변 초안');
  const pin = await page.evaluate(`({disabled:document.querySelector('[name="question-pinned"]').disabled,checked:document.querySelector('[name="question-pinned"]').checked})`);
  if (!pin.disabled) await click('[name="question-pinned"]');
  await button('변경 취소', 'document.querySelector("dialog[open]")');
  const restored = await page.evaluate(`document.querySelector('[name="question-answer"]').value===${JSON.stringify(original.answer)}&&document.querySelector('[name="question-pinned"]').checked===${JSON.stringify(original.pinned)}`);
  await page.key('Escape'); await gone();
  check(stable && restored && successfulReads.has(detailPath) && await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(rowSelector + ' button')})`),
    'The real detail survives effect replay, cancels a local answer and pin draft, and Escape restores its opener');

  await tab('투표'); await has('[name="poll-status-filter"]'); await until(() => successfulReads.has('/api/v1/me/polls'), 'The existing owner poll list is read');
  const pollTab = await page.evaluate(`!new URL(location.href).searchParams.has('q')&&!new URL(location.href).searchParams.has('status')&&!document.querySelector('[role="alert"]')`);
  await tab('질문'); await has('table[aria-label="시청자 질문 목록"]');
  check(pollTab && await page.evaluate(`new URL(location.href).searchParams.get('tab')==='questions'&&!new URL(location.href).searchParams.has('q')&&document.querySelector('[name="question-query"]').value===''&&!document.querySelector('[role="alert"]')`),
    'Question and existing poll tabs navigate both ways using real owner reads and clear unrelated filters');

  await searchQuestion(query);
  await viewport(390); await page.evaluate('scrollTo(0,0)');
  const listFits = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[name="question-status-filter"]').getBoundingClientRect().width>0`);
  await writeFile(path.join(output, 'questions-dev-list.png'), await page.screenshot());
  await viewport(320); await openEditor();
  const controlsFit = await page.evaluate(`(() => {const dialog=document.querySelector('dialog'),input=document.querySelector('[name="question-pinned"]'),box=input.nextElementSibling,label=input.closest('label'),text=label.lastElementChild,style=getComputedStyle(box),rect=box.getBoundingClientRect(),body=dialog.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&dialog.scrollWidth<=dialog.clientWidth&&getComputedStyle(input).opacity==='0'&&box.getAttribute('aria-hidden')==='true'&&rect.width>=20&&rect.width<=25&&rect.height>=20&&parseFloat(style.borderTopWidth)>0&&text.scrollWidth<=text.clientWidth+1&&text.getBoundingClientRect().right<=body.right&&document.querySelector('[name="question-answer"]').getBoundingClientRect().right<=body.right&&!document.querySelector('dialog [role="alert"]');})()`);
  check(listFits && controlsFit, 'The 390px owner list and 320px answer editor retain readable fields and a styled pin checkbox without overflow');
  await writeFile(path.join(output, 'questions-dev-editor.png'), await page.screenshot());
  await page.key('Escape'); await gone();
  const final = await fixtureSnapshot();
  check(final.text === original.text && final.answer === original.answer && final.version === original.version && (final.pinned === original.pinned || !final.broadcastActive)
    && writes === 0 && blockedWrites === 0 && errors.length === 0 && chatSockets === 0 && ownerHeaders.length > 0 && ownerHeaders.every(Boolean)
    && successfulReads.has('/api/v1/me/questions') && successfulReads.has('/api/v1/me/polls') && successfulReads.has(detailPath),
    'The saved answer and pin remain unchanged; every owner read is guarded with no writes, chat sockets or runtime errors');
  await writeFile(path.join(output, 'questions-dev-result.json'), JSON.stringify({ origin, developmentStrictMode: true, readOnly: true, dedicatedFixtureCookiesOnly: true,
    results, runtimeErrors: errors, dataChangingRequests: writes, blockedWrites, chatSockets, ownerHeadersMatched: true, complete: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length, dataChangingRequests: writes }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'questions-dev-result.json'), JSON.stringify({ origin, readOnly: true, results, failure: failure.message, runtimeErrors: errors,
    dataChangingRequests: writes, blockedWrites, chatSockets, ownerHeadersMatched: ownerHeaders.length > 0 && ownerHeaders.every(Boolean), complete: false }, null, 2));
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
