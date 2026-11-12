// Real operator workflow on the separate verification DB. Native OBS and production accounts remain untouched.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'verification/product'), directory = join(tmpdir(), 'frame-operator-reports-e2e-' + Date.now());
const api = 'http://127.0.0.1:18083', origin = 'http://127.0.0.1:5365';
const config = JSON.parse(readFileSync(join(process.env.LOCALAPPDATA, 'Frame/product/config.json'), 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:\d+\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate verification database is required.');
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
const jar = join(directory, 'frame-api.jar'); copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar);
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = {
  ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: '18083', RELAY_OBS_ENABLED: 'false', RELAY_DVR: 'false',
  RELAY_MEDIAMTX_API: 'http://127.0.0.1:29997', RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:29888', RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '',
  FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername,
  FRAME_PRODUCT_DB_PASSWORD: config.dbPassword, FRAME_PRODUCT_REDIS_HOST: config.redisHost,
  FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: 'frame:product:operator-e2e:' + randomBytes(6).toString('hex') + ':sessions',
  FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
};
const results = [];
let apiProcess, complete = false;
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function ready(url, child) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!child.running) throw Error('Verification process exited. Inspect its private local log.');
    if ((await fetch(url).catch(() => null))?.ok) return;
    await sleep(150);
  }
  throw Error('Verification process did not become ready.');
}
async function startApi(name) {
  const child = start(name, join(process.env.JAVA_HOME, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-jar', jar], { cwd: root, env: environment, logDir: directory });
  await ready(api + '/api/v1/session', child); return child;
}
async function runBrowser(script, reportName, env) {
  const child = start(script, process.execPath, [join(root, `server/verify/${script}.mjs`)], { cwd: root, env, logDir: directory });
  const code = await child.exited, file = join(output, reportName);
  const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  return code === 0 && report?.results?.length > 0 && report.results.every(item => item.pass);
}
try {
  for (const port of [18083, 5365, 5366, 9498, 9499]) if (!await portFree(port)) throw Error('Verification port is already in use: ' + port);
  apiProcess = await startApi('spring');
  const web = start('web', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready(origin + '/_frame/', web);
  check(await runBrowser('operator-reports-ui', 'operator-reports-ui-result.json', { FRAME_OPERATOR_TEST_DIR: directory }), 'Real report management, workflow conflicts and permission checks pass browser verification');
  const checkpoint = JSON.parse(readFileSync(join(directory, 'operator-reports-checkpoint.json'), 'utf8'));
  const cookies = checkpoint.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  const headers = { Cookie: cookies };
  const localConfig = join(directory, 'verification-config.json');
  writeFileSync(localConfig, JSON.stringify({ ...config, dbUrl: config.verifyDbUrl }), { mode: 0o600 });
  const command = action => JSON.parse(execFileSync(process.execPath, [join(root, 'server/product-operator.mjs'), action, '--email', checkpoint.operatorEmail],
    { cwd: root, env: { ...process.env, FRAME_PRODUCT_CONFIG: localConfig }, windowsHide: true, encoding: 'utf8' }));
  check(command('status').isOperator === true, 'Local operator command recognizes the explicitly granted verification account');
  const removed = command('revoke');
  const denied = await fetch(api + '/api/v1/admin/reports', { headers });
  check(removed.changed && !removed.isOperator && denied.status === 403, 'Explicit local revoke blocks an existing logged-in session');
  const granted = command('grant');
  check(granted.changed && granted.isOperator && (await fetch(api + '/api/v1/admin/reports', { headers })).status === 200, 'Explicit local grant restores the same existing account without creating a user');
  const dev = start('web-dev', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5366', '--strictPort'],
    { cwd: join(root, 'apps/web'), env: { FRAME_RELAY_URL: api }, logDir: directory });
  await ready('http://127.0.0.1:5366/_frame/', dev);
  check(await runBrowser('operator-reports-dev-ui', 'operator-reports-dev-result.json', { FRAME_OPERATOR_TEST_DIR: directory }), 'Read-only development StrictMode keeps operator dialogs and mobile layout working');
  await stop(dev); await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  const sessionResponse = await fetch(api + '/api/v1/session', { headers }), session = await sessionResponse.json();
  check(sessionResponse.status === 200 && session.user?.isOperator === true, 'Operator authorization and Redis login survive API restart');
  const detailResponse = await fetch(api + '/api/v1/admin/reports/' + checkpoint.reportId, { headers }), detail = await detailResponse.json();
  check(detailResponse.status === 200 && detail.status === 'resolved' && detail.reviewNote === checkpoint.reviewNote && detail.reviewedBy?.id === checkpoint.operatorId,
    'Review status, operator and note persist after API restart');
  const terminal = await fetch(api + '/api/v1/admin/reports/' + checkpoint.reportId, { method: 'PATCH',
    headers: { ...headers, Origin: origin, 'X-CSRF-TOKEN': session.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'reviewing', reviewNote: 'cannot reopen', version: detail.version }) });
  check(terminal.status === 409 && (await terminal.json()).code === 'REPORT_ALREADY_CLOSED', 'Closed reports remain immutable after restart');
  complete = true;
} catch (failure) { console.error(failure.message); process.exitCode = 1; }
finally {
  writeFileSync(join(output, 'operator-reports-e2e-result.json'), JSON.stringify({ verificationDatabaseOnly: true, productionUserDataUntouched: true,
    productionOperatorNotAutomaticallyAssigned: true, mediaReceiverUntouched: true, complete, results,
    limits: ['Single PC, loopback and headless Edge only', 'No Caddy HTTPS/WSS, physical mobile device or load verification', 'Review status and notes do not execute channel restrictions or deletion'] }, null, 2));
  await stopAll(); console.log(JSON.stringify({ complete, checks: results.length, passed: results.filter(item => item.pass).length }));
}
