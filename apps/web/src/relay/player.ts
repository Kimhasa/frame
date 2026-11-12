// Playback on the one <video> the UI owns, ported from work/console-ux.js (its rules are the specification):
//   - the transport is chosen once per connection: hls.js where Media Source Extensions (or ManagedMediaSource) exist,
//     else the browser's own HLS, else WHEP only for a browser that plays no HLS at all. A refused request (401/403, the
//     viewer cap) never leads to another transport;
//   - 429/503 are not retried inside hls.js: the watch controller waits the server's Retry-After itself;
//   - automatic quality is hls.js's own choice, kept from flipping back and forth (up then down within 15 s holds it at
//     the lower level for 15 s, doubling to 120 s); a manual level persists until 자동 is chosen again;
//   - the recording (dvr.m3u8) plays from a separate hls.js player that loads its first fragment while live keeps
//     playing, and takes the element only then; the last seek wins.
// No React here: the watch controller reads the state and turns it into PlaybackView.
import type Hls from 'hls.js';
import type { ErrorData, HlsConfig, LoaderResponse, RetryConfig } from 'hls.js';
import type { PlaybackView } from '../viewer-contract';
import { RelayError, asRelayError, call, classifyStatus, isCancelled, okOrThrow } from './api';
import type { DvrIndex, Rendition } from './api';
import { mapEnd, mediaAt, parseDvrPlaylist, wallAt } from './dvr';
import type { DvrSegment } from './dvr';
import { logRequest } from './runtime';
import { sleep, waitFrames } from './util';
import { closeWhep, openWhep } from './whep';
import type { WhepSession } from './whep';

type HlsClass = typeof Hls;
export type Transport = 'hls.js' | 'native' | 'webrtc';

let hlsClass: Promise<HlsClass> | null = null;
// hls.js 1.5.20 is fetched only when an HLS path is used (its own chunk; the design build never includes it).
function loadHls(): Promise<HlsClass> {
  hlsClass ??= import('hls.js').then(module => module.default, error => { hlsClass = null; throw error; });
  return hlsClass;
}

export type PlayerTarget = {
  path: string;
  id: string;
  // "/<path>/b/<id>/" with broadcast scopes, "/<path>/" on an older relay. Every HLS and DVR URL is relative to it.
  base: string;
  // false on an older relay: its media URLs name only the path, so /info is compared before every (re)start.
  scoped: boolean;
  master: string | null;
  dvrPlaylist: string | null;
  startedAtMs: number;
  clockOffsetMs: number;
  sourceHeight: number;
  renditions: Rendition[];
  iceServers: RTCIceServer[];
  whepUrl: string;
};

export type PlayerHost = {
  changed(): void;
  // The playing picture failed for good after it started (the watch controller reconnects or stops).
  failed(error: RelayError): void;
  notice(message: string): void;
  dvrIndex(): DvrIndex | null;
  // Throws RelayError (changed, not-running, ...) unless /info still names this broadcast.
  verify(signal: AbortSignal): Promise<void>;
};

type Media = {
  kind: Transport;
  video: HTMLVideoElement | null;
  history: boolean;
  hls: Hls | null;
  whep: WhepSession | null;
  started: boolean;
  closed: boolean;
  failed: Promise<never>;
  fail: (error: RelayError) => void;
  prefetched: Promise<void>;
  cleanup: (() => void)[];
  map: DvrSegment[];
  mapAt: number;
  mapLoading: boolean;
  targetWall: number;
  lastWall: number;
  levelIndex: number;
  sizeCap: number;
  holdCap: number;
  applyCap: () => void;
  manualRetries: number;
  manualTimer: number;
  lastError: string;
  switching: Map<number, { at: number; auto: boolean }>;
  recover: number;
  recoverAt: number;
  // Up-probe of the automatic quality (see Player.probeUp): the level held as hls.js's floor, the last probe and stall.
  floor: number;
  probeAt: number;
  stallAt: number;
};

const HLS_EDGE_MS = 6000;  // dvr.m3u8 ends a few seconds behind live: a position this close to the edge plays live
const HOLD = { flipMs: 15_000, minHoldMs: 15_000, maxHoldMs: 120_000, calmMs: 60_000 };

// 429/503 are never retried inside hls.js (the page honours Retry-After), nor 401/403/409 (retrying cannot help).
const retryNotRefused = (_config: RetryConfig | null | undefined, _count: number, _timeout: boolean, response: LoaderResponse | undefined, retry: boolean) =>
  retry && !(response?.code !== undefined && [401, 403, 409, 429, 503].includes(response.code));
const loadPolicy = (firstByteMs: number, loadMs: number, timeouts: number, errors: number) => ({
  default: {
    maxTimeToFirstByteMs: firstByteMs, maxLoadTimeMs: loadMs,
    timeoutRetry: { maxNumRetry: timeouts, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: errors, retryDelayMs: 1000, maxRetryDelayMs: 4000, shouldRetry: retryNotRefused },
  },
});
function hlsConfig(extra: Partial<HlsConfig>): Partial<HlsConfig> {
  return {
    enableWorker: true, lowLatencyMode: true, backBufferLength: 30, maxBufferLength: 10, maxMaxBufferLength: 20,
    capLevelToPlayerSize: true,
    // Before any measurement: as if 2.5 Mb/s were available (about 480p-720p, not the lowest level).
    startLevel: -1, abrEwmaDefaultEstimate: 2_500_000, abrBandWidthFactor: 0.9, abrBandWidthUpFactor: 0.6,
    preferManagedMediaSource: true,
    manifestLoadPolicy: loadPolicy(10_000, 10_000, 1, 1),
    playlistLoadPolicy: loadPolicy(10_000, 10_000, 2, 2),
    fragLoadPolicy: loadPolicy(10_000, 20_000, 2, 3),
    xhrSetup: (_xhr, url) => logRequest(url),
    ...extra,
  };
}

