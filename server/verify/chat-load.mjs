// Chat fan-out load on the relay: N WebSocket viewers join one room, S of them send messages, and every delivery is timed
// (send -> receipt at each of the N clients). Starts its own relay (no MediaMTX needed for chat) on port 24180 by default.
// This is a protocol load on one PC over loopback (generator and relay share the CPU); it is not a 1,000-viewer media test.
// Usage: node server/verify/chat-load.mjs [--clients 1000] [--senders 20] [--messages 5] [--ramp-per-s 200]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { start, stopAll, waitFor, sleep } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const N = arg('clients', 1000), SENDERS = arg('senders', 20), MESSAGES = arg('messages', 5), RAMP = arg('ramp-per-s', 200), PORT = arg('port', 24180);
const BASE = `http://127.0.0.1:${PORT}`, TOKEN = randomBytes(24).toString('hex'), ID = randomBytes(16).toString('hex');
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const usage = pid => { try { const [cpu, ws] = execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${pid}; "$($p.CPU) $($p.WorkingSet64)"`]).toString().trim().split(' ').map(Number); return { cpuS: +cpu.toFixed(2), rssMB: +(ws / 1048576).toFixed(1) }; } catch { return null; } };

const relay = start('relay-chat-load', process.execPath, [join(ROOT, 'server/relay.mjs')], { env: {
  RELAY_PORT: String(PORT), RELAY_PUBLISHER_TOKENS: TOKEN + ' load', RELAY_MEDIAMTX_API: 'http://127.0.0.1:24999', RELAY_MAX_CHAT: String(N + 100), RELAY_MAX_CHAT_PER_IP: String(N + 100),
  RELAY_MAX_SOCKETS: String(N + 500), RELAY_LOG_LEVEL: 'warn',
  // Every generator client shares 127.0.0.1, so the per-IP buckets are opened up for this run only.
  RELAY_RATE_CHAT_CONNECT: `${N}/${RAMP * 2}`, RELAY_RATE_CHAT_SEND: '100000/10000' } });
await waitFor(async () => (await fetch(BASE + '/healthz')).status > 0, 8000);
const announce = () => fetch(BASE + '/api/broadcasts/announce', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ v: 1, type: 'announce', item: { id: ID, title: '채팅 부하', publisher: 'LOAD', path: 'load', width: 1920, height: 1080, fps: 60, startedAtMs: Date.now() } }) });
await announce();
const keep = setInterval(announce, 2000);
const before = usage(relay.pid);
// Whole-PC CPU load while the test runs (the PC is shared; generator and relay are on it too).
const cpuSamples = [];
let cpuPrev = cpus();
const cpuTimer = setInterval(() => { const now = cpus(); let idle = 0, total = 0; now.forEach((c, i) => { const p = cpuPrev[i].times, t = c.times; for (const k of ['user', 'nice', 'sys', 'irq', 'idle']) total += t[k] - p[k]; idle += t.idle - p.idle; }); cpuPrev = now; if (total) cpuSamples.push(Math.round(100 * (1 - idle / total))); }, 2000);

// Ramp: RAMP connections per second (the connect rate limit is per IP, so the generator spreads its joins).
const clients = [], latencies = [], failures = { connect: 0, join: 0 };
const sentAt = new Map();
let received = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/load/chat`);
  const c = { ws, joined: false };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', broadcastId: ID, name: '시청자' + i }));
  ws.onmessage = ({ data }) => {
    const e = JSON.parse(data);
    if (e.type === 'state') { c.joined = !!e.connected; if (!e.connected) failures.join++; }
    else if (e.type === 'message') { const at = sentAt.get(e.text); if (at !== undefined) { latencies.push(performance.now() - at); received++; } }
  };
  ws.onerror = () => { failures.connect++; };
  clients.push(c);
  if (i % RAMP === RAMP - 1) await sleep(1000);
}
await waitFor(() => clients.filter(c => c.joined).length + failures.connect + failures.join >= N, 60000, 200);
const joined = clients.filter(c => c.joined).length, rampS = (Date.now() - t0) / 1000;
const idle = usage(relay.pid), health = await (await fetch(BASE + '/healthz')).json();
console.log(`joined ${joined}/${N} in ${rampS.toFixed(1)} s; relay chatClients ${health.chatClients}; connect errors ${failures.connect}, join refused ${failures.join}`);

// Messages: SENDERS clients send MESSAGES each, spread over time (each stays within 8 per 10 s).
const senders = clients.filter(c => c.joined).slice(0, SENDERS);
const total = senders.length * MESSAGES;
const s0 = Date.now();
for (let m = 0; m < MESSAGES; m++) {
  for (const [k, c] of senders.entries()) {
    const text = `부하 메시지 ${m}-${k}-${randomBytes(3).toString('hex')}`;
    sentAt.set(text, performance.now());
    c.ws.send(JSON.stringify({ type: 'send', clientId: 'l' + m + '-' + k, text }));
  }
  await sleep(1500);
}
await waitFor(() => received >= total * joined, 30000, 200);
const after = usage(relay.pid);
const result = {
  at: new Date().toISOString(), node: process.version, definition: 'one room, Node built-in WebSocket clients in one process on the same PC as the relay (loopback); no media',
  clients: N, joined, rampSeconds: +rampS.toFixed(1), connectErrors: failures.connect, joinRefused: failures.join,
  messages: { senders: senders.length, perSender: MESSAGES, sent: total, expectedDeliveries: total * joined, delivered: received, durationS: +((Date.now() - s0) / 1000).toFixed(1) },
  deliveryMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99), max: pct(latencies, 100) },
  relayProcess: { before, afterJoin: idle, afterMessages: after },
  hostCpuLoadPct: cpuSamples.length ? { logicalCpus: cpus().length, samples: cpuSamples.length, min: Math.min(...cpuSamples), avg: Math.round(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length), max: Math.max(...cpuSamples) } : null
};
console.log(JSON.stringify(result, null, 2));
mkdirSync(join(ROOT, 'deploy/verification'), { recursive: true });
writeFileSync(join(ROOT, `deploy/verification/chat-load-${N}x${SENDERS}.json`), JSON.stringify(result, null, 2));
clearInterval(keep); clearInterval(cpuTimer);
for (const c of clients) try { c.ws.close(); } catch {}
await sleep(500);
await stopAll();
process.exit(0);
