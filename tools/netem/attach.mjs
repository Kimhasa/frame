// Puts a browser page's WebRTC media through tools/netem/udp-proxy.mjs, without touching product code: a script
// injected over CDP before the page's own scripts rewrites the remote SDP so the only server ICE candidate is the
// proxy (UDP host candidates of the real server → proxy address:port, TCP/srflx/relay dropped), removes the page's own
// candidates from the WHEP offer and from trickle PATCH bodies (the server must not learn a direct path that bypasses
// the proxy, e.g. during an outage; the PATCH itself still goes to the server), and keeps every RTCPeerConnection the
// page creates so each one can be sampled from Node — a player that opens a new session per quality has two at once
// during a switch, and both share the shaped line.
//
// usage: node tools/netem/attach.mjs --devtools <port> --proxy 127.0.0.1:22300 [--url <viewer url> | --match <text>]
//          [--server <ip>[:port]] [--record stats.jsonl] [--seconds N] [--interval 1000] [--keep-local-candidates]
//          [--probe <js> | --probe frame | --probe none]
// --url navigates the page there after injecting; otherwise the matching page is reloaded so the script applies.
import { appendFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, sleep } from '../cdp.mjs';

// Runs inside the page. Must stay self-contained (it is serialized with Function.prototype.toString).
function pageScript(cfg) {
  if (window.__netem) return;
  const state = window.__netem = { cfg, conns: [], rewrites: [], strippedOffers: 0, patches: [], created: 0 };
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  // "a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ..."
  function rewriteLine(line, seen) {
    const m = /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)(.*)$/.exec(line);
    if (!m) return { keep: false, why: 'unparsed' };
    const [, foundation, component, transport, priority, address, port, type, rest] = m;
    if (transport.toLowerCase() !== 'udp') return { keep: false, why: 'tcp' };
    if (type !== 'host') return { keep: false, why: type };
    if (cfg.serverAddress && address !== cfg.serverAddress) return { keep: false, why: 'other-address' };
    if (cfg.serverPort && Number(port) !== cfg.serverPort) return { keep: false, why: 'other-port' };
    if (seen.has(component)) return { keep: false, why: 'duplicate' };
    seen.add(component);
    const tail = rest.replace(/ (raddr|rport) \S+/g, '');
    return { keep: true, line: `a=candidate:${foundation} ${component} udp ${priority} ${cfg.proxyAddress} ${cfg.proxyPort} typ host${tail}` };
  }
  function rewriteSdp(sdp, kind) {
    const out = [], record = { at: Date.now(), kind, kept: [], dropped: [] };
    let seen = new Set();
    for (const line of sdp.split(/\r\n|\n/)) {
      if (line.startsWith('m=')) seen = new Set();  // bundled sections each carry the same candidates
      if (!line.startsWith('a=candidate:')) { out.push(line); continue; }
      const r = rewriteLine(line, seen);
      if (r.keep) { out.push(r.line); record.kept.push({ from: line, to: r.line }); } else record.dropped.push({ line, why: r.why });
    }
    state.rewrites.push(record);
    if (state.rewrites.length > 40) state.rewrites.shift();
    return out.join('\r\n');
  }
  const stripCandidates = text => { const lines = text.split(/\r\n|\n/), kept = lines.filter(l => !l.startsWith('a=candidate:')); return { text: kept.join('\r\n'), removed: lines.length - kept.length }; };
  const proto = Native.prototype, setRemote = proto.setRemoteDescription, addCandidate = proto.addIceCandidate;
  // recordOnly: a control run without the proxy, only the stats hook below.
  if (!cfg.recordOnly) proto.setRemoteDescription = function (desc, ...rest) {
    if (desc && typeof desc.sdp === 'string' && desc.type !== 'rollback') desc = { type: desc.type, sdp: rewriteSdp(desc.sdp, 'remote-description') };
    return setRemote.call(this, desc, ...rest);
  };
  if (!cfg.recordOnly) proto.addIceCandidate = function (candidate, ...rest) {
    if (candidate && candidate.candidate) {
      const r = rewriteLine('a=' + candidate.candidate, new Set());
      state.rewrites.push({ at: Date.now(), kind: 'trickle', kept: r.keep ? [{ from: candidate.candidate, to: r.line }] : [], dropped: r.keep ? [] : [{ line: candidate.candidate, why: r.why }] });
      if (!r.keep) return Promise.resolve();
      candidate = { candidate: r.line.slice(2), sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment };
    }
    return addCandidate.call(this, candidate, ...rest);
  };

  // ---- getStats digest of one connection --------------------------------------------------------------------------
  const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
  const VIDEO = ['timestamp', 'bytesReceived', 'headerBytesReceived', 'packetsReceived', 'packetsLost', 'jitter', 'framesReceived', 'framesDecoded', 'framesDropped', 'framesPerSecond', 'frameWidth', 'frameHeight', 'keyFramesDecoded', 'freezeCount', 'totalFreezesDuration', 'pauseCount', 'totalPausesDuration', 'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferEmittedCount', 'nackCount', 'pliCount', 'firCount', 'totalDecodeTime', 'decoderImplementation', 'powerEfficientDecoder', 'retransmittedPacketsReceived', 'retransmittedBytesReceived'];
  const AUDIO = ['timestamp', 'bytesReceived', 'packetsReceived', 'packetsLost', 'jitter', 'concealedSamples', 'concealmentEvents', 'totalSamplesReceived', 'jitterBufferDelay', 'jitterBufferEmittedCount'];
  async function digest(pc) {
    const report = await pc.getStats(), out = {};
    let pairId = null;
    report.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId; });
    report.forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') out.video = pick(s, VIDEO);
      if (s.type === 'inbound-rtp' && s.kind === 'audio') out.audio = pick(s, AUDIO);
    });
    if (!pairId) report.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id; });
    // Every pair that carried data, so a path around the proxy cannot hide behind the "selected" one.
    const endpoint = c => c ? `${c.address || c.ip || ''}:${c.port}/${c.protocol}/${c.candidateType}` : '?';
    out.pairsWithData = [];
    report.forEach(s => { if (s.type === 'candidate-pair' && (s.bytesReceived > 0 || s.bytesSent > 0)) out.pairsWithData.push({ remote: endpoint(report.get(s.remoteCandidateId)), local: endpoint(report.get(s.localCandidateId)), bytesReceived: s.bytesReceived, bytesSent: s.bytesSent, state: s.state }); });
    const pair = pairId && report.get(pairId);
    if (pair) out.pair = { state: pair.state, rttMs: pair.currentRoundTripTime !== undefined ? pair.currentRoundTripTime * 1000 : null, bytesReceived: pair.bytesReceived, bytesSent: pair.bytesSent, availableIncomingBitrate: pair.availableIncomingBitrate, remote: endpoint(report.get(pair.remoteCandidateId)), local: endpoint(report.get(pair.localCandidateId)) };
    return out;
  }
  const bytesOf = d => d && d.video ? d.video.bytesReceived : -1;
  const inbound = d => d && d.video ? d.video.bytesReceived + (d.video.headerBytesReceived || 0) + (d.audio ? d.audio.bytesReceived || 0 : 0) : 0;
  // Once close() runs, Chrome keeps the inbound-rtp counters but drops the candidate pairs. The final pair bytes are the
  // last live sample's, scaled by how much the RTP counters grew since then (well under a second of traffic).
  function finalPairs(rec, live) {
    if (!rec || !live || (rec.pairsWithData && rec.pairsWithData.length) || !live.pairsWithData) return rec;
    const k = inbound(live) > 0 ? Math.max(1, inbound(rec) / inbound(live)) : 1, before = live.pairsWithData.reduce((a, p) => a + (p.bytesReceived || 0), 0);
    const pairs = live.pairsWithData.map(p => ({ ...p, bytesReceived: Math.round((p.bytesReceived || 0) * k), estimated: true }));
    return { ...rec, pairsWithData: pairs, pair: live.pair && { ...live.pair, bytesReceived: Math.round((live.pair.bytesReceived || 0) * k), estimated: true }, pairBytesEstimated: pairs.reduce((a, p) => a + p.bytesReceived, 0) - before };
  }

  // Subclass rather than a wrapper function so `instanceof` and page subclasses keep working.
  class NetemPeerConnection extends Native {
    constructor(config = {}, ...rest) {
      // TURN/STUN would add candidates the proxy cannot see; the shaped path must be the only one.
      super(cfg.keepIceServers || cfg.recordOnly ? config : { ...config, iceServers: [] }, ...rest);
      state.conns.push({ id: state.created++, pc: this, createdAt: Date.now(), closedAt: null, beforeClose: null, done: false });
    }
    // The page closes the old connection once a new quality shows its first frame. Its counters are asked for just
    // before the close (and again after it); the sampler keeps whichever saw more bytes as the connection's final record.
    close() {
      const entry = state.conns.find(e => e.pc === this);
      if (entry && !entry.closedAt) { entry.closedAt = Date.now(); entry.beforeClose = digest(this).catch(() => null); }
      return super.close();
    }
  }
  window.RTCPeerConnection = NetemPeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = NetemPeerConnection;

  // play() on a live MediaStream settles only once frames arrive; a player that awaits it before its own timeout can
  // hang there. Each call is kept with the time it settled (or null while pending).
  state.plays = [];
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...rest) {
    const p = nativePlay.apply(this, rest), s = this.srcObject;
    if (s && typeof s.getVideoTracks === 'function') {
      const rec = { at: Date.now(), settledAt: null, outcome: null, track: (s.getVideoTracks()[0] || {}).id || null };
      state.plays.push(rec); if (state.plays.length > 60) state.plays.shift();
      if (p && typeof p.then === 'function') p.then(() => { rec.settledAt = Date.now(); rec.outcome = 'resolved'; }, error => { rec.settledAt = Date.now(); rec.outcome = 'rejected ' + (error && error.name); });
    }
    return p;
  };

  {
    const nativeFetch = window.fetch;
    // Headers in any form fetch accepts: a plain object, [name, value] pairs or a Headers object.
    const header = (headers, name) => { if (!headers) return ''; try { return new Headers(headers).get(name) || ''; } catch { return ''; } };
    const pathOf = input => { try { return new URL(typeof input === 'string' ? input : input.url, location.href).pathname; } catch { return String(input); } };
    // Body text of a request whose candidate lines may need rewriting (string, Blob, ArrayBuffer/view or a Request's body).
    async function bodyText(req, init) {
      const b = init && init.body;
      if (typeof b === 'string') return b;
      if (b != null) {
        if (typeof b.text === 'function') return await b.text();
        if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
        return null;  // e.g. a stream: left alone
      }
      return req ? await req.clone().text() : null;
    }
    window.fetch = async function (input, init) {
      let method = 'GET', type = '';
      const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
      try { method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase(); type = header(init && init.headers !== undefined ? init.headers : req && req.headers, 'content-type'); } catch {}
      const sdpPost = method === 'POST' && /application\/sdp/i.test(type), patch = !cfg.recordOnly && method === 'PATCH' && /trickle-ice-sdpfrag/i.test(type);
      if (!sdpPost && !patch) return nativeFetch.call(this, input, init);
      const body = await bodyText(req, init).catch(() => null);
      // The same request with another body (a Request input keeps its own mode, credentials, signal, ...).
      const send = text => req ? nativeFetch.call(this, new Request(req, { ...(init || {}), body: text })) : nativeFetch.call(this, input, { ...(init || {}), body: text });
      if (sdpPost && body !== null) {
        // The WHEP endpoint tells which quality a connection carries (/<path>/whep = original, /<path>/<h>p/whep), even
        // when it never shows a frame; the offer is the connection's own local description.
        const entry = state.conns.find(e => e.pc && !e.whep && e.pc.localDescription && e.pc.localDescription.sdp === body);
        const whep = entry ? (entry.whep = { path: pathOf(input), postedAt: Date.now(), status: null, ms: null }) : null;
        let response;
        if (!cfg.recordOnly && !cfg.keepLocalCandidates) { state.strippedOffers++; response = await send(stripCandidates(body).text); }
        else response = await nativeFetch.call(this, input, init);
        if (whep) { whep.status = response.status; whep.ms = Date.now() - whep.postedAt; }
        return response;
      } else if (patch) {
        // Trickled browser candidates (or an ICE restart): the request still goes to the server, without the browser's
        // own candidates; an answer fragment with the server's candidates is pointed at the proxy like the SDP answer.
        const record = { at: Date.now(), removedCandidates: 0, status: null, rewroteAnswer: false, bodyRead: body !== null };
        state.patches.push(record); if (state.patches.length > 40) state.patches.shift();
        let response;
        if (body !== null && !cfg.keepLocalCandidates) { const r = stripCandidates(body); record.removedCandidates = r.removed; response = await send(r.text); }
        else response = await nativeFetch.call(this, input, init);
        record.status = response.status;
        if (!/sdpfrag/i.test(response.headers.get('content-type') || '')) return response;
        const answer = rewriteSdp(await response.text(), 'patch-answer'), headers = new Headers(response.headers);
        headers.delete('content-length'); record.rewroteAnswer = true;
        return new Response(answer, { status: response.status, statusText: response.statusText, headers });
      }
      return nativeFetch.call(this, input, init);
    };
  }

  // One sample of every connection that is still open, plus the final record of each one closed since the last sample.
  // The top-level fields describe the connection whose video is on screen (or the newest open one).
  state.sample = async () => {
    const shown = new Set();
    for (const v of document.querySelectorAll('video')) { const s = v.srcObject; if (s && typeof s.getTracks === 'function') for (const t of s.getTracks()) shown.add(t.id); }
    const conns = [];
    for (const e of state.conns) {
      if (e.done) continue;
      const pc = e.pc, closed = pc.signalingState === 'closed' || pc.connectionState === 'closed';
      let rec = null, source = 'live';
      if (closed) {
        const before = e.beforeClose ? await e.beforeClose : null, after = await digest(pc).catch(() => null);
        rec = bytesOf(after) >= bytesOf(before) ? after : before; source = rec === after ? 'after-close' : 'before-close';
        if (!rec || (!rec.video && e.last && e.last.video)) { rec = e.last; source = 'last-sample'; }
        else rec = finalPairs(rec, e.last);
        e.done = true;
      } else rec = await digest(pc).catch(error => ({ error: String(error && error.message || error) }));
      const onScreen = !closed && pc.getReceivers().some(r => r.track && shown.has(r.track.id)), now = Date.now();
      // Lifecycle of a quality switch: offer posted → first decoded frame → swapped onto the screen → closed.
      // (sample resolution: the first sample that saw it; a closed connection's final record does not set these)
      if (!closed && !e.firstFrameAt && rec && rec.video && rec.video.framesDecoded > 0) e.firstFrameAt = now;
      if (!e.shownAt && onScreen) e.shownAt = now;
      if (closed && !e.closedAt) e.closedAt = now;  // closed by the browser rather than through close()
      rec = { ...(rec || {}), id: e.id, createdAt: e.createdAt, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
        shown: onScreen, whep: e.whep ? e.whep.path : null, whepStatus: e.whep ? e.whep.status : null, whepMs: e.whep ? e.whep.ms : null,
        firstFrameAt: e.firstFrameAt || null, shownAt: e.shownAt || null, ageMs: now - e.createdAt };
      if (closed) { rec.closed = true; rec.closedAt = e.closedAt; rec.finalSource = source; delete e.pc; } else e.last = rec;
      conns.push(rec);
    }
    const open = conns.filter(c => !c.closed), main = open.filter(c => c.shown).at(-1) || open.at(-1) || null;
    const now = Date.now(), pending = state.plays.filter(p => !p.settledAt);
    const out = { created: state.created, open: open.length, pc: main ? main.id : null, conns,
      playsPending: pending.length, oldestPendingPlayMs: pending.length ? now - Math.min(...pending.map(p => p.at)) : 0 };
    if (main) Object.assign(out, { connectionState: main.connectionState, iceConnectionState: main.iceConnectionState, shown: main.shown, video: main.video, audio: main.audio, pair: main.pair, pairsWithData: main.pairsWithData });
    return out;
  };
}

