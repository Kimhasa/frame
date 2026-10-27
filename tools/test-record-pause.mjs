// Disk-space pause/resume of the recording while live. Prepare: a large filler file on the recordings drive and
// recordMinFreeGB set just below the free space (so recording pauses after a few MB). This script starts the broadcast,
// waits for the pause event, deletes the filler (free space recovers), waits for the resume event, then checks that
// live playback never stopped and that the DVR index has a gap the viewer skips over.
// usage: node tools/test-record-pause.mjs <filler-file>
import { unlinkSync, existsSync } from 'node:fs';
import { app, selectWindow, snapshot, sleep } from './app-flow.mjs';
import { connect } from './cdp.mjs';

const filler = process.argv[2];
const out = (name, data) => console.log(new Date().toISOString().slice(11, 19), name.padEnd(12), JSON.stringify(data));
const a = await app();
await a.evaluate(`document.getElementById('tab-sender').click()`);
await selectWindow(a, 'FRAME 모션 테스트');
await a.evaluate(`document.getElementById('start-button').click()`);
for (let i = 0; i < 60 && !(await a.evaluate(`document.getElementById('start-button').innerText.includes('종료')`)); i++) await sleep(250);
const base = await a.evaluate(`'http://' + document.getElementById('server-host').value + ':' + document.getElementById('viewer-port').value + '/' + document.getElementById('stream-path').value`);
const index = async () => { const j = await (await fetch(base + '/dvr', { cache: 'no-store' })).json(); return { recording: j.recording, ranges: (j.ranges || []).map(r => [new Date(r.startMs).toISOString().slice(11, 23), +((r.endMs - r.startMs) / 1000).toFixed(1)]), raw: j.ranges }; };
const events = async () => (await snapshot(a)).logs.filter(l => l.includes('녹화'));
out('started', (await events()).slice(0, 2));
const v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Page.navigate', { url: base });
await sleep(2500);
await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
const viewer = () => v.evaluate(`(() => { const x = document.querySelector('#viewer-preview video'); return { src: x ? (x.srcObject ? 'webrtc' : 'mse') : null, playing: !!(x && x.videoWidth && !x.paused), t: x ? +x.currentTime.toFixed(1) : 0, timeline: !document.getElementById('player-timeline').hidden, dur: document.getElementById('player-duration').textContent }; })()`);
const until = async (label, test, seconds) => { for (let i = 0; i < seconds; i++) { await sleep(1000); const e = await events(); if (e.some(test)) { out(label, { events: e.slice(0, 2), index: (await index()).ranges, viewer: await viewer() }); return true; } } out(label + ' timeout', { index: (await index()).ranges }); return false; };
if (await until('paused', l => l.includes('녹화를 멈췄습니다'), 300)) {
  await sleep(12000);
  out('while paused', { index: (await index()).ranges, viewer: await viewer() });
  if (filler && existsSync(filler)) unlinkSync(filler);
  out('filler', 'deleted');
  await until('resumed', l => l.includes('다시 시작'), 60);
  await sleep(8000);
  const idx = await index();
  out('after', { index: idx.ranges, viewer: await viewer() });
  // Seek into the gap: playback continues at the start of the next recorded part.
  if (idx.raw.length >= 2) {
    const gap = idx.raw[0].endMs + (idx.raw[1].startMs - idx.raw[0].endMs) / 2;
    await v.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${idx.raw[0].endMs - 3000}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(9000);
    const p = await v.evaluate(`({ ...window.FrameRuntime.playback, t: window.FrameRuntime.video.currentTime, pos: window.FrameRuntime.playback.base + window.FrameRuntime.video.currentTime * 1000 })`);
    out('across gap', { startedAt: 'end of range 1 - 3 s', positionMs: Math.round(p.pos), range2StartMs: Math.round(idx.raw[1].startMs), passedGap: p.pos > idx.raw[1].startMs, gapMid: Math.round(gap) });
    await v.evaluate(`(() => { const s = document.getElementById('player-seek'); s.value = ${gap}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(4000);
    const q = await v.evaluate(`({ pos: window.FrameRuntime.playback.base + window.FrameRuntime.video.currentTime * 1000, mode: window.FrameRuntime.playback.mode })`);
    out('seek in gap', { mode: q.mode, positionMs: Math.round(q.pos), range2StartMs: Math.round(idx.raw[1].startMs), landedInRange2: q.pos >= idx.raw[1].startMs - 50 });
  }
}
a.close(); v.close();
