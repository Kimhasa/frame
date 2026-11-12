import codingDesk from './assets/coding-desk.jpg';
import studyLaptop from './assets/study-laptop.jpg';
import gamingDesk from './assets/gaming-desk.jpg';
import arcade from './assets/retro-arcade.jpg';
import artTable from './assets/art-table.jpg';
import landscape from './assets/landscape.jpg';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { BroadcastSummary, ChatMessage, PlaybackView, ViewerAdapter, WatchState } from '../viewer-contract';
import workspace from './assets/code-workspace.svg';
import studio from './assets/creative-studio.webp';
import forest from './assets/forest-game.webp';
import night from './assets/night-drive.webp';

const startedAtMs = Date.now() - 5_220_000;
const samples = [
  { path: "workspace", title: "퇴근 후 사이드 프로젝트 | 채팅 UI 완성하기", publisher: "개발하는 봄", category: "개발", thumbnailUrl: workspace, viewerCount: 1284, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "forest", title: "첫 보스까지 노데스 도전… 오늘은 진짜 깬다", publisher: "초록", category: "게임", thumbnailUrl: forest, viewerCount: 842, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "night-drive", title: "비 오는 서울, 신청곡 들으면서 한 바퀴", publisher: "파도", category: "일상", thumbnailUrl: night, viewerCount: 316, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "creative", title: "아이패드로 그리는 가을 풍경 🍂 같이 작업해요", publisher: "서재", category: "창작", thumbnailUrl: studio, viewerCount: 207, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "workspace-night", title: "배포 전에 버그 하나만 더 잡고 갑니다", publisher: "리팩터", category: "개발", thumbnailUrl: codingDesk, viewerCount: 186, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "forest-farm", title: "오늘은 세팅부터! 새 키보드로 첫 게임", publisher: "소금숲", category: "게임", thumbnailUrl: gamingDesk, viewerCount: 563, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "night-city", title: "산책 다녀와서 수다 | 오늘도 고생했어요", publisher: "새벽두시", category: "일상", thumbnailUrl: landscape, viewerCount: 94, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "creative-pencil", title: "수채화 엽서 그려요 | 가을색 팔레트", publisher: "도화", category: "창작", thumbnailUrl: artTable, viewerCount: 128, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "workspace-build", title: "같이 공부해요 | React 질문도 받아요", publisher: "준의 작업실", category: "개발", thumbnailUrl: studyLaptop, viewerCount: 72, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "forest-party", title: "한 판만 더… 추억의 게임 켠왕 도전", publisher: "구름콩", category: "게임", thumbnailUrl: arcade, viewerCount: 237, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "night-radio", title: "수요일 저녁 라디오 · 오늘의 이야기", publisher: "달빛라디오", category: "일상", thumbnailUrl: landscape, viewerCount: 418, sourceVideo: { width: 1920, height: 1080, fps: 30 } },
  { path: "creative-table", title: "새 엽서 시안 뽑는 중｜조용한 작업 방송", publisher: "오후의 공방", category: "창작", thumbnailUrl: studio, viewerCount: 61, sourceVideo: { width: 1920, height: 1080, fps: 30 } }
] satisfies Omit<BroadcastSummary, 'id' | 'startedAtMs' | 'avatarUrl'>[];
function sampleAvatar(name: string, index: number) {
  const colors = [['#e4f4e9','#296c49'],['#e5edf7','#496482'],['#f5e8db','#8c6643'],['#eee8f7','#79618f'],['#e7f2f1','#477d76'],['#f8e7e9','#9c5c68']];
  const [bg,fg]=colors[index%colors.length];
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${bg}"/><text x="48" y="62" text-anchor="middle" font-family="Malgun Gothic,Arial,sans-serif" font-size="40" font-weight="700" fill="${fg}">${name.slice(0,1)}</text></svg>`);
}
export const previewBroadcasts: readonly BroadcastSummary[] = samples.map((item, index) => ({ ...item, id: (index + 1).toString(16).padStart(32, '0'), avatarUrl: sampleAvatar(item.publisher, index), startedAtMs: startedAtMs - index * 300_000 }));
export const initialMessages: ChatMessage[] = [
  {
    "id": "1",
    "author": "라떼한잔",
    "text": "퇴근하자마자 왔어요 ㅎㅎ",
    "sentAtMs": 1794395400000
  },
  {
    "id": "2",
    "author": "개발하는 봄",
    "text": "어서 오세요! 오늘은 채팅 화면 마무리해 볼게요.",
    "sentAtMs": 1794395416000
  },
  {
    "id": "3",
    "author": "도토리",
    "text": "오늘도 작업실 출석 🌱",
    "sentAtMs": 1794395432000
  },
  {
    "id": "4",
    "author": "노을빛",
    "text": "지난 방송 다시보기 보고 왔어요",
    "sentAtMs": 1794395448000
  },
  {
    "id": "5",
    "author": "코드한줄",
    "text": "왼쪽 여백 지금 딱 좋은 것 같아요",
    "sentAtMs": 1794395464000
  },
  {
    "id": "6",
    "author": "작은항해",
    "text": "소리 잘 들려요!",
    "sentAtMs": 1794395480000
  },
  {
    "id": "7",
    "author": "라떼한잔",
    "text": "저도 옆에 켜두고 사이드 프로젝트 하는 중",
    "sentAtMs": 1794395496000
  },
  {
    "id": "8",
    "author": "초록물결",
    "text": "녹색 버튼 색 예쁘다",
    "sentAtMs": 1794395512000
  },
  {
    "id": "9",
    "author": "루프",
    "text": "모바일에서도 채팅 볼 수 있나요?",
    "sentAtMs": 1794395528000
  },
  {
    "id": "10",
    "author": "개발하는 봄",
    "text": "네, 잠깐 뒤에 모바일 화면도 같이 볼게요.",
    "sentAtMs": 1794395544000
  },
  {
    "id": "11",
    "author": "유자차",
    "text": "방금 들어왔는데 어디까지 했어요?",
    "sentAtMs": 1794395560000
  },
  {
    "id": "12",
    "author": "밤의서재",
    "text": "채팅창 만드는 중이에요!",
    "sentAtMs": 1794395576000
  },
  {
    "id": "13",
    "author": "코드한줄",
    "text": "메시지 길면 줄바꿈은 어떻게 되나요",
    "sentAtMs": 1794395592000
  },
  {
    "id": "14",
    "author": "개발하는 봄",
    "text": "긴 메시지부터 확인해 볼게요. 좋은 질문이에요.",
    "sentAtMs": 1794395608000
  },
  {
    "id": "15",
    "author": "오후네시",
    "text": "이렇게 하나씩 만드는 과정이 좋아요",
    "sentAtMs": 1794395624000
  },
  {
    "id": "16",
    "author": "작은여백",
    "text": "주말에 저도 한 번 만들어 봐야겠네요",
    "sentAtMs": 1794395640000
  },
  {
    "id": "17",
    "author": "구름사이",
    "text": "와 방금 바로 반영됐다",
    "sentAtMs": 1794395656000
  },
  {
    "id": "18",
    "author": "모닝커피",
    "text": "오늘 BGM도 편안하네요",
    "sentAtMs": 1794395672000
  },
  {
    "id": "19",
    "author": "푸른노트",
    "text": "첫 방문인데 분위기 좋아요",
    "sentAtMs": 1794395688000
  },
  {
    "id": "20",
    "author": "도토리",
    "text": "어서오세요 🌿",
    "sentAtMs": 1794395704000
  },
  {
    "id": "21",
    "author": "별빛산책",
    "text": "폰으로 보고 있는데 글씨 잘 보여요",
    "sentAtMs": 1794395720000
  },
  {
    "id": "22",
    "author": "루프",
    "text": "모바일 확인 감사합니다!",
    "sentAtMs": 1794395736000
  },
  {
    "id": "23",
    "author": "개발하는 봄",
    "text": "좋아요, 다음은 입력창 포커스도 확인해 볼게요.",
    "sentAtMs": 1794395752000
  },
  {
    "id": "24",
    "author": "라떼한잔",
    "text": "같이 작업하니까 집중 잘 되네요 ㅋㅋ",
    "sentAtMs": 1794395768000
  },
  {
    "id": "25",
    "author": "초록물결",
    "text": "초록 버튼 누르고 싶다",
    "sentAtMs": 1794395784000
  },
  {
    "id": "26",
    "author": "밤의서재",
    "text": "이 부분 한 번만 다시 보여 주세요",
    "sentAtMs": 1794395800000
  },
  {
    "id": "27",
    "author": "작은항해",
    "text": "되감기로 잠깐 보고 올게요",
    "sentAtMs": 1794395816000
  },
  {
    "id": "28",
    "author": "코드한줄",
    "text": "오 이제 줄바꿈 자연스럽네요",
    "sentAtMs": 1794395832000
  },
  {
    "id": "29",
    "author": "유자차",
    "text": "오늘도 하나 배워갑니다",
    "sentAtMs": 1794395848000
  },
  {
    "id": "30",
    "author": "개발하는 봄",
    "text": "궁금한 점 있으면 편하게 남겨 주세요!",
    "sentAtMs": 1794395864000
  }
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
    const [position, setPosition] = useState(5_220_000);
    const [liveMs, setLiveMs] = useState(5_220_000);
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
