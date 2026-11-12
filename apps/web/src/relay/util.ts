// Small timing helpers shared by the relay adapter's controllers.

// Resolves after ms, or at once when the signal aborts (callers check their generation afterwards).
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { window.clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = window.setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ms spread by +-spread (0.2 = 80..120 %), so many viewers do not retry in step.
export const jitter = (ms: number, spread = 0.2) => Math.round(ms * (1 - spread + Math.random() * spread * 2));

// At least ms (a server's Retry-After is a minimum), up to 30 % later.
export const atLeast = (ms: number) => Math.round(ms * (1 + Math.random() * 0.3));

// Unique enough for a chat clientId; crypto.randomUUID needs a secure context (not on plain-HTTP LAN addresses).
export function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through */ }
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

export function storageGet(key: string): string {
  try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
}
export function storageSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode, blocked storage */ }
}

// The page's media element is "ready" with a decoded frame; a hidden page does not decode, so metadata is enough there.
export function waitFrames(video: HTMLVideoElement, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => video.readyState >= 2 || (document.hidden && video.readyState >= 1);
    if (ready()) { resolve(); return; }
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'] as const;
    const cleanup = () => {
      window.clearTimeout(timer);
      for (const name of events) video.removeEventListener(name, check);
      document.removeEventListener('visibilitychange', check);
      signal?.removeEventListener('abort', abort);
    };
    const check = () => { if (ready()) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new DOMException('aborted', 'AbortError')); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
    for (const name of events) video.addEventListener(name, check);
    document.addEventListener('visibilitychange', check);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
