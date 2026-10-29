// Read-only view of the relay MediaMTX through its loopback API, shared by every viewer request: the path list is fetched
// at most once per second however many browsers poll /info, and the inbound byte counters give a measured bitrate.
import http from 'node:http';

// LL-HLS holds blocking playlist requests open, so its pool is sized by RELAY_MAX_HLS_INFLIGHT, not the default 256.
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 });
export const hlsAgent = new http.Agent({ keepAlive: true, maxSockets: 4096, maxFreeSockets: 64 });

export function upstream(base, method, path, { headers = {}, body = null, timeoutMs = 10000, agent = keepAlive } = {}) {
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent }, resolve);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function readBody(res, limit = 1 << 20) {
  const chunks = [];
  let n = 0;
  for await (const c of res) { n += c.length; if (n > limit) throw new Error('upstream body too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

export class MediaMtx {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log;
    this.paths = new Map(); this.at = 0; this.pending = null; this.ok = false; this.rates = new Map();
    this.stale = false; this.goodAt = 0; this.failures = 0;
    this.auth = cfg.apiUser ? { Authorization: 'Basic ' + Buffer.from(cfg.apiUser + ':' + cfg.apiPass).toString('base64') } : {};
  }
  async api(path) {
    const res = await upstream(this.cfg.api, 'GET', path, { headers: this.auth, timeoutMs: 3000 });
    const body = await readBody(res);
    if (res.statusCode !== 200) throw new Error(`MediaMTX API ${res.statusCode}`);
    return JSON.parse(body.toString('utf8'));
  }
  // Map of path name -> { ready, readyMs, tracks, width, height, sourceType, readers, webrtcReaders, inboundBytes, mbps }.
  // When the API failed on the last refresh this is the last good list (this.stale) for up to cfg.staleMs.
  async list() {
    if (Date.now() - this.at < 1000) return this.paths;
    if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = null; });
    // Once a list exists, a slow API answer holds viewer requests at most 1.5 s; they get the list they would have had.
    if (this.at) await Promise.race([this.pending, new Promise(resolve => setTimeout(resolve, 1500).unref())]);
    else await this.pending;
    return this.paths;
  }
  async refresh() {
    const now = Date.now(), next = new Map();
    try {
      const items = [];
      for (let page = 0, pages = 1; page < pages && page < 20; page++) {
        const r = await this.api(`/v3/paths/list?itemsPerPage=500&page=${page}`);
        pages = r.pageCount || 1; items.push(...(r.items || []));
      }
      for (const p of items) {
        const video = (p.tracks2 || []).find(t => t.codec === 'H264' || t.codec === 'H265' || t.codec === 'AV1' || t.codec === 'VP9');
        const bytesIn = Number(p.inboundBytes ?? p.bytesReceived ?? 0);
        const prev = this.rates.get(p.name);
        let mbps = prev?.mbps || 0;
        if (prev && now > prev.at && bytesIn >= prev.bytes) {
          const sample = (bytesIn - prev.bytes) * 8 / ((now - prev.at) / 1000) / 1e6;
          mbps = prev.mbps ? prev.mbps * 0.8 + sample * 0.2 : sample;
        }
        this.rates.set(p.name, { bytes: bytesIn, at: now, mbps });
        const readers = p.readers || [];
        next.set(p.name, {
          ready: !!(p.ready ?? p.available), readyMs: Date.parse(p.readyTime || p.availableTime || '') || 0,
          tracks: p.tracks || (p.tracks2 || []).map(t => t.codec), width: video?.codecProps?.width || 0, height: video?.codecProps?.height || 0,
          sourceType: p.source?.type || '', readers: readers.length, webrtcReaders: readers.filter(r => /webrtc/i.test(r.type)).length, inboundBytes: bytesIn, mbps
        });
      }
      for (const name of this.rates.keys()) if (!next.has(name)) this.rates.delete(name);
      if (!this.ok) this.log('info', 'MediaMTX API reachable');
      this.ok = true; this.stale = false; this.goodAt = Date.now();
      this.paths = next;
    } catch (error) {
      if (this.ok || !this.at) this.log('warn', 'MediaMTX API unavailable: ' + error.message);
      this.ok = false; this.failures++;
      // One slow or failed answer must not make every broadcast look offline: the last good list stays in use (stale)
      // for cfg.staleMs; only a longer outage empties it (then the relay's media grace period still applies).
      if (this.paths.size && Date.now() - this.goodAt <= this.cfg.staleMs) this.stale = true;
      else { this.paths = new Map(); this.stale = false; }
    }
    this.at = Date.now();
  }
}
