import { ArrowLeft, Copy, Play, RefreshCw, Share2, Video, VideoOff, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useHref, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { channelPath, mediaWatchPath } from '../../preview/community-types';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { ClipCreator } from '../clips/ClipCreator';
import { vodApi } from './vod-client';
import type { PublicVod, VodChannel, VodPage } from './vod-client';
import base from '../media/MediaPages.module.css';
import styles from './VodPages.module.css';

const date = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'Asia/Seoul' });
const dateTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' });
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const withdrawnMessage = '공개가 중단되어 재생을 멈췄어요. 다시 공개된 영상은 영상 다시 시도로 불러올 수 있어요.';
export function vodDuration(ms: number) { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s % 60).padStart(2, '0'); }
function Avatar({ channel }: { channel: VodChannel }) { return <span className={base.avatar} aria-hidden="true">{Array.from(channel.displayName)[0] ?? '?'}{channel.avatarUrl && <img key={channel.avatarUrl} src={channel.avatarUrl} alt="" onError={e => { e.currentTarget.hidden = true; }} />}</span>; }
function VodCard({ item }: { item: PublicVod }) { return <article className={base.card} data-vod-id={item.id}>
  <div className={base.thumbnail} aria-hidden="true"><span className={styles.placeholder}><Play size={34} fill="currentColor" /><span>다시보기</span></span><span className={base.duration}>{vodDuration(item.durationMs)}</span></div>
  <div className={base.cardDetails}><Avatar channel={item.channel} /><div className={base.cardCopy}><Link className={base.cardTitle} to={mediaWatchPath('vod', item.channel.handle, item.id)}>{item.title}</Link><Link className={base.channelLink} to={channelPath(item.channel.handle)}>{item.channel.displayName}</Link><p className={base.cardMeta}><time dateTime={new Date(item.publishedAtMs).toISOString()}>{date.format(item.publishedAtMs)} 공개</time></p></div></div>
</article>; }

