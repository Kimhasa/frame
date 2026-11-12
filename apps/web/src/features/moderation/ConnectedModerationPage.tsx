import { Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError, accountApi } from '../account/account-client';
import type { AccountSession, ChatModerationBlock, ChatModerationSettings, ProductChannel } from '../account/account-client';
import styles from './ConnectedModerationPage.module.css';

const dates = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
type AccessError = (failure: unknown) => boolean;
type Draft = { slowMode: boolean; slowSeconds: string; followersOnly: boolean; blockLinks: boolean; bannedWords: string };
const toDraft = (value: ChatModerationSettings): Draft => ({ slowMode: value.slowMode, slowSeconds: String(value.slowSeconds), followersOnly: value.followersOnly, blockLinks: value.blockLinks, bannedWords: value.bannedWords.join('\n') });
const wordsIn = (text: string) => text.split(/[,\n\r]+/).map(word => word.trim().normalize('NFKC')).filter(Boolean);

function Modal({ title, pending = false, onClose, children }: { title: string; pending?: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), id = useId();
  const opener = useRef(document.activeElement);
  useEffect(() => {
    const dialog = ref.current; dialog?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      else document.getElementById('moderation-title')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={`${id}-title`} aria-busy={pending} onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <header className={ui.dialogHeader}><h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{title}</h2><button type="button" className="icon-button" aria-label={`${title} 닫기`} disabled={pending} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
    {children}
  </dialog>;
}

function Settings({ session, onAccessError }: { session: AccountSession; onAccessError: AccessError }) {
  const [saved, setSaved] = useState<ChatModerationSettings | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading'), [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState<'seconds' | 'words' | null>(null), [conflict, setConflict] = useState(false), [discard, setDiscard] = useState(false);
  const active = useRef(true), submitting = useRef(false), secondsInput = useRef<HTMLInputElement>(null), wordsInput = useRef<HTMLTextAreaElement>(null), id = useId();
  const access = useRef(onAccessError); access.current = onAccessError;
  const dirty = Boolean(saved && draft && JSON.stringify(toDraft(saved)) !== JSON.stringify(draft));
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(); setPhase('loading'); setError('');
    accountApi.moderationSettings(abort.signal, session.user!.id).then(value => {
      if (abort.signal.aborted) return;
      setSaved(value); setDraft(toDraft(value)); setConflict(false); setInvalid(null); setPhase('ready');
    }).catch(failure => {
      if (abort.signal.aborted || access.current(failure)) return;
      setError(message(failure, '채팅 설정을 불러오지 못했어요.')); setPhase('error');
    });
    return () => abort.abort();
  }, [session.user!.id, attempt]);
  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(current => current ? { ...current, [key]: value } : current); setNotice(''); setInvalid(null);
    if (!conflict) setError('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!draft || !saved || !dirty || submitting.current || conflict) return;
    const rawSeconds = Number(draft.slowSeconds), validSeconds = /^\d+$/.test(draft.slowSeconds) && Number.isInteger(rawSeconds) && rawSeconds >= 1 && rawSeconds <= 120;
    const seconds = validSeconds ? rawSeconds : saved.slowSeconds, words = wordsIn(draft.bannedWords), unique = new Set(words.map(word => word.toLocaleLowerCase('en-US')));
    if (draft.slowMode && !validSeconds) {
      setInvalid('seconds'); setError('전송 간격은 1~120초 사이의 정수로 입력해 주세요.'); secondsInput.current?.focus(); return;
    }
    if (words.length > 100 || words.some(word => [...word].length > 30 || /[\u0000-\u001f\u007f]/.test(word)) || unique.size !== words.length) {
      setInvalid('words'); setError(unique.size !== words.length ? '중복된 금칙어를 정리해 주세요. 대소문자는 구분하지 않아요.' : '금칙어는 각각 30자 이내로 최대 100개까지 입력해 주세요.'); wordsInput.current?.focus(); return;
    }
    submitting.current = true; setPending(true); setError(''); setNotice(''); setInvalid(null);
    try {
      const value = await accountApi.updateModerationSettings({ version: saved.version, slowMode: draft.slowMode, slowSeconds: seconds, followersOnly: draft.followersOnly, blockLinks: draft.blockLinks, bannedWords: words }, session.csrfToken, session.user!.id);
      if (!active.current) return;
      setSaved(value); setDraft(toDraft(value)); setNotice('채팅 설정을 저장했어요. 지금부터 보내는 메시지에 적용돼요.');
    } catch (failure) {
      if (!active.current || access.current(failure)) return;
      setError(message(failure, '채팅 설정을 저장하지 못했어요. 입력한 내용은 유지돼요.'));
      if (failure instanceof AccountError && failure.code === 'CHAT_SETTINGS_CONFLICT') setConflict(true);
    } finally { submitting.current = false; if (active.current) setPending(false); }
  }
  if (phase !== 'ready' || !saved || !draft) return phase === 'loading' ? <p className={styles.loading} role="status">채팅 설정을 불러오는 중이에요.</p> : <>
    <p role="alert" className={styles.error}>{error}</p><EmptyState title="채팅 설정을 불러오지 못했어요" icon={<ShieldCheck size={23} />} action={<button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}>설정 다시 시도</button>} />
  </>;
  const switches = [
    { key: 'slowMode' as const, name: '느린 채팅', help: '시청자가 메시지를 보내는 간격을 제한해요.' },
    { key: 'followersOnly' as const, name: '팔로워 전용', help: '이 채널을 팔로우한 시청자만 메시지를 보낼 수 있어요.' },
    { key: 'blockLinks' as const, name: '링크 차단', help: '웹 주소가 포함된 시청자 메시지의 전송을 막아요.' },
  ];
  return <div className={styles.settings}>
    <form className={styles.section} noValidate onSubmit={save} aria-busy={pending}>
      <div className={styles.sectionHeading}><h2>채팅 설정</h2><StatusBadge tone={dirty ? 'warning' : 'positive'}>{pending ? '저장 중' : dirty ? '저장하지 않은 변경' : '저장됨'}</StatusBadge></div>
      <p className={styles.muted}>로그인한 계정으로 채팅에 참여해요. 채널 소유자는 느린 채팅·팔로워 전용 제한에서 제외돼요.</p>
      {switches.map(({ key, name, help }) => <label className={styles.switchRow} key={key}>
        <span><strong>{name}</strong><small id={`${id}-${key}`}>{help}</small></span>
        <input type="checkbox" role="switch" aria-label={name} aria-describedby={`${id}-${key}`} checked={draft[key]} disabled={pending} onChange={event => update(key, event.target.checked)} />
        <span className={styles.switch} aria-hidden="true" />
      </label>)}
      <fieldset className={styles.fields} disabled={pending}>
        <label className={styles.field}>전송 간격<span className={styles.seconds}><input ref={secondsInput} name="slow-seconds" className={ui.control} type="number" min={1} max={120} step={1} inputMode="numeric" disabled={!draft.slowMode} value={draft.slowSeconds} aria-invalid={invalid === 'seconds'} aria-describedby={invalid === 'seconds' ? `${id}-error` : `${id}-seconds-help`} onChange={event => update('slowSeconds', event.target.value)} /><span>초</span></span><small id={`${id}-seconds-help`}>1~120초 · 같은 계정의 다른 탭에서도 함께 적용돼요.</small></label>
        <label className={styles.field}><span className={styles.wordHeading}><span>금칙어</span><small>{wordsIn(draft.bannedWords).length} / 100개</small></span>
          <textarea ref={wordsInput} name="banned-words" className={`${ui.control} ${styles.wordInput}`} rows={5} maxLength={6000} value={draft.bannedWords} placeholder="금칙어를 한 줄에 하나씩 입력하세요" aria-invalid={invalid === 'words'} aria-describedby={invalid === 'words' ? `${id}-error` : `${id}-words-help`} onChange={event => update('bannedWords', event.target.value)} />
          <small id={`${id}-words-help`}>줄바꿈 또는 쉼표로 구분 · 각 30자 이내 · 대소문자를 구분하지 않고 포함된 표현을 검사해요.</small>
        </label>
      </fieldset>
      {error && !conflict && <p id={`${id}-error`} role="alert" className={styles.error}>{error}</p>}
      {conflict && <div className={styles.conflict} role="alert"><p>{error} 입력한 내용은 남아 있어요. 최신 설정을 불러온 뒤 다시 수정해 주세요.</p><button type="button" className={ui.button} onClick={() => setDiscard(true)}><RefreshCw size={16} aria-hidden="true" />최신 설정 불러오기</button></div>}
      <div className={styles.footer}><p>{dirty ? '저장하면 현재 방송과 다음 방송에 적용돼요.' : saved.updatedAtMs ? `최근 저장 ${dates.format(saved.updatedAtMs)}` : '변경한 설정이 없어요.'}</p><div className={styles.actions}><button type="button" className={ui.button} disabled={pending || !dirty || conflict} onClick={() => { setDraft(toDraft(saved)); setError(''); setInvalid(null); setNotice('변경한 내용을 취소했어요.'); }}>변경 취소</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={pending || !dirty || conflict}>{pending ? '저장 중…' : '설정 저장'}</button></div></div>
      {notice && <p role="status" className={styles.success}>{notice}</p>}
    </form>
    {discard && <Modal title="최신 설정 불러오기" onClose={() => setDiscard(false)}><p className={styles.dialogCopy}>저장하지 않은 입력을 버리고 서버에 저장된 최신 설정을 불러올까요?</p><div className={ui.dialogActions}><button type="button" className={ui.button} onClick={() => setDiscard(false)}>입력 유지</button><button type="button" className={`${ui.button} ${ui.primary}`} onClick={() => { setDiscard(false); setNotice(''); setAttempt(value => value + 1); }}>불러오기</button></div></Modal>}
  </div>;
}

