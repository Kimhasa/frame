import { Flag, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError, accountApi } from '../account/account-client';
import type { AccountSession, OperatorReportDetail, OperatorReportItem, OperatorReportReason, OperatorReportStatus } from '../account/account-client';
import styles from './OperatorReportsPage.module.css';

const statuses: { value: OperatorReportStatus; label: string }[] = [
  { value: 'received', label: '접수' }, { value: 'reviewing', label: '검토 중' }, { value: 'resolved', label: '검토 완료' }, { value: 'dismissed', label: '기각' },
];
const reasons: { value: OperatorReportReason; label: string }[] = [
  { value: 'spam', label: '스팸·광고' }, { value: 'impersonation', label: '사칭' }, { value: 'harassment', label: '괴롭힘·혐오' },
  { value: 'inappropriate', label: '부적절한 채널 정보' }, { value: 'other', label: '기타' },
];
const dates = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const closed = (status: OperatorReportStatus) => status === 'resolved' || status === 'dismissed';
const statusLabel = (status: OperatorReportStatus) => statuses.find(item => item.value === status)?.label ?? status;
const reasonLabel = (reason: OperatorReportReason) => reasons.find(item => item.value === reason)?.label ?? reason;
const channelLink = (id: string) => `/channel/id/${encodeURIComponent(id)}`;
function ReportStatus({ status }: { status: OperatorReportStatus }) {
  return <StatusBadge tone={status === 'received' ? 'warning' : status === 'reviewing' ? 'info' : status === 'resolved' ? 'positive' : 'neutral'}>{statusLabel(status)}</StatusBadge>;
}