export function ConnectedVodList({ channelHandle, recent = false, excludeId }: { channelHandle?: string; recent?: boolean; excludeId?: string }) {
  const [params, setParams] = useSearchParams();
  const embedded = Boolean(channelHandle), q = embedded ? '' : (params.get('q') ?? '').trim(), handle = channelHandle ?? (params.get('channel') ?? '').trim(), limit = recent ? 4 : embedded ? 12 : 20;
  const key = JSON.stringify([handle, q, limit]);
  const [state, setState] = useState<{ key: string; data: VodPage | null; loading: boolean; error: string }>({ key, data: null, loading: true, error: '' });
  const [attempt, setAttempt] = useState(0), [online, setOnline] = useState(navigator.onLine), [more, setMore] = useState(false), [moreError, setMoreError] = useState(''), [fieldError, setFieldError] = useState('');
  const pending = useRef(false), generation = useRef(0), abort = useRef<AbortController | null>(null), moreAbort = useRef<AbortController | null>(null), channelInput = useRef<HTMLInputElement>(null);
  const current = state.key === key ? state : { key, data: null, loading: true, error: '' }, data = current.data;
  useEffect(() => { const wake = () => setOnline(navigator.onLine); window.addEventListener('online', wake); window.addEventListener('offline', wake); return () => { window.removeEventListener('online', wake); window.removeEventListener('offline', wake); }; }, []);
  useEffect(() => {
    const controller = new AbortController(), revision = ++generation.current; abort.current = controller; moreAbort.current?.abort(); pending.current = true; setMore(false); setMoreError('');
    if (!online) { pending.current = false; setState(old => old.key === key && old.data ? { ...old, loading: false } : { key, data: null, loading: false, error: '' }); return () => { controller.abort(); moreAbort.current?.abort(); ++generation.current; }; }
    setState(old => ({ key, data: old.key === key ? old.data : null, loading: true, error: '' }));
    void vodApi.list({ channel: handle, q, limit }, controller.signal).then(result => { if (!controller.signal.aborted && generation.current === revision) setState({ key, data: result, loading: false, error: '' }); }).catch(error => { if (!controller.signal.aborted && generation.current === revision) setState(old => ({ key, data: old.key === key ? old.data : null, loading: false, error: message(error, '다시보기를 불러오지 못했어요.') })); }).finally(() => { if (generation.current === revision) pending.current = false; });
    return () => { controller.abort(); moreAbort.current?.abort(); ++generation.current; };
  }, [key, handle, q, limit, attempt, online]);
  function refresh() { if (online && !pending.current) { pending.current = true; setAttempt(v => v + 1); } }
  async function loadMore() {
    if (!online || pending.current || !data?.nextCursor) return; pending.current = true; setMore(true); setMoreError(''); const controller = new AbortController(), revision = generation.current, cursor = data.nextCursor; moreAbort.current = controller;
    try { const result = await vodApi.list({ channel: handle, q, limit, cursor }, controller.signal); if (controller.signal.aborted || revision !== generation.current) return; if (result.nextCursor === cursor) throw Error('다음 목록을 확인하지 못했어요. 새로고침해 주세요.'); setState(old => { if (old.key !== key || !old.data) return old; const ids = new Set(old.data.items.map(item => item.id)); return { ...old, data: { ...old.data, items: [...old.data.items, ...result.items.filter(item => !ids.has(item.id))], nextCursor: result.nextCursor } }; }); }
    catch (error) { if (!controller.signal.aborted && revision === generation.current) setMoreError(message(error, '다음 다시보기를 불러오지 못했어요.')); }
    finally { if (revision === generation.current) { pending.current = false; setMore(false); } }
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!online) return; const form = new FormData(event.currentTarget), channel = String(form.get('vod-channel') ?? '').trim().replace(/^@/, '').toLowerCase();
    if (channel && !/^[a-z][a-z0-9_-]{2,23}$/.test(channel)) { setFieldError('채널의 @아이디를 확인해 주세요.'); channelInput.current?.focus(); return; }
    const next = new URLSearchParams(params), query = String(form.get('vod-q') ?? '').trim(); if (query) next.set('q', query); else next.delete('q'); if (channel) next.set('channel', channel); else next.delete('channel'); setFieldError(''); setParams(next, { replace: true });
  }
  const items = (data?.items ?? []).filter(item => item.id !== excludeId).slice(0, recent ? 3 : undefined);
  if (recent && data && !items.length && !current.error) return null;
  return <section className={ui.page + ' ' + (embedded ? styles.embedded + (recent ? ' ' + styles.recent : '') : base.page + ' ' + styles.surface)} aria-label={embedded ? '채널 다시보기' : '다시보기'}>
    <header className={recent ? styles.recentHeading : base.heading}>{embedded ? <h2>{recent ? '최근 다시보기' : '다시보기'}</h2> : <h1 id="vod-list-title">다시보기</h1>}{recent && channelHandle ? <Link className={base.button} to={channelPath(channelHandle) + '?tab=videos'}>모두 보기</Link> : <button className={ui.button} type="button" aria-label="다시보기 목록 새로고침" disabled={!online || current.loading || more} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />새로고침</button>}</header>
    {!embedded && <form key={key} className={styles.filters} role="search" aria-label="다시보기 검색" onSubmit={search} onReset={() => { const next = new URLSearchParams(params); next.delete('q'); next.delete('channel'); setFieldError(''); setParams(next, { replace: true }); }}><input className={ui.control + ' ' + styles.search} type="search" name="vod-q" aria-label="다시보기 제목 검색" placeholder="다시보기 제목 검색" maxLength={120} defaultValue={q} /><input ref={channelInput} className={ui.control + ' ' + styles.channelFilter} type="text" name="vod-channel" aria-label="다시보기 채널 검색" placeholder="채널 @아이디" maxLength={25} defaultValue={handle} aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? 'vod-channel-error' : undefined} /><button type="submit" className={ui.button + ' ' + ui.primary} disabled={!online}>검색</button><button className={ui.button} type="reset" disabled={!online}>초기화</button></form>}
    {fieldError && <p id="vod-channel-error" className={styles.feedback + ' ' + styles.error} role="alert">{fieldError}</p>}
    {!online && <p className={styles.feedback} role="status">인터넷 연결을 확인해 주세요. 마지막 목록과 입력한 조건은 유지돼요.</p>}
    {current.error && <div className={styles.feedback + ' ' + styles.error}><p role="alert">{current.error}{data ? ' 마지막으로 확인한 목록을 표시하고 있어요.' : ''}</p><button type="button" className={ui.button} disabled={!online || current.loading} onClick={refresh}>다시보기 목록 다시 시도</button></div>}
    {current.loading && !data ? <p className={styles.loading} role="status">다시보기를 불러오는 중이에요.</p> : data && (items.length ? <ul className={base.grid} aria-label="공개 다시보기 목록">{items.map(item => <li key={item.id}><VodCard item={item} /></li>)}</ul> : <EmptyState icon={<Video size={24} />} title={q || handle && !embedded ? '조건에 맞는 다시보기가 없어요' : '아직 공개된 다시보기가 없어요'} />)}
    {!recent && data?.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button className={ui.button} type="button" disabled={!online || current.loading || more} onClick={() => void loadMore()}>{more ? '불러오는 중…' : moreError ? '다시보기 더 불러오기 다시 시도' : '다시보기 더 불러오기'}</button></div>}
  </section>;
}

