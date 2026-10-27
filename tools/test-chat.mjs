// Chat server rules over raw WebSockets (Node's built-in client) against the running app's broadcast:
// room separation by broadcast id, name normalisation/validation, reserved names, same-PC name sharing,
// message length/empty/control characters, HTML kept as text, rate limit, history on join, and the UI's
// Enter / Shift+Enter / IME-composition handling in the app's sender chat.
import { app, selectWindow, sleep } from './app-flow.mjs';

const out = (name, data) => console.log(name.padEnd(22), JSON.stringify(data));
const a = await app();
if (!(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`))) {
  await a.evaluate(`document.getElementById('tab-sender').click()`);
  await selectWindow(a, 'FRAME 모션 테스트');
  await a.evaluate(`document.getElementById('start-button').click()`);
  for (let i = 0; i < 60 && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`)); i++) await sleep(250);
  await sleep(1500);
}
const host = await a.evaluate(`document.getElementById('server-host').value`), port = await a.evaluate(`document.getElementById('viewer-port').value`), path = await a.evaluate(`document.getElementById('stream-path').value`);
const info = await (await fetch(`http://${host}:${port}/${path}/info`)).json();
function client(name, broadcastId = info.broadcastId) {
  const ws = new WebSocket(`ws://${host}:${port}/${path}/chat`), events = [];
  const c = { ws, events, wait: async (test, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const hit = events.find(test); if (hit) { events.splice(events.indexOf(hit), 1); return hit; } await sleep(50); } return null; },
    send: obj => ws.send(JSON.stringify(obj)) };
  ws.addEventListener('message', e => events.push(JSON.parse(e.data)));
  ws.addEventListener('close', () => events.push({ type: '_closed' }));
  c.ready = new Promise(resolve => ws.addEventListener('open', () => { c.send({ type: 'join', broadcastId, name }); resolve(); }));
  return c;
}
// Wrong broadcast id: refused and closed.
const stale = client('예전 방송', '0'.repeat(32)); await stale.ready;
out('stale room', { state: await stale.wait(e => e.type === 'state'), closed: !!(await stale.wait(e => e.type === '_closed')) });
// Two clients from this PC with the same name: allowed (same machine); names are normalised.
const A = client('  검증   사용자  '); await A.ready;
const stateA = await A.wait(e => e.type === 'state');
out('join A', { connected: stateA.connected, displayName: stateA.displayName, error: stateA.error, history: (await A.wait(e => e.type === 'history'))?.messages.length });
const B = client('검증 사용자'); await B.ready;
const stateB = await B.wait(e => e.type === 'state');
out('join B same PC', { displayName: stateB.displayName, error: stateB.error });
await B.wait(e => e.type === 'history');
for (const [label, name] of [['empty', '   '], ['too long', '가'.repeat(21)], ['20 chars', '가'.repeat(20)], ['reserved', 'Admin'], ['control', 'a\u0007b'], ['zero width', 'a​b'], ['html', '<b>굵게</b>']]) {
  A.send({ type: 'name', name }); const r = await A.wait(e => e.type === 'name');
  out('name ' + label, { ok: r?.ok, displayName: r?.displayName, error: r?.error });
}
A.send({ type: 'name', name: '검증 A' }); await A.wait(e => e.type === 'name');
// Messages: HTML stays text, limits, empty, control characters; B receives A's message.
const sendA = async (label, text) => { const id = 'c' + Math.random().toString(36).slice(2); A.send({ type: 'send', clientId: id, text }); const ack = await A.wait(e => e.type === 'ack' && e.clientId === id); out('send ' + label, { ok: ack?.ok, error: ack?.error }); return ack; };
await sendA('html', '<img src=x onerror=alert(1)> 한글 메시지');
const got = await B.wait(e => e.type === 'message');
out('B received', { author: got?.author, text: got?.text });
await sendA('1000 chars', 'x'.repeat(1000));
await sendA('1001 chars', 'x'.repeat(1001));
await sendA('empty', '   \n  ');
await sendA('control', 'a\u0001b');
let accepted = 0, limited = 0;
for (let i = 0; i < 12; i++) { const id = 'r' + i; A.send({ type: 'send', clientId: id, text: '빠른 메시지 ' + i }); const ack = await A.wait(e => e.type === 'ack' && e.clientId === id); if (ack?.ok) accepted++; else if (ack) limited++; }
out('rate limit (12 fast)', { accepted, limited });
A.ws.close(); B.ws.close();
// Late joiner gets the recent history.
await sleep(500);
const C = client('늦은 참가'); await C.ready; await C.wait(e => e.type === 'state');
out('late joiner history', { messages: (await C.wait(e => e.type === 'history'))?.messages.length });
C.ws.close();
// UI keyboard handling in the app's sender chat: Enter sends, Shift+Enter is a line break, Enter while composing (IME) does not send.
await a.evaluate(`document.getElementById('tab-sender').click()`); await sleep(500);
const ui = await a.evaluate(`(async () => {
  const t = document.getElementById('chat-message'), count = () => document.querySelectorAll('#chat-messages .chat-message').length, before = count();
  const key = init => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...init }));
  t.value = '한글 조합 중'; t.dispatchEvent(new Event('input', { bubbles: true }));
  const composing = !key({ isComposing: true, keyCode: 229 });  // true = default prevented
  await new Promise(r => setTimeout(r, 800)); const afterComposing = count();
  const shift = !key({ shiftKey: true });
  await new Promise(r => setTimeout(r, 800)); const afterShift = count();
  key({}); await new Promise(r => setTimeout(r, 1200));
  return { enabled: !t.disabled, before, composingPrevented: composing, afterComposing, shiftPrevented: shift, afterShift, afterEnter: count(), draftAfterEnter: t.value };
})()`);
out('ui keys', ui);
a.close();
