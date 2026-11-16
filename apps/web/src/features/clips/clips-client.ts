import { AccountError, accountRequest } from '../account/account-client';

export type ClipChannel = { id: string; handle: string; displayName: string; avatarUrl: string | null };
export type ClipSource = { id: string; title: string; handle: string };
export type PublicClip = { id: string; title: string; description: string; durationMs: number; sizeBytes: number; publishedAtMs: number; channel: ClipChannel; source: ClipSource; startMs: number; endMs: number };
export type OwnerClip = Omit<PublicClip, 'publishedAtMs'> & { publishedAtMs: number | null; sourceVodId: string; clientRequestId: string; status: 'preparing' | 'ready' | 'failed'; visibility: 'public' | 'private'; published: boolean; available: boolean; sourcePublished: boolean; version: number; reason: string | null; createdAtMs: number; updatedAtMs: number };
export type ClipPage = { items: PublicClip[]; nextCursor: string | null; serverNowMs: number };
export type OwnerClipPage = { userId: string; items: OwnerClip[]; nextCursor: string | null; serverNowMs: number; storageEnabled: boolean };
export type OwnerClipDetail = { userId: string; item: OwnerClip | null; serverNowMs: number; storageEnabled: boolean };
export type CreateClip = { sourceVodId: string; startMs: number; endMs: number; title: string; description: string; clientRequestId: string };
type PublicFilters = { q?: string; channel?: string; cursor?: string; limit?: number };
type OwnerFilters = { sourceVodId: string; status?: string; q?: string; cursor?: string; limit?: number };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, handle = /^[a-z][a-z0-9_-]{2,23}$/;
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const time = (v: unknown): v is number => counter(v) && Number(v) > 0 && Number.isFinite(new Date(v).getTime());
function invalid(): never { throw new AccountError('클립 정보를 확인하지 못했어요. 다시 불러와 주세요.', 'INVALID_RESPONSE', 0); }
function item(value: unknown, owned: boolean): PublicClip | OwnerClip {
  const v = value as OwnerClip | null;
  if (!v || typeof v.id !== 'string' || !uuid.test(v.id) || typeof v.title !== 'string' || !v.title.trim() || [...v.title].length > 100
    || typeof v.description !== 'string' || [...v.description].length > 2000 || !counter(v.durationMs) || !v.durationMs || !counter(v.sizeBytes)
    || !counter(v.startMs) || !counter(v.endMs) || v.endMs <= v.startMs || v.endMs - v.startMs < 5000 || v.endMs - v.startMs > 60000
    || (owned ? v.publishedAtMs !== null && !time(v.publishedAtMs) : !time(v.publishedAtMs))
    || !v.channel || typeof v.channel.id !== 'string' || !uuid.test(v.channel.id) || typeof v.channel.handle !== 'string' || !handle.test(v.channel.handle)
    || typeof v.channel.displayName !== 'string' || (v.channel.avatarUrl !== null && typeof v.channel.avatarUrl !== 'string')
    || !v.source || typeof v.source.id !== 'string' || !uuid.test(v.source.id) || typeof v.source.title !== 'string' || typeof v.source.handle !== 'string' || !handle.test(v.source.handle)) invalid();
  if (owned && (typeof v.sourceVodId !== 'string' || v.sourceVodId !== v.source.id || typeof v.clientRequestId !== 'string' || !uuid.test(v.clientRequestId)
    || !['preparing', 'ready', 'failed'].includes(v.status) || !['public', 'private'].includes(v.visibility) || typeof v.published !== 'boolean'
    || typeof v.available !== 'boolean' || typeof v.sourcePublished !== 'boolean' || v.published !== (v.status === 'ready' && v.visibility === 'public' && v.available && v.sourcePublished)
    || !counter(v.version) || !time(v.createdAtMs) || !time(v.updatedAtMs) || (v.reason !== null && typeof v.reason !== 'string'))) invalid();
  return v;
}
function cursor(value: unknown) { if (value !== null && (typeof value !== 'string' || !value || value.length > 2048)) invalid(); }
function owner(value: unknown, expected: string): OwnerClipDetail {
  const v = value as OwnerClipDetail | null;
  if (!v || typeof v.userId !== 'string' || !uuid.test(v.userId)) invalid();
  if (v.userId !== expected) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  if (!time(v.serverNowMs) || typeof v.storageEnabled !== 'boolean') invalid();
  return v;
}
function ownDetail(value: unknown, expected: string, id?: string, requestId?: string) {
  const data = owner(value, expected), parsed = data.item === null ? null : item(data.item, true) as OwnerClip;
  if (id && parsed?.id !== id || requestId && parsed && parsed.clientRequestId !== requestId) invalid();
  return { ...data, item: parsed };
}
function params(filters: Record<string, string | number | undefined>) { const p = new URLSearchParams(); for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') p.set(k, String(v)); return p; }
async function publicRequest(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch('/api/v1' + path, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]) }); }
  catch (failure) { if (signal?.aborted) throw failure; throw new AccountError('클립에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', 'NETWORK_ERROR', 0); }
  let body: unknown; try { body = await response.json(); } catch { body = null; }
  if (!response.ok) { const p = body as { detail?: unknown; code?: unknown } | null; throw new AccountError(typeof p?.detail === 'string' ? p.detail.slice(0, 300) : '클립을 불러오지 못했어요.', typeof p?.code === 'string' ? p.code : 'REQUEST_FAILED', response.status); }
  return body;
}
export const clipsApi = {
  async list(filters: PublicFilters = {}, signal?: AbortSignal): Promise<ClipPage> {
    const data = await publicRequest('/clips?' + params(filters), signal) as ClipPage;
    if (!data || !time(data.serverNowMs) || !Array.isArray(data.items) || data.items.length > (filters.limit ?? 20)) invalid(); cursor(data.nextCursor);
    const items = data.items.map(v => item(v, false) as PublicClip); if (new Set(items.map(v => v.id)).size !== items.length) invalid(); return { ...data, items };
  },
  async detail(id: string, signal?: AbortSignal) { const data = await publicRequest('/clips/' + encodeURIComponent(id), signal) as { item: PublicClip; serverNowMs: number }; if (!data || !time(data.serverNowMs)) invalid(); const parsed = item(data.item, false) as PublicClip; if (parsed.id !== id) invalid(); return { ...data, item: parsed }; },
  mediaUrl(id: string) { return '/api/v1/clips/' + encodeURIComponent(id) + '/media'; },
  async ownedList(filters: OwnerFilters, expected: string, signal?: AbortSignal): Promise<OwnerClipPage> {
    const data = await accountRequest('/me/clips?' + params(filters), { signal, headers: { 'X-FRAME-USER-ID': expected } }) as OwnerClipPage;
    owner(data, expected); if (!Array.isArray(data.items) || data.items.length > (filters.limit ?? 20)) invalid(); cursor(data.nextCursor);
    const items = data.items.map(v => item(v, true) as OwnerClip); if (items.some(v => v.sourceVodId !== filters.sourceVodId) || new Set(items.map(v => v.id)).size !== items.length) invalid(); return { ...data, items };
  },
  async owned(id: string, expected: string, signal?: AbortSignal) { return ownDetail(await accountRequest('/me/clips/' + encodeURIComponent(id), { signal, headers: { 'X-FRAME-USER-ID': expected } }), expected, id); },
  async receipt(requestId: string, expected: string, signal?: AbortSignal) { return ownDetail(await accountRequest('/me/clips/by-request/' + encodeURIComponent(requestId), { signal, headers: { 'X-FRAME-USER-ID': expected } }), expected, undefined, requestId); },
  async create(input: CreateClip, expected: string, csrf: string) { const result = ownDetail(await accountRequest('/me/clips', { method: 'POST', headers: { 'X-FRAME-USER-ID': expected }, body: JSON.stringify(input) }, csrf), expected, undefined, input.clientRequestId); if (!result.item || result.item.sourceVodId !== input.sourceVodId || result.item.startMs !== input.startMs || result.item.endMs !== input.endMs) invalid(); return result; },
  async update(id: string, input: { version: number; title: string; description: string; visibility: 'public' | 'private' }, expected: string, csrf: string) { return ownDetail(await accountRequest('/me/clips/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'X-FRAME-USER-ID': expected }, body: JSON.stringify(input) }, csrf), expected, id); },
  async retry(id: string, version: number, expected: string, csrf: string) { return ownDetail(await accountRequest('/me/clips/' + encodeURIComponent(id) + '/retry', { method: 'POST', headers: { 'X-FRAME-USER-ID': expected }, body: JSON.stringify({ version }) }, csrf), expected, id); },
};
