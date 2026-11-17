import { useEffect, useRef, useState } from 'react';
import { StatusBadge } from '../../components/management/ManagementUI';
import type { StatusTone } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { developerClient, developerFailure } from './developer-client';
import type { DeveloperWebhook, WebhookDelivery } from './developer-client';
import { dateText, Modal } from './DeveloperControls';
import { useDeveloperMutation } from './useDeveloperMutation';
import type { DeveloperAccessError } from './useDeveloperMutation';
import styles from './ConnectedDeveloperPage.module.css';

const statuses: Record<WebhookDelivery['status'], { label: string; tone: StatusTone }> = { pending: { label: '대기 중', tone: 'warning' }, inflight: { label: '전송 중', tone: 'info' }, succeeded: { label: 'HTTP 전송 성공', tone: 'positive' }, failed: { label: '전송 실패', tone: 'danger' }, cancelled: { label: '취소됨', tone: 'neutral' } };
const errors: Record<string, string> = { TIMEOUT: '수신 서버 응답 시간 초과', DNS_FAILED: '수신 서버의 주소를 확인하지 못했어요.', TARGET_BLOCKED: '서버 정책에서 허용하지 않는 수신 주소예요.', INTERRUPTED: '전송 작업이 중단되었어요.', INVALID_PAYLOAD: '전송할 요청을 확인하지 못했어요.', NETWORK_ERROR: '수신 서버 연결 실패', HTTP_ERROR: '수신 서버가 오류 응답을 반환했어요.', WEBHOOK_DISABLED: '웹훅이 중지되어 전송이 취소되었어요.', WEBHOOK_REVOKED: '웹훅이 삭제되어 전송이 취소되었어요.' };
export function DeveloperDeliveryDialog({ item, test, api, online, onClose, onAccessError }: { item: DeveloperWebhook; test: boolean; api: ReturnType<typeof developerClient>; online: boolean; onClose: () => void; onAccessError: DeveloperAccessError }) {
  const [items, setItems] = useState<WebhookDelivery[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const active = useRef(true), fetching = useRef(false), started = useRef(false), current = useRef({ api, online, onAccessError }); current.current = { api, online, onAccessError };
  const mutation = useDeveloperMutation({ run: async requestId => ({ item: await api.testWebhook(item.id, requestId) }), verify: requestId => api.testReceipt(item.id, requestId), onSaved: delivery => setItems(values => [delivery, ...values.filter(value => value.id !== delivery.id)]), onAccessError });
  async function load() {
    if (fetching.current || !current.current.online || document.visibilityState === 'hidden') return;
    fetching.current = true; setLoading(true);
    try {
      const values = await current.current.api.deliveries(item.id);
      if (active.current) {
        // A GET started before test acceptance must not erase its newly returned pending item.
        setItems(previous => [...values, ...previous.filter(value => !values.some(received => received.id === value.id))].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 100));
        setError('');
      }
    }
    catch (failure) { if (active.current && !current.current.onAccessError(failure)) setError(developerFailure(failure).message); }
    finally { fetching.current = false; if (active.current) setLoading(false); }
  }
  useEffect(() => {
    active.current = true; void load();
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (test && online && !started.current) { started.current = true; void mutation.submit(); }
  }, [test, online]);
  const pending = items.some(value => value.status === 'pending' || value.status === 'inflight');
  useEffect(() => {
    if (!pending || !online) return;
    const timer = window.setInterval(() => void load(), 2000), wake = () => void load();
    document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); };
  }, [pending, online]);
  const unresolved = test && (mutation.busy || mutation.locked);
  return <Modal title={test ? '테스트 전송 결과' : '웹훅 전송 기록'} busy={mutation.busy} locked={mutation.locked} onClose={onClose}>
    <p><strong>{item.name}</strong><span className={styles.subtext}>{item.url}</span></p>
    <p className={styles.hint}>{test ? '서버가 실제 HTTP 요청을 전송해요. 대기·전송 중은 성공을 뜻하지 않아요.' : '방송 시작·종료 이벤트와 테스트 요청의 최근 전송 기록이에요.'}</p>
    {mutation.error && <p className={styles.error} role="alert">{mutation.error}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!online && <p className={styles.error} role="status">인터넷 연결이 끊겼어요. 연결 후 전송 기록을 새로고침해 주세요.</p>}
    {test && mutation.busy && <p className={styles.hint} role="status">테스트 요청을 접수하는 중이에요.</p>}
    <ul className={styles.deliveryList} aria-label="최근 전송 기록" aria-live="polite">{items.map(delivery => <li key={delivery.id} className={styles.delivery}><div><strong>{delivery.event === 'webhook.test' ? '연결 테스트' : delivery.event === 'broadcast.started' ? '방송 시작' : '방송 종료'}</strong><StatusBadge tone={statuses[delivery.status].tone}>{statuses[delivery.status].label}</StatusBadge></div><small>접수 {dateText(delivery.createdAtMs)}{delivery.completedAtMs !== null ? ` · 완료 ${dateText(delivery.completedAtMs)}` : ''}</small>{delivery.httpStatus !== null && <small>실제 HTTP 응답 {delivery.httpStatus}</small>}{delivery.errorCode && <small>{errors[delivery.errorCode] ?? `오류 코드: ${delivery.errorCode}`}</small>}<small>전송 ID {delivery.id}</small></li>)}</ul>
    {!items.length && <p className={styles.empty} role="status">{loading ? '전송 기록을 불러오는 중이에요.' : test && unresolved ? '요청 결과를 확인하고 있어요.' : '아직 전송 기록이 없어요.'}</p>}
    <div className={ui.dialogActions}>
      {mutation.locked && <button type="button" className={ui.button} disabled={!online || mutation.busy} onClick={() => void mutation.check()}>결과 확인</button>}
      {mutation.phase === 'absent' && <button type="button" className={ui.button} disabled={!online} onClick={() => void mutation.submit()}>같은 요청으로 다시 시도</button>}
      <button type="button" className={ui.button} disabled={!online || loading || mutation.busy} onClick={() => void load()}>{loading ? '확인 중…' : '전송 기록 새로고침'}</button>
      <button type="button" className={`${ui.button} ${ui.primary}`} disabled={mutation.busy || mutation.locked} onClick={onClose}>닫기</button>
    </div>
  </Modal>;
}
