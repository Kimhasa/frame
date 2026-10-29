// Stand-in for a broadcasting FrameConsole, for automatic-quality tests of the real viewer page without the app: its own
// MediaMTX (WebRTC section as native/src/streamer.cpp generates it: one ICE port for UDP and TCP, host candidates from
// every interface, on-demand lower renditions made by FFmpeg from the source path), an FFmpeg testsrc2 source, and a
// small viewer server that does what the app's viewer server does for one stream (native/src/http_server.cpp):
//   GET  /<path>                         outputs/index.html (read on every request, so a rebuilt page is picked up)
//   GET  [/<path>]/assets/fonts/<file>   outputs/assets/fonts
//   GET  /<path>/info                    the app's ViewerInfo JSON (size, fps, bitrate, renditions, iceServers)
//   *    /<path>[/<h>p]/whep[/<id>]      POST/PATCH/DELETE forwarded to MediaMTX WHEP; Location kept on this origin
//   POST /<path>/stats                   the page's playback report beacon (saved to beacons.jsonl)
//   GET  /api/broadcasts                 an empty catalog; /<path>/dvr → 404 (no recording)
// Nothing here talks to FrameConsole.exe or its ports. Ports: base (viewer server), base+1 (ICE UDP and TCP, all
// interfaces, like the app), base+2 (MediaMTX WHEP, loopback), base+3 (RTSP, loopback).
//
// usage: node tools/netem/fixtures/frame-fixture.mjs [--base-port 22600] [--path live] [--encoder h264_nvenc|libx264]
//          [--rate-control cbr|vbr] [--mbps 8] [--out <dir for logs>]          (runs until Ctrl+C or "quit" on stdin)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..', '..', '..');
export const FFMPEG = join(root, 'dist', 'FrameConsole', 'bin', 'ffmpeg.exe'), MEDIAMTX = join(root, 'dist', 'FrameConsole', 'bin', 'mediamtx.exe');
export const DEFAULT_RENDITIONS = [{ name: '720p', width: 1280, height: 720, mbps: 4 }, { name: '480p', width: 854, height: 480, mbps: 1.5 }];

// Same encoder arguments as the app (native/src/streamer.cpp VideoEncoderArgs): one IDR per second, no B-frames, CBR at
// the quality's bitrate, or VBR (constant quality 23, capped at it). CBR is the default here: on testsrc2 it really sends
// the announced bitrate, the harder case for the automatic quality.
function encoderArgs(encoder, fps, mbps, rateControl = 'cbr') {
  const kbps = Math.round(mbps * 1000) + 'k', gop = String(fps), vbr = rateControl === 'vbr';
  const a = encoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', fps > 90 ? 'superfast' : 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-sc_threshold', '0', ...(vbr ? ['-crf', '23'] : ['-b:v', kbps]), '-maxrate', kbps, '-bufsize', kbps]
    : ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-profile:v', 'high', '-zerolatency', '1', '-delay', '0', '-rc-lookahead', '0', '-no-scenecut', '1', '-forced-idr', '1', '-spatial-aq', '1', '-aq-strength', '8',
      ...(vbr ? ['-rc', 'vbr', '-cq', '23', '-b:v', '0'] : ['-rc', 'cbr', '-b:v', kbps]), '-maxrate', kbps, '-bufsize', kbps];
  return [...a, '-bf', '0', '-g', gop, '-keyint_min', gop, '-pix_fmt', 'nv12', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
}

