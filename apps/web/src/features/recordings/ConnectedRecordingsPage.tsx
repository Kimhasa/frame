import { Download, FolderOpen, RefreshCw, Search, Video, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import type { StatusTone } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { recordingsApi } from './recordings-client';
import { VodPublicationPanel } from '../vod/VodPublicationPanel';
import type { ProductRecording, RecordingFilter, RecordingPage, RecordingStatus } from './recordings-client';
import base from './RecordingsPage.module.css';
import styles from './ConnectedRecordingsPage.module.css';

const statusLabel: Record<RecordingStatus, string> = { ready: '완료', recording: '녹화 중', ambiguous: '구간 확인 필요', missing: '파일 없음', corrupt: '재생 불가' };
const statusTone: Record<RecordingStatus, StatusTone> = { ready: 'positive', recording: 'live', ambiguous: 'warning', missing: 'danger', corrupt: 'danger' };
const filters: { value: RecordingFilter; label: string }[] = [{ value: 'all', label: '전체' }, ...Object.entries(statusLabel).map(([value, label]) => ({ value: value as RecordingStatus, label })), { value: 'hidden', label: '숨김' }];
const formatDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' });
const numbers = new Intl.NumberFormat('ko-KR');
const errorText = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
type AccessError = (failure: unknown) => boolean;

function size(bytes: number | null) {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${numbers.format(bytes)} B`;
  const exponent = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(bytes / 1024 ** exponent)} ${['B', 'KB', 'MB', 'GB', 'TB'][exponent]}`;
}
function duration(ms: number | null) {
  if (ms === null) return '—';
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function explanation(item: ProductRecording) {
  if (item.reason) return item.reason;
  if (item.hidden) return '숨김 목록에 보관한 항목이에요. 목록에 복원하면 파일 상태를 다시 확인할 수 있어요.';
  return {
    ready: '확인된 녹화 파일이에요.',
    recording: '녹화 파일을 기록하고 있어요. 파일이 마무리되면 재생 가능 여부를 확인해요.',
    ambiguous: '이 파일의 방송 구간을 안전하게 확인하지 못했어요. 다른 방송이 포함되지 않도록 재생과 다운로드를 제한해요.',
    missing: '서버에서 원본 파일을 찾지 못했어요. 보관 기한이 지났거나 파일이 이동했을 수 있어요.',
    corrupt: '파일 구조를 확인하지 못해 재생과 다운로드를 제한했어요.',
  }[item.status];
}
function RecordingBadge({ item }: { item: ProductRecording }) {
  return <StatusBadge tone={item.hidden ? 'neutral' : statusTone[item.status]}>{item.hidden ? '숨김' : statusLabel[item.status]}</StatusBadge>;
}

function RecordingDialog({ recordingId, session, online, onClose, onSaved, onAccessError }: {
  recordingId: string; session: AccountSession; online: boolean; onClose: (item: ProductRecording | null) => void; onSaved: (item: ProductRecording) => void; onAccessError: AccessError;
}) {
  const owner = session.user!.id, id = useId(), dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), video = useRef<HTMLVideoElement>(null), opener = useRef(document.activeElement), actionTrigger = useRef<HTMLButtonElement>(null), cancelAction = useRef<HTMLButtonElement>(null), wasConfirming = useRef(false);
  const active = useRef(true), abort = useRef<AbortController | null>(null), fetching = useRef(false), writing = useRef(false), checkingMedia = useRef(false), access = useRef(onAccessError), onlineNow = useRef(online);
  access.current = onAccessError; onlineNow.current = online;
  const [item, setItem] = useState<ProductRecording | null>(null), [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading'), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState(false), [confirming, setConfirming] = useState(false);
  const vodBusy = useRef(false), [publicationBusy, setPublicationBusy] = useState(false);
  const [mediaSrc, setMediaSrc] = useState<string | null>(null), [mediaError, setMediaError] = useState(''), [mediaLoading, setMediaLoading] = useState(false);
  function releaseVideo() {
    const element = video.current; if (!element) return;
    if (document.pictureInPictureElement === element) void document.exitPictureInPicture().catch(() => {});
    element.pause(); element.removeAttribute('src'); element.load();
  }
  function stopVideo() { releaseVideo(); setMediaSrc(null); setMediaLoading(false); }
  async function load(): Promise<ProductRecording | null> {
    if (fetching.current || writing.current || vodBusy.current || !onlineNow.current) return null;
    const request = new AbortController(); abort.current = request; fetching.current = true; setLoading(true); setLoadError('');
    try {
      const result = await recordingsApi.detail(recordingId, owner, request.signal);
      if (request.signal.aborted || !active.current) return null;
      setItem(result.item); setPhase('ready'); setError(''); setConflict(false); setUncertain(false); setConfirming(false);
      if (!result.item.readyPlayable) stopVideo();
      return result.item;
    } catch (failure) {
      if (!request.signal.aborted && active.current && !access.current(failure)) {
        setLoadError(errorText(failure, '녹화 상세 정보를 불러오지 못했어요.'));
        if (failure instanceof AccountError && failure.status === 404) { stopVideo(); setItem(null); setPhase('error'); }
        else setPhase(previous => previous === 'ready' ? previous : 'error');
      }
      return null;
    } finally { if (abort.current === request) { fetching.current = false; if (active.current && !request.signal.aborted) setLoading(false); } }
  }
  useEffect(() => {
    active.current = true; const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    if (onlineNow.current) void load(); else { setPhase('error'); setLoadError('인터넷 연결을 확인해 주세요.'); }
    return () => {
      active.current = false; abort.current?.abort(); fetching.current = false; releaseVideo(); element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true }); else document.getElementById('recordings-title')?.focus({ preventScroll: true });
    };
  }, [recordingId, owner]);
  useEffect(() => { if (!online) { abort.current?.abort(); fetching.current = false; setLoading(false); setPhase(previous => previous === 'loading' ? 'error' : previous); } }, [online]);
  useEffect(() => { if (confirming) cancelAction.current?.focus(); else if (wasConfirming.current) actionTrigger.current?.focus(); wasConfirming.current = confirming; }, [confirming]);
  function dismiss() { if (!writing.current && !fetching.current && !vodBusy.current) onClose(item); }
  async function play() {
    if (!item?.readyPlayable || !onlineNow.current || fetching.current || writing.current || vodBusy.current || conflict || uncertain) return;
    stopVideo(); setMediaError('');
    const latest = await load();
    if (!latest || !active.current) return;
    if (!latest.readyPlayable) { setMediaError(explanation(latest)); return; }
    setMediaSrc(recordingsApi.mediaUrl(latest.id, owner)); setMediaLoading(true);
  }
  async function download() {
    if (!item?.readyPlayable || !onlineNow.current || fetching.current || writing.current || vodBusy.current || conflict || uncertain) return;
    setMediaError(''); const latest = await load();
    if (!latest || !active.current) return;
    if (!latest.readyPlayable) { setMediaError(explanation(latest)); return; }
    const anchor = document.createElement('a'); anchor.href = recordingsApi.mediaUrl(latest.id, owner, true); anchor.download = latest.displayName; document.body.append(anchor); anchor.click(); anchor.remove();
  }
  async function mediaFailed() {
    if (!active.current || checkingMedia.current) return;
    checkingMedia.current = true; stopVideo();
    try {
      const latest = await load(); if (!active.current) return;
      setMediaError(latest && !latest.readyPlayable ? explanation(latest) : '영상을 재생하지 못했어요. 파일 상태와 연결을 확인한 뒤 다시 시도해 주세요. 브라우저에서 재생할 수 없다면 다운로드로 확인할 수 있어요.');
    } finally { checkingMedia.current = false; }
  }
  async function save() {
    if (!item || fetching.current || writing.current || vodBusy.current || !onlineNow.current || conflict || uncertain || !confirming) return;
    writing.current = true; setPending(true); setError(''); setLoadError(''); stopVideo();
    try {
      const result = await recordingsApi.setHidden(item.id, item.version, !item.hidden, session.csrfToken, owner);
      if (active.current) onSaved(result.item);
    } catch (failure) {
      if (!active.current || access.current(failure)) return;
      setError(errorText(failure, '녹화 목록을 변경하지 못했어요.'));
      if (failure instanceof AccountError && failure.status === 409) setConflict(true);
      else if (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500) setUncertain(true);
    } finally { writing.current = false; if (active.current) setPending(false); }
  }
  return <dialog ref={dialog} data-recording-id={recordingId} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={`${id}-title`} aria-busy={pending || loading || publicationBusy} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}><h2 ref={heading} id={`${id}-title`} tabIndex={-1}>녹화 상세</h2><div className={styles.dialogTools}><button type="button" className="icon-button" aria-label="녹화 상세 새로고침" disabled={!online || pending || loading || publicationBusy || confirming} onClick={() => void load()}><RefreshCw size={18} aria-hidden="true" /></button><button type="button" className="icon-button" aria-label="녹화 상세 닫기" disabled={pending || loading || publicationBusy} onClick={dismiss}><X size={20} aria-hidden="true" /></button></div></header>
    {!online && <p className={styles.connectionNotice} role="status">인터넷 연결이 끊겼어요. 연결 후 파일 상태를 다시 확인해 주세요.</p>}
    {phase === 'loading' ? <p className={styles.loading} role="status">녹화 정보를 불러오는 중이에요.</p> : phase === 'error' ? <><p className={styles.error} role="alert">{loadError || '녹화 정보를 확인할 수 없어요.'}</p><button type="button" className={ui.button} disabled={!online || loading} onClick={() => void load()}>녹화 상세 다시 시도</button></> : item && <>
      <h3 className={styles.recordingTitle}>{item.title || '제목 없는 방송'}</h3><p className={styles.fileName}>{item.displayName}</p>
      <dl className={base.details}><div><dt>상태</dt><dd><RecordingBadge item={item} />{item.hidden && <span className={styles.originalStatus}>원본 {statusLabel[item.status]}</span>}</dd></div><div><dt>녹화 시각</dt><dd><time dateTime={new Date(item.recordedAtMs).toISOString()}>{formatDate.format(item.recordedAtMs)}</time></dd></div><div><dt>영상 길이</dt><dd>{duration(item.durationMs)}</dd></div><div><dt>파일 크기</dt><dd>{size(item.sizeBytes)}{item.status === 'missing' && item.sizeBytes !== null && <small className={styles.hint}>마지막으로 확인한 크기예요.</small>}</dd></div></dl>
      <p className={styles.reason}>{explanation(item)}</p>
      {loadError && <div className={styles.errorArea}><p className={styles.error} role="alert">{loadError} 마지막으로 확인한 정보를 표시해요.</p><button type="button" className={ui.button} disabled={!online || loading || pending || publicationBusy} onClick={() => void load()}>녹화 상세 다시 시도</button></div>}
      {item.readyPlayable && <div className={styles.mediaActions}><button type="button" className={`${ui.button} ${ui.primary}`} disabled={!online || loading || pending || publicationBusy || conflict || uncertain} onClick={() => void play()}><Video size={16} aria-hidden="true" />{mediaSrc ? '영상 다시 불러오기' : '영상 보기'}</button><button type="button" className={ui.button} disabled={!online || loading || pending || publicationBusy || conflict || uncertain} onClick={() => void download()}><Download size={16} aria-hidden="true" />다운로드</button></div>}
      {mediaSrc && <div className={styles.player}><video ref={video} aria-label="녹화 영상" src={mediaSrc} controls playsInline preload="metadata" onLoadStart={() => setMediaLoading(true)} onLoadedMetadata={() => setMediaLoading(false)} onCanPlay={() => setMediaLoading(false)} onError={() => void mediaFailed()} />{mediaLoading && <p role="status">영상 정보를 불러오는 중이에요.</p>}</div>}
      {mediaError && <p className={styles.error} role="alert">{mediaError}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <VodPublicationPanel recording={item} session={session} online={online} disabled={pending || loading || confirming || conflict || uncertain} onAccessError={onAccessError} onBusyChange={value => { vodBusy.current = value; setPublicationBusy(value); if (value) stopVideo(); }} />
      {(conflict || uncertain) ? <div className={styles.confirmation}><p>{conflict ? '다른 화면에서 변경된 상태일 수 있어요. 최신 정보를 확인한 뒤 다시 선택해 주세요.' : '요청이 처리됐는지 확인하지 못했어요. 자동으로 다시 요청하지 않고 최신 상태부터 확인해요.'}</p><button className={ui.button} type="button" disabled={!online || loading || pending || publicationBusy} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />최신 상태 불러오기</button></div> : confirming ? <div className={styles.confirmation} role="group" aria-label={item.hidden ? '녹화 복원 확인' : '녹화 숨김 확인'}><p>{item.hidden ? '이 항목을 녹화 목록에 다시 표시할까요?' : '이 항목을 녹화 목록에서 숨길까요? 파일은 서버에 남고 숨김 목록에서 복원할 수 있어요. 공개한 다시보기는 아래 공개 설정에서 따로 관리해 주세요.'}</p><div className={ui.dialogActions}><button ref={cancelAction} type="button" className={ui.button} disabled={pending || publicationBusy} onClick={() => setConfirming(false)}>취소</button><button type="button" className={`${ui.button} ${item.hidden ? ui.primary : ui.danger}`} disabled={!online || pending || loading || publicationBusy} onClick={() => void save()}>{pending ? '변경 중…' : item.hidden ? '복원하기' : '숨기기'}</button></div></div> : <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending || loading || publicationBusy} onClick={dismiss}>닫기</button><button ref={actionTrigger} type="button" className={ui.button} disabled={!online || pending || loading || publicationBusy} onClick={() => { stopVideo(); setConfirming(true); setError(''); }}>{item.hidden ? '목록에 복원' : '목록에서 숨기기'}</button></div>}
    </>}
  </dialog>;
}

