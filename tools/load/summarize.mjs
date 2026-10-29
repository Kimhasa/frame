// Prints one load run (verification/load/<runId>/results.json) as a compact table for reports and quick comparison.
// usage: node tools/load/summarize.mjs verification/load/<runId> [more run folders...]
import { join, resolve } from 'node:path';
import { readJson } from './lib/common.mjs';

const fmt = v => (v === null || v === undefined ? '-' : typeof v === 'number' ? String(v) : String(v) === 'not measured' ? 'n/m' : String(v));
for (const dir of process.argv.slice(2)) {
  const r = readJson(join(resolve(dir), 'results.json'));
  console.log(`\n# ${r.runId}${r.final ? '' : ' (incomplete)'}`);
  console.log(`host: ${r.host.cpu} (${r.host.logical} threads, ${r.host.ramGB} GB) | baseline host CPU ${r.hostBaseline?.hostCpuPct}% free ${r.hostBaseline?.freeMemMB} MB`);
  console.log(`target: ${r.target.whep}${r.target.standalone ? ` (standalone, source ${r.target.standalone.options.source} ${r.target.standalone.options.size}@${r.target.standalone.options.fps} ${r.target.standalone.options.mbps} Mbps)` : ''}`);
  const head = ['stage', 'success', 'fullRate', 'first p50/p95 ms', 'first: sample-clock/timeout/pending', 'target sess max', 'kbps/viewer p50', 'vsRef p50', 'total Mbps', 'loss est', 'stall', 'gen CPU%', 'target CPU%', 'host CPU% max', 'free MB min', 'chat p50/p95 ms', 'chat deliv', 'dvr err', 'browser fps/dec/freezes', 'browser 1st ms', 'abort'];
  const rows = r.stages.map(s => {
    const bp = s.browserPhase || s.browser;  // separate phase or inline
    const b = bp && !bp.error ? bp.summary : null;
    return [s.stage, s.successRate, s.fullRateSuccessRate, typeof s.firstMediaMs === 'object' ? `${fmt(s.firstMediaMs.p50)}/${fmt(s.firstMediaMs.p95)}` : 'n/m', `${fmt(s.firstMediaFromSampleClock)}/${fmt(s.firstMediaTimeouts)}/${fmt(s.firstMediaPending)}`, s.resources.targetSessionsMax, s.perViewerKbps.p50,
      typeof s.rateVsSource === 'object' ? s.rateVsSource.p50 : 'n/m', s.totalMbps.mean, s.lossRatioEst, s.stallTimeRatio, s.resources.genCpuPct.mean, s.resources.targetCpuPct.mean,
      s.resources.hostCpuPct.max, s.resources.freeMemMB.min, s.chat ? `${fmt(s.chat.latencyMs.p50)}/${fmt(s.chat.latencyMs.p95)}` : 'n/m', s.chat ? s.chat.deliveryRatio : 'n/m',
      s.dvr ? `${s.dvr.errors}/${s.dvr.chunks}` : 'n/m', b ? `${fmt(b.presentedFps.mean)}/${fmt(b.decodedFps.mean)}/${b.freezes}` : 'n/m', b ? b.firstFrameMs.p50 : 'n/m', s.abortReason || ''].map(fmt);
  });
  console.log('| ' + head.join(' | ') + ' |\n|' + head.map(() => '---').join('|') + '|');
  for (const row of rows) console.log('| ' + row.join(' | ') + ' |');
  console.log(`abort: ${r.abort ? `${r.abort.reason} at stage ${r.abort.stage} (${r.abort.phase}) ${JSON.stringify(r.abort.detail)}` : 'none'}`);
  console.log(`first saturation: ${r.saturation.map(s => `${s.kind}@${s.stage}`).join(' -> ') || 'none'}`);
  if (r.calibration) console.log(`calibration: max sustained ${r.calibration.maxSustainedStage}, limited by ${r.calibration.limitedBy}, per stage ${JSON.stringify(r.calibration.perStage)}${r.calibration.estimate ? `, estimate ${JSON.stringify(r.calibration.estimate)}` : ''}`);
  if (r.cleanup) console.log(`cleanup: target sessions left ${fmt(r.cleanup.remainingTargetSessions)} (baseline ${fmt(r.cleanup.baselineTargetSessions)}), generator paths left ${fmt(r.cleanup.remainingGeneratorPaths)}, target after ${JSON.stringify(r.cleanup.targetAfter)} vs baseline ${JSON.stringify(r.cleanup.targetBaseline)}`);
}
