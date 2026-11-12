import { useCallback, useEffect, useRef } from 'react';
import type { BroadcastKey } from '../../viewer-contract';

type Options = {
  broadcast: BroadcastKey;
  userId?: string;
  enabled: boolean;
  record?: (broadcast: BroadcastKey, signal: AbortSignal) => Promise<void>;
};
type Visit = {
  identity: string; mediaTime: number | null; wallTime: number | null; advancedMs: number;
  saved: boolean; stopped: boolean; active: boolean; attempts: number; nextAttemptAt: number;
  request: AbortController | null;
};

// Player intent is insufficient: only advancing, playable media counts as a watch.
// A visit is saved once, so deleting a record in another tab cannot be undone by a heartbeat.
export function useWatchHistoryRecorder(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const visit = useRef<Visit | null>(null);
  const identity = `${options.userId ?? ''}/${options.broadcast.path}/${options.broadcast.id}`;
  useEffect(() => {
    const current: Visit = { identity, mediaTime: null, wallTime: null, advancedMs: 0,
      saved: false, stopped: false, active: true, attempts: 0, nextAttemptAt: 0, request: null };
    visit.current = current;
    return () => { current.active = false; current.request?.abort(); };
  }, [identity]);

  return useCallback((video: HTMLVideoElement) => {
    const current = visit.current, options = latest.current;
    if (!current?.active || current.identity !== `${options.userId ?? ''}/${options.broadcast.path}/${options.broadcast.id}`) return;
    const now = performance.now(), mediaTime = video.currentTime;
    const previousTime = current.mediaTime, previousWall = current.wallTime;
    current.mediaTime = Number.isFinite(mediaTime) ? mediaTime : null; current.wallTime = now;
    if (current.saved || current.stopped || !options.enabled || !options.userId || !options.record) return;
    if (video.paused || video.ended || video.seeking || video.readyState < 2 || previousTime === null || previousWall === null || !Number.isFinite(mediaTime)) return;
    const elapsed = (mediaTime - previousTime) * 1000;
    // A seek or source swap is not evidence that the skipped frames were watched.
    if (elapsed <= 0 || elapsed > Math.max(1000, (now - previousWall) * 3 + 250)) return;
    current.advancedMs += Math.min(elapsed, Math.max(0, now - previousWall) * 3);
    if (current.advancedMs < 1000 || current.request || now < current.nextAttemptAt) return;
    const controller = new AbortController();
    current.request = controller; current.attempts++;
    void Promise.resolve().then(() => options.record!(options.broadcast, controller.signal)).then(() => {
      if (current.active && !controller.signal.aborted) current.saved = true;
    }).catch((failure: unknown) => {
      if (!current.active || controller.signal.aborted) return;
      const status = failure && typeof failure === 'object' && 'status' in failure ? Number(failure.status) : 0;
      if (current.attempts >= 3 || (status >= 400 && status < 500 && status !== 429)) current.stopped = true;
      else current.nextAttemptAt = performance.now() + (current.attempts === 1 ? 5000 : 15000);
    }).finally(() => { if (current.request === controller) current.request = null; });
  }, []);
}
