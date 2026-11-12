import { BadgeCheck, ChevronRight, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { channelPath } from '../../preview/community-types';
import type { PreviewChannel, PreviewVideo } from '../../preview/community-types';
import type { BroadcastSummary } from '../../viewer-contract';
import { BroadcastCard } from '../live/LivePage';
import { MediaCard } from '../media/MediaPages';
import styles from './SearchPage.module.css';

const filters = [
  { id: 'all', label: '전체' },
  { id: 'live', label: '라이브' },
  { id: 'channel', label: '채널' },
  { id: 'vod', label: '다시보기' },
  { id: 'clip', label: '클립' },
] as const;

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
}

type Result = {
  channel: PreviewChannel;
} & (
  { kind: 'channel' } |
  { kind: 'live'; broadcast: BroadcastSummary } |
  { kind: 'vod' | 'clip'; video: PreviewVideo }
);

function resultCard(result: Result) {
  const { channel } = result;
  const href = channelPath(channel.handle);
  if (result.kind === 'live') return <BroadcastCard key={result.broadcast.id} broadcast={result.broadcast} channelHref={href} />;
  if (result.kind !== 'channel') return <MediaCard key={`${channel.handle}/${result.video.id}`} video={result.video} channel={channel} />;
  return (
    <Link key={channel.handle} to={href} className={styles.channel}>
      <span className={styles.avatar} aria-hidden="true">
        {Array.from(channel.displayName)[0]}
        {channel.avatarUrl && <img key={channel.avatarUrl} src={channel.avatarUrl} alt="" onError={event => { event.currentTarget.hidden = true; }} />}
      </span>
      <span className={styles.channelText}>
        <strong>{channel.displayName}{channel.verified && <BadgeCheck size={15} role="img" aria-label="인증된 채널" />}</strong>
        <small>@{channel.handle}</small>
      </span>
      <ChevronRight size={18} aria-hidden="true" />
    </Link>
  );
}

export function SearchPage({ channels }: { channels: readonly PreviewChannel[] }) {
  const [params] = useSearchParams();
  const query = (params.get('q') ?? '').trim().slice(0, 120);
  const term = normalize(query);
  const active = filters.find(item => item.id === params.get('type'))?.id ?? 'all';
  const matches = (...fields: (string | null)[]) => fields.some(field => field && normalize(field).includes(term));
  const results: Result[] = [];

  if (term) {
    for (const channel of channels) {
      const live = channel.liveBroadcast;
      if (matches(channel.displayName, channel.handle, live?.category ?? null)) results.push({ kind: 'channel', channel });
      if (live && matches(live.title, channel.displayName, channel.handle, live.category)) {
        results.push({ kind: 'live', channel, broadcast: live });
      }
      for (const video of channel.videos) {
        if (matches(video.title, channel.displayName, channel.handle)) results.push({ kind: video.kind, channel, video });
      }
    }
  }

  function filterPath(id: typeof active) {
    const next = new URLSearchParams({ q: query });
    if (id !== 'all') next.set('type', id);
    return `/search?${next}`;
  }

  const sections = filters.slice(1)
    .filter(item => active === 'all' || item.id === active)
    .map(item => ({ ...item, items: results.filter(result => result.kind === item.id) }))
    .filter(item => item.items.length > 0);

  return (
    <section className={styles.page} aria-labelledby="search-title">
      <h1 id="search-title">{query ? <>‘{query}’ 검색 결과</> : '검색 결과'}</h1>
      {term && <nav aria-label="검색 결과 유형" className={styles.filters}>
        {filters.map(({ id, label }) => <Link key={id} to={filterPath(id)} aria-current={id === active ? 'page' : undefined}>{label}</Link>)}
      </nav>}
      {sections.length ? sections.map(({ id, label, items }) => (
        <section className={styles.section} key={id} aria-labelledby={`search-${id}`}>
          <div className={styles.sectionHeading}>
            <h2 id={`search-${id}`}>{label} <span>{items.length}</span></h2>
            {active === 'all' && items.length > 4 && <Link to={filterPath(id)} aria-label={`${label} 모두 보기`}>모두 보기<ChevronRight size={16} aria-hidden="true" /></Link>}
          </div>
          <div className={id === 'channel' ? styles.channelGrid : styles.grid}>
            {(active === 'all' ? items.slice(0, 4) : items).map(resultCard)}
          </div>
        </section>
      )) : (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><Search size={25} aria-hidden="true" /></span>
          <h2>{term ? '검색 결과가 없어요' : '무엇을 찾고 계신가요?'}</h2>
          <p>{term ? '검색어나 콘텐츠 종류를 바꿔보세요.' : '위 검색창에서 방송, 채널 또는 영상 제목을 검색해 보세요.'}</p>
          {term && <Link to="/search" className={styles.clear}>검색어 지우기</Link>}
        </div>
      )}
    </section>
  );
}
