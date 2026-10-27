// DVR checks against the running app: recording index, seek to the start (history), pause/resume, live return, and two
// viewers with independent positions. usage: node tools/smoke-dvr.mjs [appPort=9222] [viewerPort=9334] [startBroadcast=1]
// The second viewer is the app's own receiver tab; the first one is a separate browser (Edge with DevTools).
import { app, selectWindow, snapshot, sleep } from './app-flow.mjs';
import { connect } from './cdp.mjs';

const [, , , viewerPort = '9334', startBroadcast = '1'] = process.argv;
const out = (name, data) => console.log(name.padEnd(16), JSON.stringify(data));
const a = await app();
if (startBroadcast === '1' && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`))) {
  await a.evaluate(`document.getElementById('tab-sender').click()`);
  await selectWindow(a, 'FRAME 모션 테스트');
  await a.evaluate(`document.getElementById('start-button').click()`);
  for (let i = 0; i < 60 && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`)); i++) await sleep(250);
  out('started', (await snapshot(a)).logs.slice(0, 4));
  await sleep(20000);  // some recorded history before the checks
}
const base = await a.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`);
const index = await (await fetch(base + '/dvr', { cache: 'no-store' })).json();
out('index', { id: index.id, dvr: index.dvr, recording: index.recording, ranges: index.ranges.map(r => [new Date(r.startMs).toISOString(), ((r.endMs - r.startMs) / 1000).toFixed(2) + 's']),
  segments: index.segments.length, edgeBehindMs: Math.round(index.nowMs - index.ranges.at(-1)?.endMs) });

// Viewer 1: separate browser on the LAN address.
const v = await connect(Number(viewerPort), t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await v.send('Page.navigate', { url: base });
await sleep(2500);
await v.evaluate(`document.getElementById('viewer-connect-dialog')?.open || document.getElementById('viewer-form').requestSubmit()`);
const ready = async c => { for (let i = 0; i < 60; i++) { await sleep(500); if (await c.evaluate(`(() => { const x = document.querySelector('#viewer-preview video'); return !!(x && x.videoWidth && x.currentTime > 0.3) && !document.getElementById('player-timeline').hidden; })()`)) return true; } return false; };
out('v1 live', await ready(v));
const player = c => c.evaluate(`(() => { const x = document.querySelector('#viewer-preview video'), seek = document.getElementById('player-seek');
  return { src: x ? (x.srcObject ? 'webrtc' : x.src ? 'mse' : 'none') : null, size: x ? x.videoWidth + 'x' + x.videoHeight : '', t: x ? +x.currentTime.toFixed(2) : 0, paused: x?.paused,
    muted: x?.muted, videos: document.querySelectorAll('#viewer-preview video').length, pos: document.getElementById('player-position').textContent, dur: document.getElementById('player-duration').textContent,
    live: { disabled: document.getElementById('player-live').disabled, history: document.getElementById('player-live').classList.contains('is-history') },
    seekMin: +seek.min, seekMax: +seek.max, seekValue: +seek.value, frames: x?.getVideoPlaybackQuality ? x.getVideoPlaybackQuality().totalVideoFrames : 0,
    dropped: x?.getVideoPlaybackQuality ? x.getVideoPlaybackQuality().droppedVideoFrames : 0, buffered: x && x.buffered.length ? [+x.buffered.start(0).toFixed(2), +x.buffered.end(x.buffered.length - 1).toFixed(2)] : [] }; })()`);
out('v1 state', await player(v));
// Seek to 3 s after the first recorded moment (the "beginning of the broadcast").
const seek = (c, ms) => c.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${ms}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const first = index.ranges[0].startMs;
await seek(v, first + 3000);
for (let i = 0; i < 30 && (await player(v)).src !== 'mse'; i++) await sleep(300);
await sleep(3000);
const h1 = await player(v);
out('v1 history', h1);
out('v1 pos check', { expectSeconds: 3 + 3, shown: h1.pos, positionFromStartS: ((h1.seekValue - first) / 1000).toFixed(2) });

// Viewer 2 (the app's own receiver) stays live while viewer 1 watches the past.
await a.evaluate(`document.getElementById('open-viewer').click()`);
out('v2 live', await ready(a));
out('v2 state', await player(a));
out('v1 still past', await player(v));

// Pause in history, resume: continues from the same moment.
await v.evaluate(`document.getElementById('player-pause').click()`); await sleep(2500);
const paused = await player(v);
await v.evaluate(`document.getElementById('player-pause').click()`); await sleep(1500);
out('v1 pause/resume', { paused: paused.paused, tPaused: paused.t, tResumed: (await player(v)).t });

// Seek across the recording to 10 s before the live edge, then return to live.
const fresh = await (await fetch(base + '/dvr', { cache: 'no-store' })).json();
await seek(v, fresh.ranges.at(-1).endMs - 10000); await sleep(4000);
out('v1 near edge', await player(v));
await v.evaluate(`document.getElementById('player-live').click()`);
for (let i = 0; i < 30 && (await player(v)).src !== 'webrtc'; i++) await sleep(300);
await sleep(1500);
out('v1 back live', await player(v));

// Live pause for 6 s, resume: continues from the paused moment out of the recording.
await v.evaluate(`document.getElementById('player-pause').click()`); await sleep(6000);
await v.evaluate(`document.getElementById('player-pause').click()`);
for (let i = 0; i < 30 && (await player(v)).src !== 'mse'; i++) await sleep(300);
await sleep(2000);
out('v1 live resume', await player(v));
out('v1 log', await v.evaluate(`[...document.querySelectorAll('#log-list tr')].slice(0, 6).map(r => r.innerText.split('\\t').join(' | '))`));
const memory = await v.send('Performance.getMetrics').catch(() => null);
out('v1 heap MB', memory ? Math.round(memory.metrics.find(m => m.name === 'JSHeapUsedSize').value / 1048576) : null);
a.close(); v.close();
