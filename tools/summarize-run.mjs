// Prints one compact line per run-measure JSON result read from stdin.
let s = '';
process.stdin.on('data', d => s += d).on('end', () => {
  for (const line of s.trim().split('\n')) {
    try {
      const j = JSON.parse(line);
      if (j.error) { console.log(j.resolution, j.fps, j.audio, 'ERROR', j.error, (j.logs || [])[0]); continue; }
      const v = j.viewer, l = v.latencyMs || {};
      console.log(`${j.resolution} ${j.fps}fps audio=${j.audio} | sender capture ${j.sender.captureFps} sent ${j.sender.sentFps} new ${j.sender.newFrameFps} enc ${j.sender.encoderFps} skipped ${j.sender.skipped} ${j.sender.serverMbps}Mbps | viewer presented ${v.presentedFps} unique ${v.uniqueFramesPerSecond} dropped ${v.droppedFrames}/${v.totalFrames} latency p50 ${Math.round(l.p50)} p95 ${Math.round(l.p95)} | av ${v.audio && v.audio.avOffsetMs ? Math.round(v.audio.avOffsetMs.median) + 'ms (' + Math.round(v.audio.avOffsetMs.min) + '..' + Math.round(v.audio.avOffsetMs.max) + ')' : '-'}`);
    } catch { console.log(line); }
  }
});
