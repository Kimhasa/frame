import { useEffect, useState } from 'react';
import { ManagementPage, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { TransactionsPage } from '../transactions/TransactionsPage';
import { getPaymentOrders } from './payments-client';
import type { PaymentOrder } from './payments-client';
import type { PreviewChannel } from '../../preview/community-types';
import type { PreviewTransaction } from '../transactions/transactions-preview';

export function PaymentHistoryPage({ channels }: { channels: readonly PreviewChannel[] }) {
  const [orders, setOrders] = useState<PaymentOrder[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void getPaymentOrders(abort.signal).then(setOrders).catch(failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '결제 내역을 불러오지 못했어요.'); });
    return () => abort.abort();
  }, [attempt]);
  if (error) return <ManagementPage title="결제 내역" titleId="transactions-title"><EmptyState title="결제 내역을 불러오지 못했어요" description={error} action={<button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}>다시 시도</button>} /></ManagementPage>;
  if (!orders) return <ManagementPage title="결제 내역" titleId="transactions-title"><p role="status">결제 내역을 불러오는 중이에요.</p></ManagementPage>;
  const items: PreviewTransaction[] = orders.map(order => ({ id: order.orderId, channel: channels.find(channel => channel.handle === order.channel)?.displayName ?? order.channel,
    kind: `${order.kind} 후원`, amount: order.amount, createdAt: order.approvedAt ?? order.createdAt, status: order.status === 'DONE' ? '결제 완료' : '결제 확인 대기', refund: null }));
  return <TransactionsPage items={items} />;
}
