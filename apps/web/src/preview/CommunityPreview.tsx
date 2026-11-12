import { startTransition, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router';
import { CreatorSidebar } from '../features/account/CreatorSidebar';
import { ProfileMenu } from '../features/account/ProfileMenu';
import { AnalyticsPage } from '../features/analytics/AnalyticsPage';
import { BroadcastPage } from '../features/broadcast/BroadcastPage';
import { LocalObsStudio } from '../features/broadcast/LocalObsStudio';
import type { ViewerAdapter } from '../viewer-contract';
import { createPreviewBroadcast } from '../features/broadcast/broadcast-preview';
import { ChannelManagePage } from '../features/channel-manage/ChannelManagePage';
import { ChannelPage } from '../features/channel/ChannelPage';
import { createPreviewDeveloper, DeveloperPage } from '../features/developer/DeveloperPage';
import { DonationButton } from '../features/donation/DonationButton';
import { DonationDialog } from '../features/donation/DonationDialog';
import type { DonationDraft } from '../features/donation/donation-preview';
import { FollowingPage } from '../features/following/FollowingPage';
import { HistoryPage } from '../features/history/HistoryPage';
import { IntegrationsPage } from '../features/integrations/IntegrationsPage';
import { LoginPage } from '../features/login/LoginPage';
import { MediaListPage, MediaWatchPage } from '../features/media/MediaPages';
import { MembersPage } from '../features/members/MembersPage';
import { createPreviewMissions, MissionsPage } from '../features/missions/MissionsPage';
import { ModerationPage, ReportsPage } from '../features/moderation/ModerationPages';
import { NotificationsPage } from '../features/notifications/NotificationsPage';
import { createPreviewPolls, PollsPage } from '../features/polls/PollsPage';
import { RecordingsPage } from '../features/recordings/RecordingsPage';
import { RevenuePage } from '../features/revenue/RevenuePage';
import { createPreviewRewards, RewardsPage } from '../features/rewards/RewardsPage';
import { createPreviewScenes, ScenesPage } from '../features/scenes/ScenesPage';
import { channelSchedule, initialPreviewSchedule, SchedulePage } from '../features/schedule/SchedulePage';
import { SearchPage } from '../features/search/SearchPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TransactionsPage } from '../features/transactions/TransactionsPage';
import { PaymentHistoryPage } from '../features/payments/PaymentHistoryPage';
import { PaymentResultPage } from '../features/payments/PaymentResultPage';
import { createPreviewTransactions } from '../features/transactions/transactions-preview';
import { channelPath } from './community-types';
import type { CommunityPreviewRoutes, PreviewChannel } from './community-types';
import { previewBroadcasts } from './preview-viewer';
import workspace from './assets/code-workspace.svg';
import studio from './assets/creative-studio.webp';
import forest from './assets/forest-game.webp';
import night from './assets/night-drive.webp';

function live(path: string) {
  return previewBroadcasts.find(broadcast => broadcast.path === path) ?? null;
}

const ownedChannel: PreviewChannel = {
  handle: 'spring', displayName: '개발하는 봄', avatarUrl: null, bannerUrl: studio,
  description: '만들고 배우는 시간을 나누는 작은 작업실. 편하게 들렀다 가세요.',
  followerCount: 1284, verified: true, liveBroadcast: live('workspace'),
  videos: [
    { id: 'spring-v1', title: '조용히 개발해요 · 작은 화면부터', thumbnailUrl: workspace, durationLabel: '2:14:36', publishedLabel: '2일 전', views: 1284, kind: 'vod' },
    { id: 'spring-v2', title: '작업실 정리하고 다음 기능 준비하기', thumbnailUrl: studio, durationLabel: '1:48:12', publishedLabel: '4일 전', views: 902, kind: 'vod' },
    { id: 'spring-v3', title: '플레이어를 처음부터 만들어보기', thumbnailUrl: workspace, durationLabel: '3:08:45', publishedLabel: '1주 전', views: 764, kind: 'vod' },
    { id: 'spring-c1', title: '딱 맞게 붙은 첫 레이아웃', thumbnailUrl: workspace, durationLabel: '0:42', publishedLabel: '1일 전', views: 312, kind: 'clip' },
    { id: 'spring-c2', title: '오늘의 작업실 한 장면', thumbnailUrl: studio, durationLabel: '0:28', publishedLabel: '3일 전', views: 208, kind: 'clip' },
  ],
  schedule: [],
  posts: [
    { id: 'spring-p1', title: '작업실 방송 안내', body: '화요일과 목요일 저녁에 만나요. 궁금한 주제가 있다면 채팅으로 알려주세요.', publishedLabel: '1일 전' },
    { id: 'spring-p2', title: '다음 작업은 플레이어', body: '실시간 시청 화면과 되감기 경험을 살펴볼 예정이에요.', publishedLabel: '4일 전' },
  ],
};

const channels: readonly PreviewChannel[] = [
  ownedChannel,
  {
    handle: 'green', displayName: '초록', avatarUrl: null, bannerUrl: forest,
    description: '숲에서 발견한 풍경을 따라 천천히 게임을 즐겨요.',
    followerCount: 842, verified: false, liveBroadcast: live('forest'),
    videos: [{ id: 'green-v1', title: '숲길을 따라 첫 집터 찾기', thumbnailUrl: forest, durationLabel: '1:26:18', publishedLabel: '3일 전', views: 586, kind: 'vod' }],
    schedule: [{ id: 'green-s1', dateLabel: '토요일', timeLabel: '오후 6:00', title: '숲속 집에 작은 정원 만들기' }],
    posts: [],
  },
  {
    handle: 'pado', displayName: '파도', avatarUrl: null, bannerUrl: night,
    description: '조용한 음악과 함께 밤의 도시를 달려요.',
    followerCount: 416, verified: false, liveBroadcast: live('night-drive'),
    videos: [{ id: 'pado-v1', title: '가로등을 따라 한 바퀴', thumbnailUrl: night, durationLabel: '1:12:31', publishedLabel: '5일 전', views: 362, kind: 'vod' }],
    schedule: [], posts: [],
  },
  {
    handle: 'seojae', displayName: '서재', avatarUrl: null, bannerUrl: studio,
    description: '그림과 디자인을 하나씩 완성하는 시간을 나눕니다.',
    followerCount: 670, verified: false, liveBroadcast: live('creative'),
    videos: [], schedule: [], posts: [],
  },
  {
    handle: 'moa', displayName: '모아', avatarUrl: null, bannerUrl: null,
    description: '하루 동안 모은 아이디어를 함께 정리해요.',
    followerCount: 310, verified: false, liveBroadcast: null,
    videos: [{ id: 'moa-v1', title: '한 주의 아이디어 노트', thumbnailUrl: studio, durationLabel: '49:23', publishedLabel: '6일 전', views: 275, kind: 'vod' }],
    schedule: [{ id: 'moa-s1', dateLabel: '일요일', timeLabel: '오후 7:00', title: '한 주의 아이디어를 정리해요' }],
    posts: [],
  },
];

const preferenceKey = 'frame.design-community.v1';
const sessionKey = 'frame.design-session.v1';
const defaultFollows = ['spring', 'green', 'moa'];
const handles = new Set(channels.map(channel => channel.handle));
const previewProfile = { name: '봄', handle: ownedChannel.handle, avatarUrl: null };
type Preferences = { follows: string[]; alerts: string[] };
type LoginOrigin = { from: string; followHandle?: string; donationHandle?: string; replaced?: boolean };
type DonationIntent = { handle: string; from: string; draft?: DonationDraft };

function storedSignIn(storage: 'localStorage' | 'sessionStorage') {
  try { return window[storage].getItem(sessionKey) === '1'; }
  catch { return false; }
}

function writeSignIn(storage: 'localStorage' | 'sessionStorage', value: boolean) {
  try {
    if (value) window[storage].setItem(sessionKey, '1');
    else window[storage].removeItem(sessionKey);
  } catch { /* Keep the session in memory if browser storage is unavailable. */ }
}

function withFollow(current: Preferences, handle: string, followed: boolean): Preferences {
  if (current.follows.includes(handle) === followed) return current;
  return followed
    ? { ...current, follows: [...current.follows, handle] }
    : { follows: current.follows.filter(item => item !== handle), alerts: current.alerts.filter(item => item !== handle) };
}

function readPreferences(): Preferences {
  const validHandles = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && handles.has(item)))]
    : [];
  try {
    const raw = localStorage.getItem(preferenceKey);
    if (raw) {
      const value = JSON.parse(raw) as Partial<Preferences> | null;
      if (value && Array.isArray(value.follows) && Array.isArray(value.alerts)) {
        const follows = validHandles(value.follows);
        return { follows, alerts: validHandles(value.alerts).filter(handle => follows.includes(handle)) };
      }
    }
  } catch { /* Browser storage may be unavailable. */ }
  return { follows: defaultFollows, alerts: [] };
}

