import { AccountError, accountRequest } from '../account/account-client';

export type ProductReward = { id: string; channelId: string; name: string; points: number; limit: 'once_per_broadcast' | 'unlimited'; enabled: boolean; version: number; createdAtMs: number; updatedAtMs: number };
export type RewardInput = Pick<ProductReward, 'name' | 'points' | 'limit' | 'enabled'> & { clientRequestId: string };
export type RewardUpdateInput = Pick<ProductReward, 'version' | 'name' | 'points' | 'limit' | 'enabled'>;
export type RewardFilters = { status?: 'all' | 'enabled' | 'disabled'; q?: string; from?: string; to?: string; limit?: number; cursor?: string };
export type RewardPageResult = { userId: string; items: ProductReward[]; nextCursor: string | null; serverNowMs: number };
export type RewardDetailResult = { userId: string; item: ProductReward; serverNowMs: number };
export type RedemptionStatus = 'pending' | 'processing' | 'completed' | 'rejected' | 'canceled';
export type ProductRedemption = { id: string; channelId: string; rewardId: string; rewardName: string; points: number; broadcastId: string; path: string;
  user: { channelId: string; handle: string; displayName: string }; note: string; reason: string; status: RedemptionStatus; version: number; createdAtMs: number; updatedAtMs: number };
export type OwnRedemption = ProductRedemption & { clientRequestId: string };
export type RedemptionFilters = { status?: 'all' | RedemptionStatus; q?: string; from?: string; to?: string; limit?: number; cursor?: string };
export type RedemptionPageResult = { userId: string; items: ProductRedemption[]; nextCursor: string | null; serverNowMs: number };
export type RedemptionDetailResult = { userId: string; item: ProductRedemption; serverNowMs: number };
export type RedemptionUpdateInput = { version: number; status: Exclude<RedemptionStatus, 'pending'>; reason: string };
export type RewardView = { userId: string | null; channelId: string | null; rewards: ProductReward[]; balance: number | null; mine: OwnRedemption[]; nextCursor: string | null; usedRewardIds: string[];
  canRedeem: boolean; reason: null | 'login_required' | 'blocked' | 'followers_only' | 'broadcast_unavailable'; serverNowMs: number };
