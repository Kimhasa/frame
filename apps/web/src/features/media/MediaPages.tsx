import { ArrowLeft, Check, ChevronDown, Clapperboard, Copy, Info, MessageSquare, Share2, Video, VideoOff, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { channelPath, mediaListPath, mediaWatchPath, type PreviewChannel, type PreviewVideo } from '../../preview/community-types';
import styles from './MediaPages.module.css';

type Kind = PreviewVideo['kind'];
type MediaEntry = { channel: PreviewChannel; video: PreviewVideo };
type MediaPageProps = { kind: Kind; channels: readonly PreviewChannel[] };

const labels = { vod: '다시보기', clip: '클립' };
const count = new Intl.NumberFormat('ko-KR');

function catalog(channels: readonly PreviewChannel[], kind: Kind): MediaEntry[] {
  return channels.flatMap(channel => channel.videos.filter(video => video.kind === kind).map(video => ({ channel, video })));
}

const minutesPerUnit = { 분: 1, 시간: 60, 일: 1440, 주: 10080 };

function ageInMinutes(label: string) {
  const [, amount, unit] = /^(\d+)(분|시간|일|주) 전$/.exec(label) ?? [];
  return unit ? Number(amount) * minutesPerUnit[unit as keyof typeof minutesPerUnit] : Number.MAX_SAFE_INTEGER;
}

function Avatar({ channel }: { channel: PreviewChannel }) {
  return <span className={styles.avatar} aria-hidden="true">
    {Array.from(channel.displayName)[0] ?? '?'}
    {channel.avatarUrl && <img src={channel.avatarUrl} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />}
  </span>;
}

export function MediaCard({ channel, video }: MediaEntry) {
  return <article className={styles.card}>
    <div className={styles.thumbnail}>
      <Video size={28} aria-hidden="true" />
      <img src={video.thumbnailUrl} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.hidden = true; }} />
      <span className={styles.duration}>{video.durationLabel}</span>
    </div>
    <div className={styles.cardDetails}>
      <Avatar channel={channel} />
      <div className={styles.cardCopy}>
        <Link className={styles.cardTitle} to={mediaWatchPath(video.kind, channel.handle, video.id)}>{video.title}</Link>
        <Link className={styles.channelLink} to={channelPath(channel.handle)}>{channel.displayName}</Link>
        <p className={styles.cardMeta}>조회수 {count.format(video.views)}회 · {video.publishedLabel}</p>
      </div>
    </div>
  </article>;
}

function MediaGrid({ entries }: { entries: readonly MediaEntry[] }) {
  return <ul className={styles.grid}>
    {entries.map(entry => <li key={`${entry.channel.handle}/${entry.video.id}`}><MediaCard {...entry} /></li>)}
  </ul>;
}

export function MediaListPage({ kind, channels }: MediaPageProps) {
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') === 'popular' ? 'popular' : 'recent';
  const entries = params.get('state') === 'empty' ? [] : catalog(channels, kind);
  entries.sort((first, second) => (
    (sort === 'popular' ? second.video.views - first.video.views : 0) ||
    ageInMinutes(first.video.publishedLabel) - ageInMinutes(second.video.publishedLabel)
  ));
  const Icon = kind === 'vod' ? Video : Clapperboard;

  return <section className={styles.page} aria-labelledby="media-list-title">
    <header className={styles.heading}>
      <h1 id="media-list-title">{labels[kind]}</h1>
      {entries.length > 1 && <label className={styles.sort}>
        <select aria-label={`${labels[kind]} 정렬`} value={sort} onChange={event => {
          const value = event.currentTarget.value;
          setParams(previous => {
            const next = new URLSearchParams(previous);
            if (value === 'popular') next.set('sort', value);
            else next.delete('sort');
            return next;
          }, { replace: true, preventScrollReset: true });
        }}>
          <option value="recent">최신순</option>
          <option value="popular">인기순</option>
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </label>}
    </header>
    {entries.length > 0 ? <MediaGrid entries={entries} /> : <div className={styles.empty}>
      <span className={styles.emptyIcon}><Icon size={23} aria-hidden="true" /></span>
      <h2>{kind === 'vod' ? '아직 다시보기가 없어요' : '아직 클립이 없어요'}</h2>
      <Link className={styles.button} to="/live">라이브 둘러보기</Link>
    </div>}
  </section>;
}

export function MediaWatchPage({ kind, channels }: MediaPageProps) {
  const { handle, id } = useParams();
  const [params] = useSearchParams();
  const entries = catalog(channels, kind);
  const entry = entries.find(({ channel, video }) => channel.handle === handle && video.id === id);
  const deleted = params.get('state') === 'deleted';
  if (deleted || !entry) {
    return <section className={styles.page}>
      <div className={styles.empty}>
        <span className={styles.emptyIcon}><VideoOff size={23} aria-hidden="true" /></span>
        <h1>{deleted ? '삭제된 영상이에요' : '영상을 찾을 수 없어요'}</h1>
        <p>다른 {labels[kind]} 영상을 둘러보세요.</p>
        <Link className={styles.button} to={mediaListPath(kind)}>{labels[kind]} 목록</Link>
      </div>
    </section>;
  }
  const related = entries.filter(item => item !== entry).sort((first, second) => (
    Number(second.channel === entry.channel) - Number(first.channel === entry.channel) ||
    ageInMinutes(first.video.publishedLabel) - ageInMinutes(second.video.publishedLabel)
  )).slice(0, 4);
  return <MediaDetails key={`${kind}/${handle}/${id}`} {...entry} related={related} failed={params.get('state') === 'error'} />;
}

