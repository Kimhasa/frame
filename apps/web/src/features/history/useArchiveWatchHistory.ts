import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { archiveHistoryApi, sameArchiveReceipt } from './archive-history-client';
import type { ArchiveHistoryReceipt, ArchiveHistoryUpdate, ArchiveKind } from './archive-history-client';

type Options = {
  kind: ArchiveKind; mediaId: string; durationMs: number; visitKey: string; enabled: boolean;
  session?: AccountSession | null; video: RefObject<HTMLVideoElement | null>; onSessionChanged?: () => void;
};
type View = { identity: string; phase: 'loading' | 'ready' | 'error' | 'conflict'; receipt: ArchiveHistoryReceipt | null; busy: boolean; started: boolean; message: string };
type Position = { positionMs: number; completed: boolean };
type Visit = {
  identity: string; owner: string; csrf: string; kind: ArchiveKind; mediaId: string; active: boolean; stopped: boolean;
  receipt: ArchiveHistoryReceipt | null; read: AbortController | null; write: AbortController | null;
  queued: Position | null; mediaTime: number | null; wallTime: number | null; advancedMs: number;
  lastPositionMs: number | null; lastEvidenceAt: number; dirty: boolean; nextSaveAt: number; started: boolean;
};
const conflictMessage = '다른 화면에서 시청 기록이 변경됐어요. 기록을 다시 연결해 주세요.';
const saveMessage = '시청 위치를 저장하지 못했어요. 기록을 다시 연결해 주세요.';

