// Account-cookie monthly billing verification against an owned HTTP provider stub. This is NOT a Toss test-PG completion.
// Build once before running. Private cookies, keys, checkpoints, profiles, SQL and logs stay under LOCALAPPDATA/Frame/verification.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, stopAll, sleep, portFree } from './harness.mjs';
import { Client, api, origin } from './chat-moderation-client.mjs';

if (process.argv.includes('--capture-owner')) { await import('./membership-capture.mjs'); process.exit(process.exitCode ?? 0); }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), output = join(root, 'verification/product');
const run = randomBytes(6).toString('hex'), directory = join(process.env.LOCALAPPDATA, 'Frame/verification', 'membership-' + run);
const configFile = resolve(process.env.FRAME_PRODUCT_TEST_CONFIG ?? join(process.env.LOCALAPPDATA, 'Frame/product-docker/config.json'));
if (configFile.toLowerCase().startsWith(root.toLowerCase() + '\\')) throw Error('Verification configuration must remain external.');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (!/^jdbc:postgresql:\/\/127\.0\.0\.1:(15432|25432)\/frame_product_verify(?:_[a-z0-9]+)?$/.test(config.verifyDbUrl ?? '') || config.dbUrl === config.verifyDbUrl) throw Error('A separate guarded local verification database is required.');
const javaHome = join(process.env.LOCALAPPDATA, 'FrameTools/jdk-21.0.13+9');
if (!existsSync(join(javaHome, 'bin/java.exe'))) throw Error('Verification JDK unavailable.');
mkdirSync(directory, { recursive: true }); mkdirSync(output, { recursive: true });
const jar = join(directory, 'frame-api.jar'); copyFileSync(join(root, 'apps/api/build/libs/frame-api.jar'), jar);
const jarHash = createHash('sha256').update(readFileSync(jar)).digest('hex');
const providerBase = 'http://127.0.0.1:19091', clientKey = 'test_ck_membership_fixture_' + run, secretKey = 'test_sk_membership_fixture_' + randomBytes(24).toString('base64url');
const expectedBasic = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');
const clean = Object.fromEntries(Object.keys(process.env).filter(key => /^(RELAY_|MTX_|FRAME_PRODUCT_|FRAME_MEMBERSHIP_|TOSS_TEST_)/i.test(key)).map(key => [key, undefined]));
const environment = { ...clean, RELAY_LISTEN_HOST: '127.0.0.1', RELAY_PORT: '18083', RELAY_OBS_ENABLED: 'false', RELAY_DVR: 'false',
  RELAY_MEDIAMTX_API: 'http://127.0.0.1:29997', RELAY_MEDIAMTX_HLS: 'http://127.0.0.1:29888', RELAY_UI_FILE: '', RELAY_RENDITIONS: '', RELAY_STATS_DIR: '', RELAY_RECORD_DIR: '',
  FRAME_PRODUCT_ENABLED: 'true', FRAME_PRODUCT_DB_URL: config.verifyDbUrl, FRAME_PRODUCT_DB_USERNAME: config.dbUsername, FRAME_PRODUCT_DB_PASSWORD: config.dbPassword,
  FRAME_PRODUCT_REDIS_HOST: config.redisHost, FRAME_PRODUCT_REDIS_PORT: String(config.redisPort), FRAME_PRODUCT_REDIS_PASSWORD: config.redisPassword,
  FRAME_PRODUCT_REDIS_NAMESPACE: `frame:product:membership-e2e:${run}:sessions`, FRAME_PRODUCT_PUBLIC_ORIGIN: origin, FRAME_PRODUCT_COOKIE_SECURE: 'false',
  FRAME_MEMBERSHIP_TEST_ENABLED: 'true', FRAME_MEMBERSHIP_TEST_CLIENT_KEY: clientKey, FRAME_MEMBERSHIP_TEST_SECRET_KEY: secretKey };
