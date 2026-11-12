import { MessageSquare, Pin, RefreshCw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError, accountApi } from '../account/account-client';
import type { AccountSession, ProductQuestion, QuestionUpdateInput } from '../account/account-client';
import base from './PollsPage.module.css';
import styles from './ConnectedQuestionsPage.module.css';

type AccessError = (failure: unknown) => boolean;
const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const errorText = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
function Author({ item }: { item: ProductQuestion }) {
  return <Link className={styles.identity} to={`/channel/id/${encodeURIComponent(item.author.channelId)}`} target="_blank" rel="noopener noreferrer">
    <span className={styles.avatar} aria-hidden="true">{[...item.author.displayName][0]}</span><span><strong>{item.author.displayName}</strong><small>@{item.author.handle}</small></span>
  </Link>;
}
function QuestionStatus({ item }: { item: ProductQuestion }) {
  return <span className={styles.state}><StatusBadge tone={item.answer === null ? 'warning' : 'positive'}>{item.answer === null ? '답변 대기' : '답변 완료'}</StatusBadge>{!item.broadcastActive && <small>방송 종료</small>}</span>;
}

function QuestionDialog({ id: questionId, session, onClose, onSaved, onAccessError }: { id: string; session: AccountSession; onClose: () => void; onSaved: () => void; onAccessError: AccessError }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), answerInput = useRef<HTMLTextAreaElement>(null), feedback = useRef<HTMLParagraphElement>(null), opener = useRef(document.activeElement), id = useId();
  const active = useRef(true), request = useRef<AbortController | null>(null), fetching = useRef(false), submitting = useRef(false), access = useRef(onAccessError); access.current = onAccessError;
  const [detail, setDetail] = useState<ProductQuestion | null>(null), [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading'), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState('');
  const [answer, setAnswer] = useState(''), [pinned, setPinned] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(''), [invalidAnswer, setInvalidAnswer] = useState(false), [conflict, setConflict] = useState(false), [discard, setDiscard] = useState(false), [saved, setSaved] = useState(false);
  const dirty = Boolean(detail && (answer !== (detail.answer ?? '') || pinned !== detail.pinned));
  async function load() {
    if (fetching.current || submitting.current) return;
    const abort = new AbortController(); request.current = abort; fetching.current = true; setLoading(true); setLoadError('');
    try {
      const result = await accountApi.question(questionId, abort.signal, session.user!.id);
      if (abort.signal.aborted) return;
      setDetail(result.item); setAnswer(result.item.answer ?? ''); setPinned(result.item.pinned); setConflict(false); setDiscard(false); setError(''); setInvalidAnswer(false); setSaved(false); setPhase('ready');
    } catch (failure) {
      if (abort.signal.aborted || access.current(failure)) return;
      setLoadError(errorText(failure, '질문을 불러오지 못했어요.')); setPhase(previous => previous === 'ready' ? previous : 'error');
    } finally { if (request.current === abort) { fetching.current = false; if (!abort.signal.aborted) setLoading(false); } }
  }
  useEffect(() => {
    active.current = true; const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true }); void load();
    return () => {
      active.current = false; request.current?.abort(); fetching.current = false; element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      else document.getElementById('questions-title')?.focus({ preventScroll: true });
    };
  }, [questionId, session.user!.id]);
  useEffect(() => { if (saved) feedback.current?.focus({ preventScroll: true }); }, [saved]);
  function dismiss() { if (!submitting.current && !fetching.current) onClose(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail || submitting.current || fetching.current || conflict || !dirty) return;
    const changedAnswer = answer !== (detail.answer ?? ''), trimmed = answer.trim().normalize('NFC');
    if (changedAnswer && (!trimmed || [...trimmed].length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed))) {
      setInvalidAnswer(true); setError(detail.answer !== null && !trimmed ? '저장한 답변은 빈 내용으로 바꿀 수 없어요. 답변을 입력하거나 변경을 취소해 주세요.' : '답변을 1~1,000자로 입력해 주세요.'); answerInput.current?.focus(); return;
    }
    const body: QuestionUpdateInput = { version: detail.version };
    if (changedAnswer) body.answer = trimmed;
    if (pinned !== detail.pinned) body.pinned = pinned;
    submitting.current = true; setPending(true); setError(''); setLoadError(''); setInvalidAnswer(false); setSaved(false);
    try {
      const result = await accountApi.updateQuestion(detail.id, body, session.csrfToken, session.user!.id);
      if (!active.current) return;
      setDetail(result.item); setAnswer(result.item.answer ?? ''); setPinned(result.item.pinned); setSaved(true); onSaved();
    } catch (failure) {
      if (!active.current || access.current(failure)) return;
      setError(errorText(failure, '답변과 고정 상태를 저장하지 못했어요. 입력한 내용은 유지돼요.'));
      if (failure instanceof AccountError && failure.code === 'QUESTION_CONFLICT') setConflict(true);
    } finally { submitting.current = false; if (active.current) setPending(false); }
  }
  return <dialog ref={dialog} data-question-id={questionId} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={`${id}-title`} aria-busy={loading || pending}
    onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}><h2 ref={heading} id={`${id}-title`} tabIndex={-1}>질문 답변</h2><button type="button" className="icon-button" aria-label="질문 답변 닫기" disabled={pending || loading} onClick={dismiss}><X size={20} aria-hidden="true" /></button></header>
    {phase === 'loading' ? <p className={styles.loading} role="status">질문을 불러오는 중이에요.</p> : phase === 'error' ? <><p className={styles.error} role="alert">{loadError}</p><button type="button" className={ui.button} disabled={loading} onClick={() => void load()}>질문 다시 시도</button></> : detail && <>
      <Author item={detail} /><p className={styles.questionBody}>{detail.text}</p>
      <div className={styles.facts}><QuestionStatus item={detail} /><time dateTime={new Date(detail.createdAtMs).toISOString()}>{date.format(detail.createdAtMs)}</time>{detail.pinned && <StatusBadge tone="info">방송에 고정됨</StatusBadge>}</div>
      <form noValidate onSubmit={submit}>
        <fieldset className={styles.editor} disabled={pending || loading}>
          <label><span className={styles.fieldHeading}><span>{detail.answer === null ? '답변 작성' : '답변 수정'}</span><small>{[...answer].length.toLocaleString('ko-KR')} / 1,000</small></span><textarea ref={answerInput} className={ui.control} name="question-answer" rows={5} value={answer} maxLength={2000} placeholder="질문한 시청자에게 보낼 답변을 작성하세요" aria-invalid={invalidAnswer} aria-describedby={invalidAnswer ? `${id}-error` : `${id}-answer-help`} onChange={event => { setAnswer(event.target.value); setInvalidAnswer(false); setSaved(false); if (!conflict) setError(''); }} /><small className={styles.hint} id={`${id}-answer-help`}>답변은 질문한 시청자가 확인해요. 고정하면 질문과 함께 모두에게 공개돼요.</small></label>
          <AuthCheckbox className={styles.pin} name="question-pinned" checked={pinned} disabled={pending || loading || (!detail.broadcastActive && !detail.pinned)} onChange={event => { setPinned(event.target.checked); setSaved(false); if (!conflict) setError(''); }}>
            <strong>방송에 고정</strong><small>{detail.broadcastActive ? '모든 시청자에게 질문과 답변을 표시해요. 기존 고정 질문이 있으면 교체돼요.' : '방송이 종료되어 새로 고정할 수 없어요. 답변은 계속 작성할 수 있어요.'}</small>
          </AuthCheckbox>
        </fieldset>
        {loadError && <p className={styles.error} role="alert">{loadError} 입력한 내용은 유지돼요.</p>}
        {error && !conflict && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
        {conflict && <div className={styles.conflict} role="alert"><p>{error} 입력한 답변과 고정 선택은 남아 있어요.</p>{discard ? <><p>입력을 버리고 서버의 최신 답변과 고정 상태를 불러올까요?</p><div className={ui.dialogActions}><button type="button" className={ui.button} disabled={loading} onClick={() => setDiscard(false)}>입력 유지</button><button type="button" className={`${ui.button} ${ui.primary}`} disabled={loading} onClick={() => void load()}>{loading ? '불러오는 중…' : '불러오기'}</button></div></> : <button type="button" className={ui.button} onClick={() => setDiscard(true)}><RefreshCw size={16} aria-hidden="true" />최신 상태 불러오기</button>}</div>}
        {saved && <p ref={feedback} className={styles.success} role="status" tabIndex={-1}>답변과 고정 상태를 저장했어요.</p>}
        <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending || loading} onClick={dismiss}>닫기</button><button type="button" className={ui.button} disabled={pending || loading || !dirty || conflict} onClick={() => { setAnswer(detail.answer ?? ''); setPinned(detail.pinned); setError(''); setInvalidAnswer(false); setSaved(false); }}>변경 취소</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={pending || loading || !dirty || conflict}>{pending ? '저장 중…' : '저장'}</button></div>
      </form>
    </>}
  </dialog>;
}

