import { BarChart3, Check, RefreshCw, Vote, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import type { BroadcastKey, ChatAccountActions } from '../../viewer-contract';
import { AccountError, accountApi } from '../account/account-client';
import type { AccountSession, PollView, ProductPoll } from '../account/account-client';
import { pollPercentages } from './poll-format';
import styles from './ViewerPollPanel.module.css';

const reasonText: Record<NonNullable<PollView['reason']>, string> = {
  login_required: '로그인하고 투표에 참여해 주세요.', blocked: '이 채널에서 투표 참여가 제한됐어요.',
  followers_only: '이 채널을 팔로우한 뒤 투표에 참여할 수 있어요.', already_voted: '이미 참여한 투표예요. 계정당 한 번만 선택할 수 있어요.',
  closed: '마감된 투표예요.', broadcast_unavailable: '방송이 종료되어 투표에 참여할 수 없어요.',
};
function remainingLabel(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function PollDialog({ poll, pending, onDismiss, children }: { poll: ProductPoll; pending: boolean; onDismiss: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef(document.activeElement), id = useId();
  useEffect(() => {
    const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[aria-label="시청자 투표 열기"]')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} data-poll-id={poll.id} className={styles.dialog} aria-labelledby={`${id}-title`} aria-busy={pending}
    onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <header className={styles.dialogHeader}><h2 ref={heading} id={`${id}-title`} tabIndex={-1}>시청자 투표</h2>
      <button type="button" className={styles.iconButton} aria-label="시청자 투표 닫기" disabled={pending} onClick={onDismiss}><X size={20} aria-hidden="true" /></button></header>
    {children}
  </dialog>;
}

export function ViewerPollPanel({ broadcast, session, accountActions }: { broadcast: BroadcastKey; session: AccountSession; accountActions: ChatAccountActions }) {
  const ownerId = session.user?.id ?? null, scope = `${broadcast.path}/${broadcast.id}/${ownerId ?? 'anonymous'}`;
  const [view, setView] = useState<PollView | null>(null), [error, setError] = useState(''), [voteError, setVoteError] = useState('');
  const [open, setOpen] = useState(false), [mode, setMode] = useState<'choice' | 'results'>('choice'), [selection, setSelection] = useState<string | null>(null);
  const [pending, setPending] = useState(false), [feedback, setFeedback] = useState(''), [scopeLost, setScopeLost] = useState(false);
  const [clock, setClock] = useState(() => performance.now());
  const anchor = useRef({ serverNowMs: 0, at: performance.now() }), active = useRef(true), generation = useRef(0), writing = useRef(false);
  const getAbort = useRef<AbortController | null>(null), previousPoll = useRef<string | null>(null), currentScope = useRef(scope); currentScope.current = scope;
  const refresh = useRef<(force?: boolean) => Promise<void>>(async () => {}), callbacks = useRef(accountActions); callbacks.current = accountActions;
  const expiryRefresh = useRef<string | null>(null), lost = useRef(false), id = useId();
  const confirmedFeedback = useRef<HTMLParagraphElement>(null);
  const poll = view?.poll ?? null;
  const serverNow = anchor.current.serverNowMs + Math.max(0, clock - anchor.current.at);
  const seconds = poll ? Math.max(0, Math.ceil((poll.endsAtMs - serverNow) / 1000)) : 0;
  const ended = poll?.status === 'closed' || view?.reason === 'closed', deadlinePassed = Boolean(poll && !ended && poll.status === 'active' && seconds === 0);
  const canVote = Boolean(view?.canVote && poll && !ended && !deadlinePassed);
  const resultsVisible = Boolean(poll && (mode === 'results' || poll.myOptionId !== null || ended));
  const percentages = poll ? pollPercentages(poll.options) : [];

  function loseScope(login = false) {
    lost.current = true;
    ++generation.current; getAbort.current?.abort(); setView(null); setOpen(false); setSelection(null); setScopeLost(true);
    if (login) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged(ownerId ?? undefined);
  }
  function accessError(failure: unknown, fromVote = false) {
    if (!(failure instanceof AccountError)) return false;
    if (failure.status === 401) { loseScope(fromVote); return true; }
    if (failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') { loseScope(); return true; }
    return false;
  }
  function accept(result: PollView) {
    if (result.userId !== ownerId) { loseScope(); return false; }
    const now = performance.now(); anchor.current = { serverNowMs: result.serverNowMs, at: now }; setClock(now);
    setView(result); setError(''); return true;
  }
  useEffect(() => { active.current = true; return () => { active.current = false; getAbort.current?.abort(); }; }, []);
  useEffect(() => {
    let disposed = false, request: AbortController | null = null;
    setView(null); setError(''); setVoteError(''); setFeedback(''); setSelection(null); setOpen(false); setScopeLost(false);
    previousPoll.current = null; expiryRefresh.current = null; lost.current = false;
    async function load(force = false) {
      if (disposed || lost.current || writing.current || document.visibilityState !== 'visible' || !navigator.onLine) return;
      if (request && !force) return;
      request?.abort(); const abort = new AbortController(), version = ++generation.current; request = abort; getAbort.current = abort;
      try {
        const result = await accountApi.currentPoll({ path: broadcast.path, broadcastId: broadcast.id }, abort.signal, ownerId ?? undefined);
        if (disposed || abort.signal.aborted || generation.current !== version || currentScope.current !== scope) return;
        accept(result);
      } catch (failure) {
        if (disposed || abort.signal.aborted || generation.current !== version || currentScope.current !== scope || accessError(failure)) return;
        setError(failure instanceof Error ? failure.message : '투표를 불러오지 못했어요.');
      } finally { if (request === abort) request = null; if (getAbort.current === abort) getAbort.current = null; }
    }
    refresh.current = load;
    function wake() {
      setClock(performance.now());
      if (document.visibilityState !== 'visible' || !navigator.onLine) { request?.abort(); request = null; }
      else void load();
    }
    void load(); const interval = window.setInterval(() => void load(), 5000);
    window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('offline', wake); document.addEventListener('visibilitychange', wake);
    return () => {
      disposed = true; ++generation.current; request?.abort(); window.clearInterval(interval);
      window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', wake); document.removeEventListener('visibilitychange', wake);
    };
  }, [scope]);
  useEffect(() => {
    if (!poll) { setOpen(false); setSelection(null); return; }
    if (previousPoll.current && previousPoll.current !== poll.id) { setOpen(false); setSelection(null); setVoteError(''); setFeedback('새 투표가 시작됐어요.'); }
    previousPoll.current = poll.id;
    if (poll.myOptionId !== null) { setSelection(poll.myOptionId); setVoteError(''); }
  }, [poll?.id, poll?.myOptionId]);
  useEffect(() => { if (open && feedback === '투표했어요.') confirmedFeedback.current?.focus({ preventScroll: true }); }, [open, feedback]);
  useEffect(() => {
    if (poll?.status !== 'active') return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setClock(performance.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [poll?.id, poll?.status]);
  useEffect(() => {
    if (!poll || !deadlinePassed || writing.current) return;
    const key = `${poll.id}:${poll.endsAtMs}`;
    if (expiryRefresh.current !== key) { expiryRefresh.current = key; void refresh.current(); }
  }, [poll?.id, poll?.endsAtMs, deadlinePassed]);

  async function vote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writing.current || !poll || !selection || !canVote) return;
    if (!session.user) { callbacks.current.onRequireLogin(); return; }
    const requestScope = scope, pollId = poll.id;
    writing.current = true; setPending(true); setVoteError(''); setFeedback(''); ++generation.current; getAbort.current?.abort();
    let reload = false;
    try {
      const result = await accountApi.votePoll(pollId, { optionId: selection, broadcastId: broadcast.id, path: broadcast.path }, session.csrfToken, session.user.id);
      if (!active.current || currentScope.current !== requestScope || !accept(result)) return;
      setMode('results'); setFeedback('투표했어요.');
    } catch (failure) {
      if (!active.current || currentScope.current !== requestScope || accessError(failure, true)) return;
      setVoteError(failure instanceof Error ? failure.message : '투표하지 못했어요. 선택한 항목은 유지돼요.');
      reload = failure instanceof AccountError && ['POLL_CLOSED', 'POLL_ALREADY_VOTED', 'POLL_PARTICIPATION_BLOCKED', 'POLL_FOLLOW_REQUIRED'].includes(failure.code);
      if (failure instanceof AccountError && reload) {
        const reason = failure.code === 'POLL_CLOSED' ? 'closed' : failure.code === 'POLL_ALREADY_VOTED' ? 'already_voted' : failure.code === 'POLL_PARTICIPATION_BLOCKED' ? 'blocked' : 'followers_only';
        setView(previous => previous?.poll?.id === pollId ? { ...previous, canVote: false, reason } : previous);
        if (reason === 'closed' || reason === 'already_voted') setMode('results');
      }
    } finally {
      writing.current = false;
      if (active.current && currentScope.current === requestScope) { setPending(false); if (reload) void refresh.current(true); }
    }
  }
  function dismiss() { if (!writing.current) setOpen(false); }
  function openDialog() { if (!poll || writing.current) return; setMode(poll.myOptionId !== null || poll.status === 'closed' || !view?.canVote ? 'results' : 'choice'); setFeedback(''); setOpen(true); }
  const eligibility = view?.reason ? reasonText[view.reason] : '';
  const status = ended ? '마감' : deadlinePassed ? '마감 확인 중' : `${remainingLabel(seconds)} 남음`;
  if (scopeLost || (!poll && !error)) return null;

  return <>
    <section className={styles.card} data-poll-id={poll?.id} data-poll-status={poll?.status} aria-label="시청자 투표">
      {poll ? <><div className={styles.cardTitle}><Vote size={16} aria-hidden="true" /><strong>{poll.question}</strong></div><div className={styles.cardFooter}>
        <span>{poll.totalVotes.toLocaleString('ko-KR')}표 · {status}</span><button type="button" className={styles.openButton} aria-label="시청자 투표 열기" onClick={openDialog}>{ended || poll.myOptionId !== null ? '결과 보기' : '투표 참여'}</button>
      </div></> : <p className={styles.error} role="alert">{error}</p>}
      {poll && error && <p className={styles.hint}>최신 투표를 확인하지 못했어요.</p>}
      {error && <button type="button" className={styles.textButton} onClick={() => void refresh.current(true)}>투표 다시 시도</button>}
      {feedback && !open && <p className={styles.success} role="status">{feedback}</p>}
    </section>
    {open && poll && <PollDialog key={poll.id} poll={poll} pending={pending} onDismiss={dismiss}>
      <div className={styles.dialogBody}><div className={styles.question}><h3>{poll.question}</h3><button type="button" className={styles.iconButton} aria-label="투표 새로고침" disabled={pending} onClick={() => void refresh.current(true)}><RefreshCw size={17} aria-hidden="true" /></button></div>
        <p className={styles.meta}>{poll.totalVotes.toLocaleString('ko-KR')}표 · {status}</p>
        {resultsVisible ? <ul className={styles.results} aria-label="투표 결과">{poll.options.map((option, index) => <li key={option.id} data-poll-option-id={option.id} data-mine={poll.myOptionId === option.id}>
          <div><span>{option.text}{poll.myOptionId === option.id && <small className={styles.mine}><Check size={12} aria-hidden="true" />내 선택</small>}</span><strong>{option.votes.toLocaleString('ko-KR')}표 · {percentages[index]}%</strong></div>
          <span className={styles.track} aria-hidden="true"><span style={{ width: `${percentages[index]}%` }} /></span>
        </li>)}</ul> : <form id={`${id}-vote`} onSubmit={vote} aria-label="시청자 투표 참여"><fieldset className={styles.choices} disabled={pending || !canVote}><legend>한 가지를 선택해 주세요</legend>
          {poll.options.map(option => <label className={styles.choice} key={option.id} data-selected={selection === option.id}><input type="radio" name="poll-option" value={option.id} checked={selection === option.id} onChange={() => { setSelection(option.id); setVoteError(''); }} /><span>{option.text}</span></label>)}
        </fieldset></form>}
        {eligibility && <p className={styles.hint}>{eligibility}</p>}{deadlinePassed && <p className={styles.hint} role="status">마감 결과를 확인하고 있어요.</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}{voteError && <p className={styles.error} role="alert">{voteError}</p>}{feedback && <p ref={confirmedFeedback} tabIndex={-1} className={styles.success} role="status">{feedback}</p>}
        <div className={styles.actions}>
          {!session.user && !ended && <button type="button" className={`${styles.button} ${styles.primary}`} onClick={callbacks.current.onRequireLogin}>로그인하고 투표</button>}
          {view?.reason === 'followers_only' && <Link className={styles.button} to={channelHref(poll.channelId)} target="_blank" rel="noopener noreferrer">채널에서 팔로우</Link>}
          {canVote && resultsVisible && <button type="button" className={styles.button} disabled={pending} onClick={() => setMode('choice')}>선택지 보기</button>}
          {!resultsVisible && <><button type="button" className={styles.button} disabled={pending} onClick={() => setMode('results')}><BarChart3 size={16} aria-hidden="true" />결과 보기</button><button type="submit" form={`${id}-vote`} className={`${styles.button} ${styles.primary}`} disabled={pending || !canVote || !selection}>{pending ? '투표하는 중…' : '투표하기'}</button></>}
          {resultsVisible && !canVote && <button type="button" className={styles.button} disabled={pending} onClick={dismiss}>닫기</button>}
        </div>
      </div>
    </PollDialog>}
  </>;
}

function channelHref(id: string) { return `/channel/id/${encodeURIComponent(id)}`; }
