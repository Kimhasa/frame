import { ExternalLink, Globe, LockKeyhole, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { mediaWatchPath } from '../../preview/community-types';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { clipsApi } from './clips-client';
import type { OwnerClip } from './clips-client';
import styles from './ClipTools.module.css';

export function clipStatus(item: OwnerClip) { return item.status === 'preparing' ? '준비 중' : item.status === 'failed' ? '준비 실패' : !item.available ? '보관본 확인 필요' : item.visibility === 'private' ? '비공개' : !item.sourcePublished ? '원본 비공개' : item.published ? '공개' : '공개 확인 필요'; }
export function ClipBadge({ item }: { item: OwnerClip }) { return <StatusBadge tone={item.published ? 'positive' : item.status === 'failed' || item.status === 'ready' && !item.available ? 'warning' : 'neutral'}>{clipStatus(item)}</StatusBadge>; }
export const seconds = (ms: number) => (ms / 1000).toFixed(3).replace(/\.?0+$/, '');

export function ClipEditor({ initial, session, online, disabled = false, sourcePublished = true, refreshToken = '', onAccessError, onBusyChange, onUpdated, onClose }: {
  initial: OwnerClip; session: AccountSession; online: boolean; disabled?: boolean; onAccessError: (error: unknown) => boolean;
  sourcePublished?: boolean; refreshToken?: string; onBusyChange: (busy: boolean) => void; onUpdated?: (item: OwnerClip) => void; onClose?: () => void;
}) {
  const owner = session.user!.id, scope = owner + '/' + initial.id;
  const [item, setItem] = useState(initial), [title, setTitle] = useState(initial.title), [description, setDescription] = useState(initial.description);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [storage, setStorage] = useState(true);
  const [blocked, setBlocked] = useState<'conflict' | 'uncertain' | null>(null), [confirmation, setConfirmation] = useState<'public' | 'private' | 'reload' | null>(null), [retryAt, setRetryAt] = useState(0);
  const active = useRef(true), scopeRef = useRef(scope), busy = useRef(false), reading = useRef(false), request = useRef<AbortController | null>(null), itemRef = useRef(item), blockedRef = useRef(blocked), cancel = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef<HTMLElement | null>(null), wasConfirming = useRef(false);
  const callbacks = useRef({ onAccessError, onBusyChange, onUpdated }), onlineRef = useRef(online), sourceToken = useRef(refreshToken), sourceRefresh = useRef(false); onlineRef.current = online; callbacks.current = { onAccessError, onBusyChange, onUpdated }; scopeRef.current = scope; itemRef.current = item; blockedRef.current = blocked;
  async function load(replaceDraft = false, passive = false) {
    if (!onlineRef.current || busy.current || reading.current || passive && blockedRef.current) return;
    const expected = scope, controller = new AbortController(); sourceRefresh.current = false; request.current = controller; reading.current = true; if (!passive) { setLoading(true); setError(''); }
    try {
      const result = await clipsApi.owned(initial.id, owner, controller.signal);
      if (!active.current || controller.signal.aborted || scopeRef.current !== expected || !result.item) return;
      if (passive && result.item.version !== itemRef.current.version) { setBlocked('conflict'); setError('다른 화면에서 클립 설정이 바뀌었어요. 최신 내용을 확인해 주세요.'); return; }
      setItem(result.item); setStorage(result.storageEnabled); callbacks.current.onUpdated?.(result.item);
      if (replaceDraft) { setTitle(result.item.title); setDescription(result.item.description); setBlocked(null); setConfirmation(null); setError(''); }
      if (itemRef.current.status === 'preparing' && result.item.status === 'ready') setNotice(result.item.published ? '클립을 공개했어요.' : '클립 파일을 준비했어요. 공개 범위를 확인해 주세요.');
    } catch (failure) { if (active.current && !controller.signal.aborted && scopeRef.current === expected && !callbacks.current.onAccessError(failure)) setError(failure instanceof Error ? failure.message : '클립 상태를 불러오지 못했어요.'); }
    finally { if (request.current === controller) { reading.current = false; if (active.current) { setLoading(false); if (sourceRefresh.current) void load(false, true); } } }
  }
  useEffect(() => {
    active.current = true; heading.current?.focus(); if (online) void load(true); else { setLoading(false); setError('인터넷 연결을 확인해 주세요.'); }
    const timer = window.setInterval(() => { if (itemRef.current.status === 'preparing' && document.visibilityState === 'visible' && navigator.onLine) void load(false, true); }, 2000);
    return () => { active.current = false; request.current?.abort(); reading.current = false; callbacks.current.onBusyChange(false); window.clearInterval(timer); };
  }, [scope]);
  useEffect(() => { if (!online) { request.current?.abort(); reading.current = false; setLoading(false); } else if (sourceRefresh.current) void load(false, true); }, [online]);
  useEffect(() => { if (sourceToken.current !== refreshToken) { sourceToken.current = refreshToken; sourceRefresh.current = true; void load(false, true); } }, [refreshToken]);
  useEffect(() => { if (confirmation) cancel.current?.focus(); else if (wasConfirming.current) { if (opener.current?.isConnected && !opener.current.matches(':disabled')) opener.current.focus(); else heading.current?.focus(); } wasConfirming.current = Boolean(confirmation); }, [confirmation]);
  useEffect(() => { if (!retryAt) return; const timer = window.setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now())); return () => window.clearTimeout(timer); }, [retryAt]);
  function confirm(value: 'public' | 'private' | 'reload') { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirmation(value); }
  async function mutate(kind: 'save' | 'visibility' | 'retry', visibility?: 'public' | 'private') {
    if (!online || disabled || busy.current || reading.current || blocked || Date.now() < retryAt) return;
    if ((kind === 'retry' || kind === 'visibility' && visibility === 'public') && !sourcePublished) { setError('원본 다시보기를 공개한 뒤 다시 선택해 주세요.'); return; }
    const normalizedTitle = (kind === 'save' ? title : item.title).trim(), normalizedDescription = (kind === 'save' ? description : item.description).trim();
    if (!normalizedTitle || [...normalizedTitle].length > 100 || [...normalizedDescription].length > 2000) { setError('제목은 1~100자, 설명은 2,000자 이내로 입력해 주세요.'); return; }
    const expected = scope; busy.current = true; setPending(true); callbacks.current.onBusyChange(true); setError(''); setNotice('');
    try {
      const result = kind === 'retry' ? await clipsApi.retry(item.id, item.version, owner, session.csrfToken) : await clipsApi.update(item.id, { version: item.version, title: normalizedTitle, description: normalizedDescription, visibility: visibility ?? item.visibility }, owner, session.csrfToken);
      if (!active.current || scopeRef.current !== expected || !result.item) return;
      setItem(result.item); setStorage(result.storageEnabled); setConfirmation(null); callbacks.current.onUpdated?.(result.item);
      if (kind === 'save') { setTitle(result.item.title); setDescription(result.item.description); }
      setNotice(result.item.status === 'preparing' ? '클립 영상을 준비하고 있어요.' : kind === 'save' ? '클립 정보를 저장했어요.' : result.item.visibility === 'private' ? '클립을 비공개로 변경했어요.' : result.item.published && sourcePublished ? '클립을 공개했어요.' : '공개 범위를 저장했어요. 원본 공개 상태와 파일 준비 상태를 확인해 주세요.');
    } catch (failure) {
      if (!active.current || scopeRef.current !== expected || callbacks.current.onAccessError(failure)) return;
      setError(failure instanceof Error ? failure.message : '클립을 변경하지 못했어요.');
      if (failure instanceof AccountError && failure.status === 409) setBlocked('conflict');
      else if (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500) setBlocked('uncertain');
      if (failure instanceof AccountError && failure.status === 429 && failure.retryAfterMs) setRetryAt(Date.now() + failure.retryAfterMs);
    } finally { busy.current = false; if (active.current && scopeRef.current === expected) { setPending(false); callbacks.current.onBusyChange(false); if (sourceRefresh.current) void load(false, true); } }
  }
  const dirty = title !== item.title || description !== item.description, locked = disabled || pending || loading || Boolean(blocked), cooling = Date.now() < retryAt;
  const effective = sourcePublished ? item : { ...item, sourcePublished: false, published: false };
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void mutate('save'); }
  return <section className={styles.editor} aria-label="클립 편집" aria-busy={loading || pending} data-clip-id={item.id}>
    <header className={styles.heading}><h4 ref={heading} tabIndex={-1}>클립 관리</h4><div className={styles.actions}><button type="button" className="icon-button" aria-label="클립 상태 새로고침" disabled={!online || disabled || pending || loading || Boolean(blocked)} onClick={() => dirty ? confirm('reload') : void load(true)}><RefreshCw size={17} aria-hidden="true" /></button>{onClose && <button type="button" className="icon-button" aria-label="클립 관리 닫기" disabled={pending || disabled} onClick={onClose}><X size={18} aria-hidden="true" /></button>}</div></header>
    <p><ClipBadge item={effective} /></p><div className={styles.details}><span>원본 구간 {seconds(item.startMs)}–{seconds(item.endMs)}초</span><span>영상 길이 {seconds(item.durationMs)}초</span></div>
    <p className={styles.hint}>원본 다시보기가 공개되어야 이 클립도 시청할 수 있어요. 원본을 비공개로 바꾸면 클립의 공개 설정은 유지하고 시청을 중단해요.</p>
    {!effective.sourcePublished && <p className={styles.hint}>원본 다시보기가 공개되지 않아 클립 시청이 중단된 상태예요.</p>}{item.reason && <p className={styles.hint}>{item.reason}</p>}{!storage && <p className={styles.hint}>클립 보관 설정을 확인해 주세요. 비공개 전환은 계속할 수 있어요.</p>}
    <form className={styles.form} onSubmit={submit}>
      <label>제목<input className={ui.control} aria-label="클립 관리 제목" value={title} maxLength={100} required disabled={locked} onChange={event => setTitle(event.target.value)} /></label>
      <label>설명<textarea className={ui.control} aria-label="클립 관리 설명" value={description} maxLength={2000} disabled={locked} onChange={event => setDescription(event.target.value)} /></label>
      <div className={styles.actions}><button className={ui.button + ' ' + ui.primary} type="submit" disabled={!online || locked || !dirty || cooling}>{pending ? '요청 중…' : '클립 정보 저장'}</button><button className={ui.button} type="button" disabled={!online || locked || cooling || item.visibility === 'private' && (!storage || !effective.sourcePublished || item.status === 'ready' && !item.available)} onClick={() => confirm(item.visibility === 'public' ? 'private' : 'public')}>{item.visibility === 'public' ? <LockKeyhole size={16} aria-hidden="true" /> : <Globe size={16} aria-hidden="true" />}{item.visibility === 'public' ? '클립 비공개로 변경' : '클립 공개로 변경'}</button>{item.status === 'failed' && <button type="button" className={ui.button} disabled={!online || locked || !storage || !effective.sourcePublished || cooling} onClick={() => void mutate('retry')}>클립 준비 다시 시도</button>}</div>
    </form>
    {effective.published && <p><Link className={styles.link} to={mediaWatchPath('clip', item.channel.handle, item.id)} target="_blank" rel="noopener noreferrer">공개된 클립 보기<ExternalLink size={14} aria-hidden="true" /></Link></p>}
    {loading && <p className={styles.hint} role="status">클립 상태를 확인하고 있어요.</p>}{error && <p className={styles.hint + ' ' + styles.error} role="alert">{error}</p>}{notice && <p className={styles.hint} role="status">{notice}</p>}
    {blocked && <div className={styles.confirmation}><p>{blocked === 'conflict' ? '다른 화면에서 설정이 바뀌었을 수 있어요. 작성한 내용은 유지하고 있어요.' : '요청 결과를 확인하지 못했어요. 다시 요청하기 전에 최신 상태를 확인해 주세요.'}</p><button type="button" className={ui.button} disabled={!online || disabled || pending || loading} onClick={() => dirty ? confirm('reload') : void load(true)}>클립 최신 상태 확인</button></div>}
    {confirmation && <div className={styles.confirmation} role="group" aria-label="클립 변경 확인"><p>{confirmation === 'reload' ? '작성 중인 내용을 최신 클립 정보로 바꿀까요?' : confirmation === 'public' ? '이 클립을 공개할까요? 원본 다시보기도 공개 상태여야 시청할 수 있어요.' : '이 클립을 비공개로 바꿀까요? 새 시청 요청은 차단돼요.'}</p><div className={styles.actions}><button ref={cancel} className={ui.button} type="button" disabled={pending || disabled || loading} onClick={() => setConfirmation(null)}>취소</button><button className={ui.button + ' ' + ui.primary} type="button" disabled={!online || pending || disabled || loading || cooling} onClick={() => confirmation === 'reload' ? void load(true) : void mutate('visibility', confirmation)}>{confirmation === 'reload' ? '클립 최신 내용으로 바꾸기' : confirmation === 'public' ? '클립 공개하기' : '클립 비공개로 바꾸기'}</button></div></div>}
  </section>;
}
