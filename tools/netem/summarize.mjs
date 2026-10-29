// Per-step summary of a netem run: what the profile asked for, what the proxy actually forwarded, and what the
// browser's getStats saw in the same wall-clock window, plus — when the page exposed its automatic-quality state through
// the probe (the FRAME viewer's window.FrameRuntime.abr) — what the automatic quality did in every step. Works on any
// run directory holding proxy.jsonl (udp-proxy.mjs --log) and stats.jsonl (attach.mjs --record).
// usage: node tools/netem/summarize.mjs <run-dir> [--settle 3]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const readJsonl = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sum = xs => xs.reduce((a, b) => a + (b || 0), 0);
const round = (v, d = 2) => v === null || v === undefined || Number.isNaN(v) ? null : +v.toFixed(d);
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const share = (part, whole) => whole ? round(part / whole * 100, 2) : null;
const portOf = endpoint => { const m = /:(\d+)\//.exec(endpoint || ''); return m ? Number(m[1]) : null; };

// Bitrate a quality needs on the shaped line: RTP/SRTP + UDP/IPv4 headers and RTX on top of the encoder's video rate
// (measured: 8 Mbps CBR + Opus 128k = 8.35 Mbps of UDP payload, 8.54 Mbps with the proxy's 28-byte headers), plus audio.
export const FIT_RULE = { videoFactor: 1.07, audioMbps: 0.2, text: 'need = mbps x 1.07 + 0.2 (headers, RTX, Opus)' };
const need = rung => rung.mbps * FIT_RULE.videoFactor + FIT_RULE.audioMbps;
const heightOf = q => { if (q === null || q === undefined) return null; const s = String(q), m = /x(\d+)$/.exec(s) || /^(\d+)p/.exec(s); return m ? Number(m[1]) : null; };

export function summarize(dir, { settle = 3 } = {}) {
  const proxy = readJsonl(join(dir, 'proxy.jsonl')), stats = readJsonl(join(dir, 'stats.jsonl')), host = readJsonl(join(dir, 'host.jsonl'));
  const ready = proxy.find(e => e.event === 'ready'), start = proxy.find(e => e.event === 'profile-start');
  if (!start) throw new Error('no profile-start in proxy.jsonl');
  const steps = [];
  for (const e of proxy) if (e.event === 'config' && e.reason === 'step' && e.t >= start.t) steps.push(e);
  const ticks = proxy.filter(e => e.event === 'tick');
  const end = proxy.find(e => e.event === 'profile-end' && e.t >= start.t)?.t ?? ticks.at(-1)?.t;
  const stepEnd = i => steps[i + 1]?.t ?? end;
  const stepOf = t => steps.findLast(x => x.t <= t);
  const proxyEndpoint = (ready?.listen || '127.0.0.1:') + '/';

  // Received-resolution timeline of the connection on screen: every change of decoded size or of connection (a quality
  // switch in a player that opens a new session per quality), with the step it happened in.
  const switches = [];
  let prevKey = null;
  for (const x of stats) {
    if (!x.video || !x.video.frameWidth) continue;
    const key = `${x.video.frameWidth}x${x.video.frameHeight}`;
    if (prevKey && (prevKey.key !== key || prevKey.pc !== x.pc)) {
      const st = stepOf(x.t);
      switches.push({ t: x.t, sinceStartSec: round((x.t - start.t) / 1000, 1), step: st ? st.label : '(warm-up)', sinceStepSec: st ? round((x.t - st.t) / 1000, 1) : null, from: prevKey.key, to: key, connection: x.pc });
    }
    prevKey = { key, pc: x.pc };
  }

  const rows = steps.map((step, i) => {
    const t0 = step.t, t1 = stepEnd(i), from = t0 + Math.min(settle * 1000, (t1 - t0) / 3);
    // A tick covers the second before its timestamp and a sample's rate the interval before it: keep only those that
    // lie wholly inside the step (after the settle time), so a transition never leaks into the neighbouring row.
    const tk = ticks.filter(x => x.t > from + 1000 && x.t <= t1 + 50), sm = stats.filter(x => x.t > from + 1000 && x.t <= t1 + 50);
    const rated = sm.filter(x => x.rate), dn = tk.map(x => x.down), hs = host.filter(x => x.t > from && x.t <= t1);
    const before = sm.length ? stats.filter(x => x.t < sm[0].t).at(-1) : null;
    const windowSec = sm.length && before ? (sm.at(-1).t - before.t) / 1000 : null;
    // Loss over every connection of the page (two overlap during a quality switch), from the counters' own changes.
    const lost = sum(sm.map(x => x.sum ? x.sum.packetsLost : x.rate?.packetsLost)), recv = sum(sm.map(x => x.sum ? x.sum.packetsReceived : x.rate?.packetsReceived));
    const allBytes = sum(sm.map(x => x.sum ? x.sum.videoBytes : x.rate?.videoBytes));
    const rx = sum(dn.map(d => d.rxPkts)), dq = sum(dn.map(d => d.dropQueue)), dl = sum(dn.map(d => d.dropLoss)), dout = sum(dn.map(d => d.dropOutage));
    const remotes = [...new Set(sm.map(x => x.pair?.remote).filter(Boolean))];
    const states = [...new Set(sm.map(x => x.connectionState).filter(Boolean))];
    return {
      step: step.step, label: step.label, seconds: round((t1 - t0) / 1000, 1), measuredSeconds: round((t1 - from) / 1000, 1),
      set: { downMbps: step.down.rateMbps ?? null, delayMs: step.down.delayMs ?? 0, jitterMs: step.down.jitterMs ?? 0, jitterMode: step.down.jitterMode ?? 'smooth', lossPct: step.down.lossPct ?? 0, lossBurst: step.down.lossBurst ?? 1, outage: !!step.down.outage, maxQueueMs: step.down.maxQueueMs, upMbps: step.up?.rateMbps ?? null },
      proxy: {
        offeredMbps: round(mean(dn.map(d => d.rxMbps))), forwardedMbps: round(mean(dn.map(d => d.txMbps))),
        rxPkts: rx, txPkts: sum(dn.map(d => d.txPkts)), dropQueue: dq, dropLoss: dl, dropOutage: dout,
        // Drop shares from the proxy's own drop counters over the packets it received (not rx − tx, which mixes in
        // packets still queued or in flight at the window edges).
        lossDropPct: share(dl, rx), queueDropPct: share(dq, rx), outageDropPct: share(dout, rx), dropPct: share(dq + dl + dout, rx),
        queueMsAvg: round(mean(dn.map(d => d.queueMsAvg)), 1), queueMsMax: round(Math.max(0, ...dn.map(d => d.queueMsMax)), 1),
        delayMsAvg: round(mean(dn.filter(d => d.delayMsAvg !== null).map(d => d.delayMsAvg)), 1),
        upForwardedMbps: round(mean(tk.map(x => x.up.txMbps)), 3), upDropQueue: sum(tk.map(x => x.up.dropQueue)),
        lateMsAvg: round(mean(dn.filter(d => d.lateMsAvg != null).map(d => d.lateMsAvg)), 2), lateMsMax: round(Math.max(0, ...dn.map(d => d.lateMsMax ?? 0)), 1),
        cpuPct: round(mean(tk.filter(x => x.cpuPct != null).map(x => x.cpuPct)), 1), sessionsMax: Math.max(0, ...tk.map(x => x.sessions || 0)),
      },
      host: { cpuPctAvg: round(mean(hs.map(x => x.cpuPct)), 1), cpuPctMax: round(hs.length ? Math.max(...hs.map(x => x.cpuPct)) : null, 1) },
      browser: {
        samples: sm.length,
        // On-screen connection (the picture the viewer sees).
        videoMbps: round(mean(rated.filter(x => x.rate.videoMbps !== null).map(x => x.rate.videoMbps))), videoMbpsP10: round(pct(rated.filter(x => x.rate.videoMbps !== null).map(x => x.rate.videoMbps), 0.1)), videoMbpsP90: round(pct(rated.filter(x => x.rate.videoMbps !== null).map(x => x.rate.videoMbps), 0.9)),
        // Every connection of the page together (what the shaped line carried to the browser).
        videoMbpsAllConnections: windowSec ? round(allBytes * 8 / windowSec / 1e6) : null,
        audioMbps: round(mean(rated.filter(x => x.rate.audioMbps !== null).map(x => x.rate.audioMbps)), 3),
        packetsLost: lost, lossPct: round(lost + recv ? lost / (lost + recv) * 100 : null),
        jitterMsAvg: round(mean(rated.filter(x => x.rate.jitterMs !== null).map(x => x.rate.jitterMs)), 1), jitterMsMax: round(Math.max(0, ...rated.map(x => x.rate.jitterMs ?? 0)), 1),
        jitterBufferMsAvg: round(mean(rated.filter(x => x.rate.jitterBufferMs !== null).map(x => x.rate.jitterBufferMs)), 1),
        fps: round(mean(rated.filter(x => x.rate.fps !== null).map(x => x.rate.fps)), 1), decodeMsPerFrame: round(mean(rated.filter(x => x.rate.decodeMsPerFrame != null).map(x => x.rate.decodeMsPerFrame)), 2),
        framesDropped: sum(rated.map(x => x.rate.framesDropped)),
        freezes: sum(rated.map(x => x.rate.freezes)), freezeSec: round(sum(rated.map(x => x.rate.freezeSec)), 2),
        pauses: sum(rated.map(x => x.rate.pauses)), pauseSec: round(sum(rated.map(x => x.rate.pauseSec)), 2),
        zeroFpsSeconds: rated.filter(x => x.rate.fps === 0).length,
        nacks: sum(rated.map(x => x.rate.nacks)), plis: sum(rated.map(x => x.rate.plis)),
        rtxPackets: rated.some(x => x.rate.rtxPackets !== null && x.rate.rtxPackets !== undefined) ? sum(rated.map(x => x.rate.rtxPackets)) : null,
        rttMsAvg: round(mean(sm.filter(x => x.pair?.rttMs != null).map(x => x.pair.rttMs)), 1),
        resolution: [...new Set(sm.map(x => x.video && x.video.frameWidth ? `${x.video.frameWidth}x${x.video.frameHeight}` : null).filter(Boolean))].join(' '),
        switches: switches.filter(w => w.t >= t0 && w.t < t1).length,
        connectionStates: states.join(' '), remoteCandidates: remotes.join(' '),
        connections: new Set(sm.flatMap(x => (x.conns || []).map(c => c.id))).size || [...new Set(sm.map(x => x.pc).filter(v => v !== undefined && v !== null))].length,
        openConnectionsMax: Math.max(0, ...sm.map(x => x.open ?? 0)),
      },
    };
  });

  // Outages: how long the picture stood still and when frames came back. Chrome's freeze/pause durations are exact
  // (a gap over 5 s is a pause, not a freeze, and both are credited when the next frame arrives); the first-frame time
  // has the sampling interval as its resolution. An outage in the profile's last step ends with the profile.
  const outages = steps.map((step, i) => ({ step, i })).filter(({ step }) => step.down.outage).map(({ step, i }) => {
    const oEnd = stepEnd(i), until = steps[i + 2]?.t ?? (i + 1 < steps.length ? stepEnd(i + 1) : oEnd + 10000);
    const before = stats.filter(x => x.video && x.t <= step.t).at(-1), after = stats.filter(x => x.video && x.t <= until).at(-1);
    const stillSec = x => (x.video.totalFreezesDuration || 0) + (x.video.totalPausesDuration || 0);
    const same = before && after && before.pc === after.pc;
    const back = stats.find(x => x.t > oEnd && x.rate && x.rate.fps > 0);
    const states = [...new Set(stats.filter(x => x.t >= step.t && x.t <= oEnd + 5000).map(x => x.connectionState).filter(Boolean))];
    // With a page probe (FRAME viewer): seconds the on-screen video element's frame count stood still from the start of
    // the outage to 10 s after it, which still works when the player switched connections in between.
    const pv = stats.filter(x => x.t >= step.t && x.t <= oEnd + 10000 && x.probe && x.probe.video);
    let still = null; if (pv.length > 1) { still = 0; for (let k = 1; k < pv.length; k++) { const a = pv[k - 1].probe.video, b = pv[k].probe.video; if (a.track === b.track && a.frames === b.frames) still += (pv[k].t - pv[k - 1].t) / 1000; } }
    return { label: step.label, outageSec: round((oEnd - step.t) / 1000, 2), lastStep: i === steps.length - 1, pictureStalledSec: still === null ? null : round(still, 1),
      frozenSec: same ? round(stillSec(after) - stillSec(before), 2) : null,
      freezes: same ? (after.video.freezeCount || 0) - (before.video.freezeCount || 0) : null,
      pauses: same ? (after.video.pauseCount || 0) - (before.video.pauseCount || 0) : null,
      framesBackWithinSec: back ? round((back.t - oEnd) / 1000, 1) : null, sameConnection: before && after ? before.pc === after.pc : null, connectionStates: states.join(' ') };
  });

  // Whole-run cross-check: bytes the proxy delivered downstream vs bytes every browser connection received on pairs
  // whose remote end is the proxy (the final record of each connection, closed ones included).
  const totals = proxy.filter(e => e.event === 'totals').at(-1);
  const lastConn = new Map();
  for (const x of stats) {
    if (Array.isArray(x.conns)) { for (const c of x.conns) if (c.pairsWithData) lastConn.set(c.id, c); }
    else if (x.pairsWithData || x.pair) lastConn.set(x.pc, { id: x.pc, pairsWithData: x.pairsWithData || [x.pair], pair: x.pair });  // older stats.jsonl (newest connection only)
  }
  const viaProxyBytes = c => (c.pairsWithData || []).filter(p => p.remote.startsWith(proxyEndpoint)).reduce((a, p) => a + (p.bytesReceived || 0), 0);
  const otherPairs = [...lastConn.values()].flatMap(c => (c.pairsWithData || []).filter(p => !p.remote.startsWith(proxyEndpoint)));
  const pairBytes = lastConn.size ? [...lastConn.values()].reduce((a, c) => a + viaProxyBytes(c), 0) : null;
  const perSession = totals?.perSession || [];
  const perConnection = [...lastConn.values()].map(c => {
    const port = portOf((c.pairsWithData || []).find(p => p.remote.startsWith(proxyEndpoint))?.local || c.pair?.local);
    // The browser's local candidate is the proxy's upstream socket as the server saw it (prflx), or its own socket.
    const s = perSession.find(p => portOf((p.upstream || '') + '/') === port) || perSession.find(p => portOf(p.client + '/') === port);
    const got = viaProxyBytes(c);
    return { id: c.id, localPort: port, browserBytes: got, proxyBytes: s ? s.downTxBytes : null, serverSentBytes: s ? s.downRxBytes : null, ratio: s && s.downTxBytes ? round(got / s.downTxBytes, 4) : null, closed: !!c.closed, finalSource: c.finalSource || null, estimatedBytes: c.pairBytesEstimated || 0 };
  });
  const withRemote = stats.filter(x => x.pair?.remote);
  const viaProxy = withRemote.length ? withRemote.filter(x => x.pair.remote.startsWith(proxyEndpoint)).length / withRemote.length : null;
  const crossCheck = totals ? { proxyDownTxBytes: totals.down.txBytes, proxyDownRxBytes: totals.down.rxBytes, browserPairBytesReceived: pairBytes, connections: lastConn.size,
    ratio: pairBytes && totals.down.txBytes ? round(pairBytes / totals.down.txBytes, 4) : null, samplesViaProxyCandidate: viaProxy === null ? null : round(viaProxy, 4),
    estimatedBytesOfClosedConnections: [...lastConn.values()].reduce((a, c) => a + (c.pairBytesEstimated || 0), 0),
    bytesOnOtherPairs: lastConn.size ? otherPairs.reduce((a, p) => a + (p.bytesReceived || 0), 0) : null, otherPairs: [...new Set(otherPairs.map(p => p.remote))], sessions: totals.sessions, proxySessions: perSession.length, perConnection } : null;

  const connections = connectionTimeline(stats, { start, stepOf });
  const abr = abrSummary({ stats, steps, stepEnd, ticks, start, connections });
  return { dir: basename(resolve(dir)), profile: start.name, timeScale: start.timeScale, rateScale: start.rateScale, settleSeconds: settle, steps: rows, outages, switches, connections, crossCheck, abr };
}

// Every RTCPeerConnection the page opened, from the per-connection records: the quality it asked for (its WHEP path:
// /<path>/whep = the original, /<path>/<h>p/whep = a rendition), when it was created, its first decoded frame, when it
// went on screen and when it closed. In a player that opens a new session per quality each one after the first is a
// switch attempt; one that never reaches the screen failed, or was still hanging when the run ended.
// stuck: the attempt stayed off screen for STUCK_SEC or longer, whatever happened afterwards — a switch that hung for
// minutes and then went on screen is stuck too (stuckKind tells which: shown-late, closed-not-shown, open-at-end).
export const STUCK_SEC = 15;
const qualityOfPath = p => { if (!p) return null; const m = /\/(\d+)p\/whep(?:\/|$)/.exec(p); return m ? m[1] + 'p' : /\/whep(?:\/|$)/.test(p) ? 'source' : null; };
export function connectionTimeline(stats, { start, stepOf }) {
  const byId = new Map();
  for (const x of stats) for (const c of x.conns || []) {
    let r = byId.get(c.id);
    if (!r) byId.set(c.id, r = { id: c.id, createdAt: c.createdAt, whep: null, whepStatus: null, whepMs: null, firstFrameAt: null, shownAt: null, closedAt: null, lastSeen: x.t, height: null, states: new Set() });
    if (c.whep) { r.whep = c.whep; r.whepStatus = c.whepStatus ?? r.whepStatus; r.whepMs = c.whepMs ?? r.whepMs; }
    // (records from before attach.mjs kept these times: the sample that first saw a frame / the connection on screen)
    r.firstFrameAt = r.firstFrameAt || c.firstFrameAt || (!c.closed && c.video && c.video.framesDecoded > 0 ? x.t : null); r.shownAt = r.shownAt || c.shownAt || (c.shown ? x.t : null);
    if (c.closed) r.closedAt = c.closedAt || x.t;
    r.lastSeen = x.t; if (c.video && c.video.frameHeight) r.height = c.video.frameHeight; if (c.connectionState) r.states.add(c.connectionState);
  }
  const sec = (a, b) => a && b ? round((b - a) / 1000, 1) : null;
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt).map((r, i) => {
    const endAt = r.closedAt || r.lastSeen, notShownUntil = r.shownAt || endAt, st = stepOf(r.createdAt);
    const outcome = r.shownAt ? 'shown' : r.closedAt ? (r.firstFrameAt ? 'closed-after-frames-not-shown' : 'closed-without-frames') : (r.firstFrameAt ? 'open-not-shown-at-end' : 'open-without-frames-at-end');
    const stuck = (notShownUntil - r.createdAt) / 1000 >= STUCK_SEC;
    return { id: r.id, attempt: i, quality: qualityOfPath(r.whep) || (r.height ? r.height + 'p' : null), whep: r.whep, whepStatus: r.whepStatus, whepMs: r.whepMs, decodedHeight: r.height,
      createdSinceStartSec: start ? round((r.createdAt - start.t) / 1000, 1) : null, step: st ? st.label : '(warm-up)', sinceStepSec: st ? round((r.createdAt - st.t) / 1000, 1) : null,
      firstFrameSec: sec(r.createdAt, r.firstFrameAt), shownSec: sec(r.createdAt, r.shownAt), closedSec: sec(r.createdAt, r.closedAt),
      // time this connection existed without being the picture on screen (a switch in progress)
      pendingSec: sec(r.createdAt, notShownUntil), outcome, stuck, stuckKind: !stuck ? null : r.shownAt ? 'shown-late' : r.closedAt ? 'closed-not-shown' : 'open-at-end',
      createdAt: r.createdAt, firstFrameAt: r.firstFrameAt, shownAt: r.shownAt, closedAt: r.closedAt, connectionStates: [...r.states].join(' ') };
  });
}

