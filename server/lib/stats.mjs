// Anonymous playback reports from viewers (POST /<path>/stats, sent by the UI every 15 s with navigator.sendBeacon) appended
// to one CSV per UTC day: stats-YYYY-MM-DD.csv. No IP address, user agent or chat name is ever written; the session is the
// random id each page makes for itself. Each daily file stops growing at its size cap; files older than keepDays are removed.
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const STATS_COLUMNS = ['time', 'path', 'session', 'broadcast', 'transport', 'mode', 'quality', 'height', 'fps', 'loss_pct', 'jitter_ms',
  'freezes', 'mbps', 'abr_switches', 'last_switch', 'event', 'device'];
const FILE = /^stats-(\d{4}-\d{2}-\d{2})\.csv$/;

// Free text from the page: control and bidi-override characters removed, length capped.
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max) : '');
const word = (v, max) => (typeof v === 'string' && new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,${max - 1}}$`).test(v) ? v : '');
const number = (v, min, max, digits) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? String(+v.toFixed(digits)) : '');

// Returns { row } (CSV fields in STATS_COLUMNS order) or { error }.
export function statsRow(path, body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'JSON object required' };
  const session = word(body.sid, 40);
  if (!session) return { error: 'sid required' };
  const broadcast = typeof body.broadcast === 'string' && /^[0-9a-f]{32}$/.test(body.broadcast) ? body.broadcast : '';
  const quality = typeof body.quality === 'string' && /^(\d{3,4}p|auto)$/.test(body.quality) ? body.quality : '';
  return { session, row: [new Date(now).toISOString(), path, session, broadcast, word(body.transport, 16), word(body.mode, 16), quality,
    number(body.height, 0, 8192, 0), number(body.fps, 0, 1000, 1), number(body.lossPct, 0, 100, 2), number(body.jitterMs, 0, 600000, 0),
    number(body.freezes, 0, 1e6, 0), number(body.mbps, 0, 10000, 2), number(body.abrSwitches, 0, 1e6, 0), clean(body.lastSwitch, 120),
    clean(body.event, 120), word(body.device, 24)] };
}

// RFC 4180 quoting, and a leading ' on text that a spreadsheet would run as a formula.
function csvField(value, i) {
  let v = String(value);
  if (i >= 14 && /^[=+\-@]/.test(v)) v = "'" + v;  // last_switch, event (free text); numeric columns are numbers or empty
  return /[",\n\r]/.test(v) ? '"' + v.replaceAll('"', '""') + '"' : v;
}
export const csvLine = row => row.map(csvField).join(',') + '\n';

export class StatsLog {
  constructor({ dir, maxBytes, keepDays, log }) {
    this.dir = dir; this.maxBytes = maxBytes; this.keepDays = keepDays; this.log = log;
    this.day = ''; this.file = ''; this.size = 0; this.full = false; this.queue = Promise.resolve();
    this.written = 0; this.dropped = 0;
  }
  get enabled() { return !!this.dir; }
  // Appends are serialised; the promise settles once the line is on disk (or dropped at the cap).
  append(row) {
    const line = csvLine(row);
    const job = this.queue.then(() => this.write(line, row[0].slice(0, 10)));
    this.queue = job.catch(() => {});
    return job;
  }
  async write(line, day) {
    if (day !== this.day) await this.open(day);
    if (this.size + Buffer.byteLength(line) > this.maxBytes) {
      this.dropped++;
      if (!this.full) { this.full = true; this.log('warn', `playback stats ${this.file} reached ${Math.round(this.maxBytes / 1048576)} MB: further reports today are dropped`); }
      return false;
    }
    await appendFile(this.file, line);
    this.size += Buffer.byteLength(line); this.written++;
    return true;
  }
  async open(day) {
    await mkdir(this.dir, { recursive: true });
    this.day = day; this.file = join(this.dir, `stats-${day}.csv`); this.full = false;
    try { this.size = (await stat(this.file)).size; } catch { this.size = 0; }
    if (!this.size) { const head = STATS_COLUMNS.join(',') + '\n'; await appendFile(this.file, head); this.size = Buffer.byteLength(head); }
    if (this.keepDays) {
      const oldest = new Date(Date.parse(day + 'T00:00:00Z') - this.keepDays * 86400000).toISOString().slice(0, 10);
      for (const name of await readdir(this.dir)) { const m = FILE.exec(name); if (m && m[1] < oldest) await unlink(join(this.dir, name)).catch(() => {}); }
    }
  }
}
