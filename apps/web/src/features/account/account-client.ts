import type { BroadcastSummary } from '../../viewer-contract';

export const channelCategories = ['개발·작업', '게임', '일상·이야기', '디자인·창작', '지식·탐색'] as const;
export type BannerPreset = 'studio' | 'forest' | 'city' | null;
export type ChannelLink = { title: string; url: string };
export type ProductChannel = {
  id: string; handle: string; displayName: string; description: string; notice: string; category: string;
  avatarUrl: string | null; bannerUrl: string | null; bannerPreset: BannerPreset;
  followerCount: number; following: boolean; notificationsOn: boolean; liveBroadcast: BroadcastSummary | null;
  createdAtMs: number; countryCode: string | null; links: ChannelLink[];
  videoCount: number | null; totalViewCount: number | null;
};
export type AccountSession = { user: { id: string; email: string; displayName: string; isOperator: boolean } | null; channel: ProductChannel | null; csrfToken: string };
export type Registration = { email: string; password: string; displayName: string; termsAccepted: boolean; privacyAccepted: boolean; termsVersion: string; privacyVersion: string };
export type AccountPolicy = { version: string; title: string; required: true; sections: { heading: string; paragraphs: string[] }[] };
export type AccountPolicies = { terms: AccountPolicy; privacy: AccountPolicy };
export type ChannelChanges = Pick<ProductChannel, 'displayName' | 'description' | 'notice' | 'category' | 'bannerPreset' | 'handle' | 'countryCode' | 'links'>;
export type ChannelReportReceipt = { id: string; status: 'received'; createdAtMs: number };
export type OperatorReportStatus = 'received' | 'reviewing' | 'resolved' | 'dismissed';
export type OperatorReportReason = 'spam' | 'impersonation' | 'harassment' | 'inappropriate' | 'other';
export type OperatorReportItem = {
  id: string; status: OperatorReportStatus; reason: OperatorReportReason; details: string;
  createdAtMs: number; updatedAtMs: number; version: number;
  channel: { id: string; handle: string; displayName: string }; reporter: { id: string; displayName: string };
};
export type OperatorReportDetail = OperatorReportItem & { reviewNote: string; reviewedBy: { id: string; displayName: string } | null };
export type OperatorReportFilters = { status?: 'all' | OperatorReportStatus; reason?: 'all' | OperatorReportReason; q?: string; limit?: number; cursor?: string };
export type OperatorReportPageResult = { items: OperatorReportItem[]; nextCursor: string | null };
export type ScheduledBroadcast = { id: string; title: string; at: number };
export type ScheduleChanges = Pick<ScheduledBroadcast, 'title' | 'at'>;
type HistoryItemBase = {
  id: string; title: string; publisher: string; channelHandle: string | null; thumbnailUrl: string | null;
  watchedAtMs: number; available: boolean; completed: boolean; version: number;
};
export type WatchHistoryItem = HistoryItemBase & (
  { kind: 'live'; broadcastId: string; path: string; mediaId: null; durationMs: null; positionMs: null }
  | { kind: 'vod' | 'clip'; broadcastId: null; path: null; mediaId: string; durationMs: number; positionMs: number }
);
export type HistoryFilters = { kind?: 'all' | 'live' | 'vod' | 'clip'; q?: string; from?: string; to?: string; cursor?: string; limit?: number };
export type HistoryPageResult = { userId: string; items: WatchHistoryItem[]; nextCursor: string | null };
export type ProductNotification = {
  id: string; title: string; body: string; createdAtMs: number; readAtMs: number | null;
} & ({ kind: 'live'; target: { channelId: string; channelHandle: string; broadcastId: string; path: string; available: boolean }; report: null }
  | { kind: 'report'; target: null; report: { id: string; status: 'resolved' | 'dismissed' } });
export type NotificationFilters = { filter?: 'all' | 'unread'; kind?: 'all' | 'live' | 'report'; limit?: number; cursor?: string };
export type NotificationPageResult = { items: ProductNotification[]; nextCursor: string | null; unreadCount: number; userId: string };
export type NotificationUnreadCount = { unreadCount: number; userId: string };
export type ChatModerationSettings = {
  userId: string; channelId: string; version: number; updatedAtMs: number;
  slowMode: boolean; slowSeconds: number; followersOnly: boolean; blockLinks: boolean; bannedWords: string[];
};
export type ChatModerationSettingsInput = Pick<ChatModerationSettings, 'version' | 'slowMode' | 'slowSeconds' | 'followersOnly' | 'blockLinks' | 'bannedWords'>;
export type ChatModerationBlock = {
  id: string; targetChannelId: string; displayName: string; handle: string; reason: string;
  createdAtMs: number; expiresAtMs: number | null; version: number;
};
export type ChatModerationBlockPageResult = { userId: string; items: ChatModerationBlock[]; nextCursor: string | null };
export type ChatModerationBlockFilters = { status?: 'active' | 'all' | 'expired'; q?: string; cursor?: string; limit?: number };
export type ChatTicket = { ticket: string; expiresAtMs: number; userId: string; displayName: string };
export type ProductPoll = {
  id: string; channelId: string; broadcastId: string; path: string; question: string; createdAtMs: number; endsAtMs: number;
  status: 'active' | 'closed'; closeReason: null | 'manual' | 'expired' | 'broadcast_ended'; version: number;
  options: { id: string; text: string; votes: number }[]; totalVotes: number; myOptionId: string | null;
};
export type PollFilters = { status?: 'all' | 'active' | 'closed'; q?: string; from?: string; to?: string; limit?: number; cursor?: string };
export type PollCreateInput = { question: string; options: string[]; durationSeconds: 60 | 180 | 300 | 600; broadcastId: string; path: string };
export type PollPageResult = { userId: string; items: ProductPoll[]; nextCursor: string | null; currentBroadcast: { id: string; path: string; title: string } | null; activePollId: string | null; serverNowMs: number };
export type PollDetailResult = { userId: string; poll: ProductPoll; serverNowMs: number };
export type PollView = { userId: string | null; poll: ProductPoll | null; canVote: boolean;
  reason: null | 'login_required' | 'blocked' | 'followers_only' | 'already_voted' | 'closed' | 'broadcast_unavailable'; serverNowMs: number };
