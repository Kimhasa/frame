import { ChevronDown, ChevronRight, Heart, Radio, RefreshCw, Search, UserRound, X } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { channelPath, type PreviewChannel } from '../../preview/community-types';
import { BroadcastCard } from '../live/LivePage';
import liveStyles from '../live/LivePage.module.css';
import styles from './FollowingPage.module.css';

interface FollowingPageProps {
  channels: readonly PreviewChannel[];
  state: 'ready' | 'loading' | 'error' | 'login';
  onRetry: () => void;
  onPreviewSignIn: () => void;
}

const tabs = [
  { id: 'live', label: '방송 중' },
  { id: 'channels', label: '전체 채널' },
] as const;

type Tab = typeof tabs[number]['id'];

const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });
const formatCount = new Intl.NumberFormat('ko-KR');
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '');

function AvatarImage({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  return broken ? null : <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
}

function ChannelCard({ channel }: { channel: PreviewChannel }) {
  const { handle, displayName, avatarUrl, liveBroadcast } = channel;
  const viewerCount = liveBroadcast?.viewerCount ?? null;

  return (
    <Link to={channelPath(handle)} className={styles.channel}>
      <span className={`${liveStyles.avatar} ${styles.channelAvatar}`} aria-hidden="true">
        {Array.from(displayName)[0] ?? '?'}
        {avatarUrl && <AvatarImage key={avatarUrl} src={avatarUrl} />}
      </span>
      <span className={styles.channelCopy}>
        <strong title={displayName}>{displayName}</strong>
        <small>
          {liveBroadcast ? <span className={styles.liveMark}>방송 중</span> : <span>오프라인</span>}
          {viewerCount !== null && <span>{formatCount.format(viewerCount)}명 시청</span>}
        </small>
      </span>
      <ChevronRight aria-hidden="true" />
    </Link>
  );
}

function Notice({ Icon, title, alert, children }: {
  Icon: typeof Heart;
  title: string;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.notice}>
      <span className={styles.noticeIcon}><Icon size={23} strokeWidth={1.7} aria-hidden="true" /></span>
      <div role={alert ? 'alert' : undefined}><h2>{title}</h2></div>
      <div className={styles.noticeActions}>{children}</div>
    </div>
  );
}

function Loading({ tab }: { tab: Tab }) {
  return (
    <div className={tab === 'live' ? liveStyles.grid : styles.channelGrid} aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => tab === 'live' ? (
        <div className={liveStyles.skeletonCard} key={index}>
          <div className={liveStyles.skeletonThumbnail} />
          <div className={liveStyles.skeletonDetails}><span /><span /></div>
        </div>
      ) : (
        <div className={styles.channel} key={index}>
          <span className={styles.skeletonAvatar} />
          <span className={styles.channelCopy}><span className={styles.skeletonLine} /><span className={styles.skeletonLine} /></span>
        </div>
      ))}
    </div>
  );
}

