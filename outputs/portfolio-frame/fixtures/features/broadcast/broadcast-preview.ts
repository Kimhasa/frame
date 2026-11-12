import { initialMessages } from '../../preview/preview-viewer';
import type { ChatMessage } from '../../viewer-contract';
import workspace from '../../preview/assets/code-workspace.svg';
import studio from '../../preview/assets/creative-studio.webp';
import forest from '../../preview/assets/forest-game.webp';
import night from '../../preview/assets/night-drive.webp';

export const broadcastSources: readonly { id: string; name: string; detail: string; kind: 'window' | 'monitor'; image: string }[] = [
  { id: 'editor', name: 'workspace.ts — Visual Studio Code', detail: 'Visual Studio Code · 프로그램 창', kind: 'window', image: workspace },
  { id: 'discord', name: '작업실 — Discord', detail: 'Discord · 프로그램 창', kind: 'window', image: studio },
  { id: 'claude', name: 'Claude', detail: 'Claude · 프로그램 창', kind: 'window', image: studio },
  { id: 'chrome', name: '프로젝트 문서 — Chrome', detail: 'Chrome · 프로그램 창', kind: 'window', image: workspace },
  { id: 'game', name: '픽셀 어드벤처', detail: '게임 · 프로그램 창', kind: 'window', image: forest },
  { id: 'night', name: '도시의 밤 — Chrome', detail: 'Chrome · 프로그램 창', kind: 'window', image: night },
  { id: 'monitor-1', name: '모니터 1', detail: '2560 × 1440 · 주 모니터', kind: 'monitor', image: workspace },
  { id: 'monitor-2', name: '모니터 2', detail: '1920 × 1080', kind: 'monitor', image: studio },
];

export const broadcastCategories = ['개발·작업', '게임', '일상·이야기', '디자인·창작', '지식·탐색'];
export const broadcastVisibilities = ['전체 공개', '링크 공개', '비공개'];
export type BroadcastInfo = { title: string; category: string; visibility: string; tags: string };
export type BroadcastSettingsValues = {
  resolution: string;
  fps: string;
  autoBitrate: boolean;
  bitrate: number;
  codec: string;
  encoder: string;
  systemVolume: number;
  micVolume: number;
  systemMuted: boolean;
  micMuted: boolean;
  microphone: string;
  recording: boolean;
  storageGb: number;
};

export type BroadcastPreview = {
  info: BroadcastInfo;
  draft: BroadcastInfo;
  streamKey: string;
  chatOpen: boolean;
  nickname: string;
  messages: ChatMessage[];
};

export function createPreviewBroadcast(): BroadcastPreview {
  const info = { title: '퇴근 후 사이드 프로젝트 | 채팅 UI 완성하기', category: broadcastCategories[0], visibility: broadcastVisibilities[0], tags: '개발, 코딩, 작업실' };
  return {
    info, draft: { ...info }, streamKey: 'obs-spring?user=obs-spring&pass=preview-only-stream-key',
    chatOpen: true, nickname: '봄', messages: initialMessages,
  };
}
