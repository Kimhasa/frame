import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { channelPath, transactionsPath } from '../../preview/community-types';
import { dateLabel, money } from '../transactions/transactions-preview';
import { confirmPayment, getPaymentOrder, receiptLink } from './payments-client';
import type { PaymentOrder } from './payments-client';
import styles from './Payments.module.css';

function callbackValues() {
  const query = new URLSearchParams(location.search);
  const orderId = query.get('orderId') ?? '';
  const raw = query.get('amount') ?? '';
  return { orderId, paymentKey: query.get('paymentKey') ?? '', amount: /^\d+$/.test(raw) ? Number(raw) : null,
    cancelled: query.get('code') === 'PAY_PROCESS_CANCELED' };
}

export function PaymentResultPage({ failed = false }: { failed?: boolean }) {
  const [callback] = useState(callbackValues);
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(!failed);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const query = new URLSearchParams(); if (/^[A-Za-z0-9_=-]{6,64}$/.test(callback.orderId)) query.set('orderId', callback.orderId);
    const search = query.toString();
    history.replaceState(history.state, '', `${location.pathname}${search ? '?' + search : ''}`);
    if (failed) return;
    let active = true;
    async function confirm() {
      setPending(true); setError('');
      try {
        if (!/^[A-Za-z0-9_=-]{6,64}$/.test(callback.orderId)) throw new Error('주문 정보를 확인할 수 없어요. 결제 내역을 확인해 주세요.');
        let result: PaymentOrder;
        if (callback.paymentKey) {
          if (callback.paymentKey.length > 300 || !Number.isSafeInteger(callback.amount) || callback.amount! < 1000 || callback.amount! > 10_000_000) throw new Error('결제 요청 정보를 확인할 수 없어요.');
          result = await confirmPayment(callback.orderId, callback.paymentKey, callback.amount!);
        } else result = await getPaymentOrder(callback.orderId);
        if (result.status !== 'DONE') throw new Error('결제 확인이 진행 중이에요. 결제 내역에서 상태를 확인해 주세요.');
        if (active) setOrder(result);
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : '결제 결과를 확인하지 못했어요.'); }
      finally { if (active) setPending(false); }
    }
    void confirm();
    return () => { active = false; };
  }, [callback, failed, attempt]);

  const title = pending ? '결제를 확인하고 있어요' : order ? '결제가 완료되었어요' : failed ? callback.cancelled ? '결제를 취소했어요' : '결제를 완료하지 못했어요' : '결제 결과를 확인하지 못했어요';
  const receipt = receiptLink(order?.receiptUrl);
  return <ManagementPage title="결제 결과" titleId="payment-result-title">
    <section className={styles.result} aria-busy={pending}>
      <span className={`${styles.resultIcon} ${!pending && !order ? styles.failure : ''}`} aria-hidden="true">{pending ? <LoaderCircle className={styles.spinner} size={28} /> : order ? <CircleCheck size={28} /> : <CircleX size={28} />}</span>
      <h2>{title}</h2>
      {pending && <p role="status">확인이 끝날 때까지 잠시 기다려 주세요.</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {order && <dl className={styles.details}><div><dt>주문번호</dt><dd>{order.orderId}</dd></div><div><dt>내용</dt><dd>{order.orderName}</dd></div><div><dt>결제 금액</dt><dd>{money(order.amount)}</dd></div><div><dt>결제수단</dt><dd>{order.method || '—'}</dd></div>{order.approvedAt && <div><dt>결제일</dt><dd>{dateLabel(order.approvedAt)}</dd></div>}</dl>}
      {!pending && <div className={styles.actions}>
        {error && <button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}>다시 확인</button>}
        {receipt && <a className={ui.button} href={receipt} target="_blank" rel="noreferrer">영수증</a>}
        {order && <Link className={ui.button} to={channelPath(order.channel)}>채널로 돌아가기</Link>}
        <Link className={`${ui.button} ${ui.primary}`} to={transactionsPath}>결제 내역</Link>
        {!order && <Link className={ui.button} to="/live">라이브로 돌아가기</Link>}
      </div>}
    </section>
  </ManagementPage>;
}
