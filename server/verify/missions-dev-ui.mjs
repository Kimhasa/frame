// Read-only development/StrictMode smoke using the owning mission harness's private fixture.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5366', port = 9551, output = path.resolve('verification/product');
const fixtureDirectory = process.env.FRAME_MISSIONS_TEST_DIR;
if (!fixtureDirectory) throw Error('A private isolated mission fixture directory is required.');
const relative = path.relative(path.resolve('.'), path.resolve(fixtureDirectory));
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('The mission checkpoint must remain outside the repository.');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(path.join(fixtureDirectory, 'missions-checkpoint.json'), 'utf8')); }
catch { throw Error('The private mission checkpoint could not be read.'); }
const owner = checkpoint.owner, missionId = checkpoint.editableMissionId ?? checkpoint.missionId, terminalId = checkpoint.terminalMissionId, terminalReason = checkpoint.terminalReason, uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (!owner || !Array.isArray(owner.cookies) || !owner.cookies.length || !uuid.test(owner.userId ?? '') || !uuid.test(missionId ?? '') || !uuid.test(terminalId ?? '') || typeof terminalReason !== 'string' || !terminalReason) throw Error('The isolated owner and editable/terminal mission fixtures are required.');
const cookies = owner.cookies.filter(cookie => typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
  .map(cookie => ({ name: cookie.name, value: cookie.value, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' }));
if (!cookies.length || cookies.length !== owner.cookies.length) throw Error('Only the dedicated local mission owner cookies may be installed.');
const probe = createServer();
if (!await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); })) throw Error('The dedicated mission development browser port is in use.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-missions-dev-ui-')), profile = path.join(directory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
await writeFile(path.join(fixtureDirectory, 'browser-dev-owner.json'), JSON.stringify({ pid: browser.pid, profile }));
const results = [], errors = [], ownerHeaders = [], reads = new Set(), listReads = new Set();
const tabs = [{ label: '접수', tab: 'received', status: 'received' }, { label: '진행 중', tab: 'running', status: 'running' }, { label: '완료', tab: 'completed', status: 'completed' },
  { label: '거절', tab: 'rejected', status: 'rejected' }, { label: '취소', tab: 'cancelled', status: 'canceled' }, { label: '기한 만료', tab: 'expired', status: 'expired' }, { label: '실패', tab: 'failed', status: 'failed' }];
const detailPath = `/api/v1/me/missions/${missionId}`, rowSelector = `tr[data-mission-id="${missionId}"]`;
let page, writes = 0, blockedWrites = 0, chatSockets = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), 'The mission UI appears');
async function click(selector) {
  await until(() => page.evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});return !!element&&!element.matches(':disabled');})()`), 'The mission control is enabled');
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`);
  await until(() => page.evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.matches(':disabled'))return false;const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button,a')===element;})()`), 'The mission control is clickable');
  await page.click(selector);
}
async function button(label, scope = 'document') {
  await page.evaluate(`(() => {const target=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!target)throw Error('Missing mission action');target.dataset.devQaTarget='true';})()`);
  await click('[data-dev-qa-target]'); await page.evaluate(`document.querySelector('[data-dev-qa-target]')?.removeAttribute('data-dev-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing mission input');const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function viewport(width) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: width < 600 }); await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`); }
