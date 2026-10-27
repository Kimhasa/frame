// One measured streaming run against the running app (9222) and the LAN viewer page in Edge (9334).
// usage: node tools/run-measure.mjs <resolution WxH> <fps> <audio none|system|mic|mix> <seconds>
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { connect, sleep } from './cdp.mjs';
import { app, selectWindow, snapshot } from './app-flow.mjs';

const [resolution = '1920x1080', fps = '60', audio = 'none', seconds = '20'] = process.argv.slice(2);
const c = await app();
if (await c.evaluate('document.getElementById("source-row").hidden')) await selectWindow(c, 'FRAME 모션 테스트');
await c.evaluate(`(() => {
  const set = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const presets = ['30','60','90','120','144','165'];
  set('resolution', ${JSON.stringify(resolution)});
  if (presets.includes(${JSON.stringify(fps)})) set('fps', ${JSON.stringify(fps)}); else { set('fps', 'custom'); set('custom-fps', ${JSON.stringify(fps)}); }
  set('audio-source', ${JSON.stringify(audio)});
})()`);
await c.click('#start-button');
let s;
for (let i = 0; i < 40; i++) { await sleep(500); s = await snapshot(c); if (s.status !== '준비 중') break; }
if (s.status !== '송출 중') { console.log(JSON.stringify({ resolution, fps, audio, error: s.status, logs: s.logs.slice(0, 3) })); process.exit(1); }
await sleep(2000);
const v = await connect(9334, t => t.url.startsWith('http://192.168.1.27'));
if (await v.evaluate('document.getElementById("connect-button").textContent') === '연결 해제') { await v.click('#connect-button'); await sleep(1000); }
await v.click('#connect-button');
for (let i = 0; i < 30; i++) { await sleep(500); if (await v.evaluate('(() => { const x = document.querySelector("#viewer-preview video"); return !!(x && x.videoWidth && x.currentTime > 1); })()')) break; }
// Local playback muted: avoids re-capturing the viewer's own sound through system loopback on this PC.
if (await v.evaluate('document.getElementById("player-volume").value') !== '0') await v.evaluate('document.getElementById("player-mute").click()');
v.close();
const out = execFileSync(process.execPath, [new URL('measure-viewer.mjs', import.meta.url).pathname.slice(1), '9334', seconds], { encoding: 'utf8', timeout: (Number(seconds) + 30) * 1000 });
const viewer = JSON.parse(out);
// Sender side: average of the per-second CSV rows written during the measured window.
const logs = new URL('../dist/FrameConsole/data/logs/', import.meta.url);
const csvName = (await readdir(logs)).filter(n => n.startsWith('stats-')).sort().pop();
const rows = (await readFile(new URL(csvName, logs), 'utf8')).trim().split('\n');
const head = rows[0].split(','), data = rows.slice(1).map(r => Object.fromEntries(r.split(',').map((x, i) => [head[i], x]))).slice(-Number(seconds));
const avg = key => +(data.reduce((a, r) => a + Number(r[key] || 0), 0) / Math.max(1, data.length)).toFixed(1);
const sum = key => data.reduce((a, r) => a + Number(r[key] || 0), 0);
const sender = { captureFps: avg('capture_fps'), sentFps: avg('sent_fps'), newFrameFps: avg('new_frames_fps'), encoderFps: avg('encoder_fps'), skipped: sum('skipped'), serverMbps: avg('server_in_mbps'), captureToPipeMs: avg('capture_to_pipe_ms'), pipeWriteMs: avg('pipe_write_ms'), audioMixPeak: avg('audio_mix_peak'), audioPadded: sum('audio_padded'), audioDropped: sum('audio_dropped') };
s = await snapshot(c);
await c.click('#start-button'); await sleep(300);
await c.click('#confirm-stop');
for (let i = 0; i < 20; i++) { await sleep(500); if ((await snapshot(c)).status !== '종료 중') break; }
console.log(JSON.stringify({ resolution, fps: Number(fps), audio, applied: s.logs.find(l => l.includes('적용:')), sender, viewer }));
c.close();
