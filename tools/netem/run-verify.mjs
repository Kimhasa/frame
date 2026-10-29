// End-to-end check that the shaper sits on the real WebRTC media path: a standalone MediaMTX (same WebRTC settings as
// the app: one ICE UDP port, host candidates from every interface, a TCP candidate) receives an FFmpeg testsrc2
// 1080p60 H.264 (no B-frames, 1 s GOP) + Opus publish, headless Edge reads it over WHEP through udp-proxy.mjs (attached
// with attach.mjs), and the proxy counters are compared with the browser's getStats for every profile step.
// Nothing here starts or talks to FrameConsole.exe; all ports are in 22000-22999.
// usage: node tools/netem/run-verify.mjs [--profile steps] [--time-scale 1] [--rate-scale 1] [--out verification/netem/<name>]
//          [--page whep|mediamtx] [--encoder h264_nvenc|libx264] [--mbps 8] [--warmup 12] [--no-attach] [--keep-local-candidates]
//          [--edge-args "--disable-accelerated-video-decode ..."] [--base-port 22100]
// --base-port moves every port of the run to base..base+6 (page, ICE UDP, ICE TCP, proxy, DevTools, RTSP, WHEP), so two
// runs can coexist; without it the ports are 22080, 22189, 22190, 22300, 22222, 22554 and 22889.
// --target-host localhost gives the proxy a host name instead of an IP (it is resolved once, to IPv4).
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { attach } from './attach.mjs';
import { loadProfile } from './profile.mjs';
import { parseArgs, createRun, startShaper, launchEdge, playProfile, closeEdge, writeResults, hostInfo } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..', '..');
const opt = parseArgs(process.argv.slice(2));
const profileName = opt.profile || 'steps';
const profileFile = existsSync(profileName) ? resolve(profileName) : join(here, 'profiles', profileName + '.json');
const timeScale = Number(opt['time-scale'] || 1), rateScale = Number(opt['rate-scale'] || 1), warmup = Number(opt.warmup || 12);
const encoder = opt.encoder || 'h264_nvenc', mbps = Number(opt.mbps || 8), attachPage = !opt['no-attach'], page = opt.page || 'whep';
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const out = resolve(opt.out || join(root, 'verification', 'netem', `${profileName}-${stamp}`));
const base = opt['base-port'] ? Number(opt['base-port']) : null;
if (base !== null && !(base >= 1024 && base + 6 <= 65535)) throw new Error('--base-port must leave room for 7 ports');
const P = base !== null ? { page: base, iceUdp: base + 1, iceTcp: base + 2, proxy: base + 3, devtools: base + 4, rtsp: base + 5, webrtc: base + 6 }
  : { rtsp: 22554, webrtc: 22889, iceUdp: 22189, iceTcp: 22190, proxy: 22300, devtools: 22222, page: 22080 };
const FFMPEG = join(root, 'dist', 'FrameConsole', 'bin', 'ffmpeg.exe'), MEDIAMTX = join(root, 'dist', 'FrameConsole', 'bin', 'mediamtx.exe');
const run = createRun(out, join(tmpdir(), `frame-netem-${process.pid}`));

// ---- media server and publisher -----------------------------------------------------------------------------------
// The WebRTC section mirrors native/src/streamer.cpp's generated config, with this run's ports.
writeFileSync(join(run.work, 'mediamtx.yml'), [
  'logLevel: info', 'logDestinations: [stdout]', 'readTimeout: 10s', 'writeTimeout: 10s', 'writeQueueSize: 2048',
  'authInternalUsers:', "  - user: any\n    pass:\n    ips: ['127.0.0.1', '::1']\n    permissions:\n      - action: publish\n      - action: read",
  "  - user: any\n    pass:\n    ips: []\n    permissions:\n      - action: read",
  'api: false', 'metrics: false', 'pprof: false', 'playback: false',
  `rtsp: true\nrtspTransports: [tcp]\nrtspEncryption: "no"\nrtspAddress: 127.0.0.1:${P.rtsp}`, 'rtmp: false', 'hls: false', 'srt: false', 'moq: false',
  `webrtc: true\nwebrtcAddress: 127.0.0.1:${P.webrtc}\nwebrtcEncryption: false\nwebrtcAllowOrigins: ['*']`,
  `webrtcLocalUDPAddress: ':${P.iceUdp}'`, `webrtcLocalTCPAddress: ':${P.iceTcp}'`,
  'webrtcIPsFromInterfaces: true', 'webrtcIPsFromInterfacesList: []', 'webrtcAdditionalHosts: []', 'webrtcICEServers2: []',
  'paths:', '  test:', '    source: publisher', ''].join('\n'));
