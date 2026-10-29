// /api/stats on the real app: opens one LAN viewer (Edge, DevTools 9334), then checks that the aggregate counters follow
// it (WebRTC session, path reader, bytes sent at about the stream rate) and drop back after the viewer leaves.
// usage: node tools/test-stats-api.mjs [viewer url]
import { connect, sleep } from './cdp.mjs';

const url = process.argv[2] || 'http://192.168.1.27:8889/screen-01';
const origin = new URL(url).origin, path = new URL(url).pathname.slice(1);
const stats = async () => (await fetch(origin + '/api/stats', { cache: 'no-store' })).json();
const v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1200, deviceScaleFactor: 1, mobile: false });
const before = await stats();
await v.send('Page.navigate', { url }); await sleep(2500);
await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
for (let i = 0; i < 60 && !(await v.evaluate(`!!(window.FrameRuntime.video && window.FrameRuntime.video.currentTime > 0.5)`)); i++) await sleep(250);
await sleep(1500);
const a = await stats(); await sleep(5000); const b = await stats();
const mbps = (b.webrtc.bytesSent - a.webrtc.bytesSent) * 8 / ((b.timeMs - a.timeMs) / 1000) / 1e6;
const playing = await v.evaluate(`window.FrameRuntime.abr.playing`);
await v.send('Page.navigate', { url: 'about:blank' }); await sleep(3000);
const after = await stats();
await v.send('Emulation.clearDeviceMetricsOverride');
const readers = s => Object.values(s.paths).reduce((n, p) => n + p.readers, 0);
const out = { before: { sessions: before.webrtc.sessions, readers: readers(before) }, watching: { sessions: b.webrtc.sessions, readers: readers(b), playing, sendMbps: +mbps.toFixed(2), chat: b.chat, http: b.http },
  after: { sessions: after.webrtc.sessions, readers: readers(after) }, sourcePath: b.paths[path] };
console.log(JSON.stringify(out, null, 1));
const ok = out.watching.sessions === out.before.sessions + 1 && out.watching.readers >= 1 && mbps > 0.3 && out.after.sessions === out.before.sessions;
console.log(ok ? 'PASS' : 'FAIL');
v.close();
process.exitCode = ok ? 0 : 1;
