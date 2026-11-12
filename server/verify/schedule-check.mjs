// Uses a separate verification API/database only; no real accounts or broadcast settings are changed.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const base = process.env.FRAME_PRODUCT_TEST_BASE || 'http://127.0.0.1:18081';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || base.endsWith(':18080')) throw Error('Use the separate verification API.');
const origin = process.env.FRAME_PRODUCT_TEST_ORIGIN || 'http://127.0.0.1:5364';
const checkpoint = join(process.env.LOCALAPPDATA, 'Frame/product/schedule-verification.json');
const output = resolve('verification/product');
await mkdir(output, { recursive: true });
const results = [];
function check(pass, name) { results.push({ name, pass: Boolean(pass) }); if (!pass) throw Error(name); }
class Client {
  constructor(saved) { this.cookies = new Map(saved?.cookies || []); this.csrf = saved?.csrf || ''; }
  async request(method, path, body, options = {}) {
    const headers = { Accept: 'application/json', Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
    if (method !== 'GET') { headers.Origin = options.origin || origin; if (options.csrf !== false && this.csrf) headers['X-CSRF-TOKEN'] = this.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + '/api/v1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], at = pair.indexOf('='), name = pair.slice(0, at), value = pair.slice(at + 1);
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    if (data?.csrfToken) this.csrf = data.csrfToken;
    return { status: response.status, data };
  }
  saved() { return { cookies: [...this.cookies], csrf: this.csrf }; }
}

try {
  if (process.argv.includes('--after-restart')) {
    const saved = JSON.parse(await readFile(checkpoint, 'utf8')), owner = new Client(saved.owner);
    let response = await owner.request('GET', '/me/schedules');
    check(response.status === 200 && response.data.items.some(item => item.id === saved.id && item.title === saved.title), 'Saved schedule and authentication survive API restart');
    response = await new Client().request('GET', `/channels/${saved.handle}/schedule`);
    check(response.status === 200 && response.data.items.some(item => item.id === saved.id), 'Public schedule survives API restart');
    check(!response.data.items.some(item => item.id === saved.cancelledId), 'Cancelled schedule stays absent after API restart');
    await writeFile(join(output, 'schedule-restart-result.json'), JSON.stringify({ base, results }, null, 2));
    console.log(JSON.stringify({ checks: results.length, passed: results.filter(r => r.pass).length }));
    process.exit(0);
  }
  const suffix = randomBytes(5).toString('hex'), password = randomBytes(22).toString('base64url');
  const owner = new Client(), other = new Client(), anonymous = new Client();
  await owner.request('GET', '/session');
  const policies = await owner.request('GET', '/policies');
  const consent = { termsAccepted: true, privacyAccepted: true, termsVersion: policies.data.terms.version, privacyVersion: policies.data.privacy.version };
  let response = await owner.request('POST', '/auth/register', { email: `schedule_${suffix}@example.invalid`, password, displayName: '예약 채널', ...consent });
  check(response.status === 201, 'Schedule owner signs up in the verification database');
  const handle = response.data.channel.handle;
  await other.request('GET', '/session');
  response = await other.request('POST', '/auth/register', { email: `other_${suffix}@example.invalid`, password, displayName: '다른 채널', ...consent });
  check(response.status === 201, 'A separate schedule owner has a separate channel');
  const otherHandle = response.data.channel.handle;
  await anonymous.request('GET', '/session');
  response = await anonymous.request('GET', '/me/schedules');
  check(response.status === 401, 'Private schedule list requires authentication');
  const at = Math.ceil((Date.now() + 86400000) / 60000) * 60000;
  response = await anonymous.request('POST', '/me/schedules', { title: 'anonymous', at });
  check(response.status === 401, 'Anonymous schedule creation is rejected');
  response = await owner.request('POST', '/me/schedules', { title: 'CSRF', at }, { csrf: false });
  check(response.status === 403, 'Schedule writes require CSRF');
  response = await owner.request('POST', '/me/schedules', { title: 'origin', at }, { origin: 'https://untrusted.example' });
  check(response.status === 403, 'Schedule writes reject another Origin');
  response = await owner.request('GET', '/me/schedules');
  check(response.status === 200 && response.data.items.length === 0, 'New channel starts with no fabricated schedules');
  response = await owner.request('POST', '/me/schedules', { title: '  처음 예약 🌱  ', at });
  check(response.status === 201 && response.data.id && response.data.title === '처음 예약 🌱' && response.data.at === at, 'Create returns a server ID and trimmed title with the exact timestamp');
  const first = response.data;
  response = await owner.request('POST', '/me/schedules', { title: 'duplicate', at });
  check(response.status === 409 && response.data.code === 'SCHEDULE_CONFLICT', 'Duplicate channel and start time are rejected');
  response = await other.request('POST', '/me/schedules', { title: '다른 채널의 같은 시간', at });
  check(response.status === 201, 'Different channels may schedule the same time');
  response = await owner.request('POST', '/me/schedules', { title: 'past', at: Date.now() - 10000 });
  check(response.status === 400 && response.data.code === 'INVALID_SCHEDULE_TIME', 'New reservations must be in the future');
  response = await owner.request('POST', '/me/schedules', { title: 'fraction', at: at + 0.5 });
  check(response.status === 400, 'Fractional timestamps are rejected');
  response = await owner.request('POST', '/me/schedules', { title: '', at: at + 60000 });
  check(response.status === 400 && response.data.code === 'INVALID_SCHEDULE_TITLE', 'Blank titles are rejected');
  response = await other.request('PATCH', '/me/schedules/' + first.id, { title: 'stolen', at: at + 60000 });
  check(response.status === 404, 'Another account cannot edit the reservation');
  response = await other.request('DELETE', '/me/schedules/' + first.id);
  check(response.status === 404, 'Another account cannot cancel the reservation');
  response = await owner.request('PATCH', '/me/schedules/' + first.id, { title: '수정된 방송 일정', at: at + 60000 });
  check(response.status === 200 && response.data.title === '수정된 방송 일정' && response.data.at === at + 60000, 'Owner edit is saved to PostgreSQL');
  const edited = response.data;
  response = await owner.request('POST', '/me/schedules', { title: '취소할 예약', at: at + 120000 });
  check(response.status === 201, 'Another future reservation can be created');
  const cancelledId = response.data.id;
  response = await anonymous.request('GET', `/channels/${handle}/schedule`);
  check(response.status === 200 && response.data.items.length === 2 && response.data.items[0].id === first.id, 'Public schedules are readable anonymously in date order');
  check(response.data.items.every(item => Object.keys(item).sort().join(',') === 'at,id,title'), 'Public schedule contains no account or stream credentials');
  response = await anonymous.request('GET', `/channels/${otherHandle}/schedule`);
  check(response.status === 200 && response.data.items.length === 1 && response.data.items[0].title === '다른 채널의 같은 시간', 'Schedule lists stay isolated per channel');
  response = await owner.request('DELETE', '/me/schedules/' + cancelledId);
  check(response.status === 204, 'Owner can cancel a future reservation');
  response = await owner.request('GET', '/me/schedules');
  check(response.data.items.length === 1 && response.data.items[0].id === first.id, 'Private list reflects the cancellation');
  response = await anonymous.request('GET', `/channels/${handle}/schedule`);
  check(response.data.items.length === 1 && response.data.items[0].id === first.id, 'Public list reflects the cancellation');
  response = await anonymous.request('GET', '/channels/nonexistent-channel/schedule');
  check(response.status === 404, 'Missing public channel is a genuine 404');
  await writeFile(checkpoint, JSON.stringify({ owner: owner.saved(), handle, id: first.id, title: edited.title, cancelledId }), { mode: 0o600 });
  await writeFile(join(output, 'schedule-api-result.json'), JSON.stringify({ base, verificationDatabaseOnly: true, results }, null, 2));
  console.log(JSON.stringify({ checks: results.length, passed: results.filter(r => r.pass).length }));
} catch (failure) {
  await writeFile(join(output, 'schedule-api-failure.json'), JSON.stringify({ results, failure: failure.message }, null, 2));
  throw failure;
}
