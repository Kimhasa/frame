import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.FRAME_PORTFOLIO_PORT || 5362);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.zip': 'application/zip' };

http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (pathname === '/_frame') { res.writeHead(302, { Location: '/_frame/live' }).end(); return; }
    let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (pathname.startsWith('/_frame/')) relative = pathname.startsWith('/_frame/assets/') ? 'site/' + pathname.slice('/_frame/'.length) : 'site/index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !/^(?:index\.html|overview\.png|frame-portfolio-screens\.zip|screens[\\/][\w.-]+|site[\\/](?:index\.html|assets[\\/][\w.-]+)|[\w-]+\.json)$/.test(relative)) { res.writeHead(404).end(); return; }
    if (!(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`FRAME portfolio: http://127.0.0.1:${port}`));
