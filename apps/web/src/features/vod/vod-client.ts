import { AccountError, accountRequest } from '../account/account-client';

export type VodChannel = { id: string; handle: string; displayName: string; avatarUrl: string | null };
export type PublicVod = { id: string; title: string; description: string; durationMs: number; sizeBytes: number; publishedAtMs: number; channel: VodChannel };
export type OwnerVod = Omit<PublicVod, 'publishedAtMs'> & { publishedAtMs: number | null; recordingId: string | null; status: 'preparing' | 'ready' | 'failed'; visibility: 'public' | 'private'; published: boolean; available: boolean; version: number; reason: string | null; createdAtMs: number; updatedAtMs: number };
export type VodPage = { items: PublicVod[]; nextCursor: string | null; serverNowMs: number };
export type VodDetail = { item: PublicVod; serverNowMs: number };
export type OwnerVodDetail = { userId: string; item: OwnerVod | null; serverNowMs: number; storageEnabled: boolean };
export type VodFilters = { q?: string; channel?: string; cursor?: string; limit?: number };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const time = (v: unknown): v is number => counter(v) && Number(v) > 0 && Number.isFinite(new Date(v).getTime());
function invalid(): never { throw new AccountError('다시보기 정보를 확인하지 못했어요. 다시 불러와 주세요.', 'INVALID_RESPONSE', 0); }
function parseItem(value: unknown, owned: boolean): PublicVod | OwnerVod {
  const v = value as OwnerVod | null;
  if (!v || typeof v.id !== 'string' || !uuid.test(v.id) || typeof v.title !== 'string' || !v.title.trim() || [...v.title].length > 100
    || typeof v.description !== 'string' || [...v.description].length > 2000 || !counter(v.durationMs) || !counter(v.sizeBytes)
    || (owned ? v.publishedAtMs !== null && !time(v.publishedAtMs) : !time(v.publishedAtMs))
    || !v.channel || typeof v.channel.id !== 'string' || !uuid.test(v.channel.id) || typeof v.channel.handle !== 'string' || !/^[a-z][a-z0-9_-]{2,23}$/.test(v.channel.handle)
    || typeof v.channel.displayName !== 'string' || (v.channel.avatarUrl !== null && typeof v.channel.avatarUrl !== 'string')) invalid();
  if (owned && ((v.recordingId !== null && (typeof v.recordingId !== 'string' || !uuid.test(v.recordingId)))
    || !['preparing', 'ready', 'failed'].includes(v.status) || !['public', 'private'].includes(v.visibility) || typeof v.published !== 'boolean' || typeof v.available !== 'boolean'
    || v.published !== (v.status === 'ready' && v.visibility === 'public' && v.available) || !counter(v.version) || !time(v.createdAtMs) || !time(v.updatedAtMs)
    || (v.reason !== null && (typeof v.reason !== 'string' || [...v.reason].length > 1000)))) invalid();
  return v;
}
function publicDetail(value: unknown, id: string): VodDetail {
  const data = value as VodDetail | null; if (!data || !time(data.serverNowMs)) invalid();
  const item = parseItem(data.item, false) as PublicVod; if (item.id !== id) invalid(); return { item, serverNowMs: data.serverNowMs };
}
function ownerDetail(value: unknown, owner: string, id?: string, recordingId?: string): OwnerVodDetail {
  const data = value as OwnerVodDetail | null;
  if (!data || typeof data.userId !== 'string' || !uuid.test(data.userId)) invalid();
  if (data.userId !== owner) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  if (!time(data.serverNowMs) || typeof data.storageEnabled !== 'boolean') invalid();
  const item = data.item === null ? null : parseItem(data.item, true) as OwnerVod;
  if ((id && (!item || item.id !== id)) || (recordingId && item && item.recordingId !== recordingId)) invalid();
  return { ...data, item };
}
async function publicRequest(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch('/api/v1' + path, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]) }); }
  catch (failure) { if (signal?.aborted) throw failure; throw new AccountError('다시보기에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', 'NETWORK_ERROR', 0); }
  let body: unknown; try { body = await response.json(); } catch { body = null; }
  if (!response.ok) { const p = body as { detail?: unknown; code?: unknown } | null; throw new AccountError(typeof p?.detail === 'string' ? p.detail.slice(0, 300) : '다시보기를 불러오지 못했어요.', typeof p?.code === 'string' ? p.code : 'REQUEST_FAILED', response.status); }
  return body;
}
export const vodApi = {
  async list(filters: VodFilters = {}, signal?: AbortSignal): Promise<VodPage> {
    const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
    const data = await publicRequest('/vods?' + params, signal) as VodPage;
    if (!data || !time(data.serverNowMs) || !Array.isArray(data.items) || data.items.length > (filters.limit ?? 20)
      || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 2048))) invalid();
    const items = data.items.map(item => parseItem(item, false) as PublicVod); if (new Set(items.map(item => item.id)).size !== items.length) invalid(); return { ...data, items };
  },
  async detail(id: string, signal?: AbortSignal) { return publicDetail(await publicRequest('/vods/' + encodeURIComponent(id), signal), id); },
  mediaUrl(id: string) { return '/api/v1/vods/' + encodeURIComponent(id) + '/media'; },
  async forRecording(recordingId: string, owner: string, signal?: AbortSignal) { return ownerDetail(await accountRequest('/me/vods/by-recording/' + encodeURIComponent(recordingId), { signal, headers: { 'X-FRAME-USER-ID': owner } }), owner, undefined, recordingId); },
  async owned(id: string, owner: string, signal?: AbortSignal) { return ownerDetail(await accountRequest('/me/vods/' + encodeURIComponent(id), { signal, headers: { 'X-FRAME-USER-ID': owner } }), owner, id); },
  async publish(input: { recordingId: string; title: string; description: string }, owner: string, csrf: string) { return ownerDetail(await accountRequest('/me/vods', { method: 'POST', headers: { 'X-FRAME-USER-ID': owner }, body: JSON.stringify(input) }, csrf), owner, undefined, input.recordingId); },
  async update(id: string, input: { version: number; title: string; description: string; visibility: 'public' | 'private' }, owner: string, csrf: string) { return ownerDetail(await accountRequest('/me/vods/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'X-FRAME-USER-ID': owner }, body: JSON.stringify(input) }, csrf), owner, id); },
  async retry(id: string, version: number, owner: string, csrf: string) { return ownerDetail(await accountRequest('/me/vods/' + encodeURIComponent(id) + '/retry', { method: 'POST', headers: { 'X-FRAME-USER-ID': owner }, body: JSON.stringify({ version }) }, csrf), owner, id); },
};
