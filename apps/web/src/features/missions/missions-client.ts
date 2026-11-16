import { AccountError, accountRequest } from '../account/account-client';

export type MissionStatus = 'received' | 'running' | 'completed' | 'rejected' | 'canceled' | 'expired' | 'failed';
export type MissionHistory = { id: string; status: MissionStatus; reason: string; actor: 'viewer' | 'owner' | 'system'; createdAtMs: number };
export type ProductMission = {
  id: string; channelId: string; broadcastId: string; path: string; title: string; description: string;
  durationMinutes: 15 | 30 | 60; deadlineAtMs: number; status: MissionStatus; reason: string; version: number;
  createdAtMs: number; updatedAtMs: number; broadcastActive: boolean;
  author: { channelId: string; handle: string; displayName: string }; history: MissionHistory[];
};
export type OwnMission = ProductMission & { clientRequestId: string };
export type MissionFilters = { status?: 'all' | MissionStatus; q?: string; from?: string; to?: string; limit?: number; cursor?: string };
export type MissionPageResult = { userId: string; items: ProductMission[]; nextCursor: string | null; serverNowMs: number };
export type MissionDetailResult = { userId: string; item: ProductMission; serverNowMs: number };
export type MissionUpdateInput = { version: number; status: Exclude<MissionStatus, 'received' | 'expired'>; reason: string };
export type MissionSubmitInput = { path: string; broadcastId: string; title: string; description: string; durationMinutes: 15 | 30 | 60; clientRequestId: string };
export type MissionSubmitResult = { userId: string; item: OwnMission; serverNowMs: number };
export type MissionView = {
  userId: string | null; mine: OwnMission[]; nextCursor: string | null; canSubmit: boolean;
  reason: null | 'login_required' | 'blocked' | 'followers_only' | 'broadcast_unavailable' | 'rate_limited'; retryAfterMs: number | null; serverNowMs: number;
};

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, broadcastPattern = /^[0-9a-f]{32}$/, pathPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const statuses: MissionStatus[] = ['received', 'running', 'completed', 'rejected', 'canceled', 'expired', 'failed'];
const isId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const time = (value: unknown): value is number => counter(value) && Number.isFinite(new Date(value).getTime());
const cursor = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value));
const ownerHeaders = (ownerId?: string): Record<string, string> => ownerId ? { 'X-FRAME-USER-ID': ownerId } : {};
function invalid(): never { throw new AccountError('미션 정보를 확인하지 못했어요. 다시 불러와 주세요.', 'INVALID_RESPONSE', 0); }
function owner(value: unknown, ownerId?: string) {
  const data = value as { userId?: unknown; serverNowMs?: unknown } | null;
  if (!data || !isId(data.userId) || !time(data.serverNowMs)) invalid();
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  return { userId: data.userId, serverNowMs: data.serverNowMs };
}
function history(value: unknown): MissionHistory {
  const data = value as MissionHistory | null;
  if (!data || !isId(data.id) || !statuses.includes(data.status) || typeof data.reason !== 'string' || [...data.reason].length > 500
    || !['viewer', 'owner', 'system'].includes(data.actor) || !time(data.createdAtMs)) invalid();
  return data;
}
function mission(value: unknown): ProductMission {
  const data = value as ProductMission | null;
  if (!data || !isId(data.id) || !isId(data.channelId) || typeof data.broadcastId !== 'string' || !broadcastPattern.test(data.broadcastId)
    || typeof data.path !== 'string' || !pathPattern.test(data.path) || typeof data.title !== 'string' || !data.title.trim() || [...data.title].length > 100
    || typeof data.description !== 'string' || [...data.description].length > 1000 || ![15, 30, 60].includes(data.durationMinutes) || !time(data.deadlineAtMs)
    || !statuses.includes(data.status) || typeof data.reason !== 'string' || [...data.reason].length > 500 || !counter(data.version)
    || !time(data.createdAtMs) || !time(data.updatedAtMs) || typeof data.broadcastActive !== 'boolean' || !data.author || !isId(data.author.channelId)
    || typeof data.author.handle !== 'string' || !/^[a-z][a-z0-9_-]{2,23}$/.test(data.author.handle) || typeof data.author.displayName !== 'string'
    || !Array.isArray(data.history) || data.history.length < 1 || data.history.length > 3) invalid();
  const entries = data.history.map(history);
  if (new Set(entries.map(item => item.id)).size !== entries.length || entries.at(-1)?.status !== data.status) invalid();
  return { ...data, history: entries };
}
function ownMission(value: unknown): OwnMission { const data = mission(value) as OwnMission; if (!isId(data.clientRequestId)) invalid(); return data; }
function detail<T>(value: unknown, parse: (item: unknown) => T, ownerId?: string) {
  const scope = owner(value, ownerId), data = value as { item?: unknown }; return { ...scope, item: parse(data.item) };
}
function query(filters: Record<string, unknown>) { const result = new URLSearchParams(); for (const [name, value] of Object.entries(filters)) if (value !== undefined && value !== '') result.set(name, String(value)); return result; }
function current(value: unknown, binding: { path: string; broadcastId: string }, ownerId?: string): MissionView {
  const data = value as MissionView | null;
  if (!data || (data.userId !== null && !isId(data.userId)) || !Array.isArray(data.mine) || !cursor(data.nextCursor) || typeof data.canSubmit !== 'boolean'
    || (data.reason !== null && !['login_required', 'blocked', 'followers_only', 'broadcast_unavailable', 'rate_limited'].includes(data.reason))
    || (data.retryAfterMs !== null && !counter(data.retryAfterMs)) || !time(data.serverNowMs)) invalid();
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  const mine = data.mine.map(ownMission);
  if (mine.some(item => item.path !== binding.path || item.broadcastId !== binding.broadcastId) || new Set(mine.map(item => item.id)).size !== mine.length
    || (data.userId === null && (mine.length > 0 || data.nextCursor !== null || data.canSubmit))) invalid();
  return { ...data, mine };
}

