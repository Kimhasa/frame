import { MessageSquare, Pin, RefreshCw, Send, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { BroadcastKey, ChatAccountActions } from '../../viewer-contract';
import { AccountError, accountApi } from '../account/account-client';
import type { AccountSession, OwnQuestion, ProductQuestion, QuestionSubmitInput, QuestionView } from '../account/account-client';
import styles from './ViewerQuestionsPanel.module.css';

const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const reasons: Record<NonNullable<QuestionView['reason']>, string> = {
  login_required: '로그인하고 질문을 보낼 수 있어요.', blocked: '이 채널에서 질문 참여가 제한됐어요.',
  followers_only: '이 채널을 팔로우한 뒤 질문을 보낼 수 있어요.', broadcast_unavailable: '방송이 종료되어 새 질문을 보낼 수 없어요.',
  rate_limited: '질문을 잠시 쉬었다가 보내 주세요.',
};
function QuestionDialog({ pending, onClose, children }: { pending: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef(document.activeElement), id = useId();
  useEffect(() => {
    const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[aria-label="시청자 질문 열기"]')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={id} aria-busy={pending} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className={styles.dialogHeader}><h2 id={id} ref={heading} tabIndex={-1}>질문과 답변</h2><button type="button" className={styles.iconButton} aria-label="질문과 답변 닫기" disabled={pending} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
    {children}
  </dialog>;
}
function QuestionContent({ question }: { question: ProductQuestion }) {
  return <><p className={styles.questionText}>{question.text}</p>{question.answer !== null && <div className={styles.answer}><small>방송자 답변</small><p>{question.answer}</p></div>}
    <div className={styles.questionMeta}><span data-answered={question.answer !== null}>{question.answer !== null ? '답변 완료' : '답변 대기'}{question.pinned ? ' · 고정됨' : ''}</span><time dateTime={new Date(question.createdAtMs).toISOString()}>{timestamp.format(question.createdAtMs)}</time></div></>;
}

export function ViewerQuestionsPanel({ broadcast, session, accountActions }: { broadcast: BroadcastKey; session: AccountSession; accountActions: ChatAccountActions }) {
  const ownerId = session.user?.id ?? null, scope = `${broadcast.path}/${broadcast.id}/${ownerId ?? 'anonymous'}`;
  const [view, setView] = useState<QuestionView | null>(null), [error, setError] = useState(''), [submitError, setSubmitError] = useState('');
  const [draft, setDraft] = useState(''), [open, setOpen] = useState(false), [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false);
  const [morePending, setMorePending] = useState(false), [moreError, setMoreError] = useState(''), [feedback, setFeedback] = useState(''), [focusFeedback, setFocusFeedback] = useState(false);
  const [invalid, setInvalid] = useState(false), [scopeLost, setScopeLost] = useState(false), [clock, setClock] = useState(performance.now());
  const active = useRef(true), currentScope = useRef(scope), callbacks = useRef(accountActions), generation = useRef(0), writing = useRef(false), lost = useRef(false);
  currentScope.current = scope; callbacks.current = accountActions;
  const request = useRef<AbortController | null>(null), moreAbort = useRef<AbortController | null>(null), moreRef = useRef(false), paged = useRef(false);
  const submitted = useRef<QuestionSubmitInput | null>(null), nextRequestId = useRef(crypto.randomUUID()), quotaUntil = useRef(0), expiryRefresh = useRef(0);
  const refresh = useRef<(force?: boolean) => Promise<void>>(async () => {}), success = useRef<HTMLParagraphElement>(null), input = useRef<HTMLTextAreaElement>(null), id = useId();
  const seconds = Math.max(0, Math.ceil((quotaUntil.current - clock) / 1000));
  const canSubmit = Boolean(view?.canSubmit && seconds === 0 && session.user);

  function loseScope(login = false) {
    lost.current = true; ++generation.current; request.current?.abort(); moreAbort.current?.abort(); submitted.current = null;
    setView(null); setDraft(''); setOpen(false); setScopeLost(true); setUncertain(false);
    if (login) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged(ownerId ?? undefined);
  }
  function accessError(failure: unknown, fromSubmit = false) {
    if (!(failure instanceof AccountError)) return false;
    if (failure.status === 401) { loseScope(fromSubmit); return true; }
    if (failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') { loseScope(); return true; }
    return false;
  }
  function confirm(item: OwnQuestion, userInitiated: boolean) {
    if (submitted.current?.clientRequestId !== item.clientRequestId) return;
    submitted.current = null; nextRequestId.current = crypto.randomUUID(); setUncertain(false); setDraft(''); setSubmitError(''); setInvalid(false);
    setFeedback(userInitiated ? '질문을 보냈어요.' : '질문이 접수됐어요.'); setFocusFeedback(userInitiated);
  }
  function accept(result: QuestionView, append = false) {
    if (result.userId !== ownerId) { loseScope(); return false; }
    const now = performance.now(); quotaUntil.current = now + (result.retryAfterMs ?? 0); setClock(now); setError('');
    setView(previous => {
      if (!previous || (!append && !paged.current)) return result;
      const first = append ? previous.mine : result.mine, rest = append ? result.mine : previous.mine, ids = new Set(first.map(item => item.id));
      return { ...result, mine: [...first, ...rest.filter(item => !ids.has(item.id))], nextCursor: append ? result.nextCursor : previous.nextCursor };
    });
    const committed = submitted.current && result.mine.find(item => item.clientRequestId === submitted.current!.clientRequestId);
    if (committed) confirm(committed, false);
    return true;
  }
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); moreAbort.current?.abort(); }; }, []);
  useEffect(() => {
    let disposed = false;
    setView(null); setError(''); setSubmitError(''); setDraft(''); setOpen(false); setPending(false); setUncertain(false); setFeedback(''); setScopeLost(false);
    submitted.current = null; nextRequestId.current = crypto.randomUUID(); paged.current = false; lost.current = false; quotaUntil.current = 0; expiryRefresh.current = 0;
    async function load(force = false) {
      if (disposed || lost.current || writing.current || moreRef.current || document.visibilityState !== 'visible' || !navigator.onLine) return;
      if (request.current && !force) return;
      request.current?.abort(); const abort = new AbortController(), revision = ++generation.current; request.current = abort;
      try {
        const result = await accountApi.currentQuestions({ path: broadcast.path, broadcastId: broadcast.id }, { limit: 20 }, abort.signal, ownerId ?? undefined);
        if (disposed || abort.signal.aborted || generation.current !== revision || currentScope.current !== scope) return;
        accept(result);
      } catch (failure) {
        if (disposed || abort.signal.aborted || generation.current !== revision || currentScope.current !== scope || accessError(failure)) return;
        setError(failure instanceof Error ? failure.message : '질문을 불러오지 못했어요.');
      } finally { if (request.current === abort) request.current = null; }
    }
    refresh.current = load;
    function wake() {
      setClock(performance.now());
      if (document.visibilityState !== 'visible' || !navigator.onLine) { request.current?.abort(); request.current = null; }
      else void load();
    }
    void load(); const timer = window.setInterval(() => void load(), 5000);
    window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('offline', wake); document.addEventListener('visibilitychange', wake);
    return () => {
      disposed = true; ++generation.current; request.current?.abort(); request.current = null; moreAbort.current?.abort(); window.clearInterval(timer);
      window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', wake); document.removeEventListener('visibilitychange', wake);
    };
  }, [scope]);
  useEffect(() => {
    if (view?.reason !== 'rate_limited') return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setClock(performance.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [view?.reason]);
  useEffect(() => {
    if (view?.reason === 'rate_limited' && seconds === 0 && quotaUntil.current > 0 && expiryRefresh.current !== quotaUntil.current) {
      expiryRefresh.current = quotaUntil.current; void refresh.current();
    }
  }, [view?.reason, seconds]);
  useEffect(() => { if (open && feedback && focusFeedback) success.current?.focus({ preventScroll: true }); }, [open, feedback, focusFeedback]);

  async function loadMore() {
    if (!view?.nextCursor || moreRef.current || writing.current || lost.current) return;
    const cursor = view.nextCursor, requestScope = scope;
    request.current?.abort(); request.current = null; const revision = ++generation.current, abort = new AbortController(); moreAbort.current = abort;
    moreRef.current = true; setMorePending(true); setMoreError('');
    try {
      const result = await accountApi.currentQuestions({ path: broadcast.path, broadcastId: broadcast.id }, { limit: 20, cursor }, abort.signal, ownerId ?? undefined);
      if (!active.current || abort.signal.aborted || generation.current !== revision || currentScope.current !== requestScope) return;
      if (result.nextCursor === cursor) throw Error('다음 질문 목록을 확인하지 못했어요.');
      paged.current = true; accept(result, true);
    } catch (failure) {
      if (!active.current || abort.signal.aborted || generation.current !== revision || currentScope.current !== requestScope || accessError(failure)) return;
      setMoreError(failure instanceof Error ? failure.message : '다음 질문을 불러오지 못했어요.');
    } finally {
      if (moreAbort.current === abort) { moreAbort.current = null; moreRef.current = false; if (active.current && currentScope.current === requestScope) setMorePending(false); }
    }
  }
  async function sendQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writing.current || (!uncertain && !canSubmit) || lost.current) return;
    if (!session.user) { callbacks.current.onRequireLogin(); return; }
    const text = draft.trim();
    if (!submitted.current && (!text || [...text].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))) {
      setSubmitError('질문을 1~500자 이내로 입력해 주세요.'); setInvalid(true); input.current?.focus(); return;
    }
    const body = submitted.current ?? { path: broadcast.path, broadcastId: broadcast.id, text, clientRequestId: nextRequestId.current }, requestScope = scope;
    submitted.current = body; writing.current = true; setPending(true); setSubmitError(''); setFeedback(''); setInvalid(false);
    ++generation.current; request.current?.abort(); request.current = null; moreAbort.current?.abort();
    try {
      const result = await accountApi.submitQuestion(body, session.csrfToken, session.user.id);
      if (!active.current || currentScope.current !== requestScope) return;
      if (result.userId !== ownerId) { loseScope(); return; }
      setView(previous => previous ? { ...previous, mine: [result.item, ...previous.mine.filter(item => item.id !== result.item.id)] } : previous);
      confirm(result.item, true);
    } catch (failure) {
      if (!active.current || currentScope.current !== requestScope || accessError(failure, true)) return;
      if (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500) {
        setUncertain(true); setSubmitError('전송 결과를 확인하지 못했어요. 같은 질문으로 다시 확인해 주세요.');
      } else {
        submitted.current = null; nextRequestId.current = crypto.randomUUID(); setUncertain(false);
        setSubmitError(failure.message);
        const reason: QuestionView['reason'] = failure.code === 'QUESTION_PARTICIPATION_BLOCKED' ? 'blocked' : failure.code === 'QUESTION_FOLLOW_REQUIRED' ? 'followers_only'
          : failure.code === 'QUESTION_BROADCAST_UNAVAILABLE' ? 'broadcast_unavailable' : failure.code === 'QUESTION_RATE_LIMITED' ? 'rate_limited' : null;
        if (reason) {
          if (reason === 'rate_limited') { quotaUntil.current = performance.now() + (failure.retryAfterMs ?? 0); setClock(performance.now()); }
          setView(previous => previous ? { ...previous, canSubmit: false, reason, retryAfterMs: reason === 'rate_limited' ? failure.retryAfterMs ?? null : null } : previous);
        }
      }
    } finally {
      writing.current = false;
      if (active.current && currentScope.current === requestScope) { setPending(false); void refresh.current(true); }
    }
  }
  function dismiss() { if (!writing.current) setOpen(false); }
  function refreshQuestions() { if (!writing.current && !moreRef.current) { paged.current = false; void refresh.current(true); } }
  const pinned = view?.pinned, eligibility = view?.reason ? reasons[view.reason] : '';
  if (scopeLost) return null;
  return <>
    <section className={styles.card} aria-label="시청자 질문" data-pinned-question-id={pinned?.id}>
      <div className={styles.cardTitle}>{pinned ? <Pin size={15} aria-hidden="true" /> : <MessageSquare size={15} aria-hidden="true" />}<strong>{pinned ? '고정된 질문' : '질문과 답변'}</strong></div>
      {pinned && <p className={styles.cardCopy}>{pinned.text}</p>}
      <div className={styles.cardFooter}><span>{pinned ? pinned.answer !== null ? '방송자 답변이 도착했어요' : '방송자가 고정한 질문이에요' : '궁금한 점을 방송자에게 물어보세요'}</span><button type="button" className={styles.textButton} aria-label="시청자 질문 열기" onClick={() => { setFocusFeedback(false); setOpen(true); }}>{pinned ? '질문 보기' : '질문하기'}</button></div>
      {error && <p className={styles.error} role="alert">{view ? '최신 질문을 확인하지 못했어요.' : error}</p>}
      {feedback && !open && <p className={styles.success} role="status">{feedback}</p>}
    </section>
    {open && <QuestionDialog pending={pending} onClose={dismiss}><div className={styles.dialogBody}>
      {pinned && <section className={styles.pinned} data-pinned-question-id={pinned.id} aria-label="고정된 질문"><div className={styles.sectionHeading}><h3><Pin size={13} aria-hidden="true" />고정된 질문</h3><span className={styles.hint}>@{pinned.author.handle}</span></div><QuestionContent question={pinned} /></section>}
      <section aria-label="질문 보내기"><div className={styles.sectionHeading}><h3>질문 보내기</h3><button type="button" className={styles.iconButton} aria-label="질문 새로고침" disabled={pending || morePending} onClick={refreshQuestions}><RefreshCw size={17} aria-hidden="true" /></button></div>
        {session.user ? <form className={styles.form} aria-label="시청자 질문 보내기" noValidate onSubmit={sendQuestion}>
          <label className={styles.fieldHeading} htmlFor={`${id}-text`}><span>질문</span><small>{[...draft].length} / 500</small></label>
          <textarea ref={input} id={`${id}-text`} name="viewer-question-text" className={styles.textarea} rows={3} maxLength={1000} value={draft} readOnly={pending || uncertain}
            aria-invalid={invalid || undefined} aria-describedby={`${id}-privacy${submitError ? ` ${id}-error` : ''}`} placeholder="방송자에게 궁금한 내용을 적어 주세요" onChange={event => { setDraft(event.target.value); setInvalid(false); setSubmitError(''); setFeedback(''); }} />
          <p className={styles.hint} id={`${id}-privacy`}>질문과 답변은 나와 방송자에게 보여요. 방송자가 고정하면 모두 볼 수 있어요.</p>
          {eligibility && <p className={styles.hint}>{view?.reason === 'rate_limited' && seconds > 0 ? `${seconds}초 후에 다시 질문을 보낼 수 있어요.` : eligibility}</p>}
          {submitError && <p id={`${id}-error`} className={styles.error} role="alert">{submitError}</p>}
          <div className={styles.actions}><button type="submit" className={`${styles.button} ${styles.primary}`} disabled={pending || (!uncertain && !canSubmit) || !draft.trim()}><Send size={15} aria-hidden="true" />{pending ? '보내는 중…' : uncertain ? '전송 다시 확인' : '질문 보내기'}</button></div>
        </form> : <><p className={styles.hint}>로그인하고 질문을 보내거나 내 답변을 확인할 수 있어요.</p><div className={styles.actions}><button type="button" className={`${styles.button} ${styles.primary}`} onClick={callbacks.current.onRequireLogin}>로그인하고 질문</button></div></>}
      </section>
      {error && <p className={styles.error} role="alert">{error}</p>}{feedback && <p ref={success} tabIndex={-1} className={styles.success} role="status">{feedback}</p>}
      {session.user && <section aria-label="내 질문"><div className={styles.sectionHeading}><h3>내 질문</h3><span className={styles.hint}>{view ? `${view.mine.length}개${view.nextCursor ? ' 표시' : ''}` : '불러오는 중'}</span></div>
        {!view ? <p className={styles.empty}>{error ? '내 질문을 확인하지 못했어요.' : '내 질문을 불러오는 중이에요.'}</p> : view.mine.length ? <ul className={styles.list}>{view.mine.map(question => <li key={question.id} data-question-id={question.id}><QuestionContent question={question} /></li>)}</ul> : <p className={styles.empty}>아직 보낸 질문이 없어요.</p>}
        {view?.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={styles.button} disabled={morePending || pending} onClick={() => void loadMore()}>{morePending ? '불러오는 중…' : moreError ? '내 질문 더 불러오기 다시 시도' : '내 질문 더 불러오기'}</button></div>}
      </section>}
    </div></QuestionDialog>}
  </>;
}
