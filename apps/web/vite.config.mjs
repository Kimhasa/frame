import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The web app lives under /_frame/; every other path (/api/*, /<path>/info, HLS, DVR, sessions, WHEP, thumbnails and the
// chat WebSocket) belongs to the relay, as behind Caddy in production. `yarn dev:relay` and `yarn preview:relay` proxy
// them to FRAME_RELAY_URL (default http://127.0.0.1:8080); plain `yarn dev` keeps the design preview data and no proxy.
export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), 'FRAME_');
  const localFile = env.FRAME_STUDIO_CONFIG || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Frame', 'obs-local', 'studio.json') : '');
  const local = command === 'serve' && !isPreview && mode !== 'relay' && mode !== 'design' && localFile && existsSync(localFile)
    ? JSON.parse(readFileSync(localFile, 'utf8')) : null;
  if (mode === 'obs' && !local) throw new Error('Start the local OBS server first: node server/obs-local.mjs start');
  if (local && (!/^http:\/\/127\.0\.0\.1:\d+$/.test(local.backendUrl) || !/^obs-[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/.test(local.path) || typeof local.token !== 'string' || local.token.length < 24)) {
    throw new Error('Invalid local OBS configuration');
  }
  const target = local?.backendUrl || env.FRAME_RELAY_URL || 'http://127.0.0.1:8080';
  const productFile = env.FRAME_PRODUCT_CONFIG || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Frame', 'product', 'config.json') : '');
  const productEnabled = Boolean(local && productFile && existsSync(productFile) && JSON.parse(readFileSync(productFile, 'utf8')).enabled === true);
  const proxy = { '^/(?!_frame(?:/|$)).*': { target, ws: true } };
  if (local) proxy['^/_frame/api/studio(?:\\?|$)'] = {
    target, ...(productEnabled ? {} : { headers: { Authorization: `Bearer ${local.token}` } }),
    rewrite: () => productEnabled ? '/api/v1/studio' : `/api/obs/${local.path}`,
  };
  if (local) proxy['^/_frame/api/payments(?:/|$)'] = {
    target, ...(productEnabled ? {} : { headers: { Authorization: `Bearer ${local.token}` } }),
    rewrite: path => path.replace(/^\/_frame\/api\//, productEnabled ? '/api/v1/' : '/api/'),
  };
  const localStudio = {
    name: 'frame-local-studio',
    configureServer(server) {
      if (!local) return;
      server.middlewares.use((req, res, next) => {
        const productRequest = req.url?.startsWith('/api/v1/') || req.url === '/api/v1';
        const studioRequest = req.url?.startsWith('/_frame/api/studio');
        const paymentRequest = req.url?.startsWith('/_frame/api/payments');
        if (!productRequest && !studioRequest && !paymentRequest) return next();
        const host = req.headers.host || '';
        const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
        const pathname = req.url.split('?')[0];
        const allowed = productRequest ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)
          : studioRequest ? ['GET', 'PUT'].includes(req.method) && pathname === '/_frame/api/studio'
          : req.method === 'GET' ? /^\/_frame\/api\/payments\/(config|orders(?:\/[A-Za-z0-9_-]{6,80})?)$/.test(pathname)
            : req.method === 'POST' && /^\/_frame\/api\/payments\/(orders|confirm)$/.test(pathname);
        if (!localHost || (req.headers.origin && req.headers.origin !== `http://${host}`) || !allowed) {
          res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end('Forbidden'); return;
        }
        next();
      });
    },
  };
  return {
    base: '/_frame/',
    plugins: [react(), localStudio],
    define: { 'import.meta.env.FRAME_STUDIO_ENABLED': JSON.stringify(Boolean(local)), 'import.meta.env.FRAME_PRODUCT_ENABLED': JSON.stringify(productEnabled) },
    server: command === 'serve' && (mode === 'relay' || local) ? { host: '127.0.0.1', proxy } : {},
    preview: { proxy },
  };
});
