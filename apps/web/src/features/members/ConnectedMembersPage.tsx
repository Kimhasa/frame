import { UsersRound } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import { EmptyState, ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import type { AccountSession } from '../account/account-client';
import { membershipClient, membershipFailure } from './membership-client';
import type { MemberFilters, Membership, MembershipPlan, MembershipPlanDraft } from './membership-client';
import { membershipDate, membershipMoney, MembershipDetails, MembershipModal, MembershipStatus } from './MembershipUI';
import { useMembershipMutation } from './useMembershipMutation';
import type { MembershipAccessError } from './useMembershipMutation';
import styles from './Membership.module.css';

type Props = { session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void };
const emptyFilters: MemberFilters = { status: 'all', q: '', from: '', to: '' };
function PlanConfirmation({ plan, draft, api, online, onClose, onSaved, onAccessError }: { plan: MembershipPlan; draft: MembershipPlanDraft; api: ReturnType<typeof membershipClient>; online: boolean; onClose: () => void; onSaved: (value: MembershipPlan) => void; onAccessError: MembershipAccessError }) {
  const [done, setDone] = useState(false);
  const mutation = useMembershipMutation({ run: (id, signal) => api.savePlan(draft, plan.version, id, signal), verify: (id, signal) => api.planReceipt(id, signal), onSaved: value => { onSaved(value); setDone(true); }, onAccessError });
  return <MembershipModal title={done ? '멤버십 설정을 저장했어요' : '멤버십 설정을 변경할까요?'} busy={mutation.busy} locked={mutation.locked} onClose={onClose}><dl className={styles.info}><div><dt>운영</dt><dd>{draft.enabled ? '신규 가입 받기' : '신규 가입·다음 자동결제 중지'}</dd></div><div><dt>월 이용료</dt><dd>{membershipMoney(draft.amount)}</dd></div></dl><p className={styles.benefits}>{draft.benefits || '등록된 혜택 없음'}</p>{!draft.enabled && !done && <p className={styles.warning}>운영을 중지하면 신규 가입을 받지 않고 기존 멤버의 다음 자동결제도 중지해요. 이미 결제한 기간은 유지돼요. 다시 운영해도 기존 자동결제는 재개되지 않아요.</p>}{draft.enabled && <p className={styles.hint}>변경한 월 이용료와 혜택은 새 가입에 적용해요. 기존 멤버는 가입 당시 월 이용료와 혜택을 유지해요.</p>}{mutation.error && <p className={styles.error} role="alert">{mutation.error}</p>}<div className={ui.dialogActions}>{done ? <button type="button" className={`${ui.button} ${ui.primary}`} onClick={onClose}>확인</button> : <>{!mutation.locked && <button type="button" className={ui.button} disabled={mutation.busy} onClick={onClose}>취소</button>}{mutation.locked && <button type="button" className={ui.button} disabled={!online || mutation.busy} onClick={() => void mutation.check()}>결과 확인</button>}{(!mutation.locked || mutation.phase === 'absent') && <button type="button" className={`${ui.button} ${ui.primary}`} disabled={!online || mutation.busy} onClick={() => void mutation.submit()}>{mutation.busy ? '저장 중…' : mutation.phase === 'absent' ? '같은 요청으로 다시 시도' : '변경 확인'}</button>}</>}</div></MembershipModal>;
}
function MemberDetail({ initial, api, onClose, onAccessError }: { initial: Membership; api: ReturnType<typeof membershipClient>; onClose: () => void; onAccessError: MembershipAccessError }) {
  const [item, setItem] = useState<Membership | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => { const abort = new AbortController(); setError(''); void api.member(initial.id, abort.signal).then(value => { if (!abort.signal.aborted) setItem(value); }).catch(failure => { if (!abort.signal.aborted && !onAccessError(failure)) setError(membershipFailure(failure).message); }); return () => abort.abort(); }, [api, initial.id, attempt]);
  return <MembershipModal title="멤버십 상세" busy={false} onClose={onClose}><p><strong>{initial.subscriber.displayName}</strong></p>{item ? <MembershipDetails item={item} /> : <p role="status">{error ? '가입자 정보를 확인하지 못했어요.' : '가입자 정보를 불러오는 중이에요.'}</p>}{error && <p className={styles.error} role="alert">{error}</p>}<div className={ui.dialogActions}><button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}>최신 상태 확인</button><button type="button" className={ui.button} onClick={onClose}>닫기</button></div></MembershipModal>;
}
export function ConnectedMembersPage({ session, onRequireLogin, onSessionChanged }: Props) {
  const api = useMemo(() => membershipClient(session), [session.user?.id, session.channel?.id, session.csrfToken]);
  const [plan, setPlan] = useState<MembershipPlan | null>(null), [draft, setDraft] = useState<MembershipPlanDraft>({ enabled: false, amount: 4900, benefits: '' }), [planError, setPlanError] = useState(''), [planAttempt, setPlanAttempt] = useState(0), [planLoading, setPlanLoading] = useState(true);
  const [filters, setFilters] = useState<MemberFilters>(emptyFilters), [filterDraft, setFilterDraft] = useState<MemberFilters>(emptyFilters), [filterError, setFilterError] = useState('');
  const [members, setMembers] = useState<Membership[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [listError, setListError] = useState(''), [listAttempt, setListAttempt] = useState(0);
  const [choice, setChoice] = useState<{ plan: MembershipPlan; draft: MembershipPlanDraft } | null>(null), [selected, setSelected] = useState<Membership | null>(null), [notice, setNotice] = useState(''), [denied, setDenied] = useState(false), [online, setOnline] = useState(navigator.onLine);
  const dirty = useRef(false), latestPlanVersion = useRef(-1), planGeneration = useRef(0), planAbort = useRef<AbortController | null>(null), moreBusy = useRef(false), moreAbort = useRef<AbortController | null>(null), listGeneration = useRef(0), endRef = useRef<HTMLInputElement>(null), amountRef = useRef<HTMLInputElement>(null), callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  const id = useId();
  const onAccessError = useCallback((failure: unknown) => { const e = membershipFailure(failure); if (e.status === 401 || e.status === 403 || e.code === 'SESSION_CHANGED') { setDenied(true); if (e.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged(); return true; } return false; }, []);
  useEffect(() => { const connected = () => { setOnline(true); setPlanAttempt(value => value + 1); setListAttempt(value => value + 1); }, offline = () => setOnline(false); window.addEventListener('online', connected); window.addEventListener('offline', offline); return () => { window.removeEventListener('online', connected); window.removeEventListener('offline', offline); moreAbort.current?.abort(); }; }, []);
  useEffect(() => {
    const abort = new AbortController(), visit = ++planGeneration.current; planAbort.current = abort; setPlanLoading(true); setPlanError('');
    const current = () => !abort.signal.aborted && planGeneration.current === visit;
    void api.plan(abort.signal).then(value => {
      if (!current() || value.version < latestPlanVersion.current) return;
      latestPlanVersion.current = value.version; setPlan(value);
      if (!dirty.current) setDraft({ enabled: value.enabled, amount: value.amount, benefits: value.benefits });
    }).catch(failure => { if (current() && !onAccessError(failure)) setPlanError(membershipFailure(failure).message); }).finally(() => { if (current()) setPlanLoading(false); });
    return () => { abort.abort(); ++planGeneration.current; };
  }, [api, planAttempt, onAccessError]);
  useEffect(() => {
    const abort = new AbortController(), visit = ++listGeneration.current; moreAbort.current?.abort(); moreBusy.current = false; setLoading(true); setListError('');
    const current = () => !abort.signal.aborted && listGeneration.current === visit;
    void api.members(filters, abort.signal).then(value => { if (current()) { setMembers(value.items); setCursor(value.nextCursor); } }).catch(failure => { if (current() && !onAccessError(failure)) setListError(membershipFailure(failure).message); }).finally(() => { if (current()) setLoading(false); });
    return () => { abort.abort(); ++listGeneration.current; };
  }, [api, filters, listAttempt, onAccessError]);
  async function more() {
    if (!cursor || moreBusy.current || !online) return; const abort = new AbortController(), visit = listGeneration.current; moreAbort.current = abort; moreBusy.current = true; setLoading(true);
    try { const result = await api.members({ ...filters, cursor }, abort.signal); if (!abort.signal.aborted && listGeneration.current === visit) { setMembers(values => [...values, ...result.items.filter(item => !values.some(value => value.id === item.id))]); setCursor(result.nextCursor); setListError(''); } }
    catch (failure) { if (!abort.signal.aborted && listGeneration.current === visit && !onAccessError(failure)) setListError(membershipFailure(failure).message); }
    finally { if (!abort.signal.aborted && listGeneration.current === visit) { moreBusy.current = false; setLoading(false); } }
  }
  function savedPlan(value: MembershipPlan) {
    ++planGeneration.current; planAbort.current?.abort(); setPlanLoading(false);
    if (value.version >= latestPlanVersion.current) {
      latestPlanVersion.current = value.version; setPlan(value); setDraft({ enabled: value.enabled, amount: value.amount, benefits: value.benefits }); dirty.current = false;
      setNotice('멤버십 설정을 저장했어요.');
    } else setNotice('저장 내역을 확인했어요. 이후 변경된 최신 설정과 입력한 내용을 유지했어요.');
    ++listGeneration.current; moreAbort.current?.abort(); setListAttempt(attempt => attempt + 1);
  }
  function save(event: FormEvent) { event.preventDefault(); if (!plan || planLoading || !online) return; if (!Number.isSafeInteger(draft.amount) || draft.amount < 1000 || draft.amount > 1_000_000) { setPlanError('월 이용료를 1,000~1,000,000원 사이의 정수로 입력해 주세요.'); amountRef.current?.focus(); return; } if ([...draft.benefits.normalize('NFC')].length > 500) { setPlanError('혜택은 500자 이내로 입력해 주세요.'); return; } setPlanError(''); setChoice({ plan, draft: { ...draft, benefits: draft.benefits.normalize('NFC').trim() } }); }
  function search(event: FormEvent) { event.preventDefault(); if (filterDraft.from && filterDraft.to && filterDraft.from > filterDraft.to) { setFilterError('종료일은 시작일과 같거나 이후여야 해요.'); endRef.current?.focus(); return; } setFilterError(''); setFilters({ ...filterDraft, q: filterDraft.q.trim() }); }
  if (denied || !session.user || !session.channel) return <ManagementPage title="멤버십 관리" titleId="members-title"><EmptyState title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="멤버십 관리" titleId="members-title"><div className={styles.stack}>
    {!online && <p className={styles.warning} role="status">인터넷 연결을 확인해 주세요. 연결 전에는 설정을 변경할 수 없어요.</p>}
    <section className={styles.panel} aria-labelledby={`${id}-plan`}><header className={styles.panelHeader}><h2 id={`${id}-plan`}>멤버십 설정</h2><button type="button" className={ui.button} disabled={!online || planLoading || Boolean(choice)} onClick={() => { setPlanAttempt(value => value + 1); setNotice('입력한 내용은 유지하고 서버의 최신 버전을 확인해요.'); }}>최신 설정 확인</button></header>
      {plan && !plan.paymentsReady && <p className={styles.warning}>월 자동결제 테스트 설정이 완료되지 않았어요. 설정을 저장할 수 있지만 카드 등록과 가입은 아직 진행할 수 없어요.</p>}
      <form noValidate onSubmit={save}><div className={styles.fields}><AuthCheckbox checked={draft.enabled} disabled={planLoading || !online} onChange={event => { dirty.current = true; setDraft({ ...draft, enabled: event.currentTarget.checked }); }}>멤버십 운영</AuthCheckbox><label className={styles.field}>월 이용료<input ref={amountRef} className={ui.control} type="number" min={1000} max={1_000_000} step={1} inputMode="numeric" value={draft.amount || ''} disabled={planLoading || !online} onChange={event => { dirty.current = true; setDraft({ ...draft, amount: Number(event.currentTarget.value) }); setPlanError(''); }} /></label><label className={styles.field}>멤버십 혜택<textarea className={ui.control} rows={5} maxLength={500} placeholder="혜택을 한 줄에 하나씩 입력" value={draft.benefits} disabled={planLoading || !online} onChange={event => { dirty.current = true; setDraft({ ...draft, benefits: event.currentTarget.value }); setPlanError(''); }} /></label></div><p className={styles.hint}>매월 자동결제되는 단일 플랜이에요. 기존 멤버의 월 이용료와 혜택은 가입 당시 기준을 유지해요.</p>{planError && <p className={styles.error} role="alert">{planError}</p>}<div className={styles.actions}><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={!plan || planLoading || !online}>{planLoading ? '불러오는 중…' : '설정 저장'}</button></div></form>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
    </section>
    <section aria-labelledby={`${id}-members`}><header className={styles.panelHeader}><h2 id={`${id}-members`}>멤버십 가입자</h2><button type="button" className={ui.button} disabled={loading || !online} onClick={() => setListAttempt(value => value + 1)}>목록 새로고침</button></header><form className={styles.filters} role="search" aria-label="가입자 검색" noValidate onSubmit={search} onReset={() => { setFilterDraft(emptyFilters); setFilters(emptyFilters); setFilterError(''); }}><input className={ui.control} type="search" aria-label="닉네임 검색" placeholder="닉네임 검색" maxLength={100} value={filterDraft.q} onChange={event => setFilterDraft({ ...filterDraft, q: event.currentTarget.value })} /><label className={styles.dateField}>시작일<input className={ui.control} type="date" value={filterDraft.from} onChange={event => setFilterDraft({ ...filterDraft, from: event.currentTarget.value })} /></label><label className={styles.dateField}>종료일<input ref={endRef} className={ui.control} type="date" value={filterDraft.to} aria-invalid={Boolean(filterError)} aria-describedby={filterError ? `${id}-range` : undefined} onChange={event => setFilterDraft({ ...filterDraft, to: event.currentTarget.value })} /></label><div className={styles.filterActions}><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={loading || !online}>검색</button><button type="reset" className={ui.button}>초기화</button></div></form><div className={styles.choices}><label className={ui.filterField}>가입 상태<select className={ui.control} value={filterDraft.status} onChange={event => { const status = event.currentTarget.value as MemberFilters['status']; setFilterDraft({ ...filterDraft, status }); setFilters(value => ({ ...value, status })); }}><option value="all">전체 상태</option><option value="active">이용 중</option><option value="ended">이용 종료</option></select></label></div>{filterError && <p id={`${id}-range`} className={styles.error} role="alert">{filterError}</p>}{listError && <p className={styles.error} role="alert">{listError}</p>}
      {members.length ? <div className={ui.tableFrame}><table className={ui.table} aria-label="멤버십 가입자 목록"><thead><tr><th>가입일</th><th>닉네임</th><th>가입 상태</th><th>기간</th><th>관리</th></tr></thead><tbody>{members.map(item => <tr key={item.id}><td data-label="가입일">{membershipDate(item.createdAtMs)}</td><th scope="row" data-label="닉네임">{item.subscriber.displayName}</th><td data-label="가입 상태"><MembershipStatus item={item} /></td><td data-label="기간">{membershipDate(item.periodEndsAtMs)}</td><td><button type="button" className={ui.button} aria-label={`${item.subscriber.displayName} 멤버십 상세`} aria-haspopup="dialog" onClick={() => setSelected(item)}>상세</button></td></tr>)}</tbody></table></div> : loading ? <p role="status">가입자를 불러오는 중이에요.</p> : <EmptyState icon={<UsersRound size={24} />} title={filters.q || filters.from || filters.to || filters.status !== 'all' ? '조건에 맞는 가입자가 없어요' : '가입한 멤버가 없어요'} />}
      <p className={styles.count} role="status">{members.length}명{cursor ? ' · 다음 내역 있음' : ''}</p>{cursor && <div className={styles.actions}><button type="button" className={ui.button} disabled={loading || !online} onClick={() => void more()}>더 보기</button></div>}
    </section>
    {choice && <PlanConfirmation plan={choice.plan} draft={choice.draft} api={api} online={online} onClose={() => setChoice(null)} onAccessError={onAccessError} onSaved={savedPlan} />}
    {selected && <MemberDetail initial={selected} api={api} onClose={() => setSelected(null)} onAccessError={onAccessError} />}
  </div></ManagementPage>;
}
