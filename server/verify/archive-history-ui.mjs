// Native decoded media is the playback evidence; private checkpoints never leave the temporary fixture.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect, sleep } from '../../tools/cdp.mjs';
import { killByCommandLine } from './harness.mjs';
import { Client } from './missions-client.mjs';

const dev = process.env.FRAME_ARCHIVE_HISTORY_DEV_SMOKE === '1', origin = 'http://127.0.0.1:' + (dev ? 5366 : 5365), port = dev ? 9551 : 9550;
const directory = path.resolve(process.env.FRAME_ARCHIVE_HISTORY_TEST_DIR ?? ''), output = path.resolve('verification/product');
if (!process.env.FRAME_ARCHIVE_HISTORY_TEST_DIR || path.dirname(directory).toLowerCase() !== path.resolve(tmpdir()).toLowerCase() || !/^frame-archive-history-[0-9a-f]{12}$/.test(path.basename(directory))) throw Error('An exact private archive-history fixture directory is required.');
const fixture = JSON.parse(await readFile(path.join(directory, 'archive-history-checkpoint.json'), 'utf8'));
const browserDirectory = await mkdtemp(path.join(tmpdir(), dev ? 'frame-archive-history-dev-ui-' : 'frame-archive-history-ui-')), profile = path.join(browserDirectory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
await writeFile(path.join(directory, dev ? 'browser-dev-owner.json' : 'browser-owner.json'), JSON.stringify({ pid: browser.pid, profile }));
const results = [], errors = [], mutations = [], allMutations = [], metrics = [], transfers = new Map(), completions = [], pending = new Set();
let page, complete = false, holdNextPut = false, heldPut = null, holdNextGet = false, heldGet = null, failAcceptedResponse = false, acceptedBeforeFault = null;
const viewer = new Client(fixture.viewer), endpoint = kind => '/api/v1/me/history/media/' + kind + '/' + fixture[kind + 'Id'];
const route = kind => '/' + (kind === 'vod' ? 'vod' : 'clips') + '/' + encodeURIComponent(fixture.channel.handle) + '/' + fixture[kind + 'Id'];
const selector = kind => 'video[aria-label="' + (kind === 'vod' ? '다시보기' : '클립') + ' 영상"]';
function check(pass, name, detail) { results.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(fn, label, ms = 20000) { for (const end = Date.now() + ms; Date.now() < end;) { const value = await fn(); if (value) return value; await sleep(100); } throw Error('Timeout: ' + label); }
const completedReads = pathname => completions.filter(item => item.path === pathname && item.status === 200).length;
const bodyHas = value => page.evaluate('document.body.innerText.includes(' + JSON.stringify(value) + ')');
async function cookies(saved) { await page.send('Network.clearBrowserCookies'); if (saved) await page.send('Network.setCookies', { cookies: saved.cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' })) }); }
async function navigate(value, readPath) {
  const marker = randomBytes(6).toString('hex'), before = readPath ? completedReads(readPath) : 0;
  await page.evaluate('window.__archiveQaDocument=' + JSON.stringify(marker)); await page.send('Page.navigate', { url: origin + '/_frame' + value });
  await until(async () => { try { return await page.evaluate('window.__archiveQaDocument!==' + JSON.stringify(marker) + '&&document.readyState==="complete"'); } catch { return false; } }, 'new document');
  if (readPath) await until(() => completedReads(readPath) > before, 'completed private GET');
}
async function watch(kind, signedIn = true) { await navigate(route(kind), signedIn ? endpoint(kind) : null); await until(() => page.evaluate('(()=>{const v=document.querySelector(' + JSON.stringify(selector(kind)) + ');return !!v&&v.readyState>=1;})()'), 'native metadata'); }
async function button(label) { await until(() => page.evaluate('Array.from(document.querySelectorAll("main button")).some(e=>e.textContent.trim()===' + JSON.stringify(label) + '&&!e.disabled)'), 'enabled ' + label); await page.evaluate('(()=>{const e=Array.from(document.querySelectorAll("main button")).find(e=>e.textContent.trim()===' + JSON.stringify(label) + '&&!e.disabled);e.click();})()'); }
async function sample(kind) { return page.evaluate('(()=>{const v=document.querySelector(' + JSON.stringify(selector(kind)) + ');if(!v)return null;return{time:v.currentTime,paused:v.paused,ended:v.ended,width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames,duration:v.duration};})()'); }
async function play(kind, seconds = 2) {
  const before = await sample(kind);
  await page.evaluate('(()=>{const v=document.querySelector(' + JSON.stringify(selector(kind)) + ');v.muted=true;return v.play();})()');
  const after = await until(async () => { const value = await sample(kind); return value && value.time >= before.time + seconds && value.frames > before.frames + 10 ? value : null; }, 'actual decoded ' + kind + ' advancement');
  metrics.push({ kind, before, after }); return after;
}
async function pause(kind) { await page.evaluate('document.querySelector(' + JSON.stringify(selector(kind)) + ').pause()'); await until(async () => (await sample(kind))?.paused, 'native pause'); }
async function saved(kind) { const r = await viewer.request('GET', endpoint(kind).replace('/api/v1', '')); if (r.status !== 200) throw Error('Private progress read failed.'); return r.data; }
async function settled(kind, minimum = 1000) { await until(async () => { const value = await saved(kind); return value.item?.positionMs >= minimum ? value : null; }, 'durable ' + kind + ' progress'); await sleep(300); await Promise.all([...pending]); }
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await page.evaluate('scrollTo(0,0)'); await writeFile(path.join(output, name), await page.screenshot()); }
async function intercept(event) {
  const { requestId, request } = event.params;
  if (event.params.responseStatusCode !== undefined || event.params.responseErrorReason !== undefined) {
    if (failAcceptedResponse && request.method === 'PUT') {
      failAcceptedResponse = false; acceptedBeforeFault = event.params.responseStatusCode;
      await page.send('Fetch.fulfillRequest', { requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(JSON.stringify({ code: 'PRODUCT_UNAVAILABLE', detail: '저장 응답을 확인하지 못했어요.' })).toString('base64') }); return;
    }
    await page.send('Fetch.continueRequest', { requestId }); return;
  }
  if (request.method === 'GET' && holdNextGet) { holdNextGet = false; heldGet = requestId; return; }
  if (request.method === 'PUT') { const input = JSON.parse(request.postData); mutations.push({ method: 'PUT', kind: request.url.includes('/clip/') ? 'clip' : 'vod', version: input.version, positionMs: input.positionMs, completed: input.completed, expectedOwner: Object.entries(request.headers).some(([name, value]) => name.toLowerCase() === 'x-frame-user-id' && value === fixture.viewer.userId) }); if (holdNextPut) { holdNextPut = false; heldPut = requestId; return; } }
  await page.send('Fetch.continueRequest', { requestId });
}
try {
  await mkdir(output, { recursive: true }); page = await until(() => connect(port, target => !target.url.startsWith('edge://')).catch(() => null), 'private Edge CDP');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') { const r = event.params.request; if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method)) allMutations.push({ method: r.method, path: new URL(r.url).pathname }); if (r.method === 'GET') transfers.set(event.params.requestId, { path: new URL(r.url).pathname, status: null }); }
    if (event.method === 'Network.responseReceived') { const item = transfers.get(event.params.requestId); if (item) item.status = event.params.response.status; }
    if (event.method === 'Network.loadingFinished') { const item = transfers.get(event.params.requestId); if (item) { completions.push(item); transfers.delete(event.params.requestId); } }
    if (event.method === 'Network.loadingFailed') transfers.delete(event.params.requestId);
    if (event.method === 'Fetch.requestPaused') { const work = intercept(event).catch(error => errors.push(error.message)); pending.add(work); void work.finally(() => pending.delete(work)); }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/v1/me/history/media/*', requestStage: 'Request' }, { urlPattern: '*://*/api/v1/me/history/media/*', requestStage: 'Response' }] });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cookies(fixture.viewer);
  if (dev) {
    for (const kind of ['vod', 'clip']) { await watch(kind); check((await sample(kind)).paused, 'StrictMode ' + kind + ' opens paused with an actual private GET'); }
    await navigate('/history', '/api/v1/me/history'); await until(() => bodyHas('시청 기록'), 'history view');
    await sleep(500); check(allMutations.length === 0, 'StrictMode archive and history reads cause zero mutations');
  } else {
    await cookies(null); await watch('clip', false); await play('clip', 1.5); await pause('clip');
    check(mutations.length === 0, 'Anonymous actual decoded clip playback creates no private history');
    await cookies(fixture.viewer); await watch('vod'); const initial = await saved('vod');
    await page.evaluate('document.querySelector(' + JSON.stringify(selector('vod')) + ').currentTime=4');
    await until(async () => { const s = await sample('vod'); return s.paused && Math.abs(s.time - 4) < .2; }, 'paused seek'); await sleep(400);
    check(initial.item === null && mutations.length === 0 && (await saved('vod')).item === null, 'Opening metadata and seeking while paused do not fabricate a watched visit');
    await page.evaluate('document.querySelector(' + JSON.stringify(selector('vod')) + ').currentTime=0'); await play('vod'); await pause('vod'); await settled('vod');
    const first = await saved('vod');
    check(first.item.kind === 'vod' && first.item.mediaId === fixture.vodId && first.item.title === fixture.vodTitle && first.item.durationMs === fixture.vodDurationMs && first.item.positionMs >= 1000 && first.item.positionMs < 3500, 'Actual advancing VOD frames and pause persist trusted metadata and a native saved position', { positionMs: first.item.positionMs });
    await watch('vod'); check((await sample('vod')).paused && (await sample('vod')).time < .2, 'Reload offers saved progress without seeking or autoplay');
    await until(() => page.evaluate('(()=>{const v=document.querySelector(' + JSON.stringify(selector('vod')) + ');return v.readyState>=2&&!v.seeking;})()'), 'resume offer ready media'); await screenshot('archive-history-resume-ui.png');
    const count = mutations.length; await button('이어보기'); await until(async () => { const s = await sample('vod'); return s.paused && Math.abs(s.time * 1000 - first.item.positionMs) < 300; }, 'explicit saved seek');
    check(mutations.length === count, 'Explicit continue restores the saved position and remains paused', { restoredPositionMs: Math.round((await sample('vod')).time * 1000), savedPositionMs: first.item.positionMs });
    await watch('clip'); await play('clip'); await pause('clip'); await settled('clip');
    check((await saved('clip')).item.title === fixture.clipTitle, 'Actual advancing clip frames persist a separate private clip position');
    await navigate('/history', '/api/v1/me/history'); await until(() => bodyHas(fixture.vodTitle), 'actual stored history rows');
    check(await bodyHas(fixture.clipTitle) && await page.evaluate('document.querySelectorAll(' + JSON.stringify('article a[href*="resume=1"]') + ').length===2'), 'History shows real VOD and clip entries with explicit continue links');
    await screenshot('archive-history-ui.png');
    for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Saved archive history fits the ' + width + 'px viewport'); await screenshot('archive-history-' + width + '-ui.png'); }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await watch('vod'); await button('처음부터 보기'); holdNextPut = true; await play('vod'); await pause('vod'); await until(() => heldPut, 'held actual progress request');
    const old = await saved('vod'); check((await viewer.request('DELETE', '/me/history/' + old.item.id)).status === 204, 'The durable VOD row is deleted while an actual player save is in flight');
    const held = heldPut; heldPut = null; await page.send('Fetch.continueRequest', { requestId: held });
    await until(() => bodyHas('다른 화면에서 시청 기록이 변경됐어요.'), 'late save conflict'); await sleep(300);
    check((await saved('vod')).item === null, 'A late actual player PUT cannot resurrect the deleted row');
    await button('기록 다시 연결'); await until(async () => !await bodyHas('기록 다시 연결'), 'explicit reconnect'); await page.evaluate('document.querySelector(' + JSON.stringify(selector('vod')) + ').currentTime=0'); await play('vod'); await pause('vod'); await settled('vod');
    const other = new Client(fixture.other); check((await other.request('GET', '/me/history')).data.items.length === 0, 'A second logged-in account cannot see the actual viewer private history');
    // A slow initial private GET must preserve observed progress queued before the receipt exists.
    const beforeSlow = await saved('clip'), beforeSlowWrites = mutations.length; holdNextGet = true;
    await watch('clip', false); await until(() => heldGet, 'held initial archive GET'); await play('clip'); await pause('clip');
    check(mutations.length === beforeSlowWrites, 'Actual play and pause wait for the delayed initial history receipt without speculative writes');
    const delayedGet = heldGet; heldGet = null; await page.send('Fetch.continueRequest', { requestId: delayedGet });
    await until(async () => (await saved('clip')).item.version > beforeSlow.item.version, 'queued paused progress after initial GET');
    check((await sample('clip')).paused && (await saved('clip')).item.positionMs >= 1000, 'Resolving the delayed GET persists queued actual progress while video stays paused');
    // Lose only an actually accepted PUT response. The hook must reconcile its receipt rather than repeat that PUT.
    await watch('vod'); await button('처음부터 보기');
    const beforeFault = await saved('vod'), beforeFaultReads = completedReads(endpoint('vod')), beforeFaultWrites = mutations.length; failAcceptedResponse = true;
    await play('vod'); await pause('vod');
    await until(() => acceptedBeforeFault !== null && completedReads(endpoint('vod')) > beforeFaultReads, 'accepted PUT response loss and reconciliation GET');
    await until(async () => (await saved('vod')).item.version > beforeFault.item.version, 'accepted response remains durable'); await sleep(300);
    const recoveredWrites = mutations.slice(beforeFaultWrites), repeated = recoveredWrites.some((item, index) => recoveredWrites.slice(0, index).some(previous => previous.version === item.version && previous.positionMs === item.positionMs && previous.completed === item.completed));
    check(acceptedBeforeFault === 200 && !repeated && !await bodyHas('기록 다시 연결'), 'A lost actual PUT 200 response reconciles through GET without repeating the accepted update', { acceptedStatus: acceptedBeforeFault, writes: recoveredWrites.length, reconciliationGets: completedReads(endpoint('vod')) - beforeFaultReads });
    // Completion is observed from native playback to ended; a paused jump to the end is never the evidence.
    await watch('clip'); await button('처음부터 보기'); await play('clip');
    await until(async () => (await sample('clip')).ended, 'actual native clip end');
    await until(async () => (await saved('clip')).item.completed, 'native completion receipt');
    metrics.push({ kind: 'clip', nativeEnded: await sample('clip') });
    check((await saved('clip')).item.positionMs === fixture.clipDurationMs, 'Actual native clip ending stores trusted complete duration');
    await watch('clip'); await until(() => bodyHas('시청을 완료한 영상이에요.'), 'completed replay offer');
    const beforeReplayWrites = mutations.length; await button('처음부터 보기');
    check((await sample('clip')).paused && (await sample('clip')).time < .2 && mutations.length === beforeReplayWrites, 'Completed clip starts over only by explicit paused selection');
    await play('clip'); await pause('clip'); await until(async () => { const value = await saved('clip'); return !value.item.completed && value.item.positionMs >= 1000 && value.item.positionMs < 3500; }, 'actual replay position');
    check(!(await saved('clip')).item.completed, 'Actual replay advances a lower position and clears completion on the same history row');
    await navigate('/history', '/api/v1/me/history'); await until(() => bodyHas(fixture.vodTitle), 'final durable history');
    check(mutations.every(item => item.expectedOwner), 'Every actual archive save carries the expected logged-in account header');
  }
  await Promise.all([...pending]); check(errors.length === 0, 'No browser runtime or interception errors'); complete = true;
} catch (failure) {
  await writeFile(path.join(directory, 'private-ui-failure.json'), JSON.stringify({ message: failure.message, stack: failure.stack }));
  results.push({ name: 'Browser verification completes', pass: false, detail: { failure: failure.message.replaceAll(directory, '<private-fixture>') } });
  if (page) await screenshot('archive-history-ui-failure.png').catch(() => {}); process.exitCode = 1;
} finally {
  await writeFile(path.join(output, dev ? 'archive-history-dev-result.json' : 'archive-history-ui-result.json'), JSON.stringify({ complete, verificationDatabaseOnly: true, testedJarSha256: fixture.testedJarSha256, results, checks: results.length, passed: results.filter(item => item.pass).length, runtimeErrors: errors, mutations, totalMutations: allMutations.length, playbackMetrics: metrics, acceptedResponseBeforeFault: acceptedBeforeFault, completedHistoryGetResponses: completions.filter(item => item.path.startsWith('/api/v1/me/history')).length, limits: ['Native headless Edge playback on one PC; mobile widths are emulated', 'No physical-device, external-network, long-run or load verification'] }, null, 2));
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); } browser.kill(); killByCommandLine(profile);
  console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length, runtimeErrors: errors.length }));
}
