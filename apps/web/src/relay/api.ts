// Requests to the existing relay (apps/api; server/relay.mjs is its Node comparison baseline) on the page's own origin, their JSON shape checks, and the error
// classification every caller shares. The relay mixes JSON, text and empty error bodies, so the HTTP status and
// Retry-After decide first; the body only tells "not running" from other 404s and "media not ready" from other 503s.
import type { BroadcastSummary } from '../viewer-contract';
import { logRequest } from './runtime';

export const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const ID_RE = /^[0-9a-f]{32}$/;
const PLAYLIST_RE = /^[a-z0-9][a-z0-9_.-]{0,63}\.m3u8$/i;

export type FailureKind =
  | 'cancelled'   // our own abort (navigation, newer attempt): never shown
  | 'forbidden'   // 401/403: stop, no retry, no other protocol
  | 'not-running' // 404 not-running, info running:false
  | 'changed'     // 409: another broadcast now uses the path
  | 'waiting'     // 503 "Media is not ready yet" (or info mediaReady:false): the sender is reconnecting
  | 'busy'        // 429/503 with Retry-After (cap: the viewer limit of a session or WHEP offer)
  | 'not-found'   // other 404 (a quality, a recording part, an endpoint this relay lacks)
  | 'network'     // no answer, timeout, connection refused
  | 'server'      // other 5xx and unexpected statuses
  | 'media'       // the browser could not decode or buffer the stream
  | 'shape'       // an answer that is not what the relay contract describes
  | 'unsupported';// this browser has no way to play the stream

export class RelayError extends Error {
  readonly kind: FailureKind;
  readonly status: number;
  readonly retryAfterMs: number | null;
  // True for the viewer limit (session POST, WHEP offer): handled with the bounded busy policy.
  cap = false;
  constructor(kind: FailureKind, message: string = kind, status = 0, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'RelayError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const isCancelled = (error: unknown) => error instanceof RelayError && error.kind === 'cancelled';
export const asRelayError = (error: unknown): RelayError => (error instanceof RelayError ? error : new RelayError('network', String((error as Error)?.message || error)));

// Retry-After in seconds or as an HTTP date, bounded to 1..30 s (the relay sends 1, 2, 5, 10 or 15).
export function retryAfterMs(value: string | null | undefined, fallbackS = 2): number {
  let seconds = Number.NaN;
  const text = (value || '').trim();
  if (/^\d{1,6}$/.test(text)) seconds = Number(text);
  else if (text) {
    const date = Date.parse(text);
    if (Number.isFinite(date)) seconds = (date - Date.now()) / 1000;
  }
  if (!Number.isFinite(seconds)) seconds = fallbackS;
  return Math.round(Math.min(30, Math.max(1, seconds)) * 1000);
}

export function classifyStatus(status: number, body: string, retryAfter: string | null): RelayError {
  let code = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.error === 'string') code = parsed.error;
  } catch { /* text or empty body */ }
  const message = code || body.slice(0, 120) || `HTTP ${status}`;
  if (status === 401 || status === 403) return new RelayError('forbidden', message, status);
  if (status === 409) return new RelayError('changed', message, status);
  if (status === 404 || status === 410) {
    const notRunning = code === 'not-running' || /not running/i.test(body);
    return new RelayError(notRunning || status === 410 ? 'not-running' : 'not-found', message, status);
  }
  if (status === 503 && /not ready/i.test(body)) return new RelayError('waiting', message, status, retryAfterMs(retryAfter, 2));
  if (status === 429 || status === 503) return new RelayError('busy', message, status, retryAfterMs(retryAfter, 2));
  return new RelayError('server', message, status);
}

async function failure(response: Response): Promise<RelayError> {
  let body = '';
  try { body = (await response.text()).slice(0, 2000); } catch { /* aborted or broken body */ }
  return classifyStatus(response.status, body, response.headers.get('Retry-After'));
}

export type RequestOptions = {
  method?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  keepalive?: boolean;
  cache?: RequestCache;
};

