import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useSearchParams } from 'react-router';
import { ChatClient } from '../../relay/chat';
import type { ChatMessage } from '../../viewer-contract';
import { fetchOverlayChannel, OverlayError } from './overlay-client';
import { parseOverlayOptions } from './overlay-options';
import styles from './ChatOverlayPage.module.css';

type Phase = 'loading' | 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'error';
type OverlayState = { phase: Phase; channelName: string; messages: readonly ChatMessage[]; error: string };
const initialState: OverlayState = { phase: 'loading', channelName: '', messages: [], error: '' };
const statusText: Record<Phase, string> = {
  loading: '채널을 확인하고 있어요.', waiting: '방송이 시작되면 채팅이 자동으로 연결돼요.',
  connecting: '실시간 채팅에 연결하고 있어요.', connected: '실시간 채팅에 연결됐어요.',
  reconnecting: '채팅을 다시 연결하고 있어요.', error: '채널 연결을 다시 확인하고 있어요.',
};

export default function ChatOverlayPage({ channelId }: { channelId: string }) {
  const [params] = useSearchParams();
  const query = params.toString();
  const options = useMemo(() => parseOverlayOptions(new URLSearchParams(query)), [query]);
  const preview = params.get('preview') === '1';
  const [state, setState] = useState<OverlayState>(initialState);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);

  useLayoutEffect(() => {
    const elements = [document.documentElement, document.body, document.getElementById('root')].filter((element): element is HTMLElement => element !== null);
    const previous = elements.map(element => ({ element, background: Array.from(element.style).filter(property => property === 'background' || property.startsWith('background-'))
      .map(property => ({ property, value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) })) }));
    for (const element of elements) element.style.setProperty('background', 'transparent', 'important');
    return () => { for (const { element, background } of previous) {
      element.style.removeProperty('background');
      for (const { property, value, priority } of background) element.style.setProperty(property, value, priority);
    } };
  }, []);

  useEffect(() => {
    const update = () => setAttempt(value => value + 1);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  useEffect(() => {
    setNow(Date.now());
    if (options.hideAfterSeconds === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [options.hideAfterSeconds]);

  useEffect(() => {
    let active = true, timer = 0, channelName = '', key = '';
    let request: AbortController | null = null, chat: ChatClient | null = null;
    setState(initialState); setNow(Date.now());
    function stopChat() {
      const previous = chat; chat = null; key = ''; previous?.close();
    }
    function connect(broadcast: { id: string; path: string }) {
      const nextKey = `${broadcast.path}/${broadcast.id}`;
      if (key === nextKey && chat && chat.status !== 'closed') {
        setState(previous => ({ ...previous, channelName })); return;
      }
      stopChat(); key = nextKey;
      setState({ phase: 'connecting', channelName, messages: [], error: '' });
      const connection = new ChatClient(broadcast.path, broadcast.id, () => {
        if (!active || chat !== connection) return;
        setNow(Date.now());
        setState({ phase: connection.status === 'closed' ? 'waiting' : connection.status,
          channelName, messages: connection.status === 'closed' ? [] : connection.messages,
          error: connection.error ?? '' });
      }, { readOnly: true });
      chat = connection; connection.open();
    }
    async function poll() {
      const abort = new AbortController(); request = abort;
      let delay = 5000;
      try {
        if (!navigator.onLine) throw new OverlayError('인터넷 연결을 확인해 주세요. 연결되면 자동으로 다시 시도해요.');
        const channel = await fetchOverlayChannel(channelId, abort.signal);
        if (!active) return;
        channelName = channel.displayName;
        if (channel.liveBroadcast) connect(channel.liveBroadcast);
        else { stopChat(); setState({ phase: 'waiting', channelName, messages: [], error: '' }); }
      } catch (failure) {
        if (!active) return;
        if (failure instanceof OverlayError) delay = Math.max(delay, failure.retryAfterMs);
        stopChat();
        setState({ phase: 'error', channelName, messages: [], error: failure instanceof Error ? failure.message : '채널을 확인하지 못했어요.' });
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), delay);
      }
    }
    void poll();
    return () => { active = false; window.clearTimeout(timer); request?.abort(); stopChat(); };
  }, [channelId, attempt]);

  const visible = state.messages.filter(message => options.hideAfterSeconds === 0 || now - message.sentAtMs < options.hideAfterSeconds * 1000).slice(-options.maxMessages);
  const style = { '--overlay-font-size': `${options.fontSize}px` } as CSSProperties;
  return <main className={`${styles.overlay} ${preview ? styles.preview : ''}`} style={style}
    data-chat-overlay data-overlay-preview={preview ? 'true' : 'false'} data-theme={options.theme} data-phase={state.phase} aria-label="실시간 채팅 오버레이">
    {preview && <aside className={styles.status} data-overlay-status aria-live="polite">
      <strong>{state.channelName ? `${state.channelName} · 채팅 미리보기` : '채팅 미리보기'}</strong>
      <p>{state.error || statusText[state.phase]}</p>
      <p>체크무늬와 이 안내는 OBS용 주소에 표시되지 않아요. 공개 채팅을 읽기 전용으로 표시해요.</p>
      {state.phase !== 'connected' && <button type="button" data-overlay-retry onClick={() => setAttempt(value => value + 1)}>다시 시도</button>}
    </aside>}
    <ol className={styles.messages} data-overlay-messages aria-label="채팅 메시지" aria-live="polite" aria-relevant="additions">
      {visible.map(message => <li key={message.id} className={styles.message} data-overlay-message data-message-id={message.id}>
        <strong className={styles.author}>{message.author}{message.isOwner && <span className={styles.owner}>방송자</span>}</strong>
        <span className={styles.text}>{message.text}</span>
      </li>)}
    </ol>
  </main>;
}