// run: a harness createRun() (child processes by PID, logs in run.out/logs).
export async function startFixture(run, { basePort = 22600, path = 'live', encoder = 'h264_nvenc', rateControl = 'cbr', mbps = 8, fps = 60, width = 1920, height = 1080, renditions = DEFAULT_RENDITIONS, page = join(root, 'outputs', 'index.html') } = {}) {
  const P = { http: basePort, ice: basePort + 1, whep: basePort + 2, rtsp: basePort + 3 };
  const ffmpegPath = FFMPEG.replace(/\\/g, '/');
  const rendition = r => `'${ffmpegPath}' -hide_banner -nostdin -loglevel warning -rtsp_transport tcp -i rtsp://127.0.0.1:$RTSP_PORT/${path} -map 0:v:0 -map 0:a? -vf scale=${r.width}:${r.height}:flags=bilinear ${encoderArgs(encoder, fps, r.mbps, rateControl).join(' ')} -c:a copy -f rtsp -rtsp_transport tcp -pkt_size 1200 rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH`;
  const yml = [
    'logLevel: info', 'logDestinations: [stdout]', 'readTimeout: 10s', 'writeTimeout: 10s', 'writeQueueSize: 2048',
    'authInternalUsers:', "  - user: any\n    pass:\n    ips: ['127.0.0.1', '::1']\n    permissions:\n      - action: publish\n      - action: read",
    "  - user: any\n    pass:\n    ips: []\n    permissions:\n      - action: read",
    'api: false', 'metrics: false', 'pprof: false', 'playback: false',
    `rtsp: true\nrtspTransports: [tcp]\nrtspEncryption: "no"\nrtspAddress: 127.0.0.1:${P.rtsp}`, 'rtmp: false', 'hls: false', 'srt: false', 'moq: false',
    `webrtc: true\nwebrtcAddress: 127.0.0.1:${P.whep}\nwebrtcEncryption: false\nwebrtcAllowOrigins: ['*']\nwebrtcTrustedProxies: ['127.0.0.1']`,
    `webrtcLocalUDPAddress: ':${P.ice}'`, `webrtcLocalTCPAddress: ':${P.ice}'`,
    'webrtcIPsFromInterfaces: true', 'webrtcIPsFromInterfacesList: []', 'webrtcAdditionalHosts: []', 'webrtcICEServers2: []',
    'paths:', `  '${path}':`, '    source: publisher',
    ...renditions.flatMap(r => [`  '${path}/${r.name}':`, `    runOnDemand: "${rendition(r).replace(/"/g, '\\"')}"`, '    runOnDemandStartTimeout: 15s', '    runOnDemandCloseAfter: 30s']), ''].join('\n');
  writeFileSync(join(run.work, 'fixture-mediamtx.yml'), yml);
  const mediamtx = run.start('fixture-mediamtx', MEDIAMTX, [join(run.work, 'fixture-mediamtx.yml')]);
  await run.waitLine(mediamtx, /\[WebRTC\] (listener opened|started with listeners)/, 15000, 'fixture MediaMTX WebRTC listener');
  run.start('fixture-ffmpeg', FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`, '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', ...encoderArgs(encoder, fps, mbps, rateControl), '-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-application', 'lowdelay', '-frame_duration', '10',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', '-pkt_size', '1200', `rtsp://127.0.0.1:${P.rtsp}/${path}`]);
  await run.waitLine(mediamtx, new RegExp(`is publishing to path '${path}'`), 20000, 'fixture publisher');
  const startedAtMs = Date.now();
  const info = () => ({ running: true, path, width, height, fps, bitrate: mbps, audio: 'system', codec: 'H.264', elapsedMs: Date.now() - startedAtMs, startedAtMs,
    broadcastId: '', dvr: false, title: 'netem fixture', publisher: 'tools/netem', renditions: renditions.map(r => ({ name: r.name, width: r.width, height: r.height, mbps: r.mbps, fps, codec: 'H.264' })), iceServers: [] });

  const fonts = join(dirname(page), 'assets', 'fonts');
  const whepLog = join(run.out, 'whep.jsonl'), beaconLog = join(run.out, 'beacons.jsonl');
  const whepRe = new RegExp(`^/(${path})(/(?:240|360|480|720|1080|1440)p)?/whep(/[A-Za-z0-9_-]{1,128})?$`);
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, If-Match', 'Access-Control-Expose-Headers': 'Location, ETag, Link, Accept-Patch' };
  const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...cors, 'Cache-Control': 'no-store', ...(type ? { 'Content-Type': type } : {}), ...extra }); res.end(body); };
  const readBody = req => new Promise((ok, fail) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => ok(Buffer.concat(parts))); req.on('error', fail); });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x'), p = url.pathname;
      if (req.method === 'OPTIONS') return send(res, 204, '', '', { 'Access-Control-Max-Age': '600' });
      const w = whepRe.exec(p);
      if (w) {
        if (!['POST', 'PATCH', 'DELETE'].includes(req.method) || (req.method === 'POST' && w[3])) return send(res, 405, 'text/plain', 'Method not allowed');
        const body = await readBody(req), began = Date.now();
        const headers = { 'X-Forwarded-For': req.socket.remoteAddress || '127.0.0.1' };
        if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
        if (req.headers['if-match']) headers['If-Match'] = req.headers['if-match'];
        let up;
        try { up = await fetch(`http://127.0.0.1:${P.whep}${p}`, { method: req.method, headers, body: req.method === 'DELETE' ? undefined : body, signal: AbortSignal.timeout(20000) }); }
        catch (error) { appendFileSync(whepLog, JSON.stringify({ t: began, method: req.method, path: p, status: 502, ms: Date.now() - began, error: error.message }) + '\n'); return send(res, 502, 'text/plain', 'Upstream error'); }
        const text = Buffer.from(await up.arrayBuffer()), extra = {};
        for (const name of ['location', 'etag', 'link', 'accept-patch']) {
          let value = up.headers.get(name); if (!value) continue;
          if (name === 'location' && /^https?:/.test(value)) value = new URL(value).pathname;  // keep the client on this server
          extra[{ location: 'Location', etag: 'ETag', link: 'Link', 'accept-patch': 'Accept-Patch' }[name]] = value;
        }
        appendFileSync(whepLog, JSON.stringify({ t: began, method: req.method, path: p, quality: w[2] ? w[2].slice(1) : 'source', status: up.status, ms: Date.now() - began, location: extra.Location || null }) + '\n');
        return send(res, up.status, up.headers.get('content-type') || '', text, extra);
      }
      if (req.method === 'POST' && p === `/${path}/stats`) { appendFileSync(beaconLog, JSON.stringify({ t: Date.now(), ...JSON.parse((await readBody(req)).toString() || '{}') }) + '\n'); return send(res, 204, '', ''); }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
      if (p === `/${path}` || p === `/${path}/`) return send(res, 200, 'text/html; charset=utf-8', readFileSync(page));
      const font = /^(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\/assets\/fonts\/(PretendardVariable\.woff2|OFL\.txt)$/.exec(p);
      if (font && existsSync(join(fonts, font[1]))) return send(res, 200, font[1].endsWith('.woff2') ? 'font/woff2' : 'text/plain', readFileSync(join(fonts, font[1])), { 'Cache-Control': 'max-age=3600' });
      if (p === `/${path}/info`) return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(info()));
      if (/^\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/info$/.test(p)) return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ running: false, path: p.split('/')[1] }));
      if (p === '/api/broadcasts') return send(res, 200, 'application/json; charset=utf-8', '[]');
      return send(res, 404, 'text/plain', 'Not found');
    } catch (error) { try { send(res, 500, 'text/plain', String(error.message)); } catch {} }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(P.http, '127.0.0.1', ok); });
  run.log('fixture', `http://127.0.0.1:${P.http}/${path}`, 'ICE', `127.0.0.1:${P.ice}`);
  return {
    ports: P, path, url: `http://127.0.0.1:${P.http}/${path}`, target: `127.0.0.1:${P.ice}`, info: info(), encoder, rateControl, page,
    mediamtxVersion: execFileSync(MEDIAMTX, ['--version']).toString().trim(), ffmpegVersion: execFileSync(FFMPEG, ['-hide_banner', '-version']).toString().split('\n')[0].trim(),
    close: () => new Promise(ok => { server.closeAllConnections?.(); server.close(() => ok()); setTimeout(ok, 2000); }),
  };
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  const { parseArgs, createRun } = await import('../harness.mjs');
  const opt = parseArgs(process.argv.slice(2));
  const out = resolve(opt.out || join(tmpdir(), `frame-netem-fixture-log-${process.pid}`));
  mkdirSync(out, { recursive: true });
  const run = createRun(out, join(tmpdir(), `frame-netem-fixture-${process.pid}`));
  const fx = await startFixture(run, { basePort: Number(opt['base-port'] || 22600), path: opt.path || 'live', encoder: opt.encoder || 'h264_nvenc', rateControl: opt['rate-control'] || 'cbr', mbps: Number(opt.mbps || 8) });
  console.log(JSON.stringify({ event: 'fixture-ready', url: fx.url, target: fx.target, ports: fx.ports, logs: out }));
  const quit = async () => { await fx.close(); await run.stopAll(); process.exit(0); };
  process.on('SIGINT', quit);
  createInterface({ input: process.stdin }).on('line', line => { if (line.trim() === 'quit') quit(); });
}
