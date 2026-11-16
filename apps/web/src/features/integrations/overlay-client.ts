export type OverlayChannel = {
  id: string;
  handle: string;
  displayName: string;
  liveBroadcast: { id: string; path: string } | null;
};

export class OverlayError extends Error {
  constructor(message: string, readonly status = 0, readonly retryAfterMs = 0) { super(message); }
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

export async function fetchOverlayChannel(id: string, signal: AbortSignal): Promise<OverlayChannel> {
  if (!uuid.test(id)) throw new OverlayError('채널 주소를 확인해 주세요.', 400);
  let response: Response;
  try {
    response = await fetch(`/api/v1/channel-ids/${encodeURIComponent(id)}`, {
      credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
  } catch (failure) {
    if (signal.aborted) throw failure;
    throw new OverlayError('채널에 연결하지 못했어요. 연결을 다시 확인하고 있어요.');
  }
  if (!response.ok) {
    const raw = response.headers.get('Retry-After');
    const retryAfterMs = raw && /^\d{1,5}$/.test(raw) ? Math.min(Number(raw) * 1000, 120000) : 0;
    throw new OverlayError(response.status === 404 ? '채널을 찾을 수 없어요. 주소를 확인해 주세요.' : '채널 정보를 불러오지 못했어요.', response.status, retryAfterMs);
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new OverlayError('채널 응답을 확인하지 못했어요.'); }
  if (!record(value) || value.id !== id || typeof value.handle !== 'string' || !/^[a-z][a-z0-9_-]{2,23}$/.test(value.handle)
    || typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 200) throw new OverlayError('채널 응답을 확인하지 못했어요.');
  let liveBroadcast: OverlayChannel['liveBroadcast'] = null;
  if (value.liveBroadcast !== null) {
    const live = value.liveBroadcast;
    if (!record(live) || typeof live.id !== 'string' || !/^[0-9a-f]{32}$/.test(live.id)
      || typeof live.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(live.path)) throw new OverlayError('방송 응답을 확인하지 못했어요.');
    liveBroadcast = { id: live.id, path: live.path };
  }
  return { id, handle: value.handle, displayName: value.displayName, liveBroadcast };
}
