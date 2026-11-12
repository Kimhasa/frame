import type { ReactNode } from 'react';
import type { BroadcastKey, BroadcastSummary, ChatAccountActions } from '../viewer-contract';
import type { WatchPointInput, WatchPointResult } from '../features/rewards/rewards-client';

export type PreviewVideo = {
  id: string;
  title: string;
  thumbnailUrl: string;
  durationLabel: string;
  publishedLabel: string;
  views: number;
  kind: 'vod' | 'clip';
};

export type PreviewSchedule = {
  id: string;
  dateLabel: string;
  timeLabel: string;
  title: string;
};

export type PreviewPost = {
  id: string;
  title: string;
  body: string;
  publishedLabel: string;
};

export type PreviewChannel = {
  id?: string;
  createdAtMs?: number;
  countryCode?: string | null;
  links?: readonly { title: string; url: string }[];
  videoCount?: number | null;
  totalViewCount?: number | null;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  description: string;
  followerCount: number;
  verified: boolean;
  liveBroadcast: BroadcastSummary | null;
  videos: readonly PreviewVideo[];
  schedule: readonly PreviewSchedule[];
  posts: readonly PreviewPost[];
};

export type CommunityPreviewRoutes = {
  following: ReactNode;
  channel: ReactNode;
  login: ReactNode;
  settings: ReactNode;
  channelManage: ReactNode;
  search: ReactNode;
  vod: ReactNode;
  vodWatch: ReactNode;
  clips: ReactNode;
  clipWatch: ReactNode;
  history: ReactNode;
  notifications: ReactNode;
  notificationUnreadCount?: number;
  moderation: ReactNode;
  reports: ReactNode;
  operatorReports?: ReactNode;
  schedule: ReactNode;
  recordings: ReactNode;
  analytics: ReactNode;
  integrations: ReactNode;
  revenue: ReactNode;
  members: ReactNode;
  missions: ReactNode;
  polls: ReactNode;
  rewards: ReactNode;
  developer: ReactNode;
  scenes: ReactNode;
  broadcast: ReactNode;
  transactions: ReactNode;
  paymentSuccess: ReactNode;
  paymentFail: ReactNode;
  profileMenu?: (onNavigate: () => void) => ReactNode;
  creatorSidebar?: (onNavigate: () => void) => ReactNode;
  requestLogin: () => void;
  followedChannels: readonly PreviewChannel[];
  channelHrefFor: (broadcast: BroadcastKey) => string | undefined;
  watchActionsFor?: (broadcast: BroadcastKey) => ReactNode;
  watchHistory?: { userId: string; record: (broadcast: BroadcastKey, signal: AbortSignal) => Promise<void> };
  watchRewards?: { userId: string; record: (input: WatchPointInput, signal: AbortSignal) => Promise<WatchPointResult> };
  watchChat?: ChatAccountActions;
  watchParticipationFor?: (broadcast: BroadcastKey) => ReactNode;
  overlay?: ReactNode;
};

export const channelManagePath = '/studio/channel';
export const moderationPath = '/studio/moderation';
export const reportsPath = '/studio/reports';
export const operatorReportsPath = '/admin/reports';
export const schedulePath = '/studio/schedule';
export const recordingsPath = '/studio/recordings';
export const analyticsPath = '/studio/analytics';
export const integrationsPath = '/studio/integrations';
export const revenuePath = '/studio/revenue';
export const membersPath = '/studio/members';
export const missionsPath = '/studio/missions';
export const pollsPath = '/studio/polls';
export const rewardsPath = '/studio/rewards';
export const developerPath = '/studio/developer';
export const scenesPath = '/studio/scenes';
export const broadcastPath = '/studio/broadcast';
export const transactionsPath = '/transactions';

export function channelPath(handle: string) {
  return `/channel/${encodeURIComponent(handle)}`;
}

export function mediaListPath(kind: PreviewVideo['kind']) {
  return kind === 'vod' ? '/vod' : '/clips';
}

export function mediaWatchPath(kind: PreviewVideo['kind'], handle: string, id: string) {
  return `${mediaListPath(kind)}/${encodeURIComponent(handle)}/${encodeURIComponent(id)}`;
}
