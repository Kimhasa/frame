// The app's HLS proxy after its quality ladder restarts: kills the ladder FFmpeg of the running FrameConsole broadcast
// (by PID, a child of appPid) and polls one quality's media playlist through the app's viewer port until it plays again.
// usage: node tools/test-ladder-restart.mjs <appPid> [base=http://127.0.0.1:8889/screen-01] [quality=480p] [watchS=60]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [appPid, base = 'http://127.0.0.1:8889/screen-01', q = '480p', watchS = '60'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async url => {
  try { const r = await fetch(url, { cache: 'no-store' }); return { status: r.status, body: await r.text() }; }
  catch (e) { return { status: 0, body: String(e) }; }
};
const seq = body => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(body)?.[1] ?? -1);
const ladderPid = () => {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe' AND ParentProcessId=${Number(appPid)}" | Where-Object { $_.CommandLine -match '/src' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
  return out.split(/\s+/).filter(Boolean).map(Number);
};

const live = await get(base + '/live.m3u8');
if (live.status !== 200) throw new Error('live.m3u8 ' + live.status + ' ' + live.body.slice(0, 200));
const uri = live.body.split('\n').find(l => l.includes(`${q}/`) && !l.startsWith('#'))?.trim();
if (!uri) throw new Error('no ' + q + ' variant in live.m3u8:\n' + live.body);
const variant = new URL(uri, base + '/live.m3u8').href;
const media = async () => {
  const v = await get(variant);
  if (v.status !== 200) return { status: v.status, at: Date.now() };
  // A multivariant (index.m3u8) answer: follow its first media playlist.
  const sub = v.body.includes('#EXT-X-STREAM-INF') || v.body.includes('#EXT-X-MEDIA:')
    ? v.body.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() : null;
  const m = sub ? await get(new URL(sub, variant).href) : v;
  return { status: m.status, seq: m.status === 200 ? seq(m.body) : undefined, at: Date.now() };
};

const timeline = [];
for (const until = Date.now() + 5000; Date.now() < until; await sleep(500)) timeline.push({ phase: 'before', ...(await media()) });
const pids = ladderPid();
if (!pids.length) throw new Error('no ladder FFmpeg under app pid ' + appPid);
const killedAt = Date.now();
for (const pid of pids) process.kill(pid);
let back = null, newPids = [];
for (const until = killedAt + Number(watchS) * 1000; Date.now() < until; await sleep(500)) {
  const r = { phase: 'after', ...(await media()) };
  timeline.push(r);
  if (!back && r.status === 200 && Date.now() - killedAt > 1500) { back = r; newPids = ladderPid(); }
  if (back && Date.now() - back.at > 10000) break;
}
const after = timeline.filter(t => t.phase === 'after');
const statuses = after.reduce((o, t) => (o[t.status] = (o[t.status] || 0) + 1, o), {});
const okAfterBack = back ? after.filter(t => t.at >= back.at) : [];
const result = {
  at: new Date().toISOString(), base, quality: q, variant, killedPids: pids, newLadderPids: newPids,
  beforeStatuses: timeline.filter(t => t.phase === 'before').map(t => t.status),
  playlistBackAfterMs: back ? back.at - killedAt : null,
  statusesAfterKill: statuses,
  stableAfterBack: okAfterBack.every(t => t.status === 200),
  seqBefore: timeline.filter(t => t.phase === 'before').at(-1)?.seq, seqBack: back?.seq,
  timeline: timeline.map(t => ({ ms: t.at - killedAt, status: t.status, seq: t.seq })),
};
const out = process.env.OUT;
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, timeline: undefined }));
