import type { DonationDraft } from '../donation/donation-preview';

const base = `${import.meta.env.BASE_URL}api/payments`;
export type PaymentConfig = { enabled: boolean; environment: 'test'; clientKey: string | null; currency: 'KRW'; minAmount: number; maxAmount: number };
export type PaymentOrder = {
  orderId: string; orderName: string; amount: number; currency: 'KRW'; customerKey: string;
  status: 'READY' | 'CONFIRMING' | 'DONE'; channel: string; kind: string;
  createdAt: string; approvedAt: string | null; method: string | null; receiptUrl: string | null;
};

export class PaymentError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); this.name = 'PaymentError'; }
}

async function request(path: string, init: RequestInit = {}) {
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(15000)]);
  let response: Response;
  try { response = await fetch(base + path, { ...init, signal, cache: 'no-store', credentials: 'same-origin' }); }
  catch (failure) {
    if (init.signal?.aborted) throw failure;
    throw new PaymentError('결제 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.', 'NETWORK_ERROR', 0);
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    throw new PaymentError(typeof value.message === 'string' ? value.message.slice(0, 300) : '결제를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', typeof value.code === 'string' ? value.code : 'PAYMENT_ERROR', response.status);
  }
  return body;
}

function order(value: unknown): PaymentOrder {
  if (!value || typeof value !== 'object') throw new PaymentError('결제 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  const data = value as PaymentOrder;
  if (typeof data.orderId !== 'string' || !/^[A-Za-z0-9_=-]{6,64}$/.test(data.orderId) || typeof data.orderName !== 'string'
    || !Number.isSafeInteger(data.amount) || data.amount < 1000 || data.amount > 10_000_000 || data.currency !== 'KRW'
    || !['READY', 'CONFIRMING', 'DONE'].includes(data.status) || typeof data.channel !== 'string' || typeof data.kind !== 'string'
    || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) {
    throw new PaymentError('결제 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  return data;
}

export async function getPaymentConfig(signal?: AbortSignal): Promise<PaymentConfig> {
  const value = await request('/config', { signal }) as PaymentConfig;
  if (!value || value.environment !== 'test' || value.currency !== 'KRW' || typeof value.enabled !== 'boolean') {
    throw new PaymentError('결제 설정을 확인하지 못했어요.', 'INVALID_CONFIG', 0);
  }
  return value;
}

export async function createPaymentOrder(channel: string, draft: DonationDraft, amount: number, signal?: AbortSignal) {
  return order(await request('/orders', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    channel, kind: draft.kind, amount, message: draft.message.trim(),
    ...(draft.kind === '영상' ? { videoUrl: draft.videoUrl.trim(), start: draft.start.trim() } : {}),
  }) }));
}

export async function getPaymentOrder(id: string, signal?: AbortSignal) {
  return order(await request(`/orders/${encodeURIComponent(id)}`, { signal }));
}

export async function getPaymentOrders(signal?: AbortSignal) {
  const value = await request('/orders', { signal }) as { items?: unknown[] };
  if (!value || !Array.isArray(value.items)) throw new PaymentError('결제 내역을 불러오지 못했어요.', 'INVALID_RESPONSE', 0);
  return value.items.map(order);
}

const confirmations = new Map<string, Promise<PaymentOrder>>();
export function confirmPayment(orderId: string, paymentKey: string, amount: number) {
  const identity = JSON.stringify([orderId, paymentKey, amount]);
  const previous = confirmations.get(identity);
  if (previous) return previous;
  const pending = (async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try { return order(await request('/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, paymentKey, amount }) })); }
      catch (failure) {
        if (!(failure instanceof PaymentError) || failure.code !== 'PAYMENT_PROCESSING' || attempt === 7) throw failure;
        await new Promise(resolve => window.setTimeout(resolve, 750));
      }
    }
    throw new PaymentError('결제 확인이 진행 중이에요. 결제 내역에서 다시 확인해 주세요.', 'PAYMENT_PROCESSING', 409);
  })();
  confirmations.set(identity, pending);
  void pending.then(() => confirmations.delete(identity), () => confirmations.delete(identity));
  return pending;
}

export function receiptLink(value: string | null | undefined) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'tosspayments.com' || url.hostname.endsWith('.tosspayments.com')) ? url.href : null; }
  catch { return null; }
}