export function injectionSource(cfg) { return `(${pageScript.toString()})(${JSON.stringify(cfg)});`; }

// Installs the script for every new document of the page (and the current one, for pages created later in it).
export async function attach(client, { proxy = '-:0', server, keepLocalCandidates = false, keepIceServers = false, recordOnly = false }) {
  const [proxyAddress, proxyPort] = proxy.split(':');
  let serverAddress = null, serverPort = null;
  if (server) { const m = /^(.+?)(?::(\d+))?$/.exec(server); serverAddress = m[1]; serverPort = m[2] ? Number(m[2]) : null; }
  // SDP candidates carry IP addresses: a host name is resolved once, to IPv4, like udp-proxy.mjs's --target.
  if (serverAddress && !isIP(serverAddress)) serverAddress = (await lookup(serverAddress, { family: 4 })).address;
  const cfg = { proxyAddress, proxyPort: Number(proxyPort), serverAddress, serverPort, keepLocalCandidates, keepIceServers, recordOnly };
  await client.send('Page.enable');
  const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: injectionSource(cfg) });
  return { identifier, cfg };
}

// Default page probe for the FRAME viewer page (outputs/index.html): automatic-quality state, the picture on screen and
// the qualities the server announced. null on any other page.
export const FRAME_PROBE = `(() => {
  const R = window.FrameRuntime; if (!R) return null;
  let a = null; try { a = R.abr; } catch (error) { a = { error: String(error) }; }
  const v = R.video; let video = null;
  if (v) {
    const box = v.getBoundingClientRect(), q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    const scale = v.videoWidth ? Math.min(box.width / v.videoWidth, box.height / v.videoHeight) : 0;
    const track = v.srcObject && v.srcObject.getVideoTracks ? v.srcObject.getVideoTracks()[0] : null;
    video = { w: v.videoWidth, h: v.videoHeight, shownH: Math.round(v.videoHeight * scale * (window.devicePixelRatio || 1)), readyState: v.readyState, paused: v.paused,
      frames: q ? q.totalVideoFrames : null, dropped: q ? q.droppedVideoFrames : null, track: track ? track.id : null };
  }
  const info = R.stream && R.stream.info;
  const ladder = info ? [{ name: info.height + 'p', width: info.width, height: info.height, mbps: Number(info.bitrate) || 0, original: true }].concat((info.renditions || []).map(r => ({ name: r.name, width: r.width, height: r.height, mbps: Number(r.mbps) || 0 }))) : null;
  return { connected: R.connected, connecting: R.connecting, mode: a && a.mode, playing: a && a.playing, holdUpMs: a && a.holdUpMs,
    decisions: a && a.decisions, last: a && a.last, video, ladder, hidden: document.hidden, dpr: window.devicePixelRatio };
})()`;
export const resolveProbe = probe => probe === undefined || probe === true || probe === 'frame' ? FRAME_PROBE : probe === 'none' || probe === false ? null : probe;

