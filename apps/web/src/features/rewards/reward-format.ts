import type { ProductRedemption } from './rewards-client';

export const redemptionStatusLabel: Record<ProductRedemption['status'], string> = {
  pending: '신청 대기', processing: '처리 중', completed: '제공 완료', rejected: '거절', canceled: '취소',
};
export const redemptionTone = {
  pending: 'warning', processing: 'info', completed: 'positive', rejected: 'danger', canceled: 'neutral',
} as const;
const points = new Intl.NumberFormat('ko-KR');
const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const formatPoints = (value: number) => `${points.format(value)} P`;
export const formatRewardDate = (value: number) => date.format(value);
