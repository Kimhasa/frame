// Checks the deploy files against the backend they deploy (apps/api/build/libs/frame-api.jar), on this PC, without Linux:
//   1 files     deploy/*.example, deploy/systemd/*.service, mediamtx-relay.yml and Caddyfile.example are LF-only (systemd and
//               shell tools read them as they are), and the unit, the environment example and the install guide name the same
//               paths (/opt/frame-relay/frame-api.jar, /etc/frame-relay/relay.env, the stats and recording folders).
//   2 start     the jar started with exactly the variables of deploy/relay.env.example, read as systemd reads an
//               EnvironmentFile; the server paths (/etc/frame-relay, /opt/frame-relay, /var/lib/frame-relay) are mapped
//               into a temporary folder laid out as deploy/README.md section 5 installs them. No start-up warning about an
//               unknown RELAY_* variable, the JVM options line is picked up, it listens on loopback only.
//   3 service   /healthz names the Spring backend; the legacy page, its script and font come from RELAY_UI_FILE's folder;
//               the token of the token file announces; a playback report is written to RELAY_STATS_DIR.
//   4 refusals  what the guide says about a wrong value: the service does not start, and the log names the RELAY_* variable
//               (a value out of range, a malformed rate) or the setting frame.… with the value (a value of the wrong type).
// Not covered (needs a Linux server): systemd itself (sandboxing, SuccessExitStatus, stop time), the java package, Caddy.
// Light: one JVM at a time (five starts), no MediaMTX, no browser. Port 28080 only. Windows only (bin/java.exe, taskkill).
// usage: node server/verify/deploy-check.mjs   (JAVA_HOME or FRAME_JAVA = a JDK 21; build the jar first)
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { start, stop, waitFor, sleep, checks, portFree, scrub } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const JAVA = process.env.FRAME_JAVA || join(process.env.JAVA_HOME || '', 'bin', 'java.exe');
const API_JAR = join(ROOT, 'apps/api/build/libs/frame-api.jar');
const OUT = join(ROOT, 'verification/spring/deploy');
const TMP = join(tmpdir(), 'frame-deploy-check-' + Date.now()).replace(/\\/g, '/');
const PORT = 28080, BASE = `http://127.0.0.1:${PORT}`;
const { list, check } = checks();
const result = { startedAt: new Date().toISOString(), kind: 'deploy files against frame-api.jar on this PC (no Linux, no systemd)', checks: list, notes: [] };
const read = file => readFileSync(join(ROOT, file), 'utf8');

if (!existsSync(API_JAR)) throw new Error('missing apps/api/build/libs/frame-api.jar: cd apps/api && ./gradlew bootJar');
if (!existsSync(JAVA)) throw new Error('no Java: set JAVA_HOME (or FRAME_JAVA) to a JDK 21');
if (!(await portFree(PORT))) throw new Error('port in use: ' + PORT);
mkdirSync(OUT, { recursive: true });

// ---- 1 files --------------------------------------------------------------------------------------------------------------
const deployFiles = ['deploy/relay.env.example', 'deploy/mediamtx.env.example', 'deploy/systemd/frame-relay.service', 'deploy/systemd/mediamtx-relay.service',
  'deploy/mediamtx-relay.yml', 'deploy/Caddyfile.example'];
const withCr = deployFiles.filter(f => readFileSync(join(ROOT, f)).includes(13));
check('1a deploy files are LF-only (no CR, no BOM)', withCr.length === 0 && deployFiles.every(f => readFileSync(join(ROOT, f))[0] !== 0xef), { withCr });

