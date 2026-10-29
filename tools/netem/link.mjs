// One direction of an emulated access link. A packet meets the stages in the order it would on a real path:
// outage → random/burst loss → bottleneck (rate + drop-tail queue) → propagation delay + jitter → outage at exit.
// Pure model with no sockets or timers: the caller offers packets with the current time (ms) and takes the ones due,
// so it can be tested with synthetic traffic and shared by every socket of one viewer (they share one access link).

export const LINK_DEFAULTS = Object.freeze({
  rateMbps: null,      // bottleneck rate; null = unlimited
  maxQueueMs: 200,     // drop-tail buffer, expressed as the queueing delay it can hold at the current rate
  delayMs: 0,          // fixed one-way propagation delay
  jitterMs: 0,         // delay variation amplitude (± ms), see jitterMode
  jitterMode: 'smooth', // 'smooth': delay drifts between random points, no reordering; 'packet': independent per packet
  lossPct: 0,          // random loss before the queue
  lossBurst: 1,        // mean run of consecutive losses (Gilbert model); 1 = independent (Bernoulli) losses
  outage: false,       // link down: nothing enters or leaves
  overheadBytes: 28,   // IPv4 + UDP header counted against the rate (the payload is what the socket sees)
});
const KEYS = new Set(Object.keys(LINK_DEFAULTS));

export function checkLinkConfig(cfg, where = 'link') {
  for (const key of Object.keys(cfg)) if (!KEYS.has(key)) throw new Error(`${where}: unknown key "${key}"`);
  const c = { ...LINK_DEFAULTS, ...cfg };
  if (c.rateMbps !== null && !(c.rateMbps > 0)) throw new Error(`${where}: rateMbps must be > 0 or null`);
  if (!(c.maxQueueMs > 0) || c.delayMs < 0 || c.jitterMs < 0 || c.lossPct < 0 || c.lossPct > 100 || !(c.lossBurst >= 1)) throw new Error(`${where}: value out of range`);
  if (!['smooth', 'packet'].includes(c.jitterMode)) throw new Error(`${where}: jitterMode must be smooth or packet`);
  // Gilbert model limit: with a mean loss run of B packets the long-run loss rate cannot exceed B/(1+B) (the bad state
  // would have to be entered with probability > 1); beyond it the model silently loses less than asked.
  if (c.lossBurst > 1 && c.lossPct / 100 > c.lossBurst / (1 + c.lossBurst)) throw new Error(`${where}: lossPct ${c.lossPct} is not reachable with lossBurst ${c.lossBurst} (max ${(c.lossBurst / (1 + c.lossBurst) * 100).toFixed(1)}%); raise lossBurst or lower lossPct`);
  return c;
}

function counters() {
  return { rxPkts: 0, rxBytes: 0, txPkts: 0, txBytes: 0, dropQueue: 0, dropLoss: 0, dropOutage: 0, served: 0, queueMsSum: 0, queueMsMax: 0, delayMsSum: 0, delayMsMax: 0, lateMsSum: 0, lateMsMax: 0 };
}

