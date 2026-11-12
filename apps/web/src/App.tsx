import { Bell, Clapperboard, Heart, History, Menu, Radio, Search, Settings, Video, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router';
import symbol from './assets/frame-symbol.svg';
import wordmark from './assets/frame-wordmark.svg';
import { LivePage } from './features/live/LivePage';
import { WatchPage } from './features/watch/WatchPage';
import { useWatchHistoryRecorder } from './features/history/useWatchHistoryRecorder';
import { useWatchRewardHeartbeat } from './features/rewards/useWatchRewardHeartbeat';
import { analyticsPath, broadcastPath, channelManagePath, channelPath, developerPath, integrationsPath, membersPath, missionsPath, moderationPath, operatorReportsPath, pollsPath, recordingsPath, reportsPath, revenuePath, rewardsPath, scenesPath, schedulePath, transactionsPath } from './preview/community-types';
import type { CommunityPreviewRoutes, PreviewChannel } from './preview/community-types';
import type { BroadcastKey, ViewerAdapter } from './viewer-contract';

const nav = [
  { label: '다시보기', Icon: Video, to: '/vod' },
  { label: '클립', Icon: Clapperboard, to: '/clips' },
  { label: '시청 기록', Icon: History, to: '/history' },
];

const PreviewCommunity = import.meta.env.MODE === 'design'
  ? lazy(() => import('./preview/CommunityPreview'))
  : null;
const ConnectedCommunity = import.meta.env.MODE !== 'design'
  ? lazy(() => import('./features/account/ConnectedCommunity'))
  : null;

function LiveRoute({ viewer, channelHrefFor }: { viewer: ViewerAdapter; channelHrefFor?: CommunityPreviewRoutes['channelHrefFor'] }) {
  const { state, retry } = viewer.useLive();
  const [searchParams] = useSearchParams();
  return <LivePage state={state} onRetry={retry} query={searchParams.get('q') ?? ''} channelHrefFor={channelHrefFor} />;
}

function WatchContent({ viewer, broadcast, theater, onTheater, channelHref, actions, history, rewards, chatAccount, participation }: {
  viewer: ViewerAdapter;
  broadcast: BroadcastKey;
  theater: boolean;
  onTheater: () => void;
  channelHref?: string;
  actions?: ReactNode;
  history?: CommunityPreviewRoutes['watchHistory'];
  rewards?: CommunityPreviewRoutes['watchRewards'];
  chatAccount?: CommunityPreviewRoutes['watchChat'];
  participation?: ReactNode;
}) {
  const view = viewer.useWatch(broadcast);
  const recordHistory = useWatchHistoryRecorder({ broadcast, userId: history?.userId, record: history?.record,
    enabled: view.state.kind === 'ready' && view.state.broadcast?.id === broadcast.id && view.state.broadcast.path === broadcast.path });
  const recordRewards = useWatchRewardHeartbeat({ broadcast, userId: rewards?.userId, record: rewards?.record, viewerSessionId: view.playback.viewerSessionId,
    enabled: view.state.kind === 'ready' && view.state.broadcast?.id === broadcast.id && view.state.broadcast.path === broadcast.path });
  const onPlaybackProgress = useCallback((video: HTMLVideoElement) => { recordHistory(video); recordRewards(video); }, [recordHistory, recordRewards]);
  return <WatchPage view={view} theater={theater} onTheater={onTheater} channelHref={channelHref} actions={actions} onPlaybackProgress={history || rewards ? onPlaybackProgress : undefined} chatAccount={chatAccount} participation={participation} />;
}

function WatchRoute({ viewer, theater, onTheater, channelHrefFor, actionsFor, history, rewards, chatAccount, participationFor }: {
  viewer: ViewerAdapter;
  theater: boolean;
  onTheater: () => void;
  channelHrefFor?: CommunityPreviewRoutes['channelHrefFor'];
  actionsFor?: CommunityPreviewRoutes['watchActionsFor'];
  history?: CommunityPreviewRoutes['watchHistory'];
  rewards?: CommunityPreviewRoutes['watchRewards'];
  chatAccount?: CommunityPreviewRoutes['watchChat'];
  participationFor?: CommunityPreviewRoutes['watchParticipationFor'];
}) {
  const { path, id } = useParams();
  if (!path || !id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(path) || !/^[0-9a-f]{32}$/.test(id)) {
    return <section className="invalid-route"><h1>방송 주소를 확인해 주세요</h1><Link to="/live">라이브 목록으로</Link></section>;
  }
  const broadcast = { path, id };
  return <WatchContent key={`${path}/${id}`} viewer={viewer} broadcast={broadcast} theater={theater} onTheater={onTheater} channelHref={channelHrefFor?.(broadcast)} actions={actionsFor?.(broadcast)} history={history} rewards={rewards} chatAccount={chatAccount} participation={participationFor?.(broadcast)} />;
}

function FollowedSidebar({ channels, onNavigate }: { channels: readonly PreviewChannel[]; onNavigate: () => void }) {
  if (!channels.length) return null;
  const sorted = [...channels].sort((first, second) => Number(Boolean(second.liveBroadcast)) - Number(Boolean(first.liveBroadcast)));
  return (
    <nav aria-label="팔로우한 채널" className="followed-nav">
      <p>팔로우한 채널</p>
      {sorted.slice(0, 5).map(channel => (
        <Link
          key={channel.handle} to={channelPath(channel.handle)} className="followed-nav-link" onClick={onNavigate}
          aria-label={`${channel.displayName} 채널 보기, ${channel.liveBroadcast ? '방송 중' : '오프라인'}`}
        >
          <span className="followed-avatar" aria-hidden="true">
            {channel.avatarUrl ? <img src={channel.avatarUrl} alt="" /> : Array.from(channel.displayName)[0]}
          </span>
          <span className="followed-name" title={channel.displayName}>{channel.displayName}</span>
          <span className="followed-status">
            {channel.liveBroadcast ? <><i aria-hidden="true" />{channel.liveBroadcast.viewerCount?.toLocaleString('ko-KR') ?? '방송 중'}</> : '오프라인'}
          </span>
        </Link>
      ))}
      {sorted.length > 5 && <Link to="/following?tab=channels" className="followed-nav-more" onClick={onNavigate}>더 보기</Link>}
    </nav>
  );
}

type AppProps = { viewer: ViewerAdapter; designPreview: boolean };

export function App({ viewer, designPreview }: AppProps) {
  if (designPreview && PreviewCommunity) {
    return <Suspense fallback={<p className="preview-loading" role="status">화면을 불러오는 중이에요.</p>}>
      <PreviewCommunity viewer={viewer} render={community => <AppShell viewer={viewer} community={community} />} />
    </Suspense>;
  }
  if (ConnectedCommunity) return <Suspense fallback={<p className="preview-loading" role="status">화면을 불러오는 중이에요.</p>}>
    <ConnectedCommunity viewer={viewer} render={community => <AppShell viewer={viewer} community={community} />} />
  </Suspense>;
  return <AppShell viewer={viewer} />;
}

function AppShell({ viewer, community }: { viewer: ViewerAdapter; community?: CommunityPreviewRoutes }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isWatching = Boolean(useMatch('/watch/:path/:id'));
  const isLive = Boolean(useMatch('/live'));
  const isSearch = Boolean(useMatch('/search'));
  const isFollowing = Boolean(useMatch('/following'));
  const isLogin = Boolean(useMatch('/login'));
  const [navOpen, setNavOpen] = useState(false);
  const [compactNav, setCompactNav] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [theaterPath, setTheaterPath] = useState('');
  const theater = isWatching && theaterPath === location.pathname;

  function closeNavigation() {
    setNavOpen(false);
    setTheaterPath('');
  }

  function closeHeaderNavigation() {
    closeNavigation();
    setSearchOpen(false);
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    const path = community ? '/search' : '/live';
    navigate(query ? `${path}?${new URLSearchParams({ q: query })}` : path);
    closeHeaderNavigation();
  }

  function toggleNav() {
    if (window.matchMedia('(max-width: 850px)').matches) setNavOpen(!navOpen);
    else if (theater) setTheaterPath('');
    else setCompactNav(!compactNav);
  }

  if (community && isLogin) return community.login;
  const creatorSidebar = community?.creatorSidebar?.(closeHeaderNavigation);

  return (
    <div className={`app ${isWatching ? 'is-watching' : ''} ${compactNav || theater ? 'is-compact' : ''}`}>
      <a className="skip-link" href="#main-content">본문으로 이동</a>
      <header className="app-header">
        <div className="header-brand">
          <button type="button" className="icon-button nav-toggle" onClick={toggleNav} aria-label="탐색 메뉴" aria-controls="site-nav">
            <Menu size={22} />
          </button>
          <Link to="/live" className="brand" aria-label="FRAME 라이브" onClick={closeNavigation}>
            <img src={symbol} alt="" className="brand-symbol" />
            <img src={wordmark} alt="" className="brand-wordmark" />
          </Link>
        </div>
        <form key={location.pathname + location.search} role="search" className={`header-search ${searchOpen ? 'search-open' : ''}`} onSubmit={search}>
          <button type="submit" className="icon-button search-submit" aria-label="검색"><Search size={19} /></button>
          <input type="search" name="q" placeholder="방송, 채널 검색" defaultValue={isLive || isSearch ? new URLSearchParams(location.search).get('q') ?? '' : ''} aria-label="방송, 채널 검색" maxLength={120} />
        </form>
        <div className="header-actions">
          <button type="button" className="icon-button mobile-search-toggle" onClick={() => setSearchOpen(!searchOpen)} aria-expanded={searchOpen} aria-label={searchOpen ? '검색 닫기' : '검색 열기'}>
            {searchOpen ? <X size={20} /> : <Search size={20} />}
          </button>
          {community
            ? <NavLink to="/notifications" className="icon-button notification-link" onClick={closeHeaderNavigation}
              aria-label={community.notificationUnreadCount ? `알림, 읽지 않은 알림 ${community.notificationUnreadCount.toLocaleString('ko-KR')}개` : '알림'}>
              <Bell size={20} aria-hidden="true" />{Boolean(community.notificationUnreadCount) && <span className="notification-unread-badge" aria-hidden="true">{community.notificationUnreadCount! > 99 ? '99+' : community.notificationUnreadCount}</span>}
            </NavLink>
            : <button type="button" className="icon-button notifications" disabled title="알림 준비 중" aria-label="알림"><Bell size={20} /></button>}
          {community?.profileMenu?.(closeHeaderNavigation) ?? (community
            ? <button type="button" className="login-button" onClick={() => {
              closeHeaderNavigation();
              community.requestLogin();
            }}>로그인</button>
            : <button type="button" className="login-button" disabled title="로그인 준비 중">로그인</button>)}
        </div>
      </header>
      <div className="app-layout">
        {navOpen && <button type="button" className="nav-backdrop" aria-label="탐색 메뉴 닫기" onClick={() => setNavOpen(false)} />}
        <aside id="site-nav" className={`sidebar ${navOpen ? 'nav-open' : ''}`}>
          {creatorSidebar ?? <>
            <nav aria-label="둘러보기" className="nav-group">
              <Link to="/live" className="nav-link" aria-current={isLive ? 'page' : undefined} onClick={closeNavigation}>
                <Radio size={22} /><span>라이브</span>
              </Link>
              {community
                ? <Link to="/following" className="nav-link" aria-current={isFollowing ? 'page' : undefined} onClick={closeNavigation}><Heart size={22} /><span>팔로잉</span></Link>
                : <button className="nav-link" type="button" disabled title="팔로잉 준비 중"><Heart size={22} /><span>팔로잉</span></button>}
              {nav.map(({ label, Icon, to }) => community
                ? <NavLink key={to} to={to} className="nav-link" onClick={closeNavigation}><Icon size={22} /><span>{label}</span></NavLink>
                : <button className="nav-link" type="button" disabled key={to} title={`${label} 준비 중`}><Icon size={22} /><span>{label}</span></button>)}
            </nav>
            {community && <FollowedSidebar channels={community.followedChannels} onNavigate={closeNavigation} />}
            <nav aria-label="방송 관리" className="nav-group nav-secondary">
              {community ? <NavLink to={broadcastPath} className="nav-link" onClick={closeNavigation}><Radio size={22} /><span>방송하기</span></NavLink>
                : <button className="nav-link" type="button" disabled title="방송하기 준비 중"><Radio size={22} /><span>방송하기</span></button>}
              {community
                ? <NavLink to="/settings" className="nav-link" onClick={closeNavigation}><Settings size={22} /><span>설정</span></NavLink>
                : <button className="nav-link" type="button" disabled title="설정 준비 중"><Settings size={22} /><span>설정</span></button>}
            </nav>
          </>}
        </aside>
        <main id="main-content" tabIndex={-1} className="main-content">
          <Routes>
            <Route path="/live" element={<LiveRoute viewer={viewer} channelHrefFor={community?.channelHrefFor} />} />
            <Route path="/watch/:path/:id" element={<WatchRoute viewer={viewer} theater={theater} onTheater={() => setTheaterPath(theater ? '' : location.pathname)} channelHrefFor={community?.channelHrefFor} actionsFor={community?.watchActionsFor} history={community?.watchHistory} rewards={community?.watchRewards} chatAccount={community?.watchChat} participationFor={community?.watchParticipationFor} />} />
            {community && <Route path="/following" element={community.following} />}
            {community && <Route path="/channel/:handle" element={community.channel} />}
            {community && <Route path="/channel/id/:id" element={community.channel} />}
            {community && <Route path={channelManagePath} element={community.channelManage} />}
            {community && <Route path="/settings" element={community.settings} />}
            {community && <Route path="/search" element={community.search} />}
            {community && <Route path="/vod" element={community.vod} />}
            {community && <Route path="/vod/:handle/:id" element={community.vodWatch} />}
            {community && <Route path="/clips" element={community.clips} />}
            {community && <Route path="/clips/:handle/:id" element={community.clipWatch} />}
            {community && <Route path="/history" element={community.history} />}
            {community && <Route path="/notifications" element={community.notifications} />}
            {community && <Route path={moderationPath} element={community.moderation} />}
            {community && <Route path={reportsPath} element={community.reports} />}
            {community?.operatorReports !== undefined && <Route path={operatorReportsPath} element={community.operatorReports} />}
            {community && <Route path={schedulePath} element={community.schedule} />}
            {community && <Route path={recordingsPath} element={community.recordings} />}
            {community && <Route path={analyticsPath} element={community.analytics} />}
            {community && <Route path={integrationsPath} element={community.integrations} />}
            {community && <Route path={revenuePath} element={community.revenue} />}
            {community && <Route path={membersPath} element={community.members} />}
            {community && <Route path={missionsPath} element={community.missions} />}
            {community && <Route path={pollsPath} element={community.polls} />}
            {community && <Route path={rewardsPath} element={community.rewards} />}
            {community && <Route path={developerPath} element={community.developer} />}
            {community && <Route path={scenesPath} element={community.scenes} />}
            {community && <Route path={broadcastPath} element={community.broadcast} />}
            {community && <Route path={transactionsPath} element={community.transactions} />}
            {community && <Route path="/payments/success" element={community.paymentSuccess} />}
            {community && <Route path="/payments/fail" element={community.paymentFail} />}
            <Route path="*" element={<Navigate to="/live" replace />} />
          </Routes>
        </main>
      </div>
      {community?.overlay}
    </div>
  );
}
