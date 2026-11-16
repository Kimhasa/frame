import { Scissors, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { vodApi } from '../vod/vod-client';
import type { PublicVod } from '../vod/vod-client';
import { clipsApi } from './clips-client';
import type { CreateClip, OwnerClip } from './clips-client';
import { ClipEditor, seconds } from './ClipEditor';
import styles from './ClipTools.module.css';

function milliseconds(value: string) { return /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,3})?$/.test(value.trim()) ? Math.round(Number(value.trim()) * 1000) : null; }
export function ClipCreator({ source, session, online, sourceVideo, onAccessError }: {
  source: PublicVod; session: AccountSession; online: boolean; sourceVideo: RefObject<HTMLVideoElement | null>; onAccessError: (failure: unknown) => boolean;
}) {
  const owner = session.user!.id, scope = owner + '/' + source.id, id = useId();
  const [opened, setOpened] = useState(false), [start, setStart] = useState('0'), [end, setEnd] = useState('0'), [title, setTitle] = useState(''), [description, setDescription] = useState('');
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [editorBusy, setEditorBusy] = useState(false), [reading, setReading] = useState(false), [confirming, setConfirming] = useState(false);
  const [frozen, setFrozen] = useState<CreateClip | null>(null), [uncertain, setUncertain] = useState(false), [receiptAbsent, setReceiptAbsent] = useState(false), [created, setCreated] = useState<OwnerClip | null>(null), [retryAt, setRetryAt] = useState(0), [previewError, setPreviewError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null), preview = useRef<HTMLVideoElement>(null), previewEnd = useRef<number | null>(null);
  const active = useRef(true), busy = useRef(false), childBusy = useRef(false), readingRef = useRef(false), scopeRef = useRef(scope), openRef = useRef(opened), request = useRef<AbortController | null>(null), generation = useRef(0), access = useRef(onAccessError);
  scopeRef.current = scope; openRef.current = opened; access.current = onAccessError;
  useEffect(() => { active.current = true; return () => { active.current = false; ++generation.current; request.current?.abort(); const video = preview.current; if (video) { video.pause(); video.removeAttribute('src'); video.load(); } }; }, [scope]);
  useEffect(() => { if (!opened) return; const element = dialog.current, video = preview.current; element?.showModal(); heading.current?.focus(); return () => { video?.pause(); video?.removeAttribute('src'); video?.load(); element?.close(); }; }, [opened]);
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);
  useEffect(() => { if (!online) { request.current?.abort(); readingRef.current = false; setReading(false); preview.current?.pause(); } }, [online]);
  useEffect(() => { if (!retryAt) return; const timer = window.setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now())); return () => window.clearTimeout(timer); }, [retryAt]);
  function open() {
    if (!online || busy.current || childBusy.current || readingRef.current || source.durationMs < 5000) return;
    if (frozen && uncertain && !created) { sourceVideo.current?.pause(); ++generation.current; setOpened(true); return; }
    sourceVideo.current?.pause(); const at = Math.max(0, Math.min(source.durationMs - 5000, Math.floor((sourceVideo.current?.currentTime ?? 0) * 1000)));
    setStart(seconds(at)); setEnd(seconds(Math.min(source.durationMs, at + 30000))); setTitle([...source.title].slice(0, 100).join('')); setDescription(''); setError(''); setPreviewError(''); setFrozen(null); setUncertain(false); setReceiptAbsent(false); setCreated(null); setConfirming(false); previewEnd.current = null; ++generation.current; setOpened(true);
  }
  function close() {
    if (busy.current || childBusy.current) return; ++generation.current; request.current?.abort(); readingRef.current = false; setReading(false);
    const video = preview.current; if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    dialog.current?.close(); setOpened(false); trigger.current?.focus();
  }
  function payload(): CreateClip | null {
    const startMs = milliseconds(start), endMs = milliseconds(end), normalizedTitle = title.trim(), normalizedDescription = description.trim();
    if (startMs === null || endMs === null || startMs < 0 || endMs > source.durationMs || endMs - startMs < 5000 || endMs - startMs > 60000) { setError('원본 안에서 5~60초 구간을 선택해 주세요. 시간은 소수점 셋째 자리까지 입력할 수 있어요.'); return null; }
    if (!normalizedTitle || [...normalizedTitle].length > 100 || [...normalizedDescription].length > 2000) { setError('제목은 1~100자, 설명은 2,000자 이내로 입력해 주세요.'); return null; }
    return { sourceVodId: source.id, startMs, endMs, title: normalizedTitle, description: normalizedDescription, clientRequestId: crypto.randomUUID() };
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!online || busy.current || readingRef.current || frozen) return; if (payload()) setConfirming(true); }
  async function send(sameRequest = false) {
    if (!online || busy.current || readingRef.current || Date.now() < retryAt || sameRequest && (!frozen || !receiptAbsent)) return;
    const input = sameRequest ? frozen : payload(); if (!input) return;
    const expected = scope, revision = generation.current; busy.current = true; setPending(true); setError(''); setFrozen(input); setUncertain(false); setReceiptAbsent(false); preview.current?.pause();
    const valid = () => active.current && openRef.current && scopeRef.current === expected && generation.current === revision;
    try { const result = await clipsApi.create(input, owner, session.csrfToken); if (!valid() || !result.item) return; setCreated(result.item); setConfirming(false); }
    catch (failure) {
      if (!valid() || access.current(failure)) return; setError(failure instanceof Error ? failure.message : '클립 공개를 요청하지 못했어요.');
      if (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500 || failure.code === 'CLIP_REQUEST_CONFLICT') { setUncertain(true); setConfirming(false); }
      else { setFrozen(null); if (failure.status === 429 && failure.retryAfterMs) setRetryAt(Date.now() + failure.retryAfterMs); }
    } finally { busy.current = false; if (valid()) setPending(false); }
  }
  async function receipt() {
    if (!online || !frozen || busy.current || readingRef.current) return;
    const controller = new AbortController(), expected = scope, revision = generation.current; request.current = controller; readingRef.current = true; setReading(true); setError('');
    try {
      const result = await clipsApi.receipt(frozen.clientRequestId, owner, controller.signal);
      if (!active.current || controller.signal.aborted || scopeRef.current !== expected || generation.current !== revision || !openRef.current) return;
      if (result.item) { if (result.item.sourceVodId !== frozen.sourceVodId || result.item.startMs !== frozen.startMs || result.item.endMs !== frozen.endMs) throw new AccountError('접수된 클립의 구간이 달라요. 녹화 상세의 클립 관리에서 현재 요청을 확인해 주세요.', 'CLIP_REQUEST_CONFLICT', 409); setCreated(result.item); setUncertain(false); setReceiptAbsent(false); } else setReceiptAbsent(true);
    } catch (failure) { if (active.current && !controller.signal.aborted && scopeRef.current === expected && generation.current === revision && !access.current(failure)) setError(failure instanceof Error ? failure.message : '클립 접수 결과를 확인하지 못했어요.'); }
    finally { if (request.current === controller) { readingRef.current = false; if (active.current) setReading(false); } }
  }
  function currentPosition(kind: 'start' | 'end') { const at = Math.floor((preview.current?.currentTime ?? sourceVideo.current?.currentTime ?? 0) * 1000); if (kind === 'start') setStart(seconds(at)); else setEnd(seconds(at)); setError(''); }
  async function previewRange() {
    const from = milliseconds(start), to = milliseconds(end); if (from === null || to === null || from < 0 || to > source.durationMs || to <= from) { setPreviewError('재생할 시작과 끝 시간을 확인해 주세요.'); return; }
    const video = preview.current; if (!video) return; const expected = scope, revision = generation.current; video.currentTime = from / 1000; previewEnd.current = to / 1000; setPreviewError(''); try { await video.play(); } catch { if (active.current && openRef.current && scopeRef.current === expected && generation.current === revision) setPreviewError('영상의 재생 버튼을 눌러 구간을 확인해 주세요.'); }
  }
  const selectedStart = milliseconds(start), selectedEnd = milliseconds(end), selectedDuration = selectedStart !== null && selectedEnd !== null && selectedEnd > selectedStart ? selectedEnd - selectedStart : 0;
  const locked = pending || reading || Boolean(frozen), cooling = Date.now() < retryAt;
  return <><button ref={trigger} className={ui.button} type="button" disabled={!online || source.durationMs < 5000} onClick={open}><Scissors size={16} aria-hidden="true" />클립 만들기</button>
    {opened && <dialog ref={dialog} className={ui.dialog + ' ' + styles.composerDialog} aria-labelledby={id} aria-busy={pending || editorBusy || reading} onCancel={event => { event.preventDefault(); close(); }}>
      <header className={ui.dialogHeader}><h2 ref={heading} id={id} tabIndex={-1}>클립 만들기</h2><button className="icon-button" type="button" aria-label="클립 만들기 닫기" disabled={pending || editorBusy} onClick={close}><X size={19} aria-hidden="true" /></button></header>
      {created ? <ClipEditor key={created.id} initial={created} session={session} online={online} onAccessError={onAccessError} onBusyChange={value => { childBusy.current = value; setEditorBusy(value); }} onUpdated={setCreated} /> : <>
        <div className={styles.sourcePlayer}><video ref={preview} aria-label="클립 원본 영상" src={vodApi.mediaUrl(source.id)} controls playsInline preload="metadata" onLoadedMetadata={() => { const video = preview.current, from = milliseconds(start); if (video && from !== null) video.currentTime = from / 1000; }} onTimeUpdate={() => { const video = preview.current; if (video && previewEnd.current !== null && video.currentTime >= previewEnd.current) { video.pause(); previewEnd.current = null; } }} onError={() => setPreviewError('원본 영상을 확인하지 못했어요. 원본 공개 상태와 연결을 확인해 주세요.')} /></div>
        <p className={styles.hint}>5~60초 구간을 선택해요. 원본 다시보기를 비공개로 바꾸면 이 영상에서 만든 클립도 시청이 중단돼요.</p>
        <form className={styles.form} onSubmit={submit}>
          <div className={styles.times}><label>시작 (초)<input className={ui.control} aria-label="클립 시작(초)" inputMode="decimal" value={start} disabled={locked} onChange={event => setStart(event.target.value)} /><button className={ui.button} type="button" disabled={locked} onClick={() => currentPosition('start')}>현재 위치를 시작으로</button></label><label>끝 (초)<input className={ui.control} aria-label="클립 끝(초)" inputMode="decimal" value={end} disabled={locked} onChange={event => setEnd(event.target.value)} /><button className={ui.button} type="button" disabled={locked} onClick={() => currentPosition('end')}>현재 위치를 끝으로</button></label></div>
          <div className={styles.counter}><span>선택한 길이 {seconds(selectedDuration)}초</span><span>원본 {seconds(source.durationMs)}초</span></div><div className={styles.actions}><button type="button" className={ui.button} disabled={pending || reading} onClick={() => void previewRange()}>선택 구간 재생</button></div>
          <label>제목<input className={ui.control} aria-label="클립 제목" value={title} maxLength={100} required disabled={locked} onChange={event => setTitle(event.target.value)} /><span className={styles.counter}><span /><span>{[...title].length}/100</span></span></label>
          <label>설명<textarea className={ui.control} aria-label="클립 설명" value={description} maxLength={2000} disabled={locked} onChange={event => setDescription(event.target.value)} /></label>
          <div className={styles.actions}><button className={ui.button + ' ' + ui.primary} type="submit" disabled={!online || locked || cooling}>{pending ? '요청 중…' : '클립 공개'}</button></div>
        </form>
        {previewError && <p className={styles.hint + ' ' + styles.error} role="alert">{previewError}</p>}{error && <p className={styles.hint + ' ' + styles.error} role="alert">{error}</p>}
        {uncertain && <div className={styles.confirmation}><p>요청 결과를 확인하지 못했어요. 입력한 구간과 요청은 유지하고 있어요. 다시 보내기 전에 서버의 접수 결과를 확인해 주세요.</p><div className={styles.actions}><button className={ui.button} type="button" disabled={!online || reading || pending} onClick={() => void receipt()}>{reading ? '확인 중…' : '클립 접수 결과 확인'}</button>{receiptAbsent && <button className={ui.button + ' ' + ui.primary} type="button" disabled={!online || reading || pending || cooling} onClick={() => void send(true)}>같은 요청 다시 보내기</button>}</div>{receiptAbsent && <p>아직 접수된 클립이 없어요. 같은 구간과 같은 요청으로 다시 보낼 수 있어요.</p>}</div>}
        {confirming && !uncertain && <div className={styles.confirmation} role="group" aria-label="클립 공개 확인"><p>선택한 {seconds(selectedDuration)}초 구간을 클립으로 공개할까요? 영상 준비가 끝나면 시청자가 볼 수 있어요.</p><div className={styles.actions}><button ref={cancel} className={ui.button} type="button" disabled={pending} onClick={() => setConfirming(false)}>취소</button><button className={ui.button + ' ' + ui.primary} type="button" disabled={!online || pending || reading || cooling} onClick={() => void send()}>클립 공개하기</button></div></div>}
      </>}
      <div className={ui.dialogActions}><button className={ui.button} type="button" disabled={pending || editorBusy} onClick={close}>클립 만들기 닫기</button></div>
    </dialog>}
  </>;
}
