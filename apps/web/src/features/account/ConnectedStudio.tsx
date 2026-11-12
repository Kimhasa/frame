import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ManagementPage, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import type { BroadcastKey, ChatAccountActions, ViewerAdapter } from '../../viewer-contract';
import { LocalObsStudio } from '../broadcast/LocalObsStudio';
import type { BroadcastPreview } from '../broadcast/broadcast-preview';
import { AccountError, accountApi } from './account-client';
import type { AccountSession, ProductChannel } from './account-client';
import styles from './ConnectedAccount.module.css';

export function ConnectedStudio({ viewer, session, onConnected, onRequireLogin, chatAccount, participationFor }: { viewer: ViewerAdapter; session: AccountSession; onConnected: (channel: ProductChannel) => void; onRequireLogin: () => void; chatAccount?: ChatAccountActions; participationFor?: (broadcast: BroadcastKey) => ReactNode }) {
  const [state, setState] = useState<'loading' | 'connected' | 'unlinked' | 'error'>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [streamKey, setStreamKey] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [broadcast, setBroadcast] = useState<BroadcastPreview>(() => {
    const info = { title: session.channel?.displayName ?? '', category: session.channel?.category ?? '', visibility: '전체 공개', tags: '' };
    return { info, draft: { ...info }, streamKey: '', chatOpen: true, nickname: session.user?.displayName ?? '', messages: [] };
  });
  useEffect(() => {
    const abort = new AbortController(); setState('loading'); setError('');
    void accountApi.studio(abort.signal).then(() => { if (!abort.signal.aborted) setState('connected'); }).catch(failure => {
      if (abort.signal.aborted) return;
      if (failure instanceof AccountError && failure.status === 401) { onRequireLogin(); return; }
      if (failure instanceof AccountError && failure.code === 'CHANNEL_NOT_CONNECTED') setState('unlinked');
      else { setState('error'); setError(failure instanceof Error ? failure.message : '방송 정보를 불러오지 못했어요.'); }
    });
    return () => abort.abort();
  }, [attempt]);
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || !streamKey.trim()) return;
    inFlight.current = true; setPending(true); setError('');
    try { const channel = await accountApi.connectStudio(streamKey.trim(), session.csrfToken); setStreamKey(''); onConnected(channel); setAttempt(value => value + 1); }
    catch (failure) { if (failure instanceof AccountError && failure.status === 401) onRequireLogin(); else setError(failure instanceof Error ? failure.message : '송출 정보를 연결하지 못했어요.'); }
    finally { inFlight.current = false; setPending(false); }
  }
  if (state === 'connected') return <LocalObsStudio viewer={viewer} preview={broadcast} onChange={setBroadcast} endpoint="/api/v1/studio" csrfToken={session.csrfToken} onRequireLogin={onRequireLogin} chatAccount={chatAccount} participationFor={participationFor} />;
  return <ManagementPage title="방송하기" titleId="connected-studio-title">
    {state === 'loading' ? <p role="status">방송 정보를 불러오는 중이에요.</p> : state === 'error'
      ? <EmptyState title="방송 정보를 불러오지 못했어요" description={error} action={<button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}>다시 시도</button>} />
      : <section className={styles.connection} aria-labelledby="connect-obs-title"><h2 id="connect-obs-title">기존 OBS 송출 연결</h2><p>OBS에 설정한 스트림 키로 이 채널의 송출 권한을 확인하세요.</p>
        <form onSubmit={connect} aria-busy={pending}><label htmlFor="connect-stream-key">스트림 키</label><input className={ui.control} id="connect-stream-key" name="streamKey" type="password" autoComplete="off" spellCheck={false} maxLength={4096} required disabled={pending} value={streamKey} onChange={event => { setStreamKey(event.target.value); setError(''); }} />
          {error && <p className={styles.error} role="alert">{error}</p>}<button className={`${ui.button} ${ui.primary}`} type="submit" disabled={pending || !streamKey.trim()}>{pending ? '확인 중' : '송출 연결'}</button>
        </form>
      </section>}
  </ManagementPage>;
}
