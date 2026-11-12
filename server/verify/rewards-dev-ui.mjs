// Read-only development/StrictMode smoke of the isolated owner's reward editor and terminal request.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5366', port = 9541, output = path.resolve('verification/product');
const fixtureDirectory = process.env.FRAME_REWARDS_TEST_DIR;
if (!fixtureDirectory) throw Error('A private isolated reward fixture directory is required.');
const relative = path.relative(path.resolve('.'), path.resolve(fixtureDirectory));
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('The reward checkpoint must remain outside the repository.');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(path.join(fixtureDirectory, 'rewards-checkpoint.json'), 'utf8')); }
catch { throw Error('The private reward checkpoint could not be read.'); }
const { owner, rewardId, redemptionId } = checkpoint, uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (!owner || !Array.isArray(owner.cookies) || !owner.cookies.length || !uuid.test(owner.userId ?? '') || !uuid.test(rewardId ?? '') || !uuid.test(redemptionId ?? '')) throw Error('The isolated reward owner and record fixtures are required.');
const cookies = owner.cookies.filter(cookie => typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
  .map(cookie => ({ name: cookie.name, value: cookie.value, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' }));
if (!cookies.length || cookies.length !== owner.cookies.length) throw Error('Only the dedicated local reward owner cookies may be installed.');
const probe = createServer();
if (!await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); })) throw Error('The dedicated reward development browser port is in use.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-rewards-dev-ui-')), profile = path.join(directory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
await writeFile(path.join(fixtureDirectory, 'browser-dev-owner.json'), JSON.stringify({ pid: browser.pid, profile }));
const results = [], errors = [], ownerHeaders = [], successfulReads = new Set(), queryResponses = new Set();
const rewardPath = `/api/v1/me/rewards/${rewardId}`, redemptionPath = `/api/v1/me/redemptions/${redemptionId}`;
const rewardRow = `tr[data-reward-id="${rewardId}"]`, redemptionRow = `tr[data-redemption-id="${redemptionId}"]`;
let page, writes = 0, blockedWrites = 0, chatSockets = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), 'The reward UI appears');
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label, scope = 'document') {
  await until(() => page.evaluate(`Array.from(${scope}.querySelectorAll('button')).some(button=>button.textContent.trim()===${JSON.stringify(label)}&&!button.matches(':disabled'))`), 'The reward action is enabled');
  await page.evaluate(`(() => {const target=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});target.dataset.devQaTarget='true';target.scrollIntoView({block:'center'});})()`);
  await page.click('[data-dev-qa-target]'); await page.evaluate(`document.querySelector('[data-dev-qa-target]')?.removeAttribute('data-dev-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function tab(label) {
  await page.evaluate(`(() => {const target=Array.from(document.querySelectorAll('nav[aria-label="포인트 및 보상 메뉴"] a')).find(link=>link.textContent.trim()===${JSON.stringify(label)});if(!target)throw Error('Missing reward navigation');target.dataset.devQaTarget='true';target.scrollIntoView({block:'center'});})()`);
  await page.click('[data-dev-qa-target]'); await page.evaluate(`document.querySelector('[data-dev-qa-target]')?.removeAttribute('data-dev-qa-target')`);
  await until(() => page.evaluate(`Array.from(document.querySelectorAll('nav[aria-label="포인트 및 보상 메뉴"] a')).some(link=>link.textContent.trim()===${JSON.stringify(label)}&&link.getAttribute('aria-current')==='page')`), 'The reward tab changes');
}
async function search(text, kind) {
  const key = `${kind}/${text}`; queryResponses.delete(key); await set('[name="reward-query"]', text); await button('검색', 'document.querySelector("form[aria-label=\\"보상 및 교환 요청 검색\\"]")');
  await until(() => queryResponses.has(key) && page.evaluate(`new URL(location.href).searchParams.get('q')===${JSON.stringify(text)}&&!!document.querySelector(${JSON.stringify(kind === 'rewards' ? rewardRow : redemptionRow)})`), 'The real server search returns the exact fixture');
}
async function viewport(width) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: width < 600 });
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
}
const gone = () => until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'The reward dialog closes');
async function snapshot(endpoint, kind) {
  return page.evaluate(`fetch(${JSON.stringify(endpoint)},{headers:{'X-FRAME-USER-ID':${JSON.stringify(owner.userId)}}}).then(async response=>{if(!response.ok)throw Error('Reward fixture unavailable');const result=await response.json();if(result.userId!==${JSON.stringify(owner.userId)})throw Error('Reward fixture owner mismatch');const item=result.item;return ${kind === 'reward' ? `{id:item.id,name:item.name,points:item.points,limit:item.limit,enabled:item.enabled,version:item.version}` : `{id:item.id,rewardName:item.rewardName,status:item.status,reason:item.reason,version:item.version}`};})`);
}

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 100; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('The reward development browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params.request, pathname = new URL(request.url).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) writes++;
      if (/^\/api\/v1\/me\/(rewards|redemptions)(\/|$)/.test(pathname)) ownerHeaders.push(Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-frame-user-id')?.[1] === owner.userId);
    }
    if (event.method === 'Network.responseReceived' && event.params.response.status === 200) {
      const url = new URL(event.params.response.url), pathname = url.pathname;
      if (['/api/v1/me/rewards', '/api/v1/me/redemptions', rewardPath, redemptionPath].includes(pathname)) successfulReads.add(pathname);
      if (pathname === '/api/v1/me/rewards') queryResponses.add(`rewards/${url.searchParams.get('q') ?? ''}`);
      if (pathname === '/api/v1/me/redemptions') queryResponses.add(`redemptions/${url.searchParams.get('q') ?? ''}`);
    }
    if (event.method === 'Network.webSocketCreated' && new URL(event.params.url).pathname.endsWith('/chat')) chatSockets++;
    if (event.method === 'Fetch.requestPaused') {
      const { requestId, request } = event.params, changing = !['GET', 'HEAD'].includes(request.method);
      if (changing) blockedWrites++;
      void page.send(changing ? 'Fetch.failRequest' : 'Fetch.continueRequest', changing ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
    }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/*' }] });
  try { await page.send('Network.setCookies', { cookies }); } catch { throw Error('The dedicated reward owner cookies could not be installed.'); }
  await viewport(1440); await page.send('Page.navigate', { url: origin + '/_frame/studio/rewards' }); await has('table[aria-label="보상 목록"]'); await sleep(2000);
  const ownerMatches = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json()).then(session=>session.user?.id===${JSON.stringify(owner.userId)})`);
  const source = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
  check(ownerMatches && source.includes('StrictMode') && successfulReads.has('/api/v1/me/rewards') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&document.querySelectorAll('#rewards-title').length===1&&document.querySelectorAll('table[aria-label="보상 목록"]').length===1&&!document.querySelector('[role="alert"]')`),
    'Development StrictMode retains one actual owner reward list without duplicate UI or errors');

  const original = await snapshot(rewardPath, 'reward'), requestOriginal = await snapshot(redemptionPath, 'redemption');
  if (original.id !== rewardId || requestOriginal.id !== redemptionId || requestOriginal.status !== 'rejected') throw Error('The dedicated reward fixtures do not match the checkpoint.');
  await search(original.name, 'rewards'); await click(rewardRow + ' button'); await has('dialog[open] [name="reward-name"]'); await sleep(2000);
  const stable = await page.evaluate(`document.querySelectorAll('dialog[open]').length===1&&document.activeElement===document.querySelector('dialog h2')&&document.querySelector('dialog h2').textContent==='보상 수정'&&document.querySelector('[name="reward-name"]').value===${JSON.stringify(original.name)}&&!document.querySelector('dialog [role="alert"]')`);
  await set('[name="reward-name"]', '저장하지 않는 로컬 보상'); await set('[name="reward-points"]', '999'); await click('[name="reward-enabled"]');
  await button('닫기', 'document.querySelector("dialog[open]")'); await gone();
  const closeFocus = await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(rewardRow + ' button')})`);
  await click(rewardRow + ' button'); await has('dialog[open] [name="reward-name"]');
  const restored = await page.evaluate(`document.querySelector('[name="reward-name"]').value===${JSON.stringify(original.name)}&&document.querySelector('[name="reward-points"]').value===${JSON.stringify(String(original.points))}&&document.querySelector('[name="reward-enabled"]').checked===${JSON.stringify(original.enabled)}`);
  await page.key('Escape'); await gone();
  check(stable && closeFocus && restored && await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(rewardRow + ' button')})`),
    'The editor survives effect replay and discards local name, points and enabled drafts on Close and Escape');

  await tab('교환 요청'); await has('table[aria-label="보상 교환 요청 목록"]'); await search(requestOriginal.rewardName, 'redemptions');
  await click(redemptionRow + ' button'); await has('dialog[open]'); await until(() => page.evaluate(`!!document.querySelector('dialog dl')`), 'The real terminal request detail loads'); await sleep(2000);
  const terminal = await page.evaluate(`document.querySelectorAll('dialog[open]').length===1&&document.querySelector('dialog h2').textContent==='교환 요청'&&document.activeElement===document.querySelector('dialog h2')&&!document.querySelector('dialog form')&&!document.querySelector('[name="redemption-reason"]')&&document.querySelector('dialog').innerText.includes(${JSON.stringify(requestOriginal.reason)})&&document.querySelector('dialog').innerText.includes('거절')&&!document.querySelector('dialog [role="alert"]')`);
  await page.key('Escape'); await gone();
  check(terminal && successfulReads.has(redemptionPath) && await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(redemptionRow + ' button')})`),
    'The rejected request shows its actual reason read-only and restores its opener without a processing form');

  await tab('보상 설정'); await has('table[aria-label="보상 목록"]'); await search(original.name, 'rewards'); await viewport(390); await page.evaluate('scrollTo(0,0)');
  const listFits = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[name="reward-status-filter"]').getBoundingClientRect().width>0`);
  await writeFile(path.join(output, 'rewards-dev-list.png'), await page.screenshot());
  await viewport(320); await click(rewardRow + ' button'); await has('dialog[open] [name="reward-name"]');
  const editorFits = await page.evaluate(`(() => {const dialog=document.querySelector('dialog'),input=document.querySelector('[name="reward-enabled"]'),box=input.nextElementSibling,label=input.closest('label'),text=label.lastElementChild,style=getComputedStyle(box),rect=box.getBoundingClientRect(),body=dialog.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&dialog.scrollWidth<=dialog.clientWidth&&getComputedStyle(input).opacity==='0'&&box.getAttribute('aria-hidden')==='true'&&rect.width>=20&&rect.width<=25&&rect.height>=20&&parseFloat(style.borderTopWidth)>0&&text.scrollWidth<=text.clientWidth+1&&text.getBoundingClientRect().right<=body.right&&Array.from(dialog.querySelectorAll('input,select')).every(control=>control.getBoundingClientRect().right<=body.right)&&!dialog.querySelector('[role="alert"]');})()`);
  check(listFits && editorFits, 'The 390px list and 320px editor retain readable fields and a styled enabled checkbox without overflow');
  await writeFile(path.join(output, 'rewards-dev-editor.png'), await page.screenshot()); await page.key('Escape'); await gone();
  const final = await snapshot(rewardPath, 'reward'), requestFinal = await snapshot(redemptionPath, 'redemption');
  check(JSON.stringify(final) === JSON.stringify(original) && JSON.stringify(requestFinal) === JSON.stringify(requestOriginal) && writes === 0 && blockedWrites === 0 && errors.length === 0 && chatSockets === 0 && ownerHeaders.length > 0 && ownerHeaders.every(Boolean)
    && ['/api/v1/me/rewards', '/api/v1/me/redemptions', rewardPath, redemptionPath].every(value => successfulReads.has(value)),
    'Saved rewards and terminal processing remain unchanged with guarded owner reads and zero writes or runtime errors');
  await writeFile(path.join(output, 'rewards-dev-result.json'), JSON.stringify({ origin, developmentStrictMode: true, readOnly: true, dedicatedFixtureCookiesOnly: true, results,
    runtimeErrors: errors, dataChangingRequests: writes, blockedWrites, chatSockets, ownerHeadersMatched: true, complete: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length, dataChangingRequests: writes }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'rewards-dev-result.json'), JSON.stringify({ origin, readOnly: true, results, failure: failure.message, runtimeErrors: errors,
    dataChangingRequests: writes, blockedWrites, chatSockets, ownerHeadersMatched: ownerHeaders.length > 0 && ownerHeaders.every(Boolean), complete: false }, null, 2)); throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill(); const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
