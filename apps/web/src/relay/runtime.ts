// Test hooks of the relay adapter (window.FrameRuntime). Read-only for tests and measurements: values are computed when
// read, so a test polling FrameRuntime.playback.positionMs always sees the current position. Nothing here drives playback.

export type RuntimeRange = { startMs: number; endMs: number };

export type RuntimeWatch = {
  video: HTMLVideoElement | null;
  transport: 'hls.js' | 'native' | 'webrtc' | null;
  watch: { kind: string; broadcastId: string; path: string };
  playback: {
    mode: 'live' | 'history';
    status: string;
    positionMs: number | null;
    liveMs: number | null;
    seekStartMs: number | null;
    quality: string;
    activeQualityLabel: string | null;
    level: { height: number; width: number; bitrate: number } | null;
    latency: number | null;
    ranges: RuntimeRange[];
    startedAtMs: number | null;
  };
  session: { sid: string | null; opens: number; beats: number; beatFailures: number; lastBeatError: string | null };
  chat: { status: string; messages: number; lastAckId: string | null };
};

export interface RuntimeSource {
  runtime(): RuntimeWatch;
}

const REQUEST_LIMIT = 200;
const requests: string[] = [];
let active: RuntimeSource | null = null;
let installed = false;

// Media and API requests the adapter makes, without the origin (path and query), newest last.
export function logRequest(url: string) {
  let entry = url;
  try {
    const parsed = new URL(url, window.location.href);
    // The chat WebSocket (ws:/wss: on the page's host) counts as the page's own origin too.
    const own = parsed.origin === window.location.origin || (/^wss?:$/.test(parsed.protocol) && parsed.host === window.location.host);
    entry = own ? parsed.pathname + parsed.search : parsed.href;
  } catch { /* keep the raw value */ }
  requests.push(entry);
  if (requests.length > REQUEST_LIMIT) requests.splice(0, requests.length - REQUEST_LIMIT);
}

export function setRuntimeWatch(source: RuntimeSource | null) { active = source; }
export function clearRuntimeWatch(source: RuntimeSource) { if (active === source) active = null; }

const idlePlayback: RuntimeWatch['playback'] = {
  mode: 'live', status: 'paused', positionMs: null, liveMs: null, seekStartMs: null, quality: 'auto',
  activeQualityLabel: null, level: null, latency: null, ranges: [], startedAtMs: null,
};

export function installRuntime() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const current = () => (active ? active.runtime() : null);
  Object.defineProperty(window, 'FrameRuntime', {
    configurable: true,
    value: Object.freeze({
      adapter: 'relay' as const,
      get video() { return current()?.video ?? null; },
      get transport() { return current()?.transport ?? null; },
      get watch() { return current()?.watch ?? null; },
      get playback() { return current()?.playback ?? idlePlayback; },
      get session() { return current()?.session ?? { sid: null, opens: 0 }; },
      get chat() { return current()?.chat ?? { status: 'closed', messages: 0, lastAckId: null }; },
      get requests() { return requests.slice(); },
    }),
  });
}