export type ProductQuestion = {
  id: string; channelId: string; broadcastId: string; path: string; text: string;
  author: { channelId: string; handle: string; displayName: string }; answer: string | null; answeredAtMs: number | null;
  pinned: boolean; broadcastActive: boolean; version: number; createdAtMs: number; updatedAtMs: number;
};
export type OwnQuestion = ProductQuestion & { clientRequestId: string };
export type QuestionFilters = { status?: 'all' | 'waiting' | 'answered'; q?: string; from?: string; to?: string; limit?: number; cursor?: string };
export type QuestionPageResult = { userId: string; items: ProductQuestion[]; nextCursor: string | null; currentBroadcast: { id: string; path: string; title: string } | null; pinnedQuestionId: string | null; serverNowMs: number };
export type QuestionDetailResult = { userId: string; item: ProductQuestion; serverNowMs: number };
export type QuestionUpdateInput = { version: number; answer?: string; pinned?: boolean };
export type QuestionSubmitInput = { path: string; broadcastId: string; text: string; clientRequestId: string };
export type QuestionSubmitResult = { userId: string; item: OwnQuestion; serverNowMs: number };
export type QuestionView = { userId: string | null; pinned: ProductQuestion | null; mine: OwnQuestion[]; nextCursor: string | null; canSubmit: boolean;
  reason: null | 'login_required' | 'blocked' | 'followers_only' | 'broadcast_unavailable' | 'rate_limited'; retryAfterMs: number | null; serverNowMs: number };

export class AccountError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly retryAfterMs?: number) { super(message); this.name = 'AccountError'; }
}

async function request(path: string, options: RequestInit = {}, csrfToken?: string): Promise<unknown> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') {
    if (!csrfToken) throw new AccountError('로그인 정보를 다시 확인해 주세요.', 'SESSION_REQUIRED', 401);
    headers.set('X-CSRF-TOKEN', csrfToken);
  }
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: options.credentials ?? 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15000)]) });
  } catch (failure) {
    if (options.signal?.aborted) throw failure;
    throw new AccountError('서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', 'NETWORK_ERROR', 0);
  }
  if (response.status === 204) return null;
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const problem = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const retryAfter = response.headers.get('Retry-After'), retryAfterMs = retryAfter && /^\d{1,6}$/.test(retryAfter) && Number(retryAfter) <= 86400 ? Number(retryAfter) * 1000 : undefined;
    throw new AccountError(typeof problem.detail === 'string' ? problem.detail.slice(0, 300) : '요청을 처리하지 못했어요. 다시 시도해 주세요.',
      typeof problem.code === 'string' ? problem.code : 'REQUEST_FAILED', response.status, retryAfterMs);
  }
  return body;
}

function validLink(value: unknown): value is ChannelLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as ChannelLink;
  if (typeof link.title !== 'string' || !link.title.trim() || [...link.title].length > 50
    || typeof link.url !== 'string' || !link.url || link.url.length > 500 || /[\u0000-\u0020\u007f]/.test(link.url)) return false;
  try { const url = new URL(link.url); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}