export function ConnectedVodWatch({ session, onRequireLogin, onSessionChanged }: { session?: AccountSession | null; onRequireLogin?: () => void; onSessionChanged?: () => void } = {}) {
  const { handle = '', id = '' } = useParams(), key = handle + '/' + id;
  const [state, setState] = useState<{ key: string; item: PublicVod | null; phase: 'loading' | 'ready' | 'missing' | 'error'; error: string }>({ key, item: null, phase: 'loading', error: '' });
  const [attempt, setAttempt] = useState(0), [mediaAttempt, setMediaAttempt] = useState(0), [mediaError, setMediaError] = useState(''), [mediaAllowed, setMediaAllowed] = useState(true), [mediaPending, setMediaPending] = useState(false), [online, setOnline] = useState(navigator.onLine), [sharing, setSharing] = useState(false), [copied, setCopied] = useState<'idle' | 'done' | 'error'>('idle');
  const video = useRef<HTMLVideoElement>(null), active = useRef(true), generation = useRef(0), scopeRef = useRef(key), refreshing = useRef(false), request = useRef<AbortController | null>(null), mediaRequest = useRef<AbortController | null>(null), refreshNow = useRef<() => void>(() => {}), share = useRef<HTMLDialogElement>(null), shareInput = useRef<HTMLInputElement>(null), shareButton = useRef<HTMLButtonElement>(null), dialogId = useId();
  scopeRef.current = key;
  const current = state.key === key ? state : { key, item: null, phase: 'loading' as const, error: '' }, item = current.item;
  const href = useHref(item ? mediaWatchPath('vod', item.channel.handle, item.id) : '/vod'), shareUrl = new URL(href, window.location.origin).href;
  function release() { const element = video.current; if (!element) return; if (document.pictureInPictureElement === element) void document.exitPictureInPicture().catch(() => {}); element.pause(); element.removeAttribute('src'); element.load(); }
  useEffect(() => {
    active.current = true; ++generation.current; setMediaAllowed(true); setMediaError(''); setMediaPending(false); setSharing(false); let disposed = false; refreshing.current = false;
    async function refresh(initial = false) {
      if (disposed || refreshing.current || mediaRequest.current) return;
      if (!navigator.onLine) { if (initial) setState({ key, item: null, phase: 'error', error: '인터넷 연결을 확인해 주세요.' }); return; }
      const controller = new AbortController(); request.current = controller; refreshing.current = true;
      if (initial) setState({ key, item: null, phase: 'loading', error: '' });
      try { const result = await vodApi.detail(id, controller.signal); if (!disposed && !controller.signal.aborted) setState({ key, item: result.item, phase: 'ready', error: '' }); }
      catch (error) { if (disposed || controller.signal.aborted) return; if (error instanceof AccountError && error.status === 404) { release(); setMediaAllowed(false); setMediaError(withdrawnMessage); setSharing(false); setState({ key, item: null, phase: 'missing', error: '' }); } else setState(old => ({ key, item: old.key === key ? old.item : null, phase: old.key === key && old.item ? 'ready' : 'error', error: message(error, '다시보기를 불러오지 못했어요.') })); }
      finally { if (request.current === controller) { refreshing.current = false; request.current = null; } }
    }
    function wake() { setOnline(navigator.onLine); if (document.visibilityState === 'visible' && navigator.onLine) void refresh(); }
    refreshNow.current = () => { void refresh(); }; void refresh(true); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 10000);
    window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('offline', wake); document.addEventListener('visibilitychange', wake);
    return () => { disposed = true; active.current = false; ++generation.current; request.current?.abort(); mediaRequest.current?.abort(); mediaRequest.current = null; refreshing.current = false; release(); window.clearInterval(timer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', wake); document.removeEventListener('visibilitychange', wake); };
  }, [key, id, attempt]);
  useEffect(() => { if (!sharing) return; const element = share.current; element?.showModal(); shareInput.current?.focus(); shareInput.current?.select(); return () => { element?.close(); }; }, [sharing]);
  async function checkMedia(retry = false) {
    if (!active.current || scopeRef.current !== key || mediaRequest.current || retry && !online) return;
    const controller = new AbortController(), revision = generation.current, expected = key;
    const valid = () => active.current && !controller.signal.aborted && scopeRef.current === expected && generation.current === revision;
    mediaRequest.current = controller; request.current?.abort(); request.current = null; refreshing.current = false;
    release(); setMediaAllowed(false); setMediaPending(true); setMediaError('영상의 공개 상태를 다시 확인하고 있어요.');
    try {
      const result = await vodApi.detail(id, controller.signal); if (!valid()) return;
      setState({ key, item: result.item, phase: 'ready', error: '' });
      if (retry) { setMediaError(''); setMediaAllowed(true); setMediaAttempt(v => v + 1); }
      else setMediaError('영상을 재생하지 못했어요. 연결 상태와 브라우저의 영상 지원을 확인한 뒤 다시 시도해 주세요.');
    } catch (error) { if (!valid()) return; if (error instanceof AccountError && error.status === 404) { setMediaError(withdrawnMessage); setSharing(false); setState({ key, item: null, phase: 'missing', error: '' }); } else setMediaError(message(error, '영상 상태를 확인하지 못했어요.')); }
    finally { if (mediaRequest.current === controller) { mediaRequest.current = null; if (valid()) setMediaPending(false); } }
  }
  async function copy() { const expected = key, revision = generation.current; const valid = () => active.current && scopeRef.current === expected && generation.current === revision; try { if (!navigator.clipboard?.writeText) throw Error(); await navigator.clipboard.writeText(shareUrl); if (valid()) setCopied('done'); } catch { if (valid()) { setCopied('error'); shareInput.current?.focus(); shareInput.current?.select(); } } }
  function clipAccessError(failure: unknown) { if (!(failure instanceof AccountError)) return false; if (failure.status === 401) { onRequireLogin?.(); return true; } if (failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') { onSessionChanged?.(); return true; } return false; }
  function closeShare() { share.current?.close(); setSharing(false); shareButton.current?.focus(); }
  if (item && handle !== item.channel.handle) return <Navigate to={mediaWatchPath('vod', item.channel.handle, item.id)} replace />;
  return <section className={ui.page + ' ' + base.page + ' ' + base.watchPage + ' ' + styles.surface} aria-labelledby="vod-watch-title">
    {!item && <h1 className={styles.srOnly} id="vod-watch-title">다시보기</h1>}
    <header className={base.watchToolbar}><Link className={base.back} to="/vod"><ArrowLeft size={18} aria-hidden="true" />다시보기 목록</Link>{item && <div className={styles.watchActions}>{session?.user && session.channel?.id === item.channel.id && <ClipCreator key={session.user.id + '/' + item.id} source={item} session={session} online={online} sourceVideo={video} onAccessError={clipAccessError} />}<button ref={shareButton} className={ui.button} type="button" onClick={() => { setCopied('idle'); setSharing(true); }}><Share2 size={16} aria-hidden="true" />다시보기 공유</button></div>}</header>
    {current.phase === 'loading' ? <p className={styles.loading} role="status">다시보기를 불러오는 중이에요.</p> : current.phase === 'missing' ? <EmptyState icon={<VideoOff size={26} />} title="공개된 다시보기를 찾을 수 없어요" description="방송자가 공개를 중단했거나 영상 주소가 달라졌을 수 있어요." action={<Link className={ui.button} to="/vod">다른 다시보기 보기</Link>} /> : current.phase === 'error' ? <div className={styles.feedback + ' ' + styles.error}><p role="alert">{current.error}</p><button type="button" className={ui.button} disabled={!online} onClick={() => setAttempt(v => v + 1)}>다시보기 다시 시도</button></div> : item && <>
      {!online && <p className={styles.feedback} role="status">인터넷 연결을 확인해 주세요.</p>}{current.error && <div className={styles.feedback + ' ' + styles.error}><p role="alert">{current.error}</p><button className={ui.button} type="button" disabled={!online} onClick={() => refreshNow.current()}>공개 상태 다시 확인</button></div>}
      <div className={base.player + ' ' + styles.player}>{mediaAllowed ? <video key={key + '/' + mediaAttempt} ref={video} aria-label="다시보기 영상" src={vodApi.mediaUrl(item.id)} controls playsInline preload="metadata" onError={() => void checkMedia()} /> : <div className={styles.playerNotice}><VideoOff size={26} aria-hidden="true" /><p role={mediaPending ? 'status' : 'alert'}>{mediaError}</p><button type="button" className={ui.button} disabled={!online || mediaPending} onClick={() => void checkMedia(true)}>{mediaPending ? '확인 중…' : '영상 다시 시도'}</button></div>}</div>
      <div className={base.watchDetails}><span className={base.kind}>다시보기</span><h1 id="vod-watch-title">{item.title}</h1><Link className={base.watchChannel} to={channelPath(item.channel.handle)}><Avatar channel={item.channel} />{item.channel.displayName}</Link><p className={styles.watchMeta}><span>영상 길이 {vodDuration(item.durationMs)}</span><time dateTime={new Date(item.publishedAtMs).toISOString()}>{dateTime.format(item.publishedAtMs)} 공개</time></p>{item.description && <p className={styles.description}>{item.description}</p>}</div>
      <ConnectedVodList key={item.channel.id} channelHandle={item.channel.handle} recent excludeId={item.id} />
    </>}
    {sharing && item && <dialog ref={share} className={ui.dialog + ' ' + styles.shareDialog} aria-labelledby={dialogId} onCancel={event => { event.preventDefault(); closeShare(); }}><header><h2 id={dialogId}>다시보기 공유</h2><button type="button" className="icon-button" aria-label="다시보기 공유 닫기" onClick={closeShare}><X size={19} aria-hidden="true" /></button></header><label>영상 링크<span className={styles.shareControls}><input ref={shareInput} className={ui.control} readOnly value={shareUrl} aria-label="다시보기 공유 링크" onFocus={event => event.currentTarget.select()} /><button type="button" className={ui.button} onClick={() => void copy()}><Copy size={16} aria-hidden="true" />{copied === 'done' ? '복사됨' : '복사'}</button></span></label><p role="status">{copied === 'done' ? '링크를 복사했어요.' : copied === 'error' ? '링크를 선택했어요. 직접 복사해 주세요.' : ''}</p></dialog>}
  </section>;
}