export function FollowingPage({ channels, state, onRetry, onPreviewSignIn }: FollowingPageProps) {
  const [params, setParams] = useSearchParams();
  const [draftQuery, setDraftQuery] = useState<string | null>(null);
  const composing = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const liveTabRef = useRef<HTMLButtonElement>(null);
  const channelsTabRef = useRef<HTMLButtonElement>(null);
  const tab = params.get('tab') === 'channels' ? 'channels' : 'live';
  const query = (params.get('q') ?? '').slice(0, 120);
  const term = normalize(query);
  const sortParam = tab === 'live' ? 'liveSort' : 'channelSort';
  const sortValue = params.get(sortParam);
  const sort = tab === 'live' ? (sortValue === 'name' ? 'name' : 'viewers') : (sortValue === 'live' ? 'live' : 'name');
  const liveCount = channels.filter((channel) => channel.liveBroadcast !== null).length;
  const showControls = state !== 'login' && (state !== 'ready' || channels.length > 0);
  const matches = channels.filter((channel) => !term || normalize(channel.displayName).includes(term));
  const results = matches.filter((channel) => tab === 'channels' || channel.liveBroadcast !== null);
  results.sort((first, second) => (
    (sort === 'viewers' ? (second.liveBroadcast?.viewerCount ?? -1) - (first.liveBroadcast?.viewerCount ?? -1) : 0) ||
    (sort === 'live' ? Number(second.liveBroadcast !== null) - Number(first.liveBroadcast !== null) : 0) ||
    collator.compare(first.displayName, second.displayName) || first.handle.localeCompare(second.handle)
  ));

  function updateParam(key: string, value: string | null) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true, preventScrollReset: true });
  }

  function switchTab(next: Tab, focus = false) {
    if (tab !== next) updateParam('tab', next === 'live' ? null : next);
    if (focus) (next === 'live' ? liveTabRef : channelsTabRef).current?.focus({ preventScroll: true });
  }

  function handleTabKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'live' : event.key === 'End' || tab === 'live' ? 'channels' : 'live';
    switchTab(next, true);
  }

  function clearQuery() {
    composing.current = false;
    setDraftQuery(null);
    updateParam('q', null);
    inputRef.current?.focus();
  }

  const clearAction = (secondary = false) => (
    <button type="button" className={`${styles.action}${secondary ? ` ${styles.secondaryAction}` : ''}`} onClick={clearQuery}>검색어 지우기</button>
  );

  function renderResults() {
    if (state === 'login') return (
      <Notice Icon={UserRound} title="팔로잉을 보려면 로그인하세요">
        <button type="button" className={styles.action} onClick={onPreviewSignIn}>로그인</button>
      </Notice>
    );
    if (state === 'loading') return <Loading tab={tab} />;
    if (state === 'error') return (
      <Notice Icon={RefreshCw} title="팔로잉을 불러오지 못했어요" alert>
        <button type="button" className={styles.action} onClick={onRetry}>다시 시도</button>
      </Notice>
    );
    if (channels.length === 0) return (
      <Notice Icon={Heart} title="아직 팔로우한 채널이 없어요">
        <Link to="/live" className={styles.action}>라이브 둘러보기</Link>
      </Notice>
    );
    if (results.length === 0 && term && tab === 'live' && matches.length > 0) return (
      <Notice Icon={Search} title="방송 중인 검색 결과가 없어요">
        <button type="button" className={styles.action} onClick={() => switchTab('channels', true)}>전체 채널에서 찾기</button>
        {clearAction(true)}
      </Notice>
    );
    if (results.length === 0 && term) return <Notice Icon={Search} title="검색 결과가 없어요">{clearAction()}</Notice>;
    if (results.length === 0) return (
      <Notice Icon={Radio} title="지금 방송 중인 채널이 없어요">
        <button type="button" className={styles.action} onClick={() => switchTab('channels', true)}>전체 채널 보기</button>
      </Notice>
    );
    if (tab === 'channels') return (
      <div className={styles.channelGrid}>
        {results.map((channel) => <ChannelCard channel={channel} key={channel.handle} />)}
      </div>
    );
    return (
      <div className={liveStyles.grid}>
        {results.map((channel) => channel.liveBroadcast && (
          <BroadcastCard broadcast={channel.liveBroadcast} channelHref={channelPath(channel.handle)} key={channel.handle} />
        ))}
      </div>
    );
  }

  return (
    <section className={styles.page} aria-labelledby="following-title">
      <h1 id="following-title" className={styles.heading}>팔로잉</h1>
      {showControls && (
        <div className={styles.toolbar}>
          <div className={styles.tabs} role="tablist" aria-label="팔로잉 유형">
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                ref={id === 'live' ? liveTabRef : channelsTabRef}
                type="button"
                role="tab"
                id={`following-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="following-results"
                tabIndex={tab === id ? 0 : -1}
                onClick={() => switchTab(id)}
                onKeyDown={handleTabKeys}
              >
                {label}
                {state === 'ready' && <span className={styles.count}>{formatCount.format(id === 'live' ? liveCount : channels.length)}</span>}
              </button>
            ))}
          </div>
          <div className={styles.search} role="search" aria-label="팔로잉">
            <Search aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              aria-label="팔로우한 채널 검색"
              placeholder="팔로우한 채널 검색"
              value={draftQuery ?? query}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (composing.current) setDraftQuery(value);
                else updateParam('q', value || null);
              }}
              onCompositionStart={(event) => {
                composing.current = true;
                setDraftQuery(event.currentTarget.value);
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                setDraftQuery(null);
                updateParam('q', event.currentTarget.value || null);
              }}
            />
            {(draftQuery ?? query) && <button type="button" onClick={clearQuery} aria-label="검색어 지우기"><X size={16} aria-hidden="true" /></button>}
          </div>
          {state === 'ready' && results.length > 1 && (
            <label className={styles.sort}>
              <select aria-label="팔로잉 정렬" value={sort} onChange={(event) => updateParam(sortParam, event.currentTarget.value)}>
                {tab === 'live' && <option value="viewers">시청자순</option>}
                <option value="name">이름순</option>
                {tab === 'channels' && <option value="live">방송 중순</option>}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </label>
          )}
        </div>
      )}
      <div id="following-results" role={showControls ? 'tabpanel' : undefined} aria-labelledby={showControls ? `following-tab-${tab}` : undefined} aria-busy={state === 'loading'}>
        {renderResults()}
      </div>
      <p role="status" className={styles.visuallyHidden}>
        {state === 'loading' ? '팔로잉을 불러오는 중이에요.' : showControls && state === 'ready' ? `${results.length}개 ${tab === 'live' ? '방송' : '채널'}` : ''}
      </p>
    </section>
  );
}