function hlsError(H: HlsClass, data: ErrorData): RelayError {
  const code = data.response?.code ?? 0;
  if (code >= 400) {
    const details = data.networkDetails as XMLHttpRequest | undefined;
    let retryAfter: string | null = null, body = '';
    try { retryAfter = details?.getResponseHeader?.('Retry-After') ?? null; } catch { /* not readable */ }
    try { if (details && (details.responseType === '' || details.responseType === 'text')) body = String(details.responseText || ''); } catch { /* binary */ }
    const error = classifyStatus(code, body, retryAfter);
    error.message = `${data.details} ${code}`;
    return error;
  }
  return new RelayError(data.type === H.ErrorTypes.MEDIA_ERROR ? 'media' : 'network', data.details);
}

function canSetVolume() {
  try {
    const video = document.createElement('video');
    video.volume = 0.5;
    return Math.abs(video.volume - 0.5) < 0.01;
  } catch { return false; }
}

// Seconds of media buffered ahead of the playing position.
function bufferedAhead(video: HTMLVideoElement) {
  const ranges = video.buffered, t = video.currentTime;
  for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= t + 0.1 && ranges.end(i) > t) return ranges.end(i) - t;
  return 0;
}

const mseAvailable = () => typeof window !== 'undefined' && ('ManagedMediaSource' in window || 'MediaSource' in window || 'WebKitMediaSource' in window);
const nativeHls = () => !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');

export class Player {
  transport: Transport | null = null;
  quality = 'auto';
  qualities: { id: string; label: string }[] = [];
  userPaused = false;
  blocked = false;
  muted = false;
  volume = 1;
  readonly canSetVolume = canSetVolume();

  private H: HlsClass | null = null;
  private ui: HTMLVideoElement | null = null;
  private uiCleanup: (() => void) | null = null;
  private waiters: ((video: HTMLVideoElement) => void)[] = [];
  private target: PlayerTarget | null = null;
  private signal: AbortSignal | null = null;
  private live: Media | null = null;
  private history: Media | null = null;
  private pending: Media | null = null;
  private seekToken = 0;
  private pendingWall: number | null = null;
  private pausedLive: { at: number; wallMs: number } | null = null;
  private switching = false;
  private lostByDetach = false;
  private lastHeight = 0;
  private sourceQualityId = '';
  private hold = { holdMs: HOLD.minHoldMs, upAt: 0, holdUntil: 0, holdHeight: 0, lastSwitchAt: 0 };

  constructor(private readonly host: PlayerHost) {}

  // ---- element and connection -----------------------------------------------------------------------------------
  attach(video: HTMLVideoElement | null) {
    if (video === this.ui) return;
    if (this.ui) {
      if (this.live?.started || this.history?.started) this.lostByDetach = true;
      // A load still waiting for its first frame fails like a network error (retried), not like a cancel.
      const detached = new RelayError('network', 'video element detached');
      for (const media of [this.live, this.history, this.pending]) if (media && !media.started) media.fail(detached);
      this.closeAll();
      this.uiCleanup?.();
      this.uiCleanup = null;
    }
    this.ui = video;
    if (!video) return;
    video.playsInline = true;
    const onResize = () => this.host.changed();
    const onPause = () => {
      // A pause the page did not ask for (picture-in-picture window, media keys): adopt it.
      if (this.userPaused || this.switching || video.ended || video.readyState === 0) return;
      this.pauseAt(video, false);
      this.host.changed();
    };
    const onPlay = () => {
      if (!this.userPaused || this.switching) return;
      this.userPaused = false;
      this.pausedLive = null;
      this.host.changed();
    };
    video.addEventListener('resize', onResize);
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    this.uiCleanup = () => {
      video.removeEventListener('resize', onResize);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
    };
    for (const resolve of this.waiters.splice(0)) resolve(video);
    if (this.lostByDetach) {
      this.lostByDetach = false;
      queueMicrotask(() => this.host.failed(new RelayError('network', 'video element replaced')));
    }
  }

  setTarget(target: PlayerTarget) {
    this.target = target;
    if (this.transport === 'native' || this.transport === 'webrtc') this.nativeQualities();
  }

  // Everything this player made, for a new connection or for leaving: requests, players, the element's source.
  reset() {
    this.seekToken++;
    this.closeAll();
    this.signal = null;
    this.transport = null;
    this.pausedLive = null;
    this.pendingWall = null;
    this.switching = false;
    this.lostByDetach = false;
    this.userPaused = false;
    this.blocked = false;
    this.qualities = [];
    this.quality = 'auto';
    this.waiters = [];
  }

  closeAll() {
    this.closePending();
    this.closeMedia(this.history);
    this.history = null;
    this.closeMedia(this.live);
    this.live = null;
    const video = this.ui;
    if (video) {
      video.srcObject = null;
      if (video.hasAttribute('src')) {
        video.removeAttribute('src');
        video.load();
      }
    }
  }

