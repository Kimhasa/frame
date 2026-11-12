// Actual PostgreSQL + Redis product API checks. Run against a dedicated verification database, never user data.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const base = process.env.FRAME_PRODUCT_TEST_BASE || 'http://127.0.0.1:18081';
const origin = process.env.FRAME_PRODUCT_TEST_ORIGIN || 'http://127.0.0.1:5364';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || base.endsWith(':18080')) throw Error('Use a separate local verification API.');
const stateFile = join(process.env.LOCALAPPDATA, 'Frame', 'product', 'verification-session.json');
const out = resolve('verification/product');
await mkdir(out, { recursive: true });
const results = [];
function check(condition, name, detail = {}) {
  results.push({ name, pass: Boolean(condition), ...detail });
  if (!condition) throw Error(name);
}

class Client {
  constructor(saved) { this.cookies = new Map(saved?.cookies || []); this.csrf = saved?.csrf || ''; }
  async request(method, path, body, options = {}) {
    const headers = { Accept: 'application/json', Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (method !== 'GET') { headers.Origin = options.origin || origin; if (options.csrf !== false && this.csrf) headers['X-CSRF-TOKEN'] = this.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + '/api/v1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'manual' });
    const setCookies = response.headers.getSetCookie();
    for (const raw of setCookies) {
      const pair = raw.split(';')[0], at = pair.indexOf('='), name = pair.slice(0, at), value = pair.slice(at + 1);
      if (/max-age=0(?:;|$)/i.test(raw) || !value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (typeof data?.csrfToken === 'string') this.csrf = data.csrfToken;
    return { status: response.status, data, headers: response.headers, setCookies };
  }
  saved() { return { cookies: [...this.cookies], csrf: this.csrf }; }
}

try {
  if (process.argv.includes('--after-restart')) {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    const client = new Client(saved.b);
    let response = await client.request('GET', '/session');
    check(response.status === 200 && response.data.user?.id === saved.bId, 'Redis session survives API restart');
    response = await client.request('GET', '/channels/' + saved.aHandle);
    check(response.status === 200 && response.data.description === saved.description, 'PostgreSQL channel changes survive API restart');
    response = await client.request('GET', '/me/follows');
    check(response.status === 200 && response.data.items.some(c => c.id === saved.aChannelId), 'PostgreSQL follows survive API restart');
    await writeFile(join(out, 'restart-result.json'), JSON.stringify({ base, results }, null, 2));
    console.log(JSON.stringify({ checks: results.length, passed: results.filter(r => r.pass).length }));
    process.exit(0);
  }

  const run = randomBytes(5).toString('hex'), password = randomBytes(24).toString('base64url');
  const aHandle = 'qa_' + run, bHandle = 'qb_' + run, a = new Client(), b = new Client();
  let response = await a.request('GET', '/session');
  check(response.status === 200 && response.data.user === null && response.data.csrfToken, 'Anonymous session bootstrap and CSRF token');
  check(response.headers.get('cache-control')?.includes('no-store'), 'Session response is not cached');
  response = await a.request('GET', '/policies');
  check(response.status === 200 && response.data.terms?.required && response.data.privacy?.required && response.data.terms.sections?.length && response.data.privacy.sections?.length, 'Required signup documents are publicly available');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: response.data.terms.version, privacyVersion: response.data.privacy.version };
  response = await a.request('POST', '/auth/register', { email: `a_${run}@example.invalid`, password, displayName: '검증용 채널', handle: aHandle }, { csrf: false });
  check(response.status === 403, 'Signup requires CSRF');
  response = await a.request('POST', '/auth/register', { email: `a_${run}@example.invalid`, password, displayName: '검증용 채널', handle: aHandle });
  check(response.status === 400 && response.data.code === 'CONSENT_REQUIRED', 'Signup without consent is rejected');
  response = await a.request('POST', '/auth/register', { email: `a_${run}@example.invalid`, password, displayName: '검증용 채널', handle: aHandle, ...consent, privacyAccepted: false });
  check(response.status === 400 && response.data.code === 'CONSENT_REQUIRED', 'Signup without privacy consent is rejected');
  response = await a.request('POST', '/auth/register', { email: `a_${run}@example.invalid`, password, displayName: '검증용 채널', handle: aHandle, ...consent, termsVersion: 'outdated' });
  check(response.status === 400 && response.data.code === 'CONSENT_VERSION_CHANGED', 'Signup with an outdated policy is rejected');
  response = await a.request('POST', '/auth/register', { email: `a_${run}@example.invalid`, password, displayName: '검증용 채널', handle: aHandle, ...consent });
  check(response.status === 201 && response.data.user?.id && response.data.channel?.handle === aHandle, 'Signup creates account and channel and authenticates');
  const aChannelId = response.data.channel.id, aId = response.data.user.id;
  check(response.setCookies.some(c => /httponly/i.test(c) && /samesite=lax/i.test(c)), 'Session cookie is HttpOnly and SameSite Lax');
  const savedA = a.saved();
  response = await a.request('GET', '/studio');
  check(response.status === 403 && response.data.code === 'CHANNEL_NOT_CONNECTED', 'New account receives no existing OBS credentials');
  const description = '저장 확인용 채널 소개입니다. 🌱';
  response = await a.request('PATCH', '/me/channel', { displayName: '저장된 채널', description, notice: '목요일 오후 8시', category: '개발·작업', bannerPreset: 'forest' });
  check(response.status === 200 && response.data.description === description && response.data.bannerPreset === 'forest', 'Own channel fields and banner save to server');
  response = await a.request('PATCH', '/me/profile', { displayName: '저장된 프로필' });
  check(response.status === 200 && response.data.user?.displayName === '저장된 프로필', 'Own profile name saves to server');
  response = await a.request('PATCH', '/me/channel', { displayName: '거부될 변경', description }, { origin: 'https://untrusted.example' });
  check(response.status === 403, 'Foreign Origin write is rejected');
  response = await a.request('POST', '/me/channel/connection', { streamKey: 'obs-spring?user=obs-spring&pass=invalid-proof' });
  check(response.status === 403 || response.status === 400, 'Invalid stream ownership proof is rejected');

  await b.request('GET', '/session');
  response = await b.request('POST', '/auth/register', { email: `b_${run}@example.invalid`, password, displayName: '팔로우 검증', handle: bHandle, ...consent });
  check(response.status === 201 && response.data.user?.id !== aId, 'Second signup has separate identity');
  const bId = response.data.user.id;
  response = await b.request('PUT', '/me/follows/' + aChannelId, { notificationsOn: true });
  check(response.status === 200 && response.data.following && response.data.followerCount === 1 && response.data.notificationsOn, 'Follow and notification preference save');
  response = await b.request('PUT', '/me/follows/' + aChannelId, { notificationsOn: true });
  check(response.status === 200 && response.data.followerCount === 1, 'Repeated follow remains one row');
  response = await b.request('GET', '/me/follows');
  check(response.status === 200 && response.data.items.some(c => c.id === aChannelId), 'Following list comes from server');
  response = await b.request('GET', '/channels/' + aHandle);
  check(response.data.following && response.data.notificationsOn, 'Channel detail reflects authenticated follow state');
  const anonymous = new Client(); await anonymous.request('GET', '/session');
  response = await anonymous.request('PUT', '/me/follows/' + aChannelId, {});
  check(response.status === 401, 'Anonymous account cannot follow');
  response = await anonymous.request('GET', '/channels/' + aHandle);
  check(response.status === 200 && !response.data.following && response.data.followerCount === 1, 'Public channel exposes count without private follow state');
  response = await b.request('DELETE', '/me/follows/' + aChannelId);
  check(response.status === 200 && !response.data.following && response.data.followerCount === 0, 'Unfollow decrements authoritative count');
  response = await b.request('DELETE', '/me/follows/' + aChannelId);
  check(response.status === 200 && response.data.followerCount === 0, 'Repeated unfollow remains zero');
  await b.request('PUT', '/me/follows/' + aChannelId, { notificationsOn: true });
  const savedB = b.saved();

  response = await a.request('POST', '/auth/logout');
  check(response.status === 204, 'Logout completes');
  const replay = new Client(savedA);
  response = await replay.request('GET', '/session');
  check(response.status === 200 && response.data.user === null, 'Logged-out cookie cannot restore authentication');
  await a.request('GET', '/session');
  response = await a.request('POST', '/auth/login', { email: `a_${run}@example.invalid`, password: 'incorrect-password', remember: false });
  check(response.status === 401, 'Incorrect password cannot authenticate');
  response = await a.request('POST', '/auth/login', { email: `a_${run}@example.invalid`, password, remember: true });
  check(response.status === 200 && response.data.user?.id === aId, 'Correct password restores existing account');
  check(response.setCookies.some(c => /max-age=/i.test(c)), 'Remember login uses a persistent cookie');
  response = await a.request('GET', '/session');
  check(response.status === 200 && response.data.channel.id === aChannelId, 'Session bootstrap restores own channel');

  await writeFile(stateFile, JSON.stringify({ a: a.saved(), b: savedB, aHandle, aChannelId, bId, description }, null, 2), { mode: 0o600 });
  await writeFile(join(out, 'api-result.json'), JSON.stringify({ base, verificationDatabaseOnly: true, results }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(r => r.pass).length, checkpointSavedPrivately: true }));
} catch (error) {
  await writeFile(join(out, 'api-failure.json'), JSON.stringify({ results, failure: error.message }, null, 2));
  throw error;
}
