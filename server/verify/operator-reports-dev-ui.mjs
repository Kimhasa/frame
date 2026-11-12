// Read-only development/StrictMode smoke using only the isolated operator fixture's private cookies.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const origin = 'http://127.0.0.1:5366', port = 9499, output = path.resolve('verification/product');
const fixtureDirectory = process.env.FRAME_OPERATOR_TEST_DIR;
if (!fixtureDirectory) throw Error('A dedicated private operator fixture directory is required.');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(path.join(fixtureDirectory, 'operator-reports-checkpoint.json'), 'utf8')); }
catch { throw Error('The private operator fixture checkpoint could not be read.'); }
if (!Array.isArray(checkpoint.cookies) || !checkpoint.cookies.length || typeof checkpoint.operatorId !== 'string'
  || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(checkpoint.operatorId)
  || typeof checkpoint.query !== 'string' || checkpoint.query.length > 120) throw Error('The private operator fixture checkpoint is incomplete.');
const cookies = checkpoint.cookies.filter(cookie => typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
  .map(cookie => ({ name: cookie.name, value: cookie.value, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' }));
if (!cookies.length || cookies.length !== checkpoint.cookies.length) throw Error('Only the dedicated local fixture cookies may be installed.');
const probe = createServer();
if (!await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))); })) throw Error('Dedicated operator development QA browser port is in use.');
const directory = await mkdtemp(path.join(tmpdir(), 'frame-operator-reports-dev-ui-')), profile = path.join(directory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const results = [], errors = [], writes = [];
let page;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 150; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
async function click(selector) { await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 100; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Operator development QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent' && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(event.params.request.method)) writes.push(event.params.request.method);
  });
  try { await page.send('Network.setCookies', { cookies }); } catch { throw Error('The dedicated fixture cookies could not be installed.'); }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const query = new URLSearchParams({ q: checkpoint.query });
  await page.send('Page.navigate', { url: `${origin}/_frame/admin/reports?${query}` });
  const detailButton = 'table tbody button[aria-label$=" 상세 보기"]';
  await has(detailButton);
  const fixtureMatches = await page.evaluate(`fetch('/api/v1/session').then(response=>response.json()).then(session=>session.user?.isOperator===true&&session.user.id===${JSON.stringify(checkpoint.operatorId)})`);
  const devSource = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
  check(fixtureMatches && devSource.includes('StrictMode') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&!!document.querySelector('table tbody tr')`),
    'The dedicated operator session opens the real development StrictMode report list');
  const openerLabel = await page.evaluate(`document.querySelector(${JSON.stringify(detailButton)}).getAttribute('aria-label')`);
  await click(detailButton); await has('dialog[open] [aria-label="접수된 신고 내용"]'); await sleep(2000);
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.activeElement===document.querySelector('dialog h2')`) && errors.length === 0,
    'Development effect replay keeps the loaded report dialog open and its heading focused');
  await page.key('Escape'); await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Escape closes report dialog');
  check(await page.evaluate(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(openerLabel)}`), 'Escape restores focus to the report row action');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const listFits = await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`);
  await click(detailButton); await has('dialog[open] [aria-label="접수된 신고 내용"]');
  check(listFits && await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth`),
    'The development operator list and report dialog fit a 320px viewport');
  check(errors.length === 0 && writes.length === 0, 'Read-only operator smoke produces no runtime errors or data-changing requests');
  await writeFile(path.join(output, 'operator-reports-dev-result.json'), JSON.stringify({ origin, developmentStrictMode: true, dedicatedFixtureCookiesOnly: true,
    readOnly: true, results, runtimeErrors: errors, dataChangingRequests: writes.length, complete: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length, dataChangingRequests: writes.length }));
} catch (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'operator-reports-dev-result.json'), JSON.stringify({ origin, readOnly: true, results, failure: failure.message, runtimeErrors: errors, dataChangingRequests: writes.length, complete: false }, null, 2));
  throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
