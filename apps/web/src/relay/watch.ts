// One watch page: the broadcast's identity (/info), the connection loop and its retry policies, the viewer session,
// the player and the chat, exposed as a WatchView snapshot for useSyncExternalStore. A link names one broadcast: when
// its path serves another broadcast (or none), the page ends instead of following the path. Every async step checks its
// generation, so nothing of a previous connection or a left page updates the state afterwards.
import type { BroadcastKey, BroadcastSummary, ChatView, PlaybackView, WatchState, WatchView } from '../viewer-contract';
import { RelayError, asRelayError, call, fetchInfo, okOrThrow, parseDvrIndex, streamBase, summaryFromInfo } from './api';
import type { DvrIndex, InfoResult, RelayInfo } from './api';
import { ChatClient } from './chat';
import { knownBroadcasts } from './live';
import { Player } from './player';
import type { PlayerTarget } from './player';
import { clearRuntimeWatch, setRuntimeWatch } from './runtime';
import type { RuntimeSource, RuntimeWatch } from './runtime';
import { ViewerSession } from './session';
import { atLeast, jitter, sleep } from './util';

const RECONNECT_DELAYS = [2000, 4000, 8000, 16_000, 30_000];
const RECONNECT_LIMIT_MS = 45_000;
const BUSY_ATTEMPTS = 4;
const WAITING_LIMIT_MS = 5 * 60_000;
const INFO_POLL_MS = 5000;
const DVR_POLL_MS = 5000;
const NOTICE_MS = 6000;

const FORBIDDEN = '이 방송을 볼 수 있는 권한이 없어요.';
const CHANGED = '이 채널에서 새 방송이 시작됐어요. 라이브 목록에서 다시 들어가 주세요.';

type Kind = WatchState['kind'];

export class WatchController implements RuntimeSource {
  private readonly listeners = new Set<() => void>();
  private readonly player: Player;
  private readonly session: ViewerSession;
  private chat: ChatClient | null = null;
  private state: WatchState;
  private snapshot: WatchView;
  private info: RelayInfo | null = null;
  private dvr: DvrIndex | null = null;
  private base: string;
  private seen = false;
  private active = false;
  private gen = 0;
  private conn = 0;
  private connAbort: AbortController | null = null;
  private health: AbortController | null = null;
  private ticker = 0;
  private infoTimer = 0;
  private dvrTimer = 0;
  private infoBusy = false;
  private dvrBusy = false;
  private infoPauseUntil = 0;
  private failingSince = 0;
  private waitingSince = 0;
  private busyAttempts = 0;
  private reconnectAttempt = 0;
  private lastCapBusy: RelayError | null = null;
  // A manual retry after the viewer cap still waits out the server's Retry-After (the button may be pressed sooner).
  private retryNotBefore = 0;
  private notice: string | null = null;
  private noticeTimer = 0;

  constructor(private readonly key: BroadcastKey) {
    this.base = streamBase(key.path);
    this.state = { kind: 'loading', broadcast: this.known() };
    this.player = new Player({
      changed: () => this.emit(),
      failed: error => this.lost(error),
      notice: message => this.showNotice(message),
      dvrIndex: () => this.dvr,
      verify: signal => this.verify(signal),
    });
    this.session = new ViewerSession({
      base: () => this.base,
      pathBase: () => streamBase(this.key.path),
      verify: signal => this.verify(signal),
      fatal: error => {
        if (error.message === 'session-lost') this.finish(error.cap ? 'busy' : 'error', undefined, error.cap ? error.retryAfterMs ?? 15_000 : undefined);
        else this.lost(error);
      },
      changed: () => this.emit(),
    });
    this.snapshot = this.build();
  }

  // ---- store --------------------------------------------------------------------------------------------------------
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;

