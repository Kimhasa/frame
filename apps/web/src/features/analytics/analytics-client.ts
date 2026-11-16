import { AccountError, accountRequest } from '../account/account-client';

export type AnalyticsMetrics = {
  broadcastCount: number;
  broadcastDurationMs: number;
  observedDurationMs: number;
  averageConcurrent: number | null;
  peakConcurrent: number | null;
};
export type AnalyticsDay = AnalyticsMetrics & { date: string };
export type AnalyticsBroadcast = Omit<AnalyticsMetrics, 'broadcastCount'> & {
  id: string;
  broadcastId: string;
  path: string;
  title: string;
  startedAtMs: number;
  lastObservedAtMs: number;
  endedAtMs: number | null;
  status: 'live' | 'ended' | 'interrupted';
  endReason: string | null;
};
export type AnalyticsResult = {
  userId: string;
  periodDays: 7 | 30;
  fromDate: string;
  toDate: string;
  serverNowMs: number;
  collectionStartedAtMs: number | null;
  summary: AnalyticsMetrics;
  daily: AnalyticsDay[];
  items: AnalyticsBroadcast[];
  nextCursor: string | null;
};
export type AnalyticsFilters = { period: 7 | 30; q?: string; from?: string; to?: string; cursor?: string; limit?: number };

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const isCounter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isTime = (value: unknown): value is number => isCounter(value) && Number.isFinite(new Date(value).getTime());
export function isAnalyticsDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function invalid(): never { throw new AccountError('방송 통계를 확인하지 못했어요. 다시 불러와 주세요.', 'INVALID_RESPONSE', 0); }
function metrics(value: unknown, includeCount: boolean): void {
  const data = value as AnalyticsMetrics | null;
  if (!data || (includeCount && !isCounter(data.broadcastCount)) || !isCounter(data.broadcastDurationMs)
    || !isCounter(data.observedDurationMs) || data.observedDurationMs > data.broadcastDurationMs
    || (data.averageConcurrent !== null && (typeof data.averageConcurrent !== 'number' || !Number.isFinite(data.averageConcurrent) || data.averageConcurrent < 0))
    || (data.peakConcurrent !== null && !isCounter(data.peakConcurrent))
    || (data.averageConcurrent !== null && (data.peakConcurrent === null || data.averageConcurrent > data.peakConcurrent + .001))) invalid();
}
function parse(value: unknown, filters: AnalyticsFilters, ownerId: string): AnalyticsResult {
  const data = value as AnalyticsResult | null;
  if (!data || typeof data.userId !== 'string' || !uuid.test(data.userId)) invalid();
  if (data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  if (data.periodDays !== filters.period || !isAnalyticsDate(data.fromDate) || !isAnalyticsDate(data.toDate) || data.fromDate > data.toDate
    || (filters.from && data.fromDate !== filters.from) || (filters.to && data.toDate !== filters.to)
    || !isTime(data.serverNowMs) || (data.collectionStartedAtMs !== null && !isTime(data.collectionStartedAtMs))
    || !Array.isArray(data.daily) || data.daily.length < 1 || data.daily.length > filters.period
    || !Array.isArray(data.items) || data.items.length > (filters.limit ?? 20)
    || (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(data.nextCursor)))) invalid();
  metrics(data.summary, true);
  data.daily.forEach((day, index) => {
    metrics(day, true);
    const expected = new Date(`${data.fromDate}T00:00:00Z`); expected.setUTCDate(expected.getUTCDate() + index);
    if (!isAnalyticsDate(day.date) || day.date !== expected.toISOString().slice(0, 10)) invalid();
  });
  if (data.daily.at(-1)?.date !== data.toDate) invalid();
  data.items.forEach(item => {
    metrics(item, false);
    if (!item || typeof item.id !== 'string' || !uuid.test(item.id) || typeof item.broadcastId !== 'string' || !/^[0-9a-f]{32}$/.test(item.broadcastId)
      || typeof item.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.path) || typeof item.title !== 'string' || [...item.title].length > 1000
      || !isTime(item.startedAtMs) || !isTime(item.lastObservedAtMs) || item.startedAtMs > item.lastObservedAtMs
      || (item.endedAtMs !== null && (!isTime(item.endedAtMs) || item.endedAtMs < item.startedAtMs))
      || !['live', 'ended', 'interrupted'].includes(item.status) || (item.endReason !== null && typeof item.endReason !== 'string')) invalid();
  });
  if (new Set(data.items.map(item => item.id)).size !== data.items.length) invalid();
  return data;
}

export const analyticsApi = {
  async overview(filters: AnalyticsFilters, ownerId: string, signal?: AbortSignal): Promise<AnalyticsResult> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(name, String(value));
    const result = await accountRequest(`/me/analytics?${query}`, { signal, headers: { 'X-FRAME-USER-ID': ownerId } });
    return parse(result, filters, ownerId);
  },
};
