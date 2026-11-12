import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type BroadcastKey, type BroadcastSummary, type LiveState, watchPath } from '../../viewer-contract';
import styles from './LivePage.module.css';

interface LivePageProps {
  state: LiveState;
  onRetry: () => void;
  query: string;
  channelHrefFor?: (broadcast: BroadcastKey) => string | undefined;
}

const iconPaths = {
  live: 'M5.6 5.6a9 9 0 0 0 0 12.8m12.8-12.8a9 9 0 0 1 0 12.8M8.4 8.4a5 5 0 0 0 0 7.2m7.2-7.2a5 5 0 0 1 0 7.2M12 10v4',
  search: 'm20 20-4.3-4.3M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0',
  refresh: 'M20 10a8 8 0 0 0-13.7-4L3 9m0-6v6h6M4 14a8 8 0 0 0 13.7 4L21 15m0 6v-6h-6',
  alert: 'M12 8v5m0 4h.01M10.3 4.9 3 17.5a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.9a2 2 0 0 0-3.4 0Z',
  chevron: 'm6 9 6 6 6-6',
  play: 'm9 5 11 7-11 7V5Z',
};

const viewerCountFormat = new Intl.NumberFormat('ko-KR');
const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
const relayThumbnail = /^\/thumbnails\/[0-9a-f]{32}\.jpg$/;
const thumbnailRetryDelays = [2000, 4000, 8000];

function Icon({ name }: { name: keyof typeof iconPaths }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={iconPaths[name]} />
    </svg>
  );
}

function CardImage({ src, lazy, retry = false }: { src: string; lazy?: boolean; retry?: boolean }) {
  const [{ attempt, broken }, setLoad] = useState({ attempt: 0, broken: false });
  const retryDelay = retry ? thumbnailRetryDelays[attempt] : undefined;

  useEffect(() => {
    if (!broken || retryDelay === undefined) return;
    const timer = window.setTimeout(() => setLoad({ attempt: attempt + 1, broken: false }), retryDelay);
    return () => window.clearTimeout(timer);
  }, [attempt, broken, retryDelay]);

  // Relay thumbnails can arrive after their broadcast appears in the list.
  const imageSrc = attempt > 0 ? `${src}?retry=${attempt}` : src;
  return broken ? null : (
    <img alt="" src={imageSrc} loading={lazy ? 'lazy' : 'eager'} decoding="async" onError={() => setLoad({ attempt, broken: true })} />
  );
}

export function BroadcastCard({ broadcast, channelHref }: { broadcast: BroadcastSummary; channelHref?: string }) {
  const { title, publisher, thumbnailUrl, avatarUrl, viewerCount } = broadcast;

  return (
    <article className={styles.card}>
        <div className={styles.thumbnail}>
          <span className={styles.thumbnailPlaceholder}><Icon name="live" /></span>
          {thumbnailUrl && <CardImage key={thumbnailUrl} src={thumbnailUrl} lazy retry={relayThumbnail.test(thumbnailUrl)} />}
          <span className={styles.play}><Icon name="play" /></span>
          <span className={styles.liveBadge}>LIVE</span>
          {viewerCount !== null && <span className={styles.viewers}>{viewerCountFormat.format(viewerCount)}명 시청</span>}
        </div>
        <div className={styles.cardDetails}>
          <span className={styles.avatar} aria-hidden="true">
            {Array.from(publisher)[0] ?? '?'}
            {avatarUrl && <CardImage key={avatarUrl} src={avatarUrl} />}
          </span>
          <div className={styles.cardText}>
            <h2 title={title}>
              <Link to={watchPath(broadcast)} className={styles.watchLink} aria-label={`${title}, ${publisher} 방송 시청하기`}>{title}</Link>
            </h2>
            <p title={publisher}>
              {channelHref ? <Link to={channelHref} className={styles.channelLink} aria-label={`${publisher} 채널 보기`}>{publisher}</Link> : publisher}
            </p>
          </div>
        </div>
    </article>
  );
}

interface NoticeProps {
  icon: 'live' | 'search' | 'alert';
  title: string;
  detail?: string;
  action?: { label: string; run: () => void; refresh?: boolean };
}

