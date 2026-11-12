// Viewer session (apps/api playback/ViewerSessions; relay.mjs viewerSession in the Node baseline): counted viewers and the viewer cap, independent of media requests. Opened
// before HLS playback (POST <base>session -> {sid,heartbeatMs}), kept with PUT every heartbeatMs, closed with DELETE
// (keepalive) on leave. A heartbeat 404 means the session lapsed: the broadcast id is checked again, then a new one is
// opened at the server's pace; a viewer without a session for 60 s stops playing, so nobody plays on past the cap.
import { RelayError, asRelayError, beacon, call, classifyStatus, isCancelled } from './api';
import { logRequest } from './runtime';
import { atLeast, jitter, sleep } from './util';

const RENEW_LIMIT_MS = 60_000;

export type SessionHost = {
  // "/<path>/b/<id>/" (or "/<path>/" on a relay without broadcast scopes).
  base(): string;
  // "/<path>/": sessions belong to the path; its DELETE still works after the path moved on to another broadcast.
  pathBase(): string;
  // Confirms /info still names this broadcast; throws RelayError (not-running, changed, forbidden, network) otherwise.
  verify(signal: AbortSignal): Promise<void>;
  // The session cannot continue: ended, changed, forbidden, or 60 s without one (busy when the server was full).
  fatal(error: RelayError): void;
  changed(): void;
};

export class ViewerSession {
  sid: string | null = null;
  opens = 0;
  // Heartbeats answered (204) and failed, and the last failure (test hooks: window.FrameRuntime.session).
  beats = 0;
  beatFailures = 0;
  lastBeatError: string | null = null;
  // A relay without the endpoint counts viewers by itself.
  sessionless = false;
  private heartbeatMs = 15_000;
  private beat = 0;
  private beating = false;
  private lastBeatAt = 0;
  private active = false;
  private renewing = false;
  private lostAt = 0;
  private abort: AbortController | null = null;

  constructor(private readonly host: SessionHost) {}

  // POST <base>session. Throws RelayError; a full server (429/503) is busy with cap set.
  async open(signal: AbortSignal): Promise<void> {
    if (this.sid || this.sessionless) return;
    const url = this.host.base() + 'session';
    const result = await call(url, { method: 'POST', signal, timeoutMs: 5000 }, async response => {
      const body = await response.text();
      if (response.status === 200) {
        let data: unknown = null;
        try { data = JSON.parse(body); } catch { /* not JSON */ }
        const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const sid = typeof record.sid === 'string' && /^[0-9a-f]{16,64}$/.test(record.sid) ? record.sid : null;
        const beat = typeof record.heartbeatMs === 'number' ? record.heartbeatMs : 15_000;
        return { sid, heartbeatMs: Math.min(30_000, Math.max(5000, beat)) };
      }
      const error = classifyStatus(response.status, body, response.headers.get('Retry-After'));
      // No such endpoint (an older relay): it counts viewers without sessions.
      if (error.kind === 'not-found' || response.status === 405 || response.status === 501) return { sid: null, heartbeatMs: 0 };
      if (error.kind === 'busy') error.cap = true;
      throw error;
    });
    if (signal.aborted) {
      // Answered after the page moved on: close it at once instead of leaving it to expire.
      if (result.sid) beacon(this.host.base() + 'session/' + result.sid, 'DELETE');
      throw new RelayError('cancelled');
    }
    if (!result.sid) { this.sessionless = true; return; }
    if (this.sid) {
      // A concurrent open (the connection loop and a renewal) won: close this one instead of leaving it counted for 30 s.
      if (this.sid !== result.sid) beacon(this.host.base() + 'session/' + result.sid, 'DELETE');
      return;
    }
    this.sid = result.sid;
    this.heartbeatMs = result.heartbeatMs;
    this.lastBeatAt = Date.now();
    this.opens++;
    this.lostAt = 0;
    this.host.changed();
  }

  // Heartbeats (and renewal) while playback runs.
  start() {
    if (this.active) return;
    this.active = true;
    this.abort = new AbortController();
    document.addEventListener('visibilitychange', this.onVisible);
    this.schedule();
    if (!this.sid && !this.sessionless) void this.renew();
  }

  // A hidden page's timers may run far less often than asked (a muted background tab can be held to one wake-up a
  // minute): coming back, a heartbeat that is due goes out at once instead of after the remaining delay.
  private onVisible = () => {
    if (document.visibilityState !== 'visible' || !this.active || this.sessionless) return;
    if (Date.now() - this.lastBeatAt >= this.heartbeatMs) void this.heartbeat();
  };

