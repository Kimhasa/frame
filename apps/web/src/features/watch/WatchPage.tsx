import {
  ArrowLeft, Check, Copy, Info, LoaderCircle, Maximize, MessageSquare, Minimize,
  PanelTop, Pause, PictureInPicture2, Play, Settings, Share2, Volume2, VolumeX, X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ChatPanel } from '../chat/ChatPanel';
import type { ChatAccountActions, PlaybackView, WatchState, WatchView } from '../../viewer-contract';
import styles from './WatchPage.module.css';

const frameRateFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

function timecode(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, '0');
  if (minutes < 60) return `${minutes}:${tail}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}`;
}

function Dialog({ title, children, onDismiss }: { title: string; children: ReactNode; onDismiss: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={heading} onCancel={event => { event.preventDefault(); onDismiss(); }}>
      <header className={styles.dialogHeader}>
        <h2 id={heading}>{title}</h2>
        <button type="button" className="icon-button" aria-label="닫기" onClick={onDismiss}><X size={20} /></button>
      </header>
      {children}
    </dialog>
  );
}

const overlays = {
  loading: { title: '방송을 불러오는 중이에요', body: '', spinner: true },
  waiting: { title: '방송 신호를 기다리고 있어요', body: '신호가 돌아오면 재생을 시작해요.', spinner: true },
  reconnecting: { title: '방송에 다시 연결하는 중이에요', body: '잠시만 기다려 주세요.', spinner: true },
  busy: { title: '접속자가 많아요', body: '잠시 후 다시 연결해 주세요.', spinner: false },
  ended: { title: '방송이 종료됐어요', body: '', spinner: false },
  unavailable: { title: '이 방송은 지금 볼 수 없어요', body: '방송 주소를 확인해 주세요.', spinner: false },
  error: { title: '방송을 재생할 수 없어요', body: '연결을 확인하고 다시 시도해 주세요.', spinner: false },
};

function RetryAction({ state, onRetry }: { state: WatchState; onRetry: () => void }) {
  const delay = state.kind === 'busy' ? state.retryAfterMs ?? 0 : 0;
  const cooldown = delay > 0 ? state : null;
  const [expired, setExpired] = useState<WatchState | null>(null);

  useEffect(() => {
    if (!cooldown) return;
    // A later busy response can ask for the same wait, so expire only this snapshot.
    const timer = window.setTimeout(() => setExpired(cooldown), delay);
    return () => window.clearTimeout(timer);
  }, [cooldown, delay]);

  return <button className={styles.overlayAction} type="button" disabled={cooldown !== null && expired !== cooldown} onClick={onRetry}>다시 시도</button>;
}

function Timeline({ timeline, onSeek }: { timeline: NonNullable<PlaybackView['timeline']>; onSeek: PlaybackView['seek'] }) {
  const [draft, setDraft] = useState<number | null>(null);
  const pointerActive = useRef(false);
  const min = timeline.seekStartMs ?? 0;
  const max = Math.max(timeline.liveMs, min + 1000);
  const position = Math.min(max, Math.max(min, draft ?? timeline.positionMs));
  const percent = (position - min) / (max - min) * 100;
  return (
    <div className={styles.timeline}>
      <input
        type="range" min={min} max={max} step={1000} value={position} disabled={timeline.seekStartMs === null}
        aria-label="재생 위치" aria-valuetext={`${timecode(position)} / ${timecode(timeline.liveMs)}`}
        style={{ background: `linear-gradient(to right, var(--frame-green-video) ${percent}%, #ffffff55 ${percent}%)` }}
        onPointerDown={() => { pointerActive.current = true; }}
        onPointerUp={event => {
          if (pointerActive.current) onSeek(event.currentTarget.valueAsNumber);
          pointerActive.current = false;
          setDraft(null);
        }}
        onPointerCancel={() => { pointerActive.current = false; setDraft(null); }}
        onBlur={() => { pointerActive.current = false; setDraft(null); }}
        onChange={event => {
          const next = event.currentTarget.valueAsNumber;
          if (pointerActive.current) setDraft(next);
          else onSeek(next);
        }}
      />
      <span>{timecode(position)}<span className={styles.duration}> / {timecode(timeline.liveMs)}</span></span>
    </div>
  );
}

