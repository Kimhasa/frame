import { ArrowLeft, ArrowUpRight, CalendarDays, Check, Copy, Flag, Globe2, Link2, Radio, Share2, TrendingUp, UsersRound, Video, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PreviewChannel } from '../../preview/community-types';
import styles from './ChannelDetails.module.css';

export type ChannelDetailMode = 'about' | 'share' | 'report';
export type ChannelReportInput = { reason: string; details: string };
const number = new Intl.NumberFormat('ko-KR');
const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
const countries = new Intl.DisplayNames(['ko'], { type: 'region' });
const reasons = [
  { value: 'spam', label: '스팸 또는 광고' }, { value: 'impersonation', label: '다른 사람이나 채널 사칭' },
  { value: 'harassment', label: '괴롭힘 또는 혐오 표현' }, { value: 'inappropriate', label: '부적절한 채널 정보' }, { value: 'other', label: '기타' },
];

export function channelShareUrl(channel: Pick<PreviewChannel, 'handle' | 'id'>) {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  const route = channel.id ? `channel/id/${encodeURIComponent(channel.id)}` : `channel/${encodeURIComponent(channel.handle)}`;
  return new URL(route, base).href;
}
export function externalChannelUrl(value: string) {
  try {
    if (/[\u0000-\u0020\u007f]/.test(value)) return null;
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
export function channelLinks(channel: PreviewChannel) {
  return (channel.links ?? []).slice(0, 14).flatMap(link => {
    const url = externalChannelUrl(link.url);
    return url && link.title.trim() ? [{ ...link, url: url.href, host: url.hostname }] : [];
  });
}
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function ChannelDetails({ channel, mode, onModeChange, onDismiss, ownChannel, signedIn, onRequireLogin, onReport }: {
  channel: PreviewChannel; mode: ChannelDetailMode; onModeChange: (mode: ChannelDetailMode) => void; onDismiss: () => void;
  ownChannel: boolean; signedIn: boolean; onRequireLogin?: () => void; onReport?: (input: ChannelReportInput) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), linkInput = useRef<HTMLInputElement>(null);
  const detailsInput = useRef<HTMLTextAreaElement>(null), opener = useRef(document.activeElement);
  const active = useRef(true), submitting = useRef(false), id = useId();
  const [reason, setReason] = useState(''), [details, setDetails] = useState('');
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [received, setReceived] = useState(false);
  const [invalidField, setInvalidField] = useState<'reason' | 'details' | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'error'>('idle');
  const links = channelLinks(channel), shareUrl = channelShareUrl(channel);
  const publicUrl = new URL(`channel/${encodeURIComponent(channel.handle)}`, new URL(import.meta.env.BASE_URL, window.location.origin)).href;
  const created = typeof channel.createdAtMs === 'number' && channel.createdAtMs >= 0 && Number.isFinite(new Date(channel.createdAtMs).getTime()) ? new Date(channel.createdAtMs) : null;
  const country = channel.countryCode && /^[A-Z]{2}$/.test(channel.countryCode) ? countries.of(channel.countryCode) : null;
  const canReport = !ownChannel && Boolean(onReport || onRequireLogin);
  const title = mode === 'about' ? channel.displayName : mode === 'share' ? '채널 공유' : received ? '신고 접수' : '채널 신고';

  useEffect(() => {
    active.current = true; const element = dialog.current;
    element?.showModal();
    return () => {
      active.current = false; element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [mode, received]);
  function dismiss() { if (!submitting.current) onDismiss(); }
  function changeMode(next: ChannelDetailMode) {
    if (submitting.current) return;
    setError(''); setInvalidField(null); setCopyState('idle'); onModeChange(next);
  }
  function startReport() {
    if (!signedIn) { onDismiss(); onRequireLogin?.(); return; }
    changeMode('report');
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      if (active.current) setCopyState('done');
    } catch {
      if (active.current) { setCopyState('error'); linkInput.current?.focus(); linkInput.current?.select(); }
    }
  }
  async function share() {
    try { await navigator.share({ title: `${channel.displayName} · FRAME`, url: shareUrl }); }
    catch (failure) {
      if (active.current && !(failure instanceof DOMException && failure.name === 'AbortError')) setError('공유 창을 열지 못했어요. 링크를 복사해 주세요.');
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current || !onReport || received) return;
    if (!reasons.some(item => item.value === reason)) { setInvalidField('reason'); setError('신고 사유를 선택해 주세요.'); dialog.current?.querySelector<HTMLInputElement>('input[name="report-reason"]')?.focus(); return; }
    if ((reason === 'other' && !details.trim()) || [...details].length > 1000) { setInvalidField('details'); setError(reason === 'other' && !details.trim() ? '신고 내용을 입력해 주세요.' : '신고 내용은 1,000자 이내로 입력해 주세요.'); detailsInput.current?.focus(); return; }
    submitting.current = true; setPending(true); setError(''); setInvalidField(null);
    try { await onReport({ reason, details: details.trim() }); if (active.current) setReceived(true); }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : '신고를 접수하지 못했어요. 다시 시도해 주세요.'); }
    finally { submitting.current = false; if (active.current) setPending(false); }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} aria-busy={pending}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss(); } }}>
    <header className={styles.header}>
      {mode !== 'about' && !received && <button type="button" className={styles.iconButton} aria-label="채널 정보로 돌아가기" disabled={pending} onClick={() => changeMode('about')}><ArrowLeft size={20} /></button>}
      <h2 ref={heading} tabIndex={-1} id={`${id}-title`}>{title}</h2>
      <button type="button" className={styles.iconButton} aria-label="채널 상세 닫기" disabled={pending} onClick={dismiss}><X size={22} /></button>
    </header>
    <div className={styles.body}>
      {mode === 'about' && <>
        <section className={styles.section}><h3>설명</h3><p className={styles.description}>{channel.description || '아직 등록된 채널 소개가 없어요.'}</p></section>
        {links.length > 0 && <section className={styles.section}><h3>링크</h3><ul className={styles.links}>
          {links.map((link, index) => <li key={index}><span className={styles.linkIcon} aria-hidden="true"><Link2 size={20} /></span>
            <a href={link.url} target="_blank" rel="noopener noreferrer"><strong>{link.title}</strong><span>{link.host}<ArrowUpRight size={14} aria-hidden="true" /></span></a></li>)}
        </ul></section>}
        <section className={styles.section}><h3>추가 정보</h3><dl className={styles.facts}>
          <div><dt><Radio size={20} /><span className={styles.srOnly}>채널 주소</span></dt><dd><a href={publicUrl}>@{channel.handle}</a></dd></div>
          {country && <div><dt><Globe2 size={20} /><span className={styles.srOnly}>국가</span></dt><dd>{country}</dd></div>}
          {created && <div><dt><CalendarDays size={20} /><span className={styles.srOnly}>가입일</span></dt><dd>가입일: <time dateTime={created.toISOString()}>{date.format(created)}</time></dd></div>}
          <div><dt><UsersRound size={20} /><span className={styles.srOnly}>팔로워</span></dt><dd>팔로워 {number.format(channel.followerCount)}명</dd></div>
          {counter(channel.videoCount) && <div><dt><Video size={20} /><span className={styles.srOnly}>동영상 수</span></dt><dd>동영상 {number.format(channel.videoCount)}개</dd></div>}
          {counter(channel.totalViewCount) && <div><dt><TrendingUp size={20} /><span className={styles.srOnly}>누적 조회수</span></dt><dd>조회수 {number.format(channel.totalViewCount)}회</dd></div>}
        </dl></section>
        <div className={styles.actions}><button type="button" className={styles.button} onClick={() => changeMode('share')}><Share2 size={17} />채널 공유</button>
          {canReport && <button type="button" className={styles.button} onClick={startReport}><Flag size={17} />채널 신고</button>}</div>
      </>}
      {mode === 'share' && <>
        <div className={styles.shareIdentity}><span aria-hidden="true">{Array.from(channel.displayName.trim())[0] ?? 'F'}</span><div><strong>{channel.displayName}</strong><small>@{channel.handle}</small></div></div>
        <label className={styles.field}>채널 링크<div className={styles.copyField}><input ref={linkInput} name="channel-share-url" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />
          <button type="button" className={styles.copyButton} onClick={() => void copy()} aria-label="채널 링크 복사">{copyState === 'done' ? <Check size={17} /> : <Copy size={17} />}복사</button></div></label>
        {copyState !== 'idle' && <p className={copyState === 'error' ? styles.error : styles.success} role={copyState === 'error' ? 'alert' : 'status'}>{copyState === 'done' ? '링크를 복사했어요.' : '링크를 복사하지 못했어요. 주소를 선택해 복사해 주세요.'}</p>}
        {typeof navigator.share === 'function' && <div className={styles.actions}><button type="button" className={styles.button} onClick={() => void share()}><Share2 size={17} />다른 앱으로 공유</button></div>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </>}
      {mode === 'report' && (received ? <div className={styles.receipt}>
        <span aria-hidden="true"><Check size={26} /></span><h3>신고가 접수됐어요</h3><p>{channel.displayName} 채널에 대한 신고를 접수했어요.</p>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={dismiss}>확인</button>
      </div> : <form onSubmit={submit} noValidate>
        <p className={styles.reportTarget}><strong>{channel.displayName}</strong><span>@{channel.handle}</span></p>
        <fieldset className={styles.reportFields} disabled={pending}><legend>신고 사유</legend><div className={styles.reasons}>
          {reasons.map(item => <label key={item.value}><input type="radio" name="report-reason" value={item.value} checked={reason === item.value} aria-invalid={invalidField === 'reason'} aria-describedby={invalidField === 'reason' ? `${id}-error` : undefined} onChange={() => { setReason(item.value); setError(''); setInvalidField(null); }} /><span>{item.label}</span></label>)}
        </div><label className={styles.field}>상세 내용{reason === 'other' ? ' (필수)' : ' (선택)'}<textarea ref={detailsInput} name="report-details" rows={4} maxLength={2000} value={details} aria-invalid={invalidField === 'details'} aria-describedby={invalidField === 'details' ? `${id}-error` : undefined} onChange={event => { setDetails(event.target.value); setError(''); setInvalidField(null); }} placeholder="신고할 내용을 구체적으로 적어 주세요." /></label>
          <span className={styles.counter}>{[...details].length.toLocaleString('ko-KR')} / 1,000</span>
        </fieldset>
        {error && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}><button type="button" className={styles.button} disabled={pending} onClick={dismiss}>취소</button><button type="submit" className={`${styles.button} ${styles.primary}`} disabled={pending}>{pending ? '접수 중…' : '신고 접수'}</button></div>
      </form>)}
    </div>
  </dialog>;
}