function channel(value: unknown): ProductChannel {
  const data = value as ProductChannel | null;
  if (!data || typeof data.id !== 'string' || typeof data.handle !== 'string' || typeof data.displayName !== 'string'
    || !/^[a-z][a-z0-9_-]{2,23}$/.test(data.handle)
    || typeof data.description !== 'string' || typeof data.notice !== 'string' || typeof data.category !== 'string'
    || !Number.isSafeInteger(data.followerCount) || data.followerCount < 0 || typeof data.following !== 'boolean' || typeof data.notificationsOn !== 'boolean'
    || !Number.isSafeInteger(data.createdAtMs) || data.createdAtMs < 0 || !Number.isFinite(new Date(data.createdAtMs).getTime())
    || (data.countryCode !== null && (typeof data.countryCode !== 'string' || !/^[A-Z]{2}$/.test(data.countryCode)))
    || !Array.isArray(data.links) || data.links.length > 14 || !data.links.every(validLink)
    || (data.videoCount !== null && (!Number.isSafeInteger(data.videoCount) || data.videoCount < 0))
    || (data.totalViewCount !== null && (!Number.isSafeInteger(data.totalViewCount) || data.totalViewCount < 0))) {
    throw new AccountError('채널 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
function session(value: unknown): AccountSession {
  const data = value as AccountSession | null;
  if (!data || typeof data.csrfToken !== 'string' || !data.csrfToken || data.user === undefined || data.channel === undefined
    || (data.user !== null && (typeof data.user.id !== 'string' || typeof data.user.email !== 'string' || typeof data.user.displayName !== 'string' || typeof data.user.isOperator !== 'boolean'))) {
    throw new AccountError('로그인 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  if (data.channel !== null) channel(data.channel);
  return data;
}
async function channels(path: string, signal?: AbortSignal) {
  const body = await request(path, { signal }) as { items?: unknown[] };
  if (!body || !Array.isArray(body.items)) throw new AccountError('채널 목록을 불러오지 못했어요.', 'INVALID_RESPONSE', 0);
  return body.items.map(channel);
}

async function loadSession(signal?: AbortSignal): Promise<AccountSession> {
  try { return session(await request('/session', { signal })); }
  catch (failure) {
    // An expired session clears its cookie with 401; one fresh GET obtains anonymous CSRF state.
    if (!(failure instanceof AccountError) || failure.status !== 401 || signal?.aborted) throw failure;
    return session(await request('/session', { signal }));
  }
}

function policies(value: unknown): AccountPolicies {
  if (!value || typeof value !== 'object') throw new AccountError('약관 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  const data = value as AccountPolicies;
  for (const policy of [data.terms, data.privacy]) {
    if (!policy || typeof policy.version !== 'string' || !policy.version || typeof policy.title !== 'string' || policy.required !== true
      || !Array.isArray(policy.sections) || policy.sections.length === 0 || policy.sections.some(section => !section || typeof section.heading !== 'string'
        || !Array.isArray(section.paragraphs) || section.paragraphs.length === 0 || section.paragraphs.some(paragraph => typeof paragraph !== 'string'))) {
      throw new AccountError('약관 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
    }
  }
  return data;
}

function scheduledBroadcast(value: unknown): ScheduledBroadcast {
  const data = value as ScheduledBroadcast | null;
  if (!data || typeof data.id !== 'string' || !data.id || typeof data.title !== 'string' || !data.title
    || !Number.isSafeInteger(data.at) || !Number.isFinite(new Date(data.at).getTime())) {
    throw new AccountError('방송 예약 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
async function schedules(path: string, signal?: AbortSignal) {
  const body = await request(path, { signal }) as { items?: unknown[] };
  if (!body || !Array.isArray(body.items)) throw new AccountError('방송 예약을 불러오지 못했어요.', 'INVALID_RESPONSE', 0);
  return body.items.map(scheduledBroadcast);
}

export function historyItem(value: unknown): WatchHistoryItem {
  const data = value as WatchHistoryItem | null;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!data || typeof data.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.id)
    || !['live', 'vod', 'clip'].includes(data.kind)
    || typeof data.title !== 'string' || typeof data.publisher !== 'string' || typeof data.available !== 'boolean'
    || typeof data.completed !== 'boolean' || !Number.isSafeInteger(data.version) || data.version < 0
    || !Number.isSafeInteger(data.watchedAtMs) || data.watchedAtMs < 0 || !Number.isFinite(new Date(data.watchedAtMs).getTime())
    || (data.channelHandle !== null && (typeof data.channelHandle !== 'string' || !/^[a-z][a-z0-9_-]{2,23}$/.test(data.channelHandle)))
    || (data.thumbnailUrl !== null && (typeof data.thumbnailUrl !== 'string' || !/^\/thumbnails\/[0-9a-f]{32}\.jpg$/.test(data.thumbnailUrl)))) {
    throw new AccountError('시청 기록을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  if (data.kind === 'live' ? typeof data.broadcastId !== 'string' || !/^[0-9a-f]{32}$/.test(data.broadcastId)
    || typeof data.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.path)
    || data.mediaId !== null || data.durationMs !== null || data.positionMs !== null || data.completed || data.version !== 0
    : data.broadcastId !== null || data.path !== null || typeof data.mediaId !== 'string' || !uuid.test(data.mediaId)
      || data.thumbnailUrl !== null || !Number.isSafeInteger(data.durationMs) || data.durationMs <= 0
      || !Number.isSafeInteger(data.positionMs) || data.positionMs < 0 || data.positionMs > data.durationMs
      || data.completed && data.positionMs !== data.durationMs) {
    throw new AccountError('시청 기록을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
async function historyList(filters: HistoryFilters, ownerId: string, signal?: AbortSignal): Promise<HistoryPageResult> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
  const body = await request(`/me/history?${query}`, { signal, headers: { 'X-FRAME-USER-ID': ownerId } }) as { userId?: unknown; items?: unknown[]; nextCursor?: unknown } | null;
  if (!body || typeof body.userId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.userId)
    || !Array.isArray(body.items) || body.items.length > (filters.limit ?? 50) || (body.nextCursor !== null && (typeof body.nextCursor !== 'string'
    || !body.nextCursor || body.nextCursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(body.nextCursor)))) {
    throw new AccountError('시청 기록을 불러오지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  if (body.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  const items = body.items.map(historyItem);
  if (new Set(items.map(item => item.id)).size !== items.length) throw new AccountError('시청 기록을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  return { userId: body.userId, items, nextCursor: body.nextCursor };
}

function operatorReportItem(value: unknown): OperatorReportItem {
  const data = value as OperatorReportItem | null;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!data || typeof data.id !== 'string' || !uuid.test(data.id)
    || !['received', 'reviewing', 'resolved', 'dismissed'].includes(data.status)
    || !['spam', 'impersonation', 'harassment', 'inappropriate', 'other'].includes(data.reason)
    || typeof data.details !== 'string' || [...data.details].length > 1000
    || !Number.isSafeInteger(data.createdAtMs) || data.createdAtMs < 0 || !Number.isFinite(new Date(data.createdAtMs).getTime())
    || !Number.isSafeInteger(data.updatedAtMs) || data.updatedAtMs < 0 || !Number.isFinite(new Date(data.updatedAtMs).getTime())
    || !Number.isSafeInteger(data.version) || data.version < 0
    || !data.channel || typeof data.channel.id !== 'string' || !uuid.test(data.channel.id) || typeof data.channel.handle !== 'string'
    || !/^[a-z][a-z0-9_-]{2,23}$/.test(data.channel.handle) || typeof data.channel.displayName !== 'string'
    || !data.reporter || typeof data.reporter.id !== 'string' || !uuid.test(data.reporter.id) || typeof data.reporter.displayName !== 'string') {
    throw new AccountError('신고 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
function operatorReportDetail(value: unknown): OperatorReportDetail {
  const data = operatorReportItem(value) as OperatorReportDetail;
  if (typeof data.reviewNote !== 'string' || [...data.reviewNote].length > 1000 || (data.reviewedBy !== null
    && (!data.reviewedBy || typeof data.reviewedBy.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.reviewedBy.id)
      || typeof data.reviewedBy.displayName !== 'string'))) {
    throw new AccountError('신고 처리 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
async function operatorReports(filters: OperatorReportFilters = {}, signal?: AbortSignal): Promise<OperatorReportPageResult> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
  const body = await request(`/admin/reports?${query}`, { signal }) as { items?: unknown[]; nextCursor?: unknown } | null;
  if (!body || !Array.isArray(body.items) || (body.nextCursor !== null && (typeof body.nextCursor !== 'string'
    || !body.nextCursor || body.nextCursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(body.nextCursor)))) {
    throw new AccountError('신고 목록을 불러오지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return { items: body.items.map(operatorReportItem), nextCursor: body.nextCursor };
}

function notificationCount(value: unknown): NotificationUnreadCount {
  const data = value as NotificationUnreadCount | null;
  if (!data || !Number.isSafeInteger(data.unreadCount) || data.unreadCount < 0 || typeof data.userId !== 'string'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.userId)) {
    throw new AccountError('읽지 않은 알림 수를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return { unreadCount: data.unreadCount, userId: data.userId };
}
function notification(value: unknown): ProductNotification {
  const data = value as ProductNotification | null;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!data || typeof data.id !== 'string' || !uuid.test(data.id) || !['live', 'report'].includes(data.kind)
    || typeof data.title !== 'string' || typeof data.body !== 'string'
    || !Number.isSafeInteger(data.createdAtMs) || data.createdAtMs < 0 || !Number.isFinite(new Date(data.createdAtMs).getTime())
    || (data.readAtMs !== null && (!Number.isSafeInteger(data.readAtMs) || data.readAtMs < 0 || !Number.isFinite(new Date(data.readAtMs).getTime())))) {
    throw new AccountError('알림 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  if (data.kind === 'live') {
    if (data.report !== null || !data.target || typeof data.target.channelId !== 'string' || !uuid.test(data.target.channelId)
      || typeof data.target.channelHandle !== 'string' || !/^[a-z][a-z0-9_-]{2,23}$/.test(data.target.channelHandle)
      || typeof data.target.broadcastId !== 'string' || !/^[0-9a-f]{32}$/.test(data.target.broadcastId)
      || typeof data.target.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.target.path) || typeof data.target.available !== 'boolean') {
      throw new AccountError('방송 알림 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
    }
  } else if (data.target !== null || !data.report || typeof data.report.id !== 'string' || !uuid.test(data.report.id)
    || !['resolved', 'dismissed'].includes(data.report.status)) {
    throw new AccountError('신고 결과 알림을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
function accountOwnerHeaders(ownerId?: string): HeadersInit | undefined { return ownerId ? { 'X-FRAME-USER-ID': ownerId } : undefined; }
async function notificationList(filters: NotificationFilters = {}, signal?: AbortSignal, ownerId?: string): Promise<NotificationPageResult> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
  const body = await request(`/me/notifications?${query}`, { signal, headers: accountOwnerHeaders(ownerId) }) as { items?: unknown[]; nextCursor?: unknown } | null;
  if (!body || !Array.isArray(body.items) || (body.nextCursor !== null && (typeof body.nextCursor !== 'string'
    || !body.nextCursor || body.nextCursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(body.nextCursor)))) {
    throw new AccountError('알림 목록을 불러오지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return { items: body.items.map(notification), nextCursor: body.nextCursor, ...notificationCount(body) };
}

function moderationOwner(value: unknown, ownerId?: string): { userId: string } {
  const data = value as { userId?: unknown } | null;
  if (!data || typeof data.userId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.userId)) throw new AccountError('채팅 관리 계정을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  return { userId: data.userId };
}
function moderationSettings(value: unknown, ownerId?: string): ChatModerationSettings {
  moderationOwner(value, ownerId); const data = value as ChatModerationSettings;
  if (typeof data.channelId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.channelId)
    || !Number.isSafeInteger(data.version) || data.version < 0 || !Number.isSafeInteger(data.updatedAtMs) || data.updatedAtMs < 0 || !Number.isFinite(new Date(data.updatedAtMs).getTime())
    || typeof data.slowMode !== 'boolean' || !Number.isSafeInteger(data.slowSeconds) || data.slowSeconds < 1 || data.slowSeconds > 120
    || typeof data.followersOnly !== 'boolean' || typeof data.blockLinks !== 'boolean' || !Array.isArray(data.bannedWords) || data.bannedWords.length > 100
    || data.bannedWords.some(word => typeof word !== 'string' || !word || [...word].length > 30 || word.trim() !== word
      || word.normalize('NFKC') !== word || /[\u0000-\u001f\u007f]/.test(word))) {
    throw new AccountError('채팅 설정을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
function moderationBlock(value: unknown): ChatModerationBlock {
  const data = value as ChatModerationBlock | null, uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!data || typeof data.id !== 'string' || !uuid.test(data.id) || typeof data.targetChannelId !== 'string' || !uuid.test(data.targetChannelId)
    || typeof data.displayName !== 'string' || typeof data.handle !== 'string' || !/^[a-z][a-z0-9_-]{2,23}$/.test(data.handle) || typeof data.reason !== 'string'
    || !Number.isSafeInteger(data.createdAtMs) || data.createdAtMs < 0 || !Number.isFinite(new Date(data.createdAtMs).getTime())
    || (data.expiresAtMs !== null && (!Number.isSafeInteger(data.expiresAtMs) || data.expiresAtMs < 0 || !Number.isFinite(new Date(data.expiresAtMs).getTime())))
    || !Number.isSafeInteger(data.version) || data.version < 0) throw new AccountError('채팅 참여 제한을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  return data;
}
async function moderationBlocks(filters: ChatModerationBlockFilters = {}, signal?: AbortSignal, ownerId?: string): Promise<ChatModerationBlockPageResult> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
  const body = await request(`/me/chat/blocks?${query}`, { signal, headers: accountOwnerHeaders(ownerId) }) as { items?: unknown[]; nextCursor?: unknown } | null;
  const owner = moderationOwner(body, ownerId);
  if (!body || !Array.isArray(body.items) || (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !body.nextCursor
    || body.nextCursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(body.nextCursor)))) throw new AccountError('채팅 참여 제한 목록을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  return { ...owner, items: body.items.map(moderationBlock), nextCursor: body.nextCursor };
}

const pollUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function pollTime(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number.isFinite(new Date(Number(value)).getTime()); }
function productPoll(value: unknown): ProductPoll {
  const data = value as ProductPoll | null;
  if (!data || typeof data.id !== 'string' || !pollUuid.test(data.id) || typeof data.channelId !== 'string' || !pollUuid.test(data.channelId)
    || typeof data.broadcastId !== 'string' || !/^[0-9a-f]{32}$/.test(data.broadcastId) || typeof data.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.path)
    || typeof data.question !== 'string' || !data.question || [...data.question].length > 100 || !pollTime(data.createdAtMs) || !pollTime(data.endsAtMs)
    || !['active', 'closed'].includes(data.status) || (data.closeReason !== null && !['manual', 'expired', 'broadcast_ended'].includes(data.closeReason))
    || !Number.isSafeInteger(data.version) || data.version < 0 || !Array.isArray(data.options) || data.options.length < 2 || data.options.length > 8
    || data.options.some(option => !option || typeof option.id !== 'string' || !pollUuid.test(option.id) || typeof option.text !== 'string' || !option.text
      || [...option.text].length > 100 || !Number.isSafeInteger(option.votes) || option.votes < 0)
    || new Set(data.options.map(option => option.id)).size !== data.options.length || !Number.isSafeInteger(data.totalVotes) || data.totalVotes < 0
    || data.options.reduce((sum, option) => sum + option.votes, 0) !== data.totalVotes
    || (data.myOptionId !== null && (typeof data.myOptionId !== 'string' || !pollUuid.test(data.myOptionId) || !data.options.some(option => option.id === data.myOptionId)))) {
    throw new AccountError('투표 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
function pollOwner(value: unknown, ownerId?: string): { userId: string; serverNowMs: number } {
  const data = value as { userId?: unknown; serverNowMs?: unknown } | null;
  if (!data || typeof data.userId !== 'string' || !pollUuid.test(data.userId) || !pollTime(data.serverNowMs)) throw new AccountError('투표 관리 계정을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  return { userId: data.userId, serverNowMs: data.serverNowMs };
}
function pollDetail(value: unknown, ownerId?: string): PollDetailResult {
  const scope = pollOwner(value, ownerId), data = value as { poll?: unknown };
  return { ...scope, poll: productPoll(data.poll) };
}
function pollView(value: unknown, broadcast: { path: string; broadcastId: string }, ownerId?: string): PollView {
  const data = value as PollView | null;
  if (!data || (data.userId !== null && (typeof data.userId !== 'string' || !pollUuid.test(data.userId))) || !pollTime(data.serverNowMs)
    || typeof data.canVote !== 'boolean' || (data.reason !== null && !['login_required', 'blocked', 'followers_only', 'already_voted', 'closed', 'broadcast_unavailable'].includes(data.reason))) {
    throw new AccountError('투표 참여 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  const poll = data.poll === null ? null : productPoll(data.poll);
  if ((poll && (poll.path !== broadcast.path || poll.broadcastId !== broadcast.broadcastId || (data.userId === null && poll.myOptionId !== null))) || (!poll && data.canVote)) {
    throw new AccountError('이 방송의 투표 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return { ...data, poll };
}
async function polls(filters: PollFilters = {}, signal?: AbortSignal, ownerId?: string): Promise<PollPageResult> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
  const body = await request(`/me/polls?${query}`, { signal, headers: accountOwnerHeaders(ownerId) }) as PollPageResult | null;
  const scope = pollOwner(body, ownerId), current = body?.currentBroadcast;
  if (!body || !Array.isArray(body.items) || (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !body.nextCursor || body.nextCursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(body.nextCursor)))
    || (body.activePollId !== null && (typeof body.activePollId !== 'string' || !pollUuid.test(body.activePollId)))
    || (current !== null && (!current || typeof current.id !== 'string' || !/^[0-9a-f]{32}$/.test(current.id) || typeof current.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(current.path) || typeof current.title !== 'string'))) {
    throw new AccountError('투표 목록을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return { ...scope, items: body.items.map(productPoll), nextCursor: body.nextCursor, currentBroadcast: body.currentBroadcast, activePollId: body.activePollId };
}

function productQuestion(value: unknown): ProductQuestion {
  const data = value as ProductQuestion | null;
  if (!data || typeof data.id !== 'string' || !pollUuid.test(data.id) || typeof data.channelId !== 'string' || !pollUuid.test(data.channelId)
    || typeof data.broadcastId !== 'string' || !/^[0-9a-f]{32}$/.test(data.broadcastId) || typeof data.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.path)
    || typeof data.text !== 'string' || !data.text || [...data.text].length > 500 || !data.author || typeof data.author.channelId !== 'string' || !pollUuid.test(data.author.channelId)
    || typeof data.author.handle !== 'string' || !/^[a-z][a-z0-9_-]{2,23}$/.test(data.author.handle) || typeof data.author.displayName !== 'string'
    || (data.answer !== null && (typeof data.answer !== 'string' || !data.answer || [...data.answer].length > 1000))
    || (data.answeredAtMs !== null && !pollTime(data.answeredAtMs)) || ((data.answer === null) !== (data.answeredAtMs === null))
    || typeof data.pinned !== 'boolean' || typeof data.broadcastActive !== 'boolean' || (data.pinned && !data.broadcastActive)
    || !Number.isSafeInteger(data.version) || data.version < 0 || !pollTime(data.createdAtMs) || !pollTime(data.updatedAtMs)) {
    throw new AccountError('질문 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}
function ownQuestion(value: unknown): OwnQuestion {
  const data = productQuestion(value) as OwnQuestion;
  if (typeof data.clientRequestId !== 'string' || !pollUuid.test(data.clientRequestId)) throw new AccountError('내 질문 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  return data;
}
function questionOwner(value: unknown, ownerId?: string): { userId: string; serverNowMs: number } {
  const data = value as { userId?: unknown; serverNowMs?: unknown } | null;
  if (!data || typeof data.userId !== 'string' || !pollUuid.test(data.userId) || !pollTime(data.serverNowMs)) throw new AccountError('질문 관리 계정을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  return { userId: data.userId, serverNowMs: data.serverNowMs };
}
function questionCursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Boolean(value) && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value));
}
function questionDetail(value: unknown, ownerId?: string): QuestionDetailResult {
  const scope = questionOwner(value, ownerId), data = value as { item?: unknown };
  return { ...scope, item: productQuestion(data.item) };
}
function questionView(value: unknown, broadcast: { path: string; broadcastId: string }, ownerId?: string): QuestionView {
  const data = value as QuestionView | null;
  if (!data || (data.userId !== null && (typeof data.userId !== 'string' || !pollUuid.test(data.userId))) || !pollTime(data.serverNowMs)
    || !Array.isArray(data.mine) || !questionCursor(data.nextCursor) || typeof data.canSubmit !== 'boolean'
    || (data.retryAfterMs !== null && (!Number.isSafeInteger(data.retryAfterMs) || data.retryAfterMs < 0))
    || (data.reason !== null && !['login_required', 'blocked', 'followers_only', 'broadcast_unavailable', 'rate_limited'].includes(data.reason))) {
    throw new AccountError('질문 참여 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  if (ownerId && data.userId !== ownerId) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  const pinned = data.pinned === null ? null : productQuestion(data.pinned), mine = data.mine.map(ownQuestion);
  if ((pinned && (!pinned.pinned || pinned.path !== broadcast.path || pinned.broadcastId !== broadcast.broadcastId))
    || mine.some(item => item.path !== broadcast.path || item.broadcastId !== broadcast.broadcastId)
    || new Set(mine.map(item => item.id)).size !== mine.length || (data.userId === null && (mine.length > 0 || data.nextCursor !== null || data.canSubmit))) {
    throw new AccountError('이 방송의 질문 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return { ...data, pinned, mine };
}
async function questions(filters: QuestionFilters = {}, signal?: AbortSignal, ownerId?: string): Promise<QuestionPageResult> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
  const body = await request(`/me/questions?${query}`, { signal, headers: accountOwnerHeaders(ownerId) }) as QuestionPageResult | null;
  const scope = questionOwner(body, ownerId), current = body?.currentBroadcast;
  if (!body || !Array.isArray(body.items) || !questionCursor(body.nextCursor) || (body.pinnedQuestionId !== null && (typeof body.pinnedQuestionId !== 'string' || !pollUuid.test(body.pinnedQuestionId)))
    || (current !== null && (!current || typeof current.id !== 'string' || !/^[0-9a-f]{32}$/.test(current.id) || typeof current.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(current.path) || typeof current.title !== 'string'))) {
    throw new AccountError('질문 목록을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return { ...scope, items: body.items.map(productQuestion), nextCursor: body.nextCursor, currentBroadcast: body.currentBroadcast, pinnedQuestionId: body.pinnedQuestionId };
}

export const accountApi = {
  session: loadSession,
  policies: async (signal?: AbortSignal) => {
    try { return policies(await request('/policies', { signal, credentials: 'omit' })); }
    catch (failure) {
      if (failure instanceof AccountError && failure.status === 401) throw new AccountError('약관을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', 'POLICIES_UNAVAILABLE', 401);
      throw failure;
    }
  },
  login: async (body: { email: string; password: string; remember: boolean }, token: string) => session(await request('/auth/login', { method: 'POST', body: JSON.stringify(body) }, token)),
  register: async (body: Registration, token: string) => session(await request('/auth/register', { method: 'POST', body: JSON.stringify(body) }, token)),
  logout: async (token: string) => { await request('/auth/logout', { method: 'POST' }, token); },
  profile: async (displayName: string, token: string) => session(await request('/me/profile', { method: 'PATCH', body: JSON.stringify({ displayName }) }, token)),
  channel: async (handle: string, signal?: AbortSignal) => channel(await request(`/channels/${encodeURIComponent(handle)}`, { signal })),
  channelById: async (id: string, signal?: AbortSignal) => channel(await request(`/channel-ids/${encodeURIComponent(id)}`, { signal })),
  directory: (query = '', signal?: AbortSignal) => channels(`/channels?${new URLSearchParams({ query, limit: '50' })}`, signal),
  follows: (signal?: AbortSignal) => channels('/me/follows', signal),
  follow: async (id: string, token: string, notificationsOn?: boolean) => channel(await request(`/me/follows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(notificationsOn === undefined ? {} : { notificationsOn }) }, token)),
  unfollow: async (id: string, token: string) => channel(await request(`/me/follows/${encodeURIComponent(id)}`, { method: 'DELETE' }, token)),
  updateChannel: async (body: ChannelChanges, token: string) => channel(await request('/me/channel', { method: 'PATCH', body: JSON.stringify(body) }, token)),
  reportChannel: async (id: string, body: { reason: string; details: string }, token: string): Promise<ChannelReportReceipt> => {
    const value = await request(`/channels/${encodeURIComponent(id)}/reports`, { method: 'POST', body: JSON.stringify(body) }, token) as ChannelReportReceipt | null;
    if (!value || typeof value.id !== 'string' || !value.id || value.status !== 'received'
      || !Number.isSafeInteger(value.createdAtMs) || !Number.isFinite(new Date(value.createdAtMs).getTime())) {
      throw new AccountError('신고 접수 결과를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
    }
    return value;
  },
  operatorReports,
  operatorReport: async (id: string, signal?: AbortSignal) => operatorReportDetail(await request(`/admin/reports/${encodeURIComponent(id)}`, { signal })),
  reviewReport: async (id: string, body: { status: Exclude<OperatorReportStatus, 'received'>; reviewNote: string; version: number }, token: string) =>
    operatorReportDetail(await request(`/admin/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }, token)),
  studio: (signal?: AbortSignal) => request('/studio', { signal }),
  connectStudio: async (streamKey: string, token: string) => channel(await request('/me/channel/connection', { method: 'POST', body: JSON.stringify({ streamKey }) }, token)),
  scheduleList: (signal?: AbortSignal) => schedules('/me/schedules', signal),
  createSchedule: async (body: ScheduleChanges, token: string) => scheduledBroadcast(await request('/me/schedules', { method: 'POST', body: JSON.stringify(body) }, token)),
  updateSchedule: async (id: string, body: ScheduleChanges, token: string) => scheduledBroadcast(await request(`/me/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }, token)),
  cancelSchedule: async (id: string, token: string) => { await request(`/me/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }, token); },
  channelSchedule: (handle: string, signal?: AbortSignal) => schedules(`/channels/${encodeURIComponent(handle)}/schedule`, signal),
  historyList,
  recordHistory: async (body: { broadcastId: string; path: string }, token: string, signal?: AbortSignal, ownerId?: string) => { await request('/me/history', { method: 'POST', body: JSON.stringify(body), signal, ...(ownerId ? { headers: { 'X-FRAME-USER-ID': ownerId } } : {}) }, token); },
  removeHistory: async (id: string, token: string, ownerId: string, signal?: AbortSignal) => { await request(`/me/history/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-FRAME-USER-ID': ownerId }, signal }, token); },
  removeHistorySelection: async (ids: string[], token: string, ownerId: string, signal?: AbortSignal) => { await request('/me/history/delete', { method: 'POST', headers: { 'X-FRAME-USER-ID': ownerId }, body: JSON.stringify({ ids }), signal }, token); },
  clearHistory: async (token: string, ownerId: string, signal?: AbortSignal) => { await request('/me/history', { method: 'DELETE', headers: { 'X-FRAME-USER-ID': ownerId }, signal }, token); },
  notificationList,
  notificationUnreadCount: async (signal?: AbortSignal, ownerId?: string) => notificationCount(await request('/me/notifications/unread-count', { signal, headers: accountOwnerHeaders(ownerId) })),
  readNotification: async (id: string, token: string, ownerId?: string) => notificationCount(await request(`/me/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH', headers: accountOwnerHeaders(ownerId) }, token)),
  readAllNotifications: async (token: string, ownerId?: string) => notificationCount(await request('/me/notifications/read-all', { method: 'POST', headers: accountOwnerHeaders(ownerId) }, token)),
  removeNotification: async (id: string, token: string, ownerId?: string) => notificationCount(await request(`/me/notifications/${encodeURIComponent(id)}`, { method: 'DELETE', headers: accountOwnerHeaders(ownerId) }, token)),
  clearNotifications: async (token: string, ownerId?: string) => notificationCount(await request('/me/notifications', { method: 'DELETE', headers: accountOwnerHeaders(ownerId) }, token)),
  moderationSettings: async (signal?: AbortSignal, ownerId?: string) => moderationSettings(await request('/me/chat/settings', { signal, headers: accountOwnerHeaders(ownerId) }), ownerId),
  updateModerationSettings: async (body: ChatModerationSettingsInput, token: string, ownerId?: string) => moderationSettings(await request('/me/chat/settings', { method: 'PATCH', body: JSON.stringify(body), headers: accountOwnerHeaders(ownerId) }, token), ownerId),
  moderationBlocks,
  createModerationBlock: async (body: { targetChannelId: string; durationSeconds: number | null; reason: string }, token: string, ownerId?: string): Promise<ChatModerationBlock> => {
    const value = await request('/me/chat/blocks', { method: 'POST', body: JSON.stringify(body), headers: accountOwnerHeaders(ownerId) }, token) as { item?: unknown };
    moderationOwner(value, ownerId); return moderationBlock(value?.item);
  },
  removeModerationBlock: async (id: string, version: number, token: string, ownerId?: string) => moderationOwner(await request(`/me/chat/blocks/${encodeURIComponent(id)}?${new URLSearchParams({ version: String(version) })}`, { method: 'DELETE', headers: accountOwnerHeaders(ownerId) }, token), ownerId),
  createChatTicket: async (body: { path: string; broadcastId: string }, token: string, ownerId?: string, signal?: AbortSignal): Promise<ChatTicket> => {
    const value = await request('/chat/tickets', { method: 'POST', body: JSON.stringify(body), headers: accountOwnerHeaders(ownerId), signal }, token) as ChatTicket | null;
    moderationOwner(value, ownerId);
    if (!value || typeof value.ticket !== 'string' || value.ticket.length < 24 || value.ticket.length > 512 || /[\u0000-\u0020\u007f]/.test(value.ticket)
      || typeof value.displayName !== 'string' || !value.displayName || [...value.displayName].length > 30 || !Number.isSafeInteger(value.expiresAtMs)
      || !Number.isFinite(new Date(value.expiresAtMs).getTime())) throw new AccountError('채팅 인증 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
    return value;
  },
  polls,
  poll: async (id: string, signal?: AbortSignal, ownerId?: string) => pollDetail(await request(`/me/polls/${encodeURIComponent(id)}`, { signal, headers: accountOwnerHeaders(ownerId) }), ownerId),
  createPoll: async (body: PollCreateInput, token: string, ownerId?: string) => pollDetail(await request('/me/polls', { method: 'POST', body: JSON.stringify(body), headers: accountOwnerHeaders(ownerId) }, token), ownerId),
  closePoll: async (id: string, version: number, token: string, ownerId?: string) => pollDetail(await request(`/me/polls/${encodeURIComponent(id)}/close`, { method: 'POST', body: JSON.stringify({ version }), headers: accountOwnerHeaders(ownerId) }, token), ownerId),
  currentPoll: async (broadcast: { path: string; broadcastId: string }, signal?: AbortSignal, ownerId?: string) => pollView(await request(`/polls/current?${new URLSearchParams(broadcast)}`, { signal, headers: accountOwnerHeaders(ownerId) }), broadcast, ownerId),
  votePoll: async (id: string, body: { optionId: string; broadcastId: string; path: string }, token: string, ownerId?: string) => {
    const view = pollView(await request(`/polls/${encodeURIComponent(id)}/votes`, { method: 'POST', body: JSON.stringify(body), headers: accountOwnerHeaders(ownerId) }, token), body, ownerId);
    if (!view.poll || view.poll.id !== id) throw new AccountError('참여한 투표 결과를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
    return view;
  },
  questions,
  question: async (id: string, signal?: AbortSignal, ownerId?: string) => questionDetail(await request(`/me/questions/${encodeURIComponent(id)}`, { signal, headers: accountOwnerHeaders(ownerId) }), ownerId),
  updateQuestion: async (id: string, body: QuestionUpdateInput, token: string, ownerId?: string) => questionDetail(await request(`/me/questions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body), headers: accountOwnerHeaders(ownerId) }, token), ownerId),
  currentQuestions: async (broadcast: { path: string; broadcastId: string }, filters: { limit?: number; cursor?: string } = {}, signal?: AbortSignal, ownerId?: string) => {
    const query = new URLSearchParams(broadcast); for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') query.set(key, String(value));
    return questionView(await request(`/questions/current?${query}`, { signal, headers: accountOwnerHeaders(ownerId) }), broadcast, ownerId);
  },
  submitQuestion: async (body: QuestionSubmitInput, token: string, ownerId?: string): Promise<QuestionSubmitResult> => {
    const value = await request('/questions', { method: 'POST', body: JSON.stringify(body), headers: accountOwnerHeaders(ownerId) }, token) as { item?: unknown };
    const scope = questionOwner(value, ownerId), item = ownQuestion(value?.item);
    if (item.path !== body.path || item.broadcastId !== body.broadcastId || item.clientRequestId !== body.clientRequestId) throw new AccountError('접수한 질문을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
    return { ...scope, item };
  },
};

export function safeReturnPath(value: unknown, fallback = '/live') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return fallback;
  try { const url = new URL(value, location.origin); return url.origin === location.origin && url.pathname !== '/login' ? url.pathname + url.search + url.hash : fallback; }
  catch { return fallback; }
}

export { request as accountRequest };
