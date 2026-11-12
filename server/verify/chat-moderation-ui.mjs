// Real account chat policies and owner management UI, against the separate verification API only.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, sleep } from '../../tools/cdp.mjs';
import { Client, api, origin, openSocket, joinAccount, sendMessage, liveBroadcast } from './chat-moderation-client.mjs';

const suffix = randomBytes(5).toString('hex'), password = randomBytes(20).toString('base64url'), output = path.resolve('verification/product');
const directory = path.resolve(process.env.FRAME_CHAT_TEST_DIR ?? ''), relative = path.relative(path.resolve('.'), directory);
if (!process.env.FRAME_CHAT_TEST_DIR || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('A private external chat fixture directory is required.');
const fixtureStreamKey = process.env.FRAME_CHAT_FIXTURE_STREAM_KEY, fixturePath = fixtureStreamKey?.split('?')[0];
if (!fixtureStreamKey || !/^obs-chat-[0-9a-f]{12}$/.test(fixturePath ?? '')) throw Error('The dedicated isolated chat stream credential is required.');
const browserDirectory = await mkdtemp(path.join(tmpdir(), 'frame-chat-moderation-ui-')), profile = path.join(browserDirectory, 'profile');
const results = [], errors = [], writes = [], sockets = [], confirmedCanceledInterceptions = [], interactions = [];
const policyDiagnostics = [];
const interceptedRequests = new Map(), canceledNetworkRequests = new Set(), pendingInterceptions = new Set();
let page, nextFailure, holdMutation = false, heldMutation, blockPageLimit = false;
const browser = spawn(process.env.FRAME_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', '--remote-debugging-port=9510', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
async function until(test, label) { for (let i = 0; i < 120; i++) { if (await test()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const has = selector => until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
const visibleText = value => until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), value);
async function navigateDocument(method, parameters) {
  const marker = randomBytes(8).toString('hex'); await page.evaluate(`window.__chatQaNavigation=${JSON.stringify(marker)}`);
  await page.send(method, parameters);
  await until(async () => { try { return await page.evaluate(`window.__chatQaNavigation!==${JSON.stringify(marker)}&&document.readyState==='complete'`); } catch { return false; } }, 'New chat management document');
}
async function nav(route) { await navigateDocument('Page.navigate', { url: origin + '/_frame' + route }); }
async function reload() { await navigateDocument('Page.reload', {}); }
async function click(selector) {
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).matches(':disabled')`), 'Enabled control: ' + selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await page.click(selector);
}
async function button(label, scope = 'document') {
  await until(() => page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});return !!element&&!element.matches(':disabled');})()`), 'Enabled button: ' + label);
  await page.evaluate(`(() => {const element=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});element.dataset.chatQaTarget='true';element.scrollIntoView({block:'center'});})()`);
  await until(() => page.evaluate(`(() => {const element=document.querySelector('[data-chat-qa-target]');if(!element||element.matches(':disabled'))return false;const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===element;})()`), 'Clickable button: ' + label);
  interactions.push({ label, phase: 'before', ...(await snapshot()) }); await page.click('[data-chat-qa-target]');
  interactions.push({ label, phase: 'after', ...(await snapshot()) }); if (interactions.length > 30) interactions.splice(0, interactions.length - 30);
  await page.evaluate(`document.querySelector('[data-chat-qa-target]')?.removeAttribute('data-chat-qa-target')`);
}
async function set(selector, value) {
  await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Missing input');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function switchTo(label, enabled) { const selector = `[role="switch"][aria-label="${label}"]`; if (await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.checked`) !== enabled) await click(selector); }
async function snapshot() {
  return page.evaluate(`(() => {const e=document.querySelector('[data-chat-qa-target]'),r=e?.getBoundingClientRect();return {path:location.pathname,visibility:document.visibilityState,focused:document.hasFocus(),dialogOpen:!!document.querySelector('dialog[open]'),target:e?{disabled:e.matches(':disabled'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}:null};})()`);
}
async function interceptionCommand(command, parameters) {
  const request = interceptedRequests.get(parameters.requestId);
  try { return await page.send(command, parameters); }
  catch (failure) {
    if (/Invalid InterceptionId\.?/.test(failure.message) && request?.networkId) {
      if (!canceledNetworkRequests.has(request.networkId)) await sleep(100);
      if (canceledNetworkRequests.has(request.networkId)) { confirmedCanceledInterceptions.push({ method: request.method, path: request.path, command, confirmedBy: 'Network.loadingFailed:canceled' }); return; }
    }
    failure.chatQaContext = { source: 'Fetch', method: request?.method ?? null, path: request?.path ?? null, command, hasNetworkId: Boolean(request?.networkId), error: failure.message }; throw failure;
  } finally { interceptedRequests.delete(parameters.requestId); }
}
async function fulfill(requestId, failure) {
  await interceptionCommand('Fetch.fulfillRequest', { requestId, responseCode: failure.status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(JSON.stringify({ code: failure.code, detail: failure.detail })).toString('base64') });
}
async function intercept(event) {
  const { requestId, request } = event.params, url = new URL(request.url);
  interceptedRequests.set(requestId, { networkId: event.params.networkId, method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') });
  if (request.method !== 'GET') writes.push({ method: request.method, path: url.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') });
  if (nextFailure?.matches(request.method, url)) { const failure = nextFailure; nextFailure = null; await fulfill(requestId, failure); return; }
  if (holdMutation && request.method !== 'GET') { heldMutation = requestId; return; }
  if (blockPageLimit && request.method === 'GET' && url.pathname === '/api/v1/me/chat/blocks') { url.searchParams.set('limit', '2'); await interceptionCommand('Fetch.continueRequest', { requestId, url: url.href }); return; }
  await interceptionCommand('Fetch.continueRequest', { requestId });
}
const failure503 = (method, endpoint, detail, cursor = false) => ({ status: 503, code: 'PRODUCT_UNAVAILABLE', detail, matches: (actual, url) => actual === method && url.pathname === '/api/v1' + endpoint && (!cursor || url.searchParams.has('cursor')) });
async function createAccount(kind, consent) {
  const client = new Client(); await client.request('GET', '/session');
  const email = `chat_moderation_ui_${kind}_${suffix}@example.invalid`, displayName = `채팅 검증 ${kind} ${suffix}`;
  const response = await client.request('POST', '/auth/register', { email, password, displayName, ...consent });
  if (response.status !== 201) throw Error('Dedicated chat account registration returned HTTP ' + response.status);
  return { client, email, displayName, user: response.data.user, channel: response.data.channel };
}
async function login(account) {
  await page.send('Network.clearBrowserCookies'); await nav('/login'); await has('#account-email');
  await set('[name=email]', account.email); await set('[name=password]', password); await click('main form button[type=submit]'); await has('[aria-label="내 계정"]');
}
async function screenshot(name) { await page.evaluate('document.fonts.ready'); await writeFile(path.join(output, name), await page.screenshot()); }
async function marker(name, value) { const target = path.join(directory, name), temporary = target + '.tmp'; await writeFile(temporary, JSON.stringify(value)); await rename(temporary, target); }
function expire(block) {
  try { execFileSync(process.execPath, [path.resolve('server/verify/chat-moderation-fixture.mjs'), 'expire', block.id], { windowsHide: true, stdio: 'pipe', timeout: 15000 }); }
  catch { throw Error('The exact isolated block expiry fixture could not be advanced.'); }
}
async function rememberJoin(client, broadcast, extra) { const joined = await joinAccount(client, broadcast, extra); sockets.push(joined.socket); return joined; }

try {
  await mkdir(output, { recursive: true });
  for (let i = 0; i < 60; i++) { try { page = await connect(9510, target => !target.url.startsWith('edge://')); break; } catch { await sleep(100); } }
  if (!page) throw Error('Chat moderation QA browser was unavailable.');
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  page.on(event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
    if (event.method === 'Network.loadingFailed' && event.params.canceled === true) canceledNetworkRequests.add(event.params.requestId);
    if (event.method === 'Fetch.requestPaused') { const pending = intercept(event).catch(failure => errors.push(failure.chatQaContext ?? failure.message)); pendingInterceptions.add(pending); void pending.finally(() => pendingInterceptions.delete(pending)); }
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const bootstrap = new Client(), policies = await bootstrap.request('GET', '/policies');
  if (policies.status !== 200) throw Error('Signup policies are unavailable in the isolated app.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  const owner = await createAccount('owner', consent), viewer = await createAccount('viewer', consent), visitor = await createAccount('visitor', consent), other = await createAccount('other', consent);
  let response = await owner.client.request('POST', '/me/channel/connection', { streamKey: fixtureStreamKey });
  if (response.status !== 200) throw Error('Dedicated stream ownership connection returned HTTP ' + response.status);
  response = await owner.client.request('PUT', '/studio', { title: `채팅 정책 실제 연동 ${suffix}`, publisher: owner.displayName });
  if (response.status !== 200) throw Error('Dedicated broadcast metadata returned HTTP ' + response.status);
  await marker('ready-live.json', { path: fixturePath }); const broadcast = await liveBroadcast(fixturePath);
  let settings = (await owner.client.request('GET', '/me/chat/settings')).data;
  check(settings.userId === owner.user.id && settings.channelId === owner.channel.id && settings.version === 0 && !settings.slowMode && !settings.followersOnly && !settings.blockLinks && settings.slowSeconds === 5 && settings.bannedWords.length === 0, 'A real new channel starts with the documented private moderation defaults');
  const input = (value, changes = {}) => ({ version: value.version, slowMode: value.slowMode, slowSeconds: value.slowSeconds, followersOnly: value.followersOnly, blockLinks: value.blockLinks, bannedWords: value.bannedWords, ...changes });
  async function policy(changes) { const result = await owner.client.request('PATCH', '/me/chat/settings', input(settings, changes)); if (result.status !== 200) throw Error('Real policy update returned HTTP ' + result.status); settings = result.data; return settings; }
  const anonymous = new Client(); await anonymous.request('GET', '/session');
  const anonymousSettings = await anonymous.request('GET', '/me/chat/settings'), anonymousTicket = await anonymous.request('POST', '/chat/tickets', { path: fixturePath, broadcastId: broadcast.id });
  const mismatched = await viewer.client.request('GET', '/me/chat/settings', undefined, { expectedUserId: owner.user.id });
  check(anonymousSettings.status === 401 && anonymousTicket.status === 401 && mismatched.status === 409 && mismatched.data.code === 'SESSION_CHANGED', 'Private moderation and ticket APIs require a real account and reject a changed account scope');
  const hostileOrigin = await openSocket(fixturePath, { socketOrigin: 'https://untrusted.example.invalid' }); sockets.push(hostileOrigin);
  check(hostileOrigin.status === 403, 'The product WebSocket rejects a foreign Origin before joining a room');
  const ownerRoom = await rememberJoin(owner.client, broadcast), guest = await openSocket(fixturePath); sockets.push(guest);
  guest.send({ type: 'join', broadcastId: broadcast.id, name: owner.displayName, userId: owner.user.id }); const guestState = await guest.wait(event => event.type === 'state');
  const guestAck = await sendMessage(guest, '로그인하지 않은 사칭 전송');
  check(guestState?.connected && guestState.authenticated === false && guestState.canSend === false && guestState.userId === null && guestAck?.ok === false && guestAck.code === 'CHAT_LOGIN_REQUIRED', 'A guest can read chat but cannot gain the supplied account identity or send a message');
  const joined = await rememberJoin(viewer.client, broadcast, { name: owner.displayName, userId: owner.user.id });
  check(joined.state?.authenticated && joined.state.userId === viewer.user.id && joined.state.authorChannelId === viewer.channel.id && joined.state.displayName === viewer.displayName, 'A valid ticket fixes the real account and ignores spoofed join name and user ID');
  const acceptedText = '실제 계정 발신 검증 ' + suffix, accepted = await sendMessage(joined.socket, acceptedText, { authorId: owner.user.id, author: owner.displayName });
  const delivered = await ownerRoom.socket.wait(event => event.type === 'message' && event.text === acceptedText);
  check(accepted?.ok && delivered?.authorChannelId === viewer.channel.id && delivered.authorHandle === viewer.channel.handle && delivered.isOwner === false && delivered.author === viewer.displayName
    && !Object.hasOwn(delivered, 'authorId') && !JSON.stringify(delivered).includes(viewer.user.id), 'Delivered messages use server-owned public channel identity and keep the internal account UUID private');
  const replay = await openSocket(fixturePath); sockets.push(replay); replay.send({ type: 'join', broadcastId: broadcast.id, ticket: joined.ticket.ticket });
  const replayState = await replay.wait(event => event.type === 'state'), replayClose = await replay.wait(event => event.type === '_closeFrame');
  check(replayState?.connected === false && replayState.code === 'CHAT_AUTH_INVALID' && replayClose?.code === 1008, 'A consumed account chat ticket cannot be replayed on another socket');
  const visitorRoom = await rememberJoin(visitor.client, broadcast); await visitor.client.request('POST', '/auth/logout');
  const loggedOut = await sendMessage(visitorRoom.socket, '로그아웃 뒤 전송');
  check(loggedOut?.ok === false && loggedOut.code === 'CHAT_SESSION_EXPIRED', 'An already open socket loses send authority after its actual Redis session is logged out');
  await visitor.client.request('GET', '/session'); await visitor.client.request('POST', '/auth/login', { email: visitor.email, password, remember: false });
  await policy({ blockLinks: true, bannedWords: ['blockme'] });
  const link = await sendMessage(joined.socket, 'https://example.invalid/test'), ownerLink = await sendMessage(ownerRoom.socket, 'https://example.invalid/owner');
  const word = await sendMessage(joined.socket, 'ＢＬＯＣＫＭＥ'), ownerWord = await sendMessage(ownerRoom.socket, 'BLOCKME');
  check(link?.code === 'CHAT_LINK_BLOCKED' && ownerLink?.code === 'CHAT_LINK_BLOCKED' && word?.code === 'CHAT_WORD_BLOCKED' && ownerWord?.code === 'CHAT_WORD_BLOCKED', 'Live link and NFKC case-insensitive word policies also apply to the broadcaster');
  joined.socket.events.length = 0; await policy({ blockLinks: false, bannedWords: [], followersOnly: true });
  await until(() => joined.socket.events.some(event => event.type === 'state'), 'Policy update after link and word rejection');
  check(!['CHAT_LINK_BLOCKED', 'CHAT_WORD_BLOCKED'].includes(joined.socket.events.filter(event => event.type === 'state').at(-1)?.code), 'A settings update does not reapply stale link or banned-word refusal state');
  const notFollowing = await sendMessage(joined.socket, '팔로우 전'); await viewer.client.request('PUT', `/me/follows/${owner.channel.id}`, {});
  const following = await sendMessage(joined.socket, '팔로우 후'); await viewer.client.request('DELETE', `/me/follows/${owner.channel.id}`);
  const unfollowed = await sendMessage(joined.socket, '팔로우 해제 뒤'), ownerExempt = await sendMessage(ownerRoom.socket, '소유자 팔로우 면제');
  check(notFollowing?.code === 'CHAT_FOLLOW_REQUIRED' && following?.ok && unfollowed?.code === 'CHAT_FOLLOW_REQUIRED' && ownerExempt?.ok, 'Follower-only enforcement follows actual stored follows immediately and exempts only the owner');
  await policy({ followersOnly: false, slowMode: true, slowSeconds: 2 }); await sleep(2100);
  const secondTab = await rememberJoin(viewer.client, broadcast), firstSlow = await sendMessage(joined.socket, '같은 계정 첫 전송'), slow = await sendMessage(secondTab.socket, '다른 탭으로 우회');
  await sleep(2100); const afterSlow = await sendMessage(secondTab.socket, '간격 후 전송');
  const ownerFastA = await sendMessage(ownerRoom.socket, '소유자 빠른 전송 하나'), ownerFastB = await sendMessage(ownerRoom.socket, '소유자 빠른 전송 둘');
  check(firstSlow?.ok && slow?.code === 'CHAT_SLOW_MODE' && slow.retryAfterMs > 0 && afterSlow?.ok && ownerFastA?.ok && ownerFastB?.ok, 'Slow chat shares its timer across account tabs, recovers after the interval and exempts the owner');
  const lastSlow = await sendMessage(joined.socket, '다시 빠르게 전송');
  if (lastSlow?.code !== 'CHAT_SLOW_MODE') throw Error('The slow-state reset fixture did not reach its intended refusal.');
  joined.socket.events.length = 0; await policy({ slowMode: false });
  await until(() => joined.socket.events.some(event => event.type === 'state'), 'Policy update after slow refusal');
  check(joined.socket.events.filter(event => event.type === 'state').at(-1)?.code !== 'CHAT_SLOW_MODE', 'Disabling slow mode clears a previous slow-mode refusal on the open socket');
  // The relay also has an independent 8/10s per-socket abuse limit. Continue on the already verified second tab so
  // rejected policy fixtures do not accidentally turn the following account-block checks into abuse-limit checks.
  joined.socket = secondTab.socket;
  const privateReason = `QA_PRIVATE_BLOCK_REASON_${suffix}`;
  const createBlock = async (target, durationSeconds, reason = privateReason) => { const result = await owner.client.request('POST', '/me/chat/blocks', { targetChannelId: target.channel.id, durationSeconds, reason }); if (result.status !== 201) throw Error('Real account block returned HTTP ' + result.status); return result.data.item; };
  let blocked = await createBlock(viewer, 600); const blockedAck = await sendMessage(joined.socket, '차단된 계정 전송');
  const blockedJoin = await rememberJoin(viewer.client, broadcast);
  policyDiagnostics.push({ stage: 'first-account-block', ack: { ok: blockedAck?.ok ?? null, code: blockedAck?.code ?? null },
    newSocket: { authenticated: blockedJoin.state?.authenticated ?? null, canSend: blockedJoin.state?.canSend ?? null, code: blockedJoin.state?.code ?? null },
    recentSocketSends: joined.socket.sendTimes.filter(at => Date.now() - at < 10000).length });
  check(blockedAck?.code === 'CHAT_BLOCKED' && blockedJoin.state?.authenticated && blockedJoin.state.canSend === false && !JSON.stringify([...joined.socket.events, blockedJoin.state, blockedAck]).includes(privateReason), 'A stored account block applies to existing and new sockets without leaking its private reason');
  const foreignDelete = await other.client.request('DELETE', `/me/chat/blocks/${blocked.id}?version=${blocked.version}`), selfBlock = await owner.client.request('POST', '/me/chat/blocks', { targetChannelId: owner.channel.id, durationSeconds: null, reason: '자기 차단 거절' });
  check(foreignDelete.status === 404 && selfBlock.status === 400 && selfBlock.data.code === 'SELF_BLOCK_NOT_ALLOWED', 'A different channel cannot remove the owner block and the owner cannot block their own account');
  expire(blocked); const afterExpiry = await sendMessage(joined.socket, '만료 뒤 전송');
  check(afterExpiry?.ok && (await owner.client.request('GET', '/me/chat/blocks?status=expired')).data.items.some(item => item.id === blocked.id), 'The actual send path accepts an expired account restriction and its row appears in the expired filter');
  blocked = await createBlock(viewer, null); const staleDelete = await owner.client.request('DELETE', `/me/chat/blocks/${blocked.id}?version=${blocked.version + 1}`);
  await sendMessage(joined.socket, '영구 제한 중 전송'); joined.socket.events.length = 0;
  const unblocked = await owner.client.request('DELETE', `/me/chat/blocks/${blocked.id}?version=${blocked.version}`); await policy({ slowSeconds: 3 });
  await until(() => joined.socket.events.filter(event => event.type === 'state').length >= 2, 'Unblock and subsequent settings state');
  const releasedState = joined.socket.events.filter(event => event.type === 'state').at(-1), afterUnblock = await sendMessage(joined.socket, '해제와 설정 변경 뒤 전송');
  check(staleDelete.status === 409 && staleDelete.data.code === 'CHAT_BLOCK_CONFLICT' && unblocked.status === 200 && releasedState?.canSend === true && releasedState.code !== 'CHAT_BLOCKED' && afterUnblock?.ok, 'Unblocking then saving settings keeps the same socket enabled instead of reviving a stale blocked refusal');
  const viewerBlock = await createBlock(viewer, 600), expiredVisitor = await createBlock(visitor, 3600), otherBlock = await createBlock(other, null); expire(expiredVisitor);
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/me/chat/*' }] });
  await login(owner); nextFailure = failure503('GET', '/me/chat/settings', '채팅 설정을 불러오지 못했어요.');
  await nav('/studio/moderation'); await visibleText('채팅 설정을 불러오지 못했어요');
  check(await page.evaluate(`!!document.querySelector('main [role=alert]')&&!document.querySelector('[name=banned-words]')`), 'Settings GET 503 shows a retryable load error instead of invented default controls');
  await button('설정 다시 시도'); await has('[name=banned-words]');
  await switchTo('느린 채팅', true); await set('[name=slow-seconds]', '0'); const beforeInvalid = writes.length; await button('설정 저장');
  await visibleText('전송 간격은 1~120초');
  check(writes.length === beforeInvalid && await page.evaluate(`document.activeElement.name==='slow-seconds'`), 'Invalid slow-chat interval is rejected locally and focuses its input');
  await set('[name=slow-seconds]', '2'); await set('[name=banned-words]', 'blockme\nBLOCKME'); await button('설정 저장'); await visibleText('중복된 금칙어');
  check(writes.length === beforeInvalid && await page.evaluate(`document.activeElement.name==='banned-words'`), 'Duplicate case-insensitive banned words are rejected before any save');
  await set('[name=banned-words]', 'blockme\n테스트금칙어'); await switchTo('팔로워 전용', true); await switchTo('링크 차단', true);
  await click('[aria-label="채팅 관리 메뉴"] button:nth-child(2)'); await has('[name=block-query]'); await click('[aria-label="채팅 관리 메뉴"] button:first-child');
  check(await page.evaluate(`document.querySelector('[name=banned-words]').value===${JSON.stringify('blockme\n테스트금칙어')}&&document.querySelector('[name=slow-seconds]').value==='2'&&document.querySelector('[role=switch][aria-label="팔로워 전용"]').checked`), 'Switching management tabs preserves unsaved settings and control states');
  nextFailure = failure503('PATCH', '/me/chat/settings', '채팅 설정을 저장하지 못했어요. 입력한 내용은 유지돼요.'); await button('설정 저장'); await visibleText('채팅 설정을 저장하지 못했어요');
  check(await page.evaluate(`document.querySelector('[name=banned-words]').value===${JSON.stringify('blockme\n테스트금칙어')}&&document.querySelector('[role=switch][aria-label="링크 차단"]').checked&&document.querySelector('[name=slow-seconds]').value==='2'`), 'Settings PATCH 503 keeps all changed switches, interval and banned-word draft');
  holdMutation = true; const beforeSave = writes.length; await button('설정 저장'); await until(() => Boolean(heldMutation), 'Held moderation save');
  await page.key('Enter'); await page.evaluate(`document.querySelector('[name=banned-words]').closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  check(writes.length === beforeSave + 1 && await page.evaluate(`document.querySelector('[name=banned-words]').matches(':disabled')&&Array.from(document.querySelectorAll('[role=switch]')).every(input=>input.disabled)`), 'Pending settings save disables editing and guards duplicate submission');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null;
  await visibleText('채팅 설정을 저장했어요'); await reload(); await has('[name=banned-words]');
  settings = (await owner.client.request('GET', '/me/chat/settings')).data;
  check(settings.slowMode && settings.slowSeconds === 2 && settings.followersOnly && settings.blockLinks && JSON.stringify(settings.bannedWords) === JSON.stringify(['blockme', '테스트금칙어'])
    && await page.evaluate(`document.querySelector('[name=banned-words]').value===${JSON.stringify('blockme\n테스트금칙어')}&&document.querySelector('[role=switch][aria-label="느린 채팅"]').checked`), 'Successful UI settings reach the actual server and survive reload');
  await screenshot('chat-moderation-settings-ui.png');
  for (const width of [390, 320]) { await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true }); check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Chat settings fit the ${width}px viewport`); }
  await screenshot('chat-moderation-settings-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await policy({ blockLinks: false }); await set('[name=banned-words]', '내 입력 유지'); const beforeConflict = writes.length; await button('설정 저장'); await visibleText('최신 설정 불러오기');
  check(writes.length === beforeConflict + 1 && await page.evaluate(`document.querySelector('[name=banned-words]').value==='내 입력 유지'&&Array.from(document.querySelectorAll('main button')).find(button=>button.textContent.trim()==='설정 저장').disabled`), 'Actual settings version conflict preserves the draft and prevents automatic stale resubmission');
  await button('최신 설정 불러오기'); await has('dialog[open]'); await button('입력 유지', 'document.querySelector("dialog")');
  check(await page.evaluate(`!document.querySelector('dialog[open]')&&document.querySelector('[name=banned-words]').value==='내 입력 유지'`), 'Conflict refresh confirmation can be cancelled without discarding the draft');
  await button('최신 설정 불러오기'); await has('dialog[open]'); await button('불러오기', 'document.querySelector("dialog")');
  await until(() => page.evaluate(`document.querySelector('[name=banned-words]')?.value===${JSON.stringify('blockme\n테스트금칙어')}&&!document.querySelector('[role=switch][aria-label="링크 차단"]')?.checked`), 'Latest settings applied');
  check(writes.length === beforeConflict + 1, 'Explicit conflict refresh loads the newest stored settings without silently saving the discarded draft');
  const tableRows = () => page.evaluate(`Array.from(document.querySelectorAll('table[aria-label="채팅 참여 제한 목록"] tbody tr')).map(row=>row.innerText)`);
  nextFailure = failure503('GET', '/me/chat/blocks', '차단 목록을 불러오지 못했어요.'); blockPageLimit = true;
  await nav('/studio/moderation?tab=blocked&status=all'); await visibleText('차단 목록을 불러오지 못했어요');
  check((await tableRows()).length === 0 && await page.evaluate(`!!document.querySelector('main [role=alert]')&&!document.querySelector('main').innerText.includes('등록된 참여 제한이 없어요')`), 'Block-list GET 503 is an error instead of a false empty state');
  await button('목록 다시 시도'); await until(async () => (await tableRows()).length === 2, 'First actual block cursor page');
  nextFailure = failure503('GET', '/me/chat/blocks', '다음 차단 목록을 불러오지 못했어요.', true); await button('더 불러오기'); await visibleText('다음 차단 목록을 불러오지 못했어요');
  check((await tableRows()).length === 2, 'Block pagination 503 retains the already loaded rows');
  await button('더 불러오기 다시 시도'); await until(async () => (await tableRows()).length === 3, 'Final actual block cursor page'); blockPageLimit = false;
  check(new Set(await tableRows()).size === 3 && (await tableRows()).some(row => row.includes(visitor.displayName) && row.includes('기간 만료')), 'Cursor retry appends the final block once and shows the real expired restriction');
  await set('[name=block-status-filter]', 'active'); await until(async () => (await tableRows()).length === 2, 'Active restrictions');
  await set('[name=block-status-filter]', 'expired'); await until(async () => (await tableRows()).length === 1, 'Expired restrictions');
  check((await tableRows())[0].includes(visitor.displayName), 'Active and expired filters use the persisted restriction expiration');
  await set('[name=block-status-filter]', 'all'); await until(async () => (await tableRows()).length === 3, 'All restrictions');
  await set('[name=block-query]', viewer.channel.handle); await click('form[aria-label="차단 목록 검색"] button[type=submit]'); await until(async () => (await tableRows()).length === 1, 'Exact account handle search');
  check((await tableRows())[0].includes(viewer.displayName), 'Owner block search finds the actual account by its channel handle');
  await set('[name=block-query]', ''); await click('form[aria-label="차단 목록 검색"] button[type=submit]'); await until(async () => (await tableRows()).length === 3, 'Reset block search');
  await screenshot('chat-moderation-blocks-ui.png');
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: true });
    check(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Account restriction rows and filters fit the ${width}px viewport`);
    check(await page.evaluate(`(() => {const select=document.querySelector('[name=block-status-filter]'),css=getComputedStyle(select),context=document.createElement('canvas').getContext('2d');if(!context)return false;context.font=css.font||[css.fontStyle,css.fontWeight,css.fontSize,css.fontFamily].join(' ');const text=select.selectedOptions[0]?.textContent??'',padding=(parseFloat(css.paddingLeft)||0)+(parseFloat(css.paddingRight)||0);return context.measureText(text).width+padding<=select.clientWidth+1;})()`), `Selected restriction filter text remains fully readable at ${width}px`);
  }
  await screenshot('chat-moderation-blocks-mobile-ui.png'); await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await button('참여 제한 추가'); await has('dialog [name=block-handle]'); await set('dialog [name=block-handle]', '@' + owner.channel.handle); await button('대상 확인', 'document.querySelector("dialog")'); await visibleText('내 채널은 차단할 수 없어요');
  await set('dialog [name=block-handle]', '@' + visitor.channel.handle); await button('대상 확인', 'document.querySelector("dialog")'); await visibleText('확인됨');
  const beforeBlankReason = writes.length; await button('참여 제한', 'document.querySelector("dialog")'); await visibleText('제한 사유를 1~200자로');
  check(writes.length === beforeBlankReason && await page.evaluate(`document.activeElement.name==='block-reason'`), 'Block creation resolves the real account and requires a private management reason');
  const uiReason = `UI_PRIVATE_REASON_${suffix}`; await set('dialog [name=block-duration]', 'permanent'); await set('dialog [name=block-reason]', uiReason);
  nextFailure = failure503('POST', '/me/chat/blocks', '참여 제한을 저장하지 못했어요.'); await button('참여 제한', 'document.querySelector("dialog")'); await visibleText('참여 제한을 저장하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog [name=block-duration]').value==='permanent'&&document.querySelector('dialog [name=block-reason]').value===${JSON.stringify(uiReason)}&&document.querySelector('dialog').innerText.includes(${JSON.stringify(visitor.displayName)})`), 'Block POST 503 preserves the confirmed target, selected duration and typed reason');
  holdMutation = true; const beforeBlock = writes.length; await button('참여 제한', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held account restriction'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeBlock + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&document.querySelector('dialog fieldset').disabled&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'Pending account restriction locks its dialog and rejects Escape or duplicate submission');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null;
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Account restriction succeeds');
  await until(async () => (await tableRows()).some(row => row.includes(visitor.displayName) && row.includes('해제할 때까지')), 'Permanent restriction row');
  const visitorRoomAfter = await rememberJoin(visitor.client, broadcast), visitorBlocked = await sendMessage(visitorRoomAfter.socket, 'UI에서 제한된 계정');
  check(visitorBlocked?.code === 'CHAT_BLOCKED' && !JSON.stringify(visitorBlocked).includes(uiReason), 'A block created through the UI immediately restricts the actual account without exposing its reason');
  await click(`[aria-label="${other.displayName} 참여 제한 해제"]`); await has('dialog[open]');
  nextFailure = { status: 503, code: 'PRODUCT_UNAVAILABLE', detail: '참여 제한을 해제하지 못했어요.', matches: (method, url) => method === 'DELETE' && url.pathname.endsWith('/' + otherBlock.id) };
  await button('제한 해제', 'document.querySelector("dialog")'); await visibleText('참여 제한을 해제하지 못했어요');
  check(await page.evaluate(`!!document.querySelector('dialog[open]')`) && (await tableRows()).some(row => row.includes(other.displayName)), 'Unblock DELETE 503 preserves its confirmation and stored row');
  holdMutation = true; const beforeUnblock = writes.length; await button('제한 해제', 'document.querySelector("dialog")'); await until(() => Boolean(heldMutation), 'Held account unblock'); await page.key('Escape'); await page.key('Enter');
  check(writes.length === beforeUnblock + 1 && await page.evaluate(`!!document.querySelector('dialog[open]')&&Array.from(document.querySelectorAll('dialog button')).every(button=>button.matches(':disabled'))`), 'Pending unblock cannot close or issue a duplicate destructive request');
  holdMutation = false; await interceptionCommand('Fetch.continueRequest', { requestId: heldMutation }); heldMutation = null;
  await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'Unblock succeeds');
  await until(async () => !(await tableRows()).some(row => row.includes(other.displayName)), 'Unblocked row removed');
  check((await owner.client.request('GET', '/me/chat/blocks?status=all')).data.items.every(row => row.id !== otherBlock.id), 'UI account unblock is a real server change rather than a local list edit');
  const watchRoute = `/watch/${fixturePath}/${broadcast.id}`; await nav(watchRoute); await has('main aside textarea');
  await until(() => page.evaluate(`!document.querySelector('main aside textarea').readOnly`), 'Authenticated owner chat composer');
  check(await page.evaluate(`!document.querySelector('main aside button[aria-label^="채팅 닉네임"]')&&document.querySelector('main aside').innerText.includes(${JSON.stringify(owner.displayName)})`), 'Production chat uses the fixed authenticated account name and offers no nickname impersonation control');
  await set('main aside textarea', 'BLOCKME'); await button('보내기', 'document.querySelector("main aside")'); await visibleText('채널의 채팅 규칙에 맞지 않는 내용');
  check(await page.evaluate(`document.querySelector('main aside textarea').value==='BLOCKME'&&!!document.querySelector('main aside [role=alert]')`), 'A real banned-word chat rejection preserves the browser composer draft');
  const ownerMessage = '방송자 실제 메시지 ' + suffix; await set('main aside textarea', ownerMessage); await button('보내기', 'document.querySelector("main aside")');
  await until(() => page.evaluate(`document.querySelector('main aside textarea').value===''&&document.querySelector('[role=log]').innerText.includes(${JSON.stringify(ownerMessage)})`), 'Acknowledged owner chat message');
  check(await page.evaluate(`Array.from(document.querySelectorAll('[role=log] li')).some(item=>item.innerText.includes(${JSON.stringify(ownerMessage)})&&item.innerText.includes('방송자')&&!!item.querySelector('a[href="/_frame/channel/id/${owner.channel.id}"]'))`), 'The browser clears only an acknowledged draft and renders the server-owned broadcaster channel identity');
  await screenshot('chat-moderation-account-chat-ui.png');
  await page.send('Network.clearBrowserCookies'); await nav(watchRoute); await has('main aside textarea');
  await until(() => page.evaluate(`document.querySelector('main aside textarea').readOnly&&Array.from(document.querySelectorAll('main aside button,a')).some(element=>element.textContent.trim()==='로그인')`), 'Guest read-only chat');
  check(await page.evaluate(`!document.querySelector('main aside button[aria-label^="채팅 닉네임"]')&&document.querySelector('[role=log]').innerText.includes(${JSON.stringify(ownerMessage)})`), 'Anonymous viewers can read chat history while the composer requires account login');
  const loginControl = await page.evaluate(`(() => {const element=Array.from(document.querySelectorAll('main aside button,a')).find(element=>element.textContent.trim()==='로그인');element.dataset.chatLoginQa='true';return '[data-chat-login-qa]';})()`);
  await click(loginControl); await has('#account-email');
  check(await page.evaluate(`new URLSearchParams(location.search).get('returnTo')===${JSON.stringify(watchRoute)}`), 'Chat login keeps the exact broadcast watch return path');
  settings = (await owner.client.request('GET', '/me/chat/settings')).data;
  const finalBlocks = (await owner.client.request('GET', '/me/chat/blocks?status=active')).data;
  check(finalBlocks.userId === owner.user.id && finalBlocks.items.some(row => row.id === viewerBlock.id), 'Final private restriction state retains the intended blocked account for restart verification');
  await Promise.all([...pendingInterceptions]); check(errors.length === 0, 'No browser runtime or unconfirmed interception errors');
  await marker('chat-moderation-checkpoint.json', { owner: owner.client.saved(), blockedViewer: viewer.client.saved(), path: fixturePath, settings, activeBlockIds: finalBlocks.items.map(row => row.id) });
  await writeFile(path.join(output, 'chat-moderation-ui-result.json'), JSON.stringify({ verificationDatabaseOnly: true, origin, api,
    checks: results.length, passed: results.filter(result => result.pass).length,
    fixtureExpiry: 'The guarded helper changes only a fresh expiring fixture block to created_at_ms+1, a timestamp already in the past; it does not wait 10 minutes or modify production data.',
    paginationInstrumentation: 'Only initial block-list UI GET limits are lowered to 2; all returned rows and cursors come from the actual server.',
    faultInjection: ['Settings GET/PATCH 503', 'Delayed settings PATCH', 'Block-list and cursor GET 503', 'Block POST 503 and delay', 'Unblock DELETE 503 and delay'],
    realEdges: ['Ticket identity/Origin/single-use/session revocation', 'Actual policy and account restriction enforcement', 'Settings version HTTP 409', 'Foreign owner block isolation'],
    results, runtimeErrors: errors, confirmedCanceledInterceptions }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(result => result.pass).length, runtimeErrors: errors.length }));
} catch (failure) {
  let failureState = null; if (page) { try { failureState = await snapshot(); } catch {} }
  await writeFile(path.join(output, 'chat-moderation-ui-failure.json'), JSON.stringify({ results, failure: failure.message, runtimeErrors: errors, confirmedCanceledInterceptions, writes, interactions, failureState, policyDiagnostics }, null, 2));
  if (page) await screenshot('chat-moderation-ui-failure.png').catch(() => {}); throw failure;
} finally {
  for (const socket of sockets) socket.destroy();
  if (page) { await Promise.race([page.send('Browser.close').catch(() => {}), sleep(1000)]); page.close(); } browser.kill();
  const literal = profile.replaceAll("'", "''");
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
}
