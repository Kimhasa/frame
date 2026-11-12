import type { PaymentOrder } from './payments-client';

type PaymentWindow = { on: (event: 'paymentRequest' | 'cancel', callback: () => void) => void; destroy: () => void | Promise<void> };
type Widgets = {
  setAmount: (amount: { currency: 'KRW'; value: number }) => Promise<void>;
  renderPaymentWindow: (options: { orderName: string }) => Promise<PaymentWindow>;
  requestPayment: (options: { orderId: string; orderName: string; successUrl: string; failUrl: string }) => Promise<void>;
};
type TossFactory = (clientKey: string) => { widgets: (params: { customerKey: string }) => Widgets };
declare global { interface Window { TossPayments?: TossFactory } }

let loading: Promise<TossFactory> | null = null;
function loadSdk() {
  if (window.TossPayments) return Promise.resolve(window.TossPayments);
  if (loading) return loading;
  loading = new Promise<TossFactory>((resolve, reject) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(() => { script.remove(); loading = null; reject(new Error('결제창을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')); }, 20000);
    script.src = 'https://js.tosspayments.com/v2/standard'; script.async = true;
    script.onload = () => { window.clearTimeout(timer); if (window.TossPayments) resolve(window.TossPayments); else { loading = null; script.remove(); reject(new Error('결제창을 불러오지 못했어요.')); } };
    script.onerror = () => { window.clearTimeout(timer); loading = null; script.remove(); reject(new Error('결제창을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.')); };
    document.head.append(script);
  });
  return loading;
}

export async function openTossPayment(clientKey: string, order: PaymentOrder, signal: AbortSignal) {
  if (!/^test_gck_/.test(clientKey)) throw new Error('테스트 결제 설정을 확인해 주세요.');
  if (typeof order.customerKey !== 'string' || order.customerKey.length < 22) throw new Error('결제 고객 정보를 확인하지 못했어요.');
  const TossPayments = await loadSdk();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const widgets = TossPayments(clientKey).widgets({ customerKey: order.customerKey });
  await widgets.setAmount({ currency: 'KRW', value: order.amount });
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (typeof widgets.renderPaymentWindow !== 'function') throw new Error('결제창을 열지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.');
  const paymentWindow = await widgets.renderPaymentWindow({ orderName: order.orderName });
  return new Promise<void>((resolve, reject) => {
    let settled = false, requesting = false;
    function finish(failure?: unknown) {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort);
      try { void Promise.resolve(paymentWindow.destroy()).catch(() => {}); } catch { /* Already closed by the SDK. */ }
      if (failure) reject(failure); else resolve();
    }
    function abort() { finish(new DOMException('Aborted', 'AbortError')); }
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      paymentWindow.on('cancel', () => finish());
      paymentWindow.on('paymentRequest', () => {
        if (requesting || settled) return;
        requesting = true;
        try {
          void Promise.resolve(widgets.requestPayment({ orderId: order.orderId, orderName: order.orderName,
            successUrl: new URL(`${import.meta.env.BASE_URL}payments/success`, location.origin).href,
            failUrl: new URL(`${import.meta.env.BASE_URL}payments/fail`, location.origin).href,
          })).catch(failure => finish(failure));
        } catch (failure) { finish(failure); }
      });
    } catch (failure) { finish(failure); }
  });
}