const mediamtx = run.start('mediamtx', MEDIAMTX, [join(run.work, 'mediamtx.yml')]);
await run.waitLine(mediamtx, /\[WebRTC\] (listener opened|started with listeners)/, 15000, 'MediaMTX WebRTC listener');
// Same rate control as the app's first-choice encoder (native/src/streamer.cpp VideoEncoderArgs).
const encoderArgs = encoder === 'libx264'
  ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-sc_threshold', '0', '-b:v', mbps + 'M', '-maxrate', mbps + 'M', '-bufsize', mbps + 'M']
  : ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-profile:v', 'high', '-zerolatency', '1', '-delay', '0', '-rc-lookahead', '0', '-no-scenecut', '1', '-forced-idr', '1', '-rc', 'cbr', '-b:v', mbps + 'M', '-maxrate', mbps + 'M', '-bufsize', mbps + 'M'];
run.start('ffmpeg', FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-map', '0:v', '-map', '1:a', ...encoderArgs, '-bf', '0', '-g', '60', '-keyint_min', '60', '-pix_fmt', 'nv12',
  '-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-application', 'lowdelay', '-frame_duration', '10', '-f', 'rtsp', '-rtsp_transport', 'tcp', '-pkt_size', '1200', `rtsp://127.0.0.1:${P.rtsp}/test`]);
await run.waitLine(mediamtx, /is publishing to path 'test'/, 20000, 'publisher');

// ---- shaper, test page, browser -----------------------------------------------------------------------------------
const profile = loadProfile(profileFile, { timeScale, rateScale });
const targetHost = typeof opt['target-host'] === 'string' ? opt['target-host'] : '127.0.0.1';
const proxy = await startShaper(run, { listen: `127.0.0.1:${P.proxy}`, target: `${targetHost}:${P.iceUdp}`, profileFile, timeScale, rateScale });
// The test page is served over HTTP (Edge refuses fetch from a file:// page to a loopback server) and talks to
// MediaMTX's WHEP endpoint cross-origin, which webrtcAllowOrigins permits.
const pageServer = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(readFileSync(join(here, 'whep-viewer.html'))); });
await new Promise(r => pageServer.listen(P.page, '127.0.0.1', r));
const edgeArgs = typeof opt['edge-args'] === 'string' ? opt['edge-args'].split(/\s+/).filter(Boolean) : [];
const { client, version } = await launchEdge(run, { port: P.devtools, extraArgs: edgeArgs });
// Control run (--no-attach): the proxy runs the same profile but the page keeps MediaMTX's own candidates (same stats
// hook, no SDP rewrite), which shows what an unattached viewer gets.
await attach(client, attachPage ? { proxy: `127.0.0.1:${P.proxy}`, keepLocalCandidates: !!opt['keep-local-candidates'] } : { recordOnly: true });
const viewerUrl = page === 'mediamtx' ? `http://127.0.0.1:${P.webrtc}/test` : `http://127.0.0.1:${P.page}/?whep=${encodeURIComponent(`http://127.0.0.1:${P.webrtc}/test/whep`)}`;
await client.send('Page.navigate', { url: viewerUrl });
run.log('viewer', viewerUrl);

const pageState = await playProfile(run, { client, proxy, profile, warmup, probe: opt.probe && opt.probe !== true ? opt.probe : null });
await closeEdge(client);
await run.stopAll();
pageServer.close();

writeResults(out, { tool: 'tools/netem/run-verify.mjs', date: new Date().toISOString(), host: hostInfo(), browser: version.Browser, userAgent: version['User-Agent'],
  mediamtx: execFileSync(MEDIAMTX, ['--version']).toString().trim(), ffmpeg: execFileSync(FFMPEG, ['-hide_banner', '-version']).toString().split('\n')[0].trim(),
  source: { video: 'testsrc2 1920x1080 60fps', encoder, mbps, gop: 60, bframes: 0, audio: 'sine 440 Hz, Opus 128k stereo 10 ms' },
  page, viewerUrl, edgeArgs, attached: attachPage, proxy: { listen: `127.0.0.1:${P.proxy}`, target: `${targetHost}:${P.iceUdp}`, keepLocalCandidates: !!opt['keep-local-candidates'] },
  profile: { file: profileFile, name: profile.name, timeScale, rateScale, total: profile.total, steps: profile.steps.map(s => ({ label: s.label, start: s.start, duration: s.duration })) },
  warmupSeconds: warmup, ports: P, page_state: pageState });
run.log('results in', out);
