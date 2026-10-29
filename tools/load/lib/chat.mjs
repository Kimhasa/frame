// Chat load: viewers that hold the app's chat WebSocket (/<path>/chat, protocol of native/src/chat.cpp) and some that send.
// Every sent message carries the sender's clock and a run token, so delivery latency is measured on the other sockets of
// this same process (one clock); expected deliveries = joined sockets at send time, so lost deliveries are counted too.
import { percentile, round } from './common.mjs';

// Display names are "부하-<generatorId>-<viewer>" (at most 20 code points as chat.cpp NormaliseChatName requires). The app
// rejects a name another machine already holds (ChatHub::NameTaken), so every generator PC needs its own generatorId.
export function chatName(generatorId, viewer) {
  const name = `부하-${generatorId}-${viewer}`;
  if ([...name].length > 20) throw new Error(`chat name ${name} is longer than 20 characters (shorten --generator-id)`);
  return name;
}

export class ChatPool {
  constructor(o) {
    this.o = o;                // { wsUrl, broadcastId, generatorId, senderFraction, messagesPerMinute, connectTimeoutMs, reconnectMs }
    this.token = Math.random().toString(36).slice(2, 8);
    this.clients = new Map();  // viewer -> client
    this.sent = new Map();     // message seq -> { at, expected, received }
    this.seq = 0;
    this.reset();
  }

  reset() {
    this.w = { attempts: 0, opened: 0, joined: 0, connectFail: 0, joinRejected: 0, unexpectedClose: 0, sent: 0, acked: 0, nacked: 0, nackReasons: {},
      latencies: [], connectMs: [], joinMs: [], historyMessages: 0, deliveries: 0, nameRejected: 0, nameErrors: {} };
  }

  open(viewer, sender) {
    if (this.clients.has(viewer)) return;
    const c = { viewer, sender, name: chatName(this.o.generatorId, viewer), ws: null, joined: false, wanted: true, t0: Date.now(), nextSend: 0 };
    this.clients.set(viewer, c);
    this.connect(c);
  }

  connect(c) {
    this.w.attempts++;
    c.t0 = Date.now();
    c.joined = false;
    let ws;
    try { ws = new WebSocket(this.o.wsUrl); } catch { this.w.connectFail++; return this.retry(c); }
    c.ws = ws;
    const timer = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) { ws.close(); } }, this.o.connectTimeoutMs || 10000);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      this.w.opened++;
      this.w.connectMs.push(Date.now() - c.t0);
      ws.send(JSON.stringify({ type: 'join', broadcastId: this.o.broadcastId, name: c.name }));
    };
    ws.onmessage = ev => this.message(c, ev.data);
    ws.onclose = () => {
      clearTimeout(timer);
      if (!opened) this.w.connectFail++;
      else if (c.wanted) this.w.unexpectedClose++;
      c.joined = false;
      if (c.wanted) this.retry(c);
    };
    ws.onerror = () => {};
  }

  retry(c) {
    if (!c.wanted || !this.o.reconnectMs) return;
    setTimeout(() => { if (c.wanted && this.clients.get(c.viewer) === c) this.connect(c); }, this.o.reconnectMs);
  }

  message(c, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'state') {
      if (m.connected) {
        c.joined = true; this.w.joined++; this.w.joinMs.push(Date.now() - c.t0); c.nextSend = Date.now() + Math.random() * this.interval();
        // Joined but without the requested name (taken, invalid): its sends would be refused with "이름을 먼저 설정하십시오.".
        if (m.displayName !== c.name) { this.w.nameRejected++; const k = String(m.error || 'name not applied').slice(0, 60); this.w.nameErrors[k] = (this.w.nameErrors[k] || 0) + 1; }
      }
      else { this.w.joinRejected++; this.lastJoinError = m.error; }
    } else if (m.type === 'history') {
      this.w.historyMessages += (m.messages || []).length;
    } else if (m.type === 'message') {
      const hit = typeof m.text === 'string' && m.text.match(/\[(\w+)#(\d+)@(\d+)\]/);
      if (!hit || hit[1] !== this.token) return;
      const rec = this.sent.get(Number(hit[2]));
      if (rec) rec.received++;
      this.w.deliveries++;
      if (rec && rec.from !== c.viewer) this.w.latencies.push(Date.now() - Number(hit[3]));
    } else if (m.type === 'ack') {
      if (m.ok) this.w.acked++;
      else { this.w.nacked++; const k = String(m.error || 'unknown').slice(0, 60); this.w.nackReasons[k] = (this.w.nackReasons[k] || 0) + 1; }
    } else if (m.type === 'closed') {
      this.lastClosed = m.reason;
    }
  }

  interval() { return 60000 / Math.max(0.01, this.o.messagesPerMinute || 6); }

  // Called about once a second: senders that are due send one message (stays under the server's 8 per 10 s limit by default).
  tick() {
    const now = Date.now();
    let joined = 0;
    for (const c of this.clients.values()) if (c.joined) joined++;
    for (const c of this.clients.values()) {
      if (!c.sender || !c.joined || now < c.nextSend) continue;
      c.nextSend = now + this.interval();
      const seq = ++this.seq;
      this.sent.set(seq, { at: now, expected: joined, received: 0, from: c.viewer });
      try { c.ws.send(JSON.stringify({ type: 'send', clientId: `${this.token}-${seq}`, text: `부하 시험 메시지 [${this.token}#${seq}@${now}]` })); this.w.sent++; } catch {}
    }
    // Messages older than 15 s are settled: whatever has not arrived by then counts as not delivered.
    for (const [seq, rec] of this.sent) if (now - rec.at > 15000) { this.settled = (this.settled || { expected: 0, received: 0 }); this.settled.expected += rec.expected; this.settled.received += rec.received; this.sent.delete(seq); }
  }

  close(viewer) {
    const c = this.clients.get(viewer);
    if (!c) return;
    c.wanted = false;
    this.clients.delete(viewer);
    try { c.ws?.close(); } catch {}
  }

  closeAll() { for (const v of [...this.clients.keys()]) this.close(v); }

  counts() {
    let open = 0, joined = 0;
    for (const c of this.clients.values()) { if (c.ws?.readyState === WebSocket.OPEN) open++; if (c.joined) joined++; }
    return { wanted: this.clients.size, open, joined };
  }

  // Window summary (since the last reset), for one stage.
  summary() {
    const w = this.w, s = this.settled || { expected: 0, received: 0 };
    return { ...this.counts(), attempts: w.attempts, opened: w.opened, joinedEvents: w.joined, connectFail: w.connectFail, joinRejected: w.joinRejected, unexpectedClose: w.unexpectedClose,
      sent: w.sent, acked: w.acked, nacked: w.nacked, nackReasons: w.nackReasons, deliveries: w.deliveries, nameRejected: w.nameRejected, nameErrors: w.nameErrors,
      nameExample: chatName(this.o.generatorId, 'v00000'),
      deliveryRatio: s.expected ? round(s.received / s.expected, 4) : null, settledExpected: s.expected,
      latencyMs: { n: w.latencies.length, p50: percentile(w.latencies, 0.5), p95: percentile(w.latencies, 0.95), max: percentile(w.latencies, 1) },
      connectMs: { p50: percentile(w.connectMs, 0.5), p95: percentile(w.connectMs, 0.95) }, joinMs: { p50: percentile(w.joinMs, 0.5), p95: percentile(w.joinMs, 0.95) },
      lastJoinError: this.lastJoinError || null, lastClosed: this.lastClosed || null };
  }

  resetWindow() { this.reset(); this.settled = null; }
}