export type RewardRedemptionInput = { broadcastId: string; path: string; note: string; clientRequestId: string; rewardVersion: number };
export type RewardRedemptionResult = { userId: string; item: OwnRedemption; balance: number; serverNowMs: number };
export type PointLedgerItem = { id: string; kind: 'watch' | 'redemption' | 'refund'; delta: number; balanceAfter: number; label: string; redemptionId: string | null; createdAtMs: number };
export type PointLedgerPageResult = { userId: string; channelId: string; balance: number; items: PointLedgerItem[]; nextCursor: string | null; serverNowMs: number };
export type WatchPointInput = { path: string; broadcastId: string; viewerSessionId: string; visitId: string; sequence: number; eligibleMs: number; watching: boolean };
export type WatchPointResult = { userId: string; channelId: string | null; balance: number; pendingWatchMs: number; creditedPoints: number; acceptedMs: number;
  reason: null | 'watching_elsewhere' | 'baseline' | 'stopped' | 'broadcast_unavailable' | 'session_unavailable'; serverNowMs: number };

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, broadcastId = /^[0-9a-f]{32}$/, pathPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const time = (value: unknown): value is number => counter(value) && Number.isFinite(new Date(value).getTime());
const cursor = (value: unknown): value is string | null => value === null || (typeof value === 'string' && Boolean(value) && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value));
const ownerHeaders = (ownerId?: string): Record<string, string> => ownerId ? { 'X-FRAME-USER-ID': ownerId } : {};
function invalid(message = '포인트와 보상 정보를 확인하지 못했어요.'): never { throw new AccountError(message, 'INVALID_RESPONSE', 0); }
function owner(value: unknown, ownerId?: string): { userId: string; serverNowMs: number } {
  const data = value as { userId?: unknown; serverNowMs?: unknown } | null;
  if (!data || !isId(data.userId) || !time(data.serverNowMs)) invalid();
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  return { userId: data.userId, serverNowMs: data.serverNowMs };
}
function reward(value: unknown): ProductReward {
  const data = value as ProductReward | null;
  if (!data || !isId(data.id) || !isId(data.channelId) || typeof data.name !== 'string' || !data.name || [...data.name].length > 40
    || !counter(data.points) || data.points < 1 || data.points > 1000000 || !['once_per_broadcast', 'unlimited'].includes(data.limit)
    || typeof data.enabled !== 'boolean' || !counter(data.version) || !time(data.createdAtMs) || !time(data.updatedAtMs)) invalid();
  return data;
}
function redemption(value: unknown): ProductRedemption {
  const data = value as ProductRedemption | null;
  if (!data || !isId(data.id) || !isId(data.channelId) || !isId(data.rewardId) || typeof data.rewardName !== 'string' || !data.rewardName
    || !counter(data.points) || data.points < 1 || data.points > 1000000 || typeof data.broadcastId !== 'string' || !broadcastId.test(data.broadcastId)
    || typeof data.path !== 'string' || !pathPattern.test(data.path) || !data.user || !isId(data.user.channelId) || typeof data.user.handle !== 'string' || !/^[a-z][a-z0-9_-]{2,23}$/.test(data.user.handle)
    || typeof data.user.displayName !== 'string' || typeof data.note !== 'string' || [...data.note].length > 500 || typeof data.reason !== 'string' || [...data.reason].length > 500
    || !['pending', 'processing', 'completed', 'rejected', 'canceled'].includes(data.status) || !counter(data.version) || !time(data.createdAtMs) || !time(data.updatedAtMs)) invalid();
  return data;
}
function ownRedemption(value: unknown): OwnRedemption { const data = redemption(value) as OwnRedemption; if (!isId(data.clientRequestId)) invalid(); return data; }
function detail<T>(value: unknown, parse: (item: unknown) => T, ownerId?: string) {
  const scope = owner(value, ownerId), data = value as { item?: unknown }; return { ...scope, item: parse(data.item) };
}
function page<T>(value: unknown, parse: (item: unknown) => T, ownerId?: string) {
  const scope = owner(value, ownerId), data = value as { items?: unknown[]; nextCursor?: unknown };
  if (!Array.isArray(data.items) || !cursor(data.nextCursor)) invalid();
  return { ...scope, items: data.items.map(parse), nextCursor: data.nextCursor };
}
function query(filters: Record<string, unknown>) { const result = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') result.set(key, String(value)); return result; }
function redemptionResult(value: unknown, ownerId?: string): RewardRedemptionResult {
  const result = detail(value, ownRedemption, ownerId), data = value as { balance?: unknown }; if (!counter(data.balance)) invalid(); return { ...result, balance: data.balance };
}
function rewardView(value: unknown, binding: { path: string; broadcastId: string }, ownerId?: string): RewardView {
  const data = value as RewardView | null;
  if (!data || (data.userId !== null && !isId(data.userId)) || (data.channelId !== null && !isId(data.channelId)) || !Array.isArray(data.rewards) || data.rewards.length > 50
    || (data.balance !== null && !counter(data.balance)) || !Array.isArray(data.mine) || !cursor(data.nextCursor) || !Array.isArray(data.usedRewardIds) || !data.usedRewardIds.every(isId)
    || typeof data.canRedeem !== 'boolean' || (data.reason !== null && !['login_required', 'blocked', 'followers_only', 'broadcast_unavailable'].includes(data.reason)) || !time(data.serverNowMs)) invalid();
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  const rewards = data.rewards.map(reward), mine = data.mine.map(ownRedemption);
  if (rewards.some(item => !item.enabled || item.channelId !== data.channelId) || mine.some(item => item.path !== binding.path || item.broadcastId !== binding.broadcastId || item.channelId !== data.channelId)
    || new Set(mine.map(item => item.id)).size !== mine.length || new Set(rewards.map(item => item.id)).size !== rewards.length
    || (data.userId === null && (data.balance !== null || mine.length > 0 || data.nextCursor !== null || data.usedRewardIds.length > 0 || data.canRedeem))) invalid();
  return { ...data, rewards, mine };
}
function ledger(value: unknown): PointLedgerItem {
  const data = value as PointLedgerItem | null;
  if (!data || !isId(data.id) || !['watch', 'redemption', 'refund'].includes(data.kind) || !Number.isSafeInteger(data.delta) || data.delta === 0 || !counter(data.balanceAfter)
    || typeof data.label !== 'string' || (data.redemptionId !== null && !isId(data.redemptionId)) || !time(data.createdAtMs)
    || (data.kind === 'redemption' ? data.delta >= 0 : data.delta <= 0)) invalid();
  return data;
}

export const rewardsApi = {
  rewards: async (filters: RewardFilters = {}, signal?: AbortSignal, ownerId?: string): Promise<RewardPageResult> => page(await accountRequest(`/me/rewards?${query(filters)}`, { signal, headers: ownerHeaders(ownerId) }), reward, ownerId),
  reward: async (id: string, signal?: AbortSignal, ownerId?: string): Promise<RewardDetailResult> => detail(await accountRequest(`/me/rewards/${encodeURIComponent(id)}`, { signal, headers: ownerHeaders(ownerId) }), reward, ownerId),
  createReward: async (body: RewardInput, csrf: string, ownerId?: string): Promise<RewardDetailResult> => detail(await accountRequest('/me/rewards', { method: 'POST', body: JSON.stringify(body), headers: ownerHeaders(ownerId) }, csrf), reward, ownerId),
  updateReward: async (id: string, body: RewardUpdateInput, csrf: string, ownerId?: string): Promise<RewardDetailResult> => detail(await accountRequest(`/me/rewards/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body), headers: ownerHeaders(ownerId) }, csrf), reward, ownerId),
  redemptions: async (filters: RedemptionFilters = {}, signal?: AbortSignal, ownerId?: string): Promise<RedemptionPageResult> => page(await accountRequest(`/me/redemptions?${query(filters)}`, { signal, headers: ownerHeaders(ownerId) }), redemption, ownerId),
  redemption: async (id: string, signal?: AbortSignal, ownerId?: string): Promise<RedemptionDetailResult> => detail(await accountRequest(`/me/redemptions/${encodeURIComponent(id)}`, { signal, headers: ownerHeaders(ownerId) }), redemption, ownerId),
  updateRedemption: async (id: string, body: RedemptionUpdateInput, csrf: string, ownerId?: string): Promise<RedemptionDetailResult> => detail(await accountRequest(`/me/redemptions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body), headers: ownerHeaders(ownerId) }, csrf), redemption, ownerId),
  currentRewards: async (binding: { path: string; broadcastId: string }, filters: { limit?: number; cursor?: string } = {}, signal?: AbortSignal, ownerId?: string): Promise<RewardView> => rewardView(await accountRequest(`/rewards/current?${query({ ...binding, ...filters })}`, { signal, headers: ownerHeaders(ownerId) }), binding, ownerId),
  redeemReward: async (id: string, body: RewardRedemptionInput, csrf: string, ownerId?: string): Promise<RewardRedemptionResult> => {
    const result = redemptionResult(await accountRequest(`/rewards/${encodeURIComponent(id)}/redemptions`, { method: 'POST', body: JSON.stringify(body), headers: ownerHeaders(ownerId) }, csrf), ownerId);
    if (result.item.rewardId !== id || result.item.path !== body.path || result.item.broadcastId !== body.broadcastId || result.item.clientRequestId !== body.clientRequestId) invalid(); return result;
  },
  cancelRedemption: async (id: string, version: number, csrf: string, ownerId?: string): Promise<RewardRedemptionResult> => {
    const result = redemptionResult(await accountRequest(`/redemptions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ version }), headers: ownerHeaders(ownerId) }, csrf), ownerId); if (result.item.id !== id) invalid(); return result;
  },
  points: async (channelId: string, filters: { limit?: number; cursor?: string } = {}, signal?: AbortSignal, ownerId?: string): Promise<PointLedgerPageResult> => {
    const value = await accountRequest(`/me/points?${query({ channelId, ...filters })}`, { signal, headers: ownerHeaders(ownerId) }) as PointLedgerPageResult;
    const result = page(value, ledger, ownerId); if (value?.channelId !== channelId || !isId(value.channelId) || !counter(value.balance)) invalid(); return { ...result, channelId: value.channelId, balance: value.balance };
  },
  watchPoints: async (body: WatchPointInput, csrf: string, ownerId?: string, signal?: AbortSignal): Promise<WatchPointResult> => {
    const value = await accountRequest('/points/watch', { method: 'POST', body: JSON.stringify(body), headers: ownerHeaders(ownerId), signal, keepalive: !body.watching }, csrf) as WatchPointResult;
    const scope = owner(value, ownerId);
    if ((value.channelId !== null && !isId(value.channelId)) || !counter(value.balance) || !counter(value.pendingWatchMs) || value.pendingWatchMs >= 60000 || !counter(value.creditedPoints)
      || !counter(value.acceptedMs) || value.acceptedMs > 20000 || (value.reason !== null && !['watching_elsewhere', 'baseline', 'stopped', 'broadcast_unavailable', 'session_unavailable'].includes(value.reason))) invalid();
    return { ...value, ...scope };
  },
};
