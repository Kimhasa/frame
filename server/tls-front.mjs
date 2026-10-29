// Local stand-in for the production Caddy front (deploy/Caddyfile.example), for verification without downloading Caddy:
// terminates TLS, sets X-Forwarded-For/-Proto/-Host the way Caddy does (client value replaced, not appended to), streams
// responses unbuffered (DVR chunks, LL-HLS) and passes WebSocket upgrades through for WSS chat.
// Usage: node server/tls-front.mjs --listen 127.0.0.1:24443 --upstream 127.0.0.1:24080 --cert c.pem --key k.pem
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const [lhost, lport] = (arg('listen') || '127.0.0.1:24443').split(':');
const [uhost, uport] = (arg('upstream') || '127.0.0.1:24080').split(':');
const hop = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

function forwardHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!hop.has(k) && !k.startsWith('x-forwarded-')) h[k] = v;
  h['x-forwarded-for'] = req.socket.remoteAddress.replace(/^::ffff:/, '');
  h['x-forwarded-proto'] = 'https';
  h['x-forwarded-host'] = req.headers.host || '';
  return h;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
const server = https.createServer({ cert: readFileSync(arg('cert')), key: readFileSync(arg('key')) }, (req, res) => {
  const up = http.request({ host: uhost, port: uport, method: req.method, path: req.url, headers: forwardHeaders(req), agent }, r => {
    const headers = { ...r.headers };
    for (const k of hop) delete headers[k];
    res.writeHead(r.statusCode, headers);
    r.pipe(res);
    r.on('aborted', () => res.destroy());  // keep an upstream break visible to the browser (no clean end)
    r.on('error', () => res.destroy());
  });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Bad gateway'); } else res.destroy(); });
  req.pipe(up);
});
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(Number(uport), uhost, () => {
    const headers = { ...forwardHeaders(req), connection: 'Upgrade', upgrade: req.headers.upgrade };
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const close = () => { socket.destroy(); up.destroy(); };
  up.on('error', close); socket.on('error', close); up.on('close', close); socket.on('close', close);
});
server.listen(Number(lport), lhost, () => console.log(`tls-front https://${lhost}:${lport} -> http://${uhost}:${uport}`));
