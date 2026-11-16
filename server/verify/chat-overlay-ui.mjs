// Real isolated account fixtures; browser overlay remains anonymous even while the browser holds owner cookies.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { Client, joinAccount, sendMessage, liveBroadcast } from './chat-moderation-client.mjs';

const mode = process.argv[2] ?? 'production';
if (!['production', 'dev'].includes(mode)) throw Error('Unknown overlay verification mode.');
const origin = 'http://127.0.0.1:5365', port = mode === 'dev' ? 9551 : 9550;
const output = path.resolve('verification/product'), directory = path.resolve(process.env.FRAME_CHAT_OVERLAY_TEST_DIR ?? '');
const relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_CHAT_OVERLAY_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external overlay fixture directory is required.');
const streamKey = process.env.FRAME_CHAT_OVERLAY_STREAM_KEY, streamPath = streamKey?.split('?')[0];
if (!streamKey || !/^obs-chat-[0-9a-f]{12}$/.test(streamPath ?? '')) throw Error('The isolated overlay stream credential is required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), 'frame-chat-overlay-ui-')), profile = path.join(browserDirectory, 'profile');
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const results = [], errors = [], fixtureSockets = [];
let page, current, scope = 'idle', complete = false, fixture, metadataFailure = false, allMetadataResponses = 0;
const network = { requests: [], frames: [], created: 0, closed: 0, active: new Set(), metadataCookieHeaders: 0, metadataResponses: 0 };
const requestPaths = new Map(), managementWrites = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label, duration = 16000) {
  const end = Date.now() + duration;
  while (Date.now() < end) { if (await test()) return; await sleep(100); }
  throw Error('Timeout: ' + label);
}
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const phase = value => until(() => page.evaluate(`document.querySelector('[data-chat-overlay]')?.dataset.phase===${JSON.stringify(value)}`), 'Overlay phase ' + value, 22000);
async function navigate(route) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__overlayQaDocument=${JSON.stringify(marker)}`);
  // Chromium does not emit webSocketClosed for sockets discarded with a whole document. The live set belongs to one
  // document; the final SPA transition deliberately keeps that document and must emit an observed close for its socket.
  network.active.clear();
  await page.send('Page.navigate', { url: origin + '/_frame' + route });
  await until(async () => { try { return await page.evaluate(`window.__overlayQaDocument!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New overlay QA document');
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing overlay control');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const key = { '[name="overlay-theme"]': 'theme', '[name="overlay-font-size"]': 'fontSize', '[name="overlay-max-messages"]': 'maxMessages', '[name="overlay-hide-after"]': 'hideAfterSeconds' }[selector];
  if (key) await until(() => page.evaluate(`new URLSearchParams(location.search).get(${JSON.stringify(key)})===${JSON.stringify(value)}`), 'Configured display option ' + key);
}
async function button(label) {
  await page.evaluate(`(() => {const button=Array.from(document.querySelectorAll('button')).find(item=>item.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Missing enabled overlay action');button.dataset.overlayQaTarget='true';button.scrollIntoView({block:'center'});})()`);
  await page.click('[data-overlay-qa-target]'); await page.evaluate(`document.querySelector('[data-overlay-qa-target]')?.removeAttribute('data-overlay-qa-target')`);
}
async function click(selector) {
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled overlay control');
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector);
}
async function viewport(width) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: width < 600 });
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
}
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, name), await page.screenshot()); }
async function marker(command) {
  const target = path.join(directory, command + '.json'), temporary = target + '.tmp';
  await writeFile(temporary, '{}'); await rename(temporary, target);
  await until(async () => { try { await readFile(path.join(directory, command + '-done.json')); return true; } catch { return false; } }, 'Dedicated source control ' + command);
}
async function installOwner() {
  const cookies = fixture.owner.cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' }));
  await page.send('Network.setCookies', { cookies });
  check((await page.send('Network.getCookies', { urls: [origin] })).cookies.length > 0, 'Only isolated owner cookies are installed in the private browser profile');
}
async function account(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const response = await client.request('POST', '/auth/register', { email: `chat_overlay_${kind}_${randomBytes(6).toString('hex')}@example.invalid`,
    password: randomBytes(24).toString('base64url'), displayName: kind === 'owner' ? '오버레이 방송자' : '오버레이 시청자', ...consent });
  if (response.status !== 201) throw Error('Isolated overlay registration returned HTTP ' + response.status);
  return { client, user: response.data.user, channel: response.data.channel };
}
async function joined(client, broadcast) { const value = await joinAccount(client, broadcast); fixtureSockets.push(value.socket); if (!value.state?.authenticated) throw Error('Managed fixture chat identity was unavailable.'); return value.socket; }
async function message(socket, text) { const ack = await sendMessage(socket, text); if (!ack?.ok) throw Error('Managed fixture message was refused: ' + (ack?.code ?? 'no acknowledgement')); }
const overlayRoute = (query = '') => '/overlay/chat/' + fixture.channelId + (query ? '?' + query : '');
async function overlay(query = '') { scope = 'overlay'; await navigate(overlayRoute(query)); await has('[data-chat-overlay]'); }
async function messages() { return page.evaluate(`Array.from(document.querySelectorAll('[data-overlay-message]')).map(element=>element.textContent)`); }
async function hasMessage(text) { await until(async () => (await messages()).some(value => value.includes(text)), 'Real fixture message is rendered'); }
function safeNetwork() {
  const product = network.requests.filter(request => request.path.startsWith('/api/'));
  return product.length > 0 && product.every(request => request.method === 'GET' && /^\/api\/v1\/channel-ids\/[0-9a-f-]{36}$/.test(request.path))
    && network.frames.length > 0 && network.frames.every(frame => frame.type === 'join' && frame.keys.join(',') === 'broadcastId,type')
    && network.metadataCookieHeaders === 0;
}
async function intercept(event) {
  const { requestId, request } = event.params, pathname = new URL(request.url).pathname;
  if (metadataFailure && /^\/api\/v1\/channel-ids\//.test(pathname)) {
    await page.send('Fetch.fulfillRequest', { requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ code: 'PRODUCT_UNAVAILABLE', detail: '검증용 채널 확인 실패' })).toString('base64') });
  } else await page.send('Fetch.continueRequest', { requestId });
}

