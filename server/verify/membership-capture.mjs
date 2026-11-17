// Read-only owner recapture after the checkbox CSS fix. Does not run a provider, SDK, signup, plan save or cancellation.
// FRAME_MEMBERSHIP_TEST_DIR must point to the successful private run. Reuses its exact copied JAR and Redis sessions.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, portFree, killByCommandLine, sleep } from './harness.mjs';
import { connect } from '../../tools/cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, 'verification/product');
const directory = resolve(process.env.FRAME_MEMBERSHIP_TEST_DIR ?? ''), parent = resolve(process.env.LOCALAPPDATA, 'Frame/verification');
if (!process.env.FRAME_MEMBERSHIP_TEST_DIR || dirname(directory).toLowerCase() !== parent.toLowerCase() || !/^membership-[a-f0-9]{12}$/.test(directory.split(/[\\/]/).at(-1))) throw Error('Exact successful external membership fixture directory required.');
const fixture = JSON.parse(readFileSync(join(directory, 'membership-checkpoint.json'), 'utf8'));
if (directory.split(/[\\/]/).at(-1) !== 'membership-' + fixture.run) throw Error('Successful checkpoint run guard failed.');
const report = JSON.parse(readFileSync(join(output, 'membership-e2e-result.json'), 'utf8'));
const jar = join(directory, 'frame-api.jar'), jarHash = createHash('sha256').update(readFileSync(jar)).digest('hex');
const backendReport = JSON.parse(readFileSync(join(output, 'membership-backend-result.json'), 'utf8'));
const builtJarHash = createHash('sha256').update(readFileSync(join(root, 'apps/api/build/libs/frame-api.jar'))).digest('hex');
if (!report.complete || !backendReport.complete || jarHash !== report.jarSha256 || jarHash !== backendReport.jarSha256 || jarHash !== builtJarHash) throw Error('The exact successfully verified immutable membership JAR is required.');
const configFile = resolve(process.env.FRAME_PRODUCT_TEST_CONFIG ?? join(process.env.LOCALAPPDATA, 'Frame/product-docker/config.json'));
if (configFile.toLowerCase().startsWith(root.toLowerCase() + '\\')) throw Error('External verification config required.');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.verifyDbUrl === config.dbUrl) throw Error('A separate guarded verification database is required.');
const work = join(directory, 'capture-' + randomBytes(6).toString('hex')); mkdirSync(work, { recursive: true });
const javaHome = join(process.env.LOCALAPPDATA, 'FrameTools/jdk-21.0.13+9'), api = 'http://127.0.0.1:18083', origin = 'http://127.0.0.1:5365';
if (!existsSync(join(javaHome, 'bin/java.exe'))) throw Error('Verification JDK missing.');
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|FRAME_MEMBERSHIP_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = { ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: '18083', RELAY_OBS_ENABLED: 'false', RELAY_DVR: 'false', RELAY_MEDIAMTX_API: 'http://127.0.0.1:29997', RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:29888', RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '', RELAY_RECORD_DIR: '', FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername, FRAME_PRODUCT_DB_PASSWORD: config.dbPassword, FRAME_PRODUCT_REDIS_HOST: config.redisHost, FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword, FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:membership-e2e:${fixture.run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false', FRAME_MEMBERSHIP_TEST_ENABLED: 'false', FRAME_MEMBERSHIP_TEST_CLIENT_KEY: '', FRAME_MEMBERSHIP_TEST_SECRET_KEY: '' };
const results = [], geometry = []; let complete = false, writeAttempts = 0, sdkCalls = 0, runtimeErrors = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label, duration = 30000) { const end = Date.now() + duration; while (Date.now() < end) { if (await test()) return; await sleep(80); } throw Error(label); }
async function ready(url, child) { await until(async () => { if (!child.running) throw Error('Owned capture process exited.'); return (await fetch(url).catch(() => null))?.ok; }, 'Capture service readiness timed out.'); }
async function capture(mode) {
  const port = mode === 'dev' ? 9551 : 9550, profile = join(work, 'browser-' + mode); mkdirSync(profile, { recursive: true });
  const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...clean } });
  let page; const pending = new Set();
  try {
    await until(async () => { try { page = await connect(port, item => !item.url.startsWith('edge://')); return true; } catch { return false; } }, 'Owned capture browser unavailable.');
    await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable'); await page.send('Runtime.addBinding', { name: '__membershipCaptureSdk' });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.TossPayments=()=>{window.__membershipCaptureSdk('called');throw Error('SDK is disabled for read-only capture');};` });
    page.on(event => { if (event.method === 'Runtime.exceptionThrown') runtimeErrors++; if (event.method === 'Runtime.bindingCalled' && event.params.name === '__membershipCaptureSdk') sdkCalls++; if (event.method === 'Fetch.requestPaused') { const work = (async () => { if (!['GET','HEAD'].includes(event.params.request.method)) { writeAttempts++; await page.send('Fetch.failRequest', { requestId: event.params.requestId, errorReason: 'BlockedByClient' }); } else await page.send('Fetch.continueRequest', { requestId: event.params.requestId }); })(); pending.add(work); void work.finally(() => pending.delete(work)); } });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/v1/*', requestStage: 'Request' }] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.send('Network.setCookies', { cookies: fixture.owner.cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' })) });
    await page.send('Page.navigate', { url: origin + '/_frame/studio/members' });
    await until(() => page.evaluate(`document.querySelector('main h1')?.textContent==='멤버십 관리'&&Array.from(document.querySelectorAll('label')).some(label=>label.textContent.trim()==='멤버십 운영'&&!label.querySelector('input')?.disabled)&&!!document.querySelector('[aria-label="멤버십 가입자 목록"]')`), 'Actual saved owner membership page did not finish loading.');
    check(await page.evaluate(`document.body.innerText.includes('월 자동결제 테스트 설정이 완료되지 않았어요.')`), mode + ' capture honestly shows billing disabled with no payment credentials');
    const measured = await page.evaluate(`(()=>{const label=Array.from(document.querySelectorAll('label')).find(item=>item.textContent.trim()==='멤버십 운영');const box=label.querySelector('input').nextElementSibling.getBoundingClientRect(),text=label.children[1].getBoundingClientRect();return{box:{x:box.x,y:box.y,width:box.width,height:box.height},text:{x:text.x,y:text.y,width:text.width,height:text.height},centreDelta:Math.abs(box.y+box.height/2-text.y-text.height/2),gap:text.x-box.right,display:getComputedStyle(label).display};})()`);
    geometry.push({ mode, ...measured }); check(measured.centreDelta <= 2 && measured.gap >= 6 && ['flex','inline-flex'].includes(measured.display), mode + ' custom checkbox box and operating label share the same horizontal row');
    check(await page.evaluate('document.documentElement.scrollWidth<=innerWidth&&!/[?&](authKey|customerKey|paymentKey|billingKey)=/.test(location.search)&&!document.querySelector("dialog[open]")'), mode + ' owner capture has no horizontal overflow, payment callback secrets or dialog');
    await page.evaluate('document.fonts.ready'); await page.evaluate('scrollTo(0,0)');
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }); writeFileSync(join(output, 'membership-' + mode + '-owner-desktop.png'), Buffer.from(screenshot.data, 'base64'));
    await Promise.allSettled([...pending]);
  } finally { if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); } browser.kill(); killByCommandLine(profile); }
}
try {
  for (const port of [18083,5365,9550,9551]) if (!await portFree(port)) throw Error('An owned capture port is occupied: ' + port);
  const spring = start('spring-capture', join(javaHome, 'bin/java.exe'), ['-Xms64m','-Xmx256m','-jar',jar], { cwd: root, env: environment, logDir: work }); await ready(api + '/api/v1/session', spring);
  for (const mode of ['production','dev']) { const args = mode === 'production' ? ['preview','--mode','relay'] : ['--mode','relay']; const web = start('web-capture-' + mode, process.execPath, [join(root,'apps/web/node_modules/vite/bin/vite.js'),...args,'--host','127.0.0.1','--port','5365','--strictPort'], { cwd: join(root,'apps/web'), env: { ...clean, FRAME_RELAY_URL: api }, logDir: work }); await ready(origin + '/_frame/', web); await capture(mode); await stop(web); }
  check(writeAttempts === 0 && sdkCalls === 0 && runtimeErrors === 0, 'Read-only owner recapture makes no API write attempts, billing SDK calls or browser runtime errors');
  check(createHash('sha256').update(readFileSync(jar)).digest('hex') === jarHash, 'Owner recapture reuses the identical immutable functionally tested JAR'); complete = true;
} catch (error) { writeFileSync(join(work,'capture-failure.txt'),error.stack ?? String(error)); console.error(error.message); if (!results.some(item=>item.name===error.message&&!item.pass)) results.push({name:error.message,pass:false}); process.exitCode=1; }
finally { await stopAll(); writeFileSync(join(output,'membership-capture-result.json'),JSON.stringify({complete,readOnly:true,billingConfigured:false,billingUnavailableWarningVisible:true,actualTossTestPgCompleted:false,providerStarted:false,apiWriteAttempts:writeAttempts,sdkCalls,browserRuntimeErrors:runtimeErrors,jarSha256:jarHash,command:'FRAME_MEMBERSHIP_TEST_DIR=<successful-private-run> node server/verify/membership-e2e.mjs --capture-owner',functionalVerification:'Existing 35/18/14 functional JSON results remain from before the narrow checkbox CSS fix; this separate run only verifies final owner layout and replaces its two desktop PNGs.',results,geometry},null,2)); console.log(JSON.stringify({complete,checks:results.length,passed:results.filter(item=>item.pass).length,apiWriteAttempts:writeAttempts,sdkCalls})); }
