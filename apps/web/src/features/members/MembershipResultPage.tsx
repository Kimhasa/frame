import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { channelPath, transactionsPath } from '../../preview/community-types';
import type { AccountSession } from '../account/account-client';
import { membershipClient, membershipFailure } from './membership-client';
import type { Membership } from './membership-client';
import { clearMembershipCallback } from './membership-callback';
import type { MembershipCallback } from './membership-callback';
import { MembershipDetails } from './MembershipUI';
import styles from './Membership.module.css';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const authorizations = new Map<string, Promise<Membership>>();
function authorizeOnce(api: ReturnType<typeof membershipClient>, owner: string, callback: MembershipCallback): Promise<Membership> {
  const key = `${owner}:${callback.membershipId}:${callback.requestId}`, pending = authorizations.get(key); if (pending) return pending;
  const result = api.authorize(callback.membershipId, callback.authKey, callback.customerKey, callback.requestId);
  authorizations.set(key, result); void result.finally(() => { authorizations.delete(key); clearMembershipCallback(callback); }).catch(() => {}); return result;
}
export function MembershipResultPage({ session, sessionReady, callback, failed = false, onRequireLogin, onSessionChanged }: { session: AccountSession | null; sessionReady: boolean; callback: MembershipCallback | null; failed?: boolean; onRequireLogin: () => void; onSessionChanged: () => void }) {
  const api = useMemo(() => membershipClient(session), [session?.user?.id, session?.csrfToken]);
  const [item, setItem] = useState<Membership | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [online, setOnline] = useState(navigator.onLine), [attempt, setAttempt] = useState(0), [denied, setDenied] = useState(false);
  const started = useRef(false), owner = useRef<string | null>(null), generation = useRef(0), reconcileAbort = useRef<AbortController | null>(null), reconcileBusy = useRef(false), callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  const valid = Boolean(callback && uuid.test(callback.membershipId) && uuid.test(callback.requestId));
  const accessError = useCallback((failure: unknown) => { const e = membershipFailure(failure); if (e.status === 401 || e.status === 403 || e.code === 'SESSION_CHANGED') { clearMembershipCallback(callback); setDenied(true); setItem(null); if (e.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged(); return true; } return false; }, [callback]);
  useEffect(() => { const connected = () => { setOnline(true); setAttempt(value => value + 1); }, offline = () => setOnline(false); window.addEventListener('online', connected); window.addEventListener('offline', offline); return () => { window.removeEventListener('online', connected); window.removeEventListener('offline', offline); reconcileAbort.current?.abort(); }; }, []);
  useEffect(() => {
    if (!sessionReady || !session?.user || !valid || !callback) return;
    if (owner.current && owner.current !== session.user.id) { clearMembershipCallback(callback); setDenied(true); setItem(null); return; }
    owner.current = session.user.id; const abort = new AbortController(), visit = ++generation.current; setLoading(true); setError('');
    async function check() {
      try {
        let result: Membership;
        const existingAuthorization = authorizations.get(`${session!.user!.id}:${callback!.membershipId}:${callback!.requestId}`);
        if (existingAuthorization) result = await existingAuthorization;
        else if (!failed && !started.current && callback!.authKey && callback!.customerKey) {
          started.current = true;
          if (callback!.authKey.length > 1000 || callback!.customerKey.length > 300) throw new Error('카드 등록 응답을 확인할 수 없어요.');
          // Authorization is shared only while this exact account/request is in flight.
          // StrictMode and refresh never issue a new billing authorization request UUID.
          result = await authorizeOnce(api, session!.user!.id, callback!);
        } else result = await api.detail(callback!.membershipId, abort.signal);
        if (!abort.signal.aborted && generation.current === visit) setItem(result);
      } catch (failure) {
        if (abort.signal.aborted || generation.current !== visit || accessError(failure)) return;
        setError(membershipFailure(failure).message);
        // A lost authorize response is reconciled using GET, never a second authorization.
        try { const current = await api.detail(callback!.membershipId, abort.signal); if (!abort.signal.aborted && generation.current === visit) setItem(current); } catch (readFailure) { if (!abort.signal.aborted) accessError(readFailure); }
      } finally { if (!abort.signal.aborted && generation.current === visit) setLoading(false); }
    }
    void check(); return () => { abort.abort(); ++generation.current; };
  }, [api, callback, sessionReady, session?.user?.id, failed, valid, attempt, accessError]);
  const pending = item?.paymentPending || item?.status === 'issuing' || item?.status === 'pending_charge';
  useEffect(() => { if (!pending || !online) return; const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') setAttempt(value => value + 1); }, 2500); return () => window.clearInterval(timer); }, [pending, online]);
  async function reconcile() {
    if (!item || reconcileBusy.current || !online) return; reconcileBusy.current = true; const abort = new AbortController(); reconcileAbort.current = abort; setLoading(true);
    try { const current = await api.reconcile(item.id, abort.signal); if (!abort.signal.aborted) { setItem(current); setError(''); } } catch (failure) { if (!abort.signal.aborted && !accessError(failure)) setError(membershipFailure(failure).message); } finally { reconcileBusy.current = false; if (!abort.signal.aborted) setLoading(false); }
  }
  const confirmed = item?.status === 'active' && item.entitled && !item.paymentPending;
  const title = confirmed ? '멤버십 가입이 완료되었어요' : item?.status === 'failed' ? '멤버십 결제를 완료하지 못했어요' : item?.status === 'issue_unknown' ? '카드 등록 결과를 확인할 수 없어요' : failed ? callback?.cancelled ? '카드 등록을 취소했어요' : '카드 등록을 완료하지 못했어요' : '멤버십 가입 상태를 확인해요';
  if (denied) return <ManagementPage title="멤버십 결제 결과"><EmptyState title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="멤버십 결제 결과" titleId="membership-result-title"><section className={styles.result} aria-busy={loading}><h2>{title}</h2>{!sessionReady ? <p role="status">계정 정보를 확인하고 있어요.</p> : !session?.user ? <><p>가입을 시작한 계정으로 로그인한 뒤 결과를 확인해 주세요.</p><button type="button" className={ui.button} onClick={onRequireLogin}>로그인</button></> : !valid ? <p className={styles.error} role="alert">가입 요청 정보를 확인할 수 없어요. 결제 내역에서 상태를 확인해 주세요.</p> : <>{loading && <p role="status">서버에서 실제 가입·결제 결과를 확인하고 있어요.</p>}{item && <MembershipDetails item={item} />}{!confirmed && !failed && <p className={styles.hint}>카드 등록 화면에서 돌아왔어도 서버의 결제 승인이 확인되기 전에는 가입 완료로 표시하지 않아요.</p>}{error && <p className={styles.error} role="alert">{error}</p>}{!online && <p className={styles.warning}>인터넷 연결 후 가입 상태를 다시 확인해 주세요.</p>}<div className={styles.actions}><button type="button" className={ui.button} disabled={loading || !online} onClick={() => item ? void reconcile() : setAttempt(value => value + 1)}>상태 다시 확인</button>{item && <Link className={ui.button} to={channelPath(item.channel.handle)}>채널로 돌아가기</Link>}<Link className={`${ui.button} ${ui.primary}`} to={transactionsPath}>내 멤버십·결제 내역</Link></div></>}</section></ManagementPage>;
}
