import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';

export const keyScopes = ['broadcast:read', 'analytics:read', 'chat:manage'] as const;
export type KeyScope = typeof keyScopes[number];
export const webhookEvents = ['broadcast.started', 'broadcast.ended'] as const;
export type WebhookEvent = typeof webhookEvents[number];
export type DeveloperKey = { id: string; name: string; scopes: KeyScope[]; prefix: string; last4: string; createdAtMs: number; lastUsedAtMs: number | null; revokedAtMs: number | null; version: number; clientRequestId: string };
export type DeveloperWebhook = { id: string; name: string; url: string; events: WebhookEvent[]; enabled: boolean; createdAtMs: number; updatedAtMs: number; revokedAtMs: number | null; version: number; clientRequestId: string };
export type WebhookDraft = Pick<DeveloperWebhook, 'name' | 'url' | 'events' | 'enabled'>;
export type WebhookDelivery = { id: string; webhookId: string; event: string; eventId: string; status: 'pending' | 'inflight' | 'succeeded' | 'failed' | 'cancelled'; createdAtMs: number; startedAtMs: number | null; completedAtMs: number | null; httpStatus: number | null; errorCode: string | null; clientRequestId: string | null };

const base = '/api/v1/me/developer';
const invalid = () => new AccountError('서버 응답을 확인하지 못했어요. 결과를 다시 확인해 주세요.', 'INVALID_RESPONSE', 0);
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object') throw invalid(); return value as Record<string, unknown>; };
const str = (value: unknown): string => { if (typeof value !== 'string') throw invalid(); return value; };
const num = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(); return value as number; };
const nullableTime = (value: unknown) => value === null ? null : num(value);
const bool = (value: unknown): boolean => { if (typeof value !== 'boolean') throw invalid(); return value; };
function selections<T extends string>(value: unknown, allowed: readonly T[]): T[] { if (!Array.isArray(value) || !value.length || value.some(item => !allowed.includes(item)) || new Set(value).size !== value.length) throw invalid(); return [...value] as T[]; }
function key(value: unknown): DeveloperKey {
  const d = record(value);
  return { id: str(d.id), name: str(d.name), scopes: selections(d.scopes, keyScopes), prefix: str(d.prefix), last4: str(d.last4), createdAtMs: num(d.createdAtMs), lastUsedAtMs: nullableTime(d.lastUsedAtMs), revokedAtMs: nullableTime(d.revokedAtMs), version: num(d.version), clientRequestId: str(d.clientRequestId) };
}
function webhook(value: unknown): DeveloperWebhook {
  const d = record(value);
  return { id: str(d.id), name: str(d.name), url: str(d.url), events: selections(d.events, webhookEvents), enabled: bool(d.enabled), createdAtMs: num(d.createdAtMs), updatedAtMs: num(d.updatedAtMs), revokedAtMs: nullableTime(d.revokedAtMs), version: num(d.version), clientRequestId: str(d.clientRequestId) };
}
function delivery(value: unknown): WebhookDelivery {
  const d = record(value), status = str(d.status);
  if (!['pending', 'inflight', 'succeeded', 'failed', 'cancelled'].includes(status)) throw invalid();
  return { id: str(d.id), webhookId: str(d.webhookId), event: str(d.event), eventId: str(d.eventId), status: status as WebhookDelivery['status'], createdAtMs: num(d.createdAtMs), startedAtMs: nullableTime(d.startedAtMs), completedAtMs: nullableTime(d.completedAtMs), httpStatus: d.httpStatus === null ? null : num(d.httpStatus), errorCode: d.errorCode === null ? null : str(d.errorCode), clientRequestId: d.clientRequestId === null ? null : str(d.clientRequestId) };
}
export function developerFailure(failure: unknown): AccountError { return failure instanceof AccountError ? failure : new AccountError('서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.', 'NETWORK_ERROR', 0); }
export function uncertainMutation(failure: unknown): boolean { const error = developerFailure(failure); return error.status === 0 || error.status >= 500 || error.code === 'ISSUE_ALREADY_PROCESSED'; }

