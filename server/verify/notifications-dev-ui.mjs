// Read-only development/StrictMode smoke using the isolated account's already-read report notification.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5366', port = 9501, output = path.resolve('verification/product');
const fixtureDirectory = process.env.FRAME_NOTIFICATION_TEST_DIR;
if (!fixtureDirectory) throw Error('A dedicated private notification fixture directory is required.');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(path.join(fixtureDirectory, 'notifications-checkpoint.json'), 'utf8')); }
catch { throw Error('The private notification fixture checkpoint could not be read.'); }
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (!Array.isArray(checkpoint.cookies) || !checkpoint.cookies.length || !uuid.test(checkpoint.userId) || !uuid.test(checkpoint.notificationId)) throw Error('The private notification fixture checkpoint is incomplete.');
const cookies = checkpoint.cookies.filter(cookie => typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
  .map(cookie => ({ name: cookie.name, value: cookie.value, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' }));
if (!cookies.length || cookies.length !== checkpoint.cookies.length) throw Error('Only the dedicated local fixture cookies may be installed.');
const probe = createServer();
if (!await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); })) throw Error('Dedicated notification development QA browser port is in use.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-notifications-dev-ui-')), profile = path.join(directory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const results = [], errors = [], writes = [], ownerHeaders = [];
let page, blockedWrites = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 100; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Notification development QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params.request;
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) writes.push(request.method);
      if (new URL(request.url).pathname.startsWith('/api/v1/me/notifications')) {
        const owner = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'x-frame-user-id')?.[1];
        ownerHeaders.push(owner === checkpoint.userId);
      }
    }
    if (event.method === 'Fetch.requestPaused') {
      const { requestId, request } = event.params;
      const changing = !['GET', 'HEAD'].includes(request.method);
      if (changing) blockedWrites++;
      void page.send(changing ? 'Fetch.failRequest' : 'Fetch.continueRequest', changing ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(() => {});
    }
  });
  // Prevent an accidental application write from reaching the verification database during this smoke.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/*' }] });
  try { await page.send('Network.setCookies', { cookies }); } catch { throw Error('The dedicated fixture cookies could not be installed.'); }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: origin + '/_frame/notifications' });
  const row = `[data-notification-id="${checkpoint.notificationId}"]`, openButton = row + ' button[aria-label$=" 알림 열기"]';
  await has(openButton); await sleep(2000);
  const fixtureMatches = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json()).then(session=>session.user?.id===${JSON.stringify(checkpoint.userId)})`);
  const devSource = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
  const alreadyRead = await page.evaluate(`document.querySelector(${JSON.stringify(row)}).querySelector('article').dataset.read==='true'`);
  check(fixtureMatches && alreadyRead && devSource.includes('StrictMode') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&document.querySelectorAll('[data-notification-id]').length===1&&!document.querySelector('[role="alert"]')`),
    'Real development StrictMode retains exactly the dedicated account’s one already-read report notification');
  const openerLabel = await page.evaluate(`document.querySelector(${JSON.stringify(openButton)}).getAttribute('aria-label')`);
  await click(openButton); await has('dialog[open]'); await sleep(2000);
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.activeElement===document.querySelector('dialog h2')&&document.querySelector('dialog h2').textContent==='신고 검토 결과'`) && errors.length === 0,
    'The read report result stays open with its heading focused after development effect replay');
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Escape closes notification detail');
  check(await page.evaluate(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(openerLabel)}&&!document.querySelector('.notification-unread-badge')&&document.querySelector('a.notification-link')?.getAttribute('aria-label')==='알림'`),
    'Escape restores the opening control and the zero-unread account has no false badge');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const listFits = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`);
  await click(openButton); await has('dialog[open]');
  check(listFits && await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth`),
    'The notification inbox and personal report result fit a 320px viewport');
  check(errors.length === 0 && writes.length === 0 && blockedWrites === 0 && ownerHeaders.length > 0 && ownerHeaders.every(Boolean),
    'All notification requests keep the captured owner and the smoke performs no writes or runtime errors');
  await writeFile(path.join(output, 'notifications-dev-result.json'), JSON.stringify({ origin, developmentStrictMode: true, dedicatedFixtureCookiesOnly: true,
    readOnly: true, results, runtimeErrors: errors, dataChangingRequests: writes.length, blockedWrites, ownerHeadersMatched: true, complete: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length, dataChangingRequests: writes.length }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'notifications-dev-result.json'), JSON.stringify({ origin, readOnly: true, results, failure: failure.message,
    runtimeErrors: errors, dataChangingRequests: writes.length, blockedWrites, ownerHeadersMatched: ownerHeaders.length > 0 && ownerHeaders.every(Boolean), complete: false }, null, 2));
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