  // Stable callbacks: the UI keeps them across snapshots (attachVideo is a ref callback).
  private readonly actions = {
    attachVideo: (video: HTMLVideoElement | null) => this.player.attach(video),
    togglePlaying: () => this.player.togglePlaying(),
    toggleMuted: () => this.player.toggleMuted(),
    setVolume: (volume: number) => this.player.setVolume(volume),
    seek: (positionMs: number) => { if (this.state.kind === 'ready') this.player.seek(positionMs); },
    goLive: () => { if (this.state.kind === 'ready') this.player.goLive(); },
    setQuality: (id: string) => this.player.setQuality(id),
  } satisfies Partial<PlaybackView>;
  private readonly chatActions = {
    setNickname: (name: string) => this.chat?.setNickname(name),
    send: (text: string) => this.chat?.send(text),
    reconnect: () => this.chat?.reconnect(),
  } satisfies Partial<ChatView>;
  private readonly retry = () => {
    if (!this.active || (this.state.kind !== 'error' && this.state.kind !== 'busy')) return;
    void this.connect('retry');
  };

  private build(): WatchView {
    const player = this.player, chat = this.chat, kind = this.state.kind;
    const state = kind === 'ready' && this.notice ? { ...this.state, message: this.notice } : this.state;
    const waitingChat = kind === 'loading' || kind === 'waiting' || kind === 'reconnecting' || kind === 'busy';
    return {
      state,
      playback: {
        status: player.status,
        mode: player.mode,
        muted: player.muted || player.blocked,
        volume: player.volume,
        canSetVolume: player.canSetVolume,
        timeline: kind === 'ready' ? player.timeline() : null,
        quality: player.quality,
        qualities: player.qualities,
        activeQualityLabel: player.activeQualityLabel,
        viewerSessionId: this.session.sid,
        ...this.actions,
      },
      chat: {
        status: chat ? chat.status : waitingChat ? 'connecting' : 'closed',
        nickname: chat?.nickname ?? '',
        messages: chat?.messages ?? [],
        pending: chat?.pending ?? false,
        error: chat?.error ?? null,
        lastAckId: chat?.lastAckId ?? null,
        account: chat?.account,
        canSend: chat?.canSend ?? false,
        restriction: chat?.restriction,
        policy: chat?.policy,
        ...this.chatActions,
      },
      retry: this.retry,
    };
  }

  private emit() {
    this.snapshot = this.build();
    if (!this.active) return;
    for (const listener of [...this.listeners]) listener();
  }

  private setState(kind: Kind, extra: { message?: string; retryAfterMs?: number } = {}) {
    const broadcast = this.info && this.seen ? summaryFromInfo(this.info) : this.state.broadcast ?? this.known();
    this.state = { kind, broadcast, ...(extra.message ? { message: extra.message } : {}), ...(extra.retryAfterMs ? { retryAfterMs: extra.retryAfterMs } : {}) };
    this.emit();
  }

  // The path still serves this link's broadcast (before a session renewal or a restart outside the connection loop).
  private async verify(signal: AbortSignal) {
    const info = await fetchInfo(this.key.path, signal);
    if (!info.running) throw new RelayError('not-running');
    if (info.broadcastId !== this.key.id) throw new RelayError('changed');
  }

  private known(): BroadcastSummary | null {
    const item = knownBroadcasts.get(this.key.id);
    return item && item.path === this.key.path ? item : null;
  }