const results = [], captures = [], sockets = new Set(), requests = new Map(), billing = new Map(), payments = new Map();
const counts = { issue: 0, charge: 0, lookup: 0, delete: 0, acceptedCharges: 0, invalidAuth: 0, invalidIdempotency: 0 };
let apiProcess, provider, fixture, complete = false, nextChargeMode = 'ok';
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) throw Error(name); }
async function until(test, label, duration = 45000) { const end = Date.now() + duration; while (Date.now() < end) { const value = await test(); if (value) return value; await sleep(100); } throw Error(label); }
async function ready(url, process) { await until(async () => { if (!process.running) throw Error('Owned verification process exited; see its private local log.'); return (await fetch(url).catch(() => null))?.ok; }, 'Verification service readiness timed out.'); }
async function startApi(name) { const child = start(name, join(javaHome, 'bin/java.exe'), ['-Xms64m', '-Xmx256m', '-Dframe.membership.test-api-base=' + providerBase, '-jar', jar], { cwd: root, env: environment, logDir: directory }); await ready(api + '/api/v1/session', child); return child; }
async function account(kind, consent) { const client = new Client(); await client.request('GET', '/session'); const response = await client.request('POST', '/auth/register', { email: `membership_${kind}_${run}@example.invalid`, password: randomBytes(24).toString('base64url'), displayName: '멤버십 검증 ' + kind, ...consent }); if (response.status !== 201) throw Error('Dedicated membership account registration failed.'); return { client, user: response.data.user, channel: response.data.channel }; }
async function membership(client, id) { const response = await client.request('GET', '/me/memberships/' + id); if (response.status !== 200) throw Error('Owned membership detail unavailable.'); return response.data.item; }
async function state(client, id, test, label, duration = 45000) { return until(async () => { const item = await membership(client, id); return test(item) ? item : null; }, label, duration); }
function makeRenewalDue(id) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (![id, fixture.member.user.id, fixture.owner.channel.id].every(value => uuid.test(value))) throw Error('Only exact fixture UUIDs may enter the controlled renewal clock.');
  const database = new URL(config.verifyDbUrl.slice(5));
  const sql = `WITH target AS (
    SELECT m.id,m.period_ends_at_ms-(floor(extract(epoch FROM clock_timestamp())*1000)::bigint-1000) AS shift
    FROM product_memberships m JOIN product_accounts subscriber ON subscriber.id=m.subscriber_id
    JOIN product_channels c ON c.id=m.channel_id JOIN product_accounts owner ON owner.id=c.owner_id
    WHERE m.id='${id}'::uuid AND m.subscriber_id='${fixture.member.user.id}'::uuid AND m.channel_id='${fixture.owner.channel.id}'::uuid
      AND subscriber.email='membership_member_${run}@example.invalid' AND owner.email='membership_owner_${run}@example.invalid'
      AND m.created_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint-3600000
      AND m.status='active' AND m.cancel_requested_at_ms IS NULL AND m.ended_at_ms IS NULL
      AND m.period_started_at_ms IS NOT NULL AND m.period_ends_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
      AND m.next_charge_at_ms=m.period_ends_at_ms
      AND (SELECT count(*) FROM product_membership_payments p WHERE p.membership_id=m.id)=1
      AND EXISTS(SELECT 1 FROM product_membership_payments p WHERE p.membership_id=m.id AND p.cycle=0 AND p.status='paid')
    FOR UPDATE OF m
  ), shifted AS (
    UPDATE product_memberships m SET period_started_at_ms=m.period_started_at_ms-t.shift,
      period_ends_at_ms=m.period_ends_at_ms-t.shift,next_charge_at_ms=m.next_charge_at_ms-t.shift
    FROM target t WHERE m.id=t.id RETURNING m.id,t.shift
  ), history_shift AS (
    UPDATE product_membership_payments p SET period_started_at_ms=p.period_started_at_ms-s.shift,period_ends_at_ms=p.period_ends_at_ms-s.shift
    FROM shifted s WHERE p.membership_id=s.id AND p.cycle=0 AND p.status='paid' RETURNING p.membership_id
  ) SELECT membership_id FROM history_shift`;
  let result;
  try { result = execFileSync(join(process.env.FRAME_POSTGRES_BIN ?? 'C:/Program Files/PostgreSQL/17/bin', 'psql.exe'), ['-X', '-w', '-h', database.hostname, '-p', database.port, '-U', config.dbUsername, '-d', database.pathname.slice(1), '-At', '-v', 'ON_ERROR_STOP=1'], { env: { ...process.env, ...clean, PGPASSWORD: config.dbPassword }, input: sql, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { throw Error('The guarded membership renewal clock fixture failed; no SQL or credentials were printed.'); }
  if (!result.split(/\r?\n/).includes(id)) throw Error('The renewal clock guard refused to change an unrelated or nonfresh membership.');
}
async function browser(mode) { writeFileSync(join(directory, 'membership-checkpoint.json'), JSON.stringify({ owner: fixture.owner.client.saved(), member: fixture.member.client.saved(), other: fixture.other.client.saved(), channel: fixture.owner.channel, providerBase, run })); const child = start('membership-ui-' + mode, process.execPath, [join(root, 'server/verify/membership-ui.mjs'), mode], { cwd: root, env: { ...clean, FRAME_MEMBERSHIP_TEST_DIR: directory }, logDir: directory }); await until(() => !child.running, 'Membership browser verification timed out.', 240000); const reportFile = join(output, 'membership-' + mode + '-result.json'), report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null; check(await child.exited === 0 && report?.complete && report.results?.length > 0 && report.results.every(item => item.pass), mode + ' membership browser verification passes with an explicitly stubbed billing SDK and provider'); }
function reply(response, status, value) { response.writeHead(status, value === undefined ? {} : { 'Content-Type': 'application/json' }).end(value === undefined ? undefined : JSON.stringify(value)); }
async function providerRequest(request, response) {
  if (request.headers.authorization !== expectedBasic) { counts.invalidAuth++; reply(response, 401, { code: 'UNAUTHORIZED' }); return; }
  const chunks = []; let length = 0; for await (const chunk of request) { length += chunk.length; if (length > 65536) { reply(response, 413, { code: 'TOO_LARGE' }); return; } chunks.push(chunk); }
  let body; try { body = length ? JSON.parse(Buffer.concat(chunks)) : null; } catch { reply(response, 400, { code: 'INVALID_JSON' }); return; }
  const path = request.url, method = request.method, idempotency = request.headers['idempotency-key'];
  if (['POST', 'DELETE'].includes(method) && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(idempotency ?? '')) { counts.invalidIdempotency++; reply(response, 400, { code: 'INVALID_IDEMPOTENCY' }); return; }
  const capture = { method, path, idempotency, body, basicValid: true }; captures.push(capture);
  const operation = method === 'POST' && path === '/v1/billing/authorizations/issue' ? 'issue' : method === 'POST' && path.startsWith('/v1/billing/') ? 'charge' : method === 'GET' && path.startsWith('/v1/payments/orders/') ? 'lookup' : method === 'DELETE' && path.startsWith('/v1/billing/') ? 'delete' : null;
  if (operation) counts[operation]++;
  const identity = JSON.stringify([method, path, body]);
  if (idempotency && requests.has(idempotency)) { const previous = requests.get(idempotency); if (previous.identity !== identity) { reply(response, 409, { code: 'IDEMPOTENCY_CONFLICT' }); return; } reply(response, previous.status, previous.value); return; }
  function save(status, value) { if (idempotency) requests.set(idempotency, { identity, status, value }); return value; }
  if (method === 'POST' && path === '/v1/billing/authorizations/issue') {
    if (typeof body?.authKey !== 'string' || typeof body?.customerKey !== 'string') { reply(response, 400, { code: 'INVALID_AUTHORIZATION' }); return; }
    const billingKey = 'membership_billing_' + randomBytes(24).toString('hex'), value = { customerKey: body.customerKey, billingKey, method: '카드', card: { number: '433012******1234' } };
    billing.set(billingKey, { customerKey: body.customerKey, deleted: false }); reply(response, 200, save(200, value)); return;
  }
  if (method === 'POST' && path.startsWith('/v1/billing/')) {
    const key = decodeURIComponent(path.slice('/v1/billing/'.length)), saved = billing.get(key);
    if (!saved || saved.deleted || saved.customerKey !== body?.customerKey || !Number.isSafeInteger(body?.amount) || !body?.orderId) { reply(response, 400, { code: 'INVALID_BILLING' }); return; }
    const value = { orderId: body.orderId, paymentKey: 'membership_payment_' + randomBytes(24).toString('hex'), totalAmount: body.amount, currency: 'KRW', type: 'BILLING', status: 'DONE', approvedAt: new Date().toISOString(), method: '카드', card: {}, receipt: { url: 'https://dashboard.tosspayments.com/receipt/fixture' } };
    if (payments.has(body.orderId)) { reply(response, 409, { code: 'DUPLICATE_ORDER_ID' }); return; }
    payments.set(body.orderId, value); counts.acceptedCharges++; save(200, value);
    const mode = nextChargeMode; nextChargeMode = 'ok'; if (mode === 'responseLost') { request.socket.destroy(); return; }
    if (mode === 'processing400') { reply(response, 400, { code: 'ALREADY_PROCESSING_REQUEST' }); return; }
    reply(response, 200, value); return;
  }
  if (method === 'GET' && path.startsWith('/v1/payments/orders/')) { const value = payments.get(decodeURIComponent(path.slice('/v1/payments/orders/'.length))); reply(response, value ? 200 : 404, value ?? { code: 'NOT_FOUND_PAYMENT' }); return; }
  if (method === 'DELETE' && path.startsWith('/v1/billing/')) { const saved = billing.get(decodeURIComponent(path.slice('/v1/billing/'.length))); if (saved) saved.deleted = true; save(200); reply(response, 200); return; }
  reply(response, 404, { code: 'NOT_FOUND' });
}

try {
  for (const port of [18083, 5365, 19091, 9550, 9551]) if (!await portFree(port)) throw Error('A dedicated membership verification port is occupied: ' + port);
  provider = createServer((request, response) => { void providerRequest(request, response).catch(() => { if (!response.headersSent) reply(response, 500, { code: 'FIXTURE_ERROR' }); else response.destroy(); }); }); provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(19091, '127.0.0.1', resolve); });
  apiProcess = await startApi('spring');
  const policies = await new Client().request('GET', '/policies'); if (policies.status !== 200) throw Error('Registration policies unavailable.');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  fixture = { owner: await account('owner', consent), member: await account('member', consent), other: await account('other', consent) };
  const owner = fixture.owner.client, member = fixture.member.client, other = fixture.other.client, anonymous = new Client(); await anonymous.request('GET', '/session');
  const defaultPlan = await owner.request('GET', '/me/membership/plan');
  check(defaultPlan.status === 200 && defaultPlan.data.item.channelId === fixture.owner.channel.id && defaultPlan.data.item.version === 0 && !defaultPlan.data.item.enabled && defaultPlan.data.item.paymentsReady && defaultPlan.headers.get('cache-control')?.includes('no-store'), 'A new owner has private disabled membership settings and an explicitly configured stub gateway');
  const planBody = { version: 0, enabled: true, amount: 4900, benefits: '검증용 월 멤버십 혜택', clientRequestId: randomUUID() };
  check((await anonymous.request('GET', '/me/memberships')).status === 401 && (await owner.request('PATCH', '/me/membership/plan', planBody, { csrf: false })).status === 403 && (await owner.request('PATCH', '/me/membership/plan', planBody, { origin: 'https://untrusted.example.invalid' })).status === 403 && (await owner.request('GET', '/me/membership/plan', undefined, { expectedUserId: fixture.other.user.id })).status === 409, 'Membership management rejects anonymous reads, missing CSRF, foreign Origin and changed accounts');
  let savedPlan = await owner.request('PATCH', '/me/membership/plan', planBody); check(savedPlan.status === 200 && savedPlan.data.item.enabled && savedPlan.data.item.amount === 4900, 'The owning broadcaster publishes its real monthly plan through a versioned server update');
  check((await owner.request('GET', '/me/membership/plan/requests/' + planBody.clientRequestId)).status === 200 && (await owner.request('PATCH', '/me/membership/plan', { ...planBody, clientRequestId: randomUUID() })).status === 409, 'Plan update receipts reconcile committed writes and stale versions cannot overwrite them');
  const publicPlan = await anonymous.request('GET', '/channels/' + fixture.owner.channel.id + '/membership');
  check(publicPlan.status === 200 && publicPlan.data.plan.amount === 4900 && !JSON.stringify(publicPlan.data).includes(secretKey), 'The public membership offer exposes the server price without billing credentials');
  const signupId = randomUUID(), signupBody = { channelId: fixture.owner.channel.id, planVersion: savedPlan.data.item.version, clientRequestId: signupId, consentVersion: '2026-11-17' };
  const beforeSignup = captures.length;
  const { consentVersion: ignoredConsent, ...missingConsent } = signupBody;
  check((await member.request('POST', '/me/memberships', missingConsent)).status === 400 && (await member.request('POST', '/me/memberships', { ...signupBody, consentVersion: 'unsupported' })).status === 400 && captures.length === beforeSignup, 'Missing or unsupported recurring-payment consent is rejected before any provider request');
  check((await owner.request('POST', '/me/memberships', signupBody)).status === 400 && (await member.request('POST', '/me/memberships', { ...signupBody, amount: 1 })).status === 400, 'Self-subscription and client-supplied payment amounts are rejected before provider contact');
  check((await member.request('POST', '/me/memberships', { ...signupBody, planVersion: savedPlan.data.item.version + 1, clientRequestId: randomUUID() })).status === 409, 'A stale or invented offer version cannot prepare a checkout with a different price');
  check(captures.length === beforeSignup, 'Rejected membership preparation does not contact the provider');
  const joined = await member.request('POST', '/me/memberships', signupBody), subscription = joined.data?.item, checkout = joined.data?.checkout;
  check(joined.status === 201 && subscription?.status === 'pending_auth' && !subscription.entitled && checkout?.subscriptionId === subscription.id && checkout?.clientKey === clientKey && typeof checkout.customerKey === 'string', 'Preparing a real account membership returns a pending authorization and server-bound checkout identity without entitlement');
  const duplicateSignup = await member.request('POST', '/me/memberships', signupBody), signupReceipt = await member.request('GET', '/me/memberships/requests/' + signupId);
  check(duplicateSignup.status === 200 && duplicateSignup.data.item.id === subscription.id && signupReceipt.status === 200 && signupReceipt.data.item.id === subscription.id && (await member.request('GET', '/me/memberships')).data.items.length === 1, 'Repeated signup and its receipt resolve one durable subscription without a second order');
  check((await other.request('GET', '/me/memberships/' + subscription.id)).status === 404 && (await other.request('GET', '/me/memberships/' + subscription.id + '/payments')).status === 404 && (await other.request('POST', '/me/memberships/' + subscription.id + '/authorize', { authKey: 'membership_other_fixture_auth', customerKey: checkout.customerKey, clientRequestId: signupId })).status === 404 && (await other.request('POST', '/me/memberships/' + subscription.id + '/cancel', { version: subscription.version, clientRequestId: randomUUID() })).status === 404, 'A different account cannot read, authorize or cancel the subscriber’s private membership');
  const authorization = { authKey: 'membership_auth_' + randomBytes(24).toString('hex'), customerKey: checkout.customerKey, clientRequestId: signupId };
  check((await member.request('POST', '/me/memberships/' + subscription.id + '/authorize', { ...authorization, customerKey: 'wrong_customer_key_with_valid_length' })).status === 409 && captures.length === beforeSignup, 'A tampered checkout customer identity is refused before billing-key issuance');
  nextChargeMode = 'responseLost';
  const authorized = await member.request('POST', '/me/memberships/' + subscription.id + '/authorize', authorization);
  check(authorized.status === 202, 'The authentic account callback is accepted for asynchronous billing-key issuance and first charging');
  await until(async () => (await member.request('GET', '/me/memberships/' + subscription.id + '/payments')).data.items.some(item => item.status === 'unknown'), 'A dropped provider charge response did not reach the persisted unknown state.');
  const uncertain = await membership(member, subscription.id);
  check(!uncertain.entitled && uncertain.paymentPending && counts.acceptedCharges === 1 && counts.charge === 1, 'A provider-accepted charge with a lost response remains unconfirmed and grants no fabricated membership');
  const repeatedAuthorization = await member.request('POST', '/me/memberships/' + subscription.id + '/authorize', authorization);
  check([200, 202].includes(repeatedAuthorization.status) && counts.issue === 1 && counts.charge === 1, 'Repeating the same authorization cannot issue or charge again while confirmation is unknown');
  check([200, 202].includes((await member.request('POST', '/me/memberships/' + subscription.id + '/reconcile', {})).status), 'The subscriber can explicitly request lookup-only reconciliation');
  let active = await state(member, subscription.id, item => item.status === 'active' && item.entitled && !item.paymentPending, 'Provider lookup did not reconcile the accepted charge into a paid membership.');
  check(counts.lookup >= 1 && counts.charge === 1 && counts.acceptedCharges === 1 && active.nextChargeAtMs === active.periodEndsAtMs && active.periodEndsAtMs > active.periodStartedAtMs, 'Lookup of the same persisted order confirms one paid month without a second provider charge');
  const firstPayments = await member.request('GET', '/me/memberships/' + subscription.id + '/payments');
  check(firstPayments.status === 200 && firstPayments.data.items.length === 1 && firstPayments.data.items[0].status === 'paid' && firstPayments.data.items[0].amount === 4900 && !JSON.stringify(firstPayments.data).includes(authorization.authKey), 'The account payment history contains the confirmed monthly amount and excludes authorization secrets');
  const ownerMembers = await owner.request('GET', '/me/membership/members?status=active&limit=1');
  check(ownerMembers.status === 200 && ownerMembers.data.items.some(item => item.id === subscription.id) && (await other.request('GET', '/me/membership/members/' + subscription.id)).status === 404, 'Only the owning broadcaster sees its actual active subscriber and private detail');
  fixture.subscriptionId = subscription.id;
  const changedPlan = await owner.request('PATCH', '/me/membership/plan', { ...planBody, version: savedPlan.data.item.version, amount: 5900, clientRequestId: randomUUID() });
  check(changedPlan.status === 200 && (await membership(member, subscription.id)).amount === 4900, 'Changing the offer price affects future signups while the existing subscriber keeps the paid price snapshot');
  nextChargeMode = 'processing400'; makeRenewalDue(subscription.id);
  await until(async () => (await member.request('GET', '/me/memberships/' + subscription.id + '/payments')).data.items.some(item => item.status === 'unknown'), 'An HTTP400 processing response was incorrectly treated as a definitive renewal failure.');
  check(counts.charge === 2 && counts.acceptedCharges === 2 && !(await membership(member, subscription.id)).entitled, 'A provider HTTP400 ALREADY_PROCESSING_REQUEST remains unconfirmed without another charge or fabricated renewed access');
  check((await member.request('POST', '/me/memberships/' + subscription.id + '/reconcile', {})).status === 200, 'A processing-error renewal can request lookup of its existing order');
  active = await state(member, subscription.id, item => item.entitled && !item.paymentPending && item.nextChargeAtMs > Date.now() && counts.acceptedCharges === 2, 'The controlled due membership did not receive exactly one scheduled renewal.');
  const renewedPayments = await member.request('GET', '/me/memberships/' + subscription.id + '/payments'), chargeRequests = captures.filter(item => item.method === 'POST' && item.path.startsWith('/v1/billing/') && !item.path.endsWith('/issue'));
  check(renewedPayments.data.items.length === 2 && renewedPayments.data.items.every(item => item.status === 'paid' && item.amount === 4900) && counts.lookup >= 2 && chargeRequests.length === 2 && new Set(chargeRequests.map(item => item.body.orderId)).size === 2 && new Set(chargeRequests.map(item => item.idempotency)).size === 2, 'Lookup resolves the HTTP400 processing response into one new monthly cycle with a distinct stable order/idempotency tuple and the original price');
  check((await member.request('POST', '/me/memberships/' + subscription.id + '/cancel', { version: active.version - 1, clientRequestId: randomUUID() })).status === 409, 'A stale membership version cannot cancel a newer paid cycle');
  const cancelId = randomUUID(), cancelBody = { version: active.version, clientRequestId: cancelId }, cancelled = await member.request('POST', '/me/memberships/' + subscription.id + '/cancel', cancelBody);
  check(cancelled.status === 200 && cancelled.data.item.cancelRequestedAtMs && cancelled.data.item.nextChargeAtMs === null && cancelled.data.item.entitled && cancelled.data.item.periodEndsAtMs === active.periodEndsAtMs, 'Cancellation stops the next monthly charge while preserving the already paid membership period');
  const afterCancel = counts.acceptedCharges;
  await state(member, subscription.id, item => item.billingKeyDeletion === 'done', 'Cancelled billing key was not deleted from the owned provider.');
  check(counts.delete === 1 && [...billing.values()].filter(item => item.deleted).length === 1 && (await member.request('GET', '/me/memberships/' + subscription.id + '/requests/' + cancelId)).status === 200, 'Cancellation has a durable receipt and actually deletes its billing key through the authenticated provider route');
  check((await member.request('POST', '/me/memberships/' + subscription.id + '/cancel', cancelBody)).status === 200 && counts.acceptedCharges === afterCancel, 'Repeating cancellation neither refunds the paid month nor creates another charge');
  await sleep(2300); check(counts.acceptedCharges === afterCancel && (await membership(member, subscription.id)).nextChargeAtMs === null, 'Subsequent scheduler polls create no renewal charge after cancellation removes the next-charge deadline');
  const web = start('web-production', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'], { cwd: join(root, 'apps/web'), env: { ...clean, FRAME_RELAY_URL: api }, logDir: directory }); await ready(origin + '/_frame/', web); await browser('production'); await stop(web);
  const dev = start('web-development', process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--mode', 'relay', '--host', '127.0.0.1', '--port', '5365', '--strictPort'], { cwd: join(root, 'apps/web'), env: { ...clean, FRAME_RELAY_URL: api }, logDir: directory }); await ready(origin + '/_frame/', dev); await browser('dev'); await stop(dev);
  const browserMemberships = await other.request('GET', '/me/memberships'), browserMembership = browserMemberships.data.items.find(item => item.channel.id === fixture.owner.channel.id);
  await state(other, browserMembership.id, item => item.billingKeyDeletion === 'done', 'The browser-cancelled membership billing key was not deleted.');
  check(counts.issue === 2 && counts.charge === 3 && counts.acceptedCharges === 3 && counts.delete === 2 && [...billing.values()].every(item => item.deleted), 'The complete API and browser workflows issue two billing keys, make exactly three effective charges and delete both keys without hidden renewal or authorization retries');
  await stop(apiProcess); apiProcess = await startApi('spring-restarted');
  const restored = await membership(member, subscription.id), restoredPayments = await member.request('GET', '/me/memberships/' + subscription.id + '/payments');
  check(restored.cancelRequestedAtMs && restored.nextChargeAtMs === null && restored.billingKeyDeletion === 'done' && restored.entitled && restoredPayments.data.items.length === renewedPayments.data.items.length, 'The same account session, paid period, cancellation and confirmed payment history survive an identical-JAR API restart');
  check(counts.invalidAuth === 0 && counts.invalidIdempotency === 0 && captures.length > 0 && captures.every(item => item.basicValid) && captures.filter(item => ['POST', 'DELETE'].includes(item.method)).every(item => item.idempotency), 'Every actual loopback provider request uses the expected Basic secret and every mutation has a stable idempotency key');
  check(createHash('sha256').update(readFileSync(jar)).digest('hex') === jarHash, 'All membership API lifecycles use the same immutable copied JAR');
  complete = true;
} catch (failure) { writeFileSync(join(directory, 'failure.txt'), failure.stack ?? String(failure)); console.error(failure.message); if (!results.some(item => item.name === failure.message && !item.pass)) results.push({ name: failure.message, pass: false }); process.exitCode = 1; }
finally { await stopAll(); for (const socket of sockets) socket.destroy(); if (provider) await new Promise(resolve => provider.close(resolve)); writeFileSync(join(output, 'membership-e2e-result.json'), JSON.stringify({ complete, providerStubComplete: complete, actualTossTestPgCompleted: false, actualTossTestPgCancellationCompleted: false, verificationDatabaseOnly: true, productionUserDataUntouched: true, currentMediaReceiverUntouched: true, singleImmutableJar: true, provider: 'Owned loopback HTTP billing provider stub, not Toss', sdk: 'Browser-local billing-auth spy, not Toss authentication', results, providerRequestCounts: counts, limits: ['No actual Toss test-PG authorization or charge was completed by this suite', 'No refund is requested; cancellation stops future charges and retains the paid period', 'A controlled database clock fixture represents renewal scheduling, not a real elapsed month', 'Single Windows PC; mobile viewports are emulated; provider secrets and callback keys remain private'] }, null, 2)); console.log(JSON.stringify({ complete, actualTossTestPgCompleted: false, checks: results.length, passed: results.filter(item => item.pass).length })); }
