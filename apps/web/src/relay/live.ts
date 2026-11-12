// Live list: GET /api/broadcasts while the list is on screen. Loading, an empty list and a failed request are distinct;
// a failed refresh keeps the last list (stale). Refreshes run every 10 s only while the document is visible, and never
// before a Retry-After the relay asked for.
import type { BroadcastSummary, LiveState } from '../viewer-contract';
import { RelayError, asRelayError, fetchBroadcasts, isCancelled } from './api';

const REFRESH_MS = 10_000;
const CACHE_MS = 60_000;

// Broadcasts this page has seen in the list: a watch link to one of them that no longer plays has "ended", while an id
// never seen here is "unavailable". Also gives the watch page its title before /info answers.
export const knownBroadcasts = new Map<string, BroadcastSummary>();
let lastList: { at: number; items: BroadcastSummary[] } | null = null;

function errorMessage(error: RelayError) {
  if (error.kind === 'busy') return '접속이 많아요. 잠시 후 다시 시도해 주세요.';
  if (error.kind === 'network') return '중계 서버에 연결할 수 없어요. 네트워크 연결을 확인해 주세요.';
  if (error.kind === 'shape') return '방송 목록 응답을 확인할 수 없어요.';
  if (error.kind === 'forbidden') return '방송 목록을 볼 수 있는 권한이 없어요.';
  return '잠시 후 다시 시도해 주세요.';
}

export class LiveList {
  private state: LiveState;
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private timer = 0;
  private loading = false;
  private started = false;
  private lastAttemptAt = 0;
  private notBefore = 0;

  constructor() {
    const cached = lastList && Date.now() - lastList.at < CACHE_MS ? lastList : null;
    this.state = cached ? (cached.items.length ? { kind: 'ready', items: cached.items } : { kind: 'empty' }) : { kind: 'loading' };
    if (cached) this.lastAttemptAt = cached.at;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.state;

  // A manual retry still waits out a Retry-After the relay sent (load() schedules itself for then).
  retry = () => {
    if (!this.started) return;
    if (this.state.kind === 'error') this.set({ kind: 'loading' });
    void this.load();
  };

  start() {
    if (this.started) return;
    this.started = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    if (Date.now() - this.lastAttemptAt >= REFRESH_MS || this.state.kind === 'loading') void this.load();
    else this.schedule(REFRESH_MS - (Date.now() - this.lastAttemptAt));
  }

  stop() {
    this.started = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.clearTimeout(this.timer);
    this.abort?.abort();
    this.abort = null;
    this.loading = false;
  }

  private onVisibility = () => {
    if (document.hidden) { window.clearTimeout(this.timer); return; }
    const since = Date.now() - this.lastAttemptAt;
    if (since >= REFRESH_MS) void this.load();
    else this.schedule(REFRESH_MS - since);
  };

  private schedule(ms: number) {
    window.clearTimeout(this.timer);
    if (!this.started || document.hidden) return;
    this.timer = window.setTimeout(() => void this.load(), Math.max(ms, this.notBefore - Date.now(), 0));
  }

  private set(state: LiveState) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  private async load() {
    if (!this.started || this.loading) return;
    if (Date.now() < this.notBefore) { this.schedule(this.notBefore - Date.now()); return; }
    window.clearTimeout(this.timer);
    this.loading = true;
    this.lastAttemptAt = Date.now();
    const abort = this.abort = new AbortController();
    try {
      const items = await fetchBroadcasts(abort.signal);
      if (abort !== this.abort) return;
      lastList = { at: Date.now(), items };
      for (const item of items) knownBroadcasts.set(item.id, item);
      this.set(items.length ? { kind: 'ready', items } : { kind: 'empty' });
    } catch (caught) {
      if (abort !== this.abort || isCancelled(caught)) return;
      const error = asRelayError(caught);
      if (error.retryAfterMs) this.notBefore = Date.now() + error.retryAfterMs;
      const previous = this.state;
      if (previous.kind === 'ready') this.set({ kind: 'ready', items: previous.items, stale: true });
      else if (previous.kind === 'empty') this.set({ kind: 'ready', items: [], stale: true });
      else this.set({ kind: 'error', message: errorMessage(error) });
    } finally {
      if (abort === this.abort) {
        this.loading = false;
        this.abort = null;
        this.schedule(REFRESH_MS);
      }
    }
  }
}
