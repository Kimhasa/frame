import { useCallback, useEffect, useRef } from 'react';
import type { BroadcastKey } from '../../viewer-contract';
import type { WatchPointInput, WatchPointResult } from './rewards-client';

type Options = {
  broadcast: BroadcastKey; userId?: string; viewerSessionId?: string | null; enabled: boolean;
  record?: (input: WatchPointInput, signal: AbortSignal) => Promise<WatchPointResult>;
};
type Visit = {
  identity: string; active: boolean; broadcast: BroadcastKey; sid: string; id: string; sequence: number;
  record: Options['record']; running: boolean; mediaTime: number | null; wallTime: number | null;
  eligibleMs: number; nextAt: number; request: AbortController | null; video: HTMLVideoElement | null; detach: (() => void) | null;
};
const PULSE_MS = 10000;

// Observed media progress is only an eligibility hint. The server checks the existing
// HLS viewer session, caps wall time and holds one account/channel visit lease.
export function useWatchRewardHeartbeat(options: Options) {
  const latest = useRef(options); latest.current = options;
  const visit = useRef<Visit | null>(null);
  const sid = options.viewerSessionId && /^[0-9a-f]{32}$/.test(options.viewerSessionId) ? options.viewerSessionId : '';
  const identity = `${options.userId ?? ''}/${options.broadcast.path}/${options.broadcast.id}/${sid}`;

  function body(current: Visit, watching: boolean, eligibleMs = 0): WatchPointInput {
    return { path: current.broadcast.path, broadcastId: current.broadcast.id, viewerSessionId: current.sid,
      visitId: current.id, sequence: current.sequence++, eligibleMs, watching };
  }
  function stop(current: Visit) {
    const release = current.running;
    current.running = false; current.mediaTime = null; current.wallTime = null; current.eligibleMs = 0; current.nextAt = 0;
    current.request?.abort(); current.request = null;
    if (release && current.record && current.sid && navigator.onLine) {
      // A later resume has a higher sequence, so a delayed release cannot stop it.
      void current.record(body(current, false), AbortSignal.timeout(5000)).catch(() => {});
    }
  }
  useEffect(() => {
    const current: Visit = { identity, active: true, broadcast: options.broadcast, sid, id: crypto.randomUUID(), sequence: 0, record: options.userId ? options.record : undefined,
      running: false, mediaTime: null, wallTime: null, eligibleMs: 0, nextAt: 0, request: null, video: null, detach: null };
    visit.current = current;
    const visibility = () => { if (document.visibilityState !== 'visible') stop(current); };
    const offline = () => stop(current), pagehide = () => stop(current);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('offline', offline); window.addEventListener('pagehide', pagehide);
    return () => {
      current.active = false; stop(current); current.detach?.();
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('offline', offline); window.removeEventListener('pagehide', pagehide);
    };
  }, [identity]);
  useEffect(() => { if (!options.enabled && visit.current) stop(visit.current); }, [options.enabled, identity]);

  return useCallback((video: HTMLVideoElement) => {
    const current = visit.current, settings = latest.current;
    const sessionId = settings.viewerSessionId && /^[0-9a-f]{32}$/.test(settings.viewerSessionId) ? settings.viewerSessionId : '';
    if (!current?.active || current.identity !== `${settings.userId ?? ''}/${settings.broadcast.path}/${settings.broadcast.id}/${sessionId}`) return;
    if (current.video !== video) {
      stop(current); current.detach?.(); current.video = video;
      const reset = () => stop(current), events = ['pause', 'waiting', 'stalled', 'seeking', 'emptied', 'error', 'ended', 'abort'];
      for (const event of events) video.addEventListener(event, reset);
      current.detach = () => { for (const event of events) video.removeEventListener(event, reset); };
    }
    if (!settings.enabled || !settings.userId || !current.record || !current.sid || document.visibilityState !== 'visible' || !navigator.onLine
      || video.paused || video.ended || video.seeking || video.error || video.readyState < 3 || !Number.isFinite(video.currentTime)) { stop(current); return; }
    const now = performance.now(), media = video.currentTime, oldMedia = current.mediaTime, oldWall = current.wallTime;
    current.mediaTime = media; current.wallTime = now;
    if (oldMedia === null || oldWall === null) return;
    const wall = now - oldWall, advanced = (media - oldMedia) * 1000;
    if (wall <= 0 || wall > 2000 || advanced <= 0 || advanced > Math.max(1000, wall * Math.max(1, Math.abs(video.playbackRate)) * 1.5 + 250)) { stop(current); return; }
    if (current.running) current.eligibleMs = Math.min(20000, current.eligibleMs + Math.min(wall, advanced));
    if (current.request || now < current.nextAt) return;
    const eligibleMs = current.running ? Math.floor(current.eligibleMs) : 0, input = body(current, true, eligibleMs), controller = new AbortController();
    current.running = true; current.eligibleMs = 0; current.nextAt = now + PULSE_MS; current.request = controller;
    void current.record(input, controller.signal).then(result => {
      if (!current.active || controller.signal.aborted || visit.current !== current) return;
      if (result.reason === 'watching_elsewhere' || result.reason === 'broadcast_unavailable' || result.reason === 'session_unavailable' || result.reason === 'stopped') {
        current.running = false; current.eligibleMs = 0; current.mediaTime = null; current.wallTime = null;
      }
    }).catch(() => {
      if (!current.active || controller.signal.aborted || visit.current !== current) return;
      // Never replay claimed time after an uncertain pulse. A fresh zero pulse
      // re-establishes the anchor, while the ledger remains server authoritative.
      current.running = false; current.eligibleMs = 0; current.mediaTime = null; current.wallTime = null; current.nextAt = performance.now() + PULSE_MS;
    }).finally(() => { if (current.request === controller) current.request = null; });
  }, []);
}
