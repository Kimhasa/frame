// Chat rooms with the protocol of native/src/chat.cpp: join/name/send from the browser, state/history/message/ack/name/closed
// from the server. One room per stream path, bound to the broadcast id currently registered for it; a new broadcast or the
// end of one closes the room for everybody (the UI then reconnects to the new id from /info).
import { frame } from './websocket.mjs';

const HISTORY = 200, HISTORY_ON_JOIN = 100;
const RESERVED = new Set(['시스템', '관리자', 'system', 'admin', 'administrator']);
const codePoints = s => [...s].length;
const lower = s => s.toLowerCase();

// Same rules as NormaliseChatName: NFC, tabs/newlines become spaces, other controls and zero-width marks are refused,
// whitespace runs collapse, 1..20 characters, reserved names refused.
export function normaliseName(input) {
  if (typeof input !== 'string') return { error: '이름을 확인하십시오.' };
  let collapsed = '';
  for (const ch of input.normalize('NFC')) {
    let c = ch;
    const u = ch.codePointAt(0);
    if (u < 0x20 || u === 0x7f || (u >= 0x200b && u <= 0x200f) || u === 0x2028 || u === 0x2029 || u === 0xfeff) {
      if (ch === '\t' || ch === '\n' || ch === '\r') c = ' ';
      else return { error: '이름에 사용할 수 없는 문자가 있습니다.' };
    }
    if (/\s/u.test(c)) { if (collapsed && !collapsed.endsWith(' ')) collapsed += ' '; }
    else collapsed += c;
  }
  const name = collapsed.replace(/ +$/, '');
  const n = codePoints(name);
  if (n < 1 || n > 20) return { error: '1~20자의 이름을 입력하십시오.' };
  if (RESERVED.has(lower(name))) return { error: '사용할 수 없는 이름입니다.' };
  return { name };
}

// Same rules as NormaliseChatText: NFC, CR dropped, controls other than LF/TAB refused, trimmed, 1..1000 characters.
export function normaliseText(input) {
  if (typeof input !== 'string') return { error: '메시지를 확인하십시오.' };
  let clean = '';
  for (const ch of input.normalize('NFC')) {
    const u = ch.codePointAt(0);
    if (ch === '\r') continue;
    if ((u < 0x20 && ch !== '\n' && ch !== '\t') || u === 0x7f) return { error: '보낼 수 없는 문자가 있습니다.' };
    clean += ch;
  }
  const text = clean.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
  const n = codePoints(text);
  if (n < 1) return { error: '메시지를 입력하십시오.' };
  if (n > 1000) return { error: '메시지는 1000자까지 보낼 수 있습니다.' };
  return { text };
}

export class ChatHub {
  // sendLimit: per-IP RateLimit shared by every connection from one address (on top of 8 messages / 10 s per connection).
  constructor({ sendLimit, log }) {
    this.rooms = new Map();  // path -> { broadcastId, clients:Set, history:[], next }
    this.clients = new Set();
    this.sendLimit = sendLimit; this.log = log;
  }
  get count() { return this.clients.size; }
  room(path) { return this.rooms.get(path); }

  // Called by the registry: a broadcast is live on `path` with `broadcastId`.
  open(path, broadcastId) {
    const r = this.rooms.get(path);
    if (r && r.broadcastId === broadcastId) return;
    if (r) this.close(path, '새 송출이 시작되었습니다.');
    this.rooms.set(path, { broadcastId, clients: new Set(), history: [], next: 0 });
  }
  close(path, reason) {
    const r = this.rooms.get(path);
    if (!r) return;
    this.rooms.delete(path);
    const closed = JSON.stringify({ type: 'closed', reason });
    for (const c of this.clients) if (c.path === path) { c.ws.sendText(closed); c.ws.close(); }
  }
  // makeSocket(handlers) completes the WebSocket handshake; the handlers exist before any frame can arrive.
  attach(path, ip, makeSocket) {
    const client = { ws: null, path, ip, name: '', joined: false, recent: [] };
    this.clients.add(client);
    client.ws = makeSocket({
      onText: text => this.handle(client, text),
      onClose: () => { this.clients.delete(client); this.rooms.get(path)?.clients.delete(client); }
    });
    return client;
  }
  send(client, value) { client.ws.sendText(JSON.stringify(value)); }
  // The same address may hold one name in several tabs or across a reconnect (as the native "same PC" rule).
  nameTaken(room, name, except) {
    const wanted = lower(name);
    for (const c of room.clients) if (c !== except && c.joined && c.name && c.ip !== except.ip && lower(c.name) === wanted) return true;
    return false;
  }
  handle(client, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    const room = this.rooms.get(client.path);
    if (msg.type === 'join') {
      const wanted = typeof msg.broadcastId === 'string' ? msg.broadcastId : '';
      if (!room || room.broadcastId !== wanted) {
        this.send(client, { type: 'state', connected: false, canSend: false, broadcastId: wanted, error: '방송이 종료되었거나 다른 방송으로 바뀌었습니다.' });
        client.ws.close();
        return;
      }
      client.joined = true; room.clients.add(client);
      let nameError = '';
      if (typeof msg.name === 'string' && msg.name) {
        const n = normaliseName(msg.name);
        if (!n.name) nameError = n.error;
        else if (this.nameTaken(room, n.name, client)) nameError = '이미 사용 중인 이름입니다. 다른 이름을 설정하십시오.';
        else client.name = n.name;
      }
      this.send(client, { type: 'state', connected: true, canSend: true, broadcastId: room.broadcastId, displayName: client.name, error: nameError });
      this.send(client, { type: 'history', messages: room.history.slice(-HISTORY_ON_JOIN) });
      return;
    }
    if (!client.joined || !room || !room.clients.has(client)) return;
    if (msg.type === 'name') {
      const n = normaliseName(msg.name);
      if (!n.name) return this.send(client, { type: 'name', ok: false, displayName: client.name, error: n.error || '이름을 확인하십시오.' });
      if (this.nameTaken(room, n.name, client)) return this.send(client, { type: 'name', ok: false, displayName: client.name, error: '이미 사용 중인 이름입니다. 다른 이름을 설정하십시오.' });
      client.name = n.name;
      return this.send(client, { type: 'name', ok: true, displayName: client.name });
    }
    if (msg.type === 'send') {
      const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : '';
      const nack = error => this.send(client, { type: 'ack', clientId, ok: false, error });
      if (!client.name) return nack('이름을 먼저 설정하십시오.');
      const t = normaliseText(msg.text);
      if (!t.text) return nack(t.error || '메시지를 확인하십시오.');
      const now = Date.now();
      while (client.recent.length && now - client.recent[0] > 10000) client.recent.shift();
      if (client.recent.length >= 8 || this.sendLimit.take(client.ip)) return nack('메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내십시오.');
      client.recent.push(now);
      const m = { id: room.broadcastId.slice(0, 8) + '-' + ++room.next, broadcastId: room.broadcastId, author: client.name, text: t.text, ts: now };
      room.history.push(m);
      if (room.history.length > HISTORY) room.history.shift();
      // Encoded once, written to every member: fan-out cost stays one JSON + one frame per message.
      const shared = frame(0x1, Buffer.from(JSON.stringify({ type: 'message', ...m }), 'utf8'));
      for (const c of room.clients) if (c.joined) c.ws.sendFrame(shared);
      this.send(client, { type: 'ack', clientId, ok: true, id: m.id });
    }
  }
}
