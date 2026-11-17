// Headless Edge against real isolated accounts. Failure injection only affects this owned browser's chatbot requests.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { killByCommandLine } from './harness.mjs';
import { Client, origin, joinAccount, sendMessage } from './chat-moderation-client.mjs';

const mode = process.argv[2] ?? 'production';
if (!['production', 'dev', 'capture'].includes(mode)) throw Error('Unknown chatbot verification mode.');
const root = path.resolve('.'), output = path.join(root, 'verification/product'), directory = path.resolve(process.env.FRAME_CHATBOT_TEST_DIR ?? '');
const expectedParent = path.resolve(process.env.LOCALAPPDATA, 'Frame/verification');
if (!process.env.FRAME_CHATBOT_TEST_DIR || path.dirname(directory).toLowerCase() !== expectedParent.toLowerCase() || !/^chatbot-[a-f0-9]{12}$/.test(path.basename(directory))) throw Error('The exact private external chatbot fixture directory is required.');
const fixture = JSON.parse(await readFile(path.join(directory, 'chatbot-checkpoint.json'), 'utf8'));
const profile = path.join(directory, 'browser-' + mode, 'profile'), port = mode === 'dev' ? 9551 : 9550;
await mkdir(profile, { recursive: true });
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const results = [], errors = [], sockets = [], writes = [], pending = new Set(), canceled = new Set(), fixtureApiWrites = [];
const owner = new Client(fixture.owner), viewer = new Client(fixture.viewer);
for (const client of [owner, viewer]) {
  const original = client.request.bind(client);
  client.request = async (method, route, ...rest) => { if (!['GET', 'HEAD'].includes(method)) fixtureApiWrites.push({ method, route: route.split('?')[0] }); return original(method, route, ...rest); };
}
const browserNetwork = { productWrites: 0, chatSends: 0, botEvents: 0 };
let page, complete = false, failure, uncertain = false, fixtureRawSends = 0;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label, duration = 16000) {
  const end = Date.now() + duration;
  while (Date.now() < end) { if (await test()) return; await sleep(100); }
  throw Error('Timeout: ' + label);
}
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const text = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigate(route) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__chatbotDocument=${JSON.stringify(marker)}`);
  await page.send('Page.navigate', { url: origin + '/_frame' + route });
  await until(async () => { try { return await page.evaluate(`window.__chatbotDocument!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New chatbot verification document');
}
async function click(selector) {
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control ' + selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing chatbot input');const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function install(account) {
  await page.send('Network.clearBrowserCookies');
  await page.send('Network.setCookies', { cookies: account.cookies.map(cookie => ({ ...cookie, url: origin + '/', path: '/', secure: false, sameSite: 'Lax' })) });
}
async function viewport(width) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
  await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
}
async function screenshot(name) {
  await page.evaluate(`document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
  // A viewport capture follows the actual scroll position; the shared helper's explicit (0,0) clip targets page origin.
  const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  await writeFile(path.join(output, name), Buffer.from(result.data, 'base64'));
}
async function config() { const response = await owner.request('GET', '/me/chat/bot'); if (response.status !== 200) throw Error('Owned chatbot configuration is unavailable.'); return response.data; }
const formValue = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`);
async function intercept(event) {
  const { requestId, request, responseStatusCode, networkId } = event.params;
  try {
    if (responseStatusCode !== undefined) {
      if (uncertain && request.method === 'PATCH') { uncertain = false; await page.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }); return; }
      await page.send('Fetch.continueResponse', { requestId }); return;
    }
    if (failure?.method === request.method) {
      const active = failure; failure = null;
      await page.send('Fetch.fulfillRequest', { requestId, responseCode: active.status ?? 503,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
        body: Buffer.from(JSON.stringify({ code: active.code ?? 'PRODUCT_UNAVAILABLE', detail: '검증용 일시 오류' })).toString('base64') }); return;
    }
    await page.send('Fetch.continueRequest', { requestId });
  } catch (error) {
    if (/Invalid InterceptionId/.test(error.message) && networkId) {
      await sleep(100); if (canceled.has(networkId)) return;
    }
    errors.push('Owned chatbot request interception failed.');
  }
}