const archivedChat = [
  ['모아', '안녕하세요. 오늘도 같이 봐요.'],
  ['초록', '이 부분 다시 보니까 이해됐어요.'],
  ['파도', '다음 방송도 기다릴게요!'],
];

function MediaDetails({ channel, video, related, failed }: MediaEntry & { related: readonly MediaEntry[]; failed: boolean }) {
  const [chatOpen, setChatOpen] = useState(true);
  const [dialogType, setDialogType] = useState<'info' | 'share' | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [params, setParams] = useSearchParams();
  const dialog = useRef<HTMLDialogElement>(null);
  const shareInput = useRef<HTMLInputElement>(null);
  const chatToggle = useRef<HTMLButtonElement>(null);
  const dialogHeading = useId();
  const chatId = useId();
  const shareUrl = window.location.origin + window.location.pathname;
  const label = labels[video.kind];

  useEffect(() => {
    if (dialogType && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [dialogType]);

  function openDialog(type: 'info' | 'share') {
    setDialogType(type);
    setCopyStatus('idle');
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyStatus('copied');
    } catch {
      shareInput.current?.focus();
      shareInput.current?.select();
      setCopyStatus('error');
    }
  }

  function retry() {
    const next = new URLSearchParams(params);
    next.delete('state');
    setParams(next, { replace: true });
  }

  return <section className={`${styles.page} ${styles.watchPage}`} aria-labelledby="media-watch-title">
    <header className={styles.watchToolbar}>
      <Link className={styles.back} to={mediaListPath(video.kind)}><ArrowLeft size={18} aria-hidden="true" />{label} 목록</Link>
      <div className={styles.actions}>
        <button className={styles.button} type="button" onClick={() => openDialog('info')}><Info size={17} aria-hidden="true" />영상 정보</button>
        <button className={styles.button} type="button" onClick={() => openDialog('share')}><Share2 size={17} aria-hidden="true" />공유</button>
        <button className={styles.button} type="button" ref={chatToggle} aria-expanded={chatOpen} aria-controls={chatId} onClick={() => setChatOpen(open => !open)}>
          <MessageSquare size={17} aria-hidden="true" />채팅
        </button>
      </div>
    </header>
    <div className={`${styles.watchLayout} ${chatOpen ? styles.chatOpen : ''}`}>
      <div className={styles.watchMain}>
        <div className={styles.player}>
          {failed ? <div className={styles.playerError} role="alert">
            <VideoOff size={27} aria-hidden="true" />
            <strong>영상을 재생할 수 없어요</strong>
            <button className={styles.button} type="button" onClick={retry}>다시 시도</button>
          </div> : <>
            <img src={video.thumbnailUrl} alt="" onError={event => { event.currentTarget.hidden = true; }} />
            <div className={styles.previewNotice}>
              <Video size={17} aria-hidden="true" />
              <span>{label}</span>
            </div>
          </>}
        </div>
        <div className={styles.watchDetails}>
          <span className={styles.kind}>{label}</span>
          <h1 id="media-watch-title">{video.title}</h1>
          <Link to={channelPath(channel.handle)} className={styles.watchChannel}><Avatar channel={channel} />{channel.displayName}</Link>
          <p>조회수 {count.format(video.views)}회 · {video.publishedLabel} · {video.durationLabel}</p>
        </div>
      </div>
      <aside id={chatId} className={styles.chat} aria-label="지난 채팅" hidden={!chatOpen}>
        <header className={styles.chatHeader}>
          <h2>지난 채팅</h2>
          <button type="button" className="icon-button" aria-label="지난 채팅 닫기" onClick={() => {
            setChatOpen(false);
            chatToggle.current?.focus();
          }}><X size={18} aria-hidden="true" /></button>
        </header>
        <p className={styles.chatNote}>방송 중 남겨진 채팅이에요.</p>
        <ul>{archivedChat.map(([author, message]) => <li key={author}><strong>{author}</strong> {message}</li>)}</ul>
      </aside>
    </div>
    {related.length > 0 && <section className={styles.related} aria-label={`${label} 더 보기`}>
      <h2>{label} 더 보기</h2>
      <MediaGrid entries={related} />
    </section>}
    {dialogType && <dialog ref={dialog} className={styles.dialog} aria-labelledby={dialogHeading} onClose={() => setDialogType(null)}>
      <header className={styles.chatHeader}>
        <h2 id={dialogHeading}>{dialogType === 'info' ? '영상 정보' : `${label} 공유`}</h2>
        <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={19} aria-hidden="true" /></button>
      </header>
      {dialogType === 'info' ? <dl className={styles.infoList}>
        <div><dt>제목</dt><dd>{video.title}</dd></div>
        <div><dt>채널</dt><dd><Link className={styles.channelLink} to={channelPath(channel.handle)}>{channel.displayName}</Link></dd></div>
        <div><dt>영상 길이</dt><dd>{video.durationLabel}</dd></div>
        <div><dt>조회수</dt><dd>{count.format(video.views)}회</dd></div>
        <div><dt>공개</dt><dd>{video.publishedLabel}</dd></div>
      </dl> : <div className={styles.share}>
        <label htmlFor={`${dialogHeading}-link`}>영상 링크</label>
        <div>
          <input ref={shareInput} id={`${dialogHeading}-link`} readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />
          <button type="button" className={`${styles.button} ${styles.copy}`} onClick={() => void copyLink()}>
            {copyStatus === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copyStatus === 'copied' ? '복사됨' : '복사'}
          </button>
        </div>
        <p role="status">{copyStatus === 'copied' ? '링크를 복사했어요.' : copyStatus === 'error' ? '링크를 선택했어요. 직접 복사해 주세요.' : ''}</p>
      </div>}
    </dialog>}
  </section>;
}