// fetch with the caller's AbortSignal and a timeout that also covers reading the body (read() runs inside it).
export async function call<T>(url: string, options: RequestOptions, read: (response: Response) => Promise<T>): Promise<T> {
  const { signal, timeoutMs = 8000, cache = 'no-store', ...init } = options;
  if (signal?.aborted) throw new RelayError('cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  logRequest(url);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, cache, credentials: 'same-origin', signal: controller.signal });
    } catch {
      throw new RelayError(signal?.aborted ? 'cancelled' : 'network', timedOut ? 'timeout' : 'network');
    }
    try {
      return await read(response);
    } catch (error) {
      if (signal?.aborted) throw new RelayError('cancelled');
      if (error instanceof RelayError) throw error;
      throw new RelayError(timedOut ? 'network' : 'shape', timedOut ? 'timeout' : 'shape');
    }
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Fire and forget (leaving the page, closing a session): keepalive so the request outlives the page.
export function beacon(url: string, method: 'DELETE' | 'PUT') {
  logRequest(url);
  try { fetch(url, { method, keepalive: true, cache: 'no-store', credentials: 'same-origin' }).catch(() => {}); } catch { /* ignore */ }
}

export async function okOrThrow(response: Response) {
  if (!response.ok) throw await failure(response);
  return response;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 400) => (typeof value === 'string' ? value.slice(0, max) : '');
const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function parseSourceVideo(width: unknown, height: unknown, fps: unknown): BroadcastSummary['sourceVideo'] {
  const w = num(width), h = num(height), frameRate = num(fps);
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) return undefined;
  return { width: w, height: h, fps: frameRate > 0 ? frameRate : undefined };
}

// Never the list's baseUrl or absolute thumbnailUrl: the page only talks to its own origin.
export const thumbnailPath = (id: string) => `/thumbnails/${id}.jpg`;
export const streamBase = (path: string) => `/${encodeURIComponent(path)}/`;

// ---- GET /api/broadcasts -------------------------------------------------------------------------------------------
export function parseBroadcastList(value: unknown): BroadcastSummary[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new RelayError('shape', 'broadcast list');
  const out = new Map<string, BroadcastSummary>();
  for (const item of value.items) {
    if (!isRecord(item)) continue;
    const id = text(item.id, 64), path = text(item.path, 64);
    if (!ID_RE.test(id) || !PATH_RE.test(path) || item.running === false) continue;
    out.set(id, {
      id, path,
      title: text(item.title, 200) || path,
      publisher: text(item.publisher, 100),
      thumbnailUrl: thumbnailPath(id),
      avatarUrl: null,
      category: null,
      viewerCount: null,
      startedAtMs: Math.max(0, num(item.startedAtMs)),
      sourceVideo: parseSourceVideo(item.width, item.height, item.fps),
    });
  }
  return [...out.values()];
}

export async function fetchBroadcasts(signal: AbortSignal): Promise<BroadcastSummary[]> {
  return call('/api/broadcasts', { signal, timeoutMs: 8000 }, async response => parseBroadcastList(await (await okOrThrow(response)).json()));
}

// ---- GET /<path>/info -------------------------------------------------------------------------------------------------
export type Rendition = { name: string; width: number; height: number };

export type RelayInfo = {
  running: true;
  mediaReady: boolean;
  path: string;
  broadcastId: string;
  title: string;
  publisher: string;
  startedAtMs: number;
  // Relay clock minus the page's clock when the answer arrived (the relay's startedAtMs + elapsedMs is its "now").
  clockOffsetMs: number;
  width: number;
  height: number;
  fps: number;
  dvr: boolean;
  // Relative to /<path>/: the scope "b/<id>/" binds every media URL and cache key to this broadcast.
  hls: { master: string; scope: string | null; dvr: string | null } | null;
  renditions: Rendition[];
  iceServers: RTCIceServer[];
  retryAfterMs: number | null;
};

export type InfoResult = RelayInfo | { running: false; path: string; retryAfterMs: number | null };

