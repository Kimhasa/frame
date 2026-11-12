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

function avatar(label: string, color: string) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${color}"/><circle cx="72" cy="18" r="27" fill="#ffffff" opacity=".1"/><text x="48" y="61" text-anchor="middle" font-family="sans-serif" font-size="38" font-weight="700" fill="#fff">${label}</text></svg>`)}`;
}
const channelAvatar = (path: string, label: string, color: string) => live(path)?.avatarUrl ?? avatar(label, color);
const upcomingSchedule = initialPreviewSchedule().map((item, index) => {
  const date = new Date(Date.now() + (index * 2 + 1) * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
  return { ...item, title: ['사이드 프로젝트 #18 · 채팅 서버 연결하기', '금요일 작업실 · 포트폴리오 같이 다듬어요', '주말 코딩 모임 · 이번 주에 만든 것들'][index], at: Date.parse(`${date}T20:00+09:00`) };
});

const ownedChannel: PreviewChannel = {
  handle: 'spring', displayName: '개발하는 봄', avatarUrl: channelAvatar('workspace', '봄', '#3c9571'), bannerUrl: studio,
  description: '퇴근하고 만드는 작은 사이드 프로젝트. 화·목·일 저녁 8시, 같이 코딩하고 이야기해요 🌿',
  followerCount: 14860, verified: true, liveBroadcast: live('workspace'),
  videos: [
    { id: 'spring-v1', title: '퇴근 후 사이드 프로젝트 | 채팅 UI 처음부터 만들기', thumbnailUrl: live('workspace')?.thumbnailUrl ?? workspace, durationLabel: '2:34:18', publishedLabel: '1일 전', views: 12842, kind: 'vod' },
    { id: 'spring-v2', title: '디자인부터 구현까지 · 내 채널 페이지 완성한 날', thumbnailUrl: live('creative')?.thumbnailUrl ?? studio, durationLabel: '2:16:42', publishedLabel: '3일 전', views: 9631, kind: 'vod' },
    { id: 'spring-v3', title: 'React 컴포넌트 정리하면서 질문 받아요', thumbnailUrl: live('workspace-night')?.thumbnailUrl ?? workspace, durationLabel: '3:02:09', publishedLabel: '5일 전', views: 16458, kind: 'vod' },
    { id: 'spring-v4', title: '처음 만드는 라이브 플레이어, 소리까지 나온다!', thumbnailUrl: workspace, durationLabel: '2:48:36', publishedLabel: '1주 전', views: 22704, kind: 'vod' },
    { id: 'spring-v5', title: '주말 작업실 · 책상 정리하고 한 주 회고하기', thumbnailUrl: studio, durationLabel: '1:42:51', publishedLabel: '1주 전', views: 7385, kind: 'vod' },
    { id: 'spring-v6', title: '같이 공부해요 | TypeScript로 작은 앱 만들기', thumbnailUrl: live('workspace-build')?.thumbnailUrl ?? workspace, durationLabel: '2:57:24', publishedLabel: '2주 전', views: 18420, kind: 'vod' },
    { id: 'spring-c1', title: '드디어 채팅이 실시간으로 들어왔다', thumbnailUrl: workspace, durationLabel: '0:42', publishedLabel: '1일 전', views: 4821, kind: 'clip' },
    { id: 'spring-c2', title: '이 버그를 세 시간 동안 못 찾았다고?', thumbnailUrl: live('workspace-night')?.thumbnailUrl ?? workspace, durationLabel: '1:08', publishedLabel: '3일 전', views: 12640, kind: 'clip' },
    { id: 'spring-c3', title: '시청자분이 알려준 한 줄로 해결', thumbnailUrl: workspace, durationLabel: '0:36', publishedLabel: '5일 전', views: 7392, kind: 'clip' },
    { id: 'spring-c4', title: '새 작업실 첫 공개 🌱', thumbnailUrl: studio, durationLabel: '0:54', publishedLabel: '1주 전', views: 9160, kind: 'clip' },
  ],
  schedule: channelSchedule(upcomingSchedule),
  posts: [
    { id: 'spring-p1', title: '이번 주 방송 일정과 작업할 내용 🌿', body: '화요일에는 채팅 UI를 완성하고, 목요일에는 서버를 연결해 볼게요. 일요일은 여러분이 만든 것도 같이 구경해요! 저녁 8시에 만나요.', publishedLabel: '6시간 전' },
    { id: 'spring-p2', title: '채팅 UI 소스와 지난 방송 정리', body: '같이 만든 컴포넌트와 참고한 자료를 정리했어요. 지난 방송을 놓치셨다면 다시보기에서 이어 보실 수 있어요. 버그 찾아주신 분들 모두 고마워요!', publishedLabel: '2일 전' },
    { id: 'spring-p3', title: '팔로워 1만 명 감사합니다', body: '작은 작업실에서 시작한 방송을 이렇게 많은 분과 함께하게 됐네요. 앞으로도 천천히, 꾸준히 만들어 갈게요. 늘 편하게 들러주세요.', publishedLabel: '1주 전' },
  ],
};

const channels: readonly PreviewChannel[] = [
  ownedChannel,
  {
    handle: 'green', displayName: '초록', avatarUrl: channelAvatar('forest', '초', '#72916c'), bannerUrl: forest,
    description: '서두르지 않고 천천히. 숲속 마을과 작은 농장을 만들어요.',
    followerCount: 9274, verified: true, liveBroadcast: live('forest'),
    videos: [{ id: 'green-v1', title: '숲속 마을 12일차 · 드디어 집을 넓혔어요', thumbnailUrl: forest, durationLabel: '3:26:18', publishedLabel: '1일 전', views: 6586, kind: 'vod' }],
    schedule: [{ id: 'green-s1', dateLabel: '토요일', timeLabel: '오후 6:00', title: '주말 힐링 농장 · 온실 완성하기' }],
    posts: [],
  },
  {
    handle: 'pado', displayName: '파도', avatarUrl: channelAvatar('night-drive', '파', '#628ca1'), bannerUrl: night,
    description: '하루의 끝에서 만나는 음악과 드라이브. 오늘도 안전 운전!',
    followerCount: 6821, verified: false, liveBroadcast: live('night-drive'),
    videos: [{ id: 'pado-v1', title: '비 오는 야간 도로 · 오늘의 플레이리스트', thumbnailUrl: night, durationLabel: '2:12:31', publishedLabel: '2일 전', views: 3362, kind: 'vod' }],
    schedule: [], posts: [],
  },
  {
    handle: 'seojae', displayName: '서재', avatarUrl: channelAvatar('creative', '서', '#ba8b71'), bannerUrl: studio,
    description: '그림 그리고 디자인하는 조용한 작업실. 음악 들으며 같이 작업해요.',
    followerCount: 4370, verified: false, liveBroadcast: live('creative'),
    videos: [{ id: 'seojae-v1', title: '오래된 골목을 그리는 저녁', thumbnailUrl: studio, durationLabel: '2:18:14', publishedLabel: '3일 전', views: 2184, kind: 'vod' }], schedule: [], posts: [],
  },
  {
    handle: 'moa', displayName: '새벽두시', avatarUrl: channelAvatar('night-city', '새', '#777891'), bannerUrl: night,
    description: '잠들기 아쉬운 밤, 도시를 천천히 돌아봐요.',
    followerCount: 2310, verified: false, liveBroadcast: live('night-city'),
    videos: [{ id: 'moa-v1', title: '늦은 밤 산책 · 비 그친 도시', thumbnailUrl: night, durationLabel: '1:49:23', publishedLabel: '2일 전', views: 1275, kind: 'vod' }],
    schedule: [{ id: 'moa-s1', dateLabel: '금요일', timeLabel: '오후 11:00', title: '금요일 밤, 도시 한 바퀴' }],
    posts: [],
  },
  ...[
    ['refactor', '리팩터', 'workspace-night', workspace, 3780, '리', '#637b9b', '오늘도 한 줄씩. 오래된 코드를 고치고 좋은 코드를 고민해요.'],
    ['sogeum', '소금숲', 'forest-farm', forest, 7160, '소', '#a28c62', '농장 꾸미기와 마을 산책. 힐링 게임 좋아하는 사람들 모여요.'],
    ['dohwa', '도화', 'creative-pencil', studio, 3290, '도', '#a87486', '연필 한 자루로 남기는 오늘의 그림. 드로잉과 수다.'],
    ['joon', '준의 작업실', 'workspace-build', workspace, 1840, '준', '#6a898f', '작은 서비스를 직접 만들고 배포하는 개발 기록.'],
    ['gureum', '구름콩', 'forest-party', forest, 5860, '콩', '#83926e', '친구들이랑 놀면 뭐든 재밌지! 함께 만드는 우리 마을.'],
    ['dalbit', '달빛라디오', 'night-radio', night, 8120, '달', '#8c7da1', '사연과 음악이 있는 밤. 오늘 하루는 어땠나요?'],
    ['craft', '오후의 공방', 'creative-table', studio, 1260, '오', '#b59b78', '손으로 만드는 느린 일상. 그림, 공예 그리고 따뜻한 차.'],
  ].map(([handle, displayName, path, bannerUrl, followers, label, color, description]) => ({
    handle: String(handle), displayName: String(displayName), avatarUrl: channelAvatar(String(path), String(label), String(color)), bannerUrl: String(bannerUrl),
    description: String(description), followerCount: Number(followers), verified: false, liveBroadcast: live(String(path)),
    videos: [{ id: `${handle}-v1`, title: `${displayName}의 지난 방송 · 함께한 시간`, thumbnailUrl: live(String(path))?.thumbnailUrl ?? String(bannerUrl), durationLabel: '2:14:38', publishedLabel: '2일 전', views: Math.round(Number(followers) * .64), kind: 'vod' as const }], schedule: [], posts: [],
  })),
  { handle: 'byeoldam', displayName: '별담', avatarUrl: avatar('별', '#aa8192'), bannerUrl: studio, description: '책 읽고 글 쓰는 사람의 밤 기록.', followerCount: 3580, verified: false, liveBroadcast: null,
    videos: [{ id: 'byeoldam-v1', title: '한 주에 한 권 · 같이 읽는 밤', thumbnailUrl: studio, durationLabel: '1:36:24', publishedLabel: '4일 전', views: 1840, kind: 'vod' }],
    schedule: [{ id: 'byeoldam-s1', dateLabel: '일요일', timeLabel: '오후 9:00', title: '북토크 · 밑줄 친 문장들' }], posts: [] },
  { handle: 'maru', displayName: '마루', avatarUrl: avatar('마', '#8a9a7d'), bannerUrl: forest, description: '여행과 산책, 일상의 좋은 장면을 모아요.', followerCount: 2140, verified: false, liveBroadcast: null,
    videos: [{ id: 'maru-v1', title: '가을 숲길을 천천히 걸어요', thumbnailUrl: forest, durationLabel: '1:08:52', publishedLabel: '1주 전', views: 1274, kind: 'vod' }], schedule: [], posts: [] },
];

const preferenceKey = 'frame.design-community.v1';
const sessionKey = 'frame.design-session.v1';
const defaultFollows = ['spring', 'green', 'pado', 'seojae', 'sogeum', 'gureum', 'dalbit', 'byeoldam'];
const handles = new Set(channels.map(channel => channel.handle));
const previewProfile = { name: '봄', handle: ownedChannel.handle, avatarUrl: ownedChannel.avatarUrl };
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
  const [schedule, setSchedule] = useState(() => upcomingSchedule);
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