try {
  await mkdir(output, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) { try { page = await connect(port, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('The isolated chatbot browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push('Browser runtime exception.');
    if (event.method === 'Network.loadingFailed' && event.params.canceled) canceled.add(event.params.requestId);
    if (event.method === 'Network.requestWillBeSent' && new URL(event.params.request.url).pathname === '/api/v1/me/chat/bot' && event.params.request.method === 'PATCH') writes.push('PATCH');
    if (event.method === 'Network.requestWillBeSent' && new URL(event.params.request.url).pathname.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(event.params.request.method)) browserNetwork.productWrites++;
    if (['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(event.method)) {
      try {
        const frame = JSON.parse(event.params.response.payloadData);
        if (event.method === 'Network.webSocketFrameSent' && frame.type === 'send') browserNetwork.chatSends++;
        if (event.method === 'Network.webSocketFrameReceived' && frame.type === 'message' && frame.isBot === true) browserNetwork.botEvents++;
      } catch {}
    }
    if (event.method === 'Fetch.requestPaused') { const active = intercept(event); pending.add(active); void active.finally(() => pending.delete(active)); }
  });
  await viewport(1440); await install(fixture.owner);
  if (mode === 'capture') {
    await navigate('/studio/integrations'); await has('[data-chatbot-form]');
    for (const width of [390, 320]) {
      await viewport(width); await page.evaluate(`document.querySelector('[data-chatbot-settings]').scrollIntoView({block:'start'});scrollBy(0,-88)`);
      await until(() => page.evaluate(`document.querySelector('[data-chatbot-settings]').getBoundingClientRect().top<innerHeight`), 'Visible management capture target');
      check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[data-chatbot-settings]').getBoundingClientRect().width>0`), 'Real chatbot form fits the ' + width + 'px capture viewport');
      await screenshot('chatbot-production-management-' + width + '.png');
    }
    complete = true;
  } else {
  if (mode === 'production') {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/me/chat/bot', requestStage: 'Request' }, { urlPattern: '*api/v1/me/chat/bot', requestStage: 'Response' }] });
    failure = { method: 'GET' }; await navigate('/studio/integrations'); await has('[data-chatbot-retry]');
    check(await page.evaluate(`!document.querySelector('[data-chatbot-form]')&&!!document.querySelector('[name="overlay-url"]')`), 'A failed chatbot load offers retry and preserves existing overlay management');
    await click('[data-chatbot-retry]'); await has('[data-chatbot-form]');
  } else { await navigate('/studio/integrations'); await has('[data-chatbot-form]'); }
  let saved = await config();
  check(await page.evaluate(`document.querySelectorAll('[data-chatbot-rule]').length===${saved.commands.length}&&document.querySelector('[name="chatbot-enabled"]').checked===${saved.enabled}`), 'The actual saved channel rules and global state load into the management form');
  check(await page.evaluate(`!!document.querySelector('[name="overlay-url"]')&&document.body.innerText.includes('API 및 웹훅')`), 'Existing overlay tools and the remaining integration rows are preserved');
  if (mode === 'production') {
    await click('[data-chatbot-add]');
    const id = await page.evaluate(`Array.from(document.querySelectorAll('[data-chatbot-rule]')).at(-1).dataset.commandId`);
    check(/^[a-f0-9-]{36}$/.test(id) && await formValue(`[name="chatbot-cooldown-${id}"]`) === '15', 'Adding a rule allocates a stable UUID and the documented fifteen-second default');
    const command = `[name="chatbot-command-${id}"]`, response = `[name="chatbot-response-${id}"]`, cooldown = `[name="chatbot-cooldown-${id}"]`;
    await set(command, '!uitest'); await set(response, '브라우저에서 저장한 실제 자동 응답'); await set(cooldown, '5');
    failure = { method: 'PATCH' }; await click('[data-chatbot-save]'); await has('[data-chatbot-settings] [role="alert"]');
    await until(() => page.evaluate(`!document.querySelector('[data-chatbot-settings] [aria-busy="true"]')`), 'Failed-save verification finishes');
    check(await formValue(response) === '브라우저에서 저장한 실제 자동 응답' && !(await config()).commands.some(value => value.id === id), 'A failed save preserves the draft and leaves persisted configuration unchanged');
    await click('[data-chatbot-save]');
    await until(async () => (await config()).commands.some(value => value.id === id), 'Actual UI configuration write');
    saved = await config();
    check(saved.commands.find(value => value.id === id)?.command === '!uitest' && saved.commands.find(value => value.id === id)?.cooldownSeconds === 5, 'Saving the management form performs a real versioned configuration write');
    for (const width of [390, 320]) {
      await viewport(width);
      check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth&&Array.from(document.querySelectorAll('[data-chatbot-form] input,[data-chatbot-form] textarea,[data-chatbot-form] button')).every(element=>element.getBoundingClientRect().right<=innerWidth+1)`), 'Chatbot controls fit the ' + width + 'px emulated viewport');
      await page.evaluate(`document.querySelector('[data-chatbot-settings]').scrollIntoView({block:'start'})`); await screenshot('chatbot-production-management-' + width + '.png');
    }
    await viewport(1440);
    await set(response, '보존할 충돌 초안');
    let external = await config();
    check((await owner.request('PATCH', '/me/chat/bot', { version: external.version, enabled: external.enabled, commands: external.commands.map(value => value.id === id ? { ...value, response: '다른 탭에서 저장한 응답' } : value) })).status === 200, 'A real concurrent update advances the shared configuration version');
    await click('[data-chatbot-save]'); await has('[data-chatbot-refresh]');
    check(await formValue(response) === '보존할 충돌 초안' && (await config()).commands.find(value => value.id === id)?.response === '다른 탭에서 저장한 응답', 'A real HTTP 409 preserves the local draft and the newer server configuration');
    await click('[data-chatbot-refresh]'); await until(() => page.evaluate(`!document.querySelector('[data-chatbot-refresh]')`), 'Explicit latest-setting check');
    check(await formValue(response) === '보존할 충돌 초안', 'Checking the newer version preserves the draft for deliberate review');
    await click('[data-chatbot-reset]'); await until(async () => await formValue(response) === '다른 탭에서 저장한 응답', 'Reset to newer saved values');
    await set(response, '응답 유실 후 실제 저장 확인'); uncertain = true; failure = { method: 'GET' }; await click('[data-chatbot-save]'); await has('[data-chatbot-verify]');
    check((await config()).commands.find(value => value.id === id)?.response === '응답 유실 후 실제 저장 확인', 'An interrupted HTTP response is tested after the server actually commits the write');
    await click('[data-chatbot-verify]'); await until(() => page.evaluate(`!document.querySelector('[data-chatbot-verify]')`), 'Uncertain save verification');
    check(await formValue(response) === '응답 유실 후 실제 저장 확인', 'Explicit verification resolves an uncertain save from the real server state');
    await set(response, '되돌릴 초안'); await click('[data-chatbot-reset]');
    await until(async () => await formValue(response) === '응답 유실 후 실제 저장 확인', 'Draft reset');
    check((await config()).commands.find(value => value.id === id)?.response === '응답 유실 후 실제 저장 확인', 'Discarding a draft restores saved values without writing the server');
    await set(response, '오프라인 보존 초안');
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.evaluate(`dispatchEvent(new Event('offline'))`);
    await until(() => page.evaluate(`document.querySelector('[data-chatbot-save]').disabled`), 'Offline saving locks');
    check(await formValue(response) === '오프라인 보존 초안' && (await config()).commands.find(value => value.id === id)?.response === '응답 유실 후 실제 저장 확인', 'An actual offline browser preserves the draft and blocks an unsendable save');
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.evaluate(`dispatchEvent(new Event('online'))`); await click('[data-chatbot-reset]');
    await page.send('Fetch.disable');
    await install(fixture.viewer); await navigate('/studio/integrations'); await has('[data-chatbot-form]');
    check(await page.evaluate(`document.querySelectorAll('[data-chatbot-rule]').length===0&&!document.querySelector('[name="chatbot-enabled"]').checked`), 'Changing accounts clears the previous owner rules and loads the second account defaults');
    await install(fixture.owner);
  } else {
    const source = await page.evaluate(`fetch('/_frame/src/main.tsx').then(response=>response.text())`);
    check(source.includes('StrictMode') && await page.evaluate(`!!document.querySelector('script[src*="/@vite/client"]')&&document.querySelectorAll('[data-chatbot-form]').length===1`), 'Development StrictMode mounts exactly one real chatbot form');
    check(writes.length === 0, 'Read-only development loading does not save or mutate chatbot configuration');
  }
  await navigate('/overlay/chat/' + fixture.channelId + '?hideAfterSeconds=0&maxMessages=20');
  await until(() => page.evaluate(`document.querySelector('[data-chat-overlay]')?.dataset.phase==='connected'`), 'Anonymous real overlay connection');
  const joined = await joinAccount(viewer, fixture.broadcast); sockets.push(joined.socket);
  await sleep(5100); fixtureRawSends++; const ack = await sendMessage(joined.socket, '!정보');
  check(ack?.ok, 'The real viewer receives a successful human-message acknowledgement');
  const freshBot = await joined.socket.wait(event => event.type === 'message' && event.isBot === true && event.text.includes('실제 서버 응답'));
  check(Boolean(freshBot?.id), 'The accepted fixture command produces a newly observed authoritative bot event');
  await has('[data-chat-bot-badge]');
  await until(() => page.evaluate(`Array.from(document.querySelectorAll('[data-overlay-message]')).some(element=>element.dataset.messageId===${JSON.stringify(freshBot.id)}&&!!element.querySelector('[data-chat-bot-badge]'))`), 'Fresh bot event reaches the anonymous overlay');
  check(await page.evaluate(`!document.querySelector('input,textarea,button,form,video')&&Array.from(document.querySelectorAll('[data-overlay-message]')).some(element=>element.querySelector('[data-chat-bot-badge]')&&element.textContent.includes('실제 서버 응답'))&&!document.querySelector('[data-overlay-messages] img')`), 'The anonymous read-only overlay renders the authoritative bot badge and literal server text');
  await screenshot('chatbot-' + mode + '-overlay.png');
  await navigate('/watch/' + fixture.streamPath + '/' + fixture.broadcast.id);
  await has('[data-chat-bot-badge]');
  check(await page.evaluate(`Array.from(document.querySelectorAll('[data-chat-bot-badge]')).some(element=>element.textContent.includes('봇'))`), 'Normal live chat preserves the authoritative bot badge in its real message history');
  await until(() => page.evaluate(`!!document.querySelector('aside textarea')&&!document.querySelector('aside textarea').readOnly`), 'Authenticated normal chat composer');
  const previousBadges = await page.evaluate(`document.querySelectorAll('[data-chat-bot-badge]').length`);
  await sleep(1100); await set('aside textarea', '!CHAIN'); await click('aside form button[type="submit"]');
  await until(async () => await formValue('aside textarea') === '', 'A real browser command acknowledgement clears the draft');
  const browserBot = await joined.socket.wait(event => event.type === 'message' && event.isBot && event.text === '!정보');
  await until(() => page.evaluate(`document.querySelectorAll('[data-chat-bot-badge]').length===${previousBadges + 1}`), 'A newly triggered bot badge renders in normal chat');
  check(Boolean(browserBot?.id), 'The actual browser composer command triggers a new server bot event and normal-chat badge');
  const ordinary = '일반 채팅 회귀 검증 ' + mode;
  await set('aside textarea', ordinary); await click('aside form button[type="submit"]');
  await until(async () => await formValue('aside textarea') === '', 'Real accepted chat acknowledgement clears the draft');
  const ordinaryEvent = await joined.socket.wait(event => event.type === 'message' && event.text === ordinary);
  check(ordinaryEvent?.isOwner === true && !ordinaryEvent.isBot, 'The normal browser composer still sends an acknowledged owner message with its human identity');
  await page.send('Network.clearBrowserCookies'); await navigate('/watch/' + fixture.streamPath + '/' + fixture.broadcast.id); await has('aside textarea');
  await has('aside [data-chat-bot-badge]');
  await until(() => page.evaluate(`document.querySelector('aside textarea').readOnly`), 'Anonymous normal chat read-only state');
  check(await page.evaluate(`document.querySelector('aside textarea').readOnly&&!!document.querySelector('[data-chat-bot-badge]')&&document.body.innerText.includes('로그인')`), 'Anonymous normal chat remains read-only while retaining public bot history');
  check(errors.length === 0, 'Chatbot management and chat interactions finish without browser runtime exceptions');
  complete = true;
  }
} catch (error) { console.error(error.message); if (results.at(-1)?.name !== error.message || results.at(-1)?.pass !== false) results.push({ name: error.message, pass: false }); process.exitCode = 1; }
finally {
  for (const socket of sockets) { socket.close(); socket.destroy(); }
  await Promise.allSettled([...pending]);
  await writeFile(path.join(output, 'chatbot-' + mode + '-result.json'), JSON.stringify({ complete, mode, origin,
    dedicatedFixtureCookiesOnly: true, browser: 'Headless Microsoft Edge (Chromium); OBS CEF not exercised', results,
    runtimeExceptionCount: errors.length, browserConfigurationWriteCount: writes.length, browserProductWriteCount: browserNetwork.productWrites,
    browserChatSendFrameCount: browserNetwork.chatSends, browserLiveBotEventCount: browserNetwork.botEvents,
    directFixtureApiWrites: fixtureApiWrites, directFixtureRawChatSendCount: fixtureRawSends,
    limits: ['Emulated mobile viewport only; no physical phone', 'Single PC and loopback only'] }, null, 2));
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); }
  browser.kill(); killByCommandLine(profile);
}
