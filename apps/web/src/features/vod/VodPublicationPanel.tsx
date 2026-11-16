import { ExternalLink, Globe, LockKeyhole, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { mediaWatchPath } from '../../preview/community-types';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import type { ProductRecording } from '../recordings/recordings-client';
import { vodApi } from './vod-client';
import type { OwnerVod } from './vod-client';
import styles from './VodPages.module.css';
import { ClipManagementPanel } from '../clips/ClipManagementPanel';

export function VodPublicationPanel({ recording, session, online, disabled = false, onAccessError, onBusyChange }: { recording: ProductRecording; session: AccountSession; online: boolean; disabled?: boolean; onAccessError: (failure: unknown) => boolean; onBusyChange: (busy: boolean) => void }) {
  const owner = session.user!.id, scope = owner + '/' + recording.id;
  const [clipBusy, setClipBusy] = useState(false), clipBusyRef = useRef(false);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading'), [item, setItem] = useState<OwnerVod | null>(null), [storage, setStorage] = useState(false);
  const [title, setTitle] = useState(Array.from(recording.title).slice(0, 100).join('')), [description, setDescription] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false), [pending, setPending] = useState(false), [blocked, setBlocked] = useState<'conflict' | 'uncertain' | null>(null), [confirmation, setConfirmation] = useState<'public' | 'private' | 'reload' | null>(null);
  const alive = useRef(true), scopeRef = useRef(scope), busy = useRef(false), reading = useRef(false), abort = useRef<AbortController | null>(null), itemRef = useRef(item), blockedRef = useRef(blocked), callbacks = useRef({ onAccessError, onBusyChange }), onlineRef = useRef(online), cancelConfirmation = useRef<HTMLButtonElement>(null), confirmationOpener = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement>(null), wasConfirming = useRef(false);
  onlineRef.current = online; scopeRef.current = scope; itemRef.current = item; blockedRef.current = blocked; callbacks.current = { onAccessError, onBusyChange };
  async function load(replaceDraft = false, passive = false) {
    if (!onlineRef.current || busy.current || clipBusyRef.current || reading.current || passive && blockedRef.current) return; const controller = new AbortController(), expected = scope; abort.current = controller; reading.current = true;
    if (!passive) { setLoading(true); setError(''); }
    try {
      const result = await vodApi.forRecording(recording.id, owner, controller.signal);
      if (!alive.current || controller.signal.aborted || scopeRef.current !== expected) return;
      if (itemRef.current?.status === 'preparing' && result.item?.status !== 'preparing') setNotice(result.item?.status === 'ready' ? result.item.published ? '다시보기를 공개했어요.' : '공개용 보관본을 준비했어요. 현재 비공개예요.' : '');
      setItem(result.item); setStorage(result.storageEnabled); setPhase('ready'); if (passive) setError('');
      if (replaceDraft) { if (result.item) { setTitle(result.item.title); setDescription(result.item.description); } setBlocked(null); setConfirmation(null); setError(''); }
    } catch (failure) { if (alive.current && !controller.signal.aborted && scopeRef.current === expected && !callbacks.current.onAccessError(failure)) { setError(failure instanceof Error ? failure.message : '다시보기 공개 설정을 불러오지 못했어요.'); if (!passive) setPhase(previous => previous === 'ready' ? previous : 'error'); } }
    finally { if (abort.current === controller) { reading.current = false; if (alive.current) setLoading(false); } }
  }
  useEffect(() => {
    alive.current = true; if (onlineRef.current) void load(true); else { setPhase('error'); setError('인터넷 연결을 확인해 주세요.'); }
    const interval = window.setInterval(() => { if (itemRef.current?.status === 'preparing' && document.visibilityState === 'visible' && navigator.onLine) void load(false, true); }, 2000);
    return () => { alive.current = false; abort.current?.abort(); reading.current = false; callbacks.current.onBusyChange(false); window.clearInterval(interval); };
  }, [scope]);
  useEffect(() => { if (!online) { abort.current?.abort(); reading.current = false; setLoading(false); } }, [online]);
  useEffect(() => { if (confirmation) cancelConfirmation.current?.focus(); else if (wasConfirming.current) { if (confirmationOpener.current?.isConnected && !confirmationOpener.current.matches(':disabled')) confirmationOpener.current.focus(); else heading.current?.focus(); } wasConfirming.current = Boolean(confirmation); }, [confirmation]);
  function confirm(value: 'public' | 'private' | 'reload') { confirmationOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirmation(value); }
  async function mutate(kind: 'create' | 'save' | 'visibility' | 'retry', visibility?: 'public' | 'private') {
    if (!online || disabled || clipBusyRef.current || busy.current || reading.current || blocked || ((!item || kind === 'retry' || kind === 'visibility' && visibility === 'public') && !storage)) return;
    const normalizedTitle = (kind === 'visibility' || kind === 'retry' ? item?.title ?? title : title).trim(), normalizedDescription = (kind === 'visibility' || kind === 'retry' ? item?.description ?? description : description).trim();
    if (!normalizedTitle || [...normalizedTitle].length > 100 || [...normalizedDescription].length > 2000) { setError('제목은 1~100자, 설명은 2,000자 이내로 입력해 주세요.'); return; }
    const expected = scope; busy.current = true; setPending(true); callbacks.current.onBusyChange(true); setError(''); setNotice('');
    try {
      const result = kind === 'create' ? await vodApi.publish({ recordingId: recording.id, title: normalizedTitle, description: normalizedDescription }, owner, session.csrfToken)
        : kind === 'retry' && item ? await vodApi.retry(item.id, item.version, owner, session.csrfToken)
        : item ? await vodApi.update(item.id, { version: item.version, title: kind === 'visibility' ? item.title : normalizedTitle, description: kind === 'visibility' ? item.description : normalizedDescription, visibility: visibility ?? item.visibility }, owner, session.csrfToken) : null;
      if (!result || !alive.current || scopeRef.current !== expected) return;
      setItem(result.item); setStorage(result.storageEnabled); setConfirmation(null); setPhase('ready');
      if (kind !== 'visibility' && kind !== 'retry') { setTitle(result.item?.title ?? normalizedTitle); setDescription(result.item?.description ?? normalizedDescription); }
      setNotice(result.item?.status === 'preparing' ? '공개용 영상을 준비하고 있어요. 준비가 끝나면 설정한 공개 범위를 적용해요.' : kind === 'visibility' ? result.item?.visibility === 'private' ? '다시보기를 비공개로 변경했어요.' : result.item?.published ? '다시보기를 공개했어요.' : result.item?.status === 'failed' ? '공개 범위를 저장했어요. 공개하려면 영상 준비를 다시 시도해 주세요.' : '공개 범위를 저장했어요. 보관 파일 상태를 확인해 주세요.' : '다시보기 정보를 저장했어요.');
    } catch (failure) {
      if (!alive.current || scopeRef.current !== expected || callbacks.current.onAccessError(failure)) return;
      setError(failure instanceof Error ? failure.message : '다시보기 공개 설정을 변경하지 못했어요.');
      if (failure instanceof AccountError && failure.status === 409) setBlocked('conflict');
      else if (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500) setBlocked('uncertain');
    } finally { busy.current = false; if (alive.current && scopeRef.current === expected) { setPending(false); callbacks.current.onBusyChange(false); } }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (disabled || clipBusyRef.current || busy.current || reading.current || blocked || !online) return; if (!item) confirm('public'); else void mutate('save'); }
  const canCreate = recording.readyPlayable && !recording.hidden, dirty = title !== (item?.title ?? Array.from(recording.title).slice(0, 100).join('')) || description !== (item?.description ?? '');
  const status = !item ? '' : item.status === 'preparing' ? '준비 중' : item.status === 'failed' ? '준비 실패' : !item.available ? '보관본 확인 필요' : item.published ? '공개' : '비공개';
  return <section className={styles.publication} aria-label="다시보기 공개 관리" aria-busy={pending || loading || clipBusy}>
    <header className={styles.publicationHeading}><h3 ref={heading} tabIndex={-1}>다시보기 공개</h3><button className="icon-button" type="button" aria-label="다시보기 공개 상태 새로고침" disabled={clipBusy || !online || disabled || pending || loading || Boolean(blocked)} onClick={() => dirty && item ? confirm('reload') : void load(true)}><RefreshCw size={17} aria-hidden="true" /></button></header>
    {phase === 'loading' ? <p role="status">공개 설정을 불러오는 중이에요.</p> : phase === 'error' ? <><p className={styles.error} role="alert">{error}</p><button type="button" className={ui.button} disabled={clipBusy || !online || disabled || loading} onClick={() => void load(true)}>다시보기 공개 설정 다시 시도</button></> : <>
      {item && <p className={styles.publicationStatus}><StatusBadge tone={item.published ? 'positive' : item.status === 'failed' || !item.available && item.status === 'ready' ? 'warning' : 'neutral'}>{status}</StatusBadge></p>}
      {!storage && <p>서버의 다시보기 보관 설정을 확인해 주세요.</p>}
      {item?.status === 'preparing' && <p role="status">공개용 파일을 준비하고 있어요. 현재 공개 예정은 {item.visibility === 'public' ? '공개' : '비공개'}예요.</p>}
      {item?.reason && <p>{item.reason}</p>}
      {!item && !canCreate && <p>방송 구간과 소유권이 확인된 완료 녹화에서 공개할 수 있어요. 숨긴 녹화는 먼저 목록에 복원해 주세요.</p>}
      <form className={styles.publicationForm} onSubmit={submit}>
        <label>제목<input className={ui.control} aria-label="다시보기 제목" value={title} maxLength={100} required disabled={clipBusy || disabled || pending || loading || Boolean(blocked)} onChange={event => setTitle(event.target.value)} /></label>
        <label>설명<textarea className={ui.control} aria-label="다시보기 설명" value={description} maxLength={2000} disabled={clipBusy || disabled || pending || loading || Boolean(blocked)} onChange={event => setDescription(event.target.value)} /></label>
        <div className={styles.formActions}><button type="submit" className={ui.button + ' ' + ui.primary} disabled={clipBusy || !online || disabled || !storage || pending || loading || Boolean(blocked) || (!item && !canCreate) || (Boolean(item) && !dirty)}>{pending ? '요청 중…' : item ? '다시보기 정보 저장' : '다시보기 공개'}</button>
          {item && <button type="button" className={ui.button} disabled={clipBusy || !online || disabled || pending || loading || Boolean(blocked) || (item.visibility === 'private' && (!storage || item.status === 'ready' && !item.available))} onClick={() => confirm(item.visibility === 'public' ? 'private' : 'public')}>{item.visibility === 'public' ? <LockKeyhole size={16} aria-hidden="true" /> : <Globe size={16} aria-hidden="true" />}{item.visibility === 'public' ? '비공개로 변경' : '공개로 변경'}</button>}
          {item?.status === 'failed' && <button className={ui.button} type="button" disabled={clipBusy || !online || disabled || pending || loading || Boolean(blocked) || !canCreate || !storage} onClick={() => void mutate('retry')}>준비 다시 시도</button>}
        </div>
      </form>
      {!item && <p>원본 녹화와 별도로 공개용 파일을 보관해요. 공개하면 로그인하지 않은 시청자도 볼 수 있어요.</p>}
      {item?.published && <p><Link className={styles.publicLink} to={mediaWatchPath('vod', item.channel.handle, item.id)} target="_blank" rel="noopener noreferrer">공개된 다시보기 보기<ExternalLink size={14} aria-hidden="true" /></Link></p>}
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {blocked && <div className={styles.confirmation}><p>{blocked === 'conflict' ? '다른 화면에서 공개 설정이 바뀌었을 수 있어요. 최신 내용을 확인한 뒤 다시 선택해 주세요.' : '요청 결과를 확인하지 못했어요. 자동으로 다시 요청하지 않고 현재 상태부터 확인해요.'}</p><button className={ui.button} type="button" disabled={clipBusy || !online || disabled || loading || pending} onClick={() => dirty && item ? confirm('reload') : void load(true)}>다시보기 최신 상태 확인</button></div>}
      {confirmation && <div className={styles.confirmation} role="group" aria-label={confirmation === 'reload' ? '공개 설정 새로고침 확인' : confirmation === 'public' ? '다시보기 공개 확인' : '다시보기 비공개 확인'}><p>{confirmation === 'reload' ? '최신 공개 설정으로 입력 내용을 바꿀까요? 작성 중인 제목과 설명은 사라져요.' : confirmation === 'public' ? item ? '이 다시보기를 모든 시청자에게 공개할까요?' : '이 녹화를 다시보기로 공개할까요? 공개용 보관본이 준비되면 모든 시청자가 볼 수 있어요.' : '이 다시보기를 비공개로 바꿀까요? 이 원본에서 만든 클립도 시청이 중단돼요. 각 클립의 공개 설정은 유지돼요.'}</p><div className={styles.formActions}><button ref={cancelConfirmation} type="button" className={ui.button} disabled={clipBusy || disabled || pending || loading} onClick={() => setConfirmation(null)}>취소</button><button type="button" className={ui.button + ' ' + ui.primary} disabled={clipBusy || !online || disabled || pending || loading} onClick={() => confirmation === 'reload' ? void load(true) : void mutate(item ? 'visibility' : 'create', confirmation)}>{confirmation === 'reload' ? '최신 내용으로 바꾸기' : confirmation === 'public' ? '공개하기' : '비공개로 바꾸기'}</button></div></div>}
    </>}
    {item && <ClipManagementPanel key={owner + '/' + item.id} sourceVodId={item.id} sourcePublished={item.status === 'ready' && item.visibility === 'public'} refreshToken={item.status + '/' + item.visibility + '/' + item.version} session={session} online={online} disabled={disabled || pending || loading || Boolean(blocked) || Boolean(confirmation)} onAccessError={onAccessError} onBusyChange={value => { clipBusyRef.current = value; setClipBusy(value); callbacks.current.onBusyChange(value); }} />}
  </section>;
}
