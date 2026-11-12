import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { PreviewChannel } from '../../preview/community-types';
import { money } from '../transactions/transactions-preview';
import { donationKinds, parseDonationAmount, validVideoStart, validVideoUrl } from './donation-preview';
import type { DonationDraft, DonationKind } from './donation-preview';
import { createPaymentOrder, getPaymentConfig } from '../payments/payments-client';
import type { PaymentOrder } from '../payments/payments-client';
import { openTossPayment } from '../payments/toss-sdk';
import styles from './DonationDialog.module.css';

type View = 'form' | 'preview' | 'policy';
type Errors = Partial<Record<'amount' | 'message' | 'videoUrl' | 'start' | 'consent' | 'form', string>>;
const defaults = (): DonationDraft => ({ kind: '메시지', amount: '5000', message: '', videoUrl: '', start: '00:00', payment: '', consent: false });

export function DonationDialog({ channel, onDismiss, signedIn, onLogin, initialDraft }: {
  channel: PreviewChannel;
  onDismiss: () => void;
  signedIn: boolean;
  onLogin: (draft: DonationDraft) => void;
  initialDraft?: DonationDraft;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const [draft, setDraft] = useState<DonationDraft>(() => ({ ...defaults(), ...initialDraft }));
  const [manualAmount, setManualAmount] = useState(() => Boolean(initialDraft && !['1000', '5000', '10000'].includes(initialDraft.amount)));
  const [view, setView] = useState<View>('form');
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const request = useRef<AbortController | null>(null);
  const order = useRef<{ fingerprint: string; value: PaymentOrder } | null>(null);
  const controls = useRef({ pending: false, dismiss: () => {} });
  const amount = parseDonationAmount(draft.amount);
  const title = view === 'policy' ? '취소·환불 기준' : view === 'preview' ? `${draft.kind} 후원 확인` : '후원하기';

  useEffect(() => {
    const element = dialog.current;
    const cancel = (event: Event) => { event.preventDefault(); if (!controls.current.pending) controls.current.dismiss(); };
    element?.addEventListener('cancel', cancel);
    alive.current = true;
    element?.showModal();
    return () => { alive.current = false; request.current?.abort(); element?.removeEventListener('cancel', cancel); element?.close(); };
  }, []);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [view]);

  function close() {
    if (inFlight.current) return;
    dialog.current?.close();
    onDismiss();
  }

  function dismiss() {
    if (view === 'policy' || view === 'preview') { setView('form'); return; }
    close();
  }

  function update<K extends keyof DonationDraft>(key: K, value: DonationDraft[K]) {
    if (inFlight.current) return;
    setDraft(previous => ({ ...previous, [key]: value }));
    setErrors(previous => ({ ...previous, [key]: undefined, form: undefined }));
  }

  function validate(submitting: boolean) {
    const next: Errors = {};
    if (amount === null) next.amount = '금액은 1,000~10,000,000원 사이의 정수로 입력해 주세요.';
    if ((draft.kind === '음성' && !draft.message.trim()) || draft.message.length > 300) next.message = draft.kind === '음성' ? '읽어줄 메시지를 1~300자로 입력해 주세요.' : '메시지는 300자 이내로 입력해 주세요.';
    if (draft.kind === '영상') {
      if (!validVideoUrl(draft.videoUrl)) next.videoUrl = 'https://로 시작하는 영상 주소를 입력해 주세요.';
      if (!validVideoStart(draft.start)) next.start = '분:초 또는 시:분:초로 입력해 주세요.';
    }
    if (submitting) {
      if (!draft.consent) next.consent = '결제 내용과 취소·환불 기준을 확인해 주세요.';
    }
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) {
      dialog.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return false;
    }
    return true;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !validate(true) || amount === null) return;
    if (!signedIn) {
      dialog.current?.close();
      onLogin({ ...draft });
      return;
    }
    inFlight.current = true; setPending(true);
    const abort = new AbortController(); request.current = abort;
    try {
      const config = await getPaymentConfig(abort.signal);
      if (!config.enabled || !config.clientKey || !/^test_gck_/.test(config.clientKey)) throw new Error('결제 서비스를 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
      const fingerprint = JSON.stringify([channel.handle, draft.kind, amount, draft.message.trim(), draft.videoUrl.trim(), draft.start.trim()]);
      const currentOrder = order.current?.fingerprint === fingerprint ? order.current.value : await createPaymentOrder(channel.handle, draft, amount, abort.signal);
      if (currentOrder.amount !== amount || currentOrder.channel !== channel.handle || currentOrder.kind !== draft.kind) throw new Error('후원 내용을 확인하지 못했어요. 다시 시도해 주세요.');
      order.current = { fingerprint, value: currentOrder };
      if (abort.signal.aborted) return;
      // The browser's top-layer dialog must close before Toss renders its own payment window.
      dialog.current?.close();
      await openTossPayment(config.clientKey, currentOrder, abort.signal);
      if (alive.current) setErrors({ form: '결제를 취소했어요.' });
    } catch (failure) {
      if (alive.current && !abort.signal.aborted) {
        const message = failure instanceof Error ? failure.message : '결제창을 열지 못했어요. 잠시 후 다시 시도해 주세요.';
        setErrors({ form: message });
      }
    } finally {
      inFlight.current = false; request.current = null;
      if (alive.current) { setPending(false); if (!dialog.current?.open) dialog.current?.showModal(); heading.current?.focus({ preventScroll: true }); }
    }
  }

  function setKind(kind: DonationKind) { update('kind', kind); setErrors({}); }

  function tabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (inFlight.current) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = donationKinds.indexOf(draft.kind);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? donationKinds.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + donationKinds.length) % donationKinds.length;
    setKind(donationKinds[next]);
    tabList.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }

  function error(key: keyof Errors) {
    return errors[key] ? <p id={`${id}-${key}-error`} className={styles.error} role="alert">{errors[key]}</p> : null;
  }

  controls.current = { pending, dismiss };

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`}
    onKeyDown={event => {
      if (event.key === 'Escape' && pending) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === 'Escape' && (view === 'policy' || view === 'preview')) { event.preventDefault(); event.stopPropagation(); setView('form'); }
    }}>
    <header className={styles.header}><h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{title}</h2>
      <button type="button" className="icon-button" disabled={pending} aria-label={view === 'policy' || view === 'preview' ? '후원 작성으로 돌아가기' : '후원하기 닫기'} onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className={styles.recipient}><span className={styles.avatar} aria-hidden="true">{channel.displayName.trim()[0] ?? 'F'}</span><strong>{channel.displayName}</strong></div>
    {view === 'form' && <>
      <div ref={tabList} className={styles.tabs} role="tablist" aria-label="후원 방식" onKeyDown={tabKey}>
        {donationKinds.map(kind => <button key={kind} type="button" role="tab" disabled={pending} id={`${id}-tab-${kind}`} aria-selected={draft.kind === kind} tabIndex={draft.kind === kind ? 0 : -1}
          aria-controls={`${id}-panel`} onClick={() => setKind(kind)}>{kind}</button>)}
      </div>
      <section id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${draft.kind}`}>
        <form noValidate className={styles.form} onSubmit={submit}>
          <fieldset className={styles.paymentFields} disabled={pending}>
          <div className={styles.amounts} role="group" aria-label="후원 금액 선택">
            {[1000, 5000, 10000].map(value => <button key={value} type="button" className={styles.button} aria-pressed={!manualAmount && amount === value} onClick={() => { update('amount', String(value)); setManualAmount(false); }}>{money(value)}</button>)}
            <button type="button" className={styles.button} aria-pressed={manualAmount} onClick={() => { setManualAmount(true); amountInput.current?.focus(); }}>직접 입력</button>
          </div>
          <label className={styles.field}>금액<input ref={amountInput} name="amount" inputMode="numeric" maxLength={32} value={draft.amount}
            aria-invalid={Boolean(errors.amount)} aria-describedby={errors.amount ? `${id}-amount-error` : `${id}-amount-help`}
            onChange={event => { update('amount', event.target.value); setManualAmount(true); }} /></label>
          {error('amount') || <p id={`${id}-amount-help`} className={styles.hint}>1,000원부터 10,000,000원까지</p>}
          {draft.kind === '영상' && <>
            <label className={styles.field}>영상 주소<input name="videoUrl" type="url" inputMode="url" maxLength={500} placeholder="https://" value={draft.videoUrl}
              aria-invalid={Boolean(errors.videoUrl)} aria-describedby={errors.videoUrl ? `${id}-videoUrl-error` : undefined} onChange={event => update('videoUrl', event.target.value)} /></label>
            {error('videoUrl')}
            <label className={styles.field}>재생 시작<input name="start" maxLength={8} placeholder="00:00" value={draft.start} aria-invalid={Boolean(errors.start)}
              aria-describedby={errors.start ? `${id}-start-error` : `${id}-start-help`} onChange={event => update('start', event.target.value)} /></label>
            {error('start') || <p id={`${id}-start-help`} className={styles.hint}>분:초 또는 시:분:초</p>}
          </>}
          <label className={styles.field}>{draft.kind === '음성' ? '읽어줄 메시지' : '메시지 (선택)'}<textarea name="message" maxLength={300} rows={3} value={draft.message}
            placeholder={draft.kind === '음성' ? '음성으로 읽을 내용을 입력하세요.' : '메시지를 입력하세요.'} aria-invalid={Boolean(errors.message)}
            aria-describedby={errors.message ? `${id}-message-error` : undefined} onChange={event => update('message', event.target.value)} /></label>
          {error('message')}
          {draft.kind !== '메시지' && <button type="button" className={styles.previewButton} onClick={() => { if (validate(false)) setView('preview'); }}>내용 미리보기</button>}
          <label className={styles.consent}><input type="checkbox" name="consent" checked={draft.consent} aria-invalid={Boolean(errors.consent)}
            aria-describedby={errors.consent ? `${id}-consent-error` : undefined} onChange={event => update('consent', event.target.checked)} /><span>결제 내용과 취소·환불 기준을 확인했어요.</span></label>
          {error('consent')}
          <button type="button" className={styles.policyButton} onClick={() => setView('policy')}>취소·환불 기준</button>
          {error('form')}
          <footer className={styles.actions}><button type="button" className={styles.button} onClick={close}>취소</button><button type="submit" className={`${styles.button} ${styles.primary}`}>{pending ? '결제창 연결 중' : `${amount !== null ? money(amount) + ' ' : ''}후원 신청`}</button></footer>
          </fieldset>
        </form>
      </section>
    </>}
    {view === 'preview' && <>
      <dl className={styles.summary}><div><dt>유형</dt><dd>{draft.kind}</dd></div><div><dt>금액</dt><dd>{money(amount ?? 0)}</dd></div>
        {draft.kind === '영상' ? <><div><dt>영상 주소</dt><dd>{draft.videoUrl.trim()}</dd></div><div><dt>재생 시작</dt><dd>{draft.start.trim()}</dd></div></> : <div><dt>읽어줄 메시지</dt><dd className={styles.multiline}>{draft.message.trim()}</dd></div>}
      </dl><footer className={styles.actions}><button type="button" className={styles.button} onClick={() => setView('form')}>수정</button><button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => setView('form')}>확인</button></footer>
    </>}
    {view === 'policy' && <>
      <dl className={styles.policy}>
        <div><dt>결제 확인 전</dt><dd>신청 내용을 취소할 수 있어요.</dd></div><div><dt>서비스 이용 후</dt><dd>거래와 제공 여부를 확인해 검토해요.</dd></div><div><dt>처리 결과</dt><dd>결제 내역의 환불 요청에서 확인하세요.</dd></div>
      </dl><footer className={styles.actions}><button type="button" className={styles.button} onClick={() => setView('form')}>돌아가기</button></footer>
    </>}
  </dialog>;
}