function ReportDialog({ reportId, session, onDismiss, onSaved, onAccessError }: {
  reportId: string; session: AccountSession; onDismiss: () => void; onSaved: () => void; onAccessError: (error: unknown) => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), noteInput = useRef<HTMLTextAreaElement>(null);
  const opener = useRef(document.activeElement), active = useRef(true), submitting = useRef(false), id = useId();
  const [detail, setDetail] = useState<OperatorReportDetail | null>(null), [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0), [loadError, setLoadError] = useState('');
  const [nextStatus, setNextStatus] = useState<'reviewing' | 'resolved' | 'dismissed'>('reviewing'), [note, setNote] = useState('');
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [invalidNote, setInvalidNote] = useState(false);
  const [conflict, setConflict] = useState(false), [saved, setSaved] = useState(false);
  const access = useRef(onAccessError); access.current = onAccessError;
  useEffect(() => {
    active.current = true; const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      active.current = false; element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus({ preventScroll: true });
      else document.getElementById('operator-reports-title')?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController(); setPhase('loading'); setLoadError(''); setError(''); setConflict(false); setSaved(false); setDetail(null);
    accountApi.operatorReport(reportId, abort.signal).then(value => {
      if (abort.signal.aborted) return;
      setDetail(value); setNextStatus(value.status === 'received' ? 'reviewing' : 'resolved'); setNote(value.reviewNote); setPhase('ready');
    }).catch(failure => {
      if (abort.signal.aborted || access.current(failure)) return;
      setLoadError(failure instanceof Error ? failure.message : '신고 내용을 불러오지 못했어요.'); setPhase('error');
    });
    return () => abort.abort();
  }, [reportId, attempt]);
  function dismiss() { if (!submitting.current) onDismiss(); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!detail || submitting.current || closed(detail.status) || conflict) return;
    const trimmed = note.trim();
    if ([...note].length > 1000 || (nextStatus !== 'reviewing' && !trimmed)) {
      setInvalidNote(true); setError(nextStatus !== 'reviewing' && !trimmed ? '검토 결과를 기록해 주세요.' : '검토 기록은 1,000자 이내로 입력해 주세요.'); noteInput.current?.focus(); return;
    }
    submitting.current = true; setPending(true); setError(''); setInvalidNote(false); setSaved(false);
    try {
      const value = await accountApi.reviewReport(detail.id, { status: nextStatus, reviewNote: trimmed, version: detail.version }, session.csrfToken);
      if (!active.current) return;
      setDetail(value); setNote(value.reviewNote); setNextStatus('resolved'); setSaved(true); onSaved(); heading.current?.focus({ preventScroll: true });
    } catch (failure) {
      if (!active.current || access.current(failure)) return;
      setError(failure instanceof Error ? failure.message : '검토 결과를 저장하지 못했어요.');
      if (failure instanceof AccountError && failure.status === 409) setConflict(true);
    } finally { submitting.current = false; if (active.current) setPending(false); }
  }

  return <dialog ref={dialog} data-report-id={reportId} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={`${id}-title`} aria-busy={phase === 'loading' || pending}
    onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}><h2 id={`${id}-title`} ref={heading} tabIndex={-1}>신고 상세</h2>
      <button type="button" className="icon-button" aria-label="신고 상세 닫기" disabled={pending} onClick={dismiss}><X size={20} aria-hidden="true" /></button></header>
    {phase === 'loading' ? <p role="status" className={styles.muted}>신고 내용을 불러오는 중이에요.</p> : phase === 'error' ? <>
      <p role="alert" className={styles.error}>{loadError}</p><button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}>상세 다시 시도</button>
    </> : detail && <>
      <div className={styles.detailHeading}><Link to={channelLink(detail.channel.id)} target="_blank" rel="noopener noreferrer"><strong>{detail.channel.displayName}</strong><span>@{detail.channel.handle}</span></Link><ReportStatus status={detail.status} /></div>
      <dl className={styles.facts}>
        <div><dt>접수일</dt><dd><time dateTime={new Date(detail.createdAtMs).toISOString()}>{dates.format(detail.createdAtMs)}</time></dd></div>
        <div><dt>신고자</dt><dd>{detail.reporter.displayName}</dd></div>
        <div><dt>신고 사유</dt><dd>{reasonLabel(detail.reason)}</dd></div>
        <div><dt>신고 번호</dt><dd className={styles.reference}>{detail.id}</dd></div>
      </dl>
      <section className={styles.reportContent} aria-label="접수된 신고 내용"><h3>신고 내용</h3><p>{detail.details || '추가 내용이 없어요.'}</p></section>
      {detail.reviewedBy && <div className={styles.lastReview}><span>최근 검토</span><strong>{detail.reviewedBy.displayName}</strong><time dateTime={new Date(detail.updatedAtMs).toISOString()}>{dates.format(detail.updatedAtMs)}</time></div>}
      {closed(detail.status) ? <section className={styles.closedReview} aria-label="저장된 검토 결과"><h3>검토 기록</h3><p>{detail.reviewNote}</p></section> : <form onSubmit={submit} noValidate>
        <fieldset className={styles.fields} disabled={pending}>
          <label className={styles.field}>처리 상태<select name="review-status" className={ui.control} value={nextStatus} disabled={conflict} onChange={event => { setNextStatus(event.target.value as typeof nextStatus); setError(''); setInvalidNote(false); setSaved(false); }}>
            {detail.status === 'received' && <option value="reviewing">검토 중</option>}<option value="resolved">검토 완료</option><option value="dismissed">기각</option></select></label>
          <label className={styles.field}>검토 기록{nextStatus !== 'reviewing' ? ' (필수)' : ' (선택)'}<textarea ref={noteInput} name="review-note" className={ui.control} rows={4} maxLength={2000} value={note} aria-invalid={invalidNote} aria-describedby={invalidNote ? `${id}-error` : `${id}-note-help`}
            onChange={event => { setNote(event.target.value); setError(''); setInvalidNote(false); setSaved(false); }} /></label>
          <p id={`${id}-note-help`} className={styles.counter}>{[...note].length.toLocaleString('ko-KR')} / 1,000</p>
        </fieldset>
        {error && <p id={`${id}-error`} role="alert" className={styles.error}>{error}</p>}
        {conflict && <button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />최신 내용으로 새로고침</button>}
        <div className={ui.dialogActions}><button type="button" className={ui.button} disabled={pending} onClick={dismiss}>닫기</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={pending || conflict}>{pending ? '저장 중…' : '검토 결과 저장'}</button></div>
      </form>}
      {saved && <p className={styles.success} role="status">검토 결과를 저장했어요.</p>}
      {closed(detail.status) && <div className={ui.dialogActions}><button type="button" className={ui.button} onClick={dismiss}>닫기</button></div>}
    </>}
  </dialog>;
}