type State = { key: string; phase: 'loading' | 'ready' | 'error'; items: ProductQuestion[]; nextCursor: string | null; pinnedQuestionId: string | null; error: string };
const initial = (key: string): State => ({ key, phase: 'loading', items: [], nextCursor: null, pinnedQuestionId: null, error: '' });
export function ConnectedQuestionsPage({ session, navigation, onRequireLogin, onSessionChanged }: { session: AccountSession; navigation: ReactNode; onRequireLogin: () => void; onSessionChanged: () => void }) {
  const [params, setParams] = useSearchParams(), owner = session.user!.id;
  const q = (params.get('q') ?? '').trim().slice(0, 120), status = params.get('status') === 'waiting' ? 'waiting' : params.get('status') === 'answered' ? 'answered' : 'all', from = params.get('from') ?? '', to = params.get('to') ?? '', key = JSON.stringify([q, status, from, to]);
  const [state, setState] = useState<State>(() => initial(key)), [attempt, setAttempt] = useState(0), [refreshing, setRefreshing] = useState(false), [more, setMore] = useState(false), [moreError, setMoreError] = useState(''), [hasUpdates, setHasUpdates] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [notice, setNotice] = useState(''), [fieldError, setFieldError] = useState(''), [scopeLost, setScopeLost] = useState(false);
  const active = useRef(true), generation = useRef(0), fetching = useRef(false), morePending = useRef(false), moreAbort = useRef<AbortController | null>(null), paged = useRef(false), passiveNext = useRef(false), stateRef = useRef(state), modalOpen = useRef(false), endInput = useRef<HTMLInputElement>(null), callbacks = useRef({ onRequireLogin, onSessionChanged });
  stateRef.current = state; modalOpen.current = selected !== null; callbacks.current = { onRequireLogin, onSessionChanged };
  const data = state.key === key ? state : initial(key), pinnedItem = data.items.find(item => item.id === data.pinnedQuestionId);
  useEffect(() => { active.current = true; return () => { active.current = false; moreAbort.current?.abort(); }; }, []);
  function accessError(failure: unknown) {
    if (!(failure instanceof AccountError) || !active.current) return false;
    if (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') {
      ++generation.current; moreAbort.current?.abort(); setScopeLost(true); setSelected(null); setState(initial(key));
      if (failure.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged();
      return true;
    }
    return false;
  }
  function refreshList() { passiveNext.current = false; setAttempt(value => value + 1); }
  useEffect(() => {
    const abort = new AbortController(), revision = ++generation.current, passive = passiveNext.current && stateRef.current.key === key && stateRef.current.phase === 'ready';
    passiveNext.current = false; moreAbort.current?.abort(); morePending.current = false; setMore(false); setMoreError(''); fetching.current = true; setRefreshing(true);
    if (!passive) { paged.current = false; setHasUpdates(false); }
    if (stateRef.current.key !== key) setState(initial(key));
    if (scopeLost) { fetching.current = false; return () => abort.abort(); }
    accountApi.questions({ q, status, from, to, limit: 25 }, abort.signal, owner).then(result => {
      if (abort.signal.aborted || generation.current !== revision) return;
      if (passive) {
        const old = stateRef.current;
        if (old.key === key && (JSON.stringify(old.items) !== JSON.stringify(result.items) || old.pinnedQuestionId !== result.pinnedQuestionId)) setHasUpdates(true);
        setState(previous => previous.key === key ? { ...previous, error: '' } : previous);
      } else setState({ key, phase: 'ready', items: result.items, nextCursor: result.nextCursor, pinnedQuestionId: result.pinnedQuestionId, error: '' });
    }).catch(failure => {
      if (abort.signal.aborted || generation.current !== revision || accessError(failure)) return;
      setState(previous => ({ ...(previous.key === key && previous.phase === 'ready' ? previous : initial(key)), phase: previous.key === key && previous.phase === 'ready' ? 'ready' : 'error', error: errorText(failure, '질문 목록을 불러오지 못했어요.') }));
    }).finally(() => { if (!abort.signal.aborted && generation.current === revision) { fetching.current = false; setRefreshing(false); } });
    return () => abort.abort();
  }, [key, attempt, owner, scopeLost]);
  useEffect(() => {
    function wake() { if (document.visibilityState === 'visible' && navigator.onLine && !fetching.current && !morePending.current && !paged.current && !modalOpen.current && !scopeLost) { passiveNext.current = true; setAttempt(value => value + 1); } }
    const timer = window.setInterval(wake, 10000); window.addEventListener('focus', wake); window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [scopeLost]);
  async function loadMore() {
    if (!data.nextCursor || fetching.current || morePending.current || scopeLost) return;
    const abort = new AbortController(), revision = generation.current, cursor = data.nextCursor; moreAbort.current = abort; morePending.current = true; setMore(true); setMoreError('');
    try {
      const result = await accountApi.questions({ q, status, from, to, cursor, limit: 25 }, abort.signal, owner);
      if (abort.signal.aborted || !active.current || generation.current !== revision) return;
      if (result.nextCursor === cursor) throw Error('다음 질문 목록을 확인하지 못했어요.');
      paged.current = true;
      setState(previous => {
        if (previous.key !== key) return previous;
        const known = new Set(previous.items.map(item => item.id));
        return { ...previous, items: [...previous.items, ...result.items.filter(item => !known.has(item.id))], nextCursor: result.nextCursor, pinnedQuestionId: result.pinnedQuestionId };
      });
    } catch (failure) { if (!abort.signal.aborted && active.current && generation.current === revision && !accessError(failure)) setMoreError(errorText(failure, '다음 질문 목록을 불러오지 못했어요.')); }
    finally { if (active.current && generation.current === revision) { morePending.current = false; setMore(false); } }
  }
  function filters(values: Record<string, string>) {
    const next = new URLSearchParams(params); for (const [name, value] of Object.entries(values)) if (value && !(name === 'status' && value === 'all')) next.set(name, value); else next.delete(name);
    setParams(next, { replace: true }); setNotice('');
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget), start = String(form.get('question-from') ?? ''), end = String(form.get('question-to') ?? '');
    if (start && end && start > end) { setFieldError('종료일은 시작일과 같거나 이후여야 해요.'); endInput.current?.focus(); return; }
    setFieldError(''); filters({ q: String(form.get('question-query') ?? '').trim(), from: start, to: end });
  }
  if (scopeLost) return <ManagementPage title="투표 및 질문 관리" titleId="questions-title"><EmptyState icon={<MessageSquare size={23} />} title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="투표 및 질문 관리" titleId="questions-title">
    {navigation}
    {data.pinnedQuestionId && <section className={styles.pinned} aria-label="방송에 고정한 질문"><div><small><Pin size={14} aria-hidden="true" />방송에 고정한 질문</small><p>{pinnedItem?.text ?? '전체 시청자에게 공개한 질문이 있어요.'}</p></div><button type="button" className={ui.button} onClick={() => { setNotice(''); setSelected(data.pinnedQuestionId); }}>고정 질문 보기</button></section>}
    <form key={JSON.stringify([q, from, to])} className={base.filters} role="search" aria-label="질문 검색" onSubmit={search} onReset={() => { setFieldError(''); filters({ q: '', from: '', to: '', status: 'all' }); }}>
      <input className={ui.control} name="question-query" type="search" maxLength={120} defaultValue={q} placeholder="질문이나 작성자 검색" aria-label="질문이나 작성자 검색" />
      <label className={base.dateField}>시작일<input className={ui.control} name="question-from" type="date" defaultValue={from} /></label><label className={base.dateField}>종료일<input ref={endInput} className={ui.control} name="question-to" type="date" defaultValue={to} aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? 'question-range-error' : undefined} /></label><div className={base.filterActions}><button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button><button type="reset" className={ui.button}>초기화</button></div>
    </form>
    {fieldError && <p id="question-range-error" className={styles.error} role="alert">{fieldError}</p>}
    <div className={styles.toolbar}><label className={ui.filterField}>상태<select className={ui.control} name="question-status-filter" value={status} onChange={event => filters({ status: event.target.value })}><option value="all">전체 상태</option><option value="waiting">답변 대기</option><option value="answered">답변 완료</option></select></label><button type="button" className={`${ui.button} ${hasUpdates ? ui.primary : ''}`} aria-label={hasUpdates ? '새 질문과 변경 내용 확인' : '질문 새로고침'} disabled={refreshing || more} onClick={refreshList}><RefreshCw size={16} aria-hidden="true" />{hasUpdates ? '변경 확인' : '새로고침'}</button></div>
    {notice && <p className={styles.success} role="status">{notice}</p>}
    {hasUpdates && <p className={styles.srOnly} role="status">새 질문이나 변경된 내용이 있어요. 변경 확인 버튼으로 불러올 수 있어요.</p>}
    {data.error && <div className={styles.errorArea}><p className={styles.error} role="alert">{data.error}</p><button type="button" className={ui.button} disabled={refreshing} onClick={refreshList}>목록 다시 시도</button></div>}
    {data.phase === 'loading' ? <p className={styles.loading} role="status">질문 목록을 불러오는 중이에요.</p> : data.phase === 'ready' && <>
      {refreshing && <p className={styles.srOnly} role="status">질문 목록을 확인하고 있어요.</p>}
      {data.items.length ? <div className={ui.tableFrame}><table role="table" className={ui.table} aria-label="시청자 질문 목록"><thead role="rowgroup"><tr role="row">{['질문', '작성자', '상태', '접수일', '관리'].map(label => <th role="columnheader" scope="col" key={label}>{label}</th>)}</tr></thead><tbody role="rowgroup">{data.items.map(item => <tr role="row" key={item.id} data-question-id={item.id}>
        <th role="rowheader" scope="row" data-primary="true" className={styles.question}>{item.pinned && <StatusBadge tone="info">고정</StatusBadge>}<strong>{item.text}</strong></th><td role="cell" data-label="작성자"><Author item={item} /></td><td role="cell" data-label="상태"><QuestionStatus item={item} /></td><td role="cell" data-label="접수일"><time dateTime={new Date(item.createdAtMs).toISOString()}>{date.format(item.createdAtMs)}</time></td><td role="cell"><button type="button" className={ui.button} aria-label={`${item.author.displayName} 질문 답변`} onClick={() => { setNotice(''); setSelected(item.id); }}>{item.answer === null ? '답변' : '답변 수정'}</button></td>
      </tr>)}</tbody></table></div> : <EmptyState icon={<MessageSquare size={24} />} title={q || from || to || status !== 'all' ? '조건에 맞는 질문이 없어요' : '아직 도착한 질문이 없어요'} action={q || from || to || status !== 'all' ? <button type="button" className={ui.button} onClick={() => filters({ q: '', from: '', to: '', status: 'all' })}>검색 초기화</button> : undefined} />}
      {data.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={ui.button} disabled={more || refreshing} onClick={() => void loadMore()}>{more ? '불러오는 중…' : moreError ? '더 불러오기 다시 시도' : '더 불러오기'}</button></div>}
    </>}
    {selected && <QuestionDialog key={selected} id={selected} session={session} onAccessError={accessError} onClose={() => setSelected(null)} onSaved={() => { setNotice('질문 답변과 고정 상태를 저장했어요.'); refreshList(); }} />}
  </ManagementPage>;
}
