// Read-only browser verification of actual analytics; account cookies and browser ownership stay private.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';

const dev = process.env.FRAME_ANALYTICS_DEV_SMOKE === '1', origin = `http://127.0.0.1:${dev ? 5366 : 5365}`, port = dev ? 9551 : 9550, output = path.resolve('verification/product');
const directory = path.resolve(process.env.FRAME_ANALYTICS_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_ANALYTICS_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('Private external analytics fixtures are required.');
const checkpoint = JSON.parse(await readFile(path.join(directory, 'analytics-checkpoint.json'), 'utf8'));
if (!/^obs-analytics-[0-9a-f]{12}$/.test(checkpoint.path) || !Array.isArray(checkpoint.owner?.cookies) || !Array.isArray(checkpoint.other?.cookies)) throw Error('Dedicated analytics fixture accounts are required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), dev ? 'frame-analytics-dev-ui-' : 'frame-analytics-ui-')), profile = path.join(browserDirectory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
await writeFile(path.join(directory, dev ? 'browser-dev-owner.json' : 'browser-owner.json'), JSON.stringify({ pid: browser.pid, profile }));
const results = [], runtimeErrors = [], privateHeaders = [], requests = [], pending = new Set(), canceled = new Set(), intercepted = new Map();
let page, failure = null, pageLimit = !dev, writes = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(fn, label) { for (let i = 0; i < 150; i++) { if (await fn()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const text = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
async function navigate() {
  const marker = String(Date.now()); await page.evaluate(`window.__analyticsDocument=${JSON.stringify(marker)}`);
  await page.send('Page.navigate', { url: origin + '/_frame/studio/analytics' });
  await until(async () => { try { return await page.evaluate(`window.__analyticsDocument!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'Analytics document');
}
async function set(selector, value) { await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing analytics control');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function click(selector) {
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control ' + selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector);
}
async function button(label) {
  await until(() => page.evaluate(`Array.from(document.querySelectorAll('main button')).some(element=>element.textContent.trim()===${JSON.stringify(label)}&&!element.matches(':disabled'))`), 'Enabled button ' + label);
  await page.evaluate(`(() => {const button=Array.from(document.querySelectorAll('main button')).find(element=>element.textContent.trim()===${JSON.stringify(label)});button.dataset.analyticsQaTarget='true';button.scrollIntoView({block:'center'});})()`);
  await page.click('[data-analytics-qa-target]'); await page.evaluate(`document.querySelector('[data-analytics-qa-target]')?.removeAttribute('data-analytics-qa-target')`);
}
async function cookies(saved) { await page.send('Network.clearBrowserCookies'); await page.send('Network.setCookies', { cookies: saved.cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' })) }); }
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await page.evaluate('scrollTo(0,0)'); await writeFile(path.join(output, name), await page.screenshot()); }
async function command(method, parameters) {
  const request = intercepted.get(parameters.requestId);
  try { return await page.send(method, parameters); }
  catch (problem) {
    if (/Invalid InterceptionId/.test(problem.message) && request?.networkId) { await sleep(150); if (canceled.has(request.networkId)) return; }
    throw Error(`Analytics interception failed for ${request?.method ?? 'unknown'} request: ${problem.message}`);
  } finally { intercepted.delete(parameters.requestId); }
}
async function intercept(event) {
  const { requestId, request, networkId } = event.params, url = new URL(request.url);
  intercepted.set(requestId, { networkId, method: request.method });
  if (request.method !== 'GET') writes++;
  privateHeaders.push(Object.keys(request.headers).some(key => key.toLowerCase() === 'x-frame-user-id'));
  requests.push({ period: url.searchParams.get('period'), cursor: url.searchParams.has('cursor'), q: url.searchParams.get('q') ?? '' });
  if (failure && (!failure.cursor || url.searchParams.has('cursor'))) {
    const active = failure; failure = null;
    await command('Fetch.fulfillRequest', { requestId, responseCode: active.status ?? 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(JSON.stringify({ code: active.code ?? 'PRODUCT_UNAVAILABLE', detail: active.detail })).toString('base64') }); return;
  }
  if (pageLimit) { url.searchParams.set('limit', '1'); await command('Fetch.continueRequest', { requestId, url: url.href }); }
  else await command('Fetch.continueRequest', { requestId });
}
try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 70; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Analytics QA browser unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') runtimeErrors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.loadingFailed' && event.params.canceled) canceled.add(event.params.requestId);
    if (event.method === 'Fetch.requestPaused') { const work = intercept(event).catch(problem => runtimeErrors.push(problem.message)); pending.add(work); void work.finally(() => pending.delete(work)); }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/v1/me/analytics*', requestStage: 'Request' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cookies(checkpoint.owner);
  if (!dev) failure = { detail: '방송 통계 첫 연결을 확인하지 못했어요.' };
  await navigate(); await has('main h1');
  if (!dev) { await text('방송 통계 첫 연결을 확인하지 못했어요.'); check(await page.evaluate(`!document.querySelector('tr[data-analytics-id]')`), 'An initial analytics failure has a retry state without fabricated zero statistics'); await button('통계 다시 시도'); }
  await has(`tr[data-analytics-id]`); await has('[aria-label="방송 요약 지표"]');
  check(await page.evaluate(`document.querySelector('main h1').textContent==='방송 분석'&&document.querySelectorAll('[aria-label="방송 요약 지표"] dd').length===4&&!!document.querySelector('[aria-label="일별 평균 동시 접속 그래프"]')`), 'Actual owning-channel aggregates use the existing four metrics, daily chart and management layout');
  check(await page.evaluate(`document.querySelector('main').innerText.includes('동시 접속')&&!document.querySelector('main').innerText.includes('누적 시청 시간')`), 'Measured connection estimates are labelled separately from actual playback time');
  check(await page.evaluate(`Array.from(document.querySelectorAll('[aria-label="일별 평균 동시 접속 그래프"] li')).filter(day=>day.getAttribute('aria-label')?.includes('관측 구간 없음')).length>=5`), 'Days without collected intervals remain unobserved instead of fabricated zero-connection samples');
  if (!dev) {
    const before = await page.evaluate(`({id:document.querySelector('tr[data-analytics-id]').dataset.analyticsId,metrics:document.querySelector('[aria-label="방송 요약 지표"]').innerText})`);
    failure = { detail: '새로고침 연결을 확인하지 못했어요.' }; await click('[aria-label="방송 통계 새로고침"]'); await text('새로고침 연결을 확인하지 못했어요.');
    check(await page.evaluate(`document.querySelector('tr[data-analytics-id]')?.dataset.analyticsId===${JSON.stringify(before.id)}&&document.querySelector('[aria-label="방송 요약 지표"]').innerText===${JSON.stringify(before.metrics)}`), 'A refresh 503 preserves the last rows and summary for the same active filters');
    await button('통계 다시 시도'); await until(() => page.evaluate(`!document.body.innerText.includes('새로고침 연결을 확인하지 못했어요.')`), 'Refresh recovery');
    failure = { cursor: true, detail: '다음 방송 통계를 불러오지 못했어요.' }; await button('더 불러오기'); await text('다음 방송 통계를 불러오지 못했어요.');
    check(await page.evaluate(`document.querySelectorAll('tr[data-analytics-id]').length===1`), 'A cursor-page failure preserves already loaded real rows');
    await button('더 불러오기 다시 시도'); await until(() => page.evaluate(`document.querySelectorAll('tr[data-analytics-id]').length===2`), 'Actual second page');
    await button('더 불러오기'); await until(() => page.evaluate(`document.querySelectorAll('tr[data-analytics-id]').length===3`), 'Actual third page');
    check(await page.evaluate(`new Set(Array.from(document.querySelectorAll('tr[data-analytics-id]')).map(row=>row.dataset.analyticsId)).size===3`), 'Real server cursor pages append three distinct broadcast instances without duplicates');
    await set('[aria-label="방송 제목 검색"]', checkpoint.titles[0]); await button('검색');
    await until(() => page.evaluate(`document.querySelectorAll('tr[data-analytics-id]').length===1&&document.querySelector('tr[data-analytics-id]').dataset.analyticsId===${JSON.stringify(checkpoint.firstRowId)}`), 'Actual title filter');
    check(await page.evaluate(`document.querySelector('[aria-label="방송 요약 지표"]').innerText.includes('1회')`), 'Title filtering applies to summary, daily data and the broadcast list together');
    await set('[aria-label="방송 제목 검색"]', '없는 방송 ' + Date.now()); await button('검색'); await text('조건에 맞는 방송이 없어요');
    check(await page.evaluate(`!document.querySelector('tr[data-analytics-id]')`), 'A changed filter never reuses rows from the previous private result');
    await button('초기화'); await has('tr[data-analytics-id]');
    await set('[aria-label="통계 기간"]', '30'); await until(() => requests.some(request => request.period === '30'), 'Actual 30 day request'); await has('tr[data-analytics-id]');
    check(await page.evaluate(`document.querySelector('[aria-label="통계 기간"]').value==='30'`), 'The thirty-day selector requests actual server period statistics');
    await set('[aria-label="통계 기간"]', '7'); await until(() => page.evaluate(`document.querySelector('[aria-label="통계 기간"]').value==='7'`), 'Seven day period'); await has('tr[data-analytics-id]');
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
    const yesterday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now() - 86400000);
    await set('[name="analytics-from"]', today); await set('[name="analytics-to"]', yesterday); await button('검색'); await has('#analytics-range-error');
    check(await page.evaluate(`document.activeElement?.name==='analytics-to'&&document.querySelector('[name="analytics-to"]').getAttribute('aria-invalid')==='true'`), 'An inverted Korean date range focuses its labelled field and reports the inline error');
    await button('초기화'); await has('tr[data-analytics-id]');
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await until(() => page.evaluate(`navigator.onLine===false&&document.querySelector('[aria-label="방송 통계 새로고침"]').matches(':disabled')`), 'Offline controls');
    check(await page.evaluate(`!!document.querySelector('tr[data-analytics-id]')`), 'Offline mode retains the last measured rows and disables outgoing refreshes');
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await until(() => page.evaluate(`navigator.onLine&&!document.querySelector('[aria-label="방송 통계 새로고침"]').matches(':disabled')`), 'Online controls');
    await screenshot('analytics-owner-ui.png');
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: true });
      check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Actual analytics cards, filters, chart and table fit the ${width}px viewport`);
      await screenshot(`analytics-owner-${width}-ui.png`);
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cookies(checkpoint.other); await click('[aria-label="방송 통계 새로고침"]');
    await until(() => page.evaluate(`!document.querySelector('tr[data-analytics-id]')&&!document.querySelector('main').innerText.includes(${JSON.stringify(checkpoint.titles[0])})&&!document.querySelector('main').innerText.includes(${JSON.stringify(checkpoint.titles[1])})`), 'Private account reset');
    check(true, 'Shared-cookie account switching immediately clears the previous private summary and broadcast rows');
  }
  await Promise.all([...pending]); check(runtimeErrors.length === 0 && writes === 0 && privateHeaders.length > 0 && privateHeaders.every(Boolean), 'Analytics performs no writes, includes every expected-owner header and has no browser runtime or unconfirmed interception errors');
  await writeFile(path.join(output, dev ? 'analytics-dev-result.json' : 'analytics-ui-result.json'), JSON.stringify({ verificationDatabaseOnly: true, checks: results.length, passed: results.filter(result => result.pass).length, writes, results, runtimeErrors,
    paginationInstrumentation: dev ? null : 'Owning analytics GET limit lowered to 1; all rows and opaque cursors remain actual server responses.',
    limits: ['Headless Edge on one PC only', 'Mobile viewports are emulated, not physical devices'] }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: runtimeErrors.length, writes }));
} catch (failure) {
  await writeFile(path.join(output, dev ? 'analytics-dev-failure.json' : 'analytics-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors }, null, 2));
  if (page) await screenshot('analytics-ui-failure.png').catch(() => {}); throw failure;
} finally {
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); } browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