type ListState = { key: string; phase: 'loading' | 'ready' | 'error'; items: OperatorReportItem[]; nextCursor: string | null; error: string };
const initial = (key: string): ListState => ({ key, phase: 'loading', items: [], nextCursor: null, error: '' });
export function OperatorReportsPage({ session, onRequireLogin, onPermissionRevoked }: {
  session: AccountSession; onRequireLogin: () => void; onPermissionRevoked: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const status = statuses.find(item => item.value === params.get('status'))?.value ?? 'all';
  const reason = reasons.find(item => item.value === params.get('reason'))?.value ?? 'all';
  const q = (params.get('q') ?? '').slice(0, 120), key = JSON.stringify([status, reason, q]);
  const [state, setState] = useState<ListState>(() => initial(key)), [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null), [blocked, setBlocked] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false), [moreError, setMoreError] = useState('');
  const active = useRef(true), generation = useRef(0), morePending = useRef(false), moreAbort = useRef<AbortController | null>(null);
  const callbacks = useRef({ onRequireLogin, onPermissionRevoked }); callbacks.current = { onRequireLogin, onPermissionRevoked };
  const allowed = Boolean(session.user?.isOperator), data = state.key === key ? state : initial(key);
  useEffect(() => { active.current = true; return () => { active.current = false; moreAbort.current?.abort(); }; }, []);
  function accessError(failure: unknown) {
    if (!active.current || !(failure instanceof AccountError)) return false;
    if (failure.status === 401 || (failure.status === 403 && ['OPERATOR_REQUIRED', 'FORBIDDEN'].includes(failure.code))) {
      ++generation.current; moreAbort.current?.abort(); setSelectedId(null); setState(initial(key)); setBlocked(true);
      if (failure.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onPermissionRevoked();
      return true;
    }
    return false;
  }
  useEffect(() => {
    const abort = new AbortController(), version = ++generation.current;
    moreAbort.current?.abort(); morePending.current = false; setLoadingMore(false); setMoreError(''); setState(initial(key));
    if (!allowed || blocked) return () => abort.abort();
    accountApi.operatorReports({ status, reason, q, limit: 25 }, abort.signal).then(result => {
      if (!abort.signal.aborted && generation.current === version) setState({ key, phase: 'ready', ...result, error: '' });
    }).catch(failure => {
      if (abort.signal.aborted || generation.current !== version || accessError(failure)) return;
      setState({ ...initial(key), phase: 'error', error: failure instanceof Error ? failure.message : '신고 목록을 불러오지 못했어요.' });
    });
    return () => abort.abort();
  }, [key, attempt, allowed, blocked, session.user?.id]);
  async function loadMore() {
    if (!data.nextCursor || morePending.current || blocked) return;
    const abort = new AbortController(), version = generation.current, cursor = data.nextCursor;
    moreAbort.current = abort; morePending.current = true; setLoadingMore(true); setMoreError('');
    try {
      const result = await accountApi.operatorReports({ status, reason, q, limit: 25, cursor }, abort.signal);
      if (abort.signal.aborted || !active.current || generation.current !== version) return;
      if (result.nextCursor === cursor) throw Error('다음 신고 목록을 확인하지 못했어요.');
      setState(previous => {
        if (previous.key !== key) return previous;
        const known = new Set(previous.items.map(item => item.id));
        return { ...previous, items: [...previous.items, ...result.items.filter(item => !known.has(item.id))], nextCursor: result.nextCursor };
      });
    } catch (failure) {
      if (abort.signal.aborted || !active.current || generation.current !== version || accessError(failure)) return;
      setMoreError(failure instanceof Error ? failure.message : '다음 신고 목록을 불러오지 못했어요.');
    } finally { if (active.current && generation.current === version) { morePending.current = false; setLoadingMore(false); } }
  }
  function filters(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [field, value] of Object.entries(values)) if (value && value !== 'all') next.set(field, value); else next.delete(field);
    setParams(next, { replace: true });
  }
  if (!allowed || blocked) return <ManagementPage title="신고 관리"><EmptyState icon={<ShieldCheck size={24} />} title="운영자 권한이 필요해요" /></ManagementPage>;
  return <ManagementPage title="신고 관리" titleId="operator-reports-title" actions={<button type="button" className={ui.button} disabled={data.phase === 'loading'} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />새로고침</button>}>
    <div className={styles.toolbar}>
      <form className={ui.search} role="search" aria-label="신고 검색" onSubmit={event => { event.preventDefault(); const value = new FormData(event.currentTarget).get('report-query'); filters({ q: typeof value === 'string' ? value.trim().slice(0, 120) : '' }); }}>
        <Search size={18} aria-hidden="true" /><input name="report-query" aria-label="신고 검색" key={q} defaultValue={q} placeholder="채널 이름, 핸들, 신고 내용 검색" maxLength={120} /><button type="submit" className={styles.searchButton}>검색</button>
      </form>
      <label className={ui.filterField}>상태<select className={ui.control} name="report-status-filter" value={status} onChange={event => filters({ status: event.target.value })}><option value="all">전체 상태</option>{statuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className={ui.filterField}>사유<select className={ui.control} name="report-reason-filter" value={reason} onChange={event => filters({ reason: event.target.value })}><option value="all">전체 사유</option>{reasons.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    </div>
    {data.phase === 'loading' ? <p role="status" className={styles.muted}>신고 목록을 불러오는 중이에요.</p> : data.phase === 'error' ? <>
      <p role="alert" className={styles.error}>{data.error}</p><EmptyState title="신고 목록을 불러오지 못했어요" action={<button type="button" className={ui.button} onClick={() => setAttempt(value => value + 1)}>목록 다시 시도</button>} />
    </> : data.items.length === 0 ? <EmptyState icon={<Flag size={23} />} title={q || status !== 'all' || reason !== 'all' ? '조건에 맞는 신고가 없어요' : '접수된 채널 신고가 없어요'}
      action={(q || status !== 'all' || reason !== 'all') && <button type="button" className={ui.button} onClick={() => filters({ q: '', status: '', reason: '' })}>필터 초기화</button>} /> : <>
      <div className={styles.listHeading}><p>채널 신고</p><span role="status">{data.items.length.toLocaleString('ko-KR')}건{data.nextCursor ? ' 표시' : ''}</span></div>
      <div className={ui.tableFrame}><table className={`${ui.table} ${styles.table}`}><caption className={styles.srOnly}>접수된 채널 신고 목록</caption><thead><tr><th scope="col">접수일</th><th scope="col">대상 채널</th><th scope="col">신고 사유</th><th scope="col">신고자</th><th scope="col">상태</th><th scope="col"><span className={styles.srOnly}>상세</span></th></tr></thead><tbody>
        {data.items.map(item => <tr key={item.id} data-report-id={item.id}>
          <td data-label="접수일"><time dateTime={new Date(item.createdAtMs).toISOString()}>{dates.format(item.createdAtMs)}</time></td>
          <th scope="row" data-primary="true"><Link to={channelLink(item.channel.id)} target="_blank" rel="noopener noreferrer" className={styles.channel}><strong>{item.channel.displayName}</strong><span>@{item.channel.handle}</span></Link></th>
          <td data-label="신고 사유"><span>{reasonLabel(item.reason)}</span></td><td data-label="신고자">{item.reporter.displayName}</td><td data-label="상태"><ReportStatus status={item.status} /></td>
          <td><button type="button" className={ui.button} aria-label={`신고 ${item.id} 상세 보기`} onClick={() => setSelectedId(item.id)}>상세 보기</button></td>
        </tr>)}
      </tbody></table></div>
      {(data.nextCursor || moreError) && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={ui.button} disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '불러오는 중…' : moreError ? '다음 목록 다시 시도' : '더 보기'}</button></div>}
    </>}
    {selectedId && <ReportDialog key={selectedId} reportId={selectedId} session={session} onDismiss={() => setSelectedId(null)} onSaved={() => setAttempt(value => value + 1)} onAccessError={accessError} />}
  </ManagementPage>;
}
