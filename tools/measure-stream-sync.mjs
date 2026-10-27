// A/V offset of the published stream (no browser involved): reads rtsp://127.0.0.1:<port>/<path> with the bundled FFmpeg,
// finds the motion-test flash in video and the beep in audio, and prints audio-minus-video onset differences.
// usage: node tools/measure-stream-sync.mjs [seconds] [crop w:h:x:y] [rtsp url]
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [seconds = '15', crop = '180:150:1630:100', url = 'rtsp://127.0.0.1:8554/screen-01'] = process.argv.slice(2);
const ffmpeg = fileURLToPath(new URL('../dist/FrameConsole/bin/ffmpeg.exe', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'frame-sync-'));
const log = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-rtsp_transport', 'tcp', '-i', url, '-t', seconds, '-filter_complex',
    `[0:v]crop=${crop},signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=flash.txt[v];[0:a]silencedetect=n=-35dB:d=0.3[a]`,
    '-map', '[v]', '-map', '[a]', '-f', 'null', '-'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 }).stderr || '';
const samples = [];
let t = null;
for (const line of readFileSync(join(dir, 'flash.txt'), 'utf8').split(/\r?\n/)) {
  const p = line.match(/pts_time:([\d.]+)/); if (p) t = +p[1];
  const y = line.match(/YAVG=([\d.]+)/); if (y && t !== null) samples.push([t, +y[1]]);
}
const flashes = [];
for (let i = 1; i < samples.length; i++) if (samples[i][1] > 120 && samples[i - 1][1] <= 120) flashes.push(samples[i][0]);
const beeps = [...(log || '').matchAll(/silence_end: ([\d.]+)/g)].map(m => +m[1]);
const offsets = beeps.map(b => { let best = null; for (const f of flashes) if (best === null || Math.abs(b - f) < Math.abs(b - best)) best = f; return best === null ? null : (b - best) * 1000; })
  .filter(v => v !== null && Math.abs(v) < 500).sort((a, b) => a - b);
console.log(JSON.stringify({ seconds: Number(seconds), flashes: flashes.length, beeps: beeps.length, audioMinusVideoMs: offsets.length ? { median: +offsets[offsets.length >> 1].toFixed(1), min: +offsets[0].toFixed(1), max: +offsets[offsets.length - 1].toFixed(1) } : null }));