try {
  await mkdir(output, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('The isolated overlay browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.requestWillBeSent') {
      const { requestId, request } = event.params, pathname = new URL(request.url).pathname;
      requestPaths.set(requestId, { pathname, scope });
      if (scope === 'overlay') network.requests.push({ method: request.method, path: pathname });
      if (scope === 'management' && !['GET', 'HEAD'].includes(request.method)) managementWrites.push(request.method);
    }
    if (event.method === 'Network.requestWillBeSentExtraInfo') {
      const target = requestPaths.get(event.params.requestId);
      if (target?.scope === 'overlay' && /^\/api\/v1\/channel-ids\//.test(target.pathname)
        && Object.keys(event.params.headers).some(name => name.toLowerCase() === 'cookie')) network.metadataCookieHeaders++;
    }
    if (event.method === 'Network.responseReceived' && event.params.response.status === 200
      && /^\/api\/v1\/channel-ids\//.test(new URL(event.params.response.url).pathname)) {
      allMetadataResponses++; if (scope === 'overlay') network.metadataResponses++;
    }
    if (event.method === 'Network.webSocketCreated' && scope === 'overlay' && new URL(event.params.url).pathname.endsWith('/chat')) { network.created++; network.active.add(event.params.requestId); }
    if (event.method === 'Network.webSocketClosed' && network.active.delete(event.params.requestId)) network.closed++;
    if (event.method === 'Network.webSocketFrameSent' && scope === 'overlay' && network.active.has(event.params.requestId)) {
      try { const frame = JSON.parse(event.params.response.payloadData); network.frames.push({ type: frame.type, keys: Object.keys(frame).sort() }); } catch { network.frames.push({ type: 'invalid', keys: [] }); }
    }
    if (event.method === 'Fetch.requestPaused') void intercept(event).catch(() => errors.push('Overlay verification interception failed.'));
  });
  await viewport(1440);
  if (mode === 'production') {
    const bootstrap = new Client(), policies = await bootstrap.request('GET', '/policies');
    if (policies.status !== 200) throw Error('Isolated registration policies were unavailable.');
    const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
    const owner = await account('owner', consent), viewer = await account('viewer', consent);
    if ((await owner.client.request('POST', '/me/channel/connection', { streamKey })).status !== 200) throw Error('Isolated stream ownership could not be connected.');
    if ((await owner.client.request('PUT', '/studio', { title: '실제 공개 채팅 오버레이 검증', publisher: '오버레이 방송자' })).status !== 200) throw Error('Isolated broadcast metadata could not be configured.');
    fixture = { owner: owner.client.saved(), viewer: viewer.client.saved(), channelId: owner.channel.id, streamPath };
  } else fixture = JSON.parse(await readFile(path.join(directory, 'chat-overlay-checkpoint.json'), 'utf8'));
  await installOwner(); scope = 'management'; await navigate('/studio/integrations'); await has('[name="overlay-url"]');
  await until(() => page.evaluate(`!document.body.innerText.includes('방송 확인 중')`), 'Management public broadcast status');
  const initialUrl = await page.evaluate(`document.querySelector('[name="overlay-url"]').value`), initial = new URL(initialUrl);
  check(initial.origin === origin && initial.pathname === '/_frame/overlay/chat/' + fixture.channelId && !initial.searchParams.has('preview')
    && [...initial.searchParams.keys()].sort().join(',') === 'fontSize,hideAfterSeconds,maxMessages,theme'
    && initial.searchParams.get('theme') === 'dark' && initial.searchParams.get('fontSize') === '20'
    && initial.searchParams.get('maxMessages') === '8' && initial.searchParams.get('hideAfterSeconds') === '30'
    && await page.evaluate(`document.querySelector('[name="overlay-url"]').readOnly&&!document.body.innerText.includes('frame.example')`),
  'Owned management exposes the real public channel URL, documented defaults and no fixture URL or secret query');
  await set('[name="overlay-theme"]', 'light'); await set('[name="overlay-font-size"]', '32');
  await set('[name="overlay-max-messages"]', '2'); await set('[name="overlay-hide-after"]', '0');
  const configuredUrl = await page.evaluate(`document.querySelector('[name="overlay-url"]').value`), configured = new URL(configuredUrl);
  const previewLink = await page.evaluate(`(() => {const link=Array.from(document.querySelectorAll('a')).find(item=>item.textContent.includes('새 탭 미리보기'));return {href:link?.href,target:link?.target,rel:link?.rel};})()`);
  check(configured.searchParams.get('theme') === 'light' && configured.searchParams.get('fontSize') === '32'
    && configured.searchParams.get('maxMessages') === '2' && configured.searchParams.get('hideAfterSeconds') === '0'
    && new URL(previewLink.href).searchParams.get('preview') === '1' && previewLink.target === '_blank' && previewLink.rel.includes('noopener'),
  'Every display option updates the source URL and the separate preview link opens safely in a new tab');
  await page.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__overlayQaCopied=value;}}})`);
  await button('URL 복사'); await until(() => page.evaluate(`document.body.innerText.includes('URL을 복사했어요.')`), 'Clipboard completion state');
  check(await page.evaluate(`window.__overlayQaCopied===document.querySelector('[name="overlay-url"]').value`), 'Copy invokes the clipboard API with the complete configured public URL');
  await page.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new DOMException('Denied','NotAllowedError');}}})`);
  await button('URL 복사'); await until(() => page.evaluate(`document.body.innerText.includes('복사하지 못했어요.')`), 'Clipboard denial fallback');
  check(await page.evaluate(`(() => {const input=document.querySelector('[name="overlay-url"]');return document.activeElement===input&&input.selectionStart===0&&input.selectionEnd===input.value.length;})()`),
    'Clipboard denial explains manual copying and selects the complete read-only URL');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/channel-ids/*' }] }); metadataFailure = true;
  await click('[aria-label="방송 상태 새로고침"]'); await until(() => page.evaluate(`!!document.querySelector('main [role="alert"]')`), 'Management public status error');
  check(await page.evaluate(`document.body.innerText.includes('확인 실패')&&!!document.querySelector('[name="overlay-url"]')`), 'A failed status request preserves the usable URL and exposes a retryable error');
  metadataFailure = false; await click('[aria-label="방송 상태 새로고침"]');
  await until(() => page.evaluate(`!document.querySelector('main [role="alert"]')`), 'Management status recovers');
  await page.send('Fetch.disable');
  for (const width of [390, 320]) {
    await viewport(width); await page.evaluate('scrollTo(0,0)');
    check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&Array.from(document.querySelectorAll('[name^="overlay-"]')).every(element=>element.getBoundingClientRect().right<=innerWidth)`),
      'Management URL and display controls fit the ' + width + 'px viewport');
    await screenshot('chat-overlay-' + mode + '-management-' + width + '.png');
  }
  await viewport(400);
  if (mode === 'production') {
    check(await page.evaluate(`document.body.innerText.includes('방송 대기')`), 'The real offline channel has a usable overlay URL before broadcasting');
    await marker('start-live'); current = await liveBroadcast(streamPath);
    const viewer = new Client(fixture.viewer), owner = new Client(fixture.owner);
    const viewerSocket = await joined(viewer, current), ownerSocket = await joined(owner, current);
    const history = '연결 이전 실제 메시지', xss = '<img src=x onerror="window.__overlayQaXss=1"> & <script>attack</script>';
    await message(ownerSocket, history); await message(viewerSocket, xss);
    await overlay('hideAfterSeconds=0'); await phase('connected'); await hasMessage(history); await hasMessage(xss);
    check(await page.evaluate(`!document.querySelector('header,nav,aside,video,audio,form,input,textarea,button,[data-overlay-status]')&&document.querySelectorAll('[data-overlay-message]').length===2`),
      'A direct overlay document renders real history without app chrome, media, an editor or preview status');
    check(await page.evaluate(`!window.__overlayQaXss&&!document.querySelector('[data-overlay-messages] img,[data-overlay-messages] script')&&document.querySelector('[data-overlay-message]').textContent.includes('방송자')`),
      'Message content stays literal text and the real broadcaster identity receives its owner badge');
    check(await page.evaluate(`['html','body','#root'].every(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor==='rgba(0, 0, 0, 0)')&&getComputedStyle(document.querySelector('[data-chat-overlay]')).backgroundImage==='none'`),
      'OBS mode has transparent html, body and root backgrounds with no checkerboard');
    await overlay('theme=light&fontSize=32&maxMessages=2&hideAfterSeconds=0'); await phase('connected');
    for (const text of ['개수 제한 첫 메시지', '개수 제한 둘째 메시지', '개수 제한 마지막 메시지']) await message(viewerSocket, text);
    await hasMessage('개수 제한 마지막 메시지');
    check((await messages()).length === 2 && !(await messages()).some(value => value.includes('개수 제한 첫 메시지'))
      && await page.evaluate(`document.querySelector('[data-chat-overlay]').dataset.theme==='light'&&getComputedStyle(document.querySelector('[data-overlay-message]')).fontSize==='32px'`),
      'The selected theme and font apply while the list retains only the latest configured message count');
    await overlay('maxMessages=20&hideAfterSeconds=1'); await phase('connected');
    await until(async () => (await messages()).length === 0, 'Old history expires at its original sent time');
    await message(viewerSocket, '짧은 표시 시간 실제 메시지'); await hasMessage('짧은 표시 시간 실제 메시지');
    await until(async () => (await messages()).length === 0, 'New message TTL expires');
    check((await messages()).length === 0, 'A one-second TTL hides real messages after their server timestamp without another incoming event');
    await overlay('preview=1&maxMessages=2&hideAfterSeconds=0'); await phase('connected');
    check(await page.evaluate(`!!document.querySelector('[data-overlay-status]')&&document.body.innerText.includes('실시간 채팅에 연결됐어요.')&&getComputedStyle(document.querySelector('[data-chat-overlay]')).backgroundImage!=='none'`),
      'Only explicit preview mode shows connection status and a checkerboard behind the real chat');
    await screenshot('chat-overlay-production-preview.png');
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/channel-ids/*' }] }); metadataFailure = true;
    await phase('error');
    check((await messages()).length === 0 && await page.evaluate(`!!document.querySelector('[data-overlay-retry]')`), 'A failed public channel refresh clears stale chat and offers retry in preview');
    metadataFailure = false; await click('[data-overlay-retry]'); await phase('connected'); await page.send('Fetch.disable');
    await overlay('hideAfterSeconds=0'); await phase('connected'); await hasMessage(history);
    const previousId = current.id; await marker('end-live'); await phase('waiting');
    check((await messages()).length === 0 && await page.evaluate(`!document.querySelector('[data-overlay-status]')`), 'Ending the actual source clears the overlay and leaves OBS waiting transparently');
    await marker('restart-live'); current = await liveBroadcast(streamPath);
    if (current.id === previousId) throw Error('The restarted dedicated source did not create a new broadcast room.');
    await phase('connected');
    check((await messages()).length === 0, 'Restarting the same stream path joins a distinct room with no messages leaking from the prior broadcast');
    const newSocket = await joined(viewer, current); await message(newSocket, '새 방송 실제 채팅'); await hasMessage('새 방송 실제 채팅');
    check(!(await messages()).some(value => value.includes(history)), 'The overlay receives the new room while prior-broadcast content stays absent');
    await writeFile(path.join(directory, 'chat-overlay-checkpoint.json'), JSON.stringify({ ...fixture, broadcast: current }));
  } else {
    current = fixture.broadcast; await overlay('hideAfterSeconds=0'); await phase('connected'); await hasMessage('새 방송 실제 채팅');
    const source = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
    check(source.includes('StrictMode') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&document.querySelectorAll('[data-chat-overlay]').length===1`),
      'Development StrictMode mounts one standalone overlay against the real running broadcast');
  }
  // Polling the same broadcast must retain one live socket; this also catches StrictMode effect leaks.
  const createdBefore = network.created, responsesBefore = network.metadataResponses;
  await until(() => network.metadataResponses > responsesBefore, 'A real public metadata poll', 16000); await sleep(250);
  check(network.active.size === 1 && network.created === createdBefore, 'Polling unchanged live metadata retains exactly one active chat socket');
  check(safeNetwork(), 'The cookie-bearing browser uses only cookie-free public metadata GETs and ticketless join frames; no session, ticket, media, history, points or send writes occur');
  check(managementWrites.length === 0, 'Management URL options, copy handling, status retry and mobile views make no data-changing requests');
  scope = 'idle';
  await page.evaluate(`history.pushState(null,'','/_frame/studio/integrations');dispatchEvent(new PopStateEvent('popstate'))`);
  await has('[name="overlay-url"]'); await until(() => network.active.size === 0, 'SPA overlay socket cleanup');
  await until(() => page.evaluate(`!document.body.innerText.includes('방송 확인 중')`), 'Management status after SPA unmount'); await sleep(500);
  const metadataAfterUnmount = allMetadataResponses; await sleep(5500);
  check(network.active.size === 0 && allMetadataResponses === metadataAfterUnmount
    && await page.evaluate(`getComputedStyle(document.documentElement).backgroundColor!=='rgba(0, 0, 0, 0)'`),
    'SPA unmount closes every overlay socket, stops its poll and restores the normal page background');
  check(errors.length === 0, 'All overlay and management interactions finish without browser runtime exceptions');
  complete = true;
} catch (failure) {
  console.error(failure.message);
  results.push({ name: failure.message, pass: false }); process.exitCode = 1;
} finally {
  for (const socket of fixtureSockets) { socket.close(); socket.destroy(); }
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'chat-overlay-' + mode + '-result.json'), JSON.stringify({ complete, mode, origin, dedicatedFixtureCookiesOnly: true,
    browser: 'Headless Microsoft Edge (Chromium); OBS CEF not exercised', results, runtimeExceptionCount: errors.length,
    browserDataChangingRequestCount: managementWrites.length + network.requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length,
    overlayProductRequestCount: network.requests.filter(request => request.path.startsWith('/api/')).length,
    overlayJoinFrameCount: network.frames.filter(frame => frame.type === 'join').length, overlayUnexpectedFrameCount: network.frames.filter(frame => frame.type !== 'join' || frame.keys.join(',') !== 'broadcastId,type').length,
    publicMetadataCookieHeaderCount: network.metadataCookieHeaders, overlaySocketsCreated: network.created, overlaySocketClosedEvents: network.closed,
    overlayActiveSocketsAfterUnmount: network.active.size }, null, 2));
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