// ---- automatic quality -------------------------------------------------------------------------------------------
// Reasons the FRAME viewer gives (work/console-ux.js abrStep): network ones, the device's decoder, the size shown, and
// the calm period before an up-step.
function classify(reason) {
  const r = String(reason || '');
  if (/시작 실패/.test(r)) return 'start-failed';
  if (/^안정/.test(r)) return 'stable';
  if (/재생 끊김/.test(r)) return 'freeze';
  if (/패킷 손실/.test(r)) return 'loss';
  if (/수신 지연/.test(r)) return 'jitter';
  if (/수신 프레임 부족/.test(r)) return 'fps';
  if (/디코딩/.test(r)) return 'decode';
  if (/표시 크기/.test(r)) return 'size';
  return 'other';
}
const NETWORK = new Set(['freeze', 'loss', 'jitter', 'fps']);

export function abrSummary({ stats, steps, stepEnd, ticks, start, connections = [] }) {
  const probes = stats.filter(x => x.probe && typeof x.probe === 'object' && !x.probe.error && ('decisions' in x.probe || 'ladder' in x.probe));
  if (!probes.length) return null;
  const ladder = (probes.find(x => Array.isArray(x.probe.ladder))?.probe.ladder || []).map(r => ({ ...r, needMbps: round(need(r), 2) })).sort((a, b) => b.height - a.height);
  const rungByHeight = h => ladder.find(r => r.height === h) || null;
  const labelOf = h => h ? (rungByHeight(h)?.name || h + 'p') : null;
  const bestFit = rate => rate === null || rate === undefined ? ladder[0] || null : ladder.find(r => need(r) <= rate) || null;  // null: nothing fits
  const stepOf = t => steps.findLast(x => x.t <= t);
  const stepIndexOf = t => steps.findLastIndex(x => x.t <= t);
  const rateAt = i => i >= 0 ? (steps[i].down.outage ? 0 : steps[i].down.rateMbps ?? null) : null;

  // Decisions, de-duplicated across samples (each sample carries the last 20).
  const seen = new Map();
  for (const p of probes) for (const d of p.probe.decisions || []) {
    const key = d.at ? String(d.at) + '|' + d.to : `${d.from}|${d.to}|${d.reason}|${d.ms}`;
    if (!seen.has(key)) seen.set(key, { ...d, firstSeen: p.t });
  }
  const decisions = [...seen.values()].map(d => {
    const at = d.at || d.firstSeen, startedAt = at - (d.ms || 0), fromH = heightOf(d.from), toH = heightOf(d.to);
    const kind = classify(d.reason), dir = toH < fromH ? 'down' : toH > fromH ? 'up' : 'same';
    const si = stepIndexOf(startedAt), st = si >= 0 ? steps[si] : null;
    // What the proxy saw on the line in the 5 s before the decision was taken.
    const win = ticks.filter(x => x.t > startedAt - 5000 && x.t <= startedAt + 1000);
    const net = { drops: sum(win.map(x => x.down.dropQueue + x.down.dropLoss + x.down.dropOutage)), queueMsMax: round(Math.max(0, ...win.map(x => x.down.queueMsMax)), 1), outage: win.some(x => x.down.outage), lossSetPct: Math.max(0, ...win.map(x => x.down.lossPct || 0)), jitterSetMs: Math.max(0, ...win.map(x => x.down.jitterMs || 0)) };
    const impaired = net.drops > 0 || net.queueMsMax >= 50 || net.outage || net.lossSetPct > 0 || net.jitterSetMs >= 20;
    return { at, startedAt, sinceStartSec: round((startedAt - start.t) / 1000, 1), step: st ? st.label : '(warm-up)', stepIndex: si, sinceStepSec: st ? round((startedAt - st.t) / 1000, 1) : null,
      from: d.from, to: d.to, reason: d.reason, kind, dir, switchMs: d.ms, failed: kind === 'start-failed', net,
      flags: [...(dir === 'down' && !NETWORK.has(kind) && kind !== 'size' && kind !== 'decode' && kind !== 'start-failed' ? ['down-without-network-or-size-reason'] : []),
        ...(dir === 'down' && NETWORK.has(kind) && !impaired ? ['network-reason-but-line-unimpaired'] : []),
        ...(dir === 'up' && kind !== 'stable' && kind !== 'size' && kind !== 'start-failed' ? ['up-without-stable-reason'] : [])] };
  }).sort((a, b) => a.at - b.at);
  const done = decisions.filter(d => !d.failed && d.dir !== 'same');

  // Quality being played: the first one the page reported, then every completed decision.
  const firstPlaying = probes.find(x => x.probe.playing)?.probe.playing;
  const playingAt = t => { let h = heightOf(firstPlaying); for (const d of done) if (d.at <= t) h = heightOf(d.to); return h; };
  // Changes the probe saw that no decision explains (e.g. a reconnect at another quality, or a manual choice).
  const unexplained = [];
  let prevH = null;
  for (const p of probes) {
    const h = heightOf(p.probe.playing);
    if (h && prevH && h !== prevH && !done.some(d => Math.abs(d.at - p.t) < 3000 && heightOf(d.to) === h)) unexplained.push({ t: p.t, sinceStartSec: round((p.t - start.t) / 1000, 1), from: labelOf(prevH), to: labelOf(h), mode: p.probe.mode });
    if (h) prevH = h;
  }
  // Reversal: a switch in the other direction than the previous one. Within 60 s while the line settings stayed the same
  // (both decisions in one profile step) a reversal is one of:
  //  - after-previous-step: the first switch was a down-step taken in the first 5 s of a step whose line carries the
  //    quality it left, right after a step that did not (an outage, a narrower rate, loss or jitter) — the reaction to the
  //    previous step and the return once it is over (1080p→720p→1080p after an outage);
  //  - oscillation: back to the quality the first switch left, or past it (720p→1080p→720p, 720p→480p→720p);
  //  - overshoot-correction: it stops between the two (1080p→480p→720p after stepping down too far), the normal end of
  //    an over-deep down-step rather than a back-and-forth.
  // Failed up-probe: an up-step undone within 20 s.
  const carries = (i, h) => { const r = rungByHeight(h), rate = rateAt(i); if (!r || i < 0) return false; const s = steps[i].down; return !s.outage && !(s.lossPct > 0) && !((s.jitterMs || 0) >= 20) && (rate === null || need(r) <= rate); };
  let reversals = 0, oscillations = 0, overshootCorrections = 0, afterPreviousStep = 0, failedUpProbes = 0;
  const oscillationList = [];
  for (let i = 1; i < done.length; i++) {
    const a = done[i - 1], b = done[i];
    if (a.dir !== b.dir) {
      reversals++;
      if (b.startedAt - a.at < 60000 && a.stepIndex === b.stepIndex && a.stepIndex >= 0) {
        const left = heightOf(a.from), to = heightOf(b.to), back = b.dir === 'up' ? to >= left : to <= left;
        const reaction = a.dir === 'down' && a.startedAt - steps[a.stepIndex].t < 5000 && carries(a.stepIndex, left) && a.stepIndex > 0 && !carries(a.stepIndex - 1, left);
        const kind = reaction ? 'after-previous-step' : back ? 'oscillation' : 'overshoot-correction';
        if (kind === 'oscillation') oscillations++; else if (kind === 'overshoot-correction') overshootCorrections++; else afterPreviousStep++;
        oscillationList.push({ step: a.step, kind, path: `${a.from}->${a.to}->${b.to}`, firstSec: a.sinceStartSec, secondSec: b.sinceStartSec });
      }
    }
    if (a.dir === 'up' && b.dir === 'down' && b.startedAt - a.at < 20000) failedUpProbes++;
  }
  // Switch attempts seen as connections (every connection after the first), each matched to the decision that finished
  // it, if any: the page records a decision only when the switch completes or fails, so an attempt that hangs leaves
  // none, and while it hangs the page takes no further decision.
  const attempts = connections.slice(1).map(c => {
    const q = c.quality === 'source' ? ladder[0]?.name : c.quality;
    const d = decisions.find(x => Math.abs(x.startedAt - c.createdAt) < 4000 && (!q || heightOf(x.to) === heightOf(q)));
    return { ...c, quality: q || c.quality, decision: d ? `${d.from}->${d.to} ${d.reason}` : null };
  });

  const stepRows = steps.map((step, i) => {
    const t0 = step.t, t1 = stepEnd(i), rate = rateAt(i), prevRate = rateAt(i - 1), fit = bestFit(rate);
    const inStep = probes.filter(x => x.t >= t0 && x.t < t1), interval = inStep.length > 1 ? (inStep.at(-1).t - inStep[0].t) / (inStep.length - 1) / 1000 : 1;
    const played = {}; for (const p of inStep) { const l = labelOf(heightOf(p.probe.playing)) || '-'; played[l] = round((played[l] || 0) + interval, 1); }
    const decoded = {}; for (const p of inStep) { const l = p.probe.video && p.probe.video.h ? p.probe.video.h + 'p' : '-'; decoded[l] = round((decoded[l] || 0) + interval, 1); }
    const atStart = playingAt(t0), atEnd = playingAt(t1 - 1);
    const ds = done.filter(d => d.startedAt >= t0 && d.startedAt < t1), all = decisions.filter(d => d.startedAt >= t0 && d.startedAt < t1);
    // A quality fits when the line carries what it needs; when none does, the lowest one is the best the player can do.
    const fitsAt = h => { const r = rungByHeight(h); if (!r) return false; if (rate === null) return true; return fit ? need(r) <= rate : r === ladder.at(-1); };
    // Bandwidth drop below what the playing quality needs: time to the first down decision and to a quality that fits
    // (the lowest one when none fits).
    let drop = null;
    if (rate !== null && !step.down.outage && atStart && rungByHeight(atStart) && !fitsAt(atStart)) {
      const firstDown = ds.find(d => d.dir === 'down');
      const fitDecision = done.find(d => d.at >= t0 && fitsAt(heightOf(d.to)));
      drop = { playingAtDrop: labelOf(atStart), needMbps: round(need(rungByHeight(atStart)), 2), target: fit ? fit.name : ladder.at(-1)?.name + ' (nothing fits)',
        firstDownDecisionSec: firstDown ? round((firstDown.startedAt - t0) / 1000, 1) : null, firstDownPlayingSec: firstDown ? round((firstDown.at - t0) / 1000, 1) : null,
        fitPlayingSec: fitDecision && fitDecision.at < t1 ? round((fitDecision.at - t0) / 1000, 1) : null, firstDownReason: firstDown ? firstDown.reason : null };
    }
    const ups = ds.filter(d => d.dir === 'up').map(d => {
      const prev = done.filter(x => x.at < d.startedAt).at(-1), hold = probes.filter(x => x.t <= d.startedAt).at(-1)?.probe.holdUpMs ?? null;
      return { to: d.to, sinceStepSec: round((d.startedAt - t0) / 1000, 1), sinceLastSwitchSec: prev ? round((d.startedAt - prev.at) / 1000, 1) : null, holdUpMs: hold, undoneWithinSec: (() => { const n = done.find(x => x.startedAt > d.at); return n && n.dir === 'down' && n.startedAt - d.at < 60000 ? round((n.startedAt - d.at) / 1000, 1) : null; })() };
    });
    const rated = stats.filter(x => x.t > t0 && x.t <= t1 && x.rate);
    let stalled = 0; for (let k = 1; k < inStep.length; k++) { const a = inStep[k - 1].probe.video, b = inStep[k].probe.video; if (a && b && a.track === b.track && b.frames === a.frames) stalled += (inStep[k].t - inStep[k - 1].t) / 1000; }
    // Seconds of the step during which a new connection was open but not yet on screen while another one was (a switch
    // in progress: both share the line), and the switch attempts that started in the step.
    const inStats = stats.filter(x => x.t >= t0 && x.t < t1 && Array.isArray(x.conns));
    let switching = 0; for (let k = 1; k < inStats.length; k++) { const c = inStats[k].conns; if (c.some(x => !x.closed && !x.shown) && c.some(x => x.shown)) switching += (inStats[k].t - inStats[k - 1].t) / 1000; }
    const opened = attempts.filter(a => a.createdAt >= t0 && a.createdAt < t1);
    return { label: step.label, downMbps: step.down.outage ? 'outage' : rate, previousMbps: prevRate, lossPct: step.down.lossPct || 0, jitterMs: step.down.jitterMs || 0,
      bestFit: fit ? fit.name : rate === null ? ladder[0]?.name ?? null : 'none', playingAtStart: labelOf(atStart), playingAtEnd: labelOf(atEnd), playedSec: played, decodedSec: decoded,
      switches: ds.length, downs: ds.filter(d => d.dir === 'down').length, ups: ups.length, failedStarts: all.filter(d => d.failed).length, drop, upHolds: ups,
      attempts: opened.map(a => `${a.quality}:${a.outcome}${a.shownSec !== null ? '@' + a.shownSec + 's' : a.pendingSec !== null ? '(' + a.pendingSec + 's)' : ''}${a.stuck ? '!STUCK' : ''}`).join(' '), attemptsStuck: opened.filter(a => a.stuck).length, switchInProgressSec: round(switching, 1),
      freezes: sum(rated.map(x => x.rate.freezes)), freezeSec: round(sum(rated.map(x => x.rate.freezeSec)) + sum(rated.map(x => x.rate.pauseSec)), 2), zeroFpsSec: rated.filter(x => x.rate.fps === 0).length,
      pictureStalledSec: round(stalled, 1), reasons: [...new Set(ds.map(d => d.kind))].join(' ') };
  });
  const holds = [...new Set(probes.map(x => x.probe.holdUpMs).filter(v => v != null))];
  return {
    ladder, fitRule: FIT_RULE.text, mode: [...new Set(probes.map(x => x.probe.mode).filter(Boolean))].join(' '),
    shownHeight: { min: Math.min(...probes.map(x => x.probe.video?.shownH || Infinity)), max: Math.max(0, ...probes.map(x => x.probe.video?.shownH || 0)) },
    hiddenSamples: probes.filter(x => x.probe.hidden).length,
    totals: { decisions: decisions.length, switches: done.length, downs: done.filter(d => d.dir === 'down').length, ups: done.filter(d => d.dir === 'up').length, failedStarts: decisions.filter(d => d.failed).length,
      reversals, oscillations, overshootCorrections, reversalsAfterPreviousStep: afterPreviousStep, failedUpProbes, holdUpMsValues: holds, maxHoldUpMs: holds.length ? Math.max(...holds) : null,
      downWithoutNetworkOrSizeReason: decisions.filter(d => d.flags.includes('down-without-network-or-size-reason')).length,
      networkReasonButLineUnimpaired: decisions.filter(d => d.flags.includes('network-reason-but-line-unimpaired')).length,
      upWithoutStableReason: decisions.filter(d => d.flags.includes('up-without-stable-reason')).length,
      playingChangesWithoutDecision: unexplained.length, byReason: Object.fromEntries([...new Set(decisions.map(d => d.kind))].map(k => [k, decisions.filter(d => d.kind === k).length])),
      switchAttempts: attempts.length, attemptsShown: attempts.filter(a => a.shownAt).length, attemptsNotShown: attempts.filter(a => !a.shownAt).length,
      attemptsStuckOver15s: attempts.filter(a => a.stuck).length, attemptsStuckThenShown: attempts.filter(a => a.stuckKind === 'shown-late').length,
      attemptsStuckClosed: attempts.filter(a => a.stuckKind === 'closed-not-shown').length, attemptsStuckOpenAtEnd: attempts.filter(a => a.stuckKind === 'open-at-end').length,
      attemptsWithoutDecision: attempts.filter(a => !a.decision).length,
      attemptsHangingAtEnd: attempts.filter(a => /at-end$/.test(a.outcome)).length, maxSwitchPendingSec: attempts.length ? Math.max(...attempts.map(a => a.pendingSec || 0)) : null,
      // longest a video.play() promise of a live stream stayed unsettled (attach.mjs records every call)
      maxPendingPlaySec: stats.some(x => x.oldestPendingPlayMs !== undefined) ? round(Math.max(0, ...stats.map(x => x.oldestPendingPlayMs || 0)) / 1000, 1) : null },
    steps: stepRows, decisions, reversalsWithin60s: oscillationList, unexplained, attempts,
  };
}

