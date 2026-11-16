import { RefreshCw, Target, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { missionsApi } from './missions-client';
import type { MissionStatus, MissionUpdateInput, ProductMission } from './missions-client';
import { formatMissionDate, missionStatusLabel, missionTone } from './mission-format';
import base from './MissionsPage.module.css';
import styles from './ConnectedMissionsPage.module.css';

const tabs = [{ id: 'received', status: 'received' }, { id: 'running', status: 'running' }, { id: 'completed', status: 'completed' }, { id: 'rejected', status: 'rejected' }, { id: 'cancelled', status: 'canceled' }, { id: 'expired', status: 'expired' }, { id: 'failed', status: 'failed' }] as const;
const transitions: Partial<Record<MissionStatus, MissionUpdateInput['status'][]>> = { received: ['running', 'rejected', 'canceled'], running: ['completed', 'failed', 'canceled'] };
const actorLabel = { viewer: '제안자', owner: '방송자', system: '자동 처리' };
const errorText = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
type AccessError = (failure: unknown) => boolean;
function Author({ item }: { item: ProductMission }) {
  return <Link className={styles.author} to={`/channel/id/${encodeURIComponent(item.author.channelId)}`} target="_blank" rel="noopener noreferrer"><span className={styles.avatar} aria-hidden="true">{[...item.author.displayName][0]}</span><span><strong>{item.author.displayName}</strong><small>@{item.author.handle}</small></span></Link>;
}

function MissionDialog({ missionId, session, onClose, onSaved, onAccessError }: { missionId: string; session: AccountSession; onClose: () => void; onSaved: (item: ProductMission) => void; onAccessError: AccessError }) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), reasonInput = useRef<HTMLTextAreaElement>(null), opener = useRef(document.activeElement);
  const active = useRef(true), abort = useRef<AbortController | null>(null), fetching = useRef(false), writing = useRef(false), access = useRef(onAccessError); access.current = onAccessError;
  const [item, setItem] = useState<ProductMission | null>(null), [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading'), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<MissionUpdateInput['status']>('running'), [reason, setReason] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState(false), [conflict, setConflict] = useState(false), [confirming, setConfirming] = useState(false);
  const available = item ? transitions[item.status] ?? [] : [];
  async function load() {
    if (fetching.current || writing.current) return;
    const request = new AbortController(); abort.current = request; fetching.current = true; setLoading(true); setLoadError('');
    try {
      const result = await missionsApi.mission(missionId, request.signal, session.user!.id);
      if (request.signal.aborted) return;
      setItem(result.item); setStatus(transitions[result.item.status]?.[0] ?? 'running'); setReason(''); setPhase('ready'); setError(''); setConflict(false); setConfirming(false); setInvalid(false);
    } catch (failure) { if (!request.signal.aborted && !access.current(failure)) { setLoadError(errorText(failure, '미션을 불러오지 못했어요.')); setPhase(previous => previous === 'ready' ? previous : 'error'); } }
    finally { if (abort.current === request) { fetching.current = false; if (!request.signal.aborted) setLoading(false); } }
  }
  useEffect(() => {
    active.current = true; const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true }); void load();
    return () => { active.current = false; abort.current?.abort(); fetching.current = false; element?.close(); if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true }); else document.getElementById('missions-title')?.focus({ preventScroll: true }); };
  }, [missionId, session.user!.id]);
  function dismiss() { if (!writing.current && !fetching.current) onClose(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!item || writing.current || fetching.current || conflict || !available.includes(status)) return;
    const text = reason.trim().normalize('NFC');
    if ((status !== 'running' && !text) || [...text].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) { setInvalid(true); setError(status !== 'running' && !text ? '상태 변경 사유를 입력해 주세요.' : '사유를 500자 이내로 입력해 주세요.'); reasonInput.current?.focus(); return; }
    writing.current = true; setPending(true); setError(''); setLoadError(''); setInvalid(false);
    try { const result = await missionsApi.updateMission(item.id, { version: item.version, status, reason: text }, session.csrfToken, session.user!.id); if (active.current) onSaved(result.item); }
    catch (failure) {
      if (!active.current || access.current(failure)) return;
      setError(errorText(failure, '미션 상태를 변경하지 못했어요. 입력한 내용은 유지돼요.'));
      if (failure instanceof AccountError && ['MISSION_CONFLICT', 'MISSION_EXPIRED', 'MISSION_ALREADY_CLOSED', 'MISSION_INVALID_TRANSITION'].includes(failure.code)) setConflict(true);
    } finally { writing.current = false; if (active.current) setPending(false); }
  }
  return <dialog ref={dialog} data-mission-id={missionId} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={`${id}-title`} aria-busy={pending || loading || phase === 'loading'} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}><h2 ref={heading} id={`${id}-title`} tabIndex={-1}>미션 상세</h2><button type="button" className="icon-button" aria-label="미션 상세 닫기" disabled={pending || loading} onClick={dismiss}><X size={20} aria-hidden="true" /></button></header>
    {phase === 'loading' ? <p className={styles.loading} role="status">미션을 불러오는 중이에요.</p> : phase === 'error' ? <><p className={styles.error} role="alert">{loadError}</p><button type="button" className={ui.button} disabled={loading} onClick={() => void load()}>{loading ? '불러오는 중…' : '미션 다시 시도'}</button></> : item && <>
      <h3 className={styles.missionTitle}>{item.title}</h3>{item.description && <p className={styles.description}>{item.description}</p>}<Author item={item} />
      <dl className={styles.facts}><div><dt>유형</dt><dd>무료 미션</dd></div><div><dt>상태</dt><dd><StatusBadge tone={missionTone[item.status]}>{missionStatusLabel[item.status]}</StatusBadge></dd></div><div><dt>접수일</dt><dd><time dateTime={new Date(item.createdAtMs).toISOString()}>{formatMissionDate(item.createdAtMs)}</time></dd></div><div><dt>기한</dt><dd><time dateTime={new Date(item.deadlineAtMs).toISOString()}>{formatMissionDate(item.deadlineAtMs)}</time><p className={styles.hint}>접수부터 {item.durationMinutes}분 · 수락해도 기한이 늘어나지 않아요.</p></dd></div></dl>
      <section className={styles.history} aria-label="미션 상태 변경 이력"><h3>변경 이력</h3><ol>{item.history.map(entry => <li key={entry.id}><div><StatusBadge tone={missionTone[entry.status]}>{missionStatusLabel[entry.status]}</StatusBadge><small>{actorLabel[entry.actor]}</small><time dateTime={new Date(entry.createdAtMs).toISOString()}>{formatMissionDate(entry.createdAtMs)}</time></div>{entry.reason && <p>{entry.reason}</p>}</li>)}</ol></section>
      {available.length ? <form noValidate onSubmit={submit}>
        <fieldset className={styles.editor} disabled={pending || loading}>
          <label>변경할 상태<select className={ui.control} name="mission-status" value={status} onChange={event => { setStatus(event.target.value as MissionUpdateInput['status']); setInvalid(false); if (!conflict) setError(''); }}>{available.map(value => <option key={value} value={value}>{missionStatusLabel[value]}</option>)}</select></label>
          <label><span className={styles.fieldHeading}><span>사유{status === 'running' ? ' (선택)' : ' (필수)'}</span><small>{[...reason].length} / 500</small></span><textarea ref={reasonInput} className={ui.control} name="mission-reason" rows={4} maxLength={1000} value={reason} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : `${id}-help`} onChange={event => { setReason(event.target.value); setInvalid(false); if (!conflict) setError(''); }} /><small className={styles.hint} id={`${id}-help`}>제안한 시청자에게 표시돼요. 최종 상태는 다시 바꿀 수 없어요.</small></label>
        </fieldset>
        {loadError && <p className={styles.error} role="alert">{loadError} 작성한 내용은 유지돼요.</p>}{error && !conflict && <p className={styles.error} id={`${id}-error`} role="alert">{error}</p>}
        {conflict && <div className={styles.conflict} role="alert"><p>{error} 입력한 사유와 상태 선택은 남아 있어요.</p>{confirming ? <><p>입력을 버리고 서버의 최신 상태를 불러올까요?</p><div className={ui.dialogActions}><button type="button" className={ui.button} disabled={loading} onClick={() => setConfirming(false)}>입력 유지</button><button type="button" className={`${ui.button} ${ui.primary}`} disabled={loading} onClick={() => void load()}>{loading ? '불러오는 중…' : '불러오기'}</button></div></> : <button type="button" className={ui.button} onClick={() => setConfirming(true)}><RefreshCw size={16} aria-hidden="true" />최신 상태 불러오기</button>}</div>}
        <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending || loading} onClick={dismiss}>닫기</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={pending || loading || conflict}>{pending ? '변경 중…' : '상태 변경'}</button></div>
      </form> : <><p className={styles.hint}>처리가 끝난 미션이에요. 변경 이력을 확인할 수 있어요.</p><div className={ui.dialogActions}><button type="button" className={ui.button} onClick={dismiss}>닫기</button></div></>}
    </>}
  </dialog>;
}

