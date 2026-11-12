import { RefreshCw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { rewardsApi } from './rewards-client';
import type { ProductReward, ProductRedemption, RewardInput } from './rewards-client';
import { formatPoints, formatRewardDate, redemptionStatusLabel, redemptionTone } from './reward-format';
import styles from './ConnectedRewardsPage.module.css';

type AccessError = (failure: unknown) => boolean;
type DialogProps = { session: AccountSession; onClose: () => void; onSaved: (message: string) => void; onAccessError: AccessError };
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
type ProcessingStatus = Exclude<ProductRedemption['status'], 'pending'>;
const editableStatuses: ProcessingStatus[] = ['processing', 'completed', 'rejected', 'canceled'];

function Frame({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef(document.activeElement), id = useId();
  useEffect(() => {
    const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      else document.getElementById('rewards-title')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={id} aria-busy={busy} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className={ui.dialogHeader}><h2 ref={heading} id={id} tabIndex={-1}>{title}</h2><button type="button" className="icon-button" aria-label={`${title} 닫기`} disabled={busy} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>{children}
  </dialog>;
}

function Conflict({ confirming, busy, onConfirm, onKeep, onLoad }: { confirming: boolean; busy: boolean; onConfirm: () => void; onKeep: () => void; onLoad: () => void }) {
  return <div className={styles.conflict} role="alert"><p>다른 화면에서 내용이 바뀌었어요. 작성한 내용은 유지돼요.</p>{confirming ? <><p>입력을 버리고 서버의 최신 내용을 불러올까요?</p><div className={ui.dialogActions}><button type="button" className={ui.button} disabled={busy} onClick={onKeep}>입력 유지</button><button type="button" className={`${ui.button} ${ui.primary}`} disabled={busy} onClick={onLoad}>{busy ? '불러오는 중…' : '불러오기'}</button></div></> : <button type="button" className={ui.button} onClick={onConfirm}><RefreshCw size={16} aria-hidden="true" />최신 상태 불러오기</button>}</div>;
}

export function RewardEditor({ rewardId, session, onClose, onSaved, onAccessError }: DialogProps & { rewardId: string | null }) {
  const id = useId(), active = useRef(true), abort = useRef<AbortController | null>(null), fetching = useRef(false), writing = useRef(false), access = useRef(onAccessError); access.current = onAccessError;
  const nameInput = useRef<HTMLInputElement>(null), pointsInput = useRef<HTMLInputElement>(null), originalRequest = useRef<RewardInput | null>(null);
  const [detail, setDetail] = useState<ProductReward | null>(null), [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(rewardId ? 'loading' : 'ready');
  const [name, setName] = useState(''), [points, setPoints] = useState('1000'), [limit, setLimit] = useState<ProductReward['limit']>('once_per_broadcast'), [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [invalid, setInvalid] = useState(''), [conflict, setConflict] = useState(false), [confirming, setConfirming] = useState(false), [uncertain, setUncertain] = useState(false);
  const dirty = !rewardId || Boolean(detail && (name !== detail.name || points !== String(detail.points) || limit !== detail.limit || enabled !== detail.enabled));
  async function load() {
    if (!rewardId || fetching.current || writing.current) return;
    const request = new AbortController(); abort.current = request; fetching.current = true; setLoading(true); setLoadError('');
    try {
      const result = await rewardsApi.reward(rewardId, request.signal, session.user!.id);
      if (request.signal.aborted) return;
      setDetail(result.item); setName(result.item.name); setPoints(String(result.item.points)); setLimit(result.item.limit); setEnabled(result.item.enabled); setPhase('ready'); setConflict(false); setConfirming(false); setError(''); setInvalid('');
    } catch (failure) { if (!request.signal.aborted && !access.current(failure)) { setLoadError(message(failure, '보상을 불러오지 못했어요.')); setPhase(previous => previous === 'ready' ? previous : 'error'); } }
    finally { if (abort.current === request) { fetching.current = false; if (!request.signal.aborted) setLoading(false); } }
  }
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; abort.current?.abort(); fetching.current = false; }; }, [rewardId, session.user!.id]);
  function dismiss() { if (!writing.current && !fetching.current) onClose(); }
  function changed() { setInvalid(''); if (!conflict) setError(''); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (writing.current || fetching.current || conflict || !dirty) return;
    const normalized = name.trim().normalize('NFC'), cost = Number(points);
    if (!originalRequest.current && (!normalized || [...normalized].length > 40 || /[\u0000-\u001f\u007f]/.test(normalized))) { setInvalid('name'); setError('보상 이름을 1~40자로 입력해 주세요.'); nameInput.current?.focus(); return; }
    if (!originalRequest.current && (!/^\d{1,7}$/.test(points) || !Number.isSafeInteger(cost) || cost < 1 || cost > 1_000_000)) { setInvalid('points'); setError('필요 포인트를 1~1,000,000 사이 정수로 입력해 주세요.'); pointsInput.current?.focus(); return; }
    const values = { name: normalized, points: cost, limit, enabled };
    if (!rewardId && !originalRequest.current) originalRequest.current = { ...values, clientRequestId: crypto.randomUUID() };
    writing.current = true; setPending(true); setError(''); setLoadError(''); setInvalid('');
    try {
      if (rewardId) { if (!detail) return; await rewardsApi.updateReward(rewardId, { ...values, version: detail.version }, session.csrfToken, session.user!.id); }
      else await rewardsApi.createReward(originalRequest.current!, session.csrfToken, session.user!.id);
      if (active.current) onSaved(rewardId ? '보상 설정을 변경했어요.' : '보상을 추가했어요.');
    } catch (failure) {
      if (!active.current || access.current(failure)) return;
      setError(message(failure, '보상을 저장하지 못했어요. 입력한 내용은 유지돼요.'));
      if (!rewardId && (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500)) { setUncertain(true); setError('저장 결과를 확인하지 못했어요. 같은 내용으로 다시 확인해 주세요.'); }
      else { originalRequest.current = null; setUncertain(false); }
      if (failure instanceof AccountError && failure.code === 'REWARD_CONFLICT') setConflict(true);
    } finally { writing.current = false; if (active.current) setPending(false); }
  }
  return <Frame title={rewardId ? '보상 수정' : '보상 추가'} busy={pending || loading || phase === 'loading'} onClose={dismiss}>
    {phase === 'loading' ? <p className={styles.loading} role="status">보상을 불러오는 중이에요.</p> : phase === 'error' ? <><p className={styles.error} role="alert">{loadError}</p><button type="button" className={ui.button} disabled={loading} onClick={() => void load()}>{loading ? '불러오는 중…' : '보상 다시 시도'}</button></> : <form noValidate onSubmit={submit}>
      <fieldset className={styles.editor} disabled={pending || loading || uncertain}>
        <label><span className={styles.fieldHeading}><span>보상 이름</span><small>{[...name].length} / 40</small></span><input ref={nameInput} className={ui.control} name="reward-name" maxLength={80} value={name} aria-invalid={invalid === 'name'} aria-describedby={invalid === 'name' ? `${id}-error` : undefined} onChange={event => { setName(event.target.value); changed(); }} /></label>
        <label>필요 포인트<input ref={pointsInput} className={ui.control} name="reward-points" inputMode="numeric" autoComplete="off" maxLength={7} value={points} aria-invalid={invalid === 'points'} aria-describedby={invalid === 'points' ? `${id}-error` : `${id}-points-help`} onChange={event => { setPoints(event.target.value); changed(); }} /><small className={styles.hint} id={`${id}-points-help`}>1~1,000,000 P · 신청이 접수될 때 차감돼요.</small></label>
        <label>교환 제한<select className={ui.control} name="reward-limit" value={limit} onChange={event => { setLimit(event.target.value as ProductReward['limit']); changed(); }}><option value="once_per_broadcast">방송당 1회</option><option value="unlimited">무제한</option></select><small className={styles.hint}>방송당 1회 보상은 취소·거절 후에도 같은 방송에서 다시 신청할 수 없어요.</small></label>
        <AuthCheckbox className={styles.enabled} name="reward-enabled" checked={enabled} onChange={event => { setEnabled(event.target.checked); changed(); }}><strong>보상 사용</strong><small>끄면 새 신청을 받지 않아요. 접수한 요청과 포인트 내역은 유지돼요.</small></AuthCheckbox>
      </fieldset>
      {loadError && <p className={styles.error} role="alert">{loadError} 입력한 내용은 유지돼요.</p>}
      {error && !conflict && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
      {conflict && <Conflict confirming={confirming} busy={loading} onConfirm={() => setConfirming(true)} onKeep={() => setConfirming(false)} onLoad={() => void load()} />}
      <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending || loading} onClick={dismiss}>닫기</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={pending || loading || conflict || !dirty}>{pending ? '저장 중…' : uncertain ? '저장 다시 확인' : '저장'}</button></div>
    </form>}
  </Frame>;
}

export function RedemptionEditor({ redemptionId, session, onClose, onSaved, onAccessError }: DialogProps & { redemptionId: string }) {
  const id = useId(), active = useRef(true), abort = useRef<AbortController | null>(null), fetching = useRef(false), writing = useRef(false), access = useRef(onAccessError); access.current = onAccessError;
  const reasonInput = useRef<HTMLTextAreaElement>(null), [detail, setDetail] = useState<ProductRedemption | null>(null), [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [status, setStatus] = useState<ProcessingStatus>('processing'), [reason, setReason] = useState(''), [pending, setPending] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [invalid, setInvalid] = useState(false), [conflict, setConflict] = useState(false), [confirming, setConfirming] = useState(false);
  const canProcess = detail?.status === 'pending' || detail?.status === 'processing', available = editableStatuses.filter(value => value !== detail?.status);
  async function load() {
    if (fetching.current || writing.current) return;
    const request = new AbortController(); abort.current = request; fetching.current = true; setLoading(true); setLoadError('');
    try {
      const result = await rewardsApi.redemption(redemptionId, request.signal, session.user!.id);
      if (request.signal.aborted) return;
      setDetail(result.item); setStatus(result.item.status === 'pending' ? 'processing' : 'completed'); setReason(result.item.reason); setPhase('ready'); setConflict(false); setConfirming(false); setError(''); setInvalid(false);
    } catch (failure) { if (!request.signal.aborted && !access.current(failure)) { setLoadError(message(failure, '교환 요청을 불러오지 못했어요.')); setPhase(previous => previous === 'ready' ? previous : 'error'); } }
    finally { if (abort.current === request) { fetching.current = false; if (!request.signal.aborted) setLoading(false); } }
  }
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; abort.current?.abort(); fetching.current = false; }; }, [redemptionId, session.user!.id]);
  function dismiss() { if (!writing.current && !fetching.current) onClose(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail || !canProcess || writing.current || fetching.current || conflict || !available.includes(status)) return;
    const text = reason.trim().normalize('NFC');
    if ((['rejected', 'canceled'].includes(status) && !text) || [...text].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) { setInvalid(true); setError('거절·취소 사유는 필수예요. 내용을 500자 이내로 입력해 주세요.'); reasonInput.current?.focus(); return; }
    writing.current = true; setPending(true); setError(''); setLoadError(''); setInvalid(false);
    try {
      await rewardsApi.updateRedemption(detail.id, { version: detail.version, status, reason: text }, session.csrfToken, session.user!.id);
      if (active.current) onSaved(['rejected', 'canceled'].includes(status) ? '교환 요청을 처리하고 포인트를 돌려줬어요.' : `교환 요청을 ${redemptionStatusLabel[status]} 상태로 변경했어요.`);
    } catch (failure) {
      if (!active.current || access.current(failure)) return;
      setError(message(failure, '교환 요청을 처리하지 못했어요. 입력한 내용은 유지돼요.'));
      if (failure instanceof AccountError && ['REDEMPTION_CONFLICT', 'REDEMPTION_ALREADY_CLOSED'].includes(failure.code)) setConflict(true);
    } finally { writing.current = false; if (active.current) setPending(false); }
  }
  return <Frame title="교환 요청" busy={pending || loading || phase === 'loading'} onClose={dismiss}>
    {phase === 'loading' ? <p className={styles.loading} role="status">교환 요청을 불러오는 중이에요.</p> : phase === 'error' ? <><p className={styles.error} role="alert">{loadError}</p><button type="button" className={ui.button} disabled={loading} onClick={() => void load()}>{loading ? '불러오는 중…' : '요청 다시 시도'}</button></> : detail && <>
      <dl className={styles.facts}>
        <div><dt>보상</dt><dd><strong>{detail.rewardName}</strong></dd></div><div><dt>신청자</dt><dd><Link className={styles.identity} to={`/channel/id/${encodeURIComponent(detail.user.channelId)}`} target="_blank" rel="noopener noreferrer">{detail.user.displayName}<small>@{detail.user.handle}</small></Link></dd></div>
        <div><dt>사용 포인트</dt><dd>{formatPoints(detail.points)}</dd></div><div><dt>상태</dt><dd><StatusBadge tone={redemptionTone[detail.status]}>{redemptionStatusLabel[detail.status]}</StatusBadge></dd></div>
        <div><dt>접수일</dt><dd><time dateTime={new Date(detail.createdAtMs).toISOString()}>{formatRewardDate(detail.createdAtMs)}</time></dd></div><div><dt>신청 내용</dt><dd>{detail.note || '—'}</dd></div>{detail.reason && <div><dt>처리 사유</dt><dd>{detail.reason}</dd></div>}
      </dl>
      {canProcess ? <form noValidate onSubmit={submit}>
        <fieldset className={styles.editor} disabled={pending || loading}>
          <label>처리 상태<select className={ui.control} name="redemption-status" value={status} onChange={event => { setStatus(event.target.value as ProcessingStatus); setInvalid(false); if (!conflict) setError(''); }}>{available.map(value => <option key={value} value={value}>{redemptionStatusLabel[value]}</option>)}</select></label>
          <label><span className={styles.fieldHeading}><span>처리 사유{['rejected', 'canceled'].includes(status) ? ' (필수)' : ' (선택)'}</span><small>{[...reason].length} / 500</small></span><textarea ref={reasonInput} className={ui.control} name="redemption-reason" rows={4} maxLength={1000} value={reason} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : `${id}-reason-help`} onChange={event => { setReason(event.target.value); setInvalid(false); if (!conflict) setError(''); }} /><small className={styles.hint} id={`${id}-reason-help`}>신청한 시청자에게 표시돼요. 거절·취소하면 사용한 포인트가 한 번만 반환돼요.</small></label>
        </fieldset>
        {loadError && <p className={styles.error} role="alert">{loadError} 입력한 내용은 유지돼요.</p>}{error && !conflict && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
        {conflict && <Conflict confirming={confirming} busy={loading} onConfirm={() => setConfirming(true)} onKeep={() => setConfirming(false)} onLoad={() => void load()} />}
        <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending || loading} onClick={dismiss}>닫기</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={pending || loading || conflict}>처리 저장</button></div>
      </form> : <><p className={styles.refund}>{['rejected', 'canceled'].includes(detail.status) ? '사용한 포인트를 돌려준 요청이에요.' : '보상 제공이 완료된 요청이에요.'} 처리 상태를 다시 바꿀 수 없어요.</p><div className={ui.dialogActions}><button type="button" className={ui.button} onClick={dismiss}>닫기</button></div></>}
    </>}
  </Frame>;
}