export function parseInfo(value: unknown, path: string, retryAfter: string | null): InfoResult {
  if (!isRecord(value) || typeof value.running !== 'boolean') throw new RelayError('shape', 'info');
  const wait = retryAfter ? retryAfterMs(retryAfter, 2) : null;
  if (!value.running) return { running: false, path, retryAfterMs: wait };
  const broadcastId = text(value.broadcastId, 64);
  if (!ID_RE.test(broadcastId)) throw new RelayError('shape', 'info broadcastId');
  const startedAtMs = num(value.startedAtMs), elapsedMs = num(value.elapsedMs, Number.NaN);
  let hls: RelayInfo['hls'] = null;
  if (isRecord(value.hls) && PLAYLIST_RE.test(text(value.hls.master, 80))) {
    const scope = text(value.hls.scope, 80);
    const dvr = text(value.hls.dvr, 80);
    hls = { master: text(value.hls.master, 80), scope: scope === `b/${broadcastId}/` ? scope : null, dvr: PLAYLIST_RE.test(dvr) ? dvr : null };
  }
  const renditions: Rendition[] = [];
  if (Array.isArray(value.renditions)) {
    for (const r of value.renditions) {
      if (!isRecord(r) || !/^(240|360|480|720|1080|1440)p$/.test(text(r.name, 8))) continue;
      renditions.push({ name: text(r.name, 8), width: num(r.width), height: num(r.height) || Number.parseInt(text(r.name, 8), 10) });
    }
  }
  const iceServers = Array.isArray(value.iceServers)
    ? value.iceServers.filter((s): s is RTCIceServer => isRecord(s) && (typeof s.urls === 'string' || Array.isArray(s.urls)))
    : [];
  return {
    running: true,
    mediaReady: value.mediaReady !== false,
    path: PATH_RE.test(text(value.path, 64)) ? text(value.path, 64) : path,
    broadcastId,
    title: text(value.title, 200) || path,
    publisher: text(value.publisher, 100),
    startedAtMs,
    clockOffsetMs: Number.isFinite(elapsedMs) && startedAtMs > 0 ? startedAtMs + elapsedMs - Date.now() : 0,
    width: num(value.width), height: num(value.height), fps: num(value.fps),
    dvr: value.dvr === true,
    hls, renditions, iceServers,
    retryAfterMs: wait,
  };
}

export async function fetchInfo(path: string, signal: AbortSignal): Promise<InfoResult> {
  return call(streamBase(path) + 'info', { signal, timeoutMs: 5000 }, async response => {
    await okOrThrow(response);
    return parseInfo(await response.json(), path, response.headers.get('Retry-After'));
  });
}

export function summaryFromInfo(info: RelayInfo): BroadcastSummary {
  return {
    id: info.broadcastId, path: info.path, title: info.title, publisher: info.publisher,
    thumbnailUrl: thumbnailPath(info.broadcastId), avatarUrl: null, category: null, viewerCount: null,
    startedAtMs: info.startedAtMs,
    sourceVideo: parseSourceVideo(info.width, info.height, info.fps),
  };
}

// ---- GET <scope>dvr ---------------------------------------------------------------------------------------------------
export type DvrIndex = { id: string; ranges: { startMs: number; endMs: number }[]; segments: number[]; gopMs: number };

// null: no recording for this broadcast (DVR off). An index with another id: the path changed broadcast.
export function parseDvrIndex(value: unknown): DvrIndex | null | { running: false } {
  if (!isRecord(value)) throw new RelayError('shape', 'dvr index');
  if (value.running === false) return { running: false };
  if (value.dvr !== true || !Array.isArray(value.ranges)) return null;
  const id = text(value.id, 64);
  const ranges = value.ranges.filter(isRecord).map(r => ({ startMs: num(r.startMs), endMs: num(r.endMs) }))
    .filter(r => r.startMs > 0 && r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs);
  const segments = Array.isArray(value.segments) ? value.segments.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b) : [];
  return { id, ranges, segments, gopMs: num(value.gopMs, 1000) || 1000 };
}
