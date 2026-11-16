import { AccountError, accountRequest } from '../account/account-client';

export type RecordingStatus = 'ready' | 'recording' | 'ambiguous' | 'missing' | 'corrupt';
export type RecordingFilter = 'all' | RecordingStatus | 'hidden';
export type ProductRecording = {
  id: string; title: string; displayName: string; recordedAtMs: number; durationMs: number | null; sizeBytes: number | null;
  status: RecordingStatus; version: number; hidden: boolean; readyPlayable: boolean; updatedAtMs: number; broadcastId: string; reason: string | null;
};
export type RecordingStorage = { knownFileCount: number; knownSizeBytes: number; availableFileCount: number; availableSizeBytes: number };
export type RecordingPage = { userId: string; items: ProductRecording[]; nextCursor: string | null; storage: RecordingStorage; serverNowMs: number; collectionEnabled: boolean; retentionHours: number };
export type RecordingDetail = { userId: string; item: ProductRecording; serverNowMs: number };
export type RecordingFilters = { status?: RecordingFilter; q?: string; cursor?: string; limit?: number };

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const statuses: RecordingStatus[] = ['ready', 'recording', 'ambiguous', 'missing', 'corrupt'];
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): value is number => counter(value) && Number(value) > 0 && Number.isFinite(new Date(value).getTime());
function invalid(): never { throw new AccountError('녹화 정보를 확인하지 못했어요. 다시 불러와 주세요.', 'INVALID_RESPONSE', 0); }
function scope(value: unknown, owner: string): { userId: string; serverNowMs: number } {
  const data = value as { userId?: unknown; serverNowMs?: unknown } | null;
  if (!data || typeof data.userId !== 'string' || !uuid.test(data.userId) || !timestamp(data.serverNowMs)) invalid();
  if (data.userId !== owner) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  return { userId: data.userId, serverNowMs: data.serverNowMs };
}
function recording(value: unknown): ProductRecording {
  const item = value as ProductRecording | null;
  if (!item || typeof item.id !== 'string' || !uuid.test(item.id) || typeof item.title !== 'string' || [...item.title].length > 1000
    || typeof item.displayName !== 'string' || !item.displayName || [...item.displayName].length > 300
    || !timestamp(item.recordedAtMs) || !timestamp(item.updatedAtMs) || !counter(item.version)
    || (item.durationMs !== null && !counter(item.durationMs)) || (item.sizeBytes !== null && !counter(item.sizeBytes))
    || !statuses.includes(item.status) || typeof item.hidden !== 'boolean' || typeof item.readyPlayable !== 'boolean'
    || (item.readyPlayable && (item.hidden || item.status !== 'ready'))
    || typeof item.broadcastId !== 'string' || !/^[0-9a-f]{32}$/.test(item.broadcastId)
    || (item.reason !== null && (typeof item.reason !== 'string' || [...item.reason].length > 1000))) invalid();
  return item;
}
function detail(value: unknown, id: string, owner: string): RecordingDetail {
  const data = value as { item?: unknown } | null, ownerScope = scope(value, owner);
  const item = recording(data?.item); if (item.id !== id) invalid();
  return { ...ownerScope, item };
}
function query(filters: RecordingFilters) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(name, String(value));
  return params;
}
const ownerHeaders = (owner: string) => ({ 'X-FRAME-USER-ID': owner });

export const recordingsApi = {
  async list(filters: RecordingFilters, owner: string, signal?: AbortSignal): Promise<RecordingPage> {
    const value = await accountRequest(`/me/recordings?${query(filters)}`, { signal, headers: ownerHeaders(owner) });
    const ownerScope = scope(value, owner), data = value as RecordingPage;
    if (!Array.isArray(data.items) || data.items.length > (filters.limit ?? 20)
      || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(data.nextCursor)))
      || typeof data.collectionEnabled !== 'boolean' || !counter(data.retentionHours) || !data.storage
      || !['knownFileCount', 'knownSizeBytes', 'availableFileCount', 'availableSizeBytes'].every(key => counter(data.storage[key as keyof RecordingStorage]))) invalid();
    const items = data.items.map(recording);
    if (new Set(items.map(item => item.id)).size !== items.length) invalid();
    return { ...data, ...ownerScope, items };
  },
  async detail(id: string, owner: string, signal?: AbortSignal): Promise<RecordingDetail> {
    return detail(await accountRequest(`/me/recordings/${encodeURIComponent(id)}`, { signal, headers: ownerHeaders(owner) }), id, owner);
  },
  async setHidden(id: string, version: number, hidden: boolean, csrf: string, owner: string): Promise<RecordingDetail> {
    return detail(await accountRequest(`/me/recordings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ version, hidden }), headers: ownerHeaders(owner) }, csrf), id, owner);
  },
  mediaUrl(id: string, owner: string, download = false): string {
    return `/api/v1/me/recordings/${encodeURIComponent(id)}/media?${new URLSearchParams({ owner, download: download ? '1' : '0' })}`;
  },
};