function FollowingRoute({ followedChannels, signedIn, onLogin }: {
  followedChannels: readonly PreviewChannel[];
  signedIn: boolean;
  onLogin: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const scenario = params.get('state');
  const state = !signedIn ? 'login' : scenario === 'loading' || scenario === 'error' ? scenario : 'ready';
  const visibleChannels = scenario === 'empty' ? []
    : scenario === 'offline' ? followedChannels.map(channel => ({ ...channel, liveBroadcast: null }))
    : followedChannels;
  function resetScenario() {
    const next = new URLSearchParams(params);
    next.delete('state');
    setParams(next, { replace: true });
  }
  return <FollowingPage channels={visibleChannels} state={state} onRetry={resetScenario} onPreviewSignIn={onLogin} />;
}

function ChannelRoute({ previewChannels, preferences, signedIn, onFollow, onAlert, onDonate }: {
  previewChannels: readonly PreviewChannel[];
  preferences: Preferences;
  signedIn: boolean;
  onFollow: (handle: string) => void;
  onAlert: (handle: string) => void;
  onDonate: (handle: string) => void;
}) {
  const { handle = '' } = useParams();
  const [params] = useSearchParams();
  const scenario = params.get('state');
  const channel = previewChannels.find(item => item.handle === handle);
  const followed = preferences.follows.includes(handle);
  const initialFollow = defaultFollows.includes(handle);
  return <ChannelPage
    key={handle}
    channel={channel ? {
      ...channel,
      liveBroadcast: scenario === 'offline' ? null : channel.liveBroadcast,
      followerCount: channel.followerCount + Number(followed) - Number(initialFollow),
    } : null}
    state={scenario === 'restricted' ? 'restricted' : 'ready'}
    followed={signedIn && followed}
    notificationsOn={signedIn && preferences.alerts.includes(handle)}
    onToggleFollow={() => onFollow(handle)}
    onToggleNotifications={() => onAlert(handle)}
    actions={channel && <DonationButton onClick={() => onDonate(handle)} />}
  />;
}

export default function CommunityPreview({ render, viewer }: { render: (routes: CommunityPreviewRoutes) => ReactNode; viewer: ViewerAdapter }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [schedule, setSchedule] = useState(initialPreviewSchedule);
  const [missions, setMissions] = useState(createPreviewMissions);
  const [polls, setPolls] = useState(createPreviewPolls);
  const [rewards, setRewards] = useState(createPreviewRewards);
  const [developer, setDeveloper] = useState(createPreviewDeveloper);
  const [scenes, setScenes] = useState(createPreviewScenes);
  const [broadcast, setBroadcast] = useState(createPreviewBroadcast);
  const [transactions] = useState(createPreviewTransactions);
  const [donation, setDonation] = useState<DonationIntent | null>(null);
  const [signedIn, setSignedIn] = useState(() => storedSignIn('localStorage') || storedSignIn('sessionStorage'));
  const location = useLocation();
  const isSettings = Boolean(useMatch('/settings'));
  const isStudio = Boolean(useMatch('/studio/*'));
  const isTransactions = Boolean(useMatch('/transactions'));
  const navigate = useNavigate();
  const origin = (location.state as { previewLogin?: LoginOrigin } | null)?.previewLogin;
  const currentUrl = location.pathname + location.search + location.hash;

  useEffect(() => {
    try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); }
    catch { /* Keep the preview functional without browser storage. */ }
  }, [preferences]);

  useEffect(() => {
    if (donation && donation.from !== currentUrl && location.pathname !== '/login') setDonation(null);
  }, [donation, currentUrl, location.pathname]);

  function openDonation(handle: string) {
    if (handles.has(handle)) setDonation({ handle, from: currentUrl });
  }

  function donationLogin(draft: DonationDraft) {
    if (!donation) return;
    setDonation({ ...donation, draft });
    navigate('/login', { state: { previewLogin: { from: donation.from, donationHandle: donation.handle } satisfies LoginOrigin } });
  }

  function closeDonation() {
    setDonation(null);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-channel-action="donate"]')?.focus({ preventScroll: true }));
  }

  function requestLogin(followHandle?: string) {
    navigate('/login', { state: { previewLogin: { from: currentUrl, followHandle } satisfies LoginOrigin } });
  }

  function completeSignIn(remember: boolean) {
    writeSignIn('localStorage', remember);
    writeSignIn('sessionStorage', !remember);
    setSignedIn(true);
    const handle = origin?.followHandle;
    if (handle && handles.has(handle)) setPreferences(current => withFollow(current, handle, true));
    if (origin?.donationHandle && handles.has(origin.donationHandle)) {
      const donationHandle = origin.donationHandle;
      setDonation(current => current?.handle === donationHandle ? current : { handle: donationHandle, from: origin.from });
    }
    if (origin?.replaced) navigate(origin.from, { replace: true });
    else if (origin) navigate(-1);
    else navigate('/live', { replace: true });
  }

  function signOut() {
    setDonation(null);
    writeSignIn('localStorage', false);
    writeSignIn('sessionStorage', false);
    if (isSettings || isStudio || isTransactions) {
      startTransition(() => {
        navigate('/live', { replace: true });
        setSignedIn(false);
      });
    } else setSignedIn(false);
  }

  function toggleFollow(handle: string) {
    if (!handles.has(handle)) return;
    if (!signedIn) requestLogin(handle);
    else setPreferences(current => withFollow(current, handle, !current.follows.includes(handle)));
  }

  function toggleAlert(handle: string) {
    if (!signedIn) return;
    setPreferences(current => {
      if (!current.follows.includes(handle)) return current;
      const alerts = current.alerts.includes(handle)
        ? current.alerts.filter(item => item !== handle)
        : [...current.alerts, handle];
      return { ...current, alerts };
    });
  }

  const previewChannels = channels.map(channel => channel === ownedChannel ? { ...channel, schedule: channelSchedule(schedule) } : channel);
  const followedChannels = signedIn ? previewChannels.filter(channel => preferences.follows.includes(channel.handle)) : [];
  const donationChannel = donation?.from === currentUrl ? previewChannels.find(channel => channel.handle === donation.handle) : undefined;
  const signInFirst = <Navigate to="/login" replace state={{ previewLogin: { from: currentUrl, replaced: true } satisfies LoginOrigin }} />;
  return render({
    following: <FollowingRoute followedChannels={followedChannels} signedIn={signedIn} onLogin={() => requestLogin()} />,
    channel: <ChannelRoute previewChannels={previewChannels} preferences={preferences} signedIn={signedIn} onFollow={toggleFollow} onAlert={toggleAlert} onDonate={openDonation} />,
    login: <LoginPage
      backTo={origin && !origin.replaced ? origin.from : '/live'}
      onBack={origin && !origin.replaced ? () => navigate(-1) : undefined}
      followRequired={Boolean(origin?.followHandle)}
      onPreviewSignIn={completeSignIn}
    />,
    settings: signedIn ? <SettingsPage profile={previewProfile} /> : signInFirst,
    channelManage: signedIn ? <ChannelManagePage channel={ownedChannel} /> : signInFirst,
    search: <SearchPage channels={channels} />,
    vod: <MediaListPage kind="vod" channels={channels} />,
    vodWatch: <MediaWatchPage kind="vod" channels={channels} />,
    clips: <MediaListPage kind="clip" channels={channels} />,
    clipWatch: <MediaWatchPage kind="clip" channels={channels} />,
    history: <HistoryPage channels={channels} signedIn={signedIn} onLogin={() => requestLogin()} />,
    notifications: <NotificationsPage channels={channels} signedIn={signedIn} onLogin={() => requestLogin()} />,
    moderation: signedIn ? <ModerationPage /> : signInFirst,
    reports: signedIn ? <ReportsPage /> : signInFirst,
    schedule: signedIn ? <SchedulePage items={schedule} onChange={setSchedule} /> : signInFirst,
    recordings: signedIn ? <RecordingsPage /> : signInFirst,
    analytics: signedIn ? <AnalyticsPage /> : signInFirst,
    integrations: signedIn ? <IntegrationsPage /> : signInFirst,
    revenue: signedIn ? <RevenuePage /> : signInFirst,
    members: signedIn ? <MembersPage /> : signInFirst,
    missions: signedIn ? <MissionsPage items={missions} onChange={setMissions} /> : signInFirst,
    polls: signedIn ? <PollsPage preview={polls} onChange={setPolls} /> : signInFirst,
    rewards: signedIn ? <RewardsPage preview={rewards} onChange={setRewards} /> : signInFirst,
    developer: signedIn ? <DeveloperPage preview={developer} onChange={setDeveloper} /> : signInFirst,
    scenes: signedIn ? <ScenesPage preview={scenes} onChange={setScenes} /> : signInFirst,
    broadcast: signedIn ? import.meta.env.FRAME_STUDIO_ENABLED
      ? <LocalObsStudio viewer={viewer} preview={broadcast} onChange={setBroadcast} />
      : <BroadcastPage preview={broadcast} onChange={setBroadcast} /> : signInFirst,
    transactions: signedIn ? import.meta.env.FRAME_STUDIO_ENABLED ? <PaymentHistoryPage channels={channels} /> : <TransactionsPage items={transactions} /> : signInFirst,
    paymentSuccess: <PaymentResultPage />,
    paymentFail: <PaymentResultPage failed />,
    profileMenu: signedIn ? onNavigate => <ProfileMenu key={location.key} profile={previewProfile}
      channelName={ownedChannel.displayName} channelHref={channelPath(ownedChannel.handle)}
      onNavigate={onNavigate} onSignOut={signOut} /> : undefined,
    creatorSidebar: signedIn && isStudio ? onNavigate => <CreatorSidebar
      channelName={ownedChannel.displayName} channelHandle={ownedChannel.handle} initial={previewProfile.name} onNavigate={onNavigate} /> : undefined,
    requestLogin,
    overlay: donation && donationChannel && <DonationDialog key={`${donationChannel.handle}:${donation.from}`} channel={donationChannel}
      signedIn={signedIn} initialDraft={donation.draft} onLogin={donationLogin} onDismiss={closeDonation} />,
    watchActionsFor: ({ id, path }) => {
      const channel = previewChannels.find(item => item.liveBroadcast?.id === id && item.liveBroadcast.path === path);
      return channel ? <DonationButton onClick={() => openDonation(channel.handle)} /> : null;
    },
    followedChannels,
    channelHrefFor: ({ id, path }) => {
      const channel = channels.find(item => item.liveBroadcast?.id === id && item.liveBroadcast.path === path);
      return channel ? channelPath(channel.handle) : undefined;
    },
  });
}
