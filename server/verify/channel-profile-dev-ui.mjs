// Read-only smoke check for the real development app, including React StrictMode dialog effects.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5366', port = 9497;
const handle = process.env.FRAME_CHANNEL_TEST_HANDLE;
if (!handle || !/^[a-z][a-z0-9_-]{2,23}$/.test(handle)) throw Error('A dedicated public channel fixture handle is required.');
const probe = createServer();
if (!await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); })) throw Error('Dedicated development QA browser port is in use.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-channel-profile-dev-ui-'));
const profile = path.join(directory, 'profile'), output = path.resolve('verification/product');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const results = [], errors = [], writes = [];
let page;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label) {
  await page.evaluate(`(() => {const button=Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing dialog action');button.dataset.devQa='true';button.scrollIntoView({block:'center'});})()`);
  await page.click('[data-dev-qa]'); await page.evaluate(`document.querySelector('[data-dev-qa]')?.removeAttribute('data-dev-qa')`);
}

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 100; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Development QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent' && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(event.params.request.method)) writes.push(event.params.request.method);
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: `${origin}/_frame/channel/${encodeURIComponent(handle)}` });
  await has('[aria-label="채널 정보 더보기"]');
  const fixture = await page.evaluate(`fetch('/api/v1/channels/${encodeURIComponent(handle)}').then(response=>{if(!response.ok)throw Error('Public fixture unavailable');return response.json();}).then(channel=>({id:channel.id,handle:channel.handle}))`);
  if (!fixture.id || !fixture.handle) throw Error('Public channel fixture has no stable identity.');
  const stableUrl = `${origin}/_frame/channel/id/${encodeURIComponent(fixture.id)}`;
  await page.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__devClipboardAttempt=value;throw new DOMException('Denied by verification','NotAllowedError');}}});Object.defineProperty(navigator,'share',{configurable:true,value:async payload=>{window.__devShareAttempt=payload;throw new DOMException('Cancelled by verification','AbortError');}});`);
  await click('[aria-label="채널 정보 더보기"]'); await has('dialog[open]'); await sleep(2000);
  const devSource = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
  check(devSource.includes('StrictMode') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&!!document.querySelector('dialog[open]')&&document.activeElement===document.querySelector('dialog h2')`) && errors.length === 0,
    'Real Vite development StrictMode keeps the details open and heading focused after effect replay');
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Escape closes details');
  check(await page.evaluate(`document.activeElement?.getAttribute('aria-label')==='채널 정보 더보기'`), 'Escape restores focus to the control that opened the dialog');

  await click('[aria-label="채널 공유"]'); await has('[name="channel-share-url"]');
  await click('[aria-label="채널 링크 복사"]');
  await until(() => page.evaluate(`document.querySelector('dialog')?.innerText.includes('링크를 복사하지 못했어요')`), 'Denied clipboard fallback');
  check(await page.evaluate(`(() => {const input=document.querySelector('[name="channel-share-url"]');return input.readOnly&&document.activeElement===input&&input.selectionStart===0&&input.selectionEnd===input.value.length&&input.value===${JSON.stringify(stableUrl)}&&window.__devClipboardAttempt===${JSON.stringify(stableUrl)};})()`),
    'Clipboard denial selects the read-only immutable channel URL for manual copying');
  await click('[aria-label="채널 정보로 돌아가기"]'); await has('dialog h3'); await button('채널 공유');
  check(await page.evaluate(`!!document.querySelector('[name="channel-share-url"]')&&!document.querySelector('dialog [role="alert"]')&&!document.querySelector('dialog [role="status"]')`),
    'Changing share mode clears the previous copy feedback');
  await button('다른 앱으로 공유'); await until(() => page.evaluate(`!!window.__devShareAttempt`), 'Mocked native share'); await sleep(100);
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&!document.querySelector('dialog [role="alert"]')&&!document.querySelector('dialog [role="status"]')&&window.__devShareAttempt.url===${JSON.stringify(stableUrl)}`),
    'Cancelling mocked native sharing keeps the dialog without an error or a fabricated success');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth`) && errors.length === 0 && writes.length === 0,
    'Development share dialog fits 320px without runtime errors or data-changing requests');

  await writeFile(path.join(output, 'channel-profile-dev-result.json'), JSON.stringify({ origin, developmentStrictMode: true, readOnly: true,
    clipboardDeniedMocked: true, nativeSharingCancelledMocked: true, externalOrOsSharing: false, results, runtimeErrors: errors, dataChangingRequests: writes.length, complete: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length, dataChangingRequests: writes.length }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'channel-profile-dev-result.json'), JSON.stringify({ origin, readOnly: true, results, failure: failure.message, runtimeErrors: errors, dataChangingRequests: writes.length, complete: false }, null, 2));
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