export function developerClient(session: AccountSession, signal?: AbortSignal) {
  let lifecycle = new AbortController();
  async function request(path: string, method = 'GET', input?: unknown) {
    if (!session.user) throw new AccountError('로그인이 필요해요.', 'SESSION_REQUIRED', 401);
    const headers = new Headers({ 'X-FRAME-USER-ID': session.user.id });
    if (method !== 'GET') headers.set('X-CSRF-TOKEN', session.csrfToken);
    if (input !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try { response = await fetch(`${base}${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input), credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : []), AbortSignal.timeout(15000)]) }); }
    catch (failure) { throw developerFailure(failure); }
    let body: unknown;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const problem = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      throw new AccountError(typeof problem.detail === 'string' ? problem.detail.slice(0, 300) : '요청을 처리하지 못했어요. 다시 확인해 주세요.', typeof problem.code === 'string' ? problem.code : 'REQUEST_FAILED', response.status);
    }
    const data = record(body);
    if (data.userId !== session.user.id) throw new AccountError('계정이 변경되었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
    return data;
  }
  async function items<T>(path: string, parse: (value: unknown) => T) { const d = await request(path); if (!Array.isArray(d.items)) throw invalid(); return d.items.map(parse); }
  async function item<T>(path: string, parse: (value: unknown) => T, method = 'GET', input?: unknown) { return parse((await request(path, method, input)).item); }
  return {
    activate: () => { if (lifecycle.signal.aborted) lifecycle = new AbortController(); },
    dispose: () => lifecycle.abort(),
    keys: () => items('/keys', key),
    issueKey: async (name: string, scopes: KeyScope[], clientRequestId: string) => { const d = await request('/keys', 'POST', { name, scopes, clientRequestId }); return { item: key(d.item), secret: str(d.secret) }; },
    keyReceipt: (requestId: string) => item(`/keys/receipts/${encodeURIComponent(requestId)}`, key),
    revokeKey: (value: DeveloperKey, requestId: string) => item(`/keys/${encodeURIComponent(value.id)}?version=${value.version}&requestId=${encodeURIComponent(requestId)}`, key, 'DELETE'),
    keyMutation: (id: string, requestId: string) => item(`/keys/${encodeURIComponent(id)}/mutations/${encodeURIComponent(requestId)}`, key),
    webhooks: () => items('/webhooks', webhook),
    createWebhook: async (draft: WebhookDraft, clientRequestId: string) => { const d = await request('/webhooks', 'POST', { ...draft, clientRequestId }); return { item: webhook(d.item), secret: str(d.signingSecret) }; },
    webhookReceipt: (requestId: string) => item(`/webhooks/receipts/${encodeURIComponent(requestId)}`, webhook),
    editWebhook: (value: DeveloperWebhook, draft: WebhookDraft, clientRequestId: string) => item(`/webhooks/${encodeURIComponent(value.id)}`, webhook, 'PATCH', { ...draft, version: value.version, clientRequestId }),
    removeWebhook: (value: DeveloperWebhook, requestId: string) => item(`/webhooks/${encodeURIComponent(value.id)}?version=${value.version}&requestId=${encodeURIComponent(requestId)}`, webhook, 'DELETE'),
    webhookMutation: (id: string, requestId: string) => item(`/webhooks/${encodeURIComponent(id)}/mutations/${encodeURIComponent(requestId)}`, webhook),
    testWebhook: (id: string, clientRequestId: string) => item(`/webhooks/${encodeURIComponent(id)}/tests`, delivery, 'POST', { clientRequestId }),
    testReceipt: (id: string, requestId: string) => item(`/webhooks/${encodeURIComponent(id)}/tests/${encodeURIComponent(requestId)}`, delivery),
    deliveries: (id: string) => items(`/webhooks/${encodeURIComponent(id)}/deliveries`, delivery),
  };
}