  private showNotice(message: string) {
    this.notice = message;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => { this.notice = null; this.emit(); }, NOTICE_MS);
    this.emit();
  }

  // ---- lifetime -------------------------------------------------------------------------------------------------------
  start() {
    if (this.active) return;
    this.active = true;
    this.gen++;
    setRuntimeWatch(this);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    this.state = { kind: 'loading', broadcast: this.state.broadcast ?? this.known() };
    this.emit();
    void this.connect('start');
  }

  // Leaving the page or changing broadcast: requests, playback, the viewer session and the chat socket all end here.
  stop() {
    if (!this.active) return;
    this.active = false;
    this.gen++;
    this.connAbort?.abort();
    this.connAbort = null;
    this.stopHealth();
    this.player.reset();
    this.session.stop();
    this.chat?.close();
    this.chat = null;
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    window.clearTimeout(this.noticeTimer);
    this.notice = null;
    this.info = null;
    this.dvr = null;
    this.seen = false;
    this.failingSince = this.waitingSince = this.busyAttempts = this.reconnectAttempt = 0;
    this.lastCapBusy = null;
    this.retryNotBefore = 0;
    clearRuntimeWatch(this);
  }

  private onPageHide = () => this.session.close();
  private onPageShow = (event: PageTransitionEvent) => { if (event.persisted) this.session.resume(); };

  // ---- connection ---------------------------------------------------------------------------------------------------
  private async connect(reason: 'start' | 'retry' | 'lost', cause?: RelayError) {
    if (!this.active) return;
    const gen = this.gen, conn = ++this.conn;
    this.connAbort?.abort();
    const signal = (this.connAbort = new AbortController()).signal;
    const alive = () => this.active && gen === this.gen && conn === this.conn && !signal.aborted;
    this.stopHealth();
    if (reason !== 'start') this.player.closeAll();
    if (reason === 'retry') {
      this.failingSince = this.waitingSince = this.busyAttempts = this.reconnectAttempt = 0;
      this.lastCapBusy = null;
      this.setState('loading');
      const hold = this.retryNotBefore - Date.now();
      this.retryNotBefore = 0;
      if (hold > 0) await sleep(hold, signal);
    }
    if (cause) {
      if (cause.kind === 'waiting' || cause.kind === 'busy') {
        const wait = this.failureDelay(cause);
        if (wait === null) return;
        await sleep(wait, signal);
      } else {
        // The picture stopped: ask the relay at once, then back off.
        this.failingSince ||= Date.now();
        this.setState('reconnecting');
      }
    }
    while (alive()) {
      try {
        const info = await fetchInfo(this.key.path, signal);
        if (!alive()) return;
        if (!this.identity(info)) return;
        const current = info as RelayInfo;
        this.accept(current);
        if (!current.mediaReady) throw new RelayError('waiting', 'media not ready', 200, current.retryAfterMs ?? 2000);
        await this.player.chooseTransport(signal);
        if (!alive()) return;
        // HLS viewers hold a session before playing; WHEP readers are counted by the relay itself.
        if (this.player.transport !== 'webrtc') await this.session.open(signal);
        if (!alive()) return;
        await this.player.openLive(signal, true);
        if (!alive()) return;
        if (this.player.transport === 'webrtc') {
          // WHEP is path-scoped: the broadcast must still be this one after the offer was answered.
          const after = await fetchInfo(this.key.path, signal);
          if (!alive()) return;
          if (!this.identity(after)) return;
        }
        this.ready();
        return;
      } catch (caught) {
        if (!alive()) return;
        const error = asRelayError(caught);
        if (error.kind === 'cancelled') return;
        const wait = this.failureDelay(error);
        if (wait === null) return;
        await sleep(wait, signal);
      }
    }
  }

  // false when the page ends here: the path plays nothing, or another broadcast than the link's.
  private identity(info: InfoResult): boolean {
    const known = this.seen || this.known() !== null;
    if (!info.running) { this.finish(known ? 'ended' : 'unavailable'); return false; }
    if (info.broadcastId !== this.key.id) { this.finish(known ? 'ended' : 'unavailable', known ? CHANGED : undefined); return false; }
    return true;
  }

  private accept(info: RelayInfo) {
    this.info = info;
    this.seen = true;
    this.base = streamBase(this.key.path) + (info.hls?.scope ?? '');
    const target: PlayerTarget = {
      path: this.key.path, id: this.key.id, base: this.base, scoped: !!info.hls?.scope,
      master: info.hls?.master ?? null,
      dvrPlaylist: info.dvr && info.hls?.dvr ? info.hls.dvr : null,
      startedAtMs: info.startedAtMs, clockOffsetMs: info.clockOffsetMs,
      sourceHeight: info.height, renditions: info.renditions, iceServers: info.iceServers,
      // Names the broadcast so the relay refuses (409) or holds (503) a path that carries another broadcast's media.
      whepUrl: streamBase(this.key.path) + 'whep?b=' + this.key.id,
    };
    this.player.setTarget(target);
    if (!this.chat) {
      this.chat = new ChatClient(this.key.path, this.key.id, () => this.emit());
      this.chat.open();
    }
    const previous = this.state.broadcast;
    const broadcast = summaryFromInfo(info);
    if (previous?.title !== broadcast.title || previous?.publisher !== broadcast.publisher ||
        previous.sourceVideo?.width !== broadcast.sourceVideo?.width ||
        previous.sourceVideo?.height !== broadcast.sourceVideo?.height ||
        previous.sourceVideo?.fps !== broadcast.sourceVideo?.fps) {
      this.state = { ...this.state, broadcast };
    }
  }

  // The wait before the next attempt, or null when the page ends in a final state.
  private failureDelay(error: RelayError): number | null {
    switch (error.kind) {
      case 'forbidden': this.finish('unavailable', FORBIDDEN); return null;
      case 'changed': this.finish('ended', CHANGED); return null;
      case 'unsupported': this.finish('error', '이 브라우저에서는 방송을 재생할 수 없어요.'); return null;
      case 'waiting': {
        // The relay says exactly what happens (the sender is away within its grace period): no reconnect budget used.
        this.failingSince = 0;
        this.waitingSince ||= Date.now();
        if (Date.now() - this.waitingSince > WAITING_LIMIT_MS) { this.finish('error', '방송 신호가 오래 돌아오지 않아요.'); return null; }
        this.player.closeAll();
        this.setState('waiting');
        return error.retryAfterMs ?? 2000;
      }
      case 'busy':
        if (error.cap) {
          // The viewer cap: a few automatic attempts at the server's pace, then the viewer retries by hand.
          this.lastCapBusy = error;
          const retryAfter = error.retryAfterMs ?? 2000;
          this.retryNotBefore = Date.now() + retryAfter;
          if (++this.busyAttempts > BUSY_ATTEMPTS) { this.finish('busy', undefined, retryAfter); return null; }
          const wait = Math.min(60_000, atLeast(retryAfter * this.busyAttempts));
          this.setState('busy', { retryAfterMs: wait });
          return wait;
        }
        break;
      default:
        break;
    }
    // Network, timeouts, 5xx, a player failure, a media 404 the next /info explains: back off, give up after ~45 s.
    const now = Date.now();
    this.failingSince ||= now;
    const elapsed = now - this.failingSince;
    if (elapsed >= RECONNECT_LIMIT_MS) {
      const capped = this.lastCapBusy;
      if (capped) this.finish('busy', undefined, capped.retryAfterMs ?? 15_000);
      else this.finish('error');
      return null;
    }
    let wait = jitter(RECONNECT_DELAYS[Math.min(this.reconnectAttempt++, RECONNECT_DELAYS.length - 1)]);
    if (error.retryAfterMs) wait = Math.max(wait, atLeast(error.retryAfterMs));
    wait = Math.max(500, Math.min(wait, RECONNECT_LIMIT_MS - elapsed));
    this.setState('reconnecting');
    return wait;
  }

  private ready() {
    this.failingSince = this.waitingSince = this.busyAttempts = this.reconnectAttempt = 0;
    this.lastCapBusy = null;
    this.setState('ready');
    if (this.player.transport !== 'webrtc') this.session.start();
    this.startHealth();
  }

  // A final state: no more attempts (busy and error keep a manual retry; the chat stays for them).
  private finish(kind: Kind, message?: string, retryAfterMs?: number) {
    this.conn++;
    this.connAbort?.abort();
    this.connAbort = null;
    this.stopHealth();
    this.player.closeAll();
    this.session.stop();
    if (kind === 'busy' && retryAfterMs) this.retryNotBefore = Math.max(this.retryNotBefore, Date.now() + retryAfterMs);
    if (kind === 'ended' || kind === 'unavailable') {
      this.chat?.close();
      this.dvr = null;
    }
    this.setState(kind, { message, retryAfterMs });
  }

  // The playing picture (or its session) failed after it started.
  private lost(error: RelayError) {
    if (!this.active || this.state.kind !== 'ready') return;
    if (error.kind === 'forbidden') { this.finish('unavailable', FORBIDDEN); return; }
    if (error.kind === 'changed') { this.finish('ended', CHANGED); return; }
    void this.connect('lost', error);
  }

  // ---- while playing ------------------------------------------------------------------------------------------------
  private startHealth() {
    this.stopHealth();
    const signal = (this.health = new AbortController()).signal;
    this.ticker = window.setInterval(() => { this.player.tick(); this.emit(); }, 1000);
    this.infoTimer = window.setInterval(() => void this.pollInfo(signal), INFO_POLL_MS);
    if (this.player.transport !== 'webrtc' && this.info?.dvr && this.info.hls?.dvr) {
      void this.pollDvr(signal);
      this.dvrTimer = window.setInterval(() => void this.pollDvr(signal), DVR_POLL_MS);
    }
  }

  private stopHealth() {
    this.health?.abort();
    this.health = null;
    window.clearInterval(this.ticker);
    window.clearInterval(this.infoTimer);
    window.clearInterval(this.dvrTimer);
    this.infoBusy = this.dvrBusy = false;
  }

  private async pollInfo(signal: AbortSignal) {
    if (this.infoBusy || Date.now() < this.infoPauseUntil || this.state.kind !== 'ready') return;
    this.infoBusy = true;
    try {
      const info = await fetchInfo(this.key.path, signal);
      if (signal.aborted || this.state.kind !== 'ready') return;
      if (!this.identity(info)) return;
      const current = info as RelayInfo;
      this.accept(current);
      // The sender is away: wait for it (a recording being watched plays on).
      if (!current.mediaReady && !this.player.playingHistory) this.lost(new RelayError('waiting', 'media not ready', 200, current.retryAfterMs ?? 2000));
      else this.emit();
    } catch (caught) {
      const error = asRelayError(caught);
      if (signal.aborted || error.kind === 'cancelled') return;
      if (error.kind === 'forbidden') { this.finish('unavailable', FORBIDDEN); return; }
      // Other failures are not acted on here: the player reports a picture that really stops.
      if (error.retryAfterMs) this.infoPauseUntil = Date.now() + error.retryAfterMs;
    } finally {
      if (!signal.aborted) this.infoBusy = false;
    }
  }

  private async pollDvr(signal: AbortSignal) {
    if (this.dvrBusy || this.state.kind !== 'ready') return;
    this.dvrBusy = true;
    try {
      const value = await call(this.base + 'dvr', { signal, timeoutMs: 5000 }, async response => parseDvrIndex(await (await okOrThrow(response)).json()));
      if (signal.aborted || this.state.kind !== 'ready') return;
      if (value && 'running' in value) { void this.pollInfo(signal); return; }
      if (value && value.id !== this.key.id) { this.dvr = null; void this.pollInfo(signal); return; }
      this.dvr = value;
      this.emit();
    } catch (caught) {
      const error = asRelayError(caught);
      if (signal.aborted || error.kind === 'cancelled') return;
      if (error.kind === 'changed') { this.finish('ended', CHANGED); return; }
      // 401/403 stop the page like everywhere else (seek, session, /info) instead of being polled again every 5 s.
      if (error.kind === 'forbidden') { this.finish('unavailable', FORBIDDEN); return; }
      if (error.kind === 'not-running') void this.pollInfo(signal);
    } finally {
      if (!signal.aborted) this.dvrBusy = false;
    }
  }

  // ---- test hooks ---------------------------------------------------------------------------------------------------
  runtime(): RuntimeWatch {
    const player = this.player, probe = player.probe(), ready = this.state.kind === 'ready';
    const timeline = ready ? player.timeline() : null, index = player.usableIndex();
    const start = this.info?.startedAtMs ?? null;
    return {
      video: probe.video,
      transport: probe.transport,
      watch: { kind: this.state.kind, broadcastId: this.key.id, path: this.key.path },
      playback: {
        mode: player.mode, status: player.status,
        positionMs: timeline?.positionMs ?? null, liveMs: timeline?.liveMs ?? null, seekStartMs: timeline?.seekStartMs ?? null,
        quality: player.quality, activeQualityLabel: player.activeQualityLabel,
        level: probe.level, latency: probe.latency,
        ranges: index && start ? index.ranges.map(r => ({ startMs: r.startMs - start, endMs: r.endMs - start })) : [],
        startedAtMs: start,
      },
      session: { sid: this.session.sid, opens: this.session.opens, beats: this.session.beats, beatFailures: this.session.beatFailures, lastBeatError: this.session.lastBeatError },
      chat: { status: this.chat?.status ?? 'closed', messages: this.chat?.messages.length ?? 0, lastAckId: this.chat?.lastAckId ?? null },
    };
  }
}