function BlockDialog({ session, onClose, onSaved, onAccessError }: { session: AccountSession; onClose: () => void; onSaved: (value: ChatModerationBlock) => void; onAccessError: AccessError }) {
  const [handle, setHandle] = useState(''), [target, setTarget] = useState<ProductChannel | null>(null), [lookupError, setLookupError] = useState(''), [looking, setLooking] = useState(false);
  const [duration, setDuration] = useState('600'), [reason, setReason] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState(false);
  const active = useRef(true), searching = useRef<AbortController | null>(null), submitting = useRef(false), reasonInput = useRef<HTMLTextAreaElement>(null), handleInput = useRef<HTMLInputElement>(null), id = useId();
  useEffect(() => { active.current = true; return () => { active.current = false; searching.current?.abort(); }; }, []);
  async function lookup() {
    const value = handle.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]{2,23}$/.test(value)) { setLookupError('채널의 @핸들을 정확히 입력해 주세요.'); handleInput.current?.focus(); return; }
    searching.current?.abort(); const abort = new AbortController(); searching.current = abort; setLooking(true); setLookupError(''); setTarget(null); setError('');
    try {
      const channel = await accountApi.channel(value, abort.signal); if (abort.signal.aborted) return;
      if (channel.id === session.channel?.id) { setLookupError('내 채널은 차단할 수 없어요.'); return; }
      setTarget(channel);
    } catch (failure) { if (!abort.signal.aborted) setLookupError(failure instanceof AccountError && failure.status === 404 ? '해당 핸들의 채널을 찾지 못했어요.' : message(failure, '대상을 찾지 못했어요. 다시 시도해 주세요.')); }
    finally { if (!abort.signal.aborted) setLooking(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!target || submitting.current) return;
    if (!reason.trim() || [...reason].length > 200) { setInvalid(true); setError('제한 사유를 1~200자로 입력해 주세요.'); reasonInput.current?.focus(); return; }
    submitting.current = true; setPending(true); setError(''); setInvalid(false);
    try {
      const row = await accountApi.createModerationBlock({ targetChannelId: target.id, durationSeconds: duration === 'permanent' ? null : Number(duration), reason: reason.trim() }, session.csrfToken, session.user!.id);
      if (active.current) onSaved(row);
    } catch (failure) { if (active.current && !onAccessError(failure)) setError(message(failure, '참여 제한을 저장하지 못했어요.')); }
    finally { submitting.current = false; if (active.current) setPending(false); }
  }
  return <Modal title="채팅 참여 제한" pending={pending} onClose={onClose}>
    <p className={styles.dialogCopy}>선택한 계정이 이 채널에서 메시지를 보내지 못하도록 제한해요. 제한 사유는 채널 소유자만 볼 수 있어요.</p>
    <form onSubmit={submit} noValidate>
      <fieldset className={styles.fields} disabled={pending}>
        <label className={styles.field}>대상 채널 핸들<span className={styles.lookup}><input ref={handleInput} className={ui.control} name="block-handle" placeholder="@채널핸들" value={handle} maxLength={25} autoComplete="off" spellCheck={false} aria-invalid={Boolean(lookupError)} aria-describedby={lookupError ? `${id}-lookup-error` : undefined} onChange={event => { searching.current?.abort(); setLooking(false); setHandle(event.target.value); setTarget(null); setLookupError(''); setError(''); }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void lookup(); } }} /><button type="button" className={ui.button} disabled={looking || !handle.trim()} onClick={() => void lookup()}>{looking ? '찾는 중…' : '대상 확인'}</button></span></label>
        {lookupError && <p id={`${id}-lookup-error`} role="alert" className={styles.error}>{lookupError}</p>}
        {target && <div className={styles.target}><div className={styles.identity}><span className={styles.avatar} aria-hidden="true">{[...target.displayName][0]}</span><span><strong>{target.displayName}</strong><small>@{target.handle}</small></span></div><StatusBadge tone="positive">확인됨</StatusBadge></div>}
        <label className={styles.field}>제한 기간<select className={ui.control} name="block-duration" value={duration} onChange={event => { setDuration(event.target.value); setError(''); }}><option value="600">10분</option><option value="3600">1시간</option><option value="permanent">해제할 때까지</option></select></label>
        <label className={styles.field}>제한 사유<textarea ref={reasonInput} className={ui.control} name="block-reason" rows={3} maxLength={400} value={reason} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : `${id}-reason-help`} onChange={event => { setReason(event.target.value); setInvalid(false); setError(''); }} /><small id={`${id}-reason-help`}>{[...reason].length} / 200자 · 관리용 기록</small></label>
      </fieldset>
      {error && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
      <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending} onClick={onClose}>취소</button><button type="submit" className={`${ui.button} ${ui.danger}`} disabled={pending || !target}>{pending ? '제한하는 중…' : '참여 제한'}</button></div>
    </form>
  </Modal>;
}

