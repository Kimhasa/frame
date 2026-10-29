// Minimal RFC 6455 server side for the chat: handshake, masked client frames, fragmentation, ping/pong, close.
// Text only; frames and reassembled messages are capped (16 KB like native/src/chat.cpp) and slow readers are dropped
// rather than buffered without bound, so one stalled phone cannot grow the relay's memory.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024;
const MAX_BUFFERED = 1 << 20;  // bytes queued to one client before it is considered stalled
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function handshakeError(req) {
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const connection = String(req.headers.connection || '').toLowerCase();
  const key = String(req.headers['sec-websocket-key'] || '');
  if (req.method !== 'GET' || upgrade !== 'websocket' || !connection.split(',').some(t => t.trim() === 'upgrade')) return [400, 'WebSocket upgrade required'];
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return [400, 'Bad Sec-WebSocket-Key'];
  if (String(req.headers['sec-websocket-version'] || '') !== '13') return [426, 'Unsupported WebSocket version'];
  return null;
}

export function frame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.alloc(10);
  if (n >= 65536) { head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, data]);
}

export class WebSocketConnection {
  // onText(string) for each complete text message; onClose() once.
  constructor(req, socket, head, { onText, onClose, pingMs = 25000, idleMs = 75000 }) {
    this.socket = socket; this.onText = onText; this.onClose = onClose; this.open = true;
    this.buffer = Buffer.alloc(0); this.parts = []; this.partsLength = 0; this.lastSeen = Date.now();
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
    socket.on('end', () => this.destroy());
    // Pings keep NAT bindings and proxies alive; a peer silent for idleMs (no pong, no data) is gone.
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSeen > idleMs) return this.destroy();
      this.sendRaw(frame(0x9));
    }, pingMs);
    this.timer.unref();
    if (head && head.length) this.receive(head);
  }
  receive(chunk) {
    if (!this.open) return;
    this.lastSeen = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      if (b[0] & 0x70) return this.fail(1002);  // no extensions were negotiated
      let length = b[1] & 0x7f, offset = 2;
      if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) return this.fail(1009); length = Number(big); offset = 10; }
      if (!masked) return this.fail(1002);  // clients must mask
      if (length > MAX_MESSAGE) return this.fail(1009);
      if (b.length < offset + 4 + length) return;
      const mask = b.subarray(offset, offset + 4), payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(offset + 4 + length);
      this.handle(fin, opcode, payload);
    }
  }
  handle(fin, opcode, payload) {
    if (opcode === 0x8) { this.sendRaw(frame(0x8, payload.subarray(0, 2))); return this.end(); }
    if (opcode === 0x9) return this.sendRaw(frame(0xa, payload));
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x0) {
      if (opcode === 0x1 && this.parts.length) return this.fail(1002);
      if (opcode === 0x0 && !this.parts.length && !this.fragmented) return this.fail(1002);
      this.partsLength += payload.length;
      if (this.partsLength > MAX_MESSAGE) return this.fail(1009);
      this.parts.push(payload); this.fragmented = !fin;
      if (!fin) return;
      const data = Buffer.concat(this.parts);
      this.parts = []; this.partsLength = 0;
      let text;
      try { text = utf8.decode(data); } catch { return this.fail(1007); }
      try { this.onText(text); } catch {}
      return;
    }
    this.fail(1003);  // binary or unknown opcodes are not part of this protocol
  }
  sendRaw(buf) {
    if (!this.open) return false;
    if (this.socket.writableLength > MAX_BUFFERED) { this.destroy(); return false; }
    this.socket.write(buf);
    return true;
  }
  sendText(text) { return this.sendRaw(frame(0x1, Buffer.from(text, 'utf8'))); }
  sendFrame(buf) { return this.sendRaw(buf); }  // a frame built once and shared by every member of a room
  fail(code) { const c = Buffer.alloc(2); c.writeUInt16BE(code); this.sendRaw(frame(0x8, c)); this.end(); }
  close(code = 1000) { this.fail(code); }
  end() {
    if (!this.open) return;
    this.open = false; clearInterval(this.timer);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.onClose?.(); this.onClose = null;
  }
  destroy() {
    if (this.open) { this.open = false; clearInterval(this.timer); this.onClose?.(); this.onClose = null; }
    this.socket.destroy();
  }
}