function Notice({ icon, title, detail, action }: NoticeProps) {
  return (
    <div className={styles.notice}>
      <div role={icon === 'alert' ? 'alert' : 'status'}>
        <div className={`${styles.noticeIcon} ${icon === 'alert' ? styles.warning : ''}`}><Icon name={icon} /></div>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {action && (
        <button type="button" className={styles.action} onClick={action.run}>
          {action.refresh && <Icon name="refresh" />}
          {action.label}
        </button>
      )}
    </div>
  );
}

export function LivePage({ state, onRetry, query, channelHrefFor }: LivePageProps) {
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<'newest' | 'viewers'>('newest');
  const items = state.kind === 'ready' ? state.items : [];
  const categories = [...new Set(items.flatMap((broadcast) => broadcast.category ? [broadcast.category] : []))];
  const activeCategory = category !== null && categories.includes(category) ? category : null;
  const hasViewerCounts = items.some((broadcast) => broadcast.viewerCount !== null);
  const activeSort = hasViewerCounts ? sort : 'newest';
  const term = normalizeSearch(query);
  const visibleItems = items.filter((broadcast) => (
    (activeCategory === null || broadcast.category === activeCategory) &&
    (!term || [broadcast.title, broadcast.publisher, broadcast.category ?? ''].some((value) => normalizeSearch(value).includes(term)))
  ));
  visibleItems.sort((first, second) => (
    (activeSort === 'viewers' ? (second.viewerCount ?? -1) - (first.viewerCount ?? -1) : 0) ||
    second.startedAtMs - first.startedAtMs || first.id.localeCompare(second.id)
  ));

  return (
    <section className={styles.page} aria-labelledby="live-title">
      {categories.length > 0 && (
        <div className={styles.categories} role="group" aria-label="방송 카테고리">
          <button type="button" aria-pressed={activeCategory === null} onClick={() => setCategory(null)}>전체</button>
          {categories.map((value) => (
            <button key={value} type="button" aria-pressed={activeCategory === value} onClick={() => setCategory(value)}>{value}</button>
          ))}
        </div>
      )}
      <div className={styles.heading}>
        <h1 id="live-title">지금 라이브</h1>
        {hasViewerCounts && (
          <label className={styles.sort}>
            <select aria-label="방송 정렬" value={activeSort} onChange={(event) => setSort(event.currentTarget.value === 'viewers' ? 'viewers' : 'newest')}>
              <option value="newest">최신순</option>
              <option value="viewers">시청자순</option>
            </select>
            <Icon name="chevron" />
          </label>
        )}
      </div>
      {state.kind === 'loading' && (
        <div role="status" aria-label="방송 목록을 불러오는 중">
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <div className={styles.skeletonCard} key={index}>
                <div className={styles.skeletonThumbnail} />
                <div className={styles.skeletonDetails}><span /><span /></div>
              </div>
            ))}
          </div>
        </div>
      )}
      {state.kind === 'error' && (
        <Notice icon="alert" title="방송 목록을 불러오지 못했어요" detail={state.message} action={{ label: '다시 시도', run: onRetry, refresh: true }} />
      )}
      {(state.kind === 'empty' || (state.kind === 'ready' && items.length === 0)) && (
        <Notice icon="live" title="지금 방송 중인 채널이 없어요" detail="잠시 후 다시 확인해 보세요." action={{ label: '새로고침', run: onRetry, refresh: true }} />
      )}
      {state.kind === 'ready' && state.stale && (
        <div className={styles.stale}>
          <p role="status"><Icon name="alert" /> 마지막으로 불러온 방송을 표시하고 있어요.</p>
          <button type="button" className={styles.action} onClick={onRetry}><Icon name="refresh" />다시 시도</button>
        </div>
      )}
      {state.kind === 'ready' && items.length > 0 && (visibleItems.length > 0 ? (
        <div className={styles.grid}>
          {visibleItems.map((broadcast) => <BroadcastCard key={broadcast.id} broadcast={broadcast} channelHref={channelHrefFor?.(broadcast)} />)}
        </div>
      ) : (
        <Notice
          icon={term ? 'search' : 'live'}
          title={term ? '검색 결과가 없어요' : '이 카테고리에는 방송이 없어요'}
          detail={term ? '다른 방송 제목이나 채널 이름으로 검색해 보세요.' : undefined}
          action={activeCategory === null ? undefined : { label: '전체 방송 보기', run: () => setCategory(null) }}
        />
      ))}
    </section>
  );
}
