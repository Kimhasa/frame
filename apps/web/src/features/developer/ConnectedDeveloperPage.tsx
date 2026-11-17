import { CodeXml } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import type { AccountSession } from '../account/account-client';
import { developerClient, developerFailure } from './developer-client';
import type { DeveloperKey, DeveloperWebhook } from './developer-client';
import { DeveloperKeys } from './DeveloperKeys';
import { DeveloperWebhooks } from './DeveloperWebhooks';
import styles from './ConnectedDeveloperPage.module.css';

type Props = { session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void };
function mergeMetadata<T extends { id: string; version: number; createdAtMs: number; revokedAtMs: number | null }>(current: T[], received: T[]): T[] {
  const merged = new Map(current.map(item => [item.id, item]));
  for (const item of received) { const prior = merged.get(item.id); if (!prior || prior.version <= item.version) merged.set(item.id, item); }
  return [...merged.values()].sort((a, b) => Number(b.revokedAtMs === null) - Number(a.revokedAtMs === null) || b.createdAtMs - a.createdAtMs).slice(0, 100);
}
function DeveloperSettings({ session, onRequireLogin, onSessionChanged }: Props) {
  const [keys, setKeys] = useState<DeveloperKey[]>([]), [webhooks, setWebhooks] = useState<DeveloperWebhook[]>([]);
  const [keyLoading, setKeyLoading] = useState(true), [webhookLoading, setWebhookLoading] = useState(true), [keyError, setKeyError] = useState(''), [webhookError, setWebhookError] = useState('');
  const [denied, setDenied] = useState(false), [online, setOnline] = useState(navigator.onLine);
  const active = useRef(true), generation = useRef(0), keyBusy = useRef(false), webhookBusy = useRef(false), callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  const api = useMemo(() => developerClient(session), [session.user?.id, session.channel?.id, session.csrfToken]);
  const onAccessError = useCallback((failure: unknown) => {
    if (!active.current) return true;
    const error = developerFailure(failure);
    if (error.status === 401 || error.status === 403 || ['SESSION_CHANGED', 'CSRF_INVALID'].includes(error.code)) {
      setDenied(true); setKeys([]); setWebhooks([]);
      if (error.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged();
      return true;
    }
    return false;
  }, []);
  async function loadKeys() {
    if (!active.current || keyBusy.current) return;
    const visit = generation.current;
    if (!navigator.onLine) { setKeyLoading(false); setKeyError('인터넷 연결을 확인해 주세요.'); return; }
    keyBusy.current = true; setKeyLoading(true);
    try { const values = await api.keys(); if (active.current && generation.current === visit) { setKeys(current => mergeMetadata(current, values)); setKeyError(''); } }
    catch (failure) { if (active.current && generation.current === visit && !onAccessError(failure)) setKeyError(developerFailure(failure).message); }
    finally { if (generation.current === visit) { keyBusy.current = false; if (active.current) setKeyLoading(false); } }
  }
  async function loadWebhooks() {
    if (!active.current || webhookBusy.current) return;
    const visit = generation.current;
    if (!navigator.onLine) { setWebhookLoading(false); setWebhookError('인터넷 연결을 확인해 주세요.'); return; }
    webhookBusy.current = true; setWebhookLoading(true);
    try { const values = await api.webhooks(); if (active.current && generation.current === visit) { setWebhooks(current => mergeMetadata(current, values)); setWebhookError(''); } }
    catch (failure) { if (active.current && generation.current === visit && !onAccessError(failure)) setWebhookError(developerFailure(failure).message); }
    finally { if (generation.current === visit) { webhookBusy.current = false; if (active.current) setWebhookLoading(false); } }
  }
  useEffect(() => {
    active.current = true; generation.current += 1; api.activate(); void loadKeys(); void loadWebhooks();
    const offline = () => setOnline(false), connected = () => { setOnline(true); void loadKeys(); void loadWebhooks(); };
    window.addEventListener('offline', offline); window.addEventListener('online', connected);
    return () => { active.current = false; generation.current += 1; keyBusy.current = false; webhookBusy.current = false; api.dispose(); window.removeEventListener('offline', offline); window.removeEventListener('online', connected); };
  }, [api]);
  // Identity changes remount this component and all dialogs, dropping every one-time secret.
  if (denied) return <ManagementPage title="개발자 설정" titleId="developer-title"><EmptyState icon={<CodeXml size={24} />} title="계정 정보를 다시 확인해 주세요" description="로그인 계정이나 채널 접근 권한이 변경되었어요." action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="개발자 설정" titleId="developer-title">
    <div className={styles.stack}>
      {!online && <p className={styles.warning} role="status">인터넷 연결이 끊겼어요. 연결이 복구되면 목록을 다시 확인해요.</p>}
      <DeveloperKeys items={keys} loading={keyLoading} loadError={keyError} api={api} online={online} onReload={() => void loadKeys()} onSaved={item => setKeys(values => mergeMetadata(values, [item]))} onAccessError={onAccessError} />
      <DeveloperWebhooks items={webhooks} loading={webhookLoading} loadError={webhookError} api={api} online={online} onReload={() => void loadWebhooks()} onSaved={item => setWebhooks(values => mergeMetadata(values, [item]))} onAccessError={onAccessError} />
    </div>
  </ManagementPage>;
}
export function ConnectedDeveloperPage(props: Props) {
  if (!props.session.user || !props.session.channel) return <ManagementPage title="개발자 설정" titleId="developer-title"><EmptyState icon={<CodeXml size={24} />} title={props.session.user ? '내 채널을 확인해 주세요' : '로그인하고 개발자 설정을 이용해 주세요'} description="내 채널의 API 키와 웹훅을 관리할 수 있어요." action={<button type="button" className={ui.button} onClick={props.session.user ? props.onSessionChanged : props.onRequireLogin}>{props.session.user ? '계정 다시 확인' : '로그인'}</button>} /></ManagementPage>;
  return <DeveloperSettings key={`${props.session.user.id}:${props.session.channel.id}`} {...props} />;
}