function UnblockDialog({ row, session, onClose, onSaved, onAccessError }: { row: ChatModerationBlock; session: AccountSession; onClose: () => void; onSaved: () => void; onAccessError: AccessError }) {
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false), active = useRef(true), submitting = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function remove() {
    if (submitting.current || stale) return;
    submitting.current = true; setPending(true); setError('');
    try { await accountApi.removeModerationBlock(row.id, row.version, session.csrfToken, session.user!.id); if (active.current) onSaved(); }
    catch (failure) {
      if (!active.current || onAccessError(failure)) return;
      setError(message(failure, '참여 제한을 해제하지 못했어요.'));
      if (failure instanceof AccountError && ['CHAT_BLOCK_CONFLICT', 'CHAT_BLOCK_NOT_FOUND'].includes(failure.code)) setStale(true);
    } finally { submitting.current = false; if (active.current) setPending(false); }
  }
  return <Modal title="참여 제한 해제" pending={pending} onClose={onClose}>
    <p className={styles.dialogCopy}>{row.displayName} 님의 채팅 참여 제한을 해제할까요?</p>
    <div className={styles.summary}><div className={styles.identity}><span className={styles.avatar} aria-hidden="true">{[...row.displayName][0]}</span><span><strong>{row.displayName}</strong><small>@{row.handle}</small></span></div><p>{row.reason}<small>{row.expiresAtMs ? `${dates.format(row.expiresAtMs)}까지` : '해제할 때까지'}</small></p></div>
    {error && <p role="alert" className={styles.error}>{error}{stale && ' 목록을 새로 불러와 현재 상태를 확인해 주세요.'}</p>}
    <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending} onClick={onClose}>{stale ? '닫기' : '취소'}</button><button type="button" className={`${ui.button} ${ui.primary}`} disabled={pending || stale} onClick={() => void remove()}>{pending ? '해제하는 중…' : '제한 해제'}</button></div>
  </Modal>;
}