async function tab(target, query = '') {
  listReads.delete(`${target.status}|${query}`);
  await page.evaluate(`(() => {const target=Array.from(document.querySelectorAll('nav[aria-label="미션 상태"] a')).find(link=>link.textContent.trim()===${JSON.stringify(target.label)});if(!target)throw Error('Missing mission status tab');target.dataset.devQaTarget='true';})()`);
  await click('[data-dev-qa-target]'); await page.evaluate(`document.querySelector('[data-dev-qa-target]')?.removeAttribute('data-dev-qa-target')`);
  await until(() => listReads.has(`${target.status}|${query}`) && page.evaluate(`new URLSearchParams(location.search).get('tab')===${JSON.stringify(target.tab)}&&Array.from(document.querySelectorAll('nav[aria-label="미션 상태"] a')).some(link=>link.textContent.trim()===${JSON.stringify(target.label)}&&link.getAttribute('aria-current')==='page')&&!document.querySelector('[role="alert"]')`), 'The actual mission status list is loaded');
}
async function fixtureSnapshot(id = missionId) {
  return page.evaluate(`fetch(${JSON.stringify('/api/v1/me/missions/' + id)},{headers:{'X-FRAME-USER-ID':${JSON.stringify(owner.userId)}}}).then(async response=>{if(!response.ok)throw Error('Mission fixture unavailable');const result=await response.json();if(result.userId!==${JSON.stringify(owner.userId)}||result.item?.id!==${JSON.stringify(id)})throw Error('Mission fixture mismatch');return result.item;})`);
}
async function searchMission(text, status, id = missionId) {
  listReads.delete(`${status}|${text}`); await set('[name="mission-query"]', text); await button('검색', 'document.querySelector("[name=mission-query]").form');
  await until(() => listReads.has(`${status}|${text}`) && page.evaluate(`new URLSearchParams(location.search).get('q')===${JSON.stringify(text)}&&!!document.querySelector(${JSON.stringify('tr[data-mission-id="' + id + '"]')})&&!document.querySelector('button[aria-label="미션 목록 새로고침"]')?.disabled`), 'The real searched mission appears after its response');
}
async function openEditor() { await has(rowSelector); await click(rowSelector + ' button'); await has('dialog[open] [name="mission-reason"]'); }
const gone = () => until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'The mission editor closes');

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 100; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('The mission development browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params.request, pathname = new URL(request.url).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) writes++;
      if (pathname === '/api/v1/me/missions' || pathname.startsWith('/api/v1/me/missions/')) ownerHeaders.push(Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-frame-user-id')?.[1] === owner.userId);
    }
    if (event.method === 'Network.responseReceived' && event.params.response.status === 200) {
      const url = new URL(event.params.response.url); if (url.pathname === '/api/v1/me/missions' || url.pathname.startsWith('/api/v1/me/missions/')) reads.add(url.pathname);
      if (url.pathname === '/api/v1/me/missions') listReads.add(`${url.searchParams.get('status') ?? 'all'}|${url.searchParams.get('q') ?? ''}`);
    }
    if (event.method === 'Network.webSocketCreated' && new URL(event.params.url).pathname.endsWith('/chat')) chatSockets++;
    if (event.method === 'Fetch.requestPaused') { const { requestId, request } = event.params, changing = !['GET', 'HEAD'].includes(request.method); if (changing) blockedWrites++; void page.send(changing ? 'Fetch.failRequest' : 'Fetch.continueRequest', changing ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {}); }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/*' }] });
  try { await page.send('Network.setCookies', { cookies }); } catch { throw Error('The dedicated mission owner cookies could not be installed.'); }
  await viewport(1440); await page.send('Page.navigate', { url: origin + '/_frame/studio/missions' }); await has('#missions-title');
  await until(() => reads.has('/api/v1/me/missions'), 'The first actual owner mission list'); await sleep(2000);
  const sessionMatches = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json()).then(session=>session.user?.id===${JSON.stringify(owner.userId)})`), source = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
  check(sessionMatches && source.includes('StrictMode') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&document.querySelectorAll('#missions-title').length===1&&document.querySelectorAll('nav[aria-label="미션 상태"] a').length===7&&!document.querySelector('[role="alert"]')`),
    'Development StrictMode retains one actual owner mission page and seven status tabs without runtime errors');

  const original = await fixtureSnapshot(), terminalOriginal = await fixtureSnapshot(terminalId);
  if (!['received', 'running'].includes(original.status) || !original.broadcastActive) throw Error('The development fixture must remain an editable mission in the current broadcast.');
  if (terminalOriginal.status !== 'completed' || terminalOriginal.history.length !== 3 || terminalOriginal.reason !== terminalReason) throw Error('The completed mission fixture must contain its three real history entries and saved reason.');
  const originalTab = tabs.find(item => item.status === original.status), query = [...original.title].slice(0, 60).join('');
  if (original.status !== 'received') await tab(originalTab); await searchMission(query, original.status);
  await openEditor(); await sleep(2000);
  const initialStatus = original.status === 'received' ? 'running' : 'completed';
  const stable = await page.evaluate(`document.querySelectorAll('dialog[open]').length===1&&document.activeElement===document.querySelector('dialog h2')&&document.querySelector('dialog h2').textContent==='미션 상세'&&document.querySelector('[name="mission-status"]').value===${JSON.stringify(initialStatus)}&&document.querySelector('[name="mission-reason"]').value===''&&!document.querySelector('dialog [role="alert"]')`);
  await set('[name="mission-status"]', original.status === 'received' ? 'rejected' : 'failed'); await set('[name="mission-reason"]', '저장하지 않는 로컬 미션 처리 사유'); await page.key('Escape'); await gone();
  const focused = await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(rowSelector + ' button')})`);
  await openEditor(); const restored = await page.evaluate(`document.querySelector('[name="mission-status"]').value===${JSON.stringify(initialStatus)}&&document.querySelector('[name="mission-reason"]').value===''`); await page.key('Escape'); await gone();
  check(stable && focused && restored && reads.has(detailPath), 'The real mission editor survives effect replay, discards a local status and reason draft, and Escape restores its opener');

  await button('초기화', 'document.querySelector("[name=mission-query]").form'); await until(() => page.evaluate(`!new URLSearchParams(location.search).has('q')`), 'The local mission search resets');
  for (const target of tabs.filter(value => value.status !== original.status)) await tab(target);
  await tab(tabs.find(target => target.status === 'completed')); await searchMission([...terminalOriginal.title].slice(0, 60).join(''), 'completed', terminalId); await click(`tr[data-mission-id="${terminalId}"] button`); await has(`dialog[open][data-mission-id="${terminalId}"] [aria-label="미션 상태 변경 이력"] li`); await sleep(2000);
  const terminalReadOnly = await page.evaluate(`(() => {const dialog=document.querySelector('dialog[open]');return !!dialog&&dialog.querySelectorAll('[aria-label="미션 상태 변경 이력"] li').length===3&&dialog.innerText.includes(${JSON.stringify(terminalReason)})&&!dialog.querySelector('form,textarea,select')&&!dialog.querySelector('[role="alert"]');})()`); await page.key('Escape'); await gone();
  await button('초기화', 'document.querySelector("[name=mission-query]").form'); await until(() => page.evaluate(`!new URLSearchParams(location.search).has('q')`), 'The completed mission search resets'); await tab(originalTab);
  check(terminalReadOnly && tabs.every(target => listReads.has(`${target.status}|`)) && await page.evaluate(`document.querySelectorAll('nav[aria-label="미션 상태"] a').length===7&&!document.querySelector('[role="alert"]')`),
    'All seven status tabs read actual owner data; the legacy canceled mapping and completed three-entry history remain read-only');

  await searchMission(query, original.status); await viewport(390); await page.evaluate('scrollTo(0,0)');
  const listFits = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[name="mission-query"]').getBoundingClientRect().width>0`); await writeFile(path.join(output, 'missions-dev-list.png'), await page.screenshot());
  await viewport(320); await openEditor();
  const editorFits = await page.evaluate(`(() => {const dialog=document.querySelector('dialog'),bounds=dialog.getBoundingClientRect(),fields=Array.from(dialog.querySelectorAll('input,select,textarea'));return document.documentElement.scrollWidth<=innerWidth&&dialog.scrollWidth<=dialog.clientWidth+1&&bounds.left>=-1&&bounds.right<=innerWidth+1&&fields.every(field=>{const r=field.getBoundingClientRect();return r.left>=bounds.left&&r.right<=bounds.right&&parseFloat(getComputedStyle(field).fontSize)>=16;})&&dialog.querySelectorAll('[aria-label="미션 상태 변경 이력"] li').length===${original.history.length}&&!dialog.querySelector('[role="alert"]');})()`);
  check(listFits && editorFits, 'The 390px mission list and 320px status editor retain readable controls and complete server history without horizontal overflow');
  await writeFile(path.join(output, 'missions-dev-editor.png'), await page.screenshot()); await page.key('Escape'); await gone();

  const final = await fixtureSnapshot(), terminalFinal = await fixtureSnapshot(terminalId);
  check(JSON.stringify(final) === JSON.stringify(original) && JSON.stringify(terminalFinal) === JSON.stringify(terminalOriginal) && writes === 0 && blockedWrites === 0 && errors.length === 0 && chatSockets === 0 && ownerHeaders.length > 0 && ownerHeaders.every(Boolean)
    && reads.has('/api/v1/me/missions') && reads.has(detailPath), 'The saved mission and history remain unchanged; every owner read is guarded with no writes, chat sockets or runtime errors');
  await writeFile(path.join(output, 'missions-dev-result.json'), JSON.stringify({ origin, developmentStrictMode: true, readOnly: true, dedicatedFixtureCookiesOnly: true, results, runtimeErrors: errors,
    dataChangingRequests: writes, blockedWrites, chatSockets, ownerHeadersMatched: true, complete: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(item => item.pass).length, runtimeErrors: errors.length, dataChangingRequests: writes }));
} catch (failure) {
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'missions-dev-result.json'), JSON.stringify({ origin, readOnly: true, results, failure: failure.message, runtimeErrors: errors,
    dataChangingRequests: writes, blockedWrites, chatSockets, ownerHeadersMatched: ownerHeaders.length > 0 && ownerHeaders.every(Boolean), complete: false }, null, 2));
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill(); const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
