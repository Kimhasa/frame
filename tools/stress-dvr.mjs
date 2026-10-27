// DVR edge cases on a LAN viewer (Edge, DevTools 9334) of the running broadcast:
// rapid successive seeks (only the last one wins, one media element, bounded memory), a live pause (timeline stays on
// the paused moment, Live returns straight to the live session), and a quality pick while a seek is loading.
// usage: node tools/stress-dvr.mjs [viewerPort=9334]
import { connect, sleep } from './cdp.mjs';

const [port = '9334'] = process.argv.slice(2);
const c = await connect(Number(port), t => /:\d+\/[A-Za-z0-9_-]+/.test(t.url));
await c.send('Performance.enable');
const out = (name, data) => console.log(name.padEnd(16), JSON.stringify(data));
const state = () => c.evaluate(`(() => { const p = window.FrameRuntime.playback, v = window.FrameRuntime.video;
  return { mode: p.mode, position: p.base !== null && v ? Math.round(p.base + v.currentTime * 1000) : null, videos: document.querySelectorAll('video').length,
    src: v ? (v.srcObject ? 'webrtc' : 'mse') : null, paused: v ? v.paused : null, liveEnabled: !document.getElementById('player-live').disabled,
    seekValue: +document.getElementById('player-seek').value, edge: p.ranges ? Math.round(p.ranges.at(-1).endMs) : null, first: p.ranges ? Math.round(p.ranges[0].startMs) : null }; })()`);
const heap = async () => Math.round((await c.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSHeapUsedSize').value / 1048576);
const seek = ms => c.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${ms}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
let s = await state();
if (!s.first) { out('no dvr', s); process.exit(1); }
out('start', { ...s, heapMB: await heap() });
// 10 seeks 120 ms apart across the recording; the last target must win.
const span = s.edge - s.first, targets = Array.from({ length: 10 }, (_, i) => Math.round(s.first + span * ((i * 37) % 10 + 0.5) / 12));
for (const t of targets) { await seek(t); await sleep(120); }
const last = targets.at(-1);
for (let i = 0; i < 40; i++) { await sleep(300); s = await state(); if (s.mode === 'history' && Math.abs(s.position - last) < 4000) break; }
await sleep(2000); s = await state();
out('rapid seeks', { lastTargetFromStartS: +((last - s.first) / 1000).toFixed(1), positionFromStartS: +((s.position - s.first) / 1000).toFixed(1), driftS: +((s.position - last) / 1000).toFixed(1), videos: s.videos, mode: s.mode, heapMB: await heap() });
// Back to live, pause on live for 5 s: timeline holds the paused moment; Live goes straight back to the live session.
await c.evaluate(`document.getElementById('player-live').click()`);
for (let i = 0; i < 30 && (await state()).src !== 'webrtc'; i++) await sleep(300);
await sleep(1500);
await c.evaluate(`document.getElementById('player-pause').click()`); await sleep(5000);
const pausedState = await state();
out('live paused', { mode: pausedState.mode, liveEnabled: pausedState.liveEnabled, seekBehindEdgeS: +((pausedState.edge - pausedState.seekValue) / 1000).toFixed(1), src: pausedState.src, paused: pausedState.paused });
await c.evaluate(`document.getElementById('player-live').click()`); await sleep(1500);
out('live button', await state());
// Quality pick while a seek is loading: the seek is cancelled, the quality switch wins, nothing is left half-loaded.
await seek(s.first + 5000);
await sleep(50);
const options = await c.evaluate(`(() => { document.getElementById('player-settings').click(); return [...document.querySelectorAll('#player-quality-options button')].map(b => b.innerText.split('\\n')[0]); })()`);
const lower = await c.evaluate(`(() => { const b = [...document.querySelectorAll('#player-quality-options button')].at(-1); b.click(); return b.innerText.split('\\n')[0]; })()`);
await sleep(6000);
s = await state();
out('seek+quality', { options, picked: lower, mode: s.mode, src: s.src, videos: s.videos, label: await c.evaluate(`document.getElementById('player-quality-label').textContent`) });
out('heap end MB', await heap());
c.close();