type BlockState = { key: string; phase: 'loading' | 'ready' | 'error'; items: ChatModerationBlock[]; nextCursor: string | null; error: string };
const initialBlocks = (key: string): BlockState => ({ key, phase: 'loading', items: [], nextCursor: null, error: '' });
function Blocks({ session, onAccessError }: { session: AccountSession; onAccessError: AccessError }) {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'all' ? 'all' : params.get('status') === 'expired' ? 'expired' : 'active', q = (params.get('q') ?? '').trim().slice(0, 120), key = JSON.stringify([status, q]);
  const [state, setState] = useState<BlockState>(() => initialBlocks(key)), [attempt, setAttempt] = useState(0), [refreshing, setRefreshing] = useState(false);
  const [more, setMore] = useState(false), [moreError, setMoreError] = useState(''), [adding, setAdding] = useState(false), [removing, setRemoving] = useState<ChatModerationBlock | null>(null), [notice, setNotice] = useState(''), [clock, setClock] = useState(Date.now());
  const active = useRef(true), generation = useRef(0), moreAbort = useRef<AbortController | null>(null), morePending = useRef(false), stateRef = useRef(state), access = useRef(onAccessError);
  stateRef.current = state; access.current = onAccessError;
  const data = state.key === key ? state : initialBlocks(key);
  useEffect(() => { active.current = true; const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => { active.current = false; moreAbort.current?.abort(); window.clearInterval(timer); }; }, []);
  useEffect(() => {
    const abort = new AbortController(), revision = ++generation.current;
    moreAbort.current?.abort(); morePending.current = false; setMore(false); setMoreError(''); setRefreshing(true);
    if (stateRef.current.key !== key) setState(initialBlocks(key));
    accountApi.moderationBlocks({ status, q, limit: 25 }, abort.signal, session.user!.id).then(result => {
      if (!abort.signal.aborted && revision === generation.current) setState({ key, phase: 'ready', items: result.items, nextCursor: result.nextCursor, error: '' });
    }).catch(failure => {
      if (abort.signal.aborted || revision !== generation.current || access.current(failure)) return;
      setState(previous => ({ ...(previous.key === key && previous.phase === 'ready' ? previous : initialBlocks(key)), phase: previous.key === key && previous.phase === 'ready' ? 'ready' : 'error', error: message(failure, '차단 목록을 불러오지 못했어요.') }));
    }).finally(() => { if (!abort.signal.aborted && revision === generation.current) setRefreshing(false); });
    return () => abort.abort();
  }, [key, attempt, session.user!.id]);
  async function loadMore() {
    if (!data.nextCursor || morePending.current || refreshing) return;
    const abort = new AbortController(), revision = generation.current, cursor = data.nextCursor;
    moreAbort.current = abort; morePending.current = true; setMore(true); setMoreError('');
    try {
      const result = await accountApi.moderationBlocks({ status, q, limit: 25, cursor }, abort.signal, session.user!.id);
      if (abort.signal.aborted || !active.current || revision !== generation.current) return;
      if (result.nextCursor === cursor) throw Error('다음 차단 목록을 확인하지 못했어요.');
      setState(previous => {
        if (previous.key !== key) return previous;
        const known = new Set(previous.items.map(item => item.id));
        return { ...previous, items: [...previous.items, ...result.items.filter(item => !known.has(item.id))], nextCursor: result.nextCursor };
      });
    } catch (failure) { if (!abort.signal.aborted && active.current && revision === generation.current && !access.current(failure)) setMoreError(message(failure, '다음 차단 목록을 불러오지 못했어요.')); }
    finally { if (active.current && revision === generation.current) { morePending.current = false; setMore(false); } }
  }
  function filters(values: Record<string, string>) {
    const next = new URLSearchParams(params); for (const [name, value] of Object.entries(values)) if (value && !(name === 'status' && value === 'active')) next.set(name, value); else next.delete(name);
    setParams(next, { replace: true }); setNotice('');
  }
  const visible = data.items.filter(row => status !== 'active' || row.expiresAtMs === null || row.expiresAtMs > clock);
  return <>
    <div className={styles.toolbar}>
      <form className={ui.search} role="search" aria-label="차단 목록 검색" onSubmit={event => { event.preventDefault(); filters({ q: String(new FormData(event.currentTarget).get('block-query') ?? '').trim() }); }}><Search size={17} aria-hidden="true" /><input name="block-query" key={q} defaultValue={q} maxLength={120} placeholder="이름, 핸들, 제한 사유 검색" aria-label="차단 목록 검색" /><button className={styles.searchButton} type="submit">검색</button></form>
      <label className={ui.filterField}>상태<select className={ui.control} name="block-status-filter" value={status} onChange={event => filters({ status: event.target.value })}><option value="active">제한 중</option><option value="expired">기간 만료</option><option value="all">전체</option></select></label>
      <button type="button" className={ui.button} disabled={refreshing || more} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />새로고침</button>
      <button type="button" className={`${ui.button} ${ui.primary}`} onClick={() => { setNotice(''); setAdding(true); }}><Plus size={16} aria-hidden="true" />참여 제한 추가</button>
    </div>
    {notice && <p role="status" className={styles.success}>{notice}</p>}
    {data.error && <div className={styles.errorArea}><p className={styles.error} role="alert">{data.error}</p><button type="button" className={ui.button} disabled={refreshing} onClick={() => setAttempt(value => value + 1)}>목록 다시 시도</button></div>}
    {data.phase === 'loading' ? <p role="status" className={styles.loading}>차단 목록을 불러오는 중이에요.</p> : data.phase === 'ready' && <>
      {refreshing && <p className={styles.loading} role="status">목록을 새로 불러오는 중이에요.</p>}
      {visible.length ? <div className={ui.tableFrame}><table className={ui.table} role="table" aria-label="채팅 참여 제한 목록"><thead role="rowgroup"><tr role="row">{['대상', '제한 사유', '등록일', '상태·기한', '관리'].map(label => <th role="columnheader" scope="col" key={label}>{label}</th>)}</tr></thead><tbody role="rowgroup">{visible.map(row => {
        const expired = row.expiresAtMs !== null && row.expiresAtMs <= clock;
        return <tr role="row" key={row.id}><td role="cell" data-primary="true"><div className={styles.identity}><span className={styles.avatar} aria-hidden="true">{[...row.displayName][0]}</span><span><strong>{row.displayName}</strong><small>@{row.handle}</small></span></div></td><td role="cell" data-label="제한 사유"><span className={styles.reason}>{row.reason}</span></td><td role="cell" data-label="등록일"><time dateTime={new Date(row.createdAtMs).toISOString()}>{dates.format(row.createdAtMs)}</time></td><td role="cell" data-label="상태·기한"><span className={styles.expiry}><StatusBadge tone={expired ? 'neutral' : 'danger'}>{expired ? '기간 만료' : '제한 중'}</StatusBadge>{row.expiresAtMs ? <time dateTime={new Date(row.expiresAtMs).toISOString()}>{dates.format(row.expiresAtMs)}까지</time> : <small className={styles.hint}>해제할 때까지</small>}</span></td><td role="cell"><button type="button" className={ui.button} disabled={refreshing || more || expired} aria-label={`${row.displayName} 참여 제한 해제`} onClick={() => setRemoving(row)}>{expired ? '만료됨' : '제한 해제'}</button></td></tr>;
      })}</tbody></table></div> : <EmptyState title={q ? '검색 조건에 맞는 사용자가 없어요' : status === 'expired' ? '기간이 만료된 제한이 없어요' : status === 'all' ? '등록된 참여 제한이 없어요' : '채팅 참여가 제한된 사용자가 없어요'} icon={<ShieldCheck size={23} />} description={q ? '다른 이름이나 핸들로 검색해 보세요.' : undefined} action={q ? <button type="button" className={ui.button} onClick={() => filters({ q: '' })}>검색 초기화</button> : undefined} />}
      {data.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={ui.button} disabled={more || refreshing} onClick={() => void loadMore()}>{more ? '불러오는 중…' : moreError ? '더 불러오기 다시 시도' : '더 불러오기'}</button></div>}
    </>}
    {adding && <BlockDialog session={session} onAccessError={onAccessError} onClose={() => setAdding(false)} onSaved={row => { setAdding(false); setNotice(`${row.displayName} 님의 채팅 참여를 제한했어요.`); setAttempt(value => value + 1); }} />}
    {removing && <UnblockDialog row={removing} session={session} onAccessError={onAccessError} onClose={() => { setRemoving(null); setAttempt(value => value + 1); }} onSaved={() => { const row = removing; setRemoving(null); setState(previous => ({ ...previous, items: previous.items.filter(item => item.id !== row.id) })); setNotice(`${row.displayName} 님의 참여 제한을 해제했어요.`); setAttempt(value => value + 1); }} />}
  </>;
}

