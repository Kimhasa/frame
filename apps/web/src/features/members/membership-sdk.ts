type BillingFactory = (key: string) => { payment: (options: { customerKey: string }) => { requestBillingAuth: (options: { method: 'CARD'; successUrl: string; failUrl: string }) => Promise<void> } };
let loading: Promise<BillingFactory> | null = null;
function factory(): BillingFactory | undefined { return (window as unknown as { TossPayments?: BillingFactory }).TossPayments; }
function loadSdk(): Promise<BillingFactory> {
  const existing = factory();
  if (existing) return Promise.resolve(existing);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => { window.clearTimeout(timer); script.remove(); loading = null; reject(new Error('카드 등록창을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.')); };
    const timer = window.setTimeout(fail, 20000);
    script.src = 'https://js.tosspayments.com/v2/standard'; script.async = true;
    script.onerror = fail;
    script.onload = () => { window.clearTimeout(timer); const sdk = factory(); if (sdk) resolve(sdk); else fail(); };
    document.head.append(script);
  });
  return loading;
}
export async function openMembershipBilling({ clientKey, customerKey, subscriptionId, requestId, signal, beforeOpen }: { clientKey: string; customerKey: string; subscriptionId: string; requestId: string; signal: AbortSignal; beforeOpen: () => void }) {
  if (!/^test_ck_/.test(clientKey) || !customerKey || !subscriptionId || !requestId) throw new Error('월 자동결제 테스트 설정을 확인해 주세요.');
  const sdk = await loadSdk();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const callback = (path: string) => {
    const url = new URL(`${import.meta.env.BASE_URL}${path}`, location.origin); url.searchParams.set('membershipId', subscriptionId); url.searchParams.set('requestId', requestId); return url.href;
  };
  beforeOpen();
  await sdk(clientKey).payment({ customerKey }).requestBillingAuth({ method: 'CARD', successUrl: callback('payments/success'), failUrl: callback('payments/fail') });
}