export function createLink(rand = Math.random) {
  let cfg = { ...LINK_DEFAULTS };
  const waiting = [];        // FIFO in front of the bottleneck: { data, wire, arrived, ctx }
  let waitHead = 0, queueBytes = 0;
  let busy = null, busyUntil = 0; // packet being serialized and when it leaves the bottleneck
  const line = [];           // after the bottleneck, ordered by deliverAt then arrival order (min-heap)
  let order = 0;
  const before = (a, b) => a.deliverAt < b.deliverAt || (a.deliverAt === b.deliverAt && a.order < b.order);
  let lastDeliver = 0, bad = false;
  let knotA = { t: 0, v: 0 }, knotB = { t: 0, v: 0 };  // smooth jitter: offset interpolated between two random points
  let interval = counters();
  const total = counters();

  const bump = (key, v = 1) => { interval[key] += v; total[key] += v; };
  const bytesPerMs = () => cfg.rateMbps * 1000 / 8;
  const serializeMs = wire => cfg.rateMbps ? wire / bytesPerMs() : 0;

  function lost() {
    if (!cfg.lossPct) { bad = false; return false; }
    if (cfg.lossPct >= 100) { bad = true; return true; }  // everything lost (checkLinkConfig allows 100 only with lossBurst 1)
    const loss = cfg.lossPct / 100;
    if (cfg.lossBurst <= 1) return rand() < loss;  // independent losses
    // Two-state Gilbert model: mean run of losses = lossBurst, long-run loss rate = lossPct (checkLinkConfig keeps
    // enterBad <= 1, the range where both hold).
    const leaveBad = 1 / cfg.lossBurst, enterBad = Math.min(1, loss * leaveBad / (1 - loss));
    bad = bad ? rand() >= leaveBad : rand() < enterBad;
    return bad;
  }
  function jitter(now) {
    const j = cfg.jitterMs;
    if (!j) return 0;
    if (cfg.jitterMode === 'packet') return (rand() * 2 - 1) * j;
    // Knots at least 2j apart keep the delay slope under 1 ms/ms, so later packets never overtake earlier ones.
    const spacing = Math.max(20, 4 * j);
    if (now - knotB.t > 4 * spacing) knotB = { t: 0, v: 0 };  // after an idle period start a fresh curve
    while (now >= knotB.t) { knotA = knotB.t ? knotB : { t: now, v: (rand() * 2 - 1) * j }; knotB = { t: knotA.t + spacing * (0.5 + rand()), v: (rand() * 2 - 1) * j }; }
    const f = (now - knotA.t) / (knotB.t - knotA.t);
    return knotA.v + (knotB.v - knotA.v) * f;
  }
  function heapPush(item) {
    line.push(item);
    for (let i = line.length - 1; i > 0;) { const p = (i - 1) >> 1; if (!before(line[i], line[p])) break; [line[p], line[i]] = [line[i], line[p]]; i = p; }
  }
  function heapPop() {
    const top = line[0], last = line.pop();
    if (line.length) {
      line[0] = last;
      for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < line.length && before(line[l], line[m])) m = l; if (r < line.length && before(line[r], line[m])) m = r; if (m === i) break; [line[m], line[i]] = [line[i], line[m]]; i = m; }
    }
    return top;
  }
  function leaveBottleneck(pkt, at) {
    const queueMs = at - pkt.arrived;
    bump('served'); bump('queueMsSum', queueMs); interval.queueMsMax = Math.max(interval.queueMsMax, queueMs); total.queueMsMax = Math.max(total.queueMsMax, queueMs);
    let deliverAt = at + cfg.delayMs + jitter(at);
    if (cfg.jitterMode !== 'packet') deliverAt = Math.max(deliverAt, lastDeliver);
    deliverAt = Math.max(deliverAt, at);
    lastDeliver = Math.max(lastDeliver, deliverAt);
    heapPush({ data: pkt.data, bytes: pkt.bytes, arrived: pkt.arrived, ctx: pkt.ctx, deliverAt, order: order++ });
  }
  // Moves packets through the bottleneck up to `now`. Each one starts when the previous one left (not when this call
  // happens), so late timer wake-ups do not lower the emulated rate.
  function advance(now) {
    for (;;) {
      if (busy) {
        if (busyUntil > now) return;
        queueBytes -= busy.wire;
        leaveBottleneck(busy, busyUntil);
        busy = null;
      }
      if (waitHead >= waiting.length) { waiting.length = 0; waitHead = 0; return; }
      const next = waiting[waitHead]; waiting[waitHead++] = undefined;
      const start = Math.max(busyUntil, next.arrived);
      busy = next; busyUntil = start + serializeMs(next.wire);
    }
  }

  return {
    get config() { return { ...cfg }; },
    setConfig(next) {
      cfg = checkLinkConfig(next);
      if (!cfg.lossPct) bad = false;
      // A lower rate must not leave more queued than the new limit allows (it would hold seconds of delay); drop the
      // newest packets like a full drop-tail buffer would have.
      if (cfg.rateMbps) {
        const limit = bytesPerMs() * cfg.maxQueueMs;
        while (waiting.length > waitHead && queueBytes > limit) { const p = waiting.pop(); queueBytes -= p.wire; bump('dropQueue'); }
      }
    },
    // Returns false when the packet was dropped on entry.
    offer(data, now, ctx) {
      const bytes = data.length, wire = bytes + cfg.overheadBytes;
      bump('rxPkts'); bump('rxBytes', bytes);
      if (cfg.outage) { bump('dropOutage'); return false; }
      if (lost()) { bump('dropLoss'); return false; }
      advance(now);
      if (cfg.rateMbps && queueBytes > 0 && queueBytes + wire > bytesPerMs() * cfg.maxQueueMs) { bump('dropQueue'); return false; }
      queueBytes += wire;
      waiting.push({ data, bytes, wire, arrived: now, ctx });
      advance(now);
      return true;
    },
    // Calls deliver(data, ctx) for each packet due at `now`.
    drain(now, deliver) {
      advance(now);
      while (line.length && line[0].deliverAt <= now) {
        const pkt = heapPop();
        if (cfg.outage) { bump('dropOutage'); continue; }
        // late = how far behind schedule the caller drained (timer granularity, CPU starvation); it adds to the delay.
        const delay = now - pkt.arrived, late = now - pkt.deliverAt;
        bump('txPkts'); bump('txBytes', pkt.bytes); bump('delayMsSum', delay); bump('lateMsSum', late);
        interval.lateMsMax = Math.max(interval.lateMsMax, late); total.lateMsMax = Math.max(total.lateMsMax, late);
        interval.delayMsMax = Math.max(interval.delayMsMax, delay); total.delayMsMax = Math.max(total.delayMsMax, delay);
        deliver(pkt.data, pkt.ctx);
      }
      advance(now);
    },
    // Earliest time something has to happen, or Infinity when the link is empty.
    nextAt() { return Math.min(busy ? busyUntil : Infinity, line.length ? line[0].deliverAt : Infinity); },
    queuedBytes: () => queueBytes,
    queuedMs: () => (cfg.rateMbps ? queueBytes / bytesPerMs() : 0),
    inFlight: () => line.length,
    // Counters since the previous call (and the running totals), for the JSONL log.
    snapshot() {
      const out = { ...interval, queueBytes, queueMsNow: cfg.rateMbps ? +(queueBytes / bytesPerMs()).toFixed(1) : 0 };
      interval = counters();
      return out;
    },
    totals: () => ({ ...total }),
  };
}
