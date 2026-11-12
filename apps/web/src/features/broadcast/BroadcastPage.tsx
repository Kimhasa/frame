import { Activity, Check, CircleAlert, CircleCheck, CircleHelp, Copy, Eye, EyeOff, KeyRound, Link2, LoaderCircle, Maximize2, MessagesSquare, Pencil, Radio, RotateCw, Unplug, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { ChatAccountActions } from '../../viewer-contract';
import { useSearchParams } from 'react-router';
import { ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import workspace from '../../preview/assets/code-workspace.svg';
import { ChatPanel } from '../chat/ChatPanel';
import { broadcastCategories, broadcastVisibilities } from './broadcast-preview';
import type { BroadcastInfo, BroadcastPreview } from './broadcast-preview';
import type { ObsStudioView } from './LocalObsStudio';
import styles from './BroadcastPage.module.css';

const designPreview = import.meta.env.MODE === 'design';
const ingestUrl = designPreview ? 'rtmps://ingest.frame.example:1936' : '';
const tabs = [{ id: 'stream', label: '송출 정보' }, { id: 'info', label: '방송 정보' }, { id: 'health', label: '방송 상태' }] as const;
type Tab = typeof tabs[number]['id'];
type Modal = 'guide' | 'info' | 'key' | 'share' | null;
type Signal = 'waiting' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'ended';

function Dialog({ title, dialogRef, onDismiss, children, locked = false }: {
  title: string;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onDismiss: () => void;
  children: ReactNode;
  locked?: boolean;
}) {
  const titleId = useId();
  const controls = useRef({ locked, onDismiss });
  controls.current = { locked, onDismiss };
  useEffect(() => {
    const element = dialogRef.current;
    const cancel = (event: Event) => { event.preventDefault(); if (!controls.current.locked) controls.current.onDismiss(); };
    element?.addEventListener('cancel', cancel);
    element?.showModal();
    element?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => { element?.removeEventListener('cancel', cancel); element?.close(); };
  }, []);
  useEffect(() => { if (locked) dialogRef.current?.querySelector<HTMLElement>('h2')?.focus(); }, [locked]);
  return <dialog ref={dialogRef} className={ui.dialog} aria-labelledby={titleId}
    onKeyDown={event => { if (locked && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } }}
    >
    <header className={ui.dialogHeader}><h2 id={titleId} tabIndex={-1}>{title}</h2><button type="button" className="icon-button" aria-label="닫기" disabled={locked} onClick={onDismiss}><X size={20} aria-hidden="true" /></button></header>
    {children}
  </dialog>;
}

function InfoFields({ info, onChange, error, prefix, titleRef, platformOnly = false, disabled = false }: {
  info: BroadcastInfo;
  onChange: (info: BroadcastInfo) => void;
  error: string;
  prefix: string;
  titleRef?: RefObject<HTMLInputElement | null>;
  platformOnly?: boolean;
  disabled?: boolean;
}) {
  return <fieldset className={styles.fields} disabled={disabled}>
    <label><span>방송 제목 <b className={styles.required}>*</b></span>
      <input className={ui.control} ref={titleRef} data-initial-focus name="title" value={info.title} maxLength={100} required placeholder="어떤 방송을 시작할까요?"
        aria-invalid={Boolean(error)} aria-describedby={error ? `${prefix}-title-error` : undefined} onChange={event => onChange({ ...info, title: event.currentTarget.value })} />
    </label>
    {error && <p className={styles.error} id={`${prefix}-title-error`} role="alert">{error}</p>}
    {!platformOnly && <><div className={styles.fieldPair}>
      <label>카테고리<select className={ui.control} name="category" value={info.category} onChange={event => onChange({ ...info, category: event.currentTarget.value })}>{broadcastCategories.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>공개 설정<select className={ui.control} name="visibility" value={info.visibility} onChange={event => onChange({ ...info, visibility: event.currentTarget.value })}>{broadcastVisibilities.map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    <label>태그<input className={ui.control} name="tags" value={info.tags} maxLength={100} placeholder="개발, 코딩, 작업실" onChange={event => onChange({ ...info, tags: event.currentTarget.value })} /></label></>}
  </fieldset>;
}

export function BroadcastPage({ preview, onChange, studio, chatAccount, participation }: { preview: BroadcastPreview; onChange: (preview: BroadcastPreview) => void; studio?: ObsStudioView; chatAccount?: ChatAccountActions; participation?: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const id = useId();
  const tab = tabs.find(item => item.id === params.get('tab'))?.id ?? 'stream';
  const scenario = params.get('state');
  const signal: Signal = studio ? studio.error || studio.status?.state === 'unavailable' ? 'error' : studio.status?.state === 'live' ? 'live'
    : studio.status?.state === 'reconnecting' ? 'reconnecting' : studio.status ? 'waiting' : 'connecting'
    : scenario === 'live' || scenario === 'ready' ? 'live' : scenario === 'connecting' ? 'connecting'
    : scenario === 'reconnecting' || scenario === 'disconnected' ? 'reconnecting' : scenario === 'error' || scenario === 'connection-error' ? 'error'
    : scenario === 'ended' ? 'ended' : 'waiting';
  const hasSignal = signal === 'live';
  const busy = signal === 'connecting' || signal === 'reconnecting';
  const canReissue = !studio && !hasSignal && !busy;
  const serverUrl = studio ? studio.status?.serverUrl ?? '' : ingestUrl;
  const streamKey = studio ? studio.status?.streamKey ?? '' : preview.streamKey;
  const watch = studio?.watch;
  const stateLabel = { waiting: '송출 대기', connecting: '연결 중', live: '방송 중', reconnecting: '재연결 중', error: '연결 실패', ended: '방송 종료' }[signal];
  const previewTitle = { waiting: 'OBS에서 방송을 시작해 주세요', connecting: 'OBS 신호를 확인하고 있어요', live: '', reconnecting: '방송 신호를 다시 기다리고 있어요', error: 'OBS와 연결하지 못했어요', ended: '방송이 종료되었어요' }[signal];
  const previewDescription = { waiting: '아래 송출 주소와 스트림 키를 OBS에 붙여넣으면 준비가 끝나요.', connecting: '영상과 소리가 들어오면 이곳에 표시돼요.', live: '', reconnecting: 'OBS의 송출 상태와 인터넷 연결을 확인해 주세요.', error: 'OBS에 입력한 송출 주소와 스트림 키를 확인해 주세요.', ended: '다음 방송을 시작하려면 OBS에서 다시 송출해 주세요.' }[signal];
  const [modal, setModal] = useState<Modal>(null);
  const [showKey, setShowKey] = useState(false);
  const [editInfo, setEditInfo] = useState(preview.info);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const saveRequest = useRef<AbortController | null>(null);
  const currentPreview = useRef(preview);
  currentPreview.current = preview;
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState<'url' | 'key' | 'share' | null>(null);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const modalOrigin = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const modalTitleInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const shareInput = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const chatTrigger = useRef<HTMLButtonElement>(null);
  const dirty = JSON.stringify(preview.info) !== JSON.stringify(preview.draft);
  const editDirty = JSON.stringify(preview.info) !== JSON.stringify(editInfo);
  const shareUrl = new URL(`${import.meta.env.BASE_URL}watch/${studio?.status?.path ?? 'workspace'}/${studio?.status?.broadcastId ?? '1'.padStart(32, '0')}`, location.origin).href;

  useEffect(() => { setShowKey(false); }, [scenario]);
  useEffect(() => () => saveRequest.current?.abort(), []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (queuedMessage === null) return;
    const timer = window.setTimeout(() => {
      onChange({ ...preview, messages: [...preview.messages, { id: crypto.randomUUID(), author: preview.nickname, text: queuedMessage, sentAtMs: Date.now() }] });
      setQueuedMessage(null);
    }, 130);
    return () => window.clearTimeout(timer);
  }, [queuedMessage, preview, onChange]);

  function selectTab(next: Tab) {
    setParams(previous => { const value = new URLSearchParams(previous); value.set('tab', next); return value; }, { preventScrollReset: true });
    setError('');
  }

  function tabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = tabs.findIndex(item => item.id === tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next].id);
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${tabs[next].id}"]`)?.focus();
  }

  function openModal(next: Exclude<Modal, null>, origin: HTMLElement) {
    modalOrigin.current = origin;
    setNotice('');
    setError('');
    if (next === 'info') setEditInfo({ ...preview.info });
    setModal(next);
  }

  function dismiss() {
    if (saving) return;
    dialog.current?.close();
    setModal(null);
    setError('');
    requestAnimationFrame(() => (modalOrigin.current?.isConnected ? modalOrigin.current : heading.current)?.focus({ preventScroll: true }));
  }

  async function saveInfo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const inModal = modal === 'info';
    const draft = inModal ? editInfo : preview.draft;
    const title = draft.title.trim();
    if (!title || title.length > 100 || new TextEncoder().encode(title).length > 200) {
      setError(!title ? '방송 제목을 입력해 주세요.' : '제목이 너무 길어요. 내용을 조금 줄여 주세요.');
      (inModal ? modalTitleInput : titleInput).current?.focus();
      return;
    }
    const info = { ...draft, title };
    const request = new AbortController();
    saveRequest.current = request;
    setSaving(true);
    try {
      if (studio) await studio.save(info, request.signal);
      if (request.signal.aborted) return;
      onChange({ ...currentPreview.current, info, draft: { ...info } });
      if (inModal) { dialog.current?.close(); setModal(null); requestAnimationFrame(() => modalOrigin.current?.focus({ preventScroll: true })); }
      setNotice('방송 정보를 저장했어요.');
    } catch { if (!request.signal.aborted) setError('방송 정보를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    finally { if (!request.signal.aborted) { setSaving(false); saveRequest.current = null; } }
  }

  async function copy(kind: 'url' | 'key' | 'share') {
    const value = kind === 'url' ? serverUrl : kind === 'key' ? streamKey : shareUrl;
    if (!value) return;
    const label = kind === 'url' ? '송출 주소' : kind === 'key' ? '스트림 키' : '방송 링크';
    try { await navigator.clipboard.writeText(value); setCopied(kind); setNotice(`${label}를 복사했어요.`); }
    catch {
      if (kind === 'key') setShowKey(true);
      const target = kind === 'url' ? urlInput : kind === 'key' ? keyInput : shareInput;
      requestAnimationFrame(() => { target.current?.focus(); target.current?.select(); });
      setNotice(`${label}를 선택했어요. 직접 복사해 주세요.`);
    }
  }

  async function fullscreen() {
    try { await canvas.current?.requestFullscreen(); }
    catch { setNotice('전체 화면을 열지 못했어요. 브라우저 설정을 확인해 주세요.'); }
  }

  const metrics = studio ? [['해상도', studio.status?.width && studio.status?.height ? `${studio.status.width} × ${studio.status.height}` : '—'],
    ['프레임', studio.status?.fps ? `${studio.status.fps} fps` : '—'], ['비트레이트', studio.status?.bitrateMbps ? `${studio.status.bitrateMbps.toFixed(1)} Mbps` : '—'], ['오디오', studio.status?.audioCodec || '—']]
    : [['해상도', hasSignal ? '1920 × 1080' : '—'], ['프레임', hasSignal ? '60 fps' : '—'], ['비트레이트', hasSignal ? '8.0 Mbps' : '—'], ['오디오', hasSignal ? 'AAC · 48 kHz' : '—']];

  return <ManagementPage title="방송하기" titleId="broadcast-title" titleRef={heading} actions={<>
    <StatusBadge tone={hasSignal ? 'live' : signal === 'error' || signal === 'reconnecting' ? 'warning' : 'neutral'}>{stateLabel}</StatusBadge>
    {!preview.chatOpen && <button ref={chatTrigger} type="button" className={ui.button} onClick={() => onChange({ ...preview, chatOpen: true })}><MessagesSquare size={17} aria-hidden="true" />채팅</button>}
    {hasSignal && <button type="button" className={ui.button} aria-haspopup="dialog" onClick={event => openModal('share', event.currentTarget)}><Link2 size={17} aria-hidden="true" />방송 링크</button>}
    <button type="button" className={ui.button} aria-haspopup="dialog" onClick={event => openModal('guide', event.currentTarget)}><CircleHelp size={17} aria-hidden="true" />OBS 연결 방법</button>
  </>}>
    <div className={`${styles.workspace} ${!preview.chatOpen ? styles.chatClosed : ''}`}>
      <div className={styles.main}>
        <section className={styles.card} aria-labelledby="broadcast-preview-title">
          <header className={styles.cardHeader}><h2 id="broadcast-preview-title">수신 미리보기</h2><div className={styles.previewActions}>
            <span>{hasSignal ? 'OBS 수신 영상' : '영상 없음'}</span>
            {watch && <button type="button" className="icon-button" aria-label={watch.playback.muted ? '수신 영상 소리 켜기' : '수신 영상 소리 끄기'} onClick={watch.playback.toggleMuted}>{watch.playback.muted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}</button>}
            {hasSignal && <button type="button" className="icon-button" aria-label="수신 미리보기 전체 화면" onClick={fullscreen}><Maximize2 size={18} aria-hidden="true" /></button>}
          </div></header>
          <div ref={canvas} className={`${styles.canvas} ${!hasSignal ? styles.canvasEmpty : ''}`}>
            {hasSignal ? <>{watch ? <video ref={watch.playback.attachVideo} playsInline autoPlay aria-label="OBS 수신 영상" /> : studio ? <div className={styles.waiting}><LoaderCircle className={styles.spinner} size={30} aria-hidden="true" /><strong>수신 영상을 여는 중이에요</strong></div> : <img src={workspace} alt="OBS 수신 영상" />}<span className={styles.liveMark}>LIVE</span></> : <div className={styles.waiting}>
              <span className={styles.waitingIcon} aria-hidden="true">{busy ? <LoaderCircle className={styles.spinner} size={32} /> : signal === 'error' ? <Unplug size={32} /> : signal === 'ended' ? <CircleCheck size={32} /> : <Radio size={32} />}</span>
              <strong>{previewTitle}</strong><p>{studio?.error || previewDescription}</p>
            </div>}
          </div>
          <div className={styles.signalBar} data-state={signal} role={signal === 'error' ? 'alert' : 'status'} aria-busy={busy}>
            {hasSignal ? <CircleCheck size={18} aria-hidden="true" /> : signal === 'error' || signal === 'reconnecting' ? <CircleAlert size={18} aria-hidden="true" /> : busy ? <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" /> : <Radio size={18} aria-hidden="true" />}
            <div><strong>{hasSignal ? '방송 신호를 정상적으로 받고 있어요' : stateLabel}</strong><p>{hasSignal ? '방송 종료는 OBS에서 진행해 주세요.' : 'OBS에서 송출을 시작하면 바로 방송돼요.'}</p></div>
          </div>
          <dl className={styles.metrics}>{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </section>

        <section className={`${styles.card} ${styles.contentCard}`} aria-label="방송 설정">
          <div ref={tabsRef} className={`${ui.tabs} ${styles.tabBar}`} role="tablist" aria-label="방송 관리 항목" onKeyDown={tabKey}>
            {tabs.map(item => <button type="button" role="tab" key={item.id} data-tab={item.id} id={`${id}-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`${id}-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => selectTab(item.id)}>{item.label}</button>)}
          </div>

          <section className={styles.panel} role="tabpanel" id={`${id}-panel-stream`} aria-labelledby={`${id}-tab-stream`} hidden={tab !== 'stream'} tabIndex={0}>
            <div className={styles.streamGrid}>
              <div className={styles.streamFields}>
                <div className={styles.sectionHeading}><h2>OBS 송출 연결</h2><span>사용자 지정 서비스</span></div>
                <label className={styles.readonlyField} htmlFor={`${id}-url`}>송출 서버 URL</label>
                <div className={styles.copyRow}><input ref={urlInput} id={`${id}-url`} name="ingestUrl" className={ui.control} readOnly value={serverUrl} placeholder="송출 정보를 불러오는 중" onFocus={event => event.currentTarget.select()} /><button className={ui.button} type="button" disabled={!serverUrl} aria-label="송출 주소 복사" onClick={() => copy('url')}>{copied === 'url' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}복사</button></div>
                <label className={styles.readonlyField} htmlFor={`${id}-key`}>스트림 키</label>
                <div className={styles.copyRow}><input ref={keyInput} id={`${id}-key`} name="streamKey" className={ui.control} readOnly type={showKey ? 'text' : 'password'} value={streamKey} autoComplete="off" onFocus={event => event.currentTarget.select()} />
                  <button className={`${ui.button} ${styles.revealButton}`} type="button" aria-label={showKey ? '스트림 키 숨기기' : '스트림 키 표시'} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}</button>
                  <button className={ui.button} type="button" disabled={!streamKey} aria-label="스트림 키 복사" onClick={() => copy('key')}>{copied === 'key' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}복사</button>
                </div>
                <div className={styles.keyActions}><p className={styles.help}>스트림 키는 방송할 권한이 있는 비밀번호예요.</p>{!studio && <button type="button" className={`${ui.button} ${ui.quiet}`} disabled={!canReissue} title={!canReissue ? 'OBS 송출을 중지한 뒤 재발급할 수 있어요.' : undefined} aria-haspopup="dialog" onClick={event => openModal('key', event.currentTarget)}><RotateCw size={15} aria-hidden="true" />키 재발급</button>}</div>
              </div>
              <aside className={styles.infoSummary} aria-labelledby="broadcast-info-summary-title">
                <div className={styles.sectionHeading}><h2 id="broadcast-info-summary-title">방송 정보</h2><button className={ui.button} type="button" aria-label="방송 정보 수정" aria-haspopup="dialog" onClick={event => openModal('info', event.currentTarget)}><Pencil size={15} aria-hidden="true" />수정</button></div>
                <h3>{preview.info.title}</h3><dl>{!studio && <div><dt>카테고리</dt><dd>{preview.info.category}</dd></div>}<div><dt>공개 설정</dt><dd>{studio ? '전체 공개' : preview.info.visibility}</dd></div></dl>
                <p className={styles.help}>화면·소리·장면·화질은 OBS에서 설정해 주세요.</p>
              </aside>
            </div>
          </section>

          <section className={styles.panel} role="tabpanel" id={`${id}-panel-info`} aria-labelledby={`${id}-tab-info`} hidden={tab !== 'info'} tabIndex={0}>
            <form noValidate className={styles.infoForm} onSubmit={saveInfo}>
              <div className={styles.sectionHeading}><h2>방송 정보</h2><span><b className={styles.required}>*</b> 필수 항목</span></div>
              <InfoFields info={preview.draft} disabled={saving} platformOnly={Boolean(studio)} onChange={draft => { onChange({ ...preview, draft }); setError(''); }} error={error} prefix={`${id}-inline`} titleRef={titleInput} />
              <footer className={styles.formFooter}><p>{dirty ? '저장하지 않은 변경사항이 있어요.' : ''}</p><div><button className={ui.button} type="button" disabled={!dirty || saving} onClick={() => { onChange({ ...preview, draft: { ...preview.info } }); setError(''); }}>취소</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={!dirty || saving}>{saving ? '저장 중' : '저장'}</button></div></footer>
            </form>
          </section>

          <section className={styles.panel} role="tabpanel" id={`${id}-panel-health`} aria-labelledby={`${id}-tab-health`} hidden={tab !== 'health'} tabIndex={0}>
            <div className={styles.sectionHeading}><h2>방송 수신 상태</h2><Activity size={18} aria-hidden="true" /></div>
            <dl className={styles.healthDetails}><div><dt>연결 상태</dt><dd><StatusBadge tone={hasSignal ? 'positive' : signal === 'error' ? 'danger' : 'neutral'}>{stateLabel}</StatusBadge></dd></div>
              {metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}<div><dt>비디오 코덱</dt><dd>{hasSignal ? 'H.264' : '—'}</dd></div>
            </dl>
          </section>
        </section>
      </div>
      {preview.chatOpen && <div className={styles.chat}><ChatPanel chat={watch?.chat ?? (studio ? { status: 'connecting', nickname: '', messages: [], pending: false, error: null, send: () => {}, setNickname: () => {} } : { status: 'connected', nickname: preview.nickname, messages: preview.messages, pending: queuedMessage !== null, error: null,
        send: text => { if (queuedMessage === null) setQueuedMessage(text); }, setNickname: nickname => onChange({ ...preview, nickname }) })} accountActions={chatAccount} participation={participation} onClose={() => { onChange({ ...preview, chatOpen: false }); requestAnimationFrame(() => chatTrigger.current?.focus()); }} /></div>}
    </div>
    <p className={styles.notice} role="status">{notice}</p>

    {modal && <Dialog key={modal} locked={saving} title={modal === 'guide' ? 'OBS 연결 방법' : modal === 'info' ? '방송 정보 수정' : modal === 'key' ? '스트림 키를 재발급할까요?' : '방송 링크'} dialogRef={dialog} onDismiss={dismiss}>
      {modal === 'guide' && <>
        <ol className={styles.guide}><li><span>1</span><div><strong>OBS에서 방송 설정 열기</strong><p>설정 → 방송에서 서비스를 ‘사용자 지정’으로 선택해 주세요.</p></div></li><li><span>2</span><div><strong>송출 주소와 스트림 키 붙여넣기</strong><p>이 화면의 송출 정보를 OBS의 서버와 스트림 키에 각각 넣어 주세요.</p></div></li><li><span>3</span><div><strong>OBS에서 방송 시작</strong><p>화면과 소리를 확인한 뒤 ‘방송 시작’을 눌러 주세요. 방송을 끝낼 때도 OBS에서 중지해 주세요.</p></div></li></ol>
        <div className={styles.recommendation}><strong>권장 송출 설정</strong><p>영상 H.264 · 오디오 AAC · 키프레임 간격 1초 · B프레임 0</p></div>
        <div className={ui.dialogActions}><a href="https://obsproject.com/" target="_blank" rel="noreferrer" className={ui.button}>OBS 다운로드</a><button data-initial-focus type="button" className={`${ui.button} ${ui.primary}`} onClick={dismiss}>확인</button></div>
      </>}
      {modal === 'info' && <form noValidate onSubmit={saveInfo}><InfoFields info={editInfo} disabled={saving} platformOnly={Boolean(studio)} onChange={value => { setEditInfo(value); setError(''); }} error={error} prefix={`${id}-modal`} titleRef={modalTitleInput} /><div className={ui.dialogActions}><button type="button" className={ui.button} disabled={saving} onClick={dismiss}>취소</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={!editDirty || saving}>{saving ? '저장 중' : '저장'}</button></div></form>}
      {designPreview && modal === 'key' && <><div className={styles.keyWarning}><KeyRound size={22} aria-hidden="true" /><p>새 키를 발급하면 OBS에도 다시 입력해야 해요.</p></div><div className={ui.dialogActions}><button data-initial-focus type="button" className={ui.button} onClick={dismiss}>취소</button><button type="button" className={`${ui.button} ${ui.primary}`} disabled={!canReissue} onClick={() => {
        if (!canReissue) return;
        onChange({ ...preview, streamKey: `obs-spring?user=obs-spring&pass=preview-only-${crypto.randomUUID()}` }); setShowKey(false); setCopied(null); dismiss(); setNotice('스트림 키를 재발급했어요.');
      }}>재발급</button></div></>}
      {modal === 'share' && <><p className={styles.shareTitle}>{preview.info.title}</p><label className={styles.readonlyField} htmlFor={`${id}-share`}>방송 링크</label><div className={styles.copyRow}><input ref={shareInput} id={`${id}-share`} className={ui.control} readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} /><button type="button" className={ui.button} onClick={() => copy('share')}>복사</button></div><p className={styles.notice} role="status">{notice}</p><div className={ui.dialogActions}><button data-initial-focus type="button" className={`${ui.button} ${ui.primary}`} onClick={dismiss}>닫기</button></div></>}
    </Dialog>}
  </ManagementPage>;
}
