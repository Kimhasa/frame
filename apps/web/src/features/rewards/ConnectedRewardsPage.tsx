import { Gift, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { RewardEditor, RedemptionEditor } from './ConnectedRewardDialogs';
import { rewardsApi } from './rewards-client';
import type { ProductReward, ProductRedemption, RewardFilters, RedemptionFilters } from './rewards-client';
import { formatPoints, formatRewardDate, redemptionStatusLabel, redemptionTone } from './reward-format';
import base from './RewardsPage.module.css';
import styles from './ConnectedRewardsPage.module.css';

type State = { key: string; phase: 'loading' | 'ready' | 'error'; rewards: ProductReward[]; redemptions: ProductRedemption[]; nextCursor: string | null; error: string };
type Page = Pick<State, 'rewards' | 'redemptions' | 'nextCursor'>;
const initial = (key: string): State => ({ key, phase: 'loading', rewards: [], redemptions: [], nextCursor: null, error: '' });
const statuses = ['pending', 'processing', 'completed', 'rejected', 'canceled'] as const;
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

export function ConnectedRewardsPage({ session, onRequireLogin, onSessionChanged }: { session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void }) {
  const [params, setParams] = useSearchParams(), owner = session.user!.id, tab = params.get('tab') === 'requests' ? 'requests' : 'settings';
  const q = (params.get('q') ?? '').trim().slice(0, 120), from = params.get('from') ?? '', to = params.get('to') ?? '';
  const status = tab === 'requests' ? statuses.find(value => value === params.get('status')) ?? 'all' : ['enabled', 'disabled'].find(value => value === params.get('status')) ?? 'all';
  const key = JSON.stringify([tab, q, from, to, status]), [state, setState] = useState<State>(() => initial(key)), [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false), [hasUpdates, setHasUpdates] = useState(false), [more, setMore] = useState(false), [moreError, setMoreError] = useState('');
  const [editor, setEditor] = useState<{ rewardId: string | null } | null>(null), [redemption, setRedemption] = useState<string | null>(null), [scopeLost, setScopeLost] = useState(false), [notice, setNotice] = useState(''), [fieldError, setFieldError] = useState('');
  const active = useRef(true), generation = useRef(0), fetching = useRef(false), morePending = useRef(false), moreAbort = useRef<AbortController | null>(null), paged = useRef(false), passiveNext = useRef(false), stateRef = useRef(state), modalOpen = useRef(false);
  const endInput = useRef<HTMLInputElement>(null), feedback = useRef<HTMLParagraphElement>(null), callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  stateRef.current = state; modalOpen.current = Boolean(editor || redemption);
  const data = state.key === key ? state : initial(key);
  useEffect(() => { active.current = true; return () => { active.current = false; moreAbort.current?.abort(); }; }, []);
  useEffect(() => { if (notice) feedback.current?.focus({ preventScroll: true }); }, [notice]);
  function accessError(failure: unknown) {
    if (!(failure instanceof AccountError) || !active.current) return false;
    if (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') {
      ++generation.current; moreAbort.current?.abort(); setScopeLost(true); setEditor(null); setRedemption(null); setState(initial(key)); setNotice('');
      if (failure.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged();
      return true;
    }
    return false;
  }
  async function page(signal: AbortSignal, cursor?: string): Promise<Page> {
    const common = { q, from, to, limit: 25, cursor };
    if (tab === 'requests') { const result = await rewardsApi.redemptions({ ...common, status: status as RedemptionFilters['status'] }, signal, owner); return { rewards: [], redemptions: result.items, nextCursor: result.nextCursor }; }
    const result = await rewardsApi.rewards({ ...common, status: status as RewardFilters['status'] }, signal, owner); return { rewards: result.items, redemptions: [], nextCursor: result.nextCursor };
  }
  function refreshList() { passiveNext.current = false; setAttempt(value => value + 1); }
  useEffect(() => {
    const request = new AbortController(), revision = ++generation.current, passive = passiveNext.current && stateRef.current.key === key && stateRef.current.phase === 'ready';
    passiveNext.current = false; moreAbort.current?.abort(); morePending.current = false; setMore(false); setMoreError(''); fetching.current = true; setRefreshing(true);
    if (!passive) { paged.current = false; setHasUpdates(false); }
    if (stateRef.current.key !== key) setState(initial(key));
    if (scopeLost) { fetching.current = false; return () => request.abort(); }
    page(request.signal).then(result => {
      if (request.signal.aborted || generation.current !== revision) return;
      if (passive) {
        const old = stateRef.current;
        if (old.key === key && (JSON.stringify(old.rewards) !== JSON.stringify(result.rewards) || JSON.stringify(old.redemptions) !== JSON.stringify(result.redemptions))) setHasUpdates(true);
        setState(previous => previous.key === key ? { ...previous, error: '' } : previous);
      } else setState({ key, phase: 'ready', ...result, error: '' });
    }).catch(failure => {
      if (request.signal.aborted || generation.current !== revision || accessError(failure)) return;
      setState(previous => ({ ...(previous.key === key && previous.phase === 'ready' ? previous : initial(key)), phase: previous.key === key && previous.phase === 'ready' ? 'ready' : 'error', error: message(failure, '목록을 불러오지 못했어요.') }));
    }).finally(() => { if (!request.signal.aborted && generation.current === revision) { fetching.current = false; setRefreshing(false); } });
    return () => request.abort();
  }, [key, attempt, owner, scopeLost]);
  useEffect(() => {
    function wake() { if (document.visibilityState === 'visible' && navigator.onLine && !fetching.current && !morePending.current && !paged.current && !modalOpen.current && !scopeLost) { passiveNext.current = true; setAttempt(value => value + 1); } }
    const timer = window.setInterval(wake, 15000); window.addEventListener('focus', wake); window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [scopeLost]);
  async function loadMore() {
    if (!data.nextCursor || fetching.current || morePending.current || scopeLost) return;
    const request = new AbortController(), revision = generation.current, cursor = data.nextCursor; moreAbort.current = request; morePending.current = true; setMore(true); setMoreError('');
    try {
      const result = await page(request.signal, cursor);
      if (request.signal.aborted || !active.current || generation.current !== revision) return;
      if (result.nextCursor === cursor) throw Error('다음 목록을 확인하지 못했어요.');
      paged.current = true;
      setState(previous => {
        if (previous.key !== key) return previous;
        const rewards = new Set(previous.rewards.map(item => item.id)), redemptions = new Set(previous.redemptions.map(item => item.id));
        return { ...previous, rewards: [...previous.rewards, ...result.rewards.filter(item => !rewards.has(item.id))], redemptions: [...previous.redemptions, ...result.redemptions.filter(item => !redemptions.has(item.id))], nextCursor: result.nextCursor };
      });
    } catch (failure) { if (!request.signal.aborted && active.current && generation.current === revision && !accessError(failure)) setMoreError(message(failure, '다음 목록을 불러오지 못했어요.')); }
    finally { if (active.current && generation.current === revision) { morePending.current = false; setMore(false); } }
  }
  function filters(values: Record<string, string>) {
    const next = new URLSearchParams(params); for (const [name, value] of Object.entries(values)) if (value && !(name === 'status' && value === 'all')) next.set(name, value); else next.delete(name);
    setParams(next, { replace: true }); setNotice('');
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget), start = String(form.get('reward-from') ?? ''), end = String(form.get('reward-to') ?? '');
    if (start && end && start > end) { setFieldError('종료일은 시작일과 같거나 이후여야 해요.'); endInput.current?.focus(); return; }
    setFieldError(''); filters({ q: String(form.get('reward-query') ?? '').trim(), from: start, to: end });
  }
  function saved(text: string) { setEditor(null); setRedemption(null); setNotice(text); refreshList(); }
  if (scopeLost) return <ManagementPage title="포인트 및 보상" titleId="rewards-title"><EmptyState icon={<Gift size={24} />} title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="포인트 및 보상" titleId="rewards-title" actions={tab === 'settings' && <button type="button" className={`${ui.button} ${ui.primary}`} aria-haspopup="dialog" onClick={() => { setNotice(''); setEditor({ rewardId: null }); }}><Plus size={17} aria-hidden="true" />보상 추가</button>}>
    <nav className={ui.tabs} aria-label="포인트 및 보상 메뉴"><Link to="/studio/rewards" aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => { setNotice(''); setFieldError(''); }}>보상 설정</Link><Link to="/studio/rewards?tab=requests" aria-current={tab === 'requests' ? 'page' : undefined} onClick={() => { setNotice(''); setFieldError(''); }}>교환 요청</Link></nav>
    {tab === 'settings' && <div className={styles.policy}><strong>시청 60초마다 10 P</strong><span>채널별로 적립 · 보상은 최대 50개</span></div>}
    <form key={JSON.stringify([tab, q, from, to])} className={base.filters} role="search" aria-label="보상 및 교환 요청 검색" noValidate onSubmit={search} onReset={() => { setFieldError(''); filters({ q: '', from: '', to: '', status: 'all' }); }}>
      <input className={ui.control} name="reward-query" type="search" maxLength={120} defaultValue={q} placeholder={tab === 'requests' ? '보상이나 신청자 검색' : '보상 이름 검색'} aria-label={tab === 'requests' ? '보상이나 신청자 검색' : '보상 이름 검색'} />
      <label className={base.dateField}>시작일<input className={ui.control} name="reward-from" type="date" defaultValue={from} /></label><label className={base.dateField}>종료일<input ref={endInput} className={ui.control} name="reward-to" type="date" defaultValue={to} aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? 'reward-range-error' : undefined} /></label><div className={base.filterActions}><button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button><button type="reset" className={ui.button}>초기화</button></div>
    </form>
    {fieldError && <p className={styles.error} id="reward-range-error" role="alert">{fieldError}</p>}
    <div className={styles.toolbar}><label className={ui.filterField}>{tab === 'requests' ? '교환 상태' : '사용 상태'}<select className={ui.control} name="reward-status-filter" value={status} onChange={event => filters({ status: event.target.value })}><option value="all">전체 상태</option>{tab === 'requests' ? statuses.map(value => <option key={value} value={value}>{redemptionStatusLabel[value]}</option>) : <><option value="enabled">사용 중</option><option value="disabled">사용 안 함</option></>}</select></label><button type="button" className={`${ui.button} ${hasUpdates ? ui.primary : ''}`} aria-label={hasUpdates ? '새 보상과 요청 변경 확인' : '보상 목록 새로고침'} disabled={refreshing || more} onClick={refreshList}><RefreshCw size={16} aria-hidden="true" />{hasUpdates ? '변경 확인' : '새로고침'}</button></div>
    {notice && <p ref={feedback} className={styles.success} role="status" tabIndex={-1}>{notice}</p>}
    {hasUpdates && <p className={styles.srOnly} role="status">새 내용이 있어요. 변경 확인 버튼으로 불러올 수 있어요.</p>}
    {data.error && <div className={styles.errorArea}><p className={styles.error} role="alert">{data.error}</p><button type="button" className={ui.button} disabled={refreshing} onClick={refreshList}>목록 다시 시도</button></div>}
    {data.phase === 'loading' ? <p className={styles.loading} role="status">목록을 불러오는 중이에요.</p> : data.phase === 'ready' && <>
      {refreshing && <p className={styles.srOnly} role="status">목록을 확인하고 있어요.</p>}
      {tab === 'settings' ? data.rewards.length ? <div className={ui.tableFrame}><table className={ui.table} role="table" aria-label="보상 목록"><thead role="rowgroup"><tr role="row">{['보상', '포인트', '교환 제한', '상태', '관리'].map(label => <th role="columnheader" scope="col" key={label} data-align={['포인트', '관리'].includes(label) ? 'end' : undefined}>{label}</th>)}</tr></thead><tbody role="rowgroup">{data.rewards.map(item => <tr role="row" key={item.id} data-reward-id={item.id}>
        <th role="rowheader" scope="row" data-primary="true" className={styles.name}><strong>{item.name}</strong><small>{formatRewardDate(item.createdAtMs)}</small></th><td role="cell" data-label="포인트" data-align="end" className={styles.points}>{formatPoints(item.points)}</td><td role="cell" data-label="교환 제한">{item.limit === 'once_per_broadcast' ? '방송당 1회' : '무제한'}</td><td role="cell" data-label="상태"><StatusBadge tone={item.enabled ? 'positive' : 'neutral'}>{item.enabled ? '사용 중' : '사용 안 함'}</StatusBadge></td><td role="cell" data-align="end"><button type="button" className={ui.button} aria-label={`${item.name} 보상 수정`} onClick={() => { setNotice(''); setEditor({ rewardId: item.id }); }}>수정</button></td>
      </tr>)}</tbody></table></div> : <EmptyState icon={<Gift size={24} />} title={q || from || to || status !== 'all' ? '조건에 맞는 보상이 없어요' : '등록된 보상이 없어요'} /> : data.redemptions.length ? <div className={ui.tableFrame}><table className={ui.table} role="table" aria-label="보상 교환 요청 목록"><thead role="rowgroup"><tr role="row">{['보상', '신청자', '포인트', '상태', '접수일', '관리'].map(label => <th role="columnheader" scope="col" key={label} data-align={['포인트', '관리'].includes(label) ? 'end' : undefined}>{label}</th>)}</tr></thead><tbody role="rowgroup">{data.redemptions.map(item => <tr role="row" key={item.id} data-redemption-id={item.id}>
        <th role="rowheader" scope="row" data-primary="true" className={styles.name}><strong>{item.rewardName}</strong></th><td role="cell" data-label="신청자"><Link className={styles.identity} to={`/channel/id/${encodeURIComponent(item.user.channelId)}`} target="_blank" rel="noopener noreferrer">{item.user.displayName}<small>@{item.user.handle}</small></Link></td><td role="cell" data-label="포인트" data-align="end" className={styles.points}>{formatPoints(item.points)}</td><td role="cell" data-label="상태"><StatusBadge tone={redemptionTone[item.status]}>{redemptionStatusLabel[item.status]}</StatusBadge></td><td role="cell" data-label="접수일"><time dateTime={new Date(item.createdAtMs).toISOString()}>{formatRewardDate(item.createdAtMs)}</time></td><td role="cell" data-align="end"><button type="button" className={ui.button} aria-label={`${item.user.displayName} ${item.rewardName} 교환 요청`} onClick={() => { setNotice(''); setRedemption(item.id); }}>{['pending', 'processing'].includes(item.status) ? '처리' : '상세'}</button></td>
      </tr>)}</tbody></table></div> : <EmptyState icon={<Gift size={24} />} title={q || from || to || status !== 'all' ? '조건에 맞는 교환 요청이 없어요' : '등록된 교환 요청이 없어요'} />}
      {data.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={ui.button} disabled={more || refreshing} onClick={() => void loadMore()}>{more ? '불러오는 중…' : moreError ? '더 불러오기 다시 시도' : '더 불러오기'}</button></div>}
    </>}
    {editor && <RewardEditor key={editor.rewardId ?? 'new'} rewardId={editor.rewardId} session={session} onClose={() => setEditor(null)} onSaved={saved} onAccessError={accessError} />}
    {redemption && <RedemptionEditor key={redemption} redemptionId={redemption} session={session} onClose={() => setRedemption(null)} onSaved={saved} onAccessError={accessError} />}
  </ManagementPage>;
}