export function ConnectedModerationPage({ session, onRequireLogin, onSessionChanged }: { session: AccountSession; onRequireLogin: () => void; onSessionChanged?: () => void }) {
  const [params, setParams] = useSearchParams(), tab = params.get('tab') === 'blocked' ? 'blocked' : 'settings';
  const [denied, setDenied] = useState(false), callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  function accessError(failure: unknown) {
    if (!(failure instanceof AccountError)) return false;
    if (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID' || (failure.status === 403 && ['CHANNEL_OWNER_REQUIRED', 'FORBIDDEN'].includes(failure.code))) {
      setDenied(true);
      if (failure.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged?.();
      return true;
    }
    return false;
  }
  if (denied) return <ManagementPage title="채팅 관리" titleId="moderation-title"><EmptyState icon={<ShieldCheck size={23} />} title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={() => callbacks.current.onSessionChanged?.()}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="채팅 관리" titleId="moderation-title">
    <nav className={ui.tabs} aria-label="채팅 관리 메뉴">{[{ id: 'settings', label: '설정' }, { id: 'blocked', label: '차단 목록' }].map(item => <button type="button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => { const next = new URLSearchParams(params); if (item.id === 'settings') next.delete('tab'); else next.set('tab', item.id); setParams(next); }}>{item.label}</button>)}</nav>
    <div hidden={tab !== 'settings'}><Settings session={session} onAccessError={accessError} /></div>
    {tab === 'blocked' && <Blocks session={session} onAccessError={accessError} />}
  </ManagementPage>;
}
