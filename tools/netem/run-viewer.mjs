// Runs a network profile against a WebRTC viewer page — the FRAME viewer of a running broadcast, for automatic-quality
// (ABR) tests — by starting udp-proxy.mjs toward the server's ICE UDP port, opening the page in its own Edge (own
// profile and DevTools port), attaching the SDP rewrite, and recording every RTCPeerConnection's getStats plus the
// page's automatic-quality state (window.FrameRuntime.abr: mode, playing quality, decisions; the video's decoded and
// shown size) once a second. Writes the per-step summary, the ABR summary (abr.csv, summary.json "abr") and the raw
// logs to the output folder. It does not start, stop or configure the sender; it opens the viewer URL like any viewer.
//
// FrameConsole: page http://<host>:8889/<path>; WHEP goes through the viewer server (/<path>/whep and
// /<path>/<h>p/whep); ICE is one UDP port (default 8189) for every path, so the default --target is <url host>:8189.
// usage: node tools/netem/run-viewer.mjs --url http://<sender-ip>:8889/<path> [--target <sender-ip>:8189]
//          [--profile abr-steps] [--time-scale 1] [--rate-scale 1] [--out verification/netem/viewer-<profile>-<time>]
//          [--headed] [--size 1600,1000] [--dpr 2] [--warmup 15] [--click <css selector>] [--server <ip>]
//          [--probe frame|none|<js expression>] [--proxy-port 22301] [--devtools 22223] [--edge-args "..."]
//        node tools/netem/run-viewer.mjs --fixture [--fixture-port 22600] [--encoder h264_nvenc|libx264] [--rate-control cbr|vbr] ...
//          (--fixture: tools/netem/fixtures/frame-fixture.mjs stands in for the app, with outputs/index.html as the page)
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sleep } from '../cdp.mjs';
import { attach, resolveProbe } from './attach.mjs';
import { loadProfile } from './profile.mjs';
import { resolveHostPort } from './udp-proxy.mjs';
import { parseArgs, createRun, startShaper, launchEdge, playProfile, closeEdge, writeResults, hostInfo } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..', '..');
const opt = parseArgs(process.argv.slice(2));
if (!opt.url && !opt.fixture) {
  console.error('usage: node tools/netem/run-viewer.mjs --url http://<sender-ip>:8889/<path> [--target <sender-ip>:8189] [--profile abr-steps] [--headed] | --fixture');
  process.exit(2);
}
const profileName = opt.profile || 'abr-steps';
const profileFile = existsSync(profileName) ? resolve(profileName) : join(here, 'profiles', profileName + '.json');
const timeScale = Number(opt['time-scale'] || 1), rateScale = Number(opt['rate-scale'] || 1), warmup = Number(opt.warmup || 15);
const proxyPort = Number(opt['proxy-port'] || 22301), devtools = Number(opt.devtools || 22223);
const size = typeof opt.size === 'string' ? opt.size : '1600,1000', dpr = opt.dpr === undefined ? 2 : Number(opt.dpr) || null;
const probe = resolveProbe(opt.probe);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const out = resolve(opt.out || join(root, 'verification', 'netem', `viewer-${profileName}-${stamp}`));
const run = createRun(out, join(tmpdir(), `frame-netem-viewer-${process.pid}`));

let fixture = null;
if (opt.fixture) {
  const { startFixture } = await import('./fixtures/frame-fixture.mjs');
  fixture = await startFixture(run, { basePort: Number(opt['fixture-port'] || 22600), encoder: opt.encoder || 'h264_nvenc', rateControl: opt['rate-control'] || 'cbr', mbps: Number(opt.mbps || 8) });
}
const url = opt.url || fixture.url;
const target = opt.target || (fixture ? fixture.target : `${new URL(url).hostname}:8189`);
const resolved = await resolveHostPort(target);
run.log('target', target, resolved.address !== resolved.name ? `(${resolved.address})` : '');

const profile = loadProfile(profileFile, { timeScale, rateScale });
const proxy = await startShaper(run, { listen: `127.0.0.1:${proxyPort}`, target, profileFile, timeScale, rateScale });
const edgeArgs = typeof opt['edge-args'] === 'string' ? opt['edge-args'].split(/\s+/).filter(Boolean) : [];
const { client, version } = await launchEdge(run, { port: devtools, headed: !!opt.headed, size, dpr, extraArgs: edgeArgs });
// --server keeps only the server's candidates on that address (a host name is resolved once, to IPv4, in attach()).
const { cfg: attached } = await attach(client, { proxy: `127.0.0.1:${proxyPort}`, server: typeof opt.server === 'string' ? opt.server : null });
const server = attached.serverAddress ? attached.serverAddress + (attached.serverPort ? ':' + attached.serverPort : '') : null;
await client.send('Page.navigate', { url });
run.log('viewer', url);
if (opt.click) {
  // e.g. a broadcast card that has to be opened before playback starts
  for (let i = 0; i < 40; i++) { await sleep(500); if (await client.evaluate(`!!document.querySelector(${JSON.stringify(opt.click)})`).catch(() => false)) break; }
  await client.click(opt.click).catch(error => run.log('click failed:', error.message));
}

const pageState = await playProfile(run, { client, proxy, profile, warmup, probe });
const abrState = probe ? await client.evaluate(probe).catch(error => ({ error: error.message })) : null;
await closeEdge(client);
if (fixture) await fixture.close();
await run.stopAll();
const summary = writeResults(out, { tool: 'tools/netem/run-viewer.mjs', date: new Date().toISOString(), host: hostInfo(), browser: version.Browser, userAgent: version['User-Agent'],
  viewerUrl: url, window: { size, dpr, headed: !!opt.headed }, edgeArgs, proxy: { listen: `127.0.0.1:${proxyPort}`, target, targetResolved: resolved.address, server },
  probe: probe === resolveProbe('frame') ? 'frame (tools/netem/attach.mjs FRAME_PROBE)' : probe,
  fixture: fixture && { url: fixture.url, target: fixture.target, ports: fixture.ports, info: fixture.info, encoder: fixture.encoder, rateControl: fixture.rateControl, page: fixture.page, mediamtx: fixture.mediamtxVersion, ffmpeg: fixture.ffmpegVersion },
  profile: { file: profileFile, name: profile.name, timeScale, rateScale, total: profile.total, steps: profile.steps.map(s => ({ label: s.label, start: s.start, duration: s.duration })) },
  warmupSeconds: warmup, page_state: pageState, abr_state_at_end: abrState });
run.log('results in', out);
if (summary.abr) run.log('ABR', JSON.stringify(summary.abr.totals));