type State = { key: string; phase: 'loading' | 'ready' | 'error'; result: RecordingPage | null; error: string };
const initial = (key: string): State => ({ key, phase: 'loading', result: null, error: '' });
export function ConnectedRecordingsPage({ session, onRequireLogin, onSessionChanged }: { session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void }) {
  const [params, setParams] = useSearchParams(), owner = session.user!.id, status = filters.find(filter => filter.value === params.get('status'))?.value ?? 'all', q = (params.get('q') ?? '').trim(), key = JSON.stringify([owner, status, q]);
  const [state, setState] = useState<State>(() => initial(key)), [attempt, setAttempt] = useState(0), [refreshing, setRefreshing] = useState(false), [more, setMore] = useState(false), [moreError, setMoreError] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [scopeLost, setScopeLost] = useState(false), [notice, setNotice] = useState(''), [online, setOnline] = useState(navigator.onLine);
  const active = useRef(true), generation = useRef(0), fetching = useRef(false), morePending = useRef(false), listAbort = useRef<AbortController | null>(null), moreAbort = useRef<AbortController | null>(null), feedback = useRef<HTMLParagraphElement>(null), missingOpenerFocus = useRef(false);
  const callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  const data = state.key === key ? state : initial(key), result = data.result;
  useEffect(() => {
    active.current = true; const changed = () => setOnline(navigator.onLine); window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { active.current = false; listAbort.current?.abort(); moreAbort.current?.abort(); window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  useEffect(() => { if (notice) feedback.current?.focus({ preventScroll: true }); }, [notice]);
  useEffect(() => { setSelected(null); }, [key]);
  useEffect(() => { if (selected === null && missingOpenerFocus.current) { missingOpenerFocus.current = false; if (document.activeElement === document.body) document.getElementById('recordings-title')?.focus({ preventScroll: true }); } }, [selected, state]);
  function accessError(failure: unknown) {
    if (!(failure instanceof AccountError) || !active.current) return false;
    if (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') {
      ++generation.current; listAbort.current?.abort(); moreAbort.current?.abort(); setScopeLost(true); setSelected(null); setState(initial(key)); setMoreError(''); setNotice('');
      if (failure.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged();
      return true;
    }
    return false;
  }
  useEffect(() => {
    const request = new AbortController(), revision = ++generation.current;
    listAbort.current = request; moreAbort.current?.abort(); fetching.current = false; morePending.current = false; setMore(false); setMoreError('');
    if (scopeLost || !online) { setRefreshing(false); setState(previous => previous.key === key && previous.phase === 'ready' ? previous : { ...initial(key), phase: 'error' }); return () => request.abort(); }
    fetching.current = true; setRefreshing(true); setState(previous => previous.key === key && previous.phase === 'ready' ? { ...previous, error: '' } : initial(key));
    void recordingsApi.list({ status, q, limit: 20 }, owner, request.signal).then(value => {
      if (!request.signal.aborted && generation.current === revision) setState({ key, phase: 'ready', result: value, error: '' });
    }).catch(failure => {
      if (request.signal.aborted || generation.current !== revision || accessError(failure)) return;
      setState(previous => ({ ...(previous.key === key && previous.phase === 'ready' ? previous : initial(key)), phase: previous.key === key && previous.phase === 'ready' ? 'ready' : 'error', error: errorText(failure, '녹화 목록을 불러오지 못했어요.') }));
    }).finally(() => { if (!request.signal.aborted && generation.current === revision) { fetching.current = false; setRefreshing(false); } });
    return () => request.abort();
  }, [key, owner, status, q, attempt, online, scopeLost]);
  function refresh() { if (online && !fetching.current && !morePending.current && !scopeLost) { fetching.current = true; setRefreshing(true); setAttempt(value => value + 1); } }
  async function loadMore() {
    if (!online || !result?.nextCursor || fetching.current || morePending.current || scopeLost) return;
    const request = new AbortController(), revision = generation.current, cursor = result.nextCursor; moreAbort.current = request; morePending.current = true; setMore(true); setMoreError('');
    try {
      const next = await recordingsApi.list({ status, q, limit: 20, cursor }, owner, request.signal);
      if (request.signal.aborted || !active.current || generation.current !== revision) return;
      if (next.nextCursor === cursor) throw Error('다음 녹화 목록을 확인하지 못했어요. 새로고침해 주세요.');
      setState(previous => {
        if (previous.key !== key || !previous.result) return previous;
        const ids = new Set(previous.result.items.map(item => item.id));
        return { ...previous, result: { ...previous.result, items: [...previous.result.items, ...next.items.filter(item => !ids.has(item.id))], nextCursor: next.nextCursor } };
      });
    } catch (failure) { if (!request.signal.aborted && active.current && generation.current === revision && !accessError(failure)) setMoreError(errorText(failure, '다음 녹화 목록을 불러오지 못했어요.')); }
    finally { if (active.current && generation.current === revision) { morePending.current = false; setMore(false); } }
  }
  function changeFilters(values: Record<string, string>) {
    const next = new URLSearchParams(params); for (const [name, value] of Object.entries(values)) if (value && value !== 'all') next.set(name, value); else next.delete(name);
    setNotice(''); setParams(next, { replace: true });
  }
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!online) return; changeFilters({ q: String(new FormData(event.currentTarget).get('recording-query') ?? '').trim() }); }
  function reloadAfterDialog() { ++generation.current; listAbort.current?.abort(); moreAbort.current?.abort(); fetching.current = false; morePending.current = false; setRefreshing(false); setMore(false); if (online && !scopeLost) setAttempt(value => value + 1); }
  function applyDetail(item: ProductRecording) {
    setState(previous => {
      if (previous.key !== key || !previous.result) return previous;
      const visible = status === 'hidden' ? item.hidden : !item.hidden && (status === 'all' || item.status === status);
      return { ...previous, result: { ...previous.result, items: previous.result.items.flatMap(row => row.id === item.id ? visible ? [item] : [] : [row]) } };
    });
  }
  function closeDialog(item: ProductRecording | null) { missingOpenerFocus.current = true; if (item) applyDetail(item); setSelected(null); }
  function saved(item: ProductRecording) {
    setSelected(null); setNotice(`‘${item.displayName}’ 항목을 ${item.hidden ? '목록에서 숨겼어요.' : '목록에 복원했어요.'}`); applyDetail(item);
    reloadAfterDialog();
  }
  if (scopeLost) return <ManagementPage title="녹화 관리" titleId="recordings-title"><EmptyState icon={<FolderOpen size={24} />} title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="녹화 관리" titleId="recordings-title" actions={<button type="button" className={ui.button} aria-label="녹화 목록 새로고침" disabled={!online || refreshing || more || selected !== null} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />새로고침</button>}>
    <form key={q} className={styles.toolbar} role="search" aria-label="녹화 검색" onSubmit={search} onReset={() => changeFilters({ q: '', status: 'all' })}>
      <label className={`${ui.search} ${styles.search}`}><Search size={17} aria-hidden="true" /><input type="search" name="recording-query" aria-label="녹화 파일 검색" placeholder="방송 제목이나 파일 이름 검색" defaultValue={q} maxLength={120} /></label>
      <label className={styles.statusFilter}><span className={styles.srOnly}>녹화 상태</span><select className={ui.control} aria-label="녹화 상태" value={status} disabled={!online} onChange={event => changeFilters({ status: event.target.value })}>{filters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></label>
      <div className={styles.searchActions}><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={!online}>검색</button><button type="reset" className={ui.button} disabled={!online}>초기화</button></div>
    </form>
    {notice && <p ref={feedback} className={base.notice} role="status" tabIndex={-1}>{notice}</p>}
    {!online && <p className={styles.connectionNotice} role="status">인터넷 연결이 끊겼어요. 입력한 검색어와 마지막 목록은 유지돼요.</p>}
    {data.error && <div className={styles.errorArea}><p className={styles.error} role="alert">{data.error}{result ? ' 마지막으로 불러온 목록을 표시하고 있어요.' : ''}</p><button type="button" className={ui.button} disabled={!online || refreshing} onClick={refresh}>녹화 목록 다시 시도</button></div>}
    {data.phase === 'loading' ? <p className={styles.loading} role="status">녹화 목록을 불러오는 중이에요.</p> : result && <>
      {!result.collectionEnabled && <p className={styles.connectionNotice} role="status">서버 녹화 수집이 꺼져 있어요. 기존에 등록한 파일은 계속 확인할 수 있어요.</p>}
      {refreshing && <p className={styles.srOnly} role="status">녹화 목록을 새로 불러오고 있어요.</p>}
      {result.items.length ? <div className={ui.tableFrame}><table className={`${ui.table} ${styles.table}`} aria-label="녹화 파일 목록"><thead><tr><th scope="col">파일</th><th scope="col" data-align="end">길이</th><th scope="col" data-align="end">크기</th><th scope="col">상태</th><th scope="col">관리</th></tr></thead><tbody>{result.items.map(item => <tr key={item.id} data-recording-id={item.id}>
        <th scope="row" data-label="파일" data-primary="true" className={styles.file}><strong>{item.title || '제목 없는 방송'}</strong><span>{item.displayName}</span><time dateTime={new Date(item.recordedAtMs).toISOString()}>{formatDate.format(item.recordedAtMs)}</time></th>
        <td data-label="길이" data-align="end">{duration(item.durationMs)}</td><td data-label="크기" data-align="end">{size(item.sizeBytes)}</td><td data-label="상태"><RecordingBadge item={item} /></td><td><button type="button" className={ui.button} aria-label={`${item.displayName} 파일 정보`} aria-haspopup="dialog" disabled={!online} onClick={() => setSelected(item.id)}>파일 정보</button></td>
      </tr>)}</tbody></table><p className={base.count}>{numbers.format(result.items.length)}개 표시{result.nextCursor ? ' · 다음 항목이 있어요' : ''}</p></div> : <EmptyState icon={<FolderOpen size={24} />} title={q ? '조건에 맞는 녹화가 없어요' : status === 'hidden' ? '숨긴 녹화가 없어요' : status !== 'all' ? '이 상태의 녹화가 없어요' : '저장된 녹화 파일이 없어요'} description={q || status !== 'all' ? '검색어나 상태 필터를 확인해 주세요.' : 'FRAME 서버에서 확인한 방송 녹화가 여기에 표시돼요.'} />}
      {result.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={ui.button} disabled={!online || refreshing || more} onClick={() => void loadMore()}>{more ? '불러오는 중…' : moreError ? '더 불러오기 다시 시도' : '더 불러오기'}</button></div>}
      <section className={styles.storage} aria-labelledby="recordings-storage-title"><h2 id="recordings-storage-title">서버 녹화 보관</h2><dl><div><dt>등록된 녹화</dt><dd>{numbers.format(result.storage.knownFileCount)}개</dd></div><div><dt>서버에서 확인한 파일 용량</dt><dd>{size(result.storage.availableSizeBytes)}<small>{numbers.format(result.storage.availableFileCount)}개 파일 · 숨긴 항목 포함</small></dd></div></dl><p>서버 녹화는 {result.retentionHours}시간 동안 보관해요. 원본 파일의 보관 기한이 지나면 ‘파일 없음’으로 표시돼요.</p><p>OBS가 내 PC에 저장한 녹화 파일은 포함하지 않아요.</p></section>
    </>}
    {selected && <RecordingDialog key={`${owner}/${selected}`} recordingId={selected} session={session} online={online} onClose={closeDialog} onSaved={saved} onAccessError={accessError} />}
  </ManagementPage>;
}
