import { ChevronDown, RefreshCw, Send, Target, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { StatusBadge } from '../../components/management/ManagementUI';
import type { BroadcastKey, ChatAccountActions } from '../../viewer-contract';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { missionsApi } from './missions-client';
import type { MissionSubmitInput, MissionView, OwnMission } from './missions-client';
import { formatMissionDate, missionStatusLabel, missionTone } from './mission-format';
import styles from './ViewerMissionsPanel.module.css';

const eligibilityText: Record<NonNullable<MissionView['reason']>, string> = {
  login_required: '로그인하고 미션을 제안할 수 있어요.', blocked: '이 채널에서 미션 참여가 제한됐어요.',
  followers_only: '이 채널을 팔로우한 뒤 미션을 제안할 수 있어요.', broadcast_unavailable: '방송이 종료되어 새 미션을 제안할 수 없어요.',
  rate_limited: '미션을 잠시 쉬었다가 제안해 주세요.',
};
const actors = { viewer: '시청자', owner: '방송자', system: '자동 처리' };
function Modal({ title, pending, onClose, children }: { title: string; pending: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef(document.activeElement), id = useId();
  useEffect(() => {
    const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[aria-label="무료 미션 열기"]')?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [title]);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={id} aria-busy={pending} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className={styles.header}><h2 ref={heading} id={id} tabIndex={-1}>{title}</h2><button type="button" className={styles.iconButton} aria-label="무료 미션 닫기" disabled={pending} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>{children}
  </dialog>;
}

function MissionContent({ mission, onCancel, disabled }: { mission: OwnMission; onCancel: () => void; disabled: boolean }) {
  return <li data-mission-id={mission.id}>
    <div className={styles.row}><strong>{mission.title}</strong><StatusBadge tone={missionTone[mission.status]}>{missionStatusLabel[mission.status]}</StatusBadge></div>
    <div className={styles.meta}><time dateTime={new Date(mission.deadlineAtMs).toISOString()}>기한 {formatMissionDate(mission.deadlineAtMs)}</time>{!mission.broadcastActive && <span>방송 종료</span>}</div>
    {mission.reason && <p className={styles.copy}>{mission.reason}</p>}
    <details className={styles.details}><summary>미션 내용과 변경 이력</summary>{mission.description && <p className={styles.copy}>{mission.description}</p>}
      <ol className={styles.history} aria-label={`${mission.title} 변경 이력`}>{mission.history.map(entry => <li key={entry.id}><strong>{missionStatusLabel[entry.status]}</strong><small>{actors[entry.actor]}</small><time dateTime={new Date(entry.createdAtMs).toISOString()}>{formatMissionDate(entry.createdAtMs)}</time>{entry.reason && <p>{entry.reason}</p>}</li>)}</ol>
    </details>
    {mission.status === 'received' && <div className={styles.actions}><button type="button" className={styles.textButton} aria-label={`${mission.title} 제안 취소`} disabled={disabled} onClick={onCancel}>제안 취소</button></div>}
  </li>;
}

export function ViewerMissionsPanel({ broadcast, session, accountActions }: { broadcast: BroadcastKey; session: AccountSession; accountActions: ChatAccountActions }) {
  const ownerId = session.user?.id ?? null, scope = `${broadcast.path}/${broadcast.id}/${ownerId ?? 'anonymous'}`;
  const [view, setView] = useState<MissionView | null>(null), [error, setError] = useState(''), [submitError, setSubmitError] = useState(''), [feedback, setFeedback] = useState('');
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [durationMinutes, setDurationMinutes] = useState<15 | 30 | 60>(30);
  const [open, setOpen] = useState(false), [tab, setTab] = useState<'create' | 'mine'>('create'), [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false);
  const [morePending, setMorePending] = useState(false), [moreError, setMoreError] = useState(''), [invalid, setInvalid] = useState<'title' | 'description' | null>(null), [scopeLost, setScopeLost] = useState(false), [focusFeedback, setFocusFeedback] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [cancelTarget, setCancelTarget] = useState<OwnMission | null>(null), [cancelError, setCancelError] = useState(''), [cancelConflict, setCancelConflict] = useState(false), [clock, setClock] = useState(performance.now());
  const active = useRef(true), currentScope = useRef(scope), callbacks = useRef(accountActions), generation = useRef(0), writing = useRef(false), lost = useRef(false);
  currentScope.current = scope; callbacks.current = accountActions;
  const request = useRef<AbortController | null>(null), moreAbort = useRef<AbortController | null>(null), moreRef = useRef(false), paged = useRef(false);
  const submitted = useRef<MissionSubmitInput | null>(null), requestId = useRef(crypto.randomUUID()), cancelRef = useRef(cancelTarget), cancelUncertain = useRef(false), quotaUntil = useRef(0), expiryRefresh = useRef(0);
  cancelRef.current = cancelTarget;
  const refresh = useRef<(force?: boolean) => Promise<void>>(async () => {}), success = useRef<HTMLParagraphElement>(null), titleInput = useRef<HTMLInputElement>(null), descriptionInput = useRef<HTMLTextAreaElement>(null), id = useId();
  const seconds = Math.max(0, Math.ceil((quotaUntil.current - clock) / 1000)), canSubmit = Boolean(session.user && view?.canSubmit && seconds === 0);
  function loseScope(login = false) {
    lost.current = true; ++generation.current; request.current?.abort(); moreAbort.current?.abort(); submitted.current = null;
    setView(null); setTitle(''); setDescription(''); setOpen(false); setCancelTarget(null); setScopeLost(true); setUncertain(false);
    if (login) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged(ownerId ?? undefined);
  }
  function accessError(failure: unknown, interaction = false) {
    if (!(failure instanceof AccountError)) return false;
    if (failure.status === 401) { loseScope(interaction); return true; }
    if (failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') { loseScope(); return true; }
    return false;
  }
  function confirm(item: OwnMission, manual: boolean) {
    if (submitted.current?.clientRequestId !== item.clientRequestId) return;
    submitted.current = null; requestId.current = crypto.randomUUID(); setUncertain(false); setTitle(''); setDescription(''); setSubmitError(''); setInvalid(null); setTab('mine');
    setFeedback('미션을 제안했어요.'); setFocusFeedback(manual);
  }
  function accept(result: MissionView, append = false) {
    if (result.userId !== ownerId) { loseScope(); return false; }
    const now = performance.now(); quotaUntil.current = now + (result.retryAfterMs ?? 0); setClock(now); setOnline(navigator.onLine); setError('');
    setView(previous => {
      if (!previous || (!append && !paged.current)) return result;
      const first = append ? previous.mine : result.mine, rest = append ? result.mine : previous.mine, ids = new Set(first.map(item => item.id));
      return { ...result, mine: [...first, ...rest.filter(item => !ids.has(item.id))], nextCursor: append ? result.nextCursor : previous.nextCursor };
    });
    const receipt = submitted.current && result.mine.find(item => item.clientRequestId === submitted.current!.clientRequestId);
    if (receipt) confirm(receipt, false);
    const target = cancelRef.current, updated = target && result.mine.find(item => item.id === target.id);
    if (cancelUncertain.current && updated && updated.status !== 'received') {
      cancelUncertain.current = false; setCancelTarget(null); setCancelError(''); setCancelConflict(false); setTab('mine');
      setFeedback(updated.status === 'canceled' ? '미션 제안을 취소했어요.' : '미션 상태가 변경됐어요. 현재 상태를 확인해 주세요.'); setFocusFeedback(false);
    }
    return true;
  }
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); moreAbort.current?.abort(); }; }, []);
  useEffect(() => {
    let disposed = false;
    setView(null); setError(''); setSubmitError(''); setFeedback(''); setTitle(''); setDescription(''); setDurationMinutes(30); setOpen(false); setTab('create'); setPending(false); setUncertain(false); setCancelTarget(null); setCancelError(''); setCancelConflict(false); setScopeLost(false);
    submitted.current = null; requestId.current = crypto.randomUUID(); paged.current = false; lost.current = false; cancelUncertain.current = false; quotaUntil.current = 0; expiryRefresh.current = 0;
    async function load(force = false) {
      if (disposed || lost.current || writing.current || moreRef.current || document.visibilityState !== 'visible' || (request.current && !force)) return;
      if (!navigator.onLine) { setOnline(false); setError('인터넷 연결을 확인해 주세요.'); return; }
      request.current?.abort(); const abort = new AbortController(), revision = ++generation.current; request.current = abort;
      try { const result = await missionsApi.currentMissions({ path: broadcast.path, broadcastId: broadcast.id }, { limit: 20 }, abort.signal, ownerId ?? undefined); if (!disposed && !abort.signal.aborted && generation.current === revision && currentScope.current === scope) accept(result); }
      catch (failure) { if (!disposed && !abort.signal.aborted && generation.current === revision && currentScope.current === scope && !accessError(failure)) setError(failure instanceof Error ? failure.message : '미션을 불러오지 못했어요.'); }
      finally { if (request.current === abort) request.current = null; }
    }
    refresh.current = load;
    function wake() { setClock(performance.now()); setOnline(navigator.onLine); if (document.visibilityState !== 'visible' || !navigator.onLine) { request.current?.abort(); request.current = null; if (!navigator.onLine) setError('인터넷 연결을 확인해 주세요.'); } else void load(); }
    void load(); const timer = window.setInterval(() => void load(), 10000);
    window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('offline', wake); document.addEventListener('visibilitychange', wake);
    return () => { disposed = true; ++generation.current; request.current?.abort(); request.current = null; moreAbort.current?.abort(); window.clearInterval(timer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', wake); document.removeEventListener('visibilitychange', wake); };
  }, [scope]);
  useEffect(() => { if (view?.reason !== 'rate_limited') return; const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setClock(performance.now()); }, 1000); return () => window.clearInterval(timer); }, [view?.reason]);
  useEffect(() => { if (view?.reason === 'rate_limited' && seconds === 0 && quotaUntil.current > 0 && expiryRefresh.current !== quotaUntil.current) { expiryRefresh.current = quotaUntil.current; void refresh.current(); } }, [view?.reason, seconds]);
  useEffect(() => { if (open && feedback && focusFeedback) success.current?.focus({ preventScroll: true }); }, [open, feedback, focusFeedback, cancelTarget]);
  function beginWrite() { writing.current = true; setPending(true); setFeedback(''); ++generation.current; request.current?.abort(); request.current = null; moreAbort.current?.abort(); }
  function refreshList() { if (!writing.current && !moreRef.current) { paged.current = false; void refresh.current(true); } }
  async function loadMore() {
    if (!view?.nextCursor || moreRef.current || writing.current || lost.current) return;
    const cursor = view.nextCursor, requestScope = scope, revision = ++generation.current, abort = new AbortController(); request.current?.abort(); request.current = null; moreAbort.current = abort; moreRef.current = true; setMorePending(true); setMoreError('');
    try { const result = await missionsApi.currentMissions({ path: broadcast.path, broadcastId: broadcast.id }, { limit: 20, cursor }, abort.signal, ownerId ?? undefined); if (!active.current || abort.signal.aborted || generation.current !== revision || currentScope.current !== requestScope) return; if (result.nextCursor === cursor) throw Error('다음 미션 목록을 확인하지 못했어요.'); paged.current = true; accept(result, true); }
    catch (failure) { if (active.current && !abort.signal.aborted && generation.current === revision && currentScope.current === requestScope && !accessError(failure)) setMoreError(failure instanceof Error ? failure.message : '다음 미션을 불러오지 못했어요.'); }
    finally { if (moreAbort.current === abort) { moreAbort.current = null; moreRef.current = false; if (active.current && currentScope.current === requestScope) setMorePending(false); } }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (writing.current || lost.current || !navigator.onLine || (!uncertain && !canSubmit)) return;
    if (!session.user) { callbacks.current.onRequireLogin(); return; }
    const name = title.trim().normalize('NFC'), body = description.trim().normalize('NFC');
    if (!submitted.current && (!name || [...name].length > 100 || /[\u0000-\u001f\u007f]/.test(name))) { setInvalid('title'); setSubmitError('미션 제목을 1~100자로 입력해 주세요.'); titleInput.current?.focus(); return; }
    if (!submitted.current && ([...body].length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body))) { setInvalid('description'); setSubmitError('설명을 1,000자 이내로 입력해 주세요.'); descriptionInput.current?.focus(); return; }
    const input = submitted.current ?? { path: broadcast.path, broadcastId: broadcast.id, title: name, description: body, durationMinutes, clientRequestId: requestId.current }, requestScope = scope;
    submitted.current = input; beginWrite(); setSubmitError(''); setInvalid(null);
    try {
      const result = await missionsApi.submitMission(input, session.csrfToken, session.user.id);
      if (!active.current || currentScope.current !== requestScope) return;
      setView(previous => previous ? { ...previous, mine: [result.item, ...previous.mine.filter(item => item.id !== result.item.id)] } : previous); confirm(result.item, true);
    } catch (failure) {
      if (!active.current || currentScope.current !== requestScope || accessError(failure, true)) return;
      if (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500) { setUncertain(true); setSubmitError('제안 결과를 확인하지 못했어요. 같은 미션으로 다시 확인해 주세요.'); }
      else {
        submitted.current = null; requestId.current = crypto.randomUUID(); setUncertain(false); setSubmitError(failure.message);
        const reason: MissionView['reason'] = failure.code === 'MISSION_PARTICIPATION_BLOCKED' ? 'blocked' : failure.code === 'MISSION_FOLLOW_REQUIRED' ? 'followers_only' : failure.code === 'MISSION_BROADCAST_UNAVAILABLE' ? 'broadcast_unavailable' : failure.code === 'MISSION_RATE_LIMITED' ? 'rate_limited' : null;
        if (reason) { const now = performance.now(); if (reason === 'rate_limited') { quotaUntil.current = now + (failure.retryAfterMs ?? 0); setClock(now); } setView(previous => previous ? { ...previous, canSubmit: false, reason, retryAfterMs: reason === 'rate_limited' ? failure.retryAfterMs ?? null : null } : previous); }
      }
    } finally { writing.current = false; if (active.current && currentScope.current === requestScope) { setPending(false); void refresh.current(true); } }
  }
  async function cancel() {
    if (writing.current || !cancelTarget || !session.user || lost.current || !navigator.onLine || staleCancel || cancelConflict) return;
    const target = cancelTarget, requestScope = scope; beginWrite(); setCancelError('');
    try {
      const result = await missionsApi.cancelMission(target.id, target.version, session.csrfToken, session.user.id);
      if (!active.current || currentScope.current !== requestScope) return;
      setView(previous => previous ? { ...previous, mine: previous.mine.map(item => item.id === result.item.id ? result.item : item) } : previous); cancelUncertain.current = false; setCancelTarget(null); setCancelConflict(false); setTab('mine'); setFeedback('미션 제안을 취소했어요.'); setFocusFeedback(true);
    } catch (failure) {
      if (!active.current || currentScope.current !== requestScope || accessError(failure, true)) return;
      cancelUncertain.current = !(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500;
      setCancelError(cancelUncertain.current ? '취소 결과를 확인하지 못했어요. 같은 미션의 상태를 다시 확인해 주세요.' : failure instanceof Error ? failure.message : '제안을 취소하지 못했어요.');
      if (failure instanceof AccountError && ['MISSION_CONFLICT', 'MISSION_EXPIRED', 'MISSION_ALREADY_CLOSED', 'MISSION_INVALID_TRANSITION'].includes(failure.code)) setCancelConflict(true);
    } finally { writing.current = false; if (active.current && currentScope.current === requestScope) { setPending(false); void refresh.current(true); } }
  }
  function dismiss() { if (!writing.current) setOpen(false); }
  const liveCancel = cancelTarget && view?.mine.find(item => item.id === cancelTarget.id), staleCancel = Boolean(cancelTarget && liveCancel && (liveCancel.version !== cancelTarget.version || liveCancel.status !== 'received'));
  const eligibility = view?.reason ? view.reason === 'rate_limited' && seconds > 0 ? `${seconds}초 후에 다시 미션을 제안할 수 있어요.` : eligibilityText[view.reason] : '';
  if (scopeLost) return null;
  return <><section className={styles.card} aria-label="무료 미션"><span><Target size={15} aria-hidden="true" />무료 미션{session.user && view && <small>내 미션 {view.mine.length}개{view.nextCursor ? '+' : ''}</small>}</span><button type="button" className={styles.textButton} aria-label="무료 미션 열기" onClick={() => { setFocusFeedback(false); setOpen(true); }}>제안하기</button>{error && <p className={styles.error} role="alert">미션 연결을 확인해 주세요.</p>}{feedback && !open && <p className={styles.success} role="status">{feedback}</p>}</section>
    {open && <Modal title={cancelTarget ? '미션 제안 취소' : '무료 미션'} pending={pending} onClose={dismiss}><div className={styles.body}>
      {cancelTarget ? <><h3 className={styles.cancelTitle}>{cancelTarget.title}</h3><p className={styles.copy}>아직 접수 상태인 미션 제안을 취소할까요? 진행이 시작된 미션은 방송자가 처리해요.</p>{cancelError && <p className={styles.error} role="alert">{cancelError}</p>}{(staleCancel || cancelConflict) && <p className={styles.hint}>현재 상태를 확인한 뒤 계속해 주세요.</p>}<div className={styles.actions}><button type="button" className={styles.button} disabled={pending} onClick={() => { setCancelTarget(null); setCancelError(''); setCancelConflict(false); setTab('mine'); refreshList(); }}>내 미션 확인</button><button type="button" className={`${styles.button} ${styles.primary}`} disabled={pending || !online || staleCancel || cancelConflict} onClick={() => void cancel()}>{pending ? '취소 중…' : '제안 취소 확인'}</button></div></> : <>
        <nav className={styles.tabs} aria-label="무료 미션 메뉴"><button type="button" aria-current={tab === 'create' ? 'page' : undefined} disabled={pending} onClick={() => setTab('create')}>미션 제안</button><button type="button" aria-current={tab === 'mine' ? 'page' : undefined} disabled={pending} onClick={() => { setTab('mine'); refreshList(); }}>내 미션</button></nav>
        <div className={styles.row}><p className={styles.hint}>미션과 진행 이력은 나와 방송자만 확인해요.</p><button type="button" className={styles.iconButton} aria-label="내 미션 새로고침" disabled={pending || morePending} onClick={refreshList}><RefreshCw size={17} aria-hidden="true" /></button></div>
        {feedback && <p ref={success} tabIndex={-1} className={styles.success} role="status">{feedback}</p>}
        {tab === 'create' && (session.user ? <form className={styles.form} aria-label="무료 미션 제안" noValidate onSubmit={submit}>
          <label htmlFor={`${id}-title`}><span className={styles.fieldHeading}><span>미션 제목</span><small>{[...title].length} / 100</small></span><input ref={titleInput} id={`${id}-title`} className={styles.control} name="viewer-mission-title" value={title} maxLength={200} readOnly={pending || uncertain} placeholder="함께 도전할 미션을 제안해 주세요" aria-invalid={invalid === 'title'} aria-describedby={invalid === 'title' ? `${id}-error` : undefined} onChange={event => { setTitle(event.target.value); setInvalid(null); setSubmitError(''); setFeedback(''); }} /></label>
          <label htmlFor={`${id}-description`}><span className={styles.fieldHeading}><span>설명 <small>선택</small></span><small>{[...description].length} / 1,000</small></span><textarea ref={descriptionInput} id={`${id}-description`} className={styles.control} name="viewer-mission-description" rows={4} value={description} maxLength={2000} readOnly={pending || uncertain} placeholder="목표와 도전 방법을 적어 주세요" aria-invalid={invalid === 'description'} aria-describedby={invalid === 'description' ? `${id}-error` : undefined} onChange={event => { setDescription(event.target.value); setInvalid(null); setSubmitError(''); setFeedback(''); }} /></label>
          <label htmlFor={`${id}-duration`}><span className={styles.fieldHeading}>미션 기한</span><span className={styles.selectWrap}><select id={`${id}-duration`} className={styles.control} name="viewer-mission-duration" value={durationMinutes} disabled={pending || uncertain} aria-describedby={`${id}-duration-help`} onChange={event => { setDurationMinutes(Number(event.target.value) as 15 | 30 | 60); setSubmitError(''); setFeedback(''); }}><option value={15}>접수부터 15분</option><option value={30}>접수부터 30분</option><option value={60}>접수부터 60분</option></select><ChevronDown size={17} aria-hidden="true" /></span><small className={styles.hint} id={`${id}-duration-help`}>접수된 시점부터 계산해요. 방송이 끝나거나 기한이 지나면 미완료 미션은 만료돼요.</small></label>
          {eligibility && <p className={styles.hint}>{eligibility}</p>}{submitError && <p className={styles.error} id={`${id}-error`} role="alert">{submitError}</p>}<div className={styles.actions}><button type="submit" className={`${styles.button} ${styles.primary}`} disabled={pending || morePending || !online || (!uncertain && (!canSubmit || !title.trim()))}><Send size={15} aria-hidden="true" />{pending ? '제안 중…' : uncertain ? '제안 다시 확인' : '미션 제안하기'}</button></div>
        </form> : <><p className={styles.hint}>로그인하고 미션을 제안하거나 내 진행 이력을 확인할 수 있어요.</p><div className={styles.actions}><button type="button" className={`${styles.button} ${styles.primary}`} onClick={callbacks.current.onRequireLogin}>로그인하고 미션 제안</button></div></>)}
        {tab === 'mine' && (!session.user ? <p className={styles.hint}>로그인하고 내 미션을 확인할 수 있어요.</p> : !view ? <p className={styles.empty}>{error ? '내 미션을 확인하지 못했어요.' : '내 미션을 불러오는 중이에요.'}</p> : view.mine.length ? <><ul className={styles.list}>{view.mine.map(mission => <MissionContent key={mission.id} mission={mission} disabled={pending || morePending || !online} onCancel={() => { setCancelTarget({ ...mission }); setCancelError(''); setCancelConflict(false); setFeedback(''); cancelUncertain.current = false; }} />)}</ul>{view.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={styles.button} disabled={morePending || pending} onClick={() => void loadMore()}>{morePending ? '불러오는 중…' : moreError ? '내 미션 더 불러오기 다시 시도' : '내 미션 더 불러오기'}</button></div>}</> : <p className={styles.empty}>아직 제안한 미션이 없어요.</p>)}
      </>}{error && <p className={styles.error} role="alert">{error}</p>}
    </div></Modal>}
  </>;
}
