import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BroadcastKey, ChatAccountActions, ViewerAdapter, WatchView } from '../../viewer-contract';
import { BroadcastPage } from './BroadcastPage';
import type { BroadcastInfo, BroadcastPreview } from './broadcast-preview';

type Status = {
  state: 'waiting' | 'live' | 'reconnecting' | 'unavailable';
  path: string; broadcastId: string | null; mediaReady: boolean;
  serverUrl: string; streamKey: string; title: string; publisher: string;
  width?: number | null; height?: number | null; fps?: number | null; bitrateMbps?: number | null; audioCodec?: string | null;
};
export type ObsStudioView = {
  status: Status | null;
  error: string | null;
  watch?: WatchView;
  save: (info: BroadcastInfo, signal?: AbortSignal) => Promise<void>;
};

function Connected({ viewer, status, onWatch }: {
  viewer: ViewerAdapter; status: Status; onWatch: (value: { id: string; view: WatchView } | null) => void;
}) {
  const watch = viewer.useWatch({ path: status.path, id: status.broadcastId! });
  const muted = useRef(false);
  useEffect(() => { if (!muted.current) { muted.current = true; if (!watch.playback.muted) watch.playback.toggleMuted(); } }, [watch.playback]);
  useEffect(() => { onWatch({ id: status.broadcastId!, view: watch }); }, [watch, status.broadcastId, onWatch]);
  useEffect(() => () => onWatch(null), [onWatch]);
  return null;
}

export function LocalObsStudio({ viewer, preview, onChange, endpoint, csrfToken, onRequireLogin, chatAccount, participationFor }: { viewer: ViewerAdapter; preview: BroadcastPreview; onChange: (preview: BroadcastPreview) => void; endpoint?: string; csrfToken?: string; onRequireLogin?: () => void; chatAccount?: ChatAccountActions; participationFor?: (broadcast: BroadcastKey) => ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receiver, setReceiver] = useState<{ id: string; view: WatchView } | null>(null);
  const initialized = useRef(false);
  const requireLoginRef = useRef(onRequireLogin);
  requireLoginRef.current = onRequireLogin;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => {
    const abort = new AbortController(); let timer: number;
    async function poll() {
      let delay = 1500;
      try {
        const response = await fetch(endpoint ?? `${import.meta.env.BASE_URL}api/studio`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]), cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) {
          const retry = Number(response.headers.get('Retry-After'));
          if (Number.isFinite(retry) && retry > 0) delay = Math.min(30000, retry * 1000);
          if (endpoint) {
            if (response.status === 401 || response.status === 403) setStatus(null);
            if (response.status === 401) requireLoginRef.current?.();
            const problem = await response.json().catch(() => null); throw new Error(typeof problem?.detail === 'string' ? problem.detail : '방송 서버에 연결할 수 없어요.');
          }
          throw new Error('방송 서버에 연결할 수 없어요. 서버 상태를 확인해 주세요.');
        }
        const value: Status = await response.json();
        if (!/^obs-[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/.test(value.path) || typeof value.streamKey !== 'string' || typeof value.serverUrl !== 'string'
          || (value.broadcastId !== null && !/^[0-9a-f]{32}$/.test(value.broadcastId))) throw new Error('송출 정보를 불러오지 못했어요.');
        if (abort.signal.aborted) return;
        setStatus(value); setError(null);
        if (!initialized.current) {
          initialized.current = true;
          const info = { ...previewRef.current.info, title: value.title, visibility: '전체 공개' };
          onChange({ ...previewRef.current, info, draft: { ...info } });
        }
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '송출 정보를 불러오지 못했어요.');
      } finally { if (!abort.signal.aborted) timer = window.setTimeout(poll, delay); }
    }
    void poll();
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [onChange, endpoint]);

  async function save(info: BroadcastInfo, signal?: AbortSignal) {
    if (!status) throw new Error('송출 정보를 먼저 불러와 주세요.');
    const response = await fetch(endpoint ?? `${import.meta.env.BASE_URL}api/studio`, {
      method: 'PUT', credentials: 'same-origin', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]), headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {}) }, body: JSON.stringify({ title: info.title, publisher: status.publisher }),
    });
    if (!response.ok) { if (endpoint && response.status === 401) requireLoginRef.current?.(); throw new Error('방송 정보를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    setStatus(current => current ? { ...current, title: info.title } : current);
  }

  return <>
    {status?.broadcastId && <Connected key={status.broadcastId} viewer={viewer} status={status} onWatch={setReceiver} />}
    <BroadcastPage preview={preview} onChange={onChange} studio={{ status, error, save, watch: receiver?.id === status?.broadcastId ? receiver?.view : undefined }} chatAccount={chatAccount} participation={status?.broadcastId ? participationFor?.({ path: status.path, id: status.broadcastId }) : undefined} />
  </>;
}
