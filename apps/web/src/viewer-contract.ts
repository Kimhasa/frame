export type BroadcastKey = { path: string; id: string };

export type BroadcastSummary = BroadcastKey & {
  title: string;
  publisher: string;
  thumbnailUrl: string | null;
  avatarUrl: string | null;
  category: string | null;
  viewerCount: number | null;
  startedAtMs: number;
  sourceVideo?: { width: number; height: number; fps?: number };
};

export type LiveState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: readonly BroadcastSummary[]; stale?: boolean };

export type WatchState = {
  kind: 'loading' | 'ready' | 'waiting' | 'reconnecting' | 'busy' | 'ended' | 'unavailable' | 'error';
  broadcast: BroadcastSummary | null;
  message?: string;
  retryAfterMs?: number;
};

export type PlaybackView = {
  status: 'paused' | 'playing' | 'blocked';
  mode: 'live' | 'history';
  muted: boolean;
  volume: number;
  canSetVolume: boolean;
  // All positions are elapsed milliseconds from the same broadcast start.
  timeline: { positionMs: number; liveMs: number; seekStartMs: number | null } | null;
  quality: string;
  qualities: readonly { id: string; label: string }[];
  activeQualityLabel: string | null;
  // The existing HLS viewer session; absent in design, legacy sessionless and WHEP playback.
  viewerSessionId?: string | null;
  // Keep this ref callback stable across state updates. React passes null when the element detaches.
  attachVideo: (video: HTMLVideoElement | null) => void;
  togglePlaying: () => void;
  toggleMuted: () => void;
  setVolume: (volume: number) => void;
  seek: (positionMs: number) => void;
  goLive: () => void;
  setQuality: (id: string) => void;
};

export type ChatMessage = { id: string; author: string; text: string; sentAtMs: number; authorChannelId?: string; authorHandle?: string; isOwner?: boolean };
export type ChatAccountActions = { currentUserId?: string | null; onRequireLogin: () => void; onSessionChanged: (expectedUserId?: string) => void };

export type ChatView = {
  status: 'connecting' | 'connected' | 'reconnecting' | 'closed';
  nickname: string;
  messages: readonly ChatMessage[];
  // Set pending until the send is acknowledged or rejected. Publish errors before clearing it.
  pending: boolean;
  error: string | null;
  lastAckId?: string | null;
  // Account metadata is absent in the isolated design/legacy nickname flow.
  account?: { state: 'checking' | 'anonymous' | 'authenticated' | 'expired' | 'changed'; userId: string | null };
  canSend?: boolean;
  restriction?: { code: string; message: string; retryAtMs?: number };
  policy?: { slowMode: boolean; slowSeconds: number; followersOnly: boolean; blockLinks: boolean };
  reconnect?: () => void;
  setNickname: (name: string) => void;
  send: (text: string) => void;
};

export type WatchView = {
  state: WatchState;
  playback: PlaybackView;
  chat: ChatView;
  retry: () => void;
};

export type ViewerAdapter = {
  useLive: () => { state: LiveState; retry: () => void };
  useWatch: (key: BroadcastKey) => WatchView;
};

export function watchPath({ path, id }: BroadcastKey) {
  return `/watch/${encodeURIComponent(path)}/${encodeURIComponent(id)}`;
}
