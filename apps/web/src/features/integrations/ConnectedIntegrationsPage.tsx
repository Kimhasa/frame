import { CodeXml, Copy, ExternalLink, Link2, MessagesSquare, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { broadcastPath, developerPath } from '../../preview/community-types';
import type { AccountSession } from '../account/account-client';
import { ChatBotSettings } from './ChatBotSettings';
import { fetchOverlayChannel } from './overlay-client';
import { overlayUrl, parseOverlayOptions } from './overlay-options';
import type { OverlayOptions } from './overlay-options';
import styles from './ConnectedIntegrationsPage.module.css';

type PageProps = {
  session: AccountSession;
  onRequireLogin: () => void;
  onSessionChanged?: () => void;
};
type BroadcastStatus = 'loading' | 'live' | 'waiting' | 'error';
type CopyStatus = 'idle' | 'busy' | 'copied' | 'failed';

function ChannelIntegrations({ session, onRequireLogin, onSessionChanged }: PageProps) {
  const channelId = session.channel!.id, displayName = session.channel!.displayName;
  const [params, setParams] = useSearchParams();
  const options = parseOverlayOptions(params);
  const sourceUrl = overlayUrl(channelId, options);
  const previewUrl = overlayUrl(channelId, options, true);
  const [status, setStatus] = useState<BroadcastStatus>('loading');
  const [checking, setChecking] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [retry, setRetry] = useState(0);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const sourceInput = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const copyOperation = useRef(0);
  const copyPending = useRef(false);
  const currentUrl = useRef(sourceUrl);
  currentUrl.current = sourceUrl;
  const id = useId();

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; copyOperation.current += 1; };
  }, []);

  useEffect(() => {
    copyOperation.current += 1;
    copyPending.current = false;
    setCopyStatus('idle');
  }, [sourceUrl]);

  useEffect(() => {
    let disposed = false;
    let request: AbortController | null = null;
    let loading = false;
    async function load() {
      if (disposed || loading || document.visibilityState === 'hidden') return;
      if (!navigator.onLine) {
        setStatus('error');
        setStatusError('인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
        return;
      }
      const abort = new AbortController();
      request = abort;
      loading = true;
      setChecking(true);
      try {
        const channel = await fetchOverlayChannel(channelId, abort.signal);
        if (disposed || abort.signal.aborted) return;
        setStatus(channel.liveBroadcast ? 'live' : 'waiting');
        setStatusError('');
      } catch {
        if (disposed || abort.signal.aborted) return;
        setStatus('error');
        setStatusError('방송 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');
      } finally {
        if (request === abort) {
          loading = false;
          if (!disposed) setChecking(false);
        }
      }
    }
    function offline() {
      request?.abort();
      loading = false;
      setChecking(false);
      setStatus('error');
      setStatusError('인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
    }
    const wake = () => void load();
    void load();
    const timer = window.setInterval(wake, 15000);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', wake);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [channelId, retry]);

  function updateOption<K extends keyof OverlayOptions>(key: K, value: OverlayOptions[K]) {
    const next = new URLSearchParams(params);
    next.set(key, String(value));
    setParams(next, { replace: true });
  }

  function selectUrl() {
    sourceInput.current?.focus();
    sourceInput.current?.select();
  }

  async function copyUrl() {
    if (copyPending.current) return;
    const operation = ++copyOperation.current;
    const value = sourceUrl;
    copyPending.current = true;
    setCopyStatus('busy');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      if (active.current && operation === copyOperation.current && currentUrl.current === value) setCopyStatus('copied');
    } catch {
      if (active.current && operation === copyOperation.current && currentUrl.current === value) {
        setCopyStatus('failed');
        selectUrl();
      }
    } finally {
      if (operation === copyOperation.current) copyPending.current = false;
    }
  }

  const statusLabel = status === 'live' ? '방송 중' : status === 'waiting' ? '방송 대기' : status === 'error' ? '확인 실패' : '방송 확인 중';

  return <ManagementPage title="외부 도구 연결" titleId="integrations-title">
    <ul className={styles.list}>
      <li className={styles.row}>
        <span className={styles.icon} aria-hidden="true"><Link2 size={21} /></span>
        <div className={styles.summary}><h2>방송 도구</h2><p>OBS에서 송출할 서버와 스트림 키를 확인해요.</p></div>
        <Link className={`${ui.button} ${styles.rowAction}`} to={`${broadcastPath}?tab=stream`}>송출 정보</Link>
      </li>
      <li className={`${styles.row} ${styles.overlayRow}`}>
        <span className={styles.icon} aria-hidden="true"><MessagesSquare size={21} /></span>
        <div className={styles.summary}>
          <div className={styles.heading}><h2>채팅 오버레이</h2><span role="status"><StatusBadge tone={status === 'live' ? 'live' : status === 'error' ? 'warning' : 'neutral'}>{statusLabel}</StatusBadge></span></div>
          <p>{displayName} 채널의 공개 채팅을 방송 화면에 표시해요.</p>
        </div>
        <button type="button" className={`${ui.button} ${styles.rowAction}`} disabled={checking} aria-label="방송 상태 새로고침" onClick={() => setRetry(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />{checking ? '확인 중…' : '상태 새로고침'}</button>
        <div className={styles.overlayBody}>
          {statusError && <p className={styles.error} role="alert">{statusError}</p>}
          {status === 'waiting' && <p className={styles.waiting}>방송을 시작하면 이 주소로 새 채팅을 받아요. 지금도 OBS에 추가할 수 있어요.</p>}
          <div className={styles.urlField}>
            <label htmlFor={`${id}-url`}>OBS 브라우저 소스 URL</label>
            <div className={styles.urlActions}>
              <input ref={sourceInput} id={`${id}-url`} name="overlay-url" type="text" className={`${ui.control} ${styles.urlInput}`} readOnly spellCheck={false} autoComplete="off" value={sourceUrl} aria-describedby={`${id}-url-hint ${id}-copy-status`} onFocus={event => event.currentTarget.select()} onClick={event => event.currentTarget.select()} />
              <button type="button" className={`${ui.button} ${ui.primary}`} disabled={copyStatus === 'busy'} onClick={() => void copyUrl()}><Copy size={16} aria-hidden="true" />{copyStatus === 'busy' ? '복사 중…' : 'URL 복사'}</button>
              <a className={ui.button} href={previewUrl} target="_blank" rel="noopener noreferrer">새 탭 미리보기<ExternalLink size={16} aria-hidden="true" /></a>
            </div>
            <p className={styles.hint} id={`${id}-url-hint`}>공개 채팅을 표시하는 주소예요. 로그인이나 스트림 키가 필요하지 않아요.</p>
            <div id={`${id}-copy-status`} className={styles.copyFeedback} role="status" aria-live="polite">
              {copyStatus === 'copied' && <p>URL을 복사했어요. OBS의 브라우저 소스에 붙여넣어 주세요.</p>}
              {copyStatus === 'failed' && <><p>복사하지 못했어요. 선택된 주소를 Ctrl+C 또는 길게 눌러 직접 복사해 주세요.</p><button type="button" className={styles.textButton} onClick={selectUrl}>주소 선택</button></>}
            </div>
          </div>
          <fieldset className={styles.options}>
            <legend>표시 설정</legend>
            <div className={styles.optionGrid}>
              <label>테마<select name="overlay-theme" className={ui.control} value={options.theme} onChange={event => updateOption('theme', event.target.value as OverlayOptions['theme'])}><option value="dark">어두운 테마</option><option value="light">밝은 테마</option></select></label>
              <label>글자 크기<select name="overlay-font-size" className={ui.control} value={options.fontSize} onChange={event => updateOption('fontSize', Number(event.target.value))}>{Array.from({ length: 19 }, (_, index) => index + 14).map(value => <option key={value} value={value}>{value}px</option>)}</select></label>
              <label>최대 메시지 수<select name="overlay-max-messages" className={ui.control} value={options.maxMessages} onChange={event => updateOption('maxMessages', Number(event.target.value))}>{Array.from({ length: 20 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}개</option>)}</select></label>
              <label>메시지 표시 시간<select name="overlay-hide-after" className={ui.control} value={options.hideAfterSeconds} onChange={event => updateOption('hideAfterSeconds', Number(event.target.value))}><option value="0">계속 표시</option>{Array.from({ length: 120 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}초</option>)}</select></label>
            </div>
            <p className={styles.hint}>설정은 위 URL에 바로 반영돼요. 변경한 URL을 복사해 OBS에 다시 붙여넣어 주세요.</p>
          </fieldset>
          <div className={styles.instructions}>
            <h3>OBS에 추가하기</h3>
            <ol><li>소스 목록에서 <strong>+ → 브라우저</strong>를 선택해요.</li><li>위 URL을 붙여넣고 너비 <strong>400</strong>, 높이 <strong>600</strong>으로 설정해요.</li><li>미리보기에서 모양을 확인하고 방송 화면에 배치해요.</li></ol>
            <p>배경은 투명해요. 설정한 시간이 지나면 메시지가 사라져요.</p>
          </div>
        </div>
      </li>
      <ChatBotSettings session={session} onRequireLogin={onRequireLogin} onSessionChanged={onSessionChanged} />
      <li className={styles.row}>
        <span className={styles.icon} aria-hidden="true"><CodeXml size={21} /></span>
        <div className={styles.summary}><h2>API 및 웹훅</h2><p>외부 앱의 접근 권한과 방송 이벤트 전송을 관리해요.</p></div>
        <Link className={`${ui.button} ${styles.rowAction}`} to={developerPath}>개발자 설정</Link>
      </li>
    </ul>
  </ManagementPage>;
}

export function ConnectedIntegrationsPage({ session, onRequireLogin, onSessionChanged }: PageProps) {
  if (!session.user || !session.channel) return <ManagementPage title="외부 도구 연결" titleId="integrations-title">
    <EmptyState title={session.user ? '채널 정보를 확인해 주세요' : '로그인이 필요해요'} description="내 채널의 채팅 오버레이 주소를 확인할 수 있어요." action={session.user
      ? onSessionChanged && <button type="button" className={ui.button} onClick={onSessionChanged}>채널 정보 새로고침</button>
      : <button type="button" className={ui.button} onClick={onRequireLogin}>로그인</button>} />
  </ManagementPage>;
  return <ChannelIntegrations key={`${session.user.id}:${session.channel.id}`} session={session} onRequireLogin={onRequireLogin} onSessionChanged={onSessionChanged} />;
}