// Archive history is a saved position, independent of the live/DVR recorder and rewards.
// A receipt is never silently replaced after deletion or a conflicting tab write.
export function useArchiveWatchHistory(options: Options) {
  const latest = useRef(options); latest.current = options;
  const identity = `${options.session?.user?.id ?? ''}/${options.kind}/${options.mediaId}/${options.visitKey}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const visit = useRef<Visit | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>({ identity, phase: 'loading', receipt: null, busy: false, started: false, message: '' });

  function valid(current: Visit) {
    const settings = latest.current;
    return current.active && visit.current === current && identityRef.current === current.identity
      && settings.enabled && settings.session?.user?.id === current.owner;
  }
  function display(current: Visit, changes: Partial<View>) {
    if (valid(current)) setView(previous => ({ ...(previous.identity === current.identity ? previous : {
      identity: current.identity, phase: 'loading' as const, receipt: null, busy: false, started: false, message: '',
    }), ...changes }));
  }
  function resetAnchor(current: Visit, discard = false) {
    current.mediaTime = null; current.wallTime = null; current.advancedMs = 0;
    if (discard) { current.lastPositionMs = null; current.dirty = false; }
  }
  function stop(current: Visit, phase: 'error' | 'conflict', message: string, failure?: unknown) {
    current.stopped = true; current.queued = null; current.read?.abort(); current.write?.abort(); resetAnchor(current, true);
    display(current, { phase, busy: false, receipt: null, message });
    if (valid(current) && failure instanceof AccountError && (failure.status === 401 || ['SESSION_CHANGED', 'CSRF_INVALID'].includes(failure.code))) latest.current.onSessionChanged?.();
  }
  function accept(current: Visit, result: ArchiveHistoryReceipt) {
    current.receipt = result;
    display(current, { phase: 'ready', receipt: result, busy: false, message: '', started: current.started });
  }
  function maximum(current: Visit, element?: HTMLVideoElement) {
    const declared = latest.current.durationMs, saved = current.receipt?.item?.durationMs ?? declared;
    const native = element && Number.isFinite(element.duration) && element.duration > 0 ? Math.floor(element.duration * 1000) : declared;
    return Math.max(0, Math.floor(Math.min(declared, saved, native)));
  }
  async function drain(current: Visit) {
    if (!valid(current) || current.stopped || !current.receipt || current.write || current.read || !current.queued || !navigator.onLine) return;
    const position = current.queued; current.queued = null;
    const before = current.receipt, controller = new AbortController(); current.write = controller;
    const input: ArchiveHistoryUpdate = { epoch: before.epoch, id: before.item?.id ?? null, version: before.item?.version ?? 0, ...position };
    display(current, { busy: true });
    try {
      const result = await archiveHistoryApi.put(current.kind, current.mediaId, input, current.owner, current.csrf, controller.signal);
      if (!valid(current) || controller.signal.aborted) return;
      const expectedVersion = before.item ? before.item.version + 1 : 0;
      if (result.epoch !== before.epoch || !result.item || before.item && result.item.id !== before.item.id
        || result.item.version !== expectedVersion || result.item.positionMs !== position.positionMs || result.item.completed !== position.completed) {
        stop(current, 'conflict', conflictMessage); return;
      }
      accept(current, result);
    } catch (failure) {
      if (!valid(current) || controller.signal.aborted) return;
      if (failure instanceof AccountError && failure.status >= 400 && failure.status < 500) {
        stop(current, failure.code === 'HISTORY_CONFLICT' ? 'conflict' : 'error', failure.code === 'HISTORY_CONFLICT' ? conflictMessage : saveMessage, failure); return;
      }
      // A lost response may have committed. Read its receipt once; never resend an uncertain PUT.
      const check = new AbortController(); current.read = check;
      try {
        const result = await archiveHistoryApi.get(current.kind, current.mediaId, current.owner, check.signal);
        if (!valid(current) || check.signal.aborted) return;
        const expectedVersion = before.item ? before.item.version + 1 : 0;
        const committed = result.epoch === before.epoch && result.item && (!before.item || result.item.id === before.item.id)
          && result.item.version === expectedVersion && result.item.positionMs === position.positionMs && result.item.completed === position.completed;
        if (committed) accept(current, result);
        else stop(current, sameArchiveReceipt(before, result) ? 'error' : 'conflict', sameArchiveReceipt(before, result) ? saveMessage : conflictMessage);
      } catch (error) { if (valid(current) && !check.signal.aborted) stop(current, 'error', saveMessage, error); }
      finally { if (current.read === check) current.read = null; }
    } finally {
      if (current.write === controller) current.write = null;
      if (valid(current) && !current.stopped) { display(current, { busy: false }); void drain(current); }
    }
  }
  function flush(current: Visit, completed = false) {
    if (!valid(current) || current.stopped || !navigator.onLine || current.lastPositionMs === null || !current.dirty && !completed) return;
    const positionMs = completed ? Math.min(latest.current.durationMs, current.receipt?.item?.durationMs ?? latest.current.durationMs) : current.lastPositionMs;
    current.queued = { positionMs, completed }; current.dirty = false; current.nextSaveAt = performance.now() + 10000;
    void drain(current);
  }
  function suspend() {
    const current = visit.current; if (!current) return;
    // Call before the public player's cleanup pauses/removes its source.
    current.active = false; current.queued = null; current.read?.abort(); current.write?.abort(); resetAnchor(current, true);
  }

  useEffect(() => {
    const owner = options.session?.user?.id;
    if (!owner || !options.enabled || !options.mediaId) { setView({ identity, phase: 'ready', receipt: null, busy: false, started: false, message: '' }); return; }
    const current: Visit = { identity, owner, csrf: options.session!.csrfToken, kind: options.kind, mediaId: options.mediaId,
      active: true, stopped: false, receipt: null, read: null, write: null, queued: null, mediaTime: null, wallTime: null,
      advancedMs: 0, lastPositionMs: null, lastEvidenceAt: 0, dirty: false, nextSaveAt: 0,
      started: Boolean(options.video.current && !options.video.current.paused && !options.video.current.ended) };
    visit.current = current;
    setView({ identity, phase: 'loading', receipt: null, busy: false, started: false, message: '' });
    const controller = new AbortController(); current.read = controller;
    void archiveHistoryApi.get(current.kind, current.mediaId, owner, controller.signal).then(result => {
      if (valid(current) && !controller.signal.aborted) accept(current, result);
    }).catch(failure => { if (valid(current) && !controller.signal.aborted) stop(current, 'error', '시청 기록을 불러오지 못했어요. 영상은 계속 볼 수 있어요.', failure); })
      .finally(() => { if (current.read === controller) { current.read = null; if (valid(current)) void drain(current); } });
    const hidden = () => { if (document.visibilityState !== 'visible') { flush(current); resetAnchor(current, true); } };
    const pagehide = () => { flush(current); resetAnchor(current, true); };
    const offline = () => {
      if (current.write || current.read) stop(current, 'error', saveMessage);
      current.queued = null; resetAnchor(current, true);
    };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', pagehide); window.addEventListener('offline', offline);
    return () => {
      current.active = false; current.queued = null; current.read?.abort(); current.write?.abort();
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', pagehide); window.removeEventListener('offline', offline);
    };
  }, [identity, options.enabled, attempt]);

  function progress(element: HTMLVideoElement) {
    const current = visit.current;
    if (!current || !valid(current) || current.stopped) return;
    // Browsers dispatch a final timeupdate and pause before ended. Preserve the
    // last advancing sample until ended can validate completion.
    if (element.ended) return;
    if (!navigator.onLine || document.visibilityState !== 'visible' || element.paused || element.seeking || element.error || element.readyState < 2 || !Number.isFinite(element.currentTime)) { resetAnchor(current); return; }
    const now = performance.now(), media = element.currentTime, previous = current.mediaTime, wall = current.wallTime;
    current.mediaTime = media; current.wallTime = now;
    if (previous === null || wall === null) return;
    const elapsed = now - wall, advanced = (media - previous) * 1000;
    if (elapsed <= 0 || elapsed > 2000 || advanced <= 0 || advanced > Math.max(1000, elapsed * Math.max(1, Math.abs(element.playbackRate)) * 1.5 + 250)) { resetAnchor(current); return; }
    current.advancedMs += Math.min(advanced, elapsed * Math.max(1, Math.abs(element.playbackRate)));
    if (current.advancedMs < 1000) return;
    current.lastPositionMs = Math.min(maximum(current, element), Math.max(0, Math.floor(media * 1000)));
    current.lastEvidenceAt = now; current.dirty = true;
    if (!current.started) { current.started = true; display(current, { started: true }); }
    if (now >= current.nextSaveAt) flush(current);
  }
  function boundary(element: HTMLVideoElement, event: 'pause' | 'seeking' | 'ended' | 'reset') {
    const current = visit.current; if (!current || !valid(current) || current.stopped) return;
    if (event === 'pause' && element.ended) return;
    const max = Math.min(latest.current.durationMs, current.receipt?.item?.durationMs ?? latest.current.durationMs);
    const ended = event === 'ended' && document.visibilityState === 'visible' && navigator.onLine && !element.seeking
      && current.advancedMs >= 1000 && current.lastPositionMs !== null && current.lastPositionMs >= max - 1500
      && performance.now() - current.lastEvidenceAt < 2000 && element.currentTime * 1000 >= max - 1000;
    if (event !== 'reset') flush(current, ended);
    resetAnchor(current, event === 'seeking' || event === 'ended' || event === 'reset');
  }
  function begin() {
    const current = visit.current;
    if (!current || !valid(current) || current.stopped) return;
    current.started = true; resetAnchor(current); display(current, { started: true });
  }
  async function choose(mode: 'resume' | 'start') {
    const current = visit.current, element = latest.current.video.current;
    if (!current || !element || !valid(current) || current.stopped || !current.receipt || current.read || current.write || !navigator.onLine) return;
    if (mode === 'resume') {
      const before = current.receipt, controller = new AbortController(); current.read = controller; display(current, { busy: true });
      try {
        const result = await archiveHistoryApi.get(current.kind, current.mediaId, current.owner, controller.signal);
        if (!valid(current) || controller.signal.aborted) return;
        if (!sameArchiveReceipt(before, result)) { stop(current, 'conflict', conflictMessage); return; }
        accept(current, result);
      } catch (failure) { if (valid(current) && !controller.signal.aborted) stop(current, 'error', '저장한 위치를 확인하지 못했어요. 기록을 다시 연결해 주세요.', failure); return; }
      finally { if (current.read === controller) current.read = null; display(current, { busy: false }); }
    }
    if (!valid(current) || current.stopped || !current.receipt) return;
    const position = mode === 'start' ? 0 : current.receipt.item?.positionMs ?? 0;
    resetAnchor(current, true);
    try { element.pause(); element.currentTime = Math.min(maximum(current, element), Math.max(0, position)) / 1000; }
    catch { display(current, { message: '영상이 준비되면 다시 시도해 주세요.' }); return; }
    resetAnchor(current, true); current.started = true; display(current, { started: true, message: '' });
  }
  const currentView = view.identity === identity ? view : { identity, phase: 'loading' as const, receipt: null, busy: false, started: false, message: '' };
  return { ...currentView, signedIn: Boolean(options.session?.user), enabled: options.enabled, progress, boundary, begin, suspend,
    resume: () => { void choose('resume'); }, start: () => { void choose('start'); }, reconnect: () => { suspend(); setAttempt(value => value + 1); } };
}
