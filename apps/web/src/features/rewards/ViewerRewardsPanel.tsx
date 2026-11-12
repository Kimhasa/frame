import { Gift, RefreshCw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { StatusBadge } from '../../components/management/ManagementUI';
import type { BroadcastKey, ChatAccountActions } from '../../viewer-contract';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { rewardsApi } from './rewards-client';
import type { OwnRedemption, PointLedgerPageResult, ProductReward, RewardRedemptionInput, RewardView } from './rewards-client';
import { formatPoints, formatRewardDate, redemptionStatusLabel, redemptionTone } from './reward-format';
import styles from './ViewerRewardsPanel.module.css';

const reasons: Record<NonNullable<RewardView['reason']>, string> = { login_required: '로그인하고 보상을 신청할 수 있어요.', blocked: '이 채널에서 보상 참여가 제한됐어요.',
  followers_only: '이 채널을 팔로우한 뒤 보상을 신청할 수 있어요.', broadcast_unavailable: '방송이 종료되어 새 보상을 신청할 수 없어요.' };
function Modal({ title, pending, onClose, children }: { title: string; pending: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef(document.activeElement), id = useId();
  useEffect(() => {
    const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => { element?.close(); if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true }); else document.querySelector<HTMLElement>('[aria-label="채널 보상 열기"]')?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [title]);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={id} aria-busy={pending} onCancel={event => { event.preventDefault(); onClose(); }}><header className={styles.header}><h2 ref={heading} id={id} tabIndex={-1}>{title}</h2><button type="button" className={styles.iconButton} aria-label="채널 보상 닫기" disabled={pending} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>{children}</dialog>;
}
function Ledger({ channelId, session, onAccessError }: { channelId: string; session: AccountSession; onAccessError: (error: unknown) => boolean }) {
  const [data, setData] = useState<PointLedgerPageResult | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false), [attempt, setAttempt] = useState(0);
  const active = useRef(true), request = useRef<AbortController | null>(null), loading = useRef(false), callbacks = useRef(onAccessError); callbacks.current = onAccessError;
  useEffect(() => {
    active.current = true; const abort = new AbortController(); request.current?.abort(); request.current = abort; loading.current = true; setPending(true); setError('');
    rewardsApi.points(channelId, { limit: 20 }, abort.signal, session.user!.id).then(result => { if (!abort.signal.aborted) setData(result); }).catch(failure => { if (!abort.signal.aborted && !callbacks.current(failure)) setError(failure instanceof Error ? failure.message : '포인트 내역을 확인하지 못했어요.'); }).finally(() => { if (!abort.signal.aborted) { loading.current = false; setPending(false); } });
    return () => { active.current = false; request.current?.abort(); };
  }, [channelId, session.user!.id, attempt]);
  async function more() {
    if (!data?.nextCursor || loading.current) return;
    const cursor = data.nextCursor, abort = new AbortController(); request.current = abort; loading.current = true; setPending(true); setError('');
    try { const result = await rewardsApi.points(channelId, { limit: 20, cursor }, abort.signal, session.user!.id); if (!active.current || abort.signal.aborted) return; if (result.nextCursor === cursor) throw Error('다음 포인트 내역을 확인하지 못했어요.'); setData(previous => { if (!previous) return result; const ids = new Set(previous.items.map(item => item.id)); return { ...result, items: [...previous.items, ...result.items.filter(item => !ids.has(item.id))] }; }); }
    catch (failure) { if (active.current && !abort.signal.aborted && !callbacks.current(failure)) setError(failure instanceof Error ? failure.message : '포인트 내역을 확인하지 못했어요.'); }
    finally { if (request.current === abort) { loading.current = false; if (active.current) setPending(false); } }
  }
  return <section aria-label="내 포인트 내역"><div className={styles.row}><p className={styles.hint}>적립·사용·반환 내역</p><button type="button" className={styles.textButton} disabled={pending} onClick={() => setAttempt(value => value + 1)}>내역 새로고침</button></div>
    {error && <p className={styles.error} role="alert">{error}</p>}{!data ? <p className={styles.empty}>{pending ? '포인트 내역을 불러오는 중이에요.' : '포인트 내역을 확인하지 못했어요.'}</p> : data.items.length ? <ul className={styles.list}>{data.items.map(item => <li key={item.id} data-ledger-id={item.id}><div className={styles.row}><div><strong>{item.label}</strong><small>{formatRewardDate(item.createdAtMs)}</small></div><span className={styles.cost}>{item.delta > 0 ? '+' : '−'}{formatPoints(Math.abs(item.delta))}</span></div><p className={styles.hint}>잔액 {formatPoints(item.balanceAfter)}</p></li>)}</ul> : <p className={styles.empty}>아직 포인트 내역이 없어요.</p>}
    {data?.nextCursor && <div className={styles.more}><button type="button" className={styles.button} disabled={pending} onClick={() => void more()}>{pending ? '불러오는 중…' : '포인트 내역 더 불러오기'}</button></div>}
  </section>;
}

export function ViewerRewardsPanel({ broadcast, session, accountActions, watchMessage }: { broadcast: BroadcastKey; session: AccountSession; accountActions: ChatAccountActions; watchMessage?: string }) {
  const ownerId = session.user?.id ?? null, scope = `${broadcast.path}/${broadcast.id}/${ownerId ?? 'anonymous'}`;
  const [view, setView] = useState<RewardView | null>(null), [error, setError] = useState(''), [actionError, setActionError] = useState(''), [feedback, setFeedback] = useState('');
  const [open, setOpen] = useState(false), [tab, setTab] = useState<'rewards' | 'requests' | 'ledger'>('rewards'), [selected, setSelected] = useState<ProductReward | null>(null), [cancelTarget, setCancelTarget] = useState<OwnRedemption | null>(null);
  const [note, setNote] = useState(''), [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false), [conflict, setConflict] = useState(false), [invalid, setInvalid] = useState(false), [scopeLost, setScopeLost] = useState(false), [focusFeedback, setFocusFeedback] = useState(false);
  const [morePending, setMorePending] = useState(false), [moreError, setMoreError] = useState('');
  const active = useRef(true), currentScope = useRef(scope), callbacks = useRef(accountActions), generation = useRef(0), writing = useRef(false), lost = useRef(false);
  currentScope.current = scope; callbacks.current = accountActions;
  const request = useRef<AbortController | null>(null), moreAbort = useRef<AbortController | null>(null), moreRef = useRef(false), paged = useRef(false), requestId = useRef(crypto.randomUUID());
  const submitted = useRef<{ rewardId: string; body: RewardRedemptionInput } | null>(null), cancelRef = useRef(cancelTarget), cancelUncertain = useRef(false);
  cancelRef.current = cancelTarget;
  const refresh = useRef<(force?: boolean) => Promise<RewardView | null>>(async () => null), success = useRef<HTMLParagraphElement>(null), noteInput = useRef<HTMLTextAreaElement>(null), id = useId();
  function loseScope(login = false) {
    lost.current = true; ++generation.current; request.current?.abort(); moreAbort.current?.abort(); submitted.current = null;
    setView(null); setOpen(false); setSelected(null); setCancelTarget(null); setNote(''); setUncertain(false); setScopeLost(true);
    if (login) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged(ownerId ?? undefined);
  }
  function accessError(failure: unknown, interaction = false) {
    if (!(failure instanceof AccountError)) return false;
    if (failure.status === 401) { loseScope(interaction); return true; }
    if (failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') { loseScope(); return true; }
    return false;
  }
  function confirm(item: OwnRedemption, manual: boolean) {
    if (submitted.current?.body.clientRequestId !== item.clientRequestId) return;
    submitted.current = null; requestId.current = crypto.randomUUID(); setUncertain(false); setSelected(null); setNote(''); setConflict(false); setActionError(''); setTab('requests');
    setFeedback('보상을 신청했어요.'); setFocusFeedback(manual);
  }
  function accept(result: RewardView, append = false) {
    if (result.userId !== ownerId) { loseScope(); return false; }
    setError(''); setView(previous => {
      if (!previous || (!append && !paged.current)) return result;
      const first = append ? previous.mine : result.mine, rest = append ? result.mine : previous.mine, ids = new Set(first.map(item => item.id));
      return { ...result, mine: [...first, ...rest.filter(item => !ids.has(item.id))], nextCursor: append ? result.nextCursor : previous.nextCursor };
    });
    const committed = submitted.current && result.mine.find(item => item.clientRequestId === submitted.current!.body.clientRequestId);
    if (committed) confirm(committed, false);
    const target = cancelRef.current, changed = target && result.mine.find(item => item.id === target.id);
    if (cancelUncertain.current && changed && changed.status !== 'pending') { cancelUncertain.current = false; setCancelTarget(null); setTab('requests'); setActionError(''); setFeedback(changed.status === 'canceled' ? '신청을 취소하고 포인트를 돌려받았어요.' : '신청 상태가 변경됐어요. 현재 상태를 확인해 주세요.'); setFocusFeedback(false); }
    return true;
  }
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); moreAbort.current?.abort(); }; }, []);
  useEffect(() => {
    let disposed = false; setView(null); setError(''); setActionError(''); setFeedback(''); setOpen(false); setSelected(null); setCancelTarget(null); setNote(''); setUncertain(false); setScopeLost(false);
    submitted.current = null; cancelUncertain.current = false; paged.current = false; lost.current = false; requestId.current = crypto.randomUUID();
    async function load(force = false): Promise<RewardView | null> {
      if (disposed || lost.current || writing.current || moreRef.current || document.visibilityState !== 'visible' || !navigator.onLine || (request.current && !force)) return null;
      request.current?.abort(); const abort = new AbortController(), revision = ++generation.current; request.current = abort;
      try { const result = await rewardsApi.currentRewards({ path: broadcast.path, broadcastId: broadcast.id }, { limit: 20 }, abort.signal, ownerId ?? undefined); if (disposed || abort.signal.aborted || generation.current !== revision || currentScope.current !== scope) return null; return accept(result) ? result : null; }
      catch (failure) { if (!disposed && !abort.signal.aborted && generation.current === revision && currentScope.current === scope && !accessError(failure)) setError(failure instanceof Error ? failure.message : '채널 보상을 불러오지 못했어요.'); return null; }
      finally { if (request.current === abort) request.current = null; }
    }
    refresh.current = load;
    function wake() { if (document.visibilityState !== 'visible' || !navigator.onLine) { request.current?.abort(); request.current = null; } else void load(); }
    void load(); const timer = window.setInterval(() => void load(), 15000);
    window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('offline', wake); document.addEventListener('visibilitychange', wake);
    return () => { disposed = true; ++generation.current; request.current?.abort(); request.current = null; moreAbort.current?.abort(); window.clearInterval(timer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', wake); document.removeEventListener('visibilitychange', wake); };
  }, [scope]);
  useEffect(() => { if (open && feedback && focusFeedback) success.current?.focus({ preventScroll: true }); }, [open, feedback, focusFeedback, selected, cancelTarget]);
  async function loadMore() {
    if (!view?.nextCursor || moreRef.current || writing.current || lost.current) return;
    const cursor = view.nextCursor, requestScope = scope, revision = ++generation.current, abort = new AbortController(); request.current?.abort(); request.current = null; moreAbort.current = abort; moreRef.current = true; setMorePending(true); setMoreError('');
    try { const result = await rewardsApi.currentRewards({ path: broadcast.path, broadcastId: broadcast.id }, { limit: 20, cursor }, abort.signal, ownerId ?? undefined); if (!active.current || abort.signal.aborted || generation.current !== revision || currentScope.current !== requestScope) return; if (result.nextCursor === cursor) throw Error('다음 신청 목록을 확인하지 못했어요.'); paged.current = true; accept(result, true); }
    catch (failure) { if (active.current && !abort.signal.aborted && generation.current === revision && currentScope.current === requestScope && !accessError(failure)) setMoreError(failure instanceof Error ? failure.message : '신청 목록을 불러오지 못했어요.'); }
    finally { if (moreAbort.current === abort) { moreAbort.current = null; moreRef.current = false; if (active.current && currentScope.current === requestScope) setMorePending(false); } }
  }
  async function redeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (writing.current || !selected || !session.user || (!uncertain && (!view?.canRedeem || staleReward))) return;
    const text = note.trim(); if (!submitted.current && ([...text].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))) { setInvalid(true); setActionError('요청 내용을 500자 이내로 입력해 주세요.'); noteInput.current?.focus(); return; }
    const transaction = submitted.current ?? { rewardId: selected.id, body: { path: broadcast.path, broadcastId: broadcast.id, note: text, clientRequestId: requestId.current, rewardVersion: selected.version } }, requestScope = scope;
    submitted.current = transaction; writing.current = true; setPending(true); setActionError(''); setFeedback(''); ++generation.current; request.current?.abort(); request.current = null; moreAbort.current?.abort();
    try {
      const result = await rewardsApi.redeemReward(transaction.rewardId, transaction.body, session.csrfToken, session.user.id);
      if (!active.current || currentScope.current !== requestScope) return;
      setView(previous => previous ? { ...previous, balance: result.balance, mine: [result.item, ...previous.mine.filter(item => item.id !== result.item.id)], usedRewardIds: selected.limit === 'once_per_broadcast' ? [...new Set([...previous.usedRewardIds, result.item.rewardId])] : previous.usedRewardIds } : previous); confirm(result.item, true);
    } catch (failure) {
      if (!active.current || currentScope.current !== requestScope || accessError(failure, true)) return;
      if (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500) { setUncertain(true); setActionError('신청 결과를 확인하지 못했어요. 같은 신청으로 다시 확인해 주세요.'); }
      else {
        submitted.current = null; requestId.current = crypto.randomUUID(); setUncertain(false); setActionError(failure.message);
        if (failure.code === 'REWARD_CONFLICT' || failure.code === 'REWARD_DISABLED' || failure.code === 'REWARD_NOT_FOUND') setConflict(true);
        const reason: RewardView['reason'] = failure.code === 'REWARD_PARTICIPATION_BLOCKED' ? 'blocked' : failure.code === 'REWARD_FOLLOW_REQUIRED' ? 'followers_only' : failure.code === 'REWARD_BROADCAST_UNAVAILABLE' ? 'broadcast_unavailable' : null;
        if (reason) setView(previous => previous ? { ...previous, canRedeem: false, reason } : previous);
        if (failure.code === 'REWARD_ALREADY_REDEEMED') setView(previous => previous ? { ...previous, usedRewardIds: [...new Set([...previous.usedRewardIds, transaction.rewardId])] } : previous);
      }
    } finally { writing.current = false; if (active.current && currentScope.current === requestScope) { setPending(false); void refresh.current(true); } }
  }
  async function cancel() {
    if (writing.current || !cancelTarget || !session.user || staleCancel) return;
    const target = cancelTarget, requestScope = scope; writing.current = true; setPending(true); setActionError(''); setFeedback(''); ++generation.current; request.current?.abort(); request.current = null;
    try { const result = await rewardsApi.cancelRedemption(target.id, target.version, session.csrfToken, session.user.id); if (!active.current || currentScope.current !== requestScope) return; setView(previous => previous ? { ...previous, balance: result.balance, mine: previous.mine.map(item => item.id === result.item.id ? result.item : item) } : previous); cancelUncertain.current = false; setCancelTarget(null); setTab('requests'); setFeedback('신청을 취소하고 포인트를 돌려받았어요.'); setFocusFeedback(true); }
    catch (failure) { if (!active.current || currentScope.current !== requestScope || accessError(failure, true)) return; cancelUncertain.current = !(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500; setActionError(cancelUncertain.current ? '취소 결과를 확인하지 못했어요. 같은 신청의 상태를 다시 확인해 주세요.' : failure instanceof Error ? failure.message : '신청을 취소하지 못했어요.'); }
    finally { writing.current = false; if (active.current && currentScope.current === requestScope) { setPending(false); void refresh.current(true); } }
  }
  async function updateSelection() {
    if (writing.current || uncertain || !selected) return;
    const target = selected.id, requestScope = scope; const result = await refresh.current(true);
    if (!active.current || currentScope.current !== requestScope || !result) return;
    const current = result.rewards.find(item => item.id === target);
    if (current) { setSelected({ ...current }); setConflict(false); setActionError(''); requestId.current = crypto.randomUUID(); noteInput.current?.focus({ preventScroll: true }); }
    else { setConflict(true); setActionError('이 보상은 지금 신청할 수 없어요. 보상 목록을 확인해 주세요.'); }
  }
  function dismiss() { if (!writing.current) setOpen(false); }
  function choose(reward: ProductReward) { if (writing.current || submitted.current) return; setSelected({ ...reward }); setNote(''); setConflict(false); setInvalid(false); setActionError(''); setFeedback(''); requestId.current = crypto.randomUUID(); }
  const liveReward = selected && view?.rewards.find(item => item.id === selected.id), staleReward = Boolean(selected && (conflict || (view && (!liveReward || liveReward.version !== selected.version))));
  const liveCancel = cancelTarget && view?.mine.find(item => item.id === cancelTarget.id), staleCancel = Boolean(cancelTarget && liveCancel && (liveCancel.version !== cancelTarget.version || liveCancel.status !== 'pending'));
  const title = selected ? '보상 신청' : cancelTarget ? '신청 취소' : '채널 포인트';
  if (scopeLost) return null;
  return <><section className={styles.card} aria-label="채널 포인트"><span><Gift size={15} aria-hidden="true" />{view?.balance !== null && view?.balance !== undefined ? <strong>{formatPoints(view.balance)}</strong> : '채널 포인트'}{error && <span>연결 확인 필요</span>}</span><button type="button" className={styles.textButton} aria-label="채널 보상 열기" onClick={() => { setFocusFeedback(false); setOpen(true); }}>보상 보기</button>{watchMessage && <p className={styles.watchHint} role="status">{watchMessage}</p>}</section>
    {open && <Modal title={title} pending={pending} onClose={dismiss}><div className={styles.body}>
      <section className={styles.wallet} aria-label="내 채널 포인트"><div><span>내 포인트</span><strong>{view?.balance !== null && view?.balance !== undefined ? formatPoints(view.balance) : session.user ? '확인 중' : '로그인 필요'}</strong></div><p>이 채널에서 사용하는 포인트예요. 실제 재생을 확인해 시청 1분마다 10 P를 적립해요.</p></section>
      {selected ? <><dl className={styles.detail}><div><dt>보상</dt><dd>{selected.name}</dd></div><div><dt>사용 포인트</dt><dd>{formatPoints(selected.points)}</dd></div><div><dt>신청 제한</dt><dd>{selected.limit === 'once_per_broadcast' ? '방송당 1회' : '무제한'}</dd></div></dl><form className={styles.form} noValidate onSubmit={redeem}>
        <label className={styles.fieldHeading} htmlFor={`${id}-note`}><span>요청 내용 <small>선택</small></span><small>{[...note].length} / 500</small></label><textarea ref={noteInput} id={`${id}-note`} name="viewer-reward-note" className={styles.textarea} rows={3} value={note} maxLength={1000} readOnly={pending || uncertain} aria-invalid={invalid || undefined} aria-describedby={actionError ? `${id}-error` : undefined} onChange={event => { setNote(event.target.value); setInvalid(false); if (!conflict) setActionError(''); }} />
        <p className={styles.hint}>신청하면 표시된 포인트가 사용돼요. 대기 중인 신청을 취소하거나 방송자가 거절하면 포인트를 돌려받아요.</p>
        {staleReward && !uncertain && <><p className={styles.error}>보상 정보가 바뀌었어요. 최신 보상을 확인한 뒤 다시 신청해 주세요.</p><button type="button" className={styles.button} disabled={pending} onClick={() => void updateSelection()}>최신 보상 확인</button></>}
        {view?.reason && <p className={styles.hint}>{reasons[view.reason]}</p>}{view?.balance !== null && view?.balance !== undefined && view.balance < selected.points && <p className={styles.hint}>포인트가 부족해요.</p>}
        {actionError && <p className={styles.error} id={`${id}-error`} role="alert">{actionError}</p>}<div className={styles.actions}><button type="button" className={styles.button} disabled={pending || uncertain} onClick={() => { setSelected(null); setActionError(''); }}>보상 목록</button><button type="submit" className={`${styles.button} ${styles.primary}`} disabled={pending || (!uncertain && (!view?.canRedeem || staleReward || view.balance === null || view.balance < selected.points || (selected.limit === 'once_per_broadcast' && view.usedRewardIds.includes(selected.id))))}>{pending ? '신청 중…' : uncertain ? '신청 다시 확인' : '신청하기'}</button></div>
      </form></> : cancelTarget ? <><dl className={styles.detail}><div><dt>보상</dt><dd>{cancelTarget.rewardName}</dd></div><div><dt>반환 포인트</dt><dd>{formatPoints(cancelTarget.points)}</dd></div></dl><p className={styles.copy}>대기 중인 신청을 취소하고 포인트를 돌려받을까요?</p>{actionError && <p className={styles.error} role="alert">{actionError}</p>}{staleCancel && <p className={styles.hint}>신청 상태가 변경됐어요. 현재 신청 목록을 확인해 주세요.</p>}<div className={styles.actions}><button type="button" className={styles.button} disabled={pending} onClick={() => { setCancelTarget(null); setActionError(''); }}>신청 목록</button><button type="button" className={`${styles.button} ${styles.primary}`} disabled={pending || staleCancel} onClick={() => void cancel()}>{pending ? '취소 중…' : '신청 취소 확인'}</button></div></> : <>
        <nav className={styles.tabs} aria-label="채널 보상 메뉴">{([['rewards', '보상'], ['requests', '내 신청'], ['ledger', '포인트 내역']] as const).map(([value, label]) => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value); setActionError(''); setFeedback(''); }}>{label}</button>)}</nav>
        <div className={styles.row}><p className={styles.hint}>{tab === 'rewards' ? '포인트로 신청할 수 있는 보상' : tab === 'requests' ? '이 방송에서 신청한 보상' : '이 채널의 내 포인트 기록'}</p><button type="button" className={styles.iconButton} aria-label="채널 보상 새로고침" disabled={pending || morePending} onClick={() => { paged.current = false; void refresh.current(true); }}><RefreshCw size={17} aria-hidden="true" /></button></div>
        {feedback && <p ref={success} tabIndex={-1} className={styles.success} role="status">{feedback}</p>}{actionError && <p className={styles.error} role="alert">{actionError}</p>}
        {tab === 'rewards' && <>{view?.reason && <p className={styles.hint}>{reasons[view.reason]}</p>}{!view ? <p className={styles.empty}>{error ? '보상을 확인하지 못했어요.' : '보상을 불러오는 중이에요.'}</p> : view.rewards.length ? <ul className={styles.list}>{view.rewards.map(reward => { const used = reward.limit === 'once_per_broadcast' && view.usedRewardIds.includes(reward.id); return <li key={reward.id} data-reward-id={reward.id}><div className={styles.row}><div><strong>{reward.name}</strong><small>{reward.limit === 'once_per_broadcast' ? '방송당 1회' : '무제한'}</small></div><span className={styles.cost}>{formatPoints(reward.points)}</span></div><div className={styles.rowActions}><span className={styles.hint}>{used ? '이미 신청한 보상' : view.balance !== null && view.balance < reward.points ? '포인트 부족' : ''}</span><button type="button" className={styles.button} disabled={Boolean(session.user) && (!view.canRedeem || used || view.balance === null || view.balance < reward.points)} aria-label={`${reward.name} 보상 신청`} onClick={() => session.user ? choose(reward) : callbacks.current.onRequireLogin()}>{session.user ? '신청' : '로그인하고 신청'}</button></div></li>; })}</ul> : <p className={styles.empty}>지금 신청할 수 있는 보상이 없어요.</p>}</>}
        {tab === 'requests' && (!session.user ? <p className={styles.hint}>로그인하고 내 신청을 확인할 수 있어요.</p> : !view ? <p className={styles.empty}>신청 내역을 불러오는 중이에요.</p> : <>{view.mine.length ? <ul className={styles.list}>{view.mine.map(item => <li key={item.id} data-redemption-id={item.id}><div className={styles.row}><div><strong>{item.rewardName}</strong><small>{formatPoints(item.points)}</small></div><StatusBadge tone={redemptionTone[item.status]}>{redemptionStatusLabel[item.status]}</StatusBadge></div>{item.note && <p className={styles.copy}>{item.note}</p>}{item.reason && <p className={styles.copy}>{item.reason}</p>}<div className={styles.rowActions}><time dateTime={new Date(item.createdAtMs).toISOString()}>{formatRewardDate(item.createdAtMs)}</time>{item.status === 'pending' && <button type="button" className={styles.textButton} aria-label={`${item.rewardName} 신청 취소`} onClick={() => { setCancelTarget({ ...item }); setActionError(''); setFeedback(''); cancelUncertain.current = false; }}>신청 취소</button>}</div></li>)}</ul> : <p className={styles.empty}>아직 신청한 보상이 없어요.</p>}{view.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={styles.button} disabled={morePending || pending} onClick={() => void loadMore()}>{morePending ? '불러오는 중…' : '내 신청 더 불러오기'}</button></div>}</>)}
        {tab === 'ledger' && (session.user && view?.channelId ? <Ledger key={`${ownerId}/${view.channelId}`} channelId={view.channelId} session={session} onAccessError={accessError} /> : <p className={styles.empty}>{session.user ? '이 채널의 포인트 내역을 확인할 수 없어요.' : '로그인하고 포인트 내역을 확인할 수 있어요.'}</p>)}
        {!session.user && <div className={styles.actions}><button type="button" className={`${styles.button} ${styles.primary}`} onClick={callbacks.current.onRequireLogin}>로그인하고 보상 이용</button></div>}
      </>}{error && <p className={styles.error} role="alert">{error}</p>}
    </div></Modal>}
  </>;
}
