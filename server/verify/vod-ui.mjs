// Browser checks use only real archived VODs from the owning isolated media fixture.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { Client } from './missions-client.mjs';

const dev = process.env.FRAME_VOD_DEV_SMOKE === '1', origin = `http://127.0.0.1:${dev ? 5366 : 5365}`, port = dev ? 9551 : 9550, output = path.resolve('verification/product');
const directory = path.resolve(process.env.FRAME_VOD_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_VOD_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external VOD fixture directory is required.');
const checkpoint = JSON.parse(await readFile(path.join(directory, 'vod-checkpoint.json'), 'utf8'));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
if (!/^obs-vod-[0-9a-f]{12}$/.test(checkpoint.path) || !uuid.test(checkpoint.publicId ?? '') || !uuid.test(checkpoint.uiRecordingId ?? '') || !Array.isArray(checkpoint.owner?.cookies)) throw Error('Actual dedicated VOD fixtures are required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), dev ? 'frame-vod-dev-ui-' : 'frame-vod-ui-')), profile = path.join(browserDirectory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
await writeFile(path.join(directory, dev ? 'browser-dev-owner.json' : 'browser-owner.json'), JSON.stringify({ pid: browser.pid, profile }));
const results = [], runtimeErrors = [], writes = [], reads = [], ownerHeaders = [], pending = new Set(), canceled = new Set(), intercepted = new Map();
let page, failure = null, holdMutation = false, heldMutation = null, pageLimit = !dev, videoMetrics = null;
const privatePrefix = '/api/v1/me/vods', publicPrefix = '/api/v1/vods';
function check(pass, name, detail) { results.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(fn, label, ms = 25000) { for (const end = Date.now() + ms; Date.now() < end;) { const value = await fn(); if (value) return value; await sleep(100); } throw Error('Timeout: ' + label); }
const text = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
async function navigate(route) { const marker = String(Date.now()); await page.evaluate(`window.__vodDocument=${JSON.stringify(marker)}`); await page.send('Page.navigate', { url: origin + '/_frame' + route }); await until(async () => { try { return await page.evaluate(`window.__vodDocument!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'VOD document'); }
async function cookies(saved) { await page.send('Network.clearBrowserCookies'); if (saved) await page.send('Network.setCookies', { cookies: saved.cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' })) }); }
async function set(selector, value) { await page.evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing VOD control');const proto=element.tagName==='SELECT'?HTMLSelectElement.prototype:element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function click(selector) { await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control ' + selector); await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector); }
async function button(label) { await until(() => page.evaluate(`Array.from(document.querySelectorAll('main button,dialog button')).some(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.matches(':disabled'))`), 'Enabled button ' + label); await page.evaluate(`(() => {const e=Array.from(document.querySelectorAll('main button,dialog button')).find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.matches(':disabled'));e.dataset.vodQaTarget='true';e.scrollIntoView({block:'center'});})()`); await page.click('[data-vod-qa-target]'); await page.evaluate(`document.querySelector('[data-vod-qa-target]')?.removeAttribute('data-vod-qa-target')`); }
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await page.evaluate('scrollTo(0,0)'); await writeFile(path.join(output, name), await page.screenshot()); }
async function command(method, parameters) { const request = intercepted.get(parameters.requestId); try { return await page.send(method, parameters); } catch (problem) { if (/Invalid InterceptionId/.test(problem.message) && request?.networkId) { await sleep(150); if (canceled.has(request.networkId)) return; } throw Error(`VOD interception failed for ${request?.method ?? 'unknown'} request: ${problem.message}`); } finally { intercepted.delete(parameters.requestId); } }
async function fulfill(requestId, problem) { await command('Fetch.fulfillRequest', { requestId, responseCode: problem.status ?? 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(JSON.stringify({ code: problem.code ?? 'PRODUCT_UNAVAILABLE', detail: problem.detail })).toString('base64') }); }
async function intercept(event) {
  const { requestId, request, networkId } = event.params, url = new URL(request.url); intercepted.set(requestId, { networkId, method: request.method });
  if (request.method === 'GET' && url.pathname === publicPrefix) reads.push({ cursor: url.searchParams.has('cursor') });
  if (url.pathname.startsWith(privatePrefix)) ownerHeaders.push(Object.keys(request.headers).some(name => name.toLowerCase() === 'x-frame-user-id'));
  if (request.method !== 'GET' && request.method !== 'HEAD') writes.push({ method: request.method, kind: url.pathname === privatePrefix ? 'publish' : url.pathname.endsWith('/retry') ? 'retry' : 'edit' });
  if (holdMutation && request.method === 'POST' && url.pathname === privatePrefix) { heldMutation = requestId; return; }
  if (failure && (!failure.path || failure.path === url.pathname) && (!failure.method || failure.method === request.method) && (!failure.cursor || url.searchParams.has('cursor'))) { const active = failure; failure = null; await fulfill(requestId, active); return; }
  if (pageLimit && request.method === 'GET' && (url.pathname === publicPrefix || url.pathname === '/api/v1/me/recordings')) { url.searchParams.set('limit', url.pathname === publicPrefix ? '1' : '2'); await command('Fetch.continueRequest', { requestId, url: url.href }); }
  else await command('Fetch.continueRequest', { requestId });
}
async function findSource() {
  await set('[aria-label="녹화 상태"]', 'ready');
  for (let i = 0; i < 30; i++) { if (await page.evaluate(`!!document.querySelector('tr[data-recording-id="${checkpoint.uiRecordingId}"]')`)) return; if (await page.evaluate(`Array.from(document.querySelectorAll('main button')).some(e=>e.textContent.trim()==='더 불러오기'&&!e.matches(':disabled'))`)) await button('더 불러오기'); else await sleep(150); }
  throw Error('The actual unpublished VOD source did not appear in the recording catalog.');
}
async function ownerItem(client, id) { const r = await client.request('GET', '/me/vods/' + id); if (r.status !== 200) throw Error('Private VOD control GET returned HTTP ' + r.status); return r.data.item; }
async function patch(client, item, visibility, title = item.title, description = item.description) { return client.request('PATCH', '/me/vods/' + item.id, { version: item.version, title, description, visibility }); }
const watchPath = id => '/vod/' + encodeURIComponent(checkpoint.channel.handle) + '/' + id;
try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 70; i++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('VOD QA browser unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => { if (event.method === 'Runtime.exceptionThrown') runtimeErrors.push(event.params.exceptionDetails.text); if (event.method === 'Network.loadingFailed' && event.params.canceled) canceled.add(event.params.requestId); if (event.method === 'Fetch.requestPaused') { const work = intercept(event).catch(problem => runtimeErrors.push(problem.message)); pending.add(work); void work.finally(() => pending.delete(work)); } });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/v1/me/vods*', requestStage: 'Request' }, { urlPattern: '*://*/api/v1/vods*', requestStage: 'Request' }, { urlPattern: '*://*/api/v1/me/recordings*', requestStage: 'Request' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const control = new Client(checkpoint.owner); let uiVodId = null;
  if (!dev) {
    await cookies(checkpoint.owner); await navigate('/studio/recordings'); await has('tr[data-recording-id]'); await findSource(); await click(`tr[data-recording-id="${checkpoint.uiRecordingId}"] button`); await has('dialog[open]'); await has('[aria-label="다시보기 공개 관리"]');
    await set('[aria-label="다시보기 제목"]', checkpoint.uiTitle); await set('[aria-label="다시보기 설명"]', checkpoint.description); holdMutation = true; await button('다시보기 공개'); await has('[aria-label="다시보기 공개 확인"]');
    check(await page.evaluate(`document.activeElement?.textContent.trim()==='취소'`), 'Publication requires a distinct confirmation with initial focus on the cancel action');
    await button('공개하기'); await until(() => heldMutation, 'Pending actual publication request');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('[aria-label="녹화 상세 닫기"]').matches(':disabled')`) && writes.filter(w => w.kind === 'publish').length === 1, 'A pending publication locks duplicate actions and the enclosing recording dialog');
    holdMutation = false; const held = heldMutation; heldMutation = null; await fulfill(held, { detail: '다시보기 공개 결과를 확인하지 못했어요.' }); await text('다시보기 공개 결과를 확인하지 못했어요.');
    check(await page.evaluate(`document.querySelector('[aria-label="다시보기 제목"]').value===${JSON.stringify(checkpoint.uiTitle)}`), 'An uncertain publication response preserves the intended metadata instead of claiming success');
    await button('다시보기 최신 상태 확인'); await until(() => page.evaluate(`Array.from(document.querySelectorAll('dialog button')).some(e=>e.textContent.trim()==='다시보기 공개'&&!e.matches(':disabled'))`), 'Publication receipt check without automatic repeat');
    check(writes.filter(w => w.kind === 'publish').length === 1, 'Checking an uncertain receipt never automatically repeats the publication request');
    await button('다시보기 공개'); await button('공개하기');
    const created = await until(async () => { const r = await control.request('GET', '/me/vods/by-recording/' + checkpoint.uiRecordingId); return r.data?.item?.published ? r.data.item : null; }, 'UI-created real public VOD'); uiVodId = created.id;
    check(created.title === checkpoint.uiTitle && created.description === checkpoint.description, 'The recording publication form creates actual archived metadata and a public ready VOD');
    await until(() => page.evaluate(`Array.from(document.querySelectorAll('[aria-label="다시보기 공개 관리"] button')).some(e=>e.textContent.trim()==='비공개로 변경')`), 'Public management state');
    const editedTitle = checkpoint.uiTitle + ' 수정', editedDescription = checkpoint.description + '\n저장한 설명';
    await set('[aria-label="다시보기 제목"]', editedTitle); await set('[aria-label="다시보기 설명"]', editedDescription); await button('다시보기 정보 저장');
    await until(async () => (await ownerItem(control, uiVodId)).title === editedTitle, 'Actual title and description edit');
    check((await ownerItem(control, uiVodId)).description === editedDescription, 'Publication title and multiline description edits are saved to the actual VOD resource');
    const concurrent = await patch(control, await ownerItem(control, uiVodId), 'public', editedTitle, editedDescription + '\n동시 변경'); if (concurrent.status !== 200) throw Error('Actual competing VOD edit failed.');
    await set('[aria-label="다시보기 제목"]', editedTitle + ' 덮어쓰기'); await button('다시보기 정보 저장'); await text('다시보기 최신 상태 확인');
    check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('[aria-label="다시보기 제목"]').value.includes('덮어쓰기')`), 'An actual version conflict preserves the editing context instead of overwriting the publisher change');
    await button('다시보기 최신 상태 확인'); await has('[aria-label="공개 설정 새로고침 확인"]'); await button('최신 내용으로 바꾸기'); await until(() => page.evaluate(`document.querySelector('[aria-label="다시보기 제목"]').value===${JSON.stringify(editedTitle)}`), 'Explicit latest VOD state');
    await button('비공개로 변경'); await has('[aria-label="다시보기 비공개 확인"]');
    check((await ownerItem(control, uiVodId)).visibility === 'public', 'Opening the withdrawal confirmation does not change actual public visibility');
    await button('취소'); check((await ownerItem(control, uiVodId)).visibility === 'public', 'Canceling withdrawal preserves the existing public VOD');
    await button('비공개로 변경'); await button('비공개로 바꾸기'); await until(async () => (await ownerItem(control, uiVodId)).visibility === 'private', 'Actual UI withdrawal');
    check((await control.request('GET', '/vods/' + uiVodId)).status === 404, 'Confirmed publisher UI withdrawal blocks the actual public VOD detail');
    await button('공개로 변경'); await button('공개하기'); await until(async () => (await ownerItem(control, uiVodId)).published, 'Actual UI republication');
    check((await control.request('GET', '/vods/' + uiVodId)).status === 200, 'Confirmed republication restores the same actual archived VOD without another copy');
    await screenshot('vod-publisher-ui.png'); await click('[aria-label="녹화 상세 닫기"]');
    await cookies(null); failure = { path: publicPrefix, detail: '다시보기 첫 연결을 확인하지 못했어요.' }; await navigate('/vod?q=' + encodeURIComponent(checkpoint.needle)); await text('다시보기 첫 연결을 확인하지 못했어요.');
    check(await page.evaluate(`!document.querySelector('main video')`), 'A failed anonymous catalog request offers retry without fabricated playback'); await button('다시보기 목록 다시 시도');
    await until(() => page.evaluate(`!!document.querySelector('a[href*="/vod/"]')`), 'Actual public VOD cards');
    check(await page.evaluate(`document.querySelector('main h1').textContent==='다시보기'&&!document.querySelector('main').innerText.includes('조회수')&&!document.querySelector('main').innerText.includes('지난 채팅')`), 'Anonymous viewers see the existing VOD layout without fake view counts or archived chat');
    const before = await page.evaluate(`document.querySelector('main a[href*="/vod/"]').getAttribute('href')`); failure = { path: publicPrefix, detail: '다시보기 새로고침을 확인하지 못했어요.' }; await click('[aria-label="다시보기 목록 새로고침"]'); await text('다시보기 새로고침을 확인하지 못했어요.');
    check(await page.evaluate(`document.querySelector('main a[href*="/vod/"]').getAttribute('href')===${JSON.stringify(before)}`), 'A public refresh failure retains the last actual cards for the current query'); await button('다시보기 목록 다시 시도');
    await until(() => page.evaluate(`!document.querySelector('main [role="alert"]')&&!document.querySelector('[aria-label="다시보기 목록 새로고침"]').matches(':disabled')`), 'Public refresh retry completion before the next operation');
    failure = { path: publicPrefix, cursor: true, detail: '다음 다시보기를 불러오지 못했어요.' }; await button('다시보기 더 불러오기'); await text('다음 다시보기를 불러오지 못했어요.'); await button('다시보기 더 불러오기 다시 시도'); await until(() => page.evaluate(`new Set(Array.from(document.querySelectorAll('main a[href*="/vod/"]')).map(e=>e.getAttribute('href'))).size>=2`), 'Actual public second cursor page');
    check(true, 'Actual cursor-page retry appends distinct public recordings after a separate page error');
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }); await until(() => page.evaluate(`!navigator.onLine&&document.querySelector('[aria-label="다시보기 목록 새로고침"]').matches(':disabled')`), 'Public catalog offline controls');
    check(await page.evaluate(`!!document.querySelector('main article[data-vod-id]')`), 'Offline public catalog retains verified cards and prevents refresh requests');
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await until(() => page.evaluate(`navigator.onLine&&!document.querySelector('[aria-label="다시보기 목록 새로고침"]').matches(':disabled')`), 'Public catalog online recovery');
    await screenshot('vod-catalog-ui.png');
    await navigate('/channel/' + encodeURIComponent(checkpoint.channel.handle) + '?tab=videos'); await has(`a[href*="${uiVodId}"]`);
    check(await page.evaluate(`!!document.querySelector('a[href*="${uiVodId}"]')&&!document.querySelector('a[href*="${checkpoint.retryPrivateId}"]')`), 'The real channel VOD tab lists public recordings and excludes a private archived VOD');
    await navigate(watchPath(uiVodId)); await has('video[aria-label="다시보기 영상"]');
    check(await page.evaluate(`document.querySelector('video[aria-label="다시보기 영상"]').paused&&!document.querySelector('video[aria-label="다시보기 영상"]').autoplay`), 'Public VOD playback is available without login and requires an explicit play action');
    await page.evaluate(`(() => {const v=document.querySelector('video[aria-label="다시보기 영상"]');v.muted=true;v.play().catch(e=>{window.__vodPlayError=e.name;});})()`);
    videoMetrics = await until(() => page.evaluate(`(() => {const v=document.querySelector('video[aria-label="다시보기 영상"]'),q=v?.getVideoPlaybackQuality();return v&&v.videoWidth===320&&v.videoHeight===180&&v.currentTime>.3&&(q?.totalVideoFrames??0)>3?{width:v.videoWidth,height:v.videoHeight,currentTime:v.currentTime,duration:v.duration,decodedFrames:q.totalVideoFrames,audioDecodedBytes:v.webkitAudioDecodedByteCount??null}:null})()`), 'Anonymous actual archived MP4 decoding');
    const target = Math.min(videoMetrics.duration - .3, videoMetrics.duration / 2); await page.evaluate(`(() => {const v=document.querySelector('video[aria-label="다시보기 영상"]');v.pause();v.currentTime=${target};})()`); await until(() => page.evaluate(`(() => {const v=document.querySelector('video[aria-label="다시보기 영상"]');return !v.seeking&&Math.abs(v.currentTime-${target})<.3;})()`), 'Actual public VOD seek'); await page.evaluate(`document.querySelector('video[aria-label="다시보기 영상"]').play().catch(()=>{})`);
    videoMetrics.seek = await until(() => page.evaluate(`(() => {const v=document.querySelector('video[aria-label="다시보기 영상"]'),q=v.getVideoPlaybackQuality();return v.currentTime>${target + .15}&&q.totalVideoFrames>${videoMetrics.decodedFrames}?{target:${target},currentTime:v.currentTime,decodedFrames:q.totalVideoFrames}:null})()`), 'Actual decoded frame progress after seek'); await page.evaluate(`document.querySelector('video[aria-label="다시보기 영상"]').pause()`);
    check(true, 'The anonymous archived VOD decodes actual video frames and advances after a native seek', videoMetrics);
    await button('다시보기 공유'); await has('dialog[open] input[readonly]');
    check(await page.evaluate(`document.querySelector('dialog[open] input[readonly]').value===location.href`), 'The share dialog exposes the stable actual public VOD watch URL'); await page.key('Escape');
    check(await page.evaluate(`!document.querySelector('dialog[open]')&&document.activeElement?.textContent.trim()==='다시보기 공유'`), 'Closing the share dialog restores focus to the sharing action');
    await screenshot('vod-watch-ui.png');
    for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Public VOD metadata and native player fit the ${width}px viewport`); await screenshot(`vod-watch-${width}-ui.png`); }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const unpublished = await patch(control, await ownerItem(control, uiVodId), 'private'); if (unpublished.status !== 200) throw Error('Actual owner withdrawal failed.');
    await until(() => page.evaluate(`!document.querySelector('video[aria-label="다시보기 영상"]')`), 'Anonymous player privacy withdrawal polling', 30000);
    check(true, 'A real publisher withdrawal removes the previously loaded public player after the next visibility check');
    await cookies(checkpoint.owner); await navigate('/studio/recordings'); await has('tr[data-recording-id]'); await findSource(); await click(`tr[data-recording-id="${checkpoint.uiRecordingId}"] button`); await has('[aria-label="다시보기 공개 관리"]'); await cookies(checkpoint.other); await click('[aria-label="다시보기 공개 상태 새로고침"]');
    await until(() => page.evaluate(`!document.querySelector('[aria-label="다시보기 공개 관리"]')&&!document.querySelector('tr[data-recording-id]')`), 'Changed publisher account cleanup');
    check(true, 'A publisher cookie-account change clears the previous private publication form and recording rows');
  } else {
    await cookies(null); await navigate('/vod?q=' + encodeURIComponent(checkpoint.needle)); await has('a[href*="/vod/"]'); check(true, 'Development StrictMode renders actual anonymous public VOD cards');
    await navigate(watchPath(checkpoint.publicId)); await has('video[aria-label="다시보기 영상"]'); check(await page.evaluate(`!document.querySelector('video').autoplay&&!document.querySelector('main').innerText.includes('지난 채팅')`), 'Development VOD detail uses the real archive player without fake chat or autoplay');
  }
  await Promise.all([...pending]); check(runtimeErrors.length === 0 && ownerHeaders.every(Boolean) && (!dev || writes.length === 0), 'VOD management carries the expected owner and has no runtime or unconfirmed interception errors');
  await writeFile(path.join(output, dev ? 'vod-dev-result.json' : 'vod-ui-result.json'), JSON.stringify({ verificationDatabaseOnly: true, checks: results.length, passed: results.filter(r => r.pass).length, results, runtimeErrors, writes, videoMetrics, paginationInstrumentation: dev ? null : 'Public catalog limit lowered to 1 and recording catalog limit to 2; every row and cursor remains an actual server response.', limits: ['Headless Edge on one PC only', 'Mobile sizes are emulated viewports, not physical phones'] }, null, 2)); console.log(JSON.stringify({ checks: results.length, passed: results.filter(r => r.pass).length, runtimeErrors: runtimeErrors.length, writes: writes.length }));
} catch (failure) { await writeFile(path.join(output, dev ? 'vod-dev-failure.json' : 'vod-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors, reads, writes }, null, 2)); if (page) await screenshot('vod-ui-failure.png').catch(() => {}); throw failure; }
finally { if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); } browser.kill(); const literal = profile.replaceAll("'", "''"); try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {} }
