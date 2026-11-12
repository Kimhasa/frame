// Verification-only product HTTP client. Cookies and CSRF credentials stay in private memory/checkpoints.
import { sleep } from '../../tools/cdp.mjs';
export const api = 'http://127.0.0.1:18083', origin = 'http://127.0.0.1:5365';
export class Client {
  constructor(saved) { this.cookies = new Map(saved?.cookies?.map(({ name, value }) => [name, value]) ?? []); this.csrf = saved?.csrfToken ?? ''; this.userId = saved?.userId ?? null; }
  async request(method, route, body, options = {}) {
    const headers = { Accept: 'application/json', Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
    const expected = options.expectedUserId ?? this.userId;
    if (expected) headers['X-FRAME-USER-ID'] = expected;
    if (method !== 'GET') { headers.Origin = options.origin ?? origin; if (this.csrf && options.csrf !== false) headers['X-CSRF-TOKEN'] = this.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + '/api/v1' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'manual' });
    for (const raw of response.headers.getSetCookie()) {
      const first = raw.split(';')[0], split = first.indexOf('='), name = first.slice(0, split), value = first.slice(split + 1);
      if (/max-age=0(?:;|$)/i.test(raw) || !value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    let data; try { data = await response.json(); } catch { data = null; }
    if (typeof data?.csrfToken === 'string') this.csrf = data.csrfToken;
    if (typeof data?.user?.id === 'string') this.userId = data.user.id;
    return { status: response.status, data, headers: response.headers };
  }
  saved() { return { cookies: [...this.cookies].map(([name, value]) => ({ name, value })), csrfToken: this.csrf, userId: this.userId }; }
}
export async function liveBroadcast(path, previousId) {
  for (let i = 0; i < 120; i++) {
    const response = await fetch(api + '/api/broadcasts', { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) {
      const body = await response.json(), item = body.items?.find(value => value.path === path && value.id !== previousId && /^[0-9a-f]{32}$/.test(value.id));
      if (item) return item;
    }
    await sleep(250);
  }
  throw Error('The actual isolated poll source did not register its expected broadcast.');
}