// Per-interval changes of one connection's counters. Counts are never clipped (packetsLost can fall when a late or
// retransmitted packet arrives); a connection's first sample counts from zero.
function rateOf(cur, prev) {
  const v = cur.video, p = prev && prev.video ? prev.video : null, zero = {};
  if (!v) return null;
  const b = p || zero, d = key => (v[key] || 0) - (b[key] || 0);
  const dt = p ? (v.timestamp - p.timestamp) / 1000 : null;
  const bytes = d('bytesReceived'), wire = bytes + d('headerBytesReceived');
  const audioBytes = cur.audio ? (cur.audio.bytesReceived || 0) - (prev && prev.audio ? prev.audio.bytesReceived || 0 : 0) : null;
  return {
    first: !p, dt: dt === null ? null : +dt.toFixed(3), videoBytes: bytes, videoWireBytes: wire, audioBytes,
    videoMbps: dt > 0 ? +(bytes * 8 / dt / 1e6).toFixed(3) : null, videoWireMbps: dt > 0 ? +(wire * 8 / dt / 1e6).toFixed(3) : null,
    audioMbps: dt > 0 && audioBytes !== null ? +(audioBytes * 8 / dt / 1e6).toFixed(3) : null,
    packetsLost: d('packetsLost'), packetsReceived: d('packetsReceived'), framesDecoded: d('framesDecoded'),
    fps: dt > 0 ? +(d('framesDecoded') / dt).toFixed(1) : null, framesDropped: d('framesDropped'),
    freezes: d('freezeCount'), freezeSec: +d('totalFreezesDuration').toFixed(3),
    // Chrome counts a gap of more than 5 s without frames as a pause, not a freeze.
    pauses: d('pauseCount'), pauseSec: +d('totalPausesDuration').toFixed(3),
    nacks: d('nackCount'), plis: d('pliCount'), rtxPackets: v.retransmittedPacketsReceived !== undefined ? d('retransmittedPacketsReceived') : null,
    // Decoder load (ABR-11): decode time per decoded frame, next to the network-side counters.
    decodeMsPerFrame: d('framesDecoded') > 0 && v.totalDecodeTime !== undefined ? +(d('totalDecodeTime') / d('framesDecoded') * 1000).toFixed(2) : null,
    jitterMs: v.jitter !== undefined ? +(v.jitter * 1000).toFixed(1) : null,
    jitterBufferMs: d('jitterBufferEmittedCount') > 0 ? +(d('jitterBufferDelay') / d('jitterBufferEmittedCount') * 1000).toFixed(1) : null,
  };
}

