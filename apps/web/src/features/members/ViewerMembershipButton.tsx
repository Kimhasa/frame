import { Crown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import ui from '../../components/management/ManagementUI.module.css';
import type { AccountSession } from '../account/account-client';
import { membershipClient, membershipFailure } from './membership-client';
import type { Membership, MembershipPlan, MembershipSignup } from './membership-client';
import { membershipMoney, MembershipDetails, MembershipModal } from './MembershipUI';
import { MembershipCancelDialog } from './MembershipCancelDialog';
import { openMembershipBilling } from './membership-sdk';
import { useMembershipMutation } from './useMembershipMutation';
import type { MembershipAccessError } from './useMembershipMutation';
import styles from './Membership.module.css';

function JoinDialog({ channelId, channelName, plan, api, online, onClose, onSaved, onAccessError }: { channelId: string; channelName: string; plan: MembershipPlan; api: ReturnType<typeof membershipClient>; online: boolean; onClose: () => void; onSaved: (item: Membership) => void; onAccessError: MembershipAccessError }) {
  const [consent, setConsent] = useState(false), [error, setError] = useState(''), [checkoutBusy, setCheckoutBusy] = useState(false), [signup, setSignup] = useState<MembershipSignup | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), active = useRef(true), checkoutAbort = useRef<AbortController | null>(null), checkoutPending = useRef(false), requestIdRef = useRef('');
  useEffect(() => { active.current = true; return () => { active.current = false; checkoutAbort.current?.abort(); }; }, []);
  async function startBilling(result: MembershipSignup, requestId: string) {
    if (!result.checkout || checkoutPending.current) return;
    checkoutPending.current = true; setCheckoutBusy(true); setError(''); const abort = new AbortController(); checkoutAbort.current = abort;
    try { await openMembershipBilling({ ...result.checkout, requestId, signal: abort.signal, beforeOpen: () => dialog.current?.close() }); if (active.current && !abort.signal.aborted) setError('카드 등록창을 닫았어요. 가입 상태를 확인한 뒤 다시 진행해 주세요.'); }
    catch (failure) { if (active.current && !abort.signal.aborted) { const code = failure && typeof failure === 'object' ? (failure as { code?: unknown }).code : undefined; setError(code === 'PAY_PROCESS_CANCELED' ? '카드 등록을 취소했어요. 아직 가입 결제가 확정되지 않았어요.' : '카드 등록창을 완료하지 못했어요. 가입 상태를 확인한 뒤 다시 진행해 주세요.'); } }
    finally { checkoutPending.current = false; if (active.current && !abort.signal.aborted) { setCheckoutBusy(false); if (!dialog.current?.open) dialog.current?.showModal(); } }
  }
  const mutation = useMembershipMutation({ run: (id, signal) => api.join(channelId, plan.version, id, signal), verify: (id, signal) => api.joinReceipt(id, signal), onSaved: result => { setSignup(result); onSaved(result.item); if (result.checkout) void startBilling(result, requestIdRef.current); }, onAccessError });
  requestIdRef.current = mutation.requestId;
  const ready = plan.paymentsReady && plan.enabled;
  return <MembershipModal title="멤버십 가입" elementRef={dialog} busy={mutation.busy || checkoutBusy} locked={mutation.locked} onClose={onClose}>
    <p><strong>{channelName}</strong>의 멤버십이에요.</p><dl className={styles.info}><div><dt>월 이용료</dt><dd>{membershipMoney(plan.amount)} · 매월 자동결제</dd></div><div><dt>이용 기간</dt><dd>첫 결제 승인일부터 한 달</dd></div></dl><p className={styles.benefits}>{plan.benefits || '별도 안내된 혜택이 없어요.'}</p>
    {!plan.paymentsReady && <p className={styles.warning}>월 자동결제 테스트 설정이 완료되지 않았어요. 카드 등록과 가입을 진행할 수 없어요.</p>}{!plan.enabled && <p className={styles.warning}>이 채널은 현재 신규 멤버십 가입을 받지 않아요.</p>}
    <p className={styles.hint}>가입 당시 월 이용료로 매월 자동결제돼요. 해지하면 다음 자동결제만 중지하고 이미 결제한 기간은 유지해요. 해지는 환불이 아니에요.</p>
    {!signup && <AuthCheckbox checked={consent} disabled={mutation.busy || mutation.locked || checkoutBusy || !ready} onChange={event => setConsent(event.currentTarget.checked)}>월 자동결제와 해지 안내를 확인했어요.</AuthCheckbox>}
    {signup && !signup.checkout && <MembershipDetails item={signup.item} />}
    {(error || mutation.error) && <p className={styles.error} role="alert">{error || mutation.error}</p>}
    <div className={ui.dialogActions}>{!mutation.locked && <button type="button" className={ui.button} disabled={mutation.busy || checkoutBusy} onClick={onClose}>닫기</button>}{mutation.locked && <button type="button" className={ui.button} disabled={!online || mutation.busy} onClick={() => void mutation.check()}>결과 확인</button>}{signup?.checkout && <button type="button" className={`${ui.button} ${ui.primary}`} disabled={!online || checkoutBusy} onClick={() => void startBilling(signup, mutation.requestId)}>{checkoutBusy ? '카드 등록 중…' : '카드 등록 계속'}</button>}{!signup && (!mutation.locked || mutation.phase === 'absent') && <button type="button" className={`${ui.button} ${ui.primary}`} disabled={!ready || !online || !consent || mutation.busy || checkoutBusy} onClick={() => void mutation.submit()}>{mutation.busy ? '가입 준비 중…' : mutation.phase === 'absent' ? '같은 요청으로 다시 시도' : '카드 등록하고 가입'}</button>}</div>
  </MembershipModal>;
}
export function ViewerMembershipButton({ channelId, channelName, session, sessionReady, onRequireLogin, onSessionChanged }: { channelId: string; channelName: string; session: AccountSession | null; sessionReady: boolean; onRequireLogin: () => void; onSessionChanged: () => void }) {
  const api = useMemo(() => membershipClient(session), [session?.user?.id, session?.csrfToken]);
  const [plan, setPlan] = useState<MembershipPlan | null>(null), [item, setItem] = useState<Membership | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [open, setOpen] = useState(false), [joining, setJoining] = useState(false), [joinPlan, setJoinPlan] = useState<MembershipPlan | null>(null), [cancel, setCancel] = useState(false), [online, setOnline] = useState(navigator.onLine), [denied, setDenied] = useState(false);
  const callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  const lookup = useRef<AbortController | null>(null), lookupBusy = useRef(false);
  const onAccessError = useCallback((failure: unknown) => { const e = membershipFailure(failure); if (e.status === 401 || e.status === 403 || e.code === 'SESSION_CHANGED') { setDenied(true); setOpen(false); setCancel(false); setItem(null); if (e.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged(); return true; } return false; }, []);
  useEffect(() => { const connected = () => { setOnline(true); setAttempt(value => value + 1); }, offline = () => setOnline(false); window.addEventListener('online', connected); window.addEventListener('offline', offline); return () => { window.removeEventListener('online', connected); window.removeEventListener('offline', offline); }; }, []);
  useEffect(() => { if (!sessionReady) { setOpen(false); setCancel(false); setJoining(false); setJoinPlan(null); } }, [sessionReady]);
  useEffect(() => () => lookup.current?.abort(), []);
  useEffect(() => { const abort = new AbortController(); setLoading(true); setError(''); void api.channel(channelId, abort.signal).then(value => { if (!abort.signal.aborted) { setPlan(value.plan); setItem(value.membership); } }).catch(failure => { if (!abort.signal.aborted && !onAccessError(failure)) setError(membershipFailure(failure).message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); return () => abort.abort(); }, [api, channelId, attempt, onAccessError]);
  const existing = item !== null && item.status !== 'ended' && item.cancelRequestedAtMs === null || Boolean(item?.entitled) || Boolean(item?.paymentPending);
  async function check() {
    if (!item || !online || lookupBusy.current) return;
    const abort = new AbortController(); lookup.current = abort; lookupBusy.current = true; setLoading(true);
    try { const current = await api.reconcile(item.id, abort.signal); if (!abort.signal.aborted) { setItem(current); setError(''); } }
    catch (failure) { if (!abort.signal.aborted && !onAccessError(failure)) setError(membershipFailure(failure).message); }
    finally { lookupBusy.current = false; if (!abort.signal.aborted) setLoading(false); }
  }
  function show() { if (!session?.user) { onRequireLogin(); return; } if (denied) { onSessionChanged(); return; } setJoining(!existing); setJoinPlan(plan); setOpen(true); }
  return <><button type="button" data-channel-action className={styles.joinButton} aria-haspopup="dialog" disabled={!sessionReady || loading} onClick={show}><Crown size={16} aria-hidden="true" />{loading ? '멤버십 확인 중…' : existing ? '내 멤버십' : '멤버십 가입'}</button>
    {open && (!joining && item ? <MembershipModal title="내 멤버십" busy={loading} onClose={() => setOpen(false)}><MembershipDetails item={item} />{error && <p className={styles.error} role="alert">{error}</p>}<div className={ui.dialogActions}><button type="button" className={ui.button} disabled={loading || !online} onClick={() => void check()}>상태 확인</button>{item.cancelRequestedAtMs === null && item.status !== 'ended' && <button type="button" className={`${ui.button} ${ui.danger}`} disabled={!online || loading} onClick={() => { setOpen(false); setCancel(true); }}>멤버십 해지</button>}<button type="button" className={ui.button} disabled={loading} onClick={() => setOpen(false)}>닫기</button></div></MembershipModal> : (joinPlan ?? plan) && (!error || joinPlan) ? <JoinDialog key={`${session?.user?.id}:${channelId}`} channelId={channelId} channelName={channelName} plan={(joinPlan ?? plan)!} api={api} online={online} onClose={() => { setOpen(false); setJoining(false); }} onSaved={setItem} onAccessError={onAccessError} /> : <MembershipModal title="멤버십 가입" busy={loading} onClose={() => setOpen(false)}><p className={styles.error} role="alert">{error || '멤버십 정보를 확인하지 못했어요.'}</p><div className={ui.dialogActions}><button type="button" className={ui.button} disabled={loading || !online} onClick={() => setAttempt(value => value + 1)}>다시 확인</button><button type="button" className={ui.button} disabled={loading} onClick={() => setOpen(false)}>닫기</button></div></MembershipModal>)}
    {cancel && item && <MembershipCancelDialog item={item} api={api} online={online} onClose={() => { setCancel(false); setOpen(true); }} onSaved={setItem} onAccessError={onAccessError} />}
  </>;
}
