import type { ViewerAdapter } from './viewer-contract';

const idle = () => {};

export const disconnectedViewer: ViewerAdapter = {
  useLive: () => ({ state: { kind: 'error', message: '방송 목록을 불러올 수 없어요.' }, retry: idle }),
  useWatch: () => ({
    state: { kind: 'unavailable', broadcast: null },
    playback: {
      status: 'paused', mode: 'live', muted: true, volume: 1, canSetVolume: false,
      timeline: null, quality: 'auto', qualities: [], activeQualityLabel: null,
      attachVideo: idle, togglePlaying: idle, toggleMuted: idle, setVolume: idle,
      seek: idle, goLive: idle, setQuality: idle,
    },
    chat: { status: 'closed', nickname: '', messages: [], pending: false, error: null, setNickname: idle, send: idle },
    retry: idle,
  }),
};
