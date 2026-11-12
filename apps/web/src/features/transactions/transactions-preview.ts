export type PreviewRefund = {
  id: string;
  status: '접수' | '검토 중' | '완료' | '거절' | '취소';
  reason: string;
  createdAt: string;
  decision: string;
};

export type PreviewTransaction = {
  id: string;
  channel: string;
  kind: string;
  amount: number;
  createdAt: string;
  status: '결제 완료' | '결제 확인 대기' | '환불 완료' | '신청 취소';
  refund: PreviewRefund | null;
};

const number = new Intl.NumberFormat('ko-KR');
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
export const transactionDay = (value: string) => dayFormat.format(new Date(value));
export const money = (amount: number) => `${number.format(amount)}원`;
export const dateLabel = (value: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));

export function transactionStatus(transaction: PreviewTransaction) {
  if (transaction.status === '환불 완료' || transaction.refund?.status === '완료') return '환불 완료';
  if (!transaction.refund) return transaction.status;
  return { '접수': '환불 요청 접수', '검토 중': '환불 검토 중', '거절': '환불 요청 거절', '취소': '환불 요청 취소', '완료': '환불 완료' }[transaction.refund.status];
}

export function createPreviewTransactions(): PreviewTransaction[] {
  const kinds = ['메시지 후원', '음성 후원', '영상 후원', '멤버십', '미션 후원'];
  const amounts = [5000, 1000, 10000, 4900, 2000];
  const channels = ['개발하는 봄', '초록', '파도', '서재'];
  const refundStatuses = ['접수', '검토 중', '완료', '거절', '취소'] as const;
  return Array.from({ length: 26 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 10, 11 - index)).toISOString().slice(0, 10);
    const refundStatus = index >= 1 && index <= 5 ? refundStatuses[index - 1] : null;
    return {
      id: `txn-${String(index + 1).padStart(3, '0')}`,
      channel: channels[index % channels.length], kind: kinds[index % kinds.length], amount: amounts[index % amounts.length],
      createdAt: `${date}T14:32:00+09:00`,
      status: index === 3 || index === 8 ? '환불 완료' : index === 6 ? '결제 확인 대기' : index === 7 ? '신청 취소' : '결제 완료',
      refund: refundStatus ? {
        id: `refund-${index}`, status: refundStatus, reason: '선택한 후원 내역을 다시 확인하고 싶어요.', createdAt: `${date}T15:10:00+09:00`,
        decision: refundStatus === '완료' ? '환불 처리가 완료되었어요.' : refundStatus === '거절' ? '이미 제공된 내역으로 요청이 거절되었어요.' : refundStatus === '취소' ? '사용자가 요청을 취소했어요.' : '',
      } : null,
    };
  });
}
