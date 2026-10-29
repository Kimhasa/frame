// Shared quality streams (ABR-01/ABR-10) on a LAN viewer (Edge, DevTools 9334): for each lower quality, the time until
// its first frame replaces the picture when its encoder is cold (not used for > 30 s) and when it is warm (just used by
// this or another viewer), the decoded size, and the server's encoder processes (one FFmpeg per quality, not per viewer).
// usage: node tools/measure-renditions.mjs [viewer url]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, sleep } from './cdp.mjs';

const url = process.argv[2] || 'http://192.168.1.27:8889/screen-01';
const v = await connect(9334, t => t.type === 'page' && !t.url.startsWith('edge') && !t.url.startsWith('devtools'));
await v.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
await v.send('Page.navigate', { url }); await sleep(2500);
await v.evaluate(`document.getElementById('viewer-form').requestSubmit()`);
for (let i = 0; i < 60 && !(await v.evaluate(`!!(window.FrameRuntime.video && window.FrameRuntime.video.currentTime > 0.5)`)); i++) await sleep(250);
const info = await (await fetch(url + '/info')).json();
const pick = async label => {
  const t0 = Date.now();
  await v.evaluate(`(() => { document.getElementById('player-settings').click(); const b = [...document.querySelectorAll('#player-quality-options button')].find(x => x.innerText.startsWith(${JSON.stringify(label)})); b.click(); })()`);
  const want = label === '자동' ? info.height : Number(label.replace('p', ''));
  for (let i = 0; i < 200; i++) { await sleep(100); if (await v.evaluate(`(window.FrameRuntime.video?.videoHeight || 0) === ${want}`)) return Date.now() - t0; }
  return null;
};
const encoders = () => Number(execFileSync('powershell', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*rtsp://127.0.0.1:8554/*' -and $_.CommandLine -like '*-vf scale=*' }).Count`], { encoding: 'utf8' }).trim());
const rows = [];
for (const r of info.renditions) {
  const cold = await pick(r.name);
  const encodersWhileWatching = encoders();
  await pick('1080p'); await sleep(2000);
  const warm = await pick(r.name);
  rows.push({ quality: r.name, size: r.width + 'x' + r.height, mbps: r.mbps, fps: r.fps, coldSwitchMs: cold, warmSwitchMs: warm, renditionEncodersRunning: encodersWhileWatching });
  console.log(JSON.stringify(rows.at(-1)));
  await pick('1080p'); await sleep(1500);
}
await pick('자동');
mkdirSync(new URL('../verification/abr/', import.meta.url), { recursive: true });
writeFileSync(new URL('../verification/abr/renditions.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), url, source: { size: info.width + 'x' + info.height, mbps: info.bitrate, fps: info.fps }, rows }, null, 2));
v.close();
