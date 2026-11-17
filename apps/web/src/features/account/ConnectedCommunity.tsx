import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router';
import { EmptyState, ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import type { CommunityPreviewRoutes, PreviewChannel } from '../../preview/community-types';
import { channelPath, operatorReportsPath } from '../../preview/community-types';
import type { BroadcastKey, ChatAccountActions, ViewerAdapter } from '../../viewer-contract';
import { ChannelPage } from '../channel/ChannelPage';
import { FollowingPage } from '../following/FollowingPage';
import { ProfileMenu } from './ProfileMenu';
import { CreatorSidebar } from './CreatorSidebar';
import { AccountSettingsPage } from './AccountSettingsPage';
import { AuthPage } from './AuthPage';
import { ConnectedChannelManagePage, channelBanner } from './ConnectedChannelManagePage';
import { ConnectedStudio } from './ConnectedStudio';
import { ConnectedSchedulePage } from './ConnectedSchedulePage';
import { ConnectedHistoryPage } from './ConnectedHistoryPage';
import { OperatorReportsPage } from '../operator/OperatorReportsPage';
import { ConnectedNotificationsPage } from '../notifications/ConnectedNotificationsPage';
import { ConnectedModerationPage } from '../moderation/ConnectedModerationPage';
import { ConnectedParticipationPage } from '../polls/ConnectedParticipationPage';
import { ViewerPollPanel } from '../polls/ViewerPollPanel';
import { ViewerQuestionsPanel } from '../polls/ViewerQuestionsPanel';
import { ConnectedRewardsPage } from '../rewards/ConnectedRewardsPage';
import { ViewerRewardsPanel } from '../rewards/ViewerRewardsPanel';
import { rewardsApi } from '../rewards/rewards-client';
import { ViewerMissionsPanel } from '../missions/ViewerMissionsPanel';
import { ConnectedMissionsPage } from '../missions/ConnectedMissionsPage';
import { ConnectedAnalyticsPage } from '../analytics/ConnectedAnalyticsPage';
import { ConnectedRecordingsPage } from '../recordings/ConnectedRecordingsPage';
import { ConnectedVodList, ConnectedVodWatch } from '../vod/ConnectedVodPages';
import { ConnectedClipList, ConnectedClipWatch } from '../clips/ConnectedClipPages';
import { ConnectedIntegrationsPage } from '../integrations/ConnectedIntegrationsPage';
import { ConnectedDeveloperPage } from '../developer/ConnectedDeveloperPage';
import { ConnectedMembersPage } from '../members/ConnectedMembersPage';
import { ViewerMembershipButton } from '../members/ViewerMembershipButton';
import { MyMembershipsPage } from '../members/MyMembershipsPage';
import { MembershipResultPage } from '../members/MembershipResultPage';
import { captureMembershipCallback } from '../members/membership-callback';
import { channelSchedule } from '../schedule/SchedulePage';
import { AccountError, accountApi, safeReturnPath } from './account-client';
import type { AccountSession, ProductChannel } from './account-client';
import type { ScheduledBroadcast } from './account-client';
import styles from './ConnectedAccount.module.css';

function pageChannel(value: ProductChannel): PreviewChannel {
  return { id: value.id, createdAtMs: value.createdAtMs, countryCode: value.countryCode, links: value.links, videoCount: value.videoCount, totalViewCount: value.totalViewCount,
    handle: value.handle, displayName: value.displayName, description: value.description, avatarUrl: value.avatarUrl, bannerUrl: channelBanner(value),
    followerCount: value.followerCount, verified: false, liveBroadcast: value.liveBroadcast, videos: [], schedule: [], posts: [] };
}
function StatePage({ title, description, loading = false, retry }: { title: string; description?: string; loading?: boolean; retry?: () => void }) {
  return <ManagementPage title={title}>{loading ? <p role="status">불러오는 중이에요.</p> : <EmptyState title={description ?? '아직 등록된 내용이 없어요'} action={retry && <button type="button" className={ui.button} onClick={retry}>다시 시도</button>} />}</ManagementPage>;
}

function ConnectedChannel({ session, sessionReady, requestLogin, onChannelChange, onSessionChanged }: { session: AccountSession | null; sessionReady: boolean; requestLogin: (handle?: string) => void; onChannelChange: (channel: ProductChannel) => void; onSessionChanged: () => void }) {
  const { handle = '', id } = useParams();
  const location = useLocation();
  const [channel, setChannel] = useState<ProductChannel | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState((location.state as { followError?: string } | null)?.followError ?? '');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [schedule, setSchedule] = useState<ScheduledBroadcast[]>([]);
  const [schedulePhase, setSchedulePhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [scheduleAttempt, setScheduleAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setLoadError(''); setChannel(null);
    void (id ? accountApi.channelById(id, abort.signal) : accountApi.channel(handle, abort.signal)).then(value => { if (!abort.signal.aborted) setChannel(value); }).catch(failure => {
      if (!abort.signal.aborted && !(failure instanceof AccountError && failure.status === 404)) setLoadError(failure instanceof Error ? failure.message : '채널 정보를 불러오지 못했어요.');
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [handle, id, session?.user?.id, attempt]);
  useEffect(() => {
    const abort = new AbortController(); setSchedule([]); setSchedulePhase('loading');
    if (!channel) return () => abort.abort();
    void accountApi.channelSchedule(channel.handle, abort.signal).then(items => {
      if (!abort.signal.aborted) { setSchedule(items); setSchedulePhase('ready'); }
    }).catch(() => { if (!abort.signal.aborted) setSchedulePhase('error'); });
    return () => abort.abort();
  }, [channel?.handle, scheduleAttempt]);
  async function toggle(notifications = false) {
    if (!channel || inFlight.current || !sessionReady) return;
    if (!session?.user) { requestLogin(channel.handle); return; }
    inFlight.current = true; setPending(true); setError('');
    try {
      const updated = notifications ? await accountApi.follow(channel.id, session.csrfToken, !channel.notificationsOn)
        : channel.following ? await accountApi.unfollow(channel.id, session.csrfToken) : await accountApi.follow(channel.id, session.csrfToken);
      setChannel(updated); onChannelChange(updated);
    } catch (failure) {
      if (failure instanceof AccountError && failure.status === 401) requestLogin(channel.handle);
      else setError(failure instanceof Error ? failure.message : '팔로우 설정을 변경하지 못했어요.');
    } finally { inFlight.current = false; setPending(false); }
  }
  async function report(input: { reason: string; details: string }) {
    if (!channel || !session?.user) { requestLogin(); throw new Error('로그인한 뒤 신고할 수 있어요.'); }
    try { await accountApi.reportChannel(channel.id, input, session.csrfToken); }
    catch (failure) { if (failure instanceof AccountError && failure.status === 401) requestLogin(); throw failure; }
  }
  if (loading) return <StatePage title="채널" loading />;
  if (loadError) return <StatePage title="채널" description={loadError} retry={() => setAttempt(value => value + 1)} />;
  if (channel && (id || handle !== channel.handle)) return <Navigate to={`${channelPath(channel.handle)}${location.search}${location.hash}`} replace state={location.state} />;
  const own = channel?.id === session?.channel?.id;
  const scheduleFeedback = schedulePhase === 'loading' ? <p role="status">방송 일정을 불러오는 중이에요.</p>
    : schedulePhase === 'error' ? <div role="alert"><p>방송 일정을 불러오지 못했어요.</p><button type="button" className={ui.button} onClick={() => setScheduleAttempt(value => value + 1)}>다시 시도</button></div> : undefined;
  return <ChannelPage channel={channel ? { ...pageChannel(channel), schedule: channelSchedule(schedule) } : null} scheduleFeedback={scheduleFeedback} clipsContent={channel ? <ConnectedClipList key={channel.id} channelHandle={channel.handle} /> : undefined} videosContent={channel ? <ConnectedVodList key={channel.id} channelHandle={channel.handle} /> : undefined} recentVideosContent={channel ? <ConnectedVodList key={channel.id} channelHandle={channel.handle} recent /> : undefined} state="ready" followed={channel?.following ?? false} notificationsOn={channel?.notificationsOn ?? false}
    pending={pending || !sessionReady} actionError={error} ownChannel={own} notice={channel?.notice} onToggleFollow={() => void toggle()} onToggleNotifications={() => void toggle(true)}
    signedIn={Boolean(session?.user)} onRequireLogin={() => requestLogin()} onReport={report}
    actions={own ? <Link className={ui.button} to="/studio/channel">채널 관리</Link> : channel && <ViewerMembershipButton key={`${channel.id}:${session?.user?.id ?? 'anonymous'}`} channelId={channel.id} channelName={channel.displayName} session={session} sessionReady={sessionReady} onRequireLogin={() => requestLogin()} onSessionChanged={onSessionChanged} />} />;
}

function ChannelSearch() {
  const [params] = useSearchParams();
  const query = (params.get('q') ?? '').trim().slice(0, 120);
  const [items, setItems] = useState<ProductChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError('');
    void accountApi.directory(query, abort.signal).then(value => { if (!abort.signal.aborted) setItems(value); }).catch(failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '검색하지 못했어요.'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [query, attempt]);
  return <ManagementPage title={query ? `'${query}' 검색 결과` : '채널 둘러보기'}>
    {loading ? <p role="status">채널을 불러오는 중이에요.</p> : error ? <EmptyState title={error} action={<button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}>다시 시도</button>} />
      : items.length ? <ul className={styles.list}>{items.map(channel => <li key={channel.id}><Link to={channelPath(channel.handle)}><span className={styles.avatar} aria-hidden="true">{Array.from(channel.displayName)[0]}</span><span><strong>{channel.displayName}</strong><small>@{channel.handle} · 팔로워 {channel.followerCount.toLocaleString('ko-KR')}명</small>{channel.description && <small>{channel.description}</small>}</span></Link></li>)}</ul>
        : <EmptyState title={query ? '조건에 맞는 채널이 없어요' : '아직 등록된 채널이 없어요'} />}
  </ManagementPage>;
}

export default function ConnectedCommunity({ viewer, render }: { viewer: ViewerAdapter; render: (routes: CommunityPreviewRoutes) => ReactNode }) {
  const location = useLocation();
  const membershipCallback = captureMembershipCallback();
  const navigate = useNavigate();
  const [session, setSession] = useState<AccountSession | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [sessionError, setSessionError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [directory, setDirectory] = useState<ProductChannel[]>([]);
  const [follows, setFollows] = useState<ProductChannel[]>([]);
  const [followsError, setFollowsError] = useState('');
  const [followsLoading, setFollowsLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [operatorDeniedFor, setOperatorDeniedFor] = useState<string | null>(null);
  const [notificationCount, setNotificationCount] = useState<{ userId: string; count: number } | null>(null);
  const [watchPointFeedback, setWatchPointFeedback] = useState<{ key: string; message: string } | null>(null);
  const latestPointPulse = useRef<{ key: string; visitId: string; sequence: number } | null>(null);
  const notificationAccount = useRef<string | null>(null); notificationAccount.current = phase === 'ready' ? session?.user?.id ?? null : null;
  const notificationAbort = useRef<AbortController | null>(null), notificationRevision = useRef(0);
  const logoutPending = useRef(false);
  const followsVersion = useRef(0);
  const isStudio = Boolean(useMatch('/studio/*'));
  const isAdmin = Boolean(useMatch('/admin/*'));
  const currentUrl = /\/payments\/(?:success|fail)\/?$/.test(location.pathname) ? location.pathname + window.location.search : location.pathname + location.search + location.hash;
  useEffect(() => {
    const abort = new AbortController(); setPhase('loading'); setSessionError('');
    void accountApi.session(abort.signal).then(value => { if (!abort.signal.aborted) { setSession(value); setPhase('ready'); } }).catch(failure => {
      if (!abort.signal.aborted) { setSessionError(failure instanceof Error ? failure.message : '로그인 정보를 불러오지 못했어요.'); setPhase('error'); }
    });
    return () => abort.abort();
  }, [attempt]);
  useEffect(() => {
    if (phase !== 'ready') return;
    const abort = new AbortController(); const version = followsVersion.current; setFollowsError(''); setFollows([]);
    void accountApi.directory('', abort.signal).then(value => { if (!abort.signal.aborted) setDirectory(value); }).catch(() => { if (!abort.signal.aborted) setDirectory([]); });
    if (session?.user) {
      setFollowsLoading(true);
      void accountApi.follows(abort.signal).then(value => { if (!abort.signal.aborted && followsVersion.current === version) setFollows(value); }).catch(failure => { if (!abort.signal.aborted) setFollowsError(failure instanceof Error ? failure.message : '팔로잉을 불러오지 못했어요.'); }).finally(() => { if (!abort.signal.aborted) setFollowsLoading(false); });
    } else setFollowsLoading(false);
    return () => abort.abort();
  }, [phase, session?.user?.id, attempt]);
  const changeNotificationUnreadCount = useCallback((count: number) => {
    const userId = session?.user?.id;
    if (!userId || notificationAccount.current !== userId || !Number.isSafeInteger(count) || count < 0) return;
    ++notificationRevision.current; notificationAbort.current?.abort();
    setNotificationCount(previous => previous?.userId === userId && previous.count === count ? previous : { userId, count });
  }, [session?.user?.id]);
  const notificationSessionChanged = useCallback(() => {
    const userId = session?.user?.id;
    if (!userId || notificationAccount.current !== userId) return;
    notificationAccount.current = null;
    ++notificationRevision.current; notificationAbort.current?.abort();
    setNotificationCount(null); setPhase('loading'); setAttempt(value => value + 1);
  }, [session?.user?.id]);
  useEffect(() => {
    const userId = session?.user?.id;
    ++notificationRevision.current; notificationAbort.current?.abort();
    setNotificationCount(previous => userId && previous?.userId === userId ? previous : null);
    if (phase !== 'ready' || !userId) return;
    let disposed = false, request: AbortController | null = null;
    async function refresh() {
      if (disposed || request || document.visibilityState !== 'visible' || !navigator.onLine) return;
      const abort = new AbortController(), revision = notificationRevision.current;
      request = abort; notificationAbort.current = abort;
      try {
        const result = await accountApi.notificationUnreadCount(abort.signal, userId);
        if (!disposed && !abort.signal.aborted && notificationAccount.current === userId) {
          if (result.userId !== userId) { notificationSessionChanged(); return; }
          if (notificationRevision.current === revision) setNotificationCount(previous => previous?.userId === userId && previous.count === result.unreadCount ? previous : { userId: userId!, count: result.unreadCount });
        }
      } catch (failure) {
        if (!disposed && !abort.signal.aborted && notificationAccount.current === userId && failure instanceof AccountError
          && (failure.status === 401 || (failure.status === 409 && failure.code === 'SESSION_CHANGED'))) notificationSessionChanged();
      } finally {
        if (request === abort) request = null;
        if (notificationAbort.current === abort) notificationAbort.current = null;
      }
    }
    function wake() {
      if (document.visibilityState !== 'visible' || !navigator.onLine) {
        const abort = request; abort?.abort(); request = null;
        if (notificationAbort.current === abort) notificationAbort.current = null;
      } else void refresh();
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30000);
    window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('offline', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      disposed = true; request?.abort();
      if (notificationAbort.current === request) notificationAbort.current = null;
      window.clearInterval(interval); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [phase, session?.user?.id, notificationSessionChanged]);
  function requestLogin(handle?: string) {
    const params = new URLSearchParams({ returnTo: safeReturnPath(currentUrl) }); if (handle) params.set('follow', handle);
    if (session?.user) setAttempt(value => value + 1);
    navigate(`/login?${params}`);
  }
  function updateChannel(channel: ProductChannel) {
    if (channel.id !== session?.channel?.id) followsVersion.current++;
    setDirectory(values => values.map(value => value.id === channel.id ? channel : value));
    setFollows(values => channel.following ? values.some(value => value.id === channel.id) ? values.map(value => value.id === channel.id ? channel : value) : [...values, channel] : values.filter(value => value.id !== channel.id));
    setSession(value => value?.channel?.id === channel.id ? { ...value, channel } : value);
  }
  async function authorized<T>(operation: () => Promise<T>) {
    try { return await operation(); }
    catch (failure) { if (failure instanceof AccountError && failure.status === 401) requestLogin(); throw failure; }
  }
  async function authenticated(value: AccountSession) {
    setSession(value); setPhase('ready'); setOperatorDeniedFor(null);
    const query = new URLSearchParams(location.search);
    const destination = safeReturnPath(query.get('returnTo'));
    const follow = query.get('follow');
    let followError = '';
    if (follow && /^[a-z][a-z0-9_-]{2,23}$/.test(follow)) {
      try { const channel = await accountApi.channel(follow); if (channel.id !== value.channel?.id && !channel.following) updateChannel(await accountApi.follow(channel.id, value.csrfToken)); }
      catch (failure) { followError = failure instanceof Error ? failure.message : '팔로우를 완료하지 못했어요. 다시 눌러 주세요.'; }
    }
    navigate(destination, { replace: true, state: followError ? { followError } : null });
  }
  async function signOut() {
    if (!session || logoutPending.current) return;
    logoutPending.current = true; setNotice('');
    try { await accountApi.logout(session.csrfToken); setSession(null); setFollows([]); setDirectory([]); setPhase('loading'); navigate('/live', { replace: true }); setAttempt(value => value + 1); }
    catch (failure) { setNotice(failure instanceof Error ? failure.message : '로그아웃하지 못했어요.'); }
    finally { logoutPending.current = false; }
  }
  function operatorPermissionRevoked() {
    if (session?.user) setOperatorDeniedFor(session.user.id);
    setAttempt(value => value + 1);
  }
  function refreshChatSession(expectedUserId?: string) {
    if (expectedUserId && session?.user && session.user.id !== expectedUserId) return;
    notificationAccount.current = null; ++notificationRevision.current; notificationAbort.current?.abort();
    setNotificationCount(null); setPhase('loading'); setAttempt(value => value + 1);
  }
  const sessionState = phase === 'loading' ? <StatePage title="계정" loading /> : <StatePage title="계정 연결" description={sessionError} retry={() => setAttempt(value => value + 1)} />;
  const requireAccount = (children: ReactNode) => phase !== 'ready' ? sessionState : session?.user ? children : <Navigate to={`/login?${new URLSearchParams({ returnTo: safeReturnPath(currentUrl) })}`} replace />;
  const waiting = (title: string) => requireAccount(<StatePage title={title} description="아직 연결된 내용이 없어요." />);
  const user = session?.user, owned = session?.channel;
  const notificationUnreadCount = user && notificationCount?.userId === user.id ? notificationCount.count : undefined;
  const operatorDenied = Boolean(user && operatorDeniedFor === user.id);
  const isOperator = phase === 'ready' && Boolean(user?.isOperator) && !operatorDenied;
  const forbiddenOperator = <StatePage title="신고 관리" description="운영자만 접근할 수 있어요." retry={() => { setOperatorDeniedFor(null); setAttempt(value => value + 1); }} />;
  const operatorReports = operatorDenied ? forbiddenOperator : requireAccount(session && user
    ? user.isOperator ? <OperatorReportsPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onPermissionRevoked={operatorPermissionRevoked} /> : forbiddenOperator : null);
  const legacyReports = operatorDenied ? forbiddenOperator : requireAccount(user?.isOperator
    ? <Navigate to={`${operatorReportsPath}${location.search}${location.hash}`} replace /> : forbiddenOperator);
  const viewFollows = follows.map(pageChannel);
  const chatAccount: ChatAccountActions = { currentUserId: phase === 'ready' ? user?.id ?? null : undefined, onRequireLogin: () => {
    refreshChatSession(); navigate(`/login?${new URLSearchParams({ returnTo: safeReturnPath(currentUrl) })}`);
  }, onSessionChanged: refreshChatSession };
  const participationFor = (broadcast: BroadcastKey) => phase === 'ready' && session
    ? <Fragment key={`${broadcast.path}/${broadcast.id}/${user?.id ?? 'anonymous'}`}><ViewerPollPanel broadcast={broadcast} session={session} accountActions={chatAccount} /><ViewerQuestionsPanel broadcast={broadcast} session={session} accountActions={chatAccount} /><ViewerRewardsPanel broadcast={broadcast} session={session} accountActions={chatAccount} watchMessage={watchPointFeedback?.key === `${user?.id}/${broadcast.path}/${broadcast.id}` ? watchPointFeedback.message : undefined} /><ViewerMissionsPanel broadcast={broadcast} session={session} accountActions={chatAccount} /></Fragment> : null;
  return render({
    login: phase === 'ready' && session ? <AuthPage session={session} onAuthenticated={authenticated} /> : sessionState,
    channel: <ConnectedChannel key={`${location.pathname}:${user?.id ?? ''}`} session={session} sessionReady={phase === 'ready'} requestLogin={requestLogin} onChannelChange={updateChannel} onSessionChanged={notificationSessionChanged} />,
    following: phase !== 'ready' ? sessionState : followsError ? <StatePage title="팔로잉" description={followsError} retry={() => setAttempt(value => value + 1)} />
      : <FollowingPage channels={viewFollows} state={!user ? 'login' : followsLoading ? 'loading' : 'ready'} onRetry={() => setAttempt(value => value + 1)} onPreviewSignIn={() => requestLogin()} />,
    settings: requireAccount(session && user ? <AccountSettingsPage key={user.id} session={session} onSave={async name => { const updated = await authorized(() => accountApi.profile(name, session.csrfToken)); setSession(updated); return updated; }} /> : null),
    channelManage: requireAccount(owned && session ? <ConnectedChannelManagePage key={owned.id} channel={owned} onSave={async changes => { const updated = await authorized(() => accountApi.updateChannel(changes, session.csrfToken)); updateChannel(updated); return updated; }} /> : <StatePage title="채널 관리" description="채널 정보를 불러오지 못했어요." />),
    broadcast: requireAccount(session && owned ? <ConnectedStudio key={owned.id} viewer={viewer} session={session} onConnected={updateChannel} onRequireLogin={() => requestLogin()} chatAccount={chatAccount} participationFor={participationFor} /> : null),
    search: <ChannelSearch />,
    vod: <ConnectedVodList />, vodWatch: <ConnectedVodWatch session={phase === 'ready' ? session : null} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} />,
    clips: <ConnectedClipList />, clipWatch: <ConnectedClipWatch session={phase === 'ready' ? session : null} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} />,
    history: requireAccount(session && user ? <ConnectedHistoryPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null),
    notifications: requireAccount(session && user ? <ConnectedNotificationsPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} onUnreadCountChange={changeNotificationUnreadCount} unreadCount={notificationUnreadCount} /> : null),
    notificationUnreadCount,
    moderation: requireAccount(session && user ? <ConnectedModerationPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), reports: legacyReports, operatorReports, schedule: requireAccount(session && user ? <ConnectedSchedulePage key={user.id} session={session} onRequireLogin={() => requestLogin()} /> : null), recordings: requireAccount(session && user ? <ConnectedRecordingsPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), analytics: requireAccount(session && user ? <ConnectedAnalyticsPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), integrations: requireAccount(session && user ? <ConnectedIntegrationsPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), revenue: waiting('수익·정산'), members: requireAccount(session && user ? <ConnectedMembersPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), missions: requireAccount(session && user ? <ConnectedMissionsPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), polls: requireAccount(session && user ? <ConnectedParticipationPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), rewards: requireAccount(session && user ? <ConnectedRewardsPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), developer: requireAccount(session && user ? <ConnectedDeveloperPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null), scenes: waiting('장면 관리'),
    transactions: requireAccount(session && user ? <MyMembershipsPage key={user.id} session={session} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} /> : null),
    paymentSuccess: <MembershipResultPage session={session} sessionReady={phase === 'ready'} callback={membershipCallback} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} />, paymentFail: <MembershipResultPage failed session={session} sessionReady={phase === 'ready'} callback={membershipCallback} onRequireLogin={() => requestLogin()} onSessionChanged={notificationSessionChanged} />,
    profileMenu: phase !== 'ready' ? () => <button type="button" className="login-button" disabled>{phase === 'loading' ? '연결 중' : '연결 오류'}</button>
      : user && owned ? onNavigate => <ProfileMenu key={location.key} profile={{ name: user.displayName, handle: owned.handle, avatarUrl: owned.avatarUrl }} channelName={owned.displayName} channelHref={channelPath(owned.handle)} onNavigate={onNavigate} onSignOut={() => void signOut()} isOperator={isOperator} /> : undefined,
    creatorSidebar: user && owned && (isStudio || isAdmin) ? onNavigate => <CreatorSidebar channelName={owned.displayName} channelHandle={owned.handle} initial={Array.from(user.displayName)[0]} onNavigate={onNavigate} isOperator={isOperator} showLegacyReports={false} /> : undefined,
    followedChannels: viewFollows,
    channelHrefFor: ({ path, id }) => { const channel = directory.find(item => item.liveBroadcast?.path === path && item.liveBroadcast.id === id); return channel ? channelPath(channel.handle) : undefined; },
    requestLogin,
    watchHistory: phase === 'ready' && user && session ? { userId: user.id, record: (broadcast, signal) => accountApi.recordHistory({ broadcastId: broadcast.id, path: broadcast.path }, session.csrfToken, signal, user.id) } : undefined,
    watchRewards: phase === 'ready' && user && session ? { userId: user.id, record: async (input, signal) => {
      const key = `${user.id}/${input.path}/${input.broadcastId}`, pulse = { key, visitId: input.visitId, sequence: input.sequence }; latestPointPulse.current = pulse;
      const current = () => !signal.aborted && notificationAccount.current === user.id && latestPointPulse.current === pulse;
      try {
        const result = await rewardsApi.watchPoints(input, session.csrfToken, user.id, signal);
        if (current()) {
          const message = result.reason === 'watching_elsewhere' ? '다른 화면에서 포인트를 적립하고 있어요.' : result.reason === 'session_unavailable' ? '시청 연결을 확인한 뒤 적립해요.' : result.reason === 'broadcast_unavailable' ? '현재 방송의 적립 상태를 확인해 주세요.' : '';
          setWatchPointFeedback(previous => previous?.key === key && previous.message === message ? previous : { key, message });
        }
        return result;
      } catch (failure) {
        if (current()) {
          if (failure instanceof AccountError && (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID')) notificationSessionChanged();
          else if (input.watching) setWatchPointFeedback({ key, message: '포인트 적립 연결을 다시 확인하고 있어요.' });
        }
        throw failure;
      }
    } } : undefined,
    watchChat: chatAccount,
    watchParticipationFor: participationFor,
    overlay: notice && <div className={styles.globalError} role="alert">{notice}<button type="button" className={ui.button} onClick={() => setNotice('')}>닫기</button></div>,
  });
}