export const missionsApi = {
  missions: async (filters: MissionFilters = {}, signal?: AbortSignal, ownerId?: string): Promise<MissionPageResult> => {
    const value = await accountRequest(`/me/missions?${query(filters)}`, { signal, headers: ownerHeaders(ownerId) }) as { items?: unknown[]; nextCursor?: unknown };
    const scope = owner(value, ownerId); if (!Array.isArray(value.items) || !cursor(value.nextCursor)) invalid();
    const items = value.items.map(mission); if (new Set(items.map(item => item.id)).size !== items.length) invalid();
    return { ...scope, items, nextCursor: value.nextCursor };
  },
  mission: async (id: string, signal?: AbortSignal, ownerId?: string): Promise<MissionDetailResult> => {
    const result = detail(await accountRequest(`/me/missions/${encodeURIComponent(id)}`, { signal, headers: ownerHeaders(ownerId) }), mission, ownerId); if (result.item.id !== id) invalid(); return result;
  },
  updateMission: async (id: string, input: MissionUpdateInput, csrf: string, ownerId?: string): Promise<MissionDetailResult> => {
    const result = detail(await accountRequest(`/me/missions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input), headers: ownerHeaders(ownerId) }, csrf), mission, ownerId); if (result.item.id !== id) invalid(); return result;
  },
  currentMissions: async (binding: { path: string; broadcastId: string }, filters: { limit?: number; cursor?: string } = {}, signal?: AbortSignal, ownerId?: string): Promise<MissionView> =>
    current(await accountRequest(`/missions/current?${query({ ...binding, ...filters })}`, { signal, headers: ownerHeaders(ownerId) }), binding, ownerId),
  submitMission: async (input: MissionSubmitInput, csrf: string, ownerId?: string): Promise<MissionSubmitResult> => {
    const result = detail(await accountRequest('/missions', { method: 'POST', body: JSON.stringify(input), headers: ownerHeaders(ownerId) }, csrf), ownMission, ownerId);
    if (result.item.path !== input.path || result.item.broadcastId !== input.broadcastId || result.item.clientRequestId !== input.clientRequestId) invalid(); return result;
  },
  cancelMission: async (id: string, version: number, csrf: string, ownerId?: string): Promise<MissionSubmitResult> => {
    const result = detail(await accountRequest(`/missions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ version }), headers: ownerHeaders(ownerId) }, csrf), ownMission, ownerId); if (result.item.id !== id) invalid(); return result;
  },
};