type State = { key: string; phase: 'loading' | 'ready' | 'error'; items: ProductMission[]; nextCursor: string | null; error: string };
const initial = (key: string): State => ({ key, phase: 'loading', items: [], nextCursor: null, error: '' });
export function ConnectedMissionsPage({ session, onRequireLogin, onSessionChanged }: { session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void }) {
  const [params, setParams] = useSearchParams(), owner = session.user!.id, selectedTab = tabs.find(value => value.id === params.get('tab')) ?? tabs[0];
  const q = (params.get('q') ?? '').trim().slice(0, 120), from = params.get('from') ?? '', to = params.get('to') ?? '', status = selectedTab.status, key = JSON.stringify([q, from, to, status]);
  const [state, setState] = useState<State>(() => initial(key)), [attempt, setAttempt] = useState(0), [refreshing, setRefreshing] = useState(false), [more, setMore] = useState(false), [moreError, setMoreError] = useState(''), [hasUpdates, setHasUpdates] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [scopeLost, setScopeLost] = useState(false), [notice, setNotice] = useState(''), [fieldError, setFieldError] = useState('');
  const active = useRef(true), generation = useRef(0), fetching = useRef(false), morePending = useRef(false), moreAbort = useRef<AbortController | null>(null), paged = useRef(false), passiveNext = useRef(false), stateRef = useRef(state), modalOpen = useRef(false);
  const endInput = useRef<HTMLInputElement>(null), feedback = useRef<HTMLParagraphElement>(null), tabLink = useRef<HTMLAnchorElement>(null), callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  stateRef.current = state; modalOpen.current = selected !== null; const data = state.key === key ? state : initial(key);
  useEffect(() => { active.current = true; return () => { active.current = false; moreAbort.current?.abort(); }; }, []);
  useEffect(() => { if (notice) feedback.current?.focus({ preventScroll: true }); }, [notice]);
  useEffect(() => { tabLink.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [status]);
  function accessError(failure: unknown) {
    if (!(failure instanceof AccountError) || !active.current) return false;
    if (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') { ++generation.current; moreAbort.current?.abort(); setScopeLost(true); setSelected(null); setState(initial(key)); setNotice(''); if (failure.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged(); return true; }
    return false;
  }
  function refreshList() { passiveNext.current = false; setAttempt(value => value + 1); }
  useEffect(() => {
    const request = new AbortController(), revision = ++generation.current, passive = passiveNext.current && stateRef.current.key === key && stateRef.current.phase === 'ready';
    passiveNext.current = false; moreAbort.current?.abort(); morePending.current = false; setMore(false); setMoreError(''); fetching.current = true; setRefreshing(true);
    if (!passive) { paged.current = false; setHasUpdates(false); } if (stateRef.current.key !== key) setState(initial(key));
    if (scopeLost) { fetching.current = false; return () => request.abort(); }
    missionsApi.missions({ q, from, to, status, limit: 25 }, request.signal, owner).then(result => {
      if (request.signal.aborted || generation.current !== revision) return;
      if (passive) { if (stateRef.current.key === key && JSON.stringify(stateRef.current.items) !== JSON.stringify(result.items)) setHasUpdates(true); setState(previous => previous.key === key ? { ...previous, error: '' } : previous); }
      else setState({ key, phase: 'ready', items: result.items, nextCursor: result.nextCursor, error: '' });
    }).catch(failure => { if (request.signal.aborted || generation.current !== revision || accessError(failure)) return; setState(previous => ({ ...(previous.key === key && previous.phase === 'ready' ? previous : initial(key)), phase: previous.key === key && previous.phase === 'ready' ? 'ready' : 'error', error: errorText(failure, '미션 목록을 불러오지 못했어요.') })); }).finally(() => { if (!request.signal.aborted && generation.current === revision) { fetching.current = false; setRefreshing(false); } });
    return () => request.abort();
  }, [key, attempt, owner, scopeLost]);
  useEffect(() => {
    function wake() { if (document.visibilityState === 'visible' && navigator.onLine && !fetching.current && !morePending.current && !paged.current && !modalOpen.current && !scopeLost) { passiveNext.current = true; setAttempt(value => value + 1); } }
    const timer = window.setInterval(wake, 10000); window.addEventListener('focus', wake); window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [scopeLost]);
  async function loadMore() {
    if (!data.nextCursor || fetching.current || morePending.current || scopeLost) return;
    const request = new AbortController(), revision = generation.current, cursor = data.nextCursor; moreAbort.current = request; morePending.current = true; setMore(true); setMoreError('');
    try {
      const result = await missionsApi.missions({ q, from, to, status, limit: 25, cursor }, request.signal, owner);
      if (request.signal.aborted || !active.current || generation.current !== revision) return; if (result.nextCursor === cursor) throw Error('다음 미션 목록을 확인하지 못했어요.');
      paged.current = true; setState(previous => { if (previous.key !== key) return previous; const ids = new Set(previous.items.map(item => item.id)); return { ...previous, items: [...previous.items, ...result.items.filter(item => !ids.has(item.id))], nextCursor: result.nextCursor }; });
    } catch (failure) { if (!request.signal.aborted && active.current && generation.current === revision && !accessError(failure)) setMoreError(errorText(failure, '다음 미션 목록을 불러오지 못했어요.')); }
    finally { if (active.current && generation.current === revision) { morePending.current = false; setMore(false); } }
  }
  function filters(values: Record<string, string>) { const next = new URLSearchParams(params); for (const [name, value] of Object.entries(values)) if (value) next.set(name, value); else next.delete(name); setParams(next, { replace: true }); setNotice(''); }
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget), start = String(form.get('mission-from') ?? ''), end = String(form.get('mission-to') ?? ''); if (start && end && start > end) { setFieldError('종료일은 시작일과 같거나 이후여야 해요.'); endInput.current?.focus(); return; } setFieldError(''); filters({ q: String(form.get('mission-query') ?? '').trim(), from: start, to: end }); }
  function saved(item: ProductMission) { setSelected(null); setNotice(`‘${item.title}’ 미션을 ${missionStatusLabel[item.status]} 상태로 변경했어요.`); const next = new URLSearchParams(params); next.set('tab', tabs.find(value => value.status === item.status)!.id); setParams(next, { replace: true }); refreshList(); }
  if (scopeLost) return <ManagementPage title="미션 관리" titleId="missions-title"><EmptyState icon={<Target size={24} />} title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="미션 관리" titleId="missions-title">
    <nav className={ui.tabs} aria-label="미션 상태">{tabs.map(value => { const next = new URLSearchParams(params); next.set('tab', value.id); return <Link ref={value.status === status ? tabLink : undefined} key={value.id} to={{ search: next.toString() }} aria-current={value.status === status ? 'page' : undefined} onClick={() => { setNotice(''); setFieldError(''); }}>{missionStatusLabel[value.status]}</Link>; })}</nav>
    <form key={JSON.stringify([q, from, to])} className={base.filters} role="search" aria-label="미션 검색" noValidate onSubmit={search} onReset={() => { setFieldError(''); filters({ q: '', from: '', to: '' }); }}><input className={ui.control} type="search" name="mission-query" defaultValue={q} maxLength={120} placeholder="미션 또는 제안자 검색" aria-label="미션 또는 제안자 검색" /><label className={base.dateField}>시작일<input className={ui.control} type="date" name="mission-from" defaultValue={from} /></label><label className={base.dateField}>종료일<input ref={endInput} className={ui.control} type="date" name="mission-to" defaultValue={to} aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? 'mission-range-error' : undefined} /></label><div className={base.filterActions}><button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button><button type="reset" className={ui.button}>초기화</button></div></form>
    {fieldError && <p className={styles.error} id="mission-range-error" role="alert">{fieldError}</p>}<div className={styles.toolbar}><button type="button" className={`${ui.button} ${hasUpdates ? ui.primary : ''}`} aria-label={hasUpdates ? '새 미션과 변경 내용 확인' : '미션 목록 새로고침'} disabled={refreshing || more} onClick={refreshList}><RefreshCw size={16} aria-hidden="true" />{hasUpdates ? '변경 확인' : '새로고침'}</button></div>
    {notice && <p ref={feedback} tabIndex={-1} className={styles.success} role="status">{notice}</p>}{hasUpdates && <p className={styles.srOnly} role="status">새 미션이나 변경된 상태가 있어요. 변경 확인 버튼으로 불러올 수 있어요.</p>}
    {data.error && <div className={styles.errorArea}><p className={styles.error} role="alert">{data.error}</p><button type="button" className={ui.button} disabled={refreshing} onClick={refreshList}>목록 다시 시도</button></div>}
    {data.phase === 'loading' ? <p className={styles.loading} role="status">미션 목록을 불러오는 중이에요.</p> : data.phase === 'ready' && <>{refreshing && <p className={styles.srOnly} role="status">미션 목록을 확인하고 있어요.</p>}{data.items.length ? <div className={ui.tableFrame}><table className={ui.table} role="table" aria-label="미션 목록"><thead role="rowgroup"><tr role="row">{['미션', '제안자', '기한', '상태', '관리'].map(label => <th role="columnheader" scope="col" key={label}>{label}</th>)}</tr></thead><tbody role="rowgroup">{data.items.map(item => <tr role="row" key={item.id} data-mission-id={item.id}><th role="rowheader" scope="row" data-primary="true" className={styles.title}><strong>{item.title}</strong><small>접수 {formatMissionDate(item.createdAtMs)}</small></th><td role="cell" data-label="제안자"><Author item={item} /></td><td role="cell" data-label="기한"><time dateTime={new Date(item.deadlineAtMs).toISOString()}>{formatMissionDate(item.deadlineAtMs)}</time></td><td role="cell" data-label="상태"><StatusBadge tone={missionTone[item.status]}>{missionStatusLabel[item.status]}</StatusBadge></td><td role="cell"><button type="button" className={ui.button} aria-label={`${item.title} 미션 상세`} onClick={() => { setNotice(''); setSelected(item.id); }}>상세</button></td></tr>)}</tbody></table></div> : <EmptyState icon={<Target size={24} />} title={q || from || to ? '조건에 맞는 미션이 없어요' : `${missionStatusLabel[status]} 상태의 미션이 없어요`} action={q || from || to ? <button type="button" className={ui.button} onClick={() => filters({ q: '', from: '', to: '' })}>검색 초기화</button> : undefined} />}{data.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={ui.button} disabled={more || refreshing} onClick={() => void loadMore()}>{more ? '불러오는 중…' : moreError ? '더 불러오기 다시 시도' : '더 불러오기'}</button></div>}</>}
    {selected && <MissionDialog key={selected} missionId={selected} session={session} onClose={() => setSelected(null)} onSaved={saved} onAccessError={accessError} />}
  </ManagementPage>;
}
