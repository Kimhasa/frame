import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './Membership.module.css';
import type { Membership } from './membership-client';

export const membershipMoney = (value: number) => `${new Intl.NumberFormat('ko-KR').format(value)}원`;
export function membershipDate(value: number | null) { return value === null ? '없음' : new Date(value).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
export function MembershipModal({ title, busy, locked = false, onClose, children, elementRef }: { title: string; busy: boolean; locked?: boolean; onClose: () => void; children: ReactNode; elementRef?: RefObject<HTMLDialogElement | null> }) {
  const ownRef = useRef<HTMLDialogElement>(null), dialog = elementRef ?? ownRef, heading = useRef<HTMLHeadingElement>(null), returnFocus = useRef<HTMLElement | null>(null), titleId = useId();
  useEffect(() => { const element = dialog.current; returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; element?.showModal(); heading.current?.focus(); return () => { element?.close(); returnFocus.current?.focus(); }; }, []);
  return <div className={`${ui.page} ${styles.modalHost}`}><dialog ref={dialog} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={titleId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy && !locked) onClose(); }}><header className={ui.dialogHeader}><h2 ref={heading} tabIndex={-1} id={titleId}>{title}</h2><button type="button" className="icon-button" disabled={busy || locked} aria-label="닫기" onClick={onClose}><X size={20} aria-hidden="true" /></button></header>{children}</dialog></div>;
}
export function MembershipStatus({ item }: { item: Membership }) {
  const labels: Record<Membership['status'], string> = { pending_auth: '카드 등록 대기', issuing: '카드 등록 확인 중', issue_unknown: '카드 등록 결과 미확정', pending_charge: '결제 확인 대기', active: '이용 중', ended: '이용 종료', failed: '결제 실패' };
  const cancelled = item.cancelRequestedAtMs !== null;
  return <StatusBadge tone={cancelled ? 'warning' : item.status === 'active' ? 'positive' : item.status === 'failed' ? 'danger' : item.status === 'ended' ? 'neutral' : 'warning'}>{cancelled ? item.entitled ? '해지 예약' : '해지됨' : labels[item.status]}</StatusBadge>;
}
export function MembershipDetails({ item }: { item: Membership }) {
  return <><dl className={styles.info}><div><dt>채널</dt><dd>{item.channel.displayName}</dd></div><div><dt>가입 상태</dt><dd><MembershipStatus item={item} /></dd></div><div><dt>월 이용료</dt><dd>{membershipMoney(item.amount)} · 매월 자동결제</dd></div><div><dt>가입일</dt><dd>{membershipDate(item.createdAtMs)}</dd></div><div><dt>이용 기간</dt><dd>{item.periodStartedAtMs !== null ? `${membershipDate(item.periodStartedAtMs)} ~ ${membershipDate(item.periodEndsAtMs)}` : '결제 승인 후 시작'}</dd></div><div><dt>다음 결제</dt><dd>{item.cancelRequestedAtMs !== null || item.status === 'ended' ? '자동결제 없음' : item.nextChargeAtMs === null ? '결제 승인 후 안내' : membershipDate(item.nextChargeAtMs)}</dd></div>{item.cancelRequestedAtMs !== null && <div><dt>해지 신청일</dt><dd>{membershipDate(item.cancelRequestedAtMs)}</dd></div>}{item.cardLabel && <div><dt>등록 카드</dt><dd>{item.cardLabel}</dd></div>}</dl>{item.benefits && <p className={styles.benefits}>{item.benefits}</p>}{item.status === 'pending_auth' && item.cancelRequestedAtMs === null && <p className={styles.hint}>카드 등록을 완료하지 않은 가입 요청이에요. 등록창을 다시 열 수 없다면 이 요청을 해지한 뒤 새로 가입해 주세요.</p>}{item.paymentPending && <p className={styles.warning}>결제 결과를 확인하고 있어요. 추가 결제를 진행하지 말고 상태 확인을 눌러 주세요.</p>}{item.status === 'issue_unknown' && <p className={styles.warning}>카드 등록 결과를 확정하지 못했어요. 같은 인증으로 다시 등록하지 않아요. 해지 후 새로 가입해 주세요.</p>}{item.cancelRequestedAtMs !== null && <p className={styles.hint}>다음 자동결제를 중지했어요.{item.entitled ? ` 이미 결제한 ${membershipDate(item.periodEndsAtMs)}까지 이용할 수 있어요.` : ''} 해지는 결제 환불이 아니에요.</p>}</>;
}