  private waitVideo(signal: AbortSignal): Promise<HTMLVideoElement> {
    if (this.ui) return Promise.resolve(this.ui);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new RelayError('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(video => { signal.removeEventListener('abort', onAbort); resolve(video); });
    });
  }

  async chooseTransport(signal: AbortSignal): Promise<Transport> {
    if (this.transport) return this.transport;
    const target = this.target;
    if (!target) throw new RelayError('shape', 'no target');
    let transport: Transport | null = null;
    if (target.master) {
      if (mseAvailable()) {
        try {
          const H = await loadHls();
          if (H.isSupported()) { this.H = H; transport = 'hls.js'; }
        } catch {
          if (signal.aborted) throw new RelayError('cancelled');
          // The player chunk did not load: the browser's own HLS if it has one, else a network failure to retry.
          if (!nativeHls()) throw new RelayError('network', 'player chunk');
        }
      }
      if (!transport && nativeHls()) transport = 'native';
    }
    // WebRTC only for a browser without any HLS (or a relay serving no HLS), chosen here once and never as a fallback.
    if (!transport && typeof RTCPeerConnection === 'function') transport = 'webrtc';
    if (!transport) throw new RelayError('unsupported');
    this.transport = transport;
    if (transport !== 'hls.js') this.nativeQualities();
    return transport;
  }

  // ---- live -------------------------------------------------------------------------------------------------------
  // Opens live playback (closing whatever the element plays) and resolves after its first frame. verified: /info named
  // this broadcast just now (the connection loop); other restarts on a path-scoped relay (or WHEP) check it first.
  async openLive(signal: AbortSignal, verified = false): Promise<void> {
    const target = this.target, transport = this.transport;
    if (!target || !transport) throw new RelayError('shape', 'not connected');
    this.signal = signal;
    if (!verified && (!target.scoped || transport === 'webrtc')) await this.host.verify(signal);
    const video = await this.waitVideo(signal);
    if (signal.aborted) throw new RelayError('cancelled');
    this.seekToken++;
    this.pendingWall = null;
    this.pausedLive = null;
    this.switching = true;
    try {
      this.closeAll();
      if (transport === 'hls.js') await this.openHlsLive(target, video, signal);
      else if (transport === 'native') await this.openNativeLive(target, video, signal);
      else await this.openWhepLive(target, video, signal);
    } finally {
      this.switching = false;
      this.host.changed();
    }
  }

  private async openHlsLive(target: PlayerTarget, video: HTMLVideoElement, signal: AbortSignal) {
    // Live target 1.5 s behind the playlist edge instead of MediaMTX's PART-HOLD-BACK (0.5 s): with less than two parts
    // buffered hls.js weighs levels by their peak BANDWIDTH and stays at the lowest level. Parts and blocking reloads stay
    // on; a viewer that fell behind catches up at up to 1.1x speed.
    const media = this.createHls(video, target.base + target.master, hlsConfig({ liveSyncDuration: 1.5, maxLiveSyncPlaybackRate: 1.1 }), false);
    this.levels(media);
    this.live = media;
    this.play(video);
    await this.started(media, 20_000, signal);
    // A start that took long (a quality's encoder starting) begins seconds behind the edge: once, move to live.
    const resync = window.setTimeout(() => {
      const hls = media.hls, wanted = hls?.targetLatency;
      if (!hls || this.live !== media || this.userPaused || wanted === null || wanted === undefined) return;
      const sync = hls.liveSyncPosition;
      if (hls.latency > wanted + 1.5 && sync !== null && Number.isFinite(sync)) video.currentTime = sync;
    }, 2500);
    media.cleanup.push(() => window.clearTimeout(resync));
  }

  private nativeUrl(target: PlayerTarget) {
    const url = target.base + target.master;
    if (this.quality === 'auto') return url;
    if (this.quality === this.sourceQualityId) return url + '?q=source';
    const rendition = target.renditions.find(r => `${r.height}p` === this.quality);
    return rendition ? `${url}?q=${rendition.name}` : url;
  }

  private async openNativeLive(target: PlayerTarget, video: HTMLVideoElement, signal: AbortSignal) {
    // The browser's own player reports no HTTP status: one playlist request first tells permission, end and busy apart.
    let url = this.nativeUrl(target);
    try {
      await call(url, { signal, timeoutMs: 8000 }, async response => { await okOrThrow(response); });
    } catch (caught) {
      const error = asRelayError(caught);
      // That one quality is not offered (?q=): play automatic quality instead, never end the broadcast for it.
      if (error.kind !== 'not-found' || this.quality === 'auto') throw error;
      this.quality = 'auto';
      this.host.notice('선택한 화질을 지금 재생할 수 없어 자동으로 바꿨어요.');
      url = this.nativeUrl(target);
    }
    if (signal.aborted) throw new RelayError('cancelled');
    const media = this.newMedia('native', video, false);
    const onError = () => this.mediaFailed(media, new RelayError('network', 'native error'));
    const onEnded = () => this.mediaFailed(media, new RelayError('network', 'native ended'));
    video.addEventListener('error', onError);
    video.addEventListener('ended', onEnded);
    media.cleanup.push(() => { video.removeEventListener('error', onError); video.removeEventListener('ended', onEnded); });
    this.live = media;
    logRequest(url);
    video.src = url;
    this.play(video);
    await this.started(media, 20_000, signal);
  }

  private async openWhepLive(target: PlayerTarget, video: HTMLVideoElement, signal: AbortSignal) {
    const session = await openWhep(target.whepUrl, target.iceServers, signal);
    if (signal.aborted) { closeWhep(session); throw new RelayError('cancelled'); }
    const media = this.newMedia('webrtc', video, false);
    media.whep = session;
    const pc = session.pc;
    let disconnectTimer = 0;
    const onState = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.mediaFailed(media, new RelayError('network', 'webrtc ' + pc.connectionState));
      else if (pc.connectionState === 'disconnected') {
        window.clearTimeout(disconnectTimer);
        disconnectTimer = window.setTimeout(() => { if (pc.connectionState === 'disconnected') this.mediaFailed(media, new RelayError('network', 'webrtc disconnected')); }, 3000);
      }
    };
    pc.addEventListener('connectionstatechange', onState);
    media.cleanup.push(() => { pc.removeEventListener('connectionstatechange', onState); window.clearTimeout(disconnectTimer); });
    this.live = media;
    video.srcObject = session.stream;
    this.play(video);
    await this.started(media, 15_000, signal);
  }

  // ---- hls.js players ---------------------------------------------------------------------------------------------
  private newMedia(kind: Transport, video: HTMLVideoElement | null, history: boolean): Media {
    let fail: (error: RelayError) => void = () => {};
    const failed = new Promise<never>((_, reject) => { fail = reject; });
    failed.catch(() => {});
    return {
      kind, video, history, hls: null, whep: null, started: false, closed: false, failed, fail, prefetched: Promise.resolve(),
      cleanup: [], map: [], mapAt: 0, mapLoading: false, targetWall: 0, lastWall: 0, levelIndex: -1, sizeCap: -1, holdCap: -1,
      applyCap: () => {}, manualRetries: 0, manualTimer: 0, lastError: '', switching: new Map(), recover: 0, recoverAt: 0,
      floor: -1, probeAt: 0, stallAt: 0,
    };
  }

  // Fatal errors before the first frame end the load; later ones go to the watch controller. A media (decoder/buffer)
  // error is recovered in place once, then once more with the other audio codec signalling.
  private createHls(video: HTMLVideoElement | null, url: string, config: Partial<HlsConfig>, history: boolean): Media {
    const H = this.H!;
    const hls = new H(config);
    const media = this.newMedia('hls.js', video, history);
    media.hls = hls;
    hls.on(H.Events.ERROR, (_event, data) => {
      if (media.closed) return;
      media.lastError = data.details + (data.response?.code ? ' ' + data.response.code : '');
      if (!data.fatal) return;
      if (data.type === H.ErrorTypes.MEDIA_ERROR) {
        if (performance.now() - media.recoverAt > 60_000) media.recover = 0;
        if (media.recover < 2) {
          media.recoverAt = performance.now();
          if (media.recover++ === 1) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        }
      }
      this.mediaFailed(media, hlsError(H, data));
    });
    if (history) {
      media.prefetched = new Promise<void>(resolve => {
        const onLoaded = (_event: unknown, data: { frag: { sn: number | 'initSegment' } }) => {
          if (data.frag.sn === 'initSegment') return;
          hls.off(H.Events.FRAG_LOADED, onLoaded);
          resolve();
        };
        hls.on(H.Events.FRAG_LOADED, onLoaded);
      });
    }
    if (video) hls.attachMedia(video);
    hls.loadSource(url);
    return media;
  }

  private mediaFailed(media: Media, error: RelayError) {
    if (media.closed) return;
    if (!media.started) { media.fail(error); return; }
    if (media !== this.live && media !== this.history) { this.closeMedia(media); return; }
    if (media.history && error.kind === 'media') {
      // The recording cannot be decoded further: back to live, without a reconnect.
      this.host.notice('지난 구간을 더 재생할 수 없어 실시간으로 돌아왔어요.');
      void this.toLive();
      return;
    }
    this.host.failed(error);
  }

  private closeMedia(media: Media | null) {
    if (!media || media.closed) return;
    media.closed = true;
    media.fail(new RelayError('cancelled'));
    window.clearTimeout(media.manualTimer);
    for (const cleanup of media.cleanup.splice(0)) cleanup();
    try { media.hls?.destroy(); } catch { /* already gone */ }
    closeWhep(media.whep);
  }

  private closePending() {
    this.closeMedia(this.pending);
    this.pending = null;
  }

  private async started(media: Media, timeoutMs: number, signal: AbortSignal) {
    const video = media.video;
    if (!video) throw new RelayError('cancelled');
    try {
      await Promise.race([waitFrames(video, timeoutMs, signal), media.failed]);
    } catch (caught) {
      this.closeMedia(media);
      if (this.live === media) this.live = null;
      if (this.history === media) this.history = null;
      if (caught instanceof RelayError) throw caught;
      throw new RelayError(signal.aborted ? 'cancelled' : 'network', 'first frame');
    }
    if (media.closed) throw new RelayError('cancelled');
    media.started = true;
  }

  // ---- quality ----------------------------------------------------------------------------------------------------
  private nativeQualities() {
    const target = this.target;
    if (!target || this.transport === 'webrtc') { this.qualities = []; return; }
    const source = target.sourceHeight;
    this.sourceQualityId = source ? `${source}p` : 'source';
    const list = [{ id: this.sourceQualityId, label: source ? `${source}p (원본)` : '원본' }];
    for (const r of [...target.renditions].sort((a, b) => b.height - a.height)) if (r.height && r.height !== source) list.push({ id: `${r.height}p`, label: `${r.height}p` });
    this.qualities = [{ id: 'auto', label: '자동' }, ...list];
  }

  private levelByHeight(hls: Hls) {
    const byHeight = new Map<number, number>();
    hls.levels.forEach((level, index) => {
      if (!level.height) return;
      const known = byHeight.get(level.height);
      if (known === undefined || hls.levels[known].bitrate < level.bitrate) byHeight.set(level.height, index);
    });
    return byHeight;
  }

  private levelIndexFor(hls: Hls, quality: string) {
    if (quality === 'auto') return -1;
    return this.levelByHeight(hls).get(Number.parseInt(quality, 10)) ?? -1;
  }

  private levels(media: Media) {
    const H = this.H!, hls = media.hls!;
    // hls.js's player-size cap (capLevelToPlayerSize) writes autoLevelCapping every second; the hold cap combines with it.
    const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(hls), 'autoLevelCapping');
    media.applyCap = () => {
      const a = media.sizeCap, b = media.holdCap, value = a < 0 ? b : b < 0 ? a : Math.min(a, b);
      if (proto?.set) proto.set.call(hls, value); else hls.autoLevelCapping = value;
    };
    if (proto?.get && proto.set) {
      const get = proto.get;
      Object.defineProperty(hls, 'autoLevelCapping', {
        configurable: true,
        get: () => get.call(hls),
        set: (value: number) => { media.sizeCap = value; media.applyCap(); },
      });
    }
    hls.on(H.Events.MANIFEST_PARSED, () => {
      if (media.closed) return;
      const byHeight = this.levelByHeight(hls);
      const top = Math.max(0, ...byHeight.keys());
      const source = this.target?.sourceHeight && byHeight.has(this.target.sourceHeight) ? this.target.sourceHeight : top;
      this.sourceQualityId = `${source}p`;
      const heights = [...byHeight.keys()].sort((a, b) => b - a);
      this.qualities = heights.length ? [{ id: 'auto', label: '자동' }, ...heights.map(h => ({ id: `${h}p`, label: h === source ? `${h}p (원본)` : `${h}p` }))] : [];
      // Manual: that level, fixed. Automatic: hls.js chooses; a reconnect starts at the level that was playing.
      const manual = this.levelIndexFor(hls, this.quality);
      if (this.quality !== 'auto' && manual < 0) {
        this.quality = 'auto';
        this.host.notice('선택한 화질을 지금 재생할 수 없어 자동으로 바꿨어요.');
      }
      if (manual >= 0) { hls.startLevel = manual; hls.loadLevel = manual; }
      else if (this.lastHeight && byHeight.has(this.lastHeight)) hls.startLevel = byHeight.get(this.lastHeight)!;
      if (this.hold.holdUntil > performance.now()) {
        media.holdCap = byHeight.get(this.hold.holdHeight) ?? -1;
        media.applyCap();
      }
      this.host.changed();
    });
    // A manual level that fails to load makes hls.js fall back to automatic by itself. It is asked for again (3 times,
    // 1.5 s apart); if it still cannot play, the viewer is told and the menu shows 자동.
    hls.on(H.Events.ERROR, (_event, data) => {
      if (data.fatal || media.closed || this.quality === 'auto' || media.manualTimer || this.live !== media) return;
      media.manualTimer = window.setTimeout(() => {
        media.manualTimer = 0;
        if (media.closed || this.live !== media || this.quality === 'auto' || !hls.autoLevelEnabled) return;
        const manual = this.levelIndexFor(hls, this.quality);
        if (manual >= 0 && media.manualRetries++ < 3) { hls.currentLevel = manual; return; }
        this.quality = 'auto';
        this.host.notice('선택한 화질을 지금 재생할 수 없어 자동으로 바꿨어요.');
        this.host.changed();
      }, 1500);
    });
    hls.on(H.Events.ERROR, (_event, data) => { if (data.details === H.ErrorDetails.BUFFER_STALLED_ERROR) media.stallAt = performance.now(); });
    hls.on(H.Events.LEVEL_SWITCHING, (_event, data) => { media.switching.set(data.level, { at: performance.now(), auto: hls.autoLevelEnabled }); });
    hls.on(H.Events.LEVEL_SWITCHED, (_event, data) => this.levelSwitched(media, data.level));
  }

  private levelSwitched(media: Media, index: number) {
    const hls = media.hls!, levels = hls.levels, level = levels[index], previous = media.levelIndex, switching = media.switching.get(index);
    if (!level) return;
    media.levelIndex = index;
    media.switching.delete(index);
    if (this.live === media) this.lastHeight = level.height;
    if (this.quality !== 'auto' && this.levelIndexFor(hls, this.quality) === index) media.manualRetries = 0;
    // Only hls.js's own automatic choices count; a step down only because the player got smaller is not flipping.
    if (previous >= 0 && previous !== index && switching?.auto) {
      const now = performance.now(), up = level.height > (levels[previous]?.height ?? 0);
      const sizeDown = !up && media.sizeCap >= 0 && index <= media.sizeCap && previous > media.sizeCap;
      if (up) this.hold.upAt = now;
      else if (sizeDown) this.hold.upAt = 0;
      else if (this.hold.upAt && now - this.hold.upAt <= HOLD.flipMs) {
        // Up, then down again soon: hold automatic choice at this level for a while, longer each time.
        media.holdCap = index;
        media.applyCap();
        this.hold.holdUntil = now + this.hold.holdMs;
        this.hold.holdHeight = level.height;
        this.hold.upAt = 0;
        this.hold.holdMs = Math.min(HOLD.maxHoldMs, this.hold.holdMs * 2);
      }
      this.hold.lastSwitchAt = now;
    }
    this.host.changed();
  }

  setQuality(id: string) {
    if (id === this.quality || (id !== 'auto' && !this.qualities.some(q => q.id === id))) return;
    this.quality = id;
    const live = this.live;
    if (!this.history && live?.started && !live.closed) {
      if (live.kind === 'hls.js' && live.hls) {
        this.setFloor(live, -1);  // a new choice starts without the automatic up-probe's floor
        if (id === 'auto') live.hls.loadLevel = -1;  // automatic again, without flushing what is buffered
        else {
          const index = this.levelIndexFor(live.hls, id);
          live.manualRetries = 0;
          if (index >= 0) live.hls.currentLevel = index;
        }
      } else if (live.kind === 'native' && this.signal) {
        // The browser's own player plays one quality per playlist: reopen live with ?q=.
        const signal = this.signal;
        void this.openLive(signal).catch(caught => {
          const error = asRelayError(caught);
          if (!isCancelled(error) && !signal.aborted) this.host.failed(error);
        });
      }
    }
    this.host.changed();
  }

  // ---- play, pause, volume ----------------------------------------------------------------------------------------
  private play(video: HTMLVideoElement) {
    if (this.canSetVolume) video.volume = this.volume;
    video.muted = this.muted || this.blocked;
    if (this.userPaused) return;
    const attempt = video.play();
    attempt?.catch((error: unknown) => {
      if (video !== this.ui || this.userPaused) return;
      // The browser refused sound without a user gesture: play muted and show 소리 켜기 until the viewer turns it on.
      if ((error as DOMException)?.name === 'NotAllowedError' && !video.muted) {
        this.blocked = true;
        video.muted = true;
        this.host.changed();
        video.play().catch(() => {});
      }
    });
  }

  private pauseAt(video: HTMLVideoElement, pauseElement: boolean) {
    this.userPaused = true;
    if (pauseElement) video.pause();
    // Paused on live with a recording: Play continues from this moment (from the recording) after more than 3 s.
    if (!this.history && this.pendingWall === null && this.usableIndex()) this.pausedLive = { at: performance.now(), wallMs: this.liveWall() };
  }

  togglePlaying() {
    const video = this.ui;
    if (!video) return;
    if (this.blocked) {
      this.blocked = false;
      this.muted = false;
      this.userPaused = false;
      this.play(video);
    } else if (!this.userPaused) this.pauseAt(video, true);
    else {
      this.userPaused = false;
      const paused = this.pausedLive;
      this.pausedLive = null;
      if (paused && !this.history && this.pendingWall === null && performance.now() - paused.at > 3000 && this.target) {
        // Continue from the paused moment (from the recording); whatever ends the seek early plays live instead.
        void this.seekTo(paused.wallMs - this.target.startedAtMs).then(() => {
          const element = this.ui;
          if (element && !this.history && this.pendingWall === null && !this.userPaused && element.paused && this.live?.started) this.play(element);
        });
      } else {
        this.play(video);
        this.catchUp();
      }
    }
    this.host.changed();
  }

  toggleMuted() {
    const video = this.ui;
    if (this.blocked) {
      this.blocked = false;
      this.muted = false;
      if (video) this.play(video);
    } else {
      this.muted = !this.muted;
      if (!this.muted && this.volume === 0) this.volume = 1;
      if (video) { video.muted = this.muted; if (this.canSetVolume) video.volume = this.volume; }
    }
    this.host.changed();
  }

  setVolume(value: number) {
    const volume = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1)), video = this.ui;
    this.volume = volume;
    this.muted = volume === 0;
    const unblock = this.blocked && volume > 0;
    if (unblock) this.blocked = false;
    if (video) {
      if (this.canSetVolume) video.volume = volume;
      video.muted = this.muted || this.blocked;
      if (unblock) this.play(video);
    }
    this.host.changed();
  }

  // Resuming live after a pause without a recording: back to the live position when far behind.
  private catchUp() {
    const hls = this.live?.hls, video = this.ui;
    if (!hls || !video || this.history) return;
    const wanted = hls.targetLatency, sync = hls.liveSyncPosition;
    if (wanted !== null && sync !== null && Number.isFinite(sync) && hls.latency > wanted + 3) video.currentTime = sync;
  }

  // ---- DVR ----------------------------------------------------------------------------------------------------------
  private relayNow() { return Date.now() + (this.target?.clockOffsetMs ?? 0); }

  // The moment the live picture shows (hls.js: its fragment's PROGRAM-DATE-TIME on the relay clock).
  private liveWall() {
    const date = this.live?.hls?.playingDate;
    if (date && Number.isFinite(date.getTime())) return date.getTime();
    return this.relayNow() - 2000;
  }

  usableIndex(): DvrIndex | null {
    const target = this.target, index = this.host.dvrIndex();
    if (!target?.dvrPlaylist || this.transport === 'webrtc' || !index || index.id !== target.id || !index.ranges.length) return null;
    const first = index.ranges[0].startMs, last = index.ranges[index.ranges.length - 1].endMs;
    return last - first >= 2000 ? index : null;
  }

  private historyMap(media: Media) {
    const fragments = media.hls?.levels[0]?.details?.fragments;
    if (fragments?.length) {
      const map = fragments.filter(f => typeof f.programDateTime === 'number' && Number.isFinite(f.programDateTime))
        .map(f => ({ pdt: f.programDateTime as number, start: f.start, dur: f.duration }));
      if (map.length >= media.map.length) return map;
    }
    return media.map;
  }

  private historyWall(): number | null {
    const media = this.history, video = this.ui;
    if (!media || !video) return null;
    const at = media.started ? wallAt(this.historyMap(media), video.currentTime) : null;
    if (at !== null) media.lastWall = at;
    return at ?? (media.lastWall || media.targetWall);
  }

  private async dvrMap(signal: AbortSignal) {
    const target = this.target;
    if (!target?.dvrPlaylist) throw new RelayError('not-found', 'no recording');
    return call(target.base + target.dvrPlaylist, { signal, timeoutMs: 8000 }, async response => parseDvrPlaylist(await (await okOrThrow(response)).text()));
  }

  seek(positionMs: number) { void this.seekTo(positionMs); }

  goLive() { void this.toLive(); }

  // Plays the recording from positionMs (elapsed since the broadcast start). The last seek wins.
  private async seekTo(positionMs: number) {
    const target = this.target, index = this.usableIndex(), signal = this.signal;
    const current = this.history ?? this.live;
    // A recording still waiting for its first frame on the element (swapToHistory) does not drop a newer seek: that seek
    // loads its own recording player and replaces it (the last seek wins).
    const swapping = !!this.history && !this.history.started && !this.history.closed;
    if (!target || !index || !signal || !(current?.started || swapping) || !Number.isFinite(positionMs)) return;
    const token = ++this.seekToken;
    this.closePending();
    const ranges = index.ranges;
    let wall = Math.max(ranges[0].startMs, target.startedAtMs + positionMs);
    if (!ranges.some(r => wall >= r.startMs && wall < r.endMs)) {
      const next = ranges.find(r => r.startMs > wall);
      if (!next) { await this.toLive(); return; }
      wall = next.startMs;
    }
    if (ranges[ranges.length - 1].endMs - wall < HLS_EDGE_MS) { await this.toLive(); return; }
    this.pendingWall = wall;
    this.host.changed();
    try {
      const history = this.history;
      if (history?.started && !history.closed) await this.seekWithin(history, wall, token, signal);
      else await this.seekFromLive(target, wall, token, signal);
    } catch (caught) {
      if (token !== this.seekToken) return;
      const error = asRelayError(caught);
      if (error.kind === 'cancelled') return;
      if (error.kind === 'changed' || error.kind === 'forbidden') { this.host.failed(error); return; }
      this.host.notice('선택한 시점을 재생할 수 없어요.');
      if (this.live?.started && this.ui && !this.userPaused) this.play(this.ui);
    } finally {
      if (token === this.seekToken) { this.pendingWall = null; this.host.changed(); }
    }
  }

  // Within the running recording player: it loads what the new position needs by itself.
  private async seekWithin(media: Media, wall: number, token: number, signal: AbortSignal) {
    let map = this.historyMap(media);
    if (!map.length || wall > mapEnd(map)) {
      media.map = await this.dvrMap(signal);
      media.mapAt = performance.now();
      if (token !== this.seekToken || media.closed) return;
      map = this.historyMap(media);
    }
    const time = mediaAt(map, wall);
    if (time === null || !this.ui) throw new RelayError('not-found', 'no-data');
    media.targetWall = media.lastWall = wall;
    this.pausedLive = null;
    this.ui.currentTime = time;
    if (!this.userPaused) this.play(this.ui);
  }

  private async seekFromLive(target: PlayerTarget, wall: number, token: number, signal: AbortSignal) {
    const map = await this.dvrMap(signal);
    if (token !== this.seekToken) return;
    const time = mediaAt(map, wall);
    if (time === null) throw new RelayError('not-found', 'no-data');
    const url = target.base + target.dvrPlaylist;
    if (this.transport === 'hls.js') {
      // A separate player with an explicit start (an EVENT playlist would open at its newest end) that fetches its
      // first fragment before it has an element: live keeps playing until the recording is there.
      const media = this.createHls(null, url, hlsConfig({
        lowLatencyMode: false, capLevelToPlayerSize: false, startPosition: time, startFragPrefetch: true, maxBufferLength: 15, maxMaxBufferLength: 30,
      }), true);
      media.map = map;
      media.mapAt = performance.now();
      media.targetWall = wall;
      this.pending = media;
      const timeout = sleep(15_000, signal).then(() => { throw new RelayError('network', 'recording timeout'); });
      try {
        await Promise.race([media.prefetched, media.failed, timeout]);
      } catch (caught) {
        if (this.pending === media) this.pending = null;
        this.closeMedia(media);
        throw signal.aborted ? new RelayError('cancelled') : caught;
      }
      if (token !== this.seekToken || media.closed || this.pending !== media) { this.closeMedia(media); return; }
      this.pending = null;
      await this.swapToHistory(media, () => media.hls!.attachMedia(media.video!), signal);
      return;
    }
    // The browser's own player loads only an element in the document: the live picture makes way first.
    const video = this.ui;
    if (!video) throw new RelayError('cancelled');
    const media = this.newMedia('native', video, true);
    media.map = map;
    media.mapAt = performance.now();
    media.targetWall = wall;
    const seeked = new Promise<void>(resolve => video.addEventListener('seeked', () => resolve(), { once: true }));
    await this.swapToHistory(media, () => {
      const onMeta = () => { try { video.currentTime = time; } catch { /* not seekable yet */ } };
      const onError = () => this.mediaFailed(media, new RelayError('network', 'recording error'));
      video.addEventListener('loadedmetadata', onMeta, { once: true });
      video.addEventListener('error', onError);
      media.cleanup.push(() => { video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('error', onError); });
      logRequest(url);
      video.src = url;
    }, signal);
    await Promise.race([seeked, sleep(5000, signal)]);
  }

  // The recording takes the element: live is closed now, so there is only ever one soundtrack; volume, mute and pause
  // carry over. If the recording shows no frame, live comes back.
  private async swapToHistory(media: Media, attach: () => void, signal: AbortSignal) {
    const video = this.ui;
    if (!video) { this.closeMedia(media); throw new RelayError('cancelled'); }
    this.switching = true;
    try {
      this.closeMedia(this.live);
      this.live = null;
      this.closeMedia(this.history);
      this.history = media;
      media.video = video;
      video.srcObject = null;
      attach();
      this.pausedLive = null;
      this.play(video);
      await this.started(media, 15_000, signal);
    } catch (caught) {
      if (this.history === media) this.history = null;
      this.closeMedia(media);
      const error = asRelayError(caught);
      if (error.kind === 'cancelled' || signal.aborted) throw error;
      if (error.kind === 'changed' || error.kind === 'forbidden') throw error;
      this.switching = false;
      this.host.notice('선택한 시점을 재생할 수 없어 실시간으로 돌아왔어요.');
      await this.reopenLive(signal);
      return;
    } finally {
      this.switching = false;
      this.host.changed();
    }
  }

  private async reopenLive(signal: AbortSignal) {
    try {
      await this.openLive(signal);
    } catch (caught) {
      const error = asRelayError(caught);
      if (!isCancelled(error) && !signal.aborted) this.host.failed(error);
    }
  }

  private async toLive() {
    this.seekToken++;
    this.closePending();
    this.pendingWall = null;
    const video = this.ui, signal = this.signal;
    // 실시간 복귀 means watching live now: playback resumes there.
    this.pausedLive = null;
    this.userPaused = false;
    if (!this.history) {
      // On live: a seek still loading is cancelled and the live picture plays on (or again, after a pause).
      if (video && this.live?.started) {
        if (video.paused) this.play(video);
        this.catchUp();
      }
      this.host.changed();
      return;
    }
    if (signal) await this.reopenLive(signal);
  }

  // hls.js's lowest automatic level (config.minAutoBitrate, read at every choice): -1 for none.
  private setFloor(media: Media, index: number) {
    const hls = media.hls;
    media.floor = index;
    if (hls) hls.config.minAutoBitrate = index >= 0 ? hls.levels[index]?.maxBitrate ?? 0 : 0;
  }

  // Automatic quality going up. MediaMTX streams a preload-hinted LL-HLS part while it produces it, so hls.js measures
  // about the bitrate of the level it plays, never the link's capacity: from a lower level its own estimate cannot justify
  // a higher one (measured on loopback: 480p for good while 720p was available). So while the buffer holds and nothing
  // stalled for 20 s, one level up is tried every 20 s as hls.js's floor; a stall or a buffer under 0.5 s drops the floor
  // and hls.js steps down by itself (counted as flipping: the hold below then caps the next probes).
  private probeUp(live: Media, now: number) {
    const hls = live.hls, video = this.ui;
    if (!hls || !video || !live.started || live.closed || this.quality !== 'auto' || this.history || this.userPaused) {
      if (live.floor >= 0) this.setFloor(live, -1);
      return;
    }
    const ahead = bufferedAhead(video);
    if (live.floor >= 0 && (ahead < 0.5 || now - live.stallAt < 2000)) { this.setFloor(live, -1); return; }
    const current = live.levelIndex, cap = hls.autoLevelCapping, top = cap >= 0 ? Math.min(cap, hls.levels.length - 1) : hls.levels.length - 1;
    if (current < 0 || current >= top || ahead < 1 || now - live.stallAt < 20_000 || now - live.probeAt < 20_000 || now - this.hold.lastSwitchAt < 20_000) return;
    live.probeAt = now;
    this.setFloor(live, current + 1);
    hls.nextLoadLevel = current + 1;
  }

  // Once a second from the watch controller: the automatic quality hold and up-probe, and the browser player's recording map.
  tick() {
    const live = this.live, now = performance.now();
    if (live && live.holdCap >= 0 && now >= this.hold.holdUntil) { live.holdCap = -1; live.applyCap(); }
    if ((!live || live.holdCap < 0) && this.hold.holdMs > HOLD.minHoldMs && now - this.hold.lastSwitchAt >= HOLD.calmMs) this.hold.holdMs = HOLD.minHoldMs;
    if (live?.kind === 'hls.js') this.probeUp(live, now);
    const history = this.history, video = this.ui, signal = this.signal;
    if (history?.kind === 'native' && history.started && video && signal && !history.mapLoading) {
      const last = history.map[history.map.length - 1];
      if (last && video.currentTime >= last.start + last.dur - 2 && now - history.mapAt >= 10_000) {
        history.mapLoading = true;
        history.mapAt = now;
        this.dvrMap(signal).then(map => { if (!history.closed && map.length >= history.map.length) history.map = map; }, () => {})
          .finally(() => { history.mapLoading = false; });
      }
    }
  }

  // ---- view -------------------------------------------------------------------------------------------------------
  get mode(): PlaybackView['mode'] {
    return this.history || this.pendingWall !== null || this.pausedLive ? 'history' : 'live';
  }

  get playingHistory() { return !!this.history?.started && !this.history.closed; }

  get status(): PlaybackView['status'] {
    return this.blocked ? 'blocked' : this.userPaused ? 'paused' : 'playing';
  }

  get activeQualityLabel(): string | null {
    const height = this.ui?.videoHeight;
    return this.quality === 'auto' && height ? `${height}p` : null;
  }

  timeline(): PlaybackView['timeline'] {
    const target = this.target;
    if (!target || !target.startedAtMs) return null;
    const start = target.startedAtMs, liveMs = Math.max(0, this.relayNow() - start);
    const index = this.usableIndex();
    const seekStartMs = index ? Math.min(liveMs, Math.max(0, index.ranges[0].startMs - start)) : null;
    let wall: number | null = null;
    if (this.history) wall = this.historyWall();
    else if (this.pendingWall !== null) wall = this.pendingWall;
    else if (this.pausedLive) wall = this.pausedLive.wallMs;
    const positionMs = wall === null ? liveMs : Math.min(liveMs, Math.max(seekStartMs ?? 0, wall - start));
    return { positionMs, liveMs, seekStartMs };
  }

  probe() {
    const media = this.history ?? this.live, hls = media?.hls, video = this.ui;
    const level = hls && media && media.levelIndex >= 0 ? hls.levels[media.levelIndex] : null;
    let latency: number | null = null;
    if (!this.history && hls && Number.isFinite(hls.latency) && hls.latency > 0) latency = Math.round(hls.latency * 1000) / 1000;
    else if (!this.history && media && !hls && video?.seekable.length) latency = Math.round((video.seekable.end(video.seekable.length - 1) - video.currentTime) * 1000) / 1000;
    return {
      video,
      transport: media?.kind ?? this.transport,
      level: level ? { height: level.height, width: level.width, bitrate: level.bitrate }
        : video?.videoHeight ? { height: video.videoHeight, width: video.videoWidth, bitrate: 0 } : null,
      latency,
    };
  }
}