function Player({ view, theater, onTheater, onPlaybackProgress }: { view: WatchView; theater: boolean; onTheater: () => void; onPlaybackProgress?: (video: HTMLVideoElement) => void }) {
  const { state, playback, retry } = view;
  const playerRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const controlsTimer = useRef<number | undefined>(undefined);
  const ready = state.kind === 'ready';
  const playing = playback.status === 'playing';
  const blocked = ready && playback.status === 'blocked';
  const overlay = state.kind === 'ready' ? null : overlays[state.kind];
  const [controlError, setControlError] = useState('');
  const qualityId = useId();

  useEffect(() => {
    function syncFullscreen() { setFull(document.fullscreenElement === playerRef.current); }
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);
  useEffect(() => {
    if (playing) controlsTimer.current = window.setTimeout(() => setControlsVisible(false), 2800);
    return () => window.clearTimeout(controlsTimer.current);
  }, [playing]);
  function revealControls() {
    setControlsVisible(true);
    window.clearTimeout(controlsTimer.current);
    if (playing) controlsTimer.current = window.setTimeout(() => setControlsVisible(false), 2800);
  }

  function closeQuality() {
    setQualityOpen(false);
    settingsRef.current?.focus();
  }

  async function fullscreen() {
    const element = playerRef.current;
    if (!element) return;
    setControlError('');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (element.requestFullscreen) await element.requestFullscreen();
      else {
        const video = element.querySelector('video') as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
        if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else setControlError('이 브라우저에서는 전체 화면을 사용할 수 없어요.');
      }
    } catch { setControlError('전체 화면을 열 수 없어요.'); }
  }

  async function pictureInPicture() {
    const video = playerRef.current?.querySelector('video');
    if (!video) return;
    setControlError('');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { setControlError('이 영상은 PIP 모드로 열 수 없어요.'); }
  }

  return (
    <div
      ref={playerRef} className={styles.player} data-testid="watch-player" data-controls={controlsVisible || !playing || qualityOpen ? 'visible' : 'hidden'}
      onPointerMove={revealControls} onPointerDown={revealControls}
      onKeyDown={event => { if (event.key === 'Escape' && qualityOpen) closeQuality(); }}
    >
      <video
        ref={playback.attachVideo} data-testid="watch-video"
        onTimeUpdate={event => onPlaybackProgress?.(event.currentTarget)}
        onSeeking={event => onPlaybackProgress?.(event.currentTarget)}
        poster={state.broadcast?.thumbnailUrl ?? undefined}
        className={styles.video} playsInline aria-label="방송 영상"
        onLoadedData={() => setVideoLoaded(true)} onEmptied={() => setVideoLoaded(false)}
      />
      <Link className={styles.mobileBack} to="/live" aria-label="라이브 목록으로"><ArrowLeft size={20} /></Link>
      {overlay && (
        <div className={styles.overlay} role="status">
          {overlay.spinner && <LoaderCircle className={styles.spinner} size={28} aria-hidden="true" />}
          <strong>{overlay.title}</strong>
          {(state.message || overlay.body) && <p>{state.message || overlay.body}</p>}
          {(state.kind === 'error' || state.kind === 'busy') && <RetryAction state={state} onRetry={retry} />}
          {(state.kind === 'ended' || state.kind === 'unavailable') && <Link className={styles.overlayAction} to="/live">라이브 목록</Link>}
        </div>
      )}
      {blocked && <div className={styles.overlay}><button type="button" className={styles.overlayAction} onClick={playback.togglePlaying}><Volume2 size={18} /> 소리 켜기</button></div>}
      <div className={styles.notices}>
        <div className={styles.notice} role="status">{ready ? state.message : null}</div>
        {controlError && <div className={styles.notice} role="status">{controlError}</div>}
      </div>
      {ready && !blocked && (
        <div className={styles.controls} data-testid="watch-controls">
          {playback.timeline && <Timeline timeline={playback.timeline} onSeek={playback.seek} />}
          <div className={styles.controlRow}>
            <div className={styles.controlsLeft}>
              <button type="button" className={styles.playerButton} onClick={playback.togglePlaying} aria-label={playing ? '일시정지' : '재생'} title={playing ? '일시정지' : '재생'}>
                {playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}
              </button>
              <div className={styles.audio}>
                <button type="button" className={styles.playerButton} onClick={playback.toggleMuted} aria-label={playback.muted ? '음소거 해제' : '음소거'} title={playback.muted ? '음소거 해제' : '음소거'}>
                  {playback.muted ? <VolumeX size={21} /> : <Volume2 size={21} />}
                </button>
                {playback.canSetVolume && <input type="range" min={0} max={1} step={.01} value={playback.muted ? 0 : playback.volume} aria-label="음량" onChange={event => playback.setVolume(event.currentTarget.valueAsNumber)} />}
              </div>
              {playback.mode === 'history'
                ? <button type="button" className={styles.liveButton} onClick={playback.goLive}><span />실시간 복귀</button>
                : <span className={styles.liveLabel}><span />LIVE</span>}
            </div>
            <div className={styles.controlsRight}>
              {playback.qualities.length > 0 && (
                <div className={styles.quality}>
                  <button ref={settingsRef} type="button" className={styles.playerButton} title="화질" aria-label="화질" aria-expanded={qualityOpen} aria-controls={qualityId} onClick={() => setQualityOpen(!qualityOpen)}>
                    <Settings size={21} />
                  </button>
                  {qualityOpen && (
                    <div className={styles.qualityMenu} id={qualityId} role="group" aria-label="화질 선택">
                      <p aria-hidden="true">화질</p>
                      {playback.qualities.map(option => (
                        <label key={option.id}>
                          <input type="radio" name={qualityId} value={option.id} checked={playback.quality === option.id}
                            onChange={() => { playback.setQuality(option.id); closeQuality(); }} />
                          <span>{option.label}{option.id === 'auto' && playback.activeQualityLabel ? <small>{playback.activeQualityLabel}</small> : null}</span>
                          {playback.quality === option.id && <Check size={17} aria-hidden="true" />}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {document.pictureInPictureEnabled && <button type="button" className={`${styles.playerButton} ${styles.desktopControl}`} disabled={!videoLoaded} onClick={() => void pictureInPicture()} aria-label="PIP 모드" title="PIP 모드"><PictureInPicture2 size={21} /></button>}
              <button type="button" className={`${styles.playerButton} ${styles.desktopControl}`} aria-pressed={theater} onClick={onTheater} aria-label="확대 보기" title="확대 보기"><PanelTop size={21} /></button>
              <button type="button" className={styles.playerButton} onClick={() => void fullscreen()} aria-label={full ? '전체 화면 닫기' : '전체 화면'} title={full ? '전체 화면 닫기' : '전체 화면'}>
                {full ? <Minimize size={21} /> : <Maximize size={21} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function WatchPage({ view, theater, onTheater, channelHref, actions, onPlaybackProgress, chatAccount, participation }: {
  view: WatchView;
  theater: boolean;
  onTheater: () => void;
  channelHref?: string;
  actions?: ReactNode;
  onPlaybackProgress?: (video: HTMLVideoElement) => void;
  chatAccount?: ChatAccountActions;
  participation?: ReactNode;
}) {
  const { state, chat } = view;
  const broadcast = state.broadcast;
  const sourceVideo = broadcast?.sourceVideo;
  const [chatOpen, setChatOpen] = useState(true);
  const [modal, setModal] = useState<'info' | 'share' | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const shareInput = useRef<HTMLInputElement>(null);
  const chatButton = useRef<HTMLButtonElement>(null);
  const chatRegion = useId();
  const shareUrl = window.location.origin + window.location.pathname;

  useEffect(() => {
    document.title = broadcast ? `${broadcast.title} · FRAME` : '방송 시청 · FRAME';
    return () => { document.title = 'FRAME · 라이브'; };
  }, [broadcast?.title]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
      shareInput.current?.select();
    }
  }

  return (
    <section className={styles.watch} aria-label={broadcast?.title ?? '방송 시청'}>
      <div className={styles.tools}>
        <div className={styles.watchHeading}>
          <Link to="/live" className={styles.back} title="라이브 목록으로" aria-label="라이브 목록으로"><ArrowLeft size={18} /></Link>
          {broadcast && <h1 title={broadcast.title}>{broadcast.title}</h1>}
        </div>
        <div className={styles.actions}>
          {state.kind === 'ready' && actions}
          <button type="button" disabled={!broadcast} onClick={() => setModal('info')}><Info size={18} />방송 정보</button>
          <button type="button" disabled={!broadcast} onClick={() => { setCopyStatus('idle'); setModal('share'); }}><Share2 size={18} />공유</button>
          <button ref={chatButton} type="button" className={styles.chatToggle} aria-controls={chatRegion} aria-expanded={chatOpen} onClick={() => setChatOpen(!chatOpen)}>
            <MessageSquare size={18} />채팅
          </button>
        </div>
      </div>
      <div className={`${styles.layout} ${chatOpen ? '' : styles.chatHidden}`}>
        <Player view={view} theater={theater} onTheater={onTheater} onPlaybackProgress={onPlaybackProgress} />
        <div className={styles.chat} id={chatRegion} hidden={!chatOpen}>
          <ChatPanel chat={chat} accountActions={chatAccount} participation={participation} onClose={() => { setChatOpen(false); chatButton.current?.focus(); }} />
        </div>
      </div>
      {modal === 'info' && broadcast && (
        <Dialog title="방송 정보" onDismiss={() => setModal(null)}>
          <dl className={styles.infoList}>
            <div><dt>방송 제목</dt><dd>{broadcast.title}</dd></div>
            <div>
              <dt>방송자</dt>
              <dd>{channelHref ? <Link to={channelHref} className={styles.channelLink}>{broadcast.publisher} 채널</Link> : broadcast.publisher}</dd>
            </div>
            {broadcast.category && <div><dt>카테고리</dt><dd>{broadcast.category}</dd></div>}
            {broadcast.viewerCount !== null && <div><dt>시청자 수</dt><dd>{broadcast.viewerCount.toLocaleString('ko-KR')}명</dd></div>}
            {sourceVideo && <div>
              <dt>원본 영상</dt>
              <dd>{sourceVideo.width} × {sourceVideo.height}{sourceVideo.fps !== undefined && ` · ${frameRateFormat.format(sourceVideo.fps)} FPS`}</dd>
            </div>}
            {broadcast.startedAtMs > 0 && <div><dt>시작 시간</dt><dd>{new Date(broadcast.startedAtMs).toLocaleString('ko-KR')}</dd></div>}
          </dl>
        </Dialog>
      )}
      {modal === 'share' && (
        <Dialog title="방송 공유" onDismiss={() => setModal(null)}>
          <div className={styles.share}>
            <label htmlFor="share-address">방송 링크</label>
            <div><input ref={shareInput} id="share-address" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />
              <button className={styles.copy} type="button" onClick={() => void copyLink()}>{copyStatus === 'copied' ? <Check size={16} /> : <Copy size={16} />}{copyStatus === 'copied' ? '복사됨' : '복사'}</button>
            </div>
            <p role="status">{copyStatus === 'error' ? '링크를 선택했어요. 직접 복사해 주세요.' : copyStatus === 'copied' ? '링크를 복사했어요.' : ''}</p>
          </div>
        </Dialog>
      )}
    </section>
  );
}
