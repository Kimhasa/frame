import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';

export type MembershipPlan = { channelId: string; version: number; enabled: boolean; amount: number; currency: 'KRW'; benefits: string; updatedAtMs: number; paymentsReady: boolean };
export type MembershipPlanDraft = Pick<MembershipPlan, 'enabled' | 'amount' | 'benefits'>;
type Person = { id: string; handle: string; displayName: string };
export type Membership = { id: string; channel: Person; subscriber: { channelId: string; handle: string; displayName: string }; amount: number; currency: 'KRW'; benefits: string; planVersion: number; status: 'pending_auth' | 'issuing' | 'issue_unknown' | 'pending_charge' | 'active' | 'ended' | 'failed'; version: number; createdAtMs: number; periodStartedAtMs: number | null; periodEndsAtMs: number | null; nextChargeAtMs: number | null; cancelRequestedAtMs: number | null; endedAtMs: number | null; lastErrorCode: string | null; cardLabel: string | null; billingKeyDeletion: 'none' | 'pending' | 'done' | 'unknown'; entitled: boolean; paymentPending: boolean };
export type MembershipPayment = { id: string; subscriptionId: string; orderId: string; amount: number; currency: 'KRW'; status: 'ready' | 'sending' | 'unknown' | 'paid' | 'failed'; createdAtMs: number; approvedAtMs: number | null; method: string | null; receiptUrl: string | null; errorCode: string | null; periodStartedAtMs: number | null; periodEndsAtMs: number | null };
export type MembershipCheckout = { clientKey: string; customerKey: string; subscriptionId: string };
export type MembershipSignup = { item: Membership; checkout: MembershipCheckout | null };
export type MemberFilters = { status: 'all' | 'active' | 'ended'; q: string; from: string; to: string; cursor?: string };
const invalid = () => new AccountError('멤버십 응답을 확인하지 못했어요. 상태를 다시 확인해 주세요.', 'INVALID_RESPONSE', 0);
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object') throw invalid(); return value as Record<string, unknown>; };
const text = (value: unknown): string => { if (typeof value !== 'string') throw invalid(); return value; };
const number = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(); return value as number; };
const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw invalid(); return value; };
const time = (value: unknown) => value === null ? null : number(value);
const optionalText = (value: unknown) => value === null ? null : text(value);
function currency(value: unknown): 'KRW' { if (value !== 'KRW') throw invalid(); return value; }
function person(value: unknown): Person { const d = object(value); return { id: text(d.id), handle: text(d.handle), displayName: text(d.displayName) }; }
function plan(value: unknown): MembershipPlan { const d = object(value); return { channelId: text(d.channelId), version: number(d.version), enabled: boolean(d.enabled), amount: number(d.amount), currency: currency(d.currency), benefits: text(d.benefits), updatedAtMs: number(d.updatedAtMs), paymentsReady: boolean(d.paymentsReady) }; }
export function parseMembership(value: unknown): Membership {
  const d = object(value), subscriber = object(d.subscriber), status = text(d.status), deletion = text(d.billingKeyDeletion);
  if (!['pending_auth', 'issuing', 'issue_unknown', 'pending_charge', 'active', 'ended', 'failed'].includes(status) || !['none', 'pending', 'done', 'unknown'].includes(deletion)) throw invalid();
  return { id: text(d.id), channel: person(d.channel), subscriber: { channelId: text(subscriber.channelId), handle: text(subscriber.handle), displayName: text(subscriber.displayName) }, amount: number(d.amount), currency: currency(d.currency), benefits: text(d.benefits), planVersion: number(d.planVersion), status: status as Membership['status'], version: number(d.version), createdAtMs: number(d.createdAtMs), periodStartedAtMs: time(d.periodStartedAtMs), periodEndsAtMs: time(d.periodEndsAtMs), nextChargeAtMs: time(d.nextChargeAtMs), cancelRequestedAtMs: time(d.cancelRequestedAtMs), endedAtMs: time(d.endedAtMs), lastErrorCode: optionalText(d.lastErrorCode), cardLabel: optionalText(d.cardLabel), billingKeyDeletion: deletion as Membership['billingKeyDeletion'], entitled: boolean(d.entitled), paymentPending: boolean(d.paymentPending) };
}
function payment(value: unknown): MembershipPayment {
  const d = object(value), status = text(d.status); if (!['ready', 'sending', 'unknown', 'paid', 'failed'].includes(status)) throw invalid();
  return { id: text(d.id), subscriptionId: text(d.subscriptionId), orderId: text(d.orderId), amount: number(d.amount), currency: currency(d.currency), status: status as MembershipPayment['status'], createdAtMs: number(d.createdAtMs), approvedAtMs: time(d.approvedAtMs), method: optionalText(d.method), receiptUrl: optionalText(d.receiptUrl), errorCode: optionalText(d.errorCode), periodStartedAtMs: time(d.periodStartedAtMs), periodEndsAtMs: time(d.periodEndsAtMs) };
}
function signup(value: Record<string, unknown>): MembershipSignup {
  const item = parseMembership(value.item); if (value.checkout === null) return { item, checkout: null };
  const d = object(value.checkout), clientKey = text(d.clientKey), customerKey = text(d.customerKey), subscriptionId = text(d.subscriptionId);
  if (!/^test_ck_/.test(clientKey) || !customerKey || subscriptionId !== item.id) throw invalid();
  return { item, checkout: { clientKey, customerKey, subscriptionId } };
}
export const membershipFailure = (failure: unknown) => failure instanceof AccountError ? failure : new AccountError('서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.', 'NETWORK_ERROR', 0);
export const membershipUncertain = (failure: unknown) => { const e = membershipFailure(failure); return e.status === 0 || e.status >= 500; };
export function membershipClient(session: AccountSession | null) {
  async function request(path: string, signal?: AbortSignal, method = 'GET', input?: unknown, publicView = false) {
    if (!publicView && !session?.user) throw new AccountError('로그인이 필요해요.', 'UNAUTHENTICATED', 401);
    const headers = new Headers(); if (session?.user) headers.set('X-FRAME-USER-ID', session.user.id);
    if (method !== 'GET') { if (!session?.csrfToken) throw new AccountError('로그인 정보를 다시 확인해 주세요.', 'CSRF_INVALID', 403); headers.set('X-CSRF-TOKEN', session.csrfToken); headers.set('Content-Type', 'application/json'); }
    let response: Response;
    try { response = await fetch(`/api/v1${path}`, { method, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]), headers, body: input === undefined ? undefined : JSON.stringify(input), credentials: 'same-origin', redirect: 'error', cache: 'no-store' }); }
    catch (failure) { if (signal?.aborted) throw failure; throw membershipFailure(failure); }
    let body: unknown; try { body = await response.json(); } catch { body = null; }
    if (!response.ok) { const problem = body && typeof body === 'object' ? body as Record<string, unknown> : {}; throw new AccountError(typeof problem.detail === 'string' ? problem.detail.slice(0, 300) : '멤버십 요청을 처리하지 못했어요.', typeof problem.code === 'string' ? problem.code : 'REQUEST_FAILED', response.status); }
    const data = object(body); if (data.userId !== (session?.user?.id ?? null)) throw new AccountError('로그인 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409); return data;
  }
  async function items<T>(path: string, parse: (value: unknown) => T, signal?: AbortSignal) { const d = await request(path, signal); if (!Array.isArray(d.items)) throw invalid(); return { items: d.items.map(parse), nextCursor: optionalText(d.nextCursor), serverNowMs: number(d.serverNowMs) }; }
  return {
    plan: async (signal?: AbortSignal) => plan((await request('/me/membership/plan', signal)).item),
    savePlan: async (draft: MembershipPlanDraft, version: number, clientRequestId: string, signal?: AbortSignal) => plan((await request('/me/membership/plan', signal, 'PATCH', { ...draft, version, clientRequestId })).item),
    planReceipt: async (id: string, signal?: AbortSignal) => plan((await request(`/me/membership/plan/requests/${encodeURIComponent(id)}`, signal)).item),
    members: async (filter: MemberFilters, signal?: AbortSignal) => { const query = new URLSearchParams({ status: filter.status, q: filter.q, from: filter.from, to: filter.to, limit: '20', ...(filter.cursor ? { cursor: filter.cursor } : {}) }); return items(`/me/membership/members?${query}`, parseMembership, signal); },
    member: async (id: string, signal?: AbortSignal) => parseMembership((await request(`/me/membership/members/${encodeURIComponent(id)}`, signal)).item),
    channel: async (channelId: string, signal?: AbortSignal) => { const d = await request(`/channels/${encodeURIComponent(channelId)}/membership`, signal, 'GET', undefined, true); return { plan: plan(d.plan), membership: d.membership === null ? null : parseMembership(d.membership) }; },
    mine: (signal?: AbortSignal) => items('/me/memberships', parseMembership, signal),
    detail: async (id: string, signal?: AbortSignal) => parseMembership((await request(`/me/memberships/${encodeURIComponent(id)}`, signal)).item),
    payments: async (id: string, signal?: AbortSignal) => { const d = await request(`/me/memberships/${encodeURIComponent(id)}/payments`, signal); if (!Array.isArray(d.items)) throw invalid(); return d.items.map(payment); },
    join: async (channelId: string, planVersion: number, clientRequestId: string, signal?: AbortSignal) => signup(await request('/me/memberships', signal, 'POST', { channelId, planVersion, clientRequestId, consentVersion: '2026-11-17' })),
    joinReceipt: async (id: string, signal?: AbortSignal) => signup(await request(`/me/memberships/requests/${encodeURIComponent(id)}`, signal)),
    authorize: async (id: string, authKey: string, customerKey: string, clientRequestId: string, signal?: AbortSignal) => parseMembership((await request(`/me/memberships/${encodeURIComponent(id)}/authorize`, signal, 'POST', { authKey, customerKey, clientRequestId })).item),
    cancel: async (item: Membership, clientRequestId: string, signal?: AbortSignal) => parseMembership((await request(`/me/memberships/${encodeURIComponent(item.id)}/cancel`, signal, 'POST', { version: item.version, clientRequestId })).item),
    cancelReceipt: async (id: string, requestId: string, signal?: AbortSignal) => parseMembership((await request(`/me/memberships/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}`, signal)).item),
    reconcile: async (id: string, signal?: AbortSignal) => parseMembership((await request(`/me/memberships/${encodeURIComponent(id)}/reconcile`, signal, 'POST', {})).item),
  };
}