const unit = read('deploy/systemd/frame-relay.service'), envText = read('deploy/relay.env.example'), guide = read('deploy/README.md');
const unitValue = key => (new RegExp(`^${key}=(.*)$`, 'm').exec(unit) || [])[1] ?? null;
const execStart = unitValue('ExecStart') || '';
const jarPath = (/-jar (\S+)/.exec(execStart) || [])[1] || '';
const envFile = unitValue('EnvironmentFile') || '';
check('1b unit: java -jar with an absolute java and jar path, exit 143 is success, no Node left',
  /^\/\S*\/java( \S+)* -jar \/\S+\.jar$/.test(execStart) && unitValue('SuccessExitStatus') === '143' && !/node|relay\.mjs/.test(unit) && !/MemoryDenyWriteExecute=/m.test(unit.replace(/^#.*$/gm, '')),
  { execStart, successExitStatus: unitValue('SuccessExitStatus'), timeoutStopSec: unitValue('TimeoutStopSec') });
check('1c the install guide puts the jar and the environment file where the unit reads them',
  !!jarPath && guide.includes(jarPath) && !!envFile && guide.includes(envFile) && !guide.includes('cp -r server /opt/frame-relay'),
  { jarPath, envFile });

// EnvironmentFile rules (systemd.exec): "#"/";" lines are comments, NAME=value, trailing whitespace dropped, no expansion.
const env = {};
const odd = [];
for (const raw of envText.split('\n')) {
  const line = raw.replace(/\s+$/, '');
  if (!line || line.startsWith('#') || line.startsWith(';')) continue;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (!m) { odd.push(line); continue; }
  if (/["'\\$%]|\s#/.test(m[2])) odd.push(line);
  env[m[1]] = m[2];
}
check('1d relay.env.example: plain NAME=value lines only (no quotes, backslashes, $, %, inline comments)', odd.length === 0 && Object.keys(env).length > 40, { variables: Object.keys(env).length, odd });
const paths = { stats: env.RELAY_STATS_DIR, records: env.RELAY_RECORD_DIR, vod: env.FRAME_PRODUCT_VOD_DIR, clips: env.FRAME_PRODUCT_CLIP_DIR, ui: env.RELAY_UI_FILE, tokens: env.RELAY_PUBLISHER_TOKENS_FILE };
check('1e the unit permits only stats, VOD and clip archive writes while source recordings stay read-only',
  unitValue('ReadWritePaths') === ['-' + paths.stats, '-' + paths.vod, '-' + paths.clips].join(' ') && paths.records.startsWith(unitValue('ReadOnlyPaths') + '/') && paths.vod.startsWith(unitValue('ReadOnlyPaths') + '/') && !paths.vod.startsWith(paths.records + '/') && paths.clips.startsWith(unitValue('ReadOnlyPaths') + '/') && !paths.clips.startsWith(paths.records + '/') && paths.clips !== paths.vod && guide.includes(paths.clips) && guide.includes(paths.vod) && guide.includes(paths.stats) && guide.includes(dirname(paths.ui)) && guide.includes(paths.tokens),
  { readWrite: unitValue('ReadWritePaths'), readOnly: unitValue('ReadOnlyPaths'), ...paths });

// ---- 2 start --------------------------------------------------------------------------------------------------------------
// The server layout of the install guide, under a temporary folder.
const map = p => TMP + p;
for (const d of ['/etc/frame-relay', '/opt/frame-relay/ui/assets/fonts', '/opt/frame-relay/ui/assets/js', '/var/lib/frame-relay/stats', '/var/lib/frame-relay/recordings', '/var/lib/frame-relay/vod', '/var/lib/frame-relay/clips']) mkdirSync(map(d), { recursive: true });
copyFileSync(API_JAR, map('/opt/frame-relay/frame-api.jar'));
copyFileSync(join(ROOT, 'outputs/index.html'), map('/opt/frame-relay/ui/index.html'));
for (const f of ['PretendardVariable.woff2', 'OFL.txt']) copyFileSync(join(ROOT, 'outputs/assets/fonts', f), map('/opt/frame-relay/ui/assets/fonts/' + f));
const scripts = readdirSync(join(ROOT, 'outputs/assets/js')).filter(f => /^hls/.test(f));
for (const f of scripts) copyFileSync(join(ROOT, 'outputs/assets/js', f), map('/opt/frame-relay/ui/assets/js/' + f));
const TOKEN = randomBytes(32).toString('hex');
writeFileSync(map(paths.tokens), `# test token of this run\n${TOKEN} screen-01\n`);
const runEnv = {};
for (const [k, v] of Object.entries(env)) runEnv[k] = /^\/(etc|opt|var)\//.test(v) ? map(v) : v;
runEnv.RELAY_PORT = String(PORT);
runEnv.RELAY_MEDIAMTX_API = 'http://127.0.0.1:28097';  // nothing listens: the service must start without MediaMTX
const jar = map(jarPath);
const relay = start('deploy-check', JAVA, ['-jar', jar], { cwd: map('/opt/frame-relay'), env: runEnv, logDir: TMP });
let failed = null;
try {
  const up = await waitFor(async () => { try { return (await fetch(BASE + '/healthz')).status; } catch { return 0; } }, 40000, 200);
  const started = await waitFor(() => relay.lines.find(l => /FRAME API /.test(l)) || null, 10000, 100);
  const startedIn = (relay.lines.find(l => /Started FrameApiApplication in/.test(l)) || '').match(/in ([0-9.]+) seconds/)?.[1] ?? null;
  await sleep(300);  // the start-up warnings are logged right after the summary line
  const warnings = relay.lines.filter(l => / (WARN|ERROR) /.test(l) && !/MediaMTX API unavailable/.test(l));
  const picked = relay.lines.find(l => /Picked up JDK_JAVA_OPTIONS/.test(l)) || '';
  check('2a the jar starts with the variables of relay.env.example (paths, port and MediaMTX API address replaced; no MediaMTX runs), without a settings warning', !!up && !!started && warnings.length === 0,
    { healthzStatus: up, startedInS: startedIn ? Number(startedIn) : null, summary: (started || '').replaceAll(TMP, '').replace(/^.*FRAME API/, 'FRAME API').slice(0, 300), warnings: warnings.map(l => l.slice(0, 200)) });
  check('2b the JVM options line of relay.env.example is picked up by java', picked.includes(env.JDK_JAVA_OPTIONS || '\u0000'), { line: picked.trim(), expected: env.JDK_JAVA_OPTIONS ?? null });
  // Loopback only: the LAN address of this PC must not answer.
  const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  let lanAnswer = 'no LAN address';
  if (lan) { try { lanAnswer = 'status ' + (await fetch(`http://${lan}:${PORT}/healthz`, { signal: AbortSignal.timeout(6000) })).status; } catch (e) { lanAnswer = e.cause?.code === 'ECONNREFUSED' ? 'refused' : 'error ' + (e.cause?.code || e.name); } }
  if (lan) check('2c RELAY_LISTEN_HOST=127.0.0.1: the LAN address of this PC refuses the connection', lanAnswer === 'refused', { lan: '<addr>', answer: lanAnswer });
  else result.notes.push('2c not measured: this PC has no non-loopback IPv4 address to try');

  // ---- 3 service ----------------------------------------------------------------------------------------------------------
  const health = await (await fetch(BASE + '/healthz')).json();
  check('3a /healthz: the Spring backend, MediaMTX reported unreachable (503) rather than a crash', health.backend === 'spring' && health.mediamtx === false && up === 503, { status: up, backend: health.backend, version: health.version });
  const get = async path => { const r = await fetch(BASE + path); return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), bytes: (await r.arrayBuffer()).byteLength }; };
  const page = await get('/'), pathPage = await get('/screen-01'), script = await get('/assets/js/' + scripts.find(f => f.endsWith('.js'))), font = await get('/assets/fonts/PretendardVariable.woff2');
  check('3b the legacy page, its hls.js and font are served from the installed ui folder', page.status === 200 && /text\/html/.test(page.type) && page.cache === 'no-store' && pathPage.status === 200
    && script.status === 200 && /immutable/.test(script.cache) && font.status === 200 && font.type === 'font/woff2', { page, pathPage, script, font });
  const id = randomBytes(16).toString('hex');
  const announce = token => fetch(BASE + '/api/broadcasts/announce', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'announce', item: { id, title: 'deploy check', publisher: 'CHECK', path: 'screen-01', width: 1280, height: 720, fps: 30, startedAtMs: Date.now(), sentAtMs: Date.now() } }) });
  const good = await announce(TOKEN), bad = await announce('x'.repeat(64));
  check('3c the token file is read: its token announces (204, media not ready), another token is refused (401)', good.status === 204 && good.headers.get('x-frame-media-ready') === '0' && bad.status === 401,
    { announce: good.status, mediaReady: good.headers.get('x-frame-media-ready'), wrongToken: bad.status });
  const report = await fetch(BASE + '/screen-01/stats', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ sid: 'deploy-check', transport: 'hls', quality: '720p', height: 720 }) });
  await sleep(300);
  const csv = readdirSync(map(paths.stats)).filter(f => /^stats-\d{4}-\d{2}-\d{2}\.csv$/.test(f));
  const rows = csv.length ? readFileSync(join(map(paths.stats), csv[0]), 'utf8').trim().split('\n') : [];
  check('3d a playback report is appended to RELAY_STATS_DIR (one CSV per day, no address in it)', report.status === 204 && csv.length === 1 && rows.length === 2 && rows[1].includes('deploy-check') && !rows[1].includes('127.0.0.1'),
    { status: report.status, file: csv[0] || null, rows: rows.length, header: rows[0] || null });
  const info = await (await fetch(BASE + '/screen-01/info')).json();
  check('3e /info: announced without media -> running, mediaReady false (viewers wait)', info.running === true && info.mediaReady === false, { running: info.running, mediaReady: info.mediaReady });
} catch (error) {
  failed = error;
  check('deploy check run', false, { error: String(error.stack || error.message).slice(0, 500) });
} finally {
  await stop(relay);
  writeFileSync(join(OUT, 'deploy-check.log'), scrub(relay.lines.join('\n').replaceAll(TOKEN, '***').replaceAll(TMP, '<tmp>'), ROOT) + '\n');
  // ---- 4 refusals ---------------------------------------------------------------------------------------------------------
  try {
    const refused = async (name, value) => {
      const p = start('deploy-check-refused', JAVA, ['-jar', jar], { cwd: map('/opt/frame-relay'), env: { ...runEnv, [name]: value } });
      const exit = await Promise.race([p.exited, sleep(40000).then(() => 'still running after 40 s')]);
      await stop(p);
      return { exit, find: re => (p.lines.find(l => re.test(l)) || '').replaceAll(TMP, '<tmp>').trim().slice(0, 220) };
    };
    const range = await refused('RELAY_MAX_VIEWERS_PER_PATH', '0');
    const rangeLine = range.find(/RELAY_MAX_VIEWERS_PER_PATH must be/);
    check('4a a value out of range (RELAY_MAX_VIEWERS_PER_PATH=0): no start, the log names the variable', typeof range.exit === 'number' && range.exit !== 0 && !!rangeLine, { exit: range.exit, line: rangeLine });
    const rate = await refused('RELAY_RATE_ANNOUNCE', 'fast');
    const rateLine = rate.find(/RELAY_RATE_ANNOUNCE must look like/);
    check('4b a malformed rate (RELAY_RATE_ANNOUNCE=fast): no start, the log names the variable', typeof rate.exit === 'number' && rate.exit !== 0 && !!rateLine, { exit: rate.exit, line: rateLine });
    const type = await refused('RELAY_DVR', 'maybe');
    const typeLine = type.find(/frame\.dvr/), valueLine = type.find(/maybe/);
    check('4c a switch that is no switch (RELAY_DVR=maybe): no start, the log names the setting frame.… and the value', typeof type.exit === 'number' && type.exit !== 0 && !!typeLine && !!valueLine, { exit: type.exit, setting: typeLine, value: valueLine });
    const on = await (async () => {
      const p = start('deploy-check-on', JAVA, ['-jar', jar], { cwd: map('/opt/frame-relay'), env: { ...runEnv, RELAY_DVR: 'off', RELAY_HLS: 'on' } });
      const up = await waitFor(async () => { try { return (await fetch(BASE + '/healthz')).status; } catch { return 0; } }, 40000, 200);
      const summary = (p.lines.find(l => /FRAME API /.test(l)) || '').replace(/^.*FRAME API/, 'FRAME API').replaceAll(TMP, '<tmp>').slice(0, 200);
      await stop(p);
      return { up, summary };
    })();
    check('4d on/off are read as switches (RELAY_DVR=off, RELAY_HLS=on): the service starts with DVR off', !!on.up && /DVR off/.test(on.summary), on);
  } catch (error) { check('4 refusals run', false, { error: String(error.stack || error.message).slice(0, 500) }); }
  const cleanupTarget = resolve(TMP), cleanupParent = resolve(tmpdir());
  if (dirname(cleanupTarget).toLowerCase() !== cleanupParent.toLowerCase() || !/^frame-deploy-check-[0-9]+$/.test(basename(cleanupTarget))) throw Error('Refusing cleanup outside the exact deployment fixture.');
  if (existsSync(cleanupTarget) && realpathSync(cleanupTarget).toLowerCase() !== cleanupTarget.toLowerCase()) throw Error('Refusing cleanup through a redirected deployment fixture.');
  try { rmSync(cleanupTarget, { recursive: true, force: true }); } catch {}
}
result.finishedAt = new Date().toISOString();
result.passed = list.filter(c => c.ok).length; result.failed = list.filter(c => c.ok === false).length;
result.notCovered = ['systemd on Linux: the sandbox directives with a JVM, SuccessExitStatus=143, stop time, FFmpeg children in the control group',
  'the distribution java package and /usr/bin/java', 'Caddy with deploy/Caddyfile.example (the test Caddyfile is checked by https-check.mjs)'];
writeFileSync(join(OUT, 'deploy-check-result.json'), scrub(JSON.stringify(result, null, 2).replaceAll(TOKEN, '***').replaceAll(TMP, '<tmp>'), ROOT));
console.log(`\n${result.passed} passed, ${result.failed} failed -> verification/spring/deploy/deploy-check-result.json`);
process.exit(result.failed || failed ? 1 : 0);
