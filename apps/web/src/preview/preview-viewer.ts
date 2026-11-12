import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { BroadcastSummary, ChatMessage, PlaybackView, ViewerAdapter, WatchState } from '../viewer-contract';
import workspace from './assets/code-workspace.svg';
import studio from './assets/creative-studio.webp';
import forest from './assets/forest-game.webp';
import night from './assets/night-drive.webp';

const startedAtMs = Date.now() - 1_080_000;
const samples = [
  { path: 'workspace', title: '작업실에서 같이 코딩해요', publisher: '개발하는 봄', category: '개발', thumbnailUrl: workspace, viewerCount: 128, sourceVideo: { width: 1920, height: 1080, fps: 60 } },
  { path: 'forest', title: '숲속에 작은 집을 지어요', publisher: '초록', category: '게임', thumbnailUrl: forest, viewerCount: 84 },
  { path: 'night-drive', title: '비 오는 밤, 드라이브', publisher: '파도', category: '일상', thumbnailUrl: night, viewerCount: 62 },
  { path: 'creative', title: '늦은 밤의 디자인 작업실', publisher: '서재', category: '창작', thumbnailUrl: studio, viewerCount: 37 },
] satisfies Omit<BroadcastSummary, 'id' | 'startedAtMs' | 'avatarUrl'>[];
export const previewBroadcasts: readonly BroadcastSummary[] = samples.map((item, index) => ({
  ...item, id: String(index + 1).padStart(32, '0'), avatarUrl: null, startedAtMs: startedAtMs - index * 300_000,
}));
const initialMessages: ChatMessage[] = [
  { id: '1', author: '모아', text: '안녕하세요. 오늘도 같이 작업해요.', sentAtMs: startedAtMs + 60_000 },
  { id: '2', author: '개발하는 봄', text: '반가워요! 화면과 소리 잘 들리나요?', sentAtMs: startedAtMs + 66_000 },
  { id: '3', author: '파도', text: '네, 둘 다 잘 보여요.', sentAtMs: startedAtMs + 74_000 },
  { id: '4', author: '초록', text: '작업하는 과정 보는 게 재밌네요.', sentAtMs: startedAtMs + 124_000 },
  { id: '5', author: '서재', text: '화질 자동으로 두니까 편하네요.', sentAtMs: startedAtMs + 141_000 },
  { id: '6', author: '모아', text: '지난 부분도 다시 볼 수 있군요.', sentAtMs: startedAtMs + 185_000 },
];

const idle = () => {};
const watchKinds = new Set<WatchState['kind']>(['loading', 'waiting', 'reconnecting', 'busy', 'ended', 'unavailable', 'error']);
const qualities = [{ id: 'auto', label: '자동' }, { id: 'source', label: '1080p (원본)' }, { id: '720p', label: '720p' }, { id: '480p', label: '480p' }];

function usePreviewScenario() {
  const [params, setParams] = useSearchParams();
  function retry() {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.delete('state');
      return next;
    }, { replace: true });
  }
  return { scenario: params.get('state'), retry };
}

export const previewViewer: ViewerAdapter = {
  useLive() {
    const { scenario, retry } = usePreviewScenario();
    if (scenario === 'loading') return { state: { kind: 'loading' }, retry };
    if (scenario === 'empty') return { state: { kind: 'empty' }, retry };
    if (scenario === 'error') return { state: { kind: 'error', message: '잠시 후 다시 시도해 주세요.' }, retry };
    return { state: { kind: 'ready', items: previewBroadcasts, stale: scenario === 'stale' }, retry };
  },
  useWatch({ path, id }) {
    const { scenario, retry } = usePreviewScenario();
    const broadcast = previewBroadcasts.find(item => item.path === path && item.id === id) ?? null;
    const sampleKind = watchKinds.has(scenario as WatchState['kind']) ? scenario as WatchState['kind'] : 'ready';
    const kind = broadcast ? sampleKind : 'unavailable';
    const state = useMemo<WatchState>(() => ({
      kind, broadcast,
      retryAfterMs: kind === 'busy' ? 15_000 : undefined,
      message: kind === 'ready' && scenario === 'quality-fallback' ? '선택한 화질을 지금 재생할 수 없어 자동으로 바꿨어요.' : undefined,
    }), [kind, broadcast, scenario]);
    const [status, setStatus] = useState<PlaybackView['status']>('playing');
    const [mode, setMode] = useState<PlaybackView['mode']>('live');
    const [muted, setMuted] = useState(true);
    const [volume, setVolume] = useState(.8);
    const [quality, setQuality] = useState('auto');
    const [position, setPosition] = useState(1_080_000);
    const [liveMs, setLiveMs] = useState(1_080_000);
    const [nickname, setNickname] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
    const [pending, setPending] = useState(false);
    const [unmuteAccepted, setUnmuteAccepted] = useState(false);
    const messageTimer = useRef<number | undefined>(undefined);
    const effectiveStatus = scenario === 'unmute' && !unmuteAccepted ? 'blocked' : status;

    useEffect(() => {
      if (kind !== 'ready') return;
      const clock = window.setInterval(() => setLiveMs(time => time + 1000), 1000);
      return () => window.clearInterval(clock);
    }, [kind]);

    useEffect(() => {
      if (kind !== 'ready' || effectiveStatus !== 'playing' || mode !== 'history') return;
      const clock = window.setInterval(() => setPosition(time => time + 1000), 1000);
      return () => window.clearInterval(clock);
    }, [kind, effectiveStatus, mode]);

    useEffect(() => () => window.clearTimeout(messageTimer.current), []);

    function send(text: string) {
      if (!nickname || pending || kind !== 'ready') return;
      setPending(true);
      messageTimer.current = window.setTimeout(() => {
        setMessages(previous => [...previous, { id: crypto.randomUUID(), author: nickname, text, sentAtMs: Date.now() }]);
        setPending(false);
      }, 130);
    }

    function togglePlaying() {
      if (effectiveStatus === 'blocked') {
        setUnmuteAccepted(true);
        setMuted(false);
      }
      if (effectiveStatus === 'playing' && mode === 'live') {
        setPosition(liveMs);
        setMode('history');
      }
      setStatus(effectiveStatus === 'playing' ? 'paused' : 'playing');
    }

    return {
      state,
      playback: {
        status: effectiveStatus, mode, muted, volume, canSetVolume: true, quality, qualities,
        timeline: broadcast ? { positionMs: mode === 'live' ? liveMs : Math.min(position, liveMs), liveMs, seekStartMs: 0 } : null,
        activeQualityLabel: quality === 'auto' ? '1080p' : null,
        attachVideo: idle, togglePlaying,
        toggleMuted: () => setMuted(!muted),
        setVolume: value => { setVolume(value); setMuted(value === 0); },
        seek: value => {
          setPosition(value);
          setMode(value >= liveMs - 1000 ? 'live' : 'history');
        },
        goLive: () => { setMode('live'); setStatus('playing'); },
        setQuality,
      },
      chat: {
        status: kind === 'ended' || kind === 'unavailable' ? 'closed' : kind === 'reconnecting' ? 'reconnecting' : kind === 'ready' ? 'connected' : 'connecting',
        nickname, messages: broadcast ? messages : [], pending, error: null, setNickname, send,
      },
      retry,
    };
  },
};
