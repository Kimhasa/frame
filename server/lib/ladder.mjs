// Quality ladder of a broadcast on the relay, the same contract as the app's viewer server (Streamer::EnsureLadder in
// native/src/streamer.cpp): one FFmpeg per broadcast decodes the source once and publishes a copy of it (<path>/src) and
// every relay-side lower quality (<path>/<h>p). All outputs keep the input timestamps and share one
// -start_time_realtime, so their RTCP sender reports put a frame at the same wall time on every path; MediaMTX keeps those
// absolute times (useAbsoluteTimestamp in mediamtx-relay.yml), so the HLS variants carry the same timestamps and
// PROGRAM-DATE-TIMEs and players switch between them without gaps. (Separate per-quality encoders started at different
// moments gave each variant its own timeline, about 0.3 s apart.) Started once when the broadcast's media is ready (a
// new ladder path only takes frames from FFmpeg's second RTCP sender report, 5 s after its start: MediaMTX drops the
// first, sent before it knows the SSRC, so a start on a viewer's request made that viewer wait about 8 s), then again by
// a request after an idle stop; stopped when none of its paths had a reader for idleMs. No per-viewer encoder.
// Failure policy (the app's): a ladder that exits before any of its paths was published starts a failure streak; each
// further such exit doubles the wait before the next start (3 s up to 60 s), and while the streak lasts the broadcast's
// live.m3u8 plays the source path itself (failing()), so viewers keep watching. The first published path ends the streak.
import { spawn } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A ladder path published by this ladder `l`: ready since it started (the relay's path list may still show the previous
// ladder's publisher for a moment after a restart; its muxer is gone, so treating it as ready would answer 404s).
const mine = (p, l) => !!p?.ready && (!p.readyMs || p.readyMs >= l.startedAt - 1000);
const RETRY_MS = 3000, RETRY_MAX_MS = 60000;

export class Ladders {
  constructor({ ffmpeg, rtsp, idleMs }, mtx, log, onStarted = () => {}) {
    this.ffmpeg = ffmpeg; this.rtsp = rtsp.replace(/\/$/, ''); this.idleMs = idleMs;
    this.mtx = mtx; this.log = log; this.onStarted = onStarted;
    this.ladders = new Map();  // path -> { child, key, list, usedAt, ready:Set, published, exited, stopped, retryAt, tail }
    // path -> consecutive exits before any path was published; kept across restarts (a new ladder object each time).
    this.streaks = new Map();
  }

  // The broadcast's ladder keeps failing before it publishes anything: list the source path itself, not src/ or qualities.
  failing(path) { return this.streaks.has(path); }

  published(path, l, name) {
    l.ready.add(name);
    if (l.published) return;
    l.published = true;
    if (this.streaks.delete(path)) this.log('info', `quality encoder for /${path} publishes again`);
  }

  // FFmpeg arguments: the source copy, then each quality (scale=-2:H, libx264 at the configured rate, the source frame
  // rate, keyframes where the source has them, both audio tracks copied in the source's order).
  args(path, list, startUs) {
    const out = name => ['-start_time_realtime', String(startUs), '-f', 'rtsp', '-rtsp_transport', 'tcp', '-pkt_size', '1190', `${this.rtsp}/${path}/${name}`];
    const graph = `[0:v:0]split=${list.length}${list.map((_, i) => `[s${i}]`).join('')}` +
      list.map((r, i) => `;[s${i}]scale=-2:${r.height}:flags=bilinear[v${i}]`).join('');
    // One decoding thread: no frame-threading delay and less memory.
    const a = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-threads', '1', '-rtsp_transport', 'tcp', '-i', `${this.rtsp}/${path}`, '-filter_complex', graph,
      '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', ...out('src')];
    list.forEach((r, i) => {
      const kbps = `${Math.round(r.mbps * 1000)}k`;
      a.push('-map', `[v${i}]`, '-map', '0:a?', '-fps_mode', 'passthrough', '-enc_time_base:v', 'filter',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-bf', '0', '-pix_fmt', 'yuv420p',
        '-force_key_frames', 'source', '-sc_threshold', '0', '-b:v', kbps, '-maxrate', kbps, '-bufsize', kbps, '-c:a', 'copy', ...out(r.name));
    });
    return a;
  }

  // Makes sure the ladder of `path` (qualities `list`: [{name, height, mbps}]) runs; with waitMs, waits until the MediaMTX
  // path `want` (<path>/src or <path>/<h>p) is published. false: not ready in time, or restarting after an exit.
  async ensure(path, list, want, waitMs) {
    if (!list.length) return false;
    const key = list.map(r => `${r.name}:${r.mbps}`).join(',');
    let l = this.ladders.get(path);
    if (l && !l.exited && l.key !== key) { this.stop(path, 'qualities changed'); l = null; }
    if (l?.exited) {
      if (Date.now() < l.retryAt) return false;
      this.ladders.delete(path);
      l = null;
    }
    if (!l) l = this.start(path, list, key);
    l.usedAt = Date.now();
    if (l.ready.has(want)) return true;
    if (!waitMs) return true;
    for (const until = Date.now() + waitMs; Date.now() < until && !l.exited;) {
      if (mine((await this.mtx.list()).get(want), l)) { this.published(path, l, want); return true; }
      await sleep(200);
    }
    return false;
  }

  start(path, list, key) {
    const startUs = Date.now() * 1000;
    const l = { key, list, startedAt: Date.now(), usedAt: Date.now(), ready: new Set(), published: false, exited: false, stopped: false, retryAt: 0, tail: [] };
    l.child = spawn(this.ffmpeg, this.args(path, list, startUs), { stdio: ['ignore', 'ignore', 'pipe'] });
    l.child.stderr.setEncoding('utf8');
    l.child.stderr.on('data', d => {
      for (const line of d.split(/\r?\n/)) if (line.trim()) { l.tail.push(line.slice(0, 300)); if (l.tail.length > 4) l.tail.shift(); }
    });
    const ended = why => {
      if (l.exited) return;
      l.exited = true; l.ready.clear();
      if (l.stopped) return;
      // An exit after publishing (source gone, sender reconnecting) retries after 3 s; one before publishing anything
      // (FFmpeg missing, a bad argument, the source not readable) backs off 3, 6, 12 ... 60 s.
      const streak = l.published ? 0 : (this.streaks.get(path) || 0) + 1;
      if (streak) this.streaks.set(path, streak);
      const wait = streak ? Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (streak - 1)) : RETRY_MS;
      l.retryAt = Date.now() + wait;
      this.log('warn', `quality encoder for /${path} ended (${why}${streak ? `, ${streak} failed start(s) in a row` : ''}; retry after ${wait / 1000} s): ${l.tail.join(' | ') || 'no output'}`, 'ladder ' + path);
    };
    l.child.on('error', error => ended(error.message));
    l.child.on('exit', (code, signal) => ended(signal || `exit ${code}`));
    this.ladders.set(path, l);
    this.log('info', `quality encoder for /${path} started (pid ${l.child.pid}): source copy + ${list.map(r => r.name).join(',')}`);
    this.onStarted(path, [`${path}/src`, ...list.map(r => `${path}/${r.name}`)]);
    return l;
  }

  stop(path, why) {
    const l = this.ladders.get(path);
    if (!l) return;
    this.ladders.delete(path);
    this.streaks.delete(path);  // an idle stop, the source ended or new qualities: the next start begins afresh
    l.stopped = true;
    if (!l.exited) { l.child.kill('SIGTERM'); this.log('info', `quality encoder for /${path} stopped (${why})`); }
  }

  // With the MediaMTX path list (every 2 s): a ladder with a reader on any of its paths (HLS muxers live 60 s after their
  // last request, WebRTC sessions while watching) stays; one without readers for idleMs, or whose source ended, stops.
  // A path of the ladder seen published here ends a failure streak even when no request waited for it.
  sweep(paths) {
    const now = Date.now();
    // A streak outlives its exited ladder (removed below), but not the broadcast: no ladder and no source, forget it.
    for (const path of this.streaks.keys()) if (!this.ladders.has(path) && !paths.get(path)?.ready) this.streaks.delete(path);
    for (const [path, l] of this.ladders) {
      if (l.exited) { if (now > l.retryAt + 60000) this.ladders.delete(path); continue; }
      const names = [`${path}/src`, ...l.list.map(r => `${path}/${r.name}`)];
      // Not from a stale list (MediaMTX API slow or down): it may still show the previous ladder's paths.
      if (!this.mtx.stale) for (const n of names) if (mine(paths.get(n), l)) this.published(path, l, n);
      if (names.some(n => (paths.get(n)?.readers || 0) > 0)) l.usedAt = now;
      if (now - l.usedAt > this.idleMs) this.stop(path, `no reader for ${Math.round(this.idleMs / 1000)} s`);
      else if (!paths.get(path)?.ready && now - l.usedAt > 5000) this.stop(path, 'source ended');
    }
  }

  stopAll() { for (const path of [...this.ladders.keys()]) this.stop(path, 'shutdown'); }
  running() { return [...this.ladders.entries()].filter(([, l]) => !l.exited).map(([path, l]) => ({ path, pid: l.child.pid, qualities: l.list.map(r => r.name) })); }
}
