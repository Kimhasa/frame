import { Plus, RefreshCw, Vote, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { watchPath } from '../../viewer-contract';
import { AccountError, accountApi } from '../account/account-client';
import type { AccountSession, PollDetailResult, PollPageResult, ProductPoll } from '../account/account-client';
import { pollPercentages } from './poll-format';
import base from './PollsPage.module.css';
import styles from './ConnectedPollsPage.module.css';

type Broadcast = NonNullable<PollPageResult['currentBroadcast']>;
type AccessError = (failure: unknown) => boolean;
const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const reasonLabel = (poll: ProductPoll) => poll.closeReason === 'expired' ? '시간 종료' : poll.closeReason === 'broadcast_ended' ? '방송 종료' : '마감';
const failureText = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
const isActive = (poll: ProductPoll, now: number) => poll.status === 'active' && poll.endsAtMs > now;
function remaining(until: number, now: number) {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 남음`;
}
function Results({ poll }: { poll: ProductPoll }) {
  const values = pollPercentages(poll.options);
  return <ul className={styles.results} aria-label="선택지별 투표 결과">{poll.options.map((option, index) => <li key={option.id}>
    <div><span>{option.text}</span><strong>{option.votes.toLocaleString('ko-KR')}표 · {values[index]}%</strong></div><span className={styles.track} aria-hidden="true"><span style={{ width: `${values[index]}%` }} /></span>
  </li>)}</ul>;
}
function Modal({ title, pending = false, onClose, children }: { title: string; pending?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef(document.activeElement), id = useId();
  useEffect(() => {
    const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      else document.getElementById('polls-title')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={`${id}-title`} aria-busy={pending}
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <header className={ui.dialogHeader}><h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{title}</h2><button type="button" className="icon-button" aria-label={`${title} 닫기`} disabled={pending} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>{children}
  </dialog>;
}

function CreatePollDialog({ broadcast, session, onClose, onSaved, onAccessError }: {
  broadcast: Broadcast; session: AccountSession; onClose: () => void; onSaved: () => void; onAccessError: AccessError;
}) {
  const [target, setTarget] = useState<Broadcast | null>(broadcast), [question, setQuestion] = useState(''), [options, setOptions] = useState(''), [duration, setDuration] = useState('300');
  const [pending, setPending] = useState(false), [checking, setChecking] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState<'question' | 'options' | null>(null), [stale, setStale] = useState(false);
  const active = useRef(true), submitting = useRef(false), checkingRef = useRef(false), request = useRef<AbortController | null>(null), questionInput = useRef<HTMLInputElement>(null), optionsInput = useRef<HTMLTextAreaElement>(null), id = useId();
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, []);
  async function refreshBroadcast() {
    if (checkingRef.current || submitting.current) return;
    const abort = new AbortController(); request.current = abort; checkingRef.current = true; setChecking(true); setError('');
    try {
      const context = await accountApi.polls({ limit: 1 }, abort.signal, session.user!.id);
      if (abort.signal.aborted) return;
      setTarget(context.currentBroadcast); setStale(Boolean(context.activePollId));
      if (!context.currentBroadcast) setError('송출 중인 방송이 없어요. 방송을 시작한 뒤 다시 확인해 주세요.');
      else if (context.activePollId) setError('진행 중인 투표가 있어요. 해당 투표를 마감한 뒤 새 투표를 만들 수 있어요.');
    } catch (failure) { if (!abort.signal.aborted && !onAccessError(failure)) setError(failureText(failure, '방송 정보를 불러오지 못했어요.')); }
    finally { checkingRef.current = false; if (!abort.signal.aborted) setChecking(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current || checkingRef.current || !target || stale) return;
    const title = question.trim().normalize('NFC'), choices = options.split(/\r?\n/).map(value => value.trim().normalize('NFC')).filter(Boolean);
    const keys = choices.map(value => value.normalize('NFKC').toLocaleLowerCase('en-US'));
    if (!title || [...title].length > 100 || /[\u0000-\u001f\u007f]/.test(title)) {
      setInvalid('question'); setError('질문을 1~100자로 입력해 주세요.'); questionInput.current?.focus(); return;
    }
    if (choices.length < 2 || choices.length > 8 || choices.some(value => [...value].length > 100 || /[\u0000-\u001f\u007f]/.test(value)) || new Set(keys).size !== choices.length) {
      setInvalid('options'); setError('서로 다른 선택지를 2~8개, 각 100자 이내로 입력해 주세요.'); optionsInput.current?.focus(); return;
    }
    submitting.current = true; setPending(true); setError(''); setInvalid(null);
    try {
      await accountApi.createPoll({ question: title, options: choices, durationSeconds: Number(duration) as 60 | 180 | 300 | 600, broadcastId: target.id, path: target.path }, session.csrfToken, session.user!.id);
      if (active.current) onSaved();
    } catch (failure) {
      if (!active.current || onAccessError(failure)) return;
      setError(failureText(failure, '투표를 시작하지 못했어요. 입력한 내용은 유지돼요.'));
      if (failure instanceof AccountError && ['POLL_BROADCAST_UNAVAILABLE', 'POLL_ACTIVE_EXISTS'].includes(failure.code)) setStale(true);
    } finally { submitting.current = false; if (active.current) setPending(false); }
  }
  return <Modal title="투표 만들기" pending={pending || checking} onClose={onClose}>
    <div className={styles.target}><small>참여할 방송</small><strong>{target?.title ?? '방송 신호 대기 중'}</strong></div>
    <form noValidate onSubmit={submit}>
      <fieldset disabled={pending || checking}>
        <label><span className={styles.fieldHeading}><span>질문</span><small>{[...question].length} / 100</small></span><input ref={questionInput} className={ui.control} name="poll-question" value={question} maxLength={200} aria-invalid={invalid === 'question'} aria-describedby={invalid === 'question' ? `${id}-error` : undefined} onChange={event => { setQuestion(event.target.value); setInvalid(null); if (!stale) setError(''); }} /></label>
        <label>선택지<textarea ref={optionsInput} className={ui.control} name="poll-options" rows={5} value={options} maxLength={2000} placeholder="한 줄에 하나씩, 2~8개" aria-invalid={invalid === 'options'} aria-describedby={invalid === 'options' ? `${id}-error` : `${id}-options-hint`} onChange={event => { setOptions(event.target.value); setInvalid(null); if (!stale) setError(''); }} /><small className={styles.hint} id={`${id}-options-hint`}>각 100자 이내 · 같은 선택지는 한 번만 입력해 주세요.</small></label>
        <label>진행 시간<select className={ui.control} name="poll-duration" value={duration} onChange={event => setDuration(event.target.value)}><option value="60">1분</option><option value="180">3분</option><option value="300">5분</option><option value="600">10분</option></select><small className={styles.hint}>시간이 끝나면 자동으로 마감해요. 한 계정당 한 번 참여할 수 있어요.</small></label>
      </fieldset>
      {error && <p className={styles.error} id={`${id}-error`} role="alert">{error}</p>}
      {(stale || !target) && <button type="button" className={styles.textButton} disabled={pending || checking} onClick={() => void refreshBroadcast()}>{checking ? '방송 확인 중…' : '최신 방송으로 다시 연결'}</button>}
      <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending || checking} onClick={onClose}>취소</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={pending || checking || stale || !target}>{pending ? '시작하는 중…' : '투표 시작'}</button></div>
    </form>
  </Modal>;
}

function PollDialog({ initial, serverNowMs, closing, session, onClose, onChanged, onAccessError }: {
  initial: ProductPoll; serverNowMs: number; closing: boolean; session: AccountSession; onClose: () => void; onChanged: () => void; onAccessError: AccessError;
}) {
  const [poll, setPoll] = useState(initial), [offset, setOffset] = useState(serverNowMs - performance.now()), [clock, setClock] = useState(performance.now()), [checkedAt, setCheckedAt] = useState(serverNowMs), [hasFresh, setHasFresh] = useState(false);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [mutationError, setMutationError] = useState(''), [pending, setPending] = useState(false), [conflict, setConflict] = useState(false), [saved, setSaved] = useState(false);
  const active = useRef(true), request = useRef<AbortController | null>(null), fetching = useRef(false), submitting = useRef(false), feedback = useRef<HTMLParagraphElement>(null), access = useRef(onAccessError); access.current = onAccessError;
  const now = clock + offset, running = isActive(poll, now);
  async function load(explicit = false) {
    if (fetching.current || submitting.current || !active.current || (!explicit && (document.visibilityState !== 'visible' || !navigator.onLine))) return;
    const abort = new AbortController(); request.current = abort; fetching.current = true; setLoading(true);
    if (explicit) { setLoadError(''); setMutationError(''); setConflict(false); }
    try {
      const result = await accountApi.poll(initial.id, abort.signal, session.user!.id);
      if (!abort.signal.aborted) { const received = performance.now(); setPoll(result.poll); setOffset(result.serverNowMs - received); setClock(received); setCheckedAt(result.serverNowMs); setHasFresh(true); setLoadError(''); }
    } catch (failure) { if (!abort.signal.aborted && !access.current(failure)) setLoadError(failureText(failure, '최신 투표 결과를 불러오지 못했어요.')); }
    finally { if (request.current === abort) { fetching.current = false; if (!abort.signal.aborted) setLoading(false); } }
  }
  useEffect(() => {
    active.current = true; void load();
    const timer = window.setInterval(() => void load(), 5000), clockTimer = window.setInterval(() => setClock(performance.now()), 1000);
    const wake = () => void load(); window.addEventListener('focus', wake); window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    return () => { active.current = false; request.current?.abort(); fetching.current = false; window.clearInterval(timer); window.clearInterval(clockTimer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [initial.id, session.user!.id]);
  useEffect(() => { if (saved) feedback.current?.focus({ preventScroll: true }); }, [saved]);
  async function closePoll() {
    if (submitting.current || conflict || !running) return;
    request.current?.abort(); request.current = null; fetching.current = false; setLoading(false);
    submitting.current = true; setPending(true); setMutationError(''); setSaved(false);
    try {
      const result = await accountApi.closePoll(poll.id, poll.version, session.csrfToken, session.user!.id);
      if (!active.current) return;
      const received = performance.now(); setPoll(result.poll); setOffset(result.serverNowMs - received); setClock(received); setCheckedAt(result.serverNowMs); setSaved(true); onChanged();
    } catch (failure) {
      if (!active.current || access.current(failure)) return;
      setMutationError(failureText(failure, '투표를 마감하지 못했어요.'));
      if (failure instanceof AccountError && failure.status === 409) setConflict(true);
    } finally { submitting.current = false; if (active.current) setPending(false); }
  }
  return <Modal title={closing && running ? '투표를 마감할까요?' : '투표 결과'} pending={pending} onClose={onClose}>
    <h3>{poll.question}</h3><Results poll={poll} />
    <div className={styles.summary}><span>총 {poll.totalVotes.toLocaleString('ko-KR')}표</span><StatusBadge tone={running ? 'positive' : 'neutral'}>{running ? remaining(poll.endsAtMs, now) : poll.status === 'active' ? '시간 종료' : reasonLabel(poll)}</StatusBadge></div>
    <p className={styles.hint}>{loading ? '최신 결과를 확인하고 있어요.' : `최근 확인 ${timestamp.format(checkedAt)}`}</p>
    {closing && running && <p className={styles.dialogCopy}>마감하면 더 이상 참여할 수 없어요. 현재 결과는 보관돼요.</p>}
    {loadError && <p className={styles.error} role="alert">{loadError} 마지막으로 확인한 결과를 표시하고 있어요.</p>}
    {mutationError && <p className={styles.error} role="alert">{mutationError}</p>}
    {(loadError || conflict) && <button type="button" className={styles.textButton} disabled={pending || loading} onClick={() => void load(true)}><RefreshCw size={14} aria-hidden="true" />최신 결과 불러오기</button>}
    {saved && <p ref={feedback} className={styles.success} role="status" tabIndex={-1}>투표를 마감했어요.</p>}
    <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending} onClick={onClose}>{closing && running ? '계속 진행' : '닫기'}</button>{closing && running && <button type="button" className={`${ui.button} ${ui.danger}`} disabled={pending || (!hasFresh && loading) || conflict} onClick={() => void closePoll()}>{pending ? '마감하는 중…' : '투표 마감'}</button>}</div>
  </Modal>;
}

type ListState = { key: string; phase: 'loading' | 'ready' | 'error'; items: ProductPoll[]; nextCursor: string | null; currentBroadcast: Broadcast | null; activePollId: string | null; offset: number; error: string };
const empty = (key: string): ListState => ({ key, phase: 'loading', items: [], nextCursor: null, currentBroadcast: null, activePollId: null, offset: 0, error: '' });
export function ConnectedPollsPage({ session, onRequireLogin, onSessionChanged, navigation }: { session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void; navigation?: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim().slice(0, 120), status = params.get('status') === 'active' ? 'active' : params.get('status') === 'closed' ? 'closed' : 'all', from = params.get('from') ?? '', to = params.get('to') ?? '', key = JSON.stringify([q, status, from, to]);
  const [state, setState] = useState<ListState>(() => empty(key)), [attempt, setAttempt] = useState(0), [refreshing, setRefreshing] = useState(false), [morePending, setMorePending] = useState(false), [moreError, setMoreError] = useState('');
  const [creating, setCreating] = useState(false), [selected, setSelected] = useState<{ poll: ProductPoll; closing: boolean; now: number } | null>(null), [notice, setNotice] = useState(''), [fieldError, setFieldError] = useState(''), [scopeLost, setScopeLost] = useState(false), [clock, setClock] = useState(performance.now());
  const active = useRef(true), generation = useRef(0), fetching = useRef(false), moreRef = useRef(false), paged = useRef(false), moreAbort = useRef<AbortController | null>(null), stateRef = useRef(state), modalOpen = useRef(false), endInput = useRef<HTMLInputElement>(null), callbacks = useRef({ onRequireLogin, onSessionChanged });
  stateRef.current = state; modalOpen.current = creating || Boolean(selected); callbacks.current = { onRequireLogin, onSessionChanged };
  const data = state.key === key ? state : empty(key), now = clock + data.offset, owner = session.user!.id;
  useEffect(() => { active.current = true; const timer = window.setInterval(() => setClock(performance.now()), 1000); return () => { active.current = false; moreAbort.current?.abort(); window.clearInterval(timer); }; }, []);
  function accessError(failure: unknown) {
    if (!(failure instanceof AccountError) || !active.current) return false;
    if (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') {
      ++generation.current; moreAbort.current?.abort(); setScopeLost(true); setCreating(false); setSelected(null); setState(empty(key));
      if (failure.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged();
      return true;
    }
    return false;
  }
  useEffect(() => {
    const abort = new AbortController(), revision = ++generation.current;
    moreAbort.current?.abort(); moreRef.current = false; paged.current = false; setMorePending(false); setMoreError(''); fetching.current = true; setRefreshing(true);
    if (stateRef.current.key !== key) setState(empty(key));
    if (scopeLost) { fetching.current = false; return () => abort.abort(); }
    accountApi.polls({ q, status, from, to, limit: 25 }, abort.signal, owner).then(result => {
      if (!abort.signal.aborted && generation.current === revision) { const received = performance.now(); setClock(received); setState({ key, phase: 'ready', items: result.items, nextCursor: result.nextCursor, currentBroadcast: result.currentBroadcast, activePollId: result.activePollId, offset: result.serverNowMs - received, error: '' }); }
    }).catch(failure => {
      if (abort.signal.aborted || generation.current !== revision || accessError(failure)) return;
      setState(previous => ({ ...(previous.key === key && previous.phase === 'ready' ? previous : empty(key)), phase: previous.key === key && previous.phase === 'ready' ? 'ready' : 'error', error: failureText(failure, '투표 목록을 불러오지 못했어요.') }));
    }).finally(() => { if (!abort.signal.aborted && generation.current === revision) { fetching.current = false; setRefreshing(false); } });
    return () => abort.abort();
  }, [key, attempt, owner, scopeLost]);
  useEffect(() => {
    function refresh() { if (document.visibilityState === 'visible' && navigator.onLine && !fetching.current && !moreRef.current && !paged.current && !modalOpen.current && !scopeLost) setAttempt(value => value + 1); }
    const timer = window.setInterval(refresh, 10000); window.addEventListener('focus', refresh); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [scopeLost]);
  async function loadMore() {
    if (!data.nextCursor || moreRef.current || fetching.current || scopeLost) return;
    const abort = new AbortController(), revision = generation.current, cursor = data.nextCursor;
    moreAbort.current = abort; moreRef.current = true; setMorePending(true); setMoreError('');
    try {
      const result = await accountApi.polls({ q, status, from, to, limit: 25, cursor }, abort.signal, owner);
      if (abort.signal.aborted || !active.current || generation.current !== revision) return;
      if (result.nextCursor === cursor) throw Error('다음 투표 목록을 확인하지 못했어요.');
      paged.current = true;
      const received = performance.now(); setClock(received);
      setState(previous => {
        if (previous.key !== key) return previous;
        const ids = new Set(previous.items.map(poll => poll.id));
        return { ...previous, items: [...previous.items, ...result.items.filter(poll => !ids.has(poll.id))], nextCursor: result.nextCursor, currentBroadcast: result.currentBroadcast, activePollId: result.activePollId, offset: result.serverNowMs - received };
      });
    } catch (failure) { if (!abort.signal.aborted && active.current && generation.current === revision && !accessError(failure)) setMoreError(failureText(failure, '다음 투표 목록을 불러오지 못했어요.')); }
    finally { if (active.current && generation.current === revision) { moreRef.current = false; setMorePending(false); } }
  }
  function filters(values: Record<string, string>) {
    const next = new URLSearchParams(params); for (const [name, value] of Object.entries(values)) if (value && !(name === 'status' && value === 'all')) next.set(name, value); else next.delete(name);
    setParams(next, { replace: true }); setNotice('');
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget), start = String(form.get('poll-from') ?? ''), end = String(form.get('poll-to') ?? '');
    if (start && end && start > end) { setFieldError('종료일은 시작일과 같거나 이후여야 해요.'); endInput.current?.focus(); return; }
    setFieldError(''); filters({ q: String(form.get('poll-query') ?? '').trim(), from: start, to: end });
  }
  async function showActive() {
    if (!data.activePollId || fetching.current || scopeLost) return;
    const cached = data.items.find(poll => poll.id === data.activePollId);
    if (cached) { setSelected({ poll: cached, closing: false, now }); return; }
    fetching.current = true; setRefreshing(true);
    try {
      const result: PollDetailResult = await accountApi.poll(data.activePollId, undefined, owner);
      if (active.current) setSelected({ poll: result.poll, closing: false, now: result.serverNowMs });
    } catch (failure) { if (active.current && !accessError(failure)) setState(previous => ({ ...previous, error: failureText(failure, '진행 중인 투표를 불러오지 못했어요.') })); }
    finally { fetching.current = false; if (active.current) setRefreshing(false); }
  }
  const canCreate = data.phase === 'ready' && Boolean(data.currentBroadcast) && !data.activePollId && !scopeLost;
  if (scopeLost) return <ManagementPage title="투표 관리" titleId="polls-title"><EmptyState icon={<Vote size={23} />} title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title={navigation ? '투표 및 질문 관리' : '투표 관리'} titleId="polls-title" actions={<button type="button" className={`${ui.button} ${ui.primary}`} id="poll-create-trigger" disabled={!canCreate} onClick={() => { setNotice(''); setCreating(true); }}><Plus size={17} aria-hidden="true" />투표 만들기</button>}>
    {navigation}
    {data.phase === 'ready' && <section className={styles.broadcast} aria-label="투표 참여 방송"><div>{data.currentBroadcast ? <><small>방송 중</small><strong>{data.currentBroadcast.title}</strong></> : <p>투표를 만들려면 방송 신호가 필요해요.</p>}</div>{data.activePollId ? <button type="button" className={ui.button} disabled={refreshing} onClick={() => void showActive()}>진행 중인 투표 보기</button> : data.currentBroadcast && <Link className={ui.button} to={watchPath(data.currentBroadcast)}>방송 화면</Link>}</section>}
    <form key={JSON.stringify([q, from, to])} className={base.filters} role="search" aria-label="투표 검색" onSubmit={search} onReset={() => { setFieldError(''); filters({ q: '', from: '', to: '', status: 'all' }); }}>
      <input className={ui.control} type="search" name="poll-query" aria-label="투표 질문 검색" placeholder="투표 질문 검색" maxLength={120} defaultValue={q} />
      <label className={base.dateField}>시작일<input className={ui.control} type="date" name="poll-from" defaultValue={from} /></label><label className={base.dateField}>종료일<input ref={endInput} className={ui.control} type="date" name="poll-to" defaultValue={to} aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? 'poll-range-error' : undefined} /></label><div className={base.filterActions}><button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button><button type="reset" className={ui.button}>초기화</button></div>
    </form>
    {fieldError && <p className={styles.error} id="poll-range-error" role="alert">{fieldError}</p>}
    <div className={styles.toolbar}><div><label className={ui.filterField}>상태<select className={ui.control} name="poll-status-filter" value={status} onChange={event => filters({ status: event.target.value })}><option value="all">전체 상태</option><option value="active">진행 중</option><option value="closed">마감</option></select></label></div><button type="button" className={ui.button} disabled={refreshing || morePending} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />새로고침</button></div>
    {notice && <p className={styles.success} role="status">{notice}</p>}
    {data.error && <div className={styles.errorArea}><p className={styles.error} role="alert">{data.error}</p><button type="button" className={ui.button} disabled={refreshing} onClick={() => setAttempt(value => value + 1)}>목록 다시 시도</button></div>}
    {data.phase === 'loading' ? <p className={styles.loading} role="status">투표 목록을 불러오는 중이에요.</p> : data.phase === 'ready' && <>
      {refreshing && <p className={styles.srOnly} role="status">최신 투표 결과를 확인하고 있어요.</p>}
      {data.items.length ? <div className={ui.tableFrame}><table className={ui.table} role="table" aria-label="투표 목록"><thead role="rowgroup"><tr role="row">{['질문', '결과', '상태', '관리'].map(label => <th role="columnheader" scope="col" key={label}>{label}</th>)}</tr></thead><tbody role="rowgroup">{data.items.map(poll => {
        const running = isActive(poll, now);
        return <tr role="row" key={poll.id}><th role="rowheader" scope="row" data-primary="true" className={styles.question}><strong>{poll.question}</strong><small><time dateTime={new Date(poll.createdAtMs).toISOString()}>{timestamp.format(poll.createdAtMs)}</time> · 총 {poll.totalVotes.toLocaleString('ko-KR')}표</small></th><td role="cell" data-label="결과"><Results poll={poll} /></td><td role="cell" data-label="상태"><span className={styles.state}><StatusBadge tone={running ? 'positive' : 'neutral'}>{running ? '진행 중' : poll.status === 'active' ? '시간 종료' : reasonLabel(poll)}</StatusBadge>{running && <small>{remaining(poll.endsAtMs, now)}</small>}</span></td><td role="cell"><div className={styles.rowActions}><button type="button" className={ui.button} aria-label={`${poll.question} 결과`} onClick={() => setSelected({ poll, closing: false, now })}>결과</button>{running && <button type="button" className={`${ui.button} ${ui.danger}`} aria-label={`${poll.question} 투표 마감`} onClick={() => setSelected({ poll, closing: true, now })}>투표 마감</button>}</div></td></tr>;
      })}</tbody></table></div> : <EmptyState title={q || from || to || status !== 'all' ? '조건에 맞는 투표가 없어요' : '아직 만든 투표가 없어요'} icon={<Vote size={24} />} action={q || from || to || status !== 'all' ? <button type="button" className={ui.button} onClick={() => filters({ q: '', from: '', to: '', status: 'all' })}>검색 초기화</button> : undefined} />}
      {data.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={ui.button} disabled={morePending || refreshing} onClick={() => void loadMore()}>{morePending ? '불러오는 중…' : moreError ? '더 불러오기 다시 시도' : '더 불러오기'}</button></div>}
    </>}
    {creating && data.currentBroadcast && <CreatePollDialog broadcast={data.currentBroadcast} session={session} onAccessError={accessError} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); filters({ q: '', from: '', to: '', status: 'all' }); setNotice('투표를 시작했어요. 시청자가 방송 화면에서 참여할 수 있어요.'); setAttempt(value => value + 1); }} />}
    {selected && <PollDialog key={selected.poll.id} initial={selected.poll} serverNowMs={selected.now} closing={selected.closing} session={session} onAccessError={accessError} onClose={() => setSelected(null)} onChanged={() => { setNotice('투표를 마감했어요.'); setAttempt(value => value + 1); }} />}
  </ManagementPage>;
}
