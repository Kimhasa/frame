// Small verification-only HTTP and WebSocket clients. Credentials and wire payloads stay in private process memory.
import { createConnection } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { sleep } from '../../tools/cdp.mjs';

export const api = 'http://127.0.0.1:18083', origin = 'http://127.0.0.1:5365';
export class Client {
  constructor(saved) { this.cookies = new Map(saved?.cookies?.map(({ name, value }) => [name, value]) ?? []); this.csrf = saved?.csrfToken ?? ''; this.userId = saved?.userId ?? null; }
  async request(method, route, body, options = {}) {
    const headers = { Accept: 'application/json', Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
    const expected = options.expectedUserId ?? this.userId;
    if (expected) headers['X-FRAME-USER-ID'] = expected;
    if (method !== 'GET') { headers.Origin = options.origin ?? origin; if (this.csrf && options.csrf !== false) headers['X-CSRF-TOKEN'] = this.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + '/api/v1' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'manual' });
    for (const raw of response.headers.getSetCookie()) {
      const first = raw.split(';')[0], split = first.indexOf('='), name = first.slice(0, split), value = first.slice(split + 1);
      if (/max-age=0(?:;|$)/i.test(raw) || !value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    let data; try { data = await response.json(); } catch { data = null; }
    if (typeof data?.csrfToken === 'string') this.csrf = data.csrfToken;
    if (typeof data?.user?.id === 'string') this.userId = data.user.id;
    return { status: response.status, data, headers: response.headers };
  }
  saved() { return { cookies: [...this.cookies].map(([name, value]) => ({ name, value })), csrfToken: this.csrf, userId: this.userId }; }
}

function frame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value ?? ''), mask = randomBytes(4);
  if (payload.length > 65535) throw Error('Verification WebSocket frame exceeds its bounded fixture size.');
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  const masked = Buffer.from(payload); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Raw handshake is necessary to send the real browser Origin while keeping fixture session cookies out of WS URLs. */
export async function openSocket(path, { socketOrigin = origin } = {}) {
  if (!/^obs-chat-[0-9a-f]{12}$/.test(path)) throw Error('Only the dedicated chat fixture path is allowed.');
  const key = randomBytes(16).toString('base64'), expectedAccept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const socket = createConnection({ host: '127.0.0.1', port: 18083 });
  const events = []; let buffer = Buffer.alloc(0), handshake = false, closed = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = setTimeout(() => { rejectReady(Error('Chat verification handshake timed out.')); socket.destroy(); }, 10000);
  const client = { status: 0, events, sendTimes: [], get closed() { return closed; },
    send(value) { if (closed || !handshake || client.status !== 101) throw Error('Chat fixture socket is not connected.'); if (value.type === 'send') client.sendTimes.push(Date.now()); socket.write(frame(1, JSON.stringify(value))); },
    async wait(test, milliseconds = 6000) { const end = Date.now() + milliseconds; while (Date.now() < end) { const index = events.findIndex(test); if (index >= 0) return events.splice(index, 1)[0]; await sleep(25); } return null; },
    close() { if (!closed) { if (handshake && client.status === 101) socket.write(frame(8, Buffer.from([3, 232]))); socket.end(); } },
    destroy() { socket.destroy(); },
  };
  socket.on('connect', () => socket.write(`GET /${path}/chat HTTP/1.1\r\nHost: 127.0.0.1:18083\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${socketOrigin}\r\n\r\n`));
  socket.on('error', () => { if (!handshake) rejectReady(Error('Chat verification connection failed.')); });
  socket.on('close', () => { clearTimeout(timeout); closed = true; events.push({ type: '_closed' }); if (!handshake) rejectReady(Error('Chat verification connection closed before the handshake.')); });
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshake) {
      const boundary = buffer.indexOf('\r\n\r\n'); if (boundary < 0) return;
      const header = buffer.subarray(0, boundary).toString('latin1'); buffer = buffer.subarray(boundary + 4);
      client.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(header)?.[1]); handshake = true; clearTimeout(timeout);
      if (client.status !== 101) { resolveReady(client); socket.end(); return; }
      if (/^sec-websocket-accept:\s*(.+)$/im.exec(header)?.[1].trim() !== expectedAccept) { rejectReady(Error('Chat verification upgrade accept key mismatch.')); socket.destroy(); return; }
      resolveReady(client);
    }
    while (buffer.length >= 2 && client.status === 101) {
      const opcode = buffer[0] & 15; let size = buffer[1] & 127, offset = 2;
      if (buffer[1] & 128) { events.push({ type: '_protocolError' }); socket.destroy(); return; }
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
      else if (size === 127) { if (buffer.length < 10) return; const large = buffer.readBigUInt64BE(2); if (large > 1_048_576n) { socket.destroy(); return; } size = Number(large); offset = 10; }
      if (buffer.length < offset + size) return;
      const payload = buffer.subarray(offset, offset + size); buffer = buffer.subarray(offset + size);
      if (opcode === 9) { socket.write(frame(10, payload)); continue; }
      if (opcode === 8) { events.push({ type: '_closeFrame', code: payload.length >= 2 ? payload.readUInt16BE(0) : null }); socket.end(); continue; }
      if (opcode !== 1) continue;
      try { events.push(JSON.parse(payload.toString('utf8'))); } catch { events.push({ type: '_invalidJson' }); }
      if (events.length > 500) events.splice(0, events.length - 500);
    }
  });
  return ready;
}

export async function joinAccount(client, broadcast, extra = {}) {
  const ticket = await client.request('POST', '/chat/tickets', { path: broadcast.path, broadcastId: broadcast.id });
  if (ticket.status !== 200) throw Error('Account chat ticket returned HTTP ' + ticket.status);
  const socket = await openSocket(broadcast.path);
  if (socket.status !== 101) throw Error('Account chat upgrade returned HTTP ' + socket.status);
  socket.send({ type: 'join', broadcastId: broadcast.id, ticket: ticket.data.ticket, ...extra });
  const state = await socket.wait(event => event.type === 'state');
  return { socket, state, ticket: ticket.data };
}
export async function sendMessage(socket, text, extra = {}) {
  const clientId = randomBytes(10).toString('hex'); socket.send({ type: 'send', clientId, text, ...extra });
  return socket.wait(event => event.type === 'ack' && event.clientId === clientId);
}
export async function liveBroadcast(path) {
  for (let i = 0; i < 120; i++) {
    const response = await fetch(api + '/api/broadcasts', { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) {
      const body = await response.json(), item = body.items?.find(value => value.path === path && /^[0-9a-f]{32}$/.test(value.id));
      if (item) return item;
    }
    await sleep(250);
  }
  throw Error('The isolated actual live source did not register a chat broadcast.');
}
