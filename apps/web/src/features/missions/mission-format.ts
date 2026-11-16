import type { MissionStatus } from './missions-client';

export const missionStatusLabel: Record<MissionStatus, string> = {
  received: '접수', running: '진행 중', completed: '완료', rejected: '거절', canceled: '취소', expired: '기한 만료', failed: '실패',
};
export const missionTone = { received: 'warning', running: 'info', completed: 'positive', rejected: 'neutral', canceled: 'neutral', expired: 'neutral', failed: 'danger' } as const;
const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const formatMissionDate = (value: number) => date.format(value);