export function toCsv(summary) {
  const cols = [['label', r => r.label], ['seconds', r => r.seconds], ['set_down_mbps', r => r.set.downMbps], ['set_loss_pct', r => r.set.lossPct], ['set_jitter_ms', r => r.set.jitterMs], ['set_outage', r => r.set.outage],
    ['proxy_offered_mbps', r => r.proxy.offeredMbps], ['proxy_forwarded_mbps', r => r.proxy.forwardedMbps], ['proxy_drop_pct', r => r.proxy.dropPct], ['proxy_loss_drop_pct', r => r.proxy.lossDropPct], ['proxy_queue_drop_pct', r => r.proxy.queueDropPct], ['proxy_drop_queue', r => r.proxy.dropQueue], ['proxy_drop_loss', r => r.proxy.dropLoss], ['proxy_drop_outage', r => r.proxy.dropOutage], ['proxy_queue_ms_avg', r => r.proxy.queueMsAvg], ['proxy_queue_ms_max', r => r.proxy.queueMsMax], ['proxy_late_ms_max', r => r.proxy.lateMsMax], ['proxy_cpu_pct', r => r.proxy.cpuPct], ['host_cpu_pct', r => r.host.cpuPctAvg], ['host_cpu_pct_max', r => r.host.cpuPctMax],
    ['browser_video_mbps', r => r.browser.videoMbps], ['browser_video_mbps_all_connections', r => r.browser.videoMbpsAllConnections], ['browser_loss_pct', r => r.browser.lossPct], ['browser_packets_lost', r => r.browser.packetsLost], ['browser_jitter_ms', r => r.browser.jitterMsAvg], ['browser_jitter_buffer_ms', r => r.browser.jitterBufferMsAvg], ['browser_fps', r => r.browser.fps], ['browser_decode_ms_per_frame', r => r.browser.decodeMsPerFrame], ['browser_frames_dropped', r => r.browser.framesDropped], ['browser_freezes', r => r.browser.freezes], ['browser_freeze_sec', r => r.browser.freezeSec], ['browser_pauses', r => r.browser.pauses], ['browser_zero_fps_sec', r => r.browser.zeroFpsSeconds], ['browser_nacks', r => r.browser.nacks], ['browser_plis', r => r.browser.plis], ['browser_rtt_ms', r => r.browser.rttMsAvg], ['resolution', r => r.browser.resolution], ['switches', r => r.browser.switches], ['connections', r => r.browser.connections], ['connection_states', r => r.browser.connectionStates], ['remote_candidates', r => r.browser.remoteCandidates]];
  return table(cols, summary.steps);
}
const cell = v => v === null || v === undefined ? '' : typeof v === 'object' ? cell(JSON.stringify(v)) : /[",\s]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const table = (cols, rows) => [cols.map(c => c[0]).join(','), ...rows.map(r => cols.map(c => cell(c[1](r))).join(','))].join('\n') + '\n';

export function abrCsv(abr) {
  const cols = [['label', r => r.label], ['down_mbps', r => r.downMbps], ['loss_pct', r => r.lossPct], ['jitter_ms', r => r.jitterMs], ['best_fit', r => r.bestFit], ['playing_at_start', r => r.playingAtStart], ['playing_at_end', r => r.playingAtEnd], ['played_sec', r => r.playedSec],
    ['switches', r => r.switches], ['downs', r => r.downs], ['ups', r => r.ups], ['failed_starts', r => r.failedStarts], ['drop_first_down_decision_sec', r => r.drop?.firstDownDecisionSec], ['drop_first_down_playing_sec', r => r.drop?.firstDownPlayingSec], ['drop_fit_playing_sec', r => r.drop?.fitPlayingSec], ['drop_target', r => r.drop?.target],
    ['up_holds', r => r.upHolds.map(u => `${u.to}@${u.sinceStepSec}s(hold ${u.holdUpMs})${u.undoneWithinSec !== null ? ' undone+' + u.undoneWithinSec + 's' : ''}`).join(' ')], ['freezes', r => r.freezes], ['freeze_sec', r => r.freezeSec], ['zero_fps_sec', r => r.zeroFpsSec], ['picture_stalled_sec', r => r.pictureStalledSec], ['reasons', r => r.reasons],
    ['switch_attempts', r => r.attempts], ['attempts_stuck', r => r.attemptsStuck], ['switch_in_progress_sec', r => r.switchInProgressSec]];
  return table(cols, abr.steps);
}

export function writeSummary(dir, s) {
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(s, null, 2));
  writeFileSync(join(dir, 'summary.csv'), toCsv(s));
  if (s.abr) writeFileSync(join(dir, 'abr.csv'), abrCsv(s.abr));
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  const [dir, flag, value] = process.argv.slice(2);
  if (!dir) { console.error('usage: node tools/netem/summarize.mjs <run-dir> [--settle 3]'); process.exit(2); }
  const s = summarize(dir, { settle: flag === '--settle' ? Number(value) : 3 });
  writeSummary(dir, s);
  printTable(s);
}

