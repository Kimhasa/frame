import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { dateLabel, money } from './transactions-preview';
import type { PreviewTransaction } from './transactions-preview';
import styles from './TransactionDialog.module.css';

type View = 'detail' | 'request' | 'refund' | 'policy';

function Status({ value }: { value: string }) {
  return <StatusBadge tone={value === '결제 완료' ? 'positive' : ['접수', '검토 중', '결제 확인 대기'].includes(value) ? 'warning' : value === '거절' ? 'danger' : 'neutral'}>{value}</StatusBadge>;
}

export function TransactionDialog({ transaction, onDismiss }: {
  transaction: PreviewTransaction;
  onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const consentInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const [view, setView] = useState<View>('detail');
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(false);
  const [reasonError, setReasonError] = useState('');
  const [consentError, setConsentError] = useState('');
  const [serviceError, setServiceError] = useState('');
  const refund = transaction.refund;
  const canRequest = transaction.status === '결제 완료' && !refund;
  const title = view === 'request' ? '환불 요청' : view === 'refund' ? '환불 요청 내역' : view === 'policy' ? '취소·환불 기준' : '결제 상세';

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    setServiceError('');
    if (view === 'request') reasonInput.current?.focus();
    else heading.current?.focus({ preventScroll: true });
  }, [view]);

  function dismiss() {
    if (view === 'policy') { setView('request'); return; }
    dialog.current?.close();
    onDismiss();
  }

  function cancelRequest() {
    setReason('');
    setConsent(false);
    setReasonError('');
    setConsentError('');
    setView('detail');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRequest) return;
    const trimmed = reason.trim();
    const invalidReason = trimmed.length < 5 || trimmed.length > 500;
    setReasonError(invalidReason ? '요청 사유를 5~500자로 입력해 주세요.' : '');
    setConsentError(consent ? '' : '취소·환불 기준을 확인해 주세요.');
    if (invalidReason) { reasonInput.current?.focus(); return; }
    if (!consent) { consentInput.current?.focus(); return; }
    setServiceError('결제 서비스를 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
  }

  function withdraw() {
    if (refund?.status !== '접수') return;
    setServiceError('결제 서비스를 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={`${id}-title`}
    onKeyDown={event => {
      if (event.key === 'Escape' && view === 'policy') { event.preventDefault(); event.stopPropagation(); setView('request'); }
    }} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{title}</h2>
      <button type="button" className="icon-button" aria-label={view === 'policy' ? '취소·환불 기준 닫기' : '결제 상세 닫기'} onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    {view === 'detail' && <>
      <dl className={styles.info}>
        <div><dt>거래 번호</dt><dd>{transaction.id}</dd></div>
        <div><dt>결제일</dt><dd>{dateLabel(transaction.createdAt)}</dd></div>
        <div><dt>채널</dt><dd>{transaction.channel}</dd></div>
        <div><dt>내용</dt><dd>{transaction.kind}</dd></div>
        <div><dt>금액</dt><dd className={styles.amount}>{money(transaction.amount)}</dd></div>
        <div><dt>결제 상태</dt><dd><Status value={transaction.status} /></dd></div>
        {refund && <div><dt>환불 상태</dt><dd><Status value={refund.status} /></dd></div>}
      </dl>
      <div className={ui.dialogActions}>
        {canRequest && <button type="button" className={ui.button} onClick={() => setView('request')}>환불 요청</button>}
        {refund && <button type="button" className={ui.button} onClick={() => setView('refund')}>환불 요청 내역</button>}
        <button type="button" className={ui.button} onClick={dismiss}>닫기</button>
      </div>
    </>}
    {view === 'request' && <>
      <dl className={styles.info}>
        <div><dt>대상</dt><dd>{transaction.channel} · {transaction.kind}</dd></div>
        <div><dt>금액</dt><dd className={styles.amount}>{money(transaction.amount)}</dd></div>
      </dl>
      <form className={styles.form} noValidate onSubmit={submit}>
        <label className={styles.field}>요청 사유<textarea className={ui.control} ref={reasonInput} name="refund-reason" rows={4} maxLength={500} value={reason}
          aria-invalid={Boolean(reasonError)} aria-describedby={reasonError ? `${id}-reason-error` : `${id}-reason-help`}
          onChange={event => { setReason(event.target.value); setReasonError(''); setServiceError(''); }} /></label>
        {reasonError ? <p id={`${id}-reason-error`} className={styles.error} role="alert">{reasonError}</p>
          : <p id={`${id}-reason-help`} className={styles.hint}>5~500자 이내로 입력해 주세요.</p>}
        <label className={styles.consent}><input className={ui.checkbox} ref={consentInput} type="checkbox" name="refund-consent" checked={consent}
          aria-invalid={Boolean(consentError)} aria-describedby={consentError ? `${id}-consent-error` : undefined}
          onChange={event => { setConsent(event.target.checked); setConsentError(''); setServiceError(''); }} /><span>결제 내용과 취소·환불 기준을 확인했어요.</span></label>
        {consentError && <p id={`${id}-consent-error`} className={styles.error} role="alert">{consentError}</p>}
        <button type="button" className={styles.policyButton} onClick={() => setView('policy')}>취소·환불 기준</button>
        <div className={ui.dialogActions}>
          <button type="button" className={ui.button} onClick={cancelRequest}>취소</button>
          <button type="submit" className={`${ui.button} ${ui.primary}`}>환불 요청</button>
        </div>
      </form>
    </>}
    {view === 'refund' && refund && <>
      <dl className={styles.info}>
        <div><dt>접수 번호</dt><dd>{refund.id}</dd></div>
        <div><dt>접수일</dt><dd>{dateLabel(refund.createdAt)}</dd></div>
        <div><dt>상태</dt><dd><Status value={refund.status} /></dd></div>
        <div><dt>대상 거래</dt><dd>{transaction.id}</dd></div>
        <div><dt>금액</dt><dd className={styles.amount}>{money(transaction.amount)}</dd></div>
        <div><dt>사유</dt><dd className={styles.multiline}>{refund.reason}</dd></div>
        <div><dt>결과 안내</dt><dd>{refund.decision || '검토 중에는 원래 결제 상태를 유지해요.'}</dd></div>
      </dl>
      <div className={ui.dialogActions}>
        {refund.status === '접수' && <button type="button" className={`${ui.button} ${ui.danger}`} onClick={withdraw}>요청 취소</button>}
        <button type="button" className={ui.button} onClick={() => setView('detail')}>결제 상세</button>
        <button type="button" className={ui.button} onClick={dismiss}>닫기</button>
      </div>
    </>}
    {view === 'policy' && <>
      <dl className={styles.policy}>
        <div><dt>결제 확인 전</dt><dd>신청 내용을 취소할 수 있어요.</dd></div>
        <div><dt>서비스 이용 후</dt><dd>거래와 제공 여부를 확인해 검토해요.</dd></div>
        <div><dt>처리 결과</dt><dd>결제 내역의 환불 요청에서 확인하세요.</dd></div>
      </dl>
      <div className={ui.dialogActions}><button type="button" className={ui.button} onClick={() => setView('request')}>돌아가기</button></div>
    </>}
    {serviceError && <p className={styles.error} role="alert">{serviceError}</p>}
  </dialog>;
}