  // Stops heartbeats and closes the session on the server (keepalive, so it also works while the page unloads).
  stop() {
    document.removeEventListener('visibilitychange', this.onVisible);
    this.active = false;
    window.clearTimeout(this.beat);
    this.abort?.abort();
    this.abort = null;
    this.renewing = false;
    this.lostAt = 0;
    this.close();
  }

  // pagehide: the page may never come back, close now; pageshow (back-forward cache) opens a new one.
  close() {
    const sid = this.sid;
    if (!sid) return;
    this.sid = null;
    // The broadcast-scoped route answers 409 once the path serves the next broadcast; the session is the path's, so it is
    // then closed on the path route instead of being left to expire (it would count as a viewer of the next broadcast).
    const scoped = this.host.base() + 'session/' + sid, plain = this.host.pathBase() + 'session/' + sid;
    logRequest(scoped);
    try {
      fetch(scoped, { method: 'DELETE', keepalive: true, cache: 'no-store', credentials: 'same-origin' })
        .then(response => { if (response.status === 409 && plain !== scoped) beacon(plain, 'DELETE'); }, () => {});
    } catch { /* ignore */ }
    this.host.changed();
  }

  resume() {
    if (this.active && !this.sid && !this.sessionless) void this.renew();
  }

  private schedule() {
    window.clearTimeout(this.beat);
    if (!this.active || this.sessionless) return;
    this.beat = window.setTimeout(() => void this.heartbeat(), this.heartbeatMs);
  }

  private async heartbeat() {
    if (!this.active || this.beating) return;
    this.beating = true;
    window.clearTimeout(this.beat);
    const sid = this.sid, signal = this.abort?.signal;
    if (!sid || !signal) { this.beating = false; void this.renew(); this.schedule(); return; }
    try {
      await call(this.host.base() + 'session/' + sid, { method: 'PUT', signal, timeoutMs: 5000, keepalive: true }, async response => {
        if (response.status === 204 || response.ok) return;
        const error = classifyStatus(response.status, await response.text().catch(() => ''), response.headers.get('Retry-After'));
        throw error;
      });
      this.beats++;
      this.lastBeatAt = Date.now();
    } catch (caught) {
      if (isCancelled(caught) || !this.active || this.sid !== sid) return;
      const error = asRelayError(caught);
      this.beatFailures++;
      this.lastBeatError = `${error.kind}${error.status ? ' ' + error.status : ''}`;
      if (error.kind === 'changed' || error.kind === 'forbidden') { this.host.fatal(error); return; }
      if (error.kind === 'not-running' || error.kind === 'not-found') {
        // Unknown or expired session: open a new one after checking the broadcast.
        this.sid = null;
        this.host.changed();
        void this.renew();
      }
      // Network errors and busy answers: the next heartbeat tries again (the session lives 30 s on the server).
    } finally {
      this.beating = false;
      this.schedule();
    }
  }

  private async renew() {
    if (!this.active || this.sid || this.sessionless || this.renewing) return;
    this.renewing = true;
    this.lostAt ||= Date.now();
    const signal = this.abort?.signal;
    let tries = 0;
    try {
      while (this.active && !this.sid && signal && !signal.aborted) {
        let error: RelayError;
        try {
          await this.host.verify(signal);
          await this.open(signal);
          return;
        } catch (caught) {
          if (isCancelled(caught) || !this.active) return;
          error = asRelayError(caught);
        }
        if (['not-running', 'changed', 'forbidden'].includes(error.kind)) { this.host.fatal(error); return; }
        const elapsed = Date.now() - this.lostAt;
        if (elapsed >= RENEW_LIMIT_MS) {
          const full = error.kind === 'busy' && error.cap;
          const ended = new RelayError(full ? 'busy' : 'network', 'session-lost', error.status, error.retryAfterMs);
          ended.cap = full;
          this.host.fatal(ended);
          return;
        }
        // Never sooner than the server's Retry-After, growing; the last attempt falls on the minute.
        const pause = Math.min(RENEW_LIMIT_MS - elapsed, atLeast((error.retryAfterMs ?? jitter(2000)) * ++tries));
        await sleep(Math.max(1000, pause), signal);
      }
    } finally {
      this.renewing = false;
    }
  }
}