export function printTable(s) {
  console.log('step'.padEnd(18) + 'set'.padStart(7) + 'offer'.padStart(7) + 'fwd'.padStart(7) + 'drop%'.padStart(7) + 'qMax'.padStart(6) + ' | ' + 'video'.padStart(7) + 'all'.padStart(7) + 'loss%'.padStart(7) + 'jbuf'.padStart(6) + 'fps'.padStart(6) + 'frz'.padStart(5) + 'frzS'.padStart(6) + 'fps0'.padStart(5) + 'nack'.padStart(6) + 'cpu%'.padStart(6) + 'late'.padStart(6) + ' res / state');
  const f = (v, w, d = 2) => (v === null || v === undefined ? '-' : typeof v === 'number' ? v.toFixed(d) : String(v)).padStart(w);
  for (const r of s.steps) {
    console.log(r.label.padEnd(18) + f(r.set.outage ? 'down' : r.set.downMbps, 7) + f(r.proxy.offeredMbps, 7) + f(r.proxy.forwardedMbps, 7) + f(r.proxy.dropPct, 7, 2) + f(r.proxy.queueMsMax, 6, 0) + ' | ' + f(r.browser.videoMbps, 7) + f(r.browser.videoMbpsAllConnections, 7) + f(r.browser.lossPct, 7, 2) + f(r.browser.jitterBufferMsAvg, 6, 0) + f(r.browser.fps, 6, 1) + f(r.browser.freezes, 5, 0) + f(r.browser.freezeSec, 6, 1) + f(r.browser.zeroFpsSeconds, 5, 0) + f(r.browser.nacks, 6, 0) + f(r.host.cpuPctAvg, 6, 0) + f(r.proxy.lateMsMax, 6, 0) + ' ' + r.browser.resolution + ' / ' + r.browser.connectionStates);
  }
  for (const o of s.outages || []) console.log('outage', JSON.stringify(o));
  for (const w of s.switches || []) console.log('switch', `${w.sinceStartSec}s [${w.step} +${w.sinceStepSec}s] ${w.from} -> ${w.to} (connection ${w.connection})`);
  if (s.crossCheck) { const { perConnection, ...rest } = s.crossCheck; console.log('cross-check', JSON.stringify(rest)); for (const c of perConnection || []) console.log('  connection', JSON.stringify(c)); }
  if (s.abr) {
    const a = s.abr;
    console.log(`ABR ladder ${a.ladder.map(r => `${r.name}=${r.mbps}M(need ${r.needMbps})`).join(' ')}; mode ${a.mode}; shown height ${a.shownHeight.min}-${a.shownHeight.max}px`);
    // drop: decided / playing the first lower quality / playing one that fits, seconds after the bandwidth drop
    console.log('step'.padEnd(18) + 'link'.padStart(7) + ' fit'.padEnd(7) + 'start>end'.padEnd(13) + 'sw'.padStart(3) + 'dn'.padStart(3) + 'up'.padStart(3) + ' drop:dec>1stDown/fit(s)'.padEnd(25) + 'frz'.padStart(4) + 'stallS'.padStart(7) + 'swS'.padStart(6) + '  up holds / played / attempts');
    for (const r of a.steps) console.log(r.label.padEnd(18) + f(r.downMbps, 7) + ' ' + String(r.bestFit).padEnd(6) + `${r.playingAtStart}>${r.playingAtEnd}`.padEnd(13) + f(r.switches, 3, 0) + f(r.downs, 3, 0) + f(r.ups, 3, 0) + ' ' + (r.drop ? `${r.drop.firstDownDecisionSec ?? '-'}>${r.drop.firstDownPlayingSec ?? '-'}/${r.drop.fitPlayingSec ?? '-'}` : '').padEnd(24) + f(r.freezes, 4, 0) + f(r.pictureStalledSec, 7, 1) + f(r.switchInProgressSec, 6, 1) + '  ' + r.upHolds.map(u => `${u.to}@+${u.sinceStepSec}s(hold ${u.holdUpMs})`).join(' ') + ' ' + JSON.stringify(r.playedSec) + (r.attempts ? ' att ' + r.attempts : ''));
    for (const d of a.decisions) console.log('  decision', `${d.sinceStartSec}s [${d.step} +${d.sinceStepSec}s] ${d.from} -> ${d.to} ${d.reason} (${d.switchMs} ms) drops5s=${d.net.drops} qMax=${d.net.queueMsMax}${d.flags.length ? ' FLAG ' + d.flags.join(',') : ''}`);
    for (const t of a.attempts || []) console.log('  attempt', `${t.createdSinceStartSec}s [${t.step} +${t.sinceStepSec}s] -> ${t.quality} ${t.outcome} firstFrame ${t.firstFrameSec ?? '-'}s shown ${t.shownSec ?? '-'}s pending ${t.pendingSec}s${t.stuck ? ' STUCK(' + t.stuckKind + ')' : ''} decision ${t.decision ?? 'none'}`);
    for (const o of a.reversalsWithin60s || []) console.log('  reversal', `${o.kind} [${o.step}] ${o.path} at ${o.firstSec}s / ${o.secondSec}s`);
    for (const u of a.unexplained) console.log('  playing change without decision', JSON.stringify(u));
    console.log('ABR totals', JSON.stringify(a.totals));
  }
}