// Samples every connection's getStats each interval and appends one JSON line per sample: per-connection records with
// their own rates (conns[].rate), the on-screen connection's rate at the top level (rate), and the sum over all
// connections (sum). probe: an optional page expression stored with each sample (e.g. the player's quality state).
export function recorder(client, file, { intervalMs = 1000, onSample = () => {}, probe } = {}) {
  const lastById = new Map();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const wall = Date.now();
      let s;
      try { s = await client.evaluate('window.__netem && window.__netem.sample ? window.__netem.sample() : null'); } catch (error) { s = { error: error.message }; }
      const line = { t: wall, ...s };
      if (probe) line.probe = await client.evaluate(probe).catch(error => ({ error: error.message }));
      if (s && Array.isArray(s.conns)) {
        const sum = { videoBytes: 0, videoWireBytes: 0, packetsLost: 0, packetsReceived: 0, freezes: 0, nacks: 0, plis: 0, connections: s.conns.length, open: s.open };
        for (const c of s.conns) {
          c.rate = rateOf(c, lastById.get(c.id));
          if (c.rate) for (const k of ['videoBytes', 'videoWireBytes', 'packetsLost', 'packetsReceived', 'freezes', 'nacks', 'plis']) sum[k] += c.rate[k] || 0;
          if (c.video) lastById.set(c.id, c);
          if (c.closed) lastById.delete(c.id);
          if (c.id === s.pc) line.rate = c.rate;
        }
        line.sum = sum;
      }
      if (file) appendFileSync(file, JSON.stringify(line) + '\n');
      onSample(line);
      await sleep(Math.max(0, intervalMs - (Date.now() - wall)));
    }
  })();
  return { stop: async () => { stopped = true; await loop; } };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (!m) throw new Error('unexpected argument ' + argv[i]);
    const next = argv[i + 1];
    out[m[1]] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return out;
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  const a = args(process.argv.slice(2));
  if (!a.devtools || !a.proxy) { console.error('usage: node tools/netem/attach.mjs --devtools <port> --proxy 127.0.0.1:22300 [--url <viewer url> | --match <text>] [--record stats.jsonl] [--seconds N]'); process.exit(2); }
  const match = a.match ? t => t.url.includes(a.match) : () => true;
  const client = await connect(Number(a.devtools), match);
  const { cfg } = await attach(client, { proxy: a.proxy, server: a.server, keepLocalCandidates: !!a['keep-local-candidates'], keepIceServers: !!a['keep-ice-servers'] });
  if (a.url) await client.send('Page.navigate', { url: a.url }); else await client.send('Page.reload', { ignoreCache: false });
  console.log(JSON.stringify({ event: 'attached', ...cfg, url: a.url || null }));
  if (a.record || a.seconds) {
    const rec = recorder(client, a.record, { intervalMs: Number(a.interval || 1000), probe: resolveProbe(a.probe), onSample: s => { if (s.rate) process.stdout.write(`\r${s.pair?.remote ?? '-'} video ${s.rate.videoMbps} Mbps lost ${s.rate.packetsLost} fps ${s.rate.fps} ${s.video?.frameWidth}x${s.video?.frameHeight} conns ${s.open}   `); } });
    const stop = async () => { await rec.stop(); client.close(); process.exit(0); };
    process.on('SIGINT', stop);
    if (a.seconds) setTimeout(stop, Number(a.seconds) * 1000);
  } else client.close();
}
