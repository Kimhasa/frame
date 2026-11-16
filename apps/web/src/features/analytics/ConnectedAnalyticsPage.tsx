import { BarChart3, RefreshCw, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import type { StatusTone } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { analyticsApi, isAnalyticsDate } from './analytics-client';
import type { AnalyticsBroadcast, AnalyticsMetrics, AnalyticsResult } from './analytics-client';
import base from './AnalyticsPage.module.css';
import styles from './ConnectedAnalyticsPage.module.css';

const numbers = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const statusLabel = { live: '방송 중', ended: '종료', interrupted: '측정 중단' };
const statusTone: Record<AnalyticsBroadcast['status'], StatusTone> = { live: 'live', ended: 'neutral', interrupted: 'warning' };
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

function duration(ms: number) {
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${numbers.format(hours)}시간 ${minutes}분` : minutes ? `${minutes}분 ${seconds % 60}초` : `${seconds}초`;
}
function concurrent(value: number | null) { return value === null ? <span title="관측 구간이 없어요">—</span> : `${numbers.format(value)}개`; }
function minDate(today: string, days: 7 | 30) {
  const first = new Date(`${today}T00:00:00Z`); first.setUTCDate(first.getUTCDate() - days + 1); return first.toISOString().slice(0, 10);
}
function Summary({ metrics }: { metrics: AnalyticsMetrics }) {
  return <dl className={base.metrics} aria-label="방송 요약 지표">
    <div><dt>방송 횟수</dt><dd>{numbers.format(metrics.broadcastCount)}회</dd></div>
    <div><dt>방송 시간</dt><dd>{duration(metrics.broadcastDurationMs)}</dd></div>
    <div><dt>평균 동시 접속</dt><dd>{concurrent(metrics.averageConcurrent)}</dd></div>
    <div><dt>최고 동시 접속</dt><dd>{concurrent(metrics.peakConcurrent)}</dd></div>
  </dl>;
}
function ViewerChart({ daily }: { daily: AnalyticsResult['daily'] }) {
  const maximum = Math.max(1, ...daily.map(day => day.averageConcurrent ?? 0));
  return <section className={base.chart} aria-labelledby="analytics-viewers">
    <div className={styles.chartHeading}><h2 id="analytics-viewers">일별 평균 동시 접속</h2><p>— 관측 구간 없음</p></div>
    <div className={base.chartScroll} tabIndex={0} role="region" aria-label="일별 평균 동시 접속 그래프">
      <ul className={base.bars} style={{ gridTemplateColumns: `repeat(${daily.length}, minmax(34px, 1fr))` }}>
        {daily.map(day => <li key={day.date} aria-label={`${day.date} ${day.averageConcurrent === null ? '관측 구간 없음' : `평균 동시 접속 ${numbers.format(day.averageConcurrent)}개`}`}>
          <time dateTime={day.date}>{day.date.slice(5)}</time>
          <span className={`${base.track} ${styles.track}`} data-observed={day.averageConcurrent !== null} aria-hidden="true"><span style={day.averageConcurrent === null ? undefined : { height: `${day.averageConcurrent / maximum * 100}%`, minHeight: 2 }} /></span>
          <strong className={styles.dayValue} aria-hidden="true">{day.averageConcurrent === null ? '—' : numbers.format(day.averageConcurrent)}</strong>
        </li>)}
      </ul>
    </div>
  </section>;
}
function BroadcastTable({ items }: { items: AnalyticsBroadcast[] }) {
  return <div className={ui.tableFrame}><table className={`${ui.table} ${styles.table}`} role="table" aria-label="방송별 통계 목록">
    <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">방송</th><th scope="col" role="columnheader">시작일</th><th scope="col" role="columnheader">상태</th><th scope="col" role="columnheader" data-align="end">방송 시간</th><th scope="col" role="columnheader" data-align="end">동시 접속</th></tr></thead>
    <tbody role="rowgroup">{items.map(item => <tr key={item.id} role="row" data-analytics-id={item.id}>
      <th scope="row" role="rowheader" data-primary="true" className={styles.rowTitle}><strong>{item.title || '제목 없는 방송'}</strong><small>{item.status === 'interrupted' ? '중단 전까지 관측한 통계예요.' : item.status === 'live' ? '방송 중인 통계는 계속 수집돼요.' : item.endedAtMs !== null ? `종료 ${dateTime.format(item.endedAtMs)}` : '마지막 관측까지 집계했어요.'}</small></th>
      <td role="cell" data-label="시작일"><time dateTime={new Date(item.startedAtMs).toISOString()}>{dateTime.format(item.startedAtMs)}</time></td>
      <td role="cell" data-label="상태"><StatusBadge tone={statusTone[item.status]}>{statusLabel[item.status]}</StatusBadge></td>
      <td role="cell" data-label="방송 시간" data-align="end">{duration(item.broadcastDurationMs)}</td>
      <td role="cell" data-label="동시 접속" data-align="end"><span className={styles.cellStack}><span>평균 {concurrent(item.averageConcurrent)}</span><small>최고 {concurrent(item.peakConcurrent)}</small></span></td>
    </tr>)}</tbody>
  </table></div>;
}

type State = { key: string; phase: 'loading' | 'ready' | 'error'; result: AnalyticsResult | null; error: string };
const initial = (key: string): State => ({ key, phase: 'loading', result: null, error: '' });
export function ConnectedAnalyticsPage({ session, onRequireLogin, onSessionChanged }: { session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void }) {
  const [params, setParams] = useSearchParams(), owner = session.user!.id;
  const days = params.get('period') === '30' ? 30 : 7, q = (params.get('q') ?? '').trim(), from = params.get('from') ?? '', to = params.get('to') ?? '';
  const key = JSON.stringify([owner, days, q, from, to]);
  const [state, setState] = useState<State>(() => initial(key)), [attempt, setAttempt] = useState(0), [refreshing, setRefreshing] = useState(false), [loadingMore, setLoadingMore] = useState(false), [moreError, setMoreError] = useState(''), [fieldError, setFieldError] = useState('');
  const [scopeLost, setScopeLost] = useState(false), [online, setOnline] = useState(navigator.onLine);
  const active = useRef(true), generation = useRef(0), fetching = useRef(false), morePending = useRef(false), listAbort = useRef<AbortController | null>(null), moreAbort = useRef<AbortController | null>(null);
  const endInput = useRef<HTMLInputElement>(null), callbacks = useRef({ onRequireLogin, onSessionChanged }); callbacks.current = { onRequireLogin, onSessionChanged };
  const data = state.key === key ? state : initial(key), result = data.result;
  const today = date.format(result?.serverNowMs ?? Date.now()), firstDay = minDate(today, days);
  useEffect(() => {
    active.current = true;
    function changed() { setOnline(navigator.onLine); }
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { active.current = false; listAbort.current?.abort(); moreAbort.current?.abort(); window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  function accessError(failure: unknown) {
    if (!(failure instanceof AccountError) || !active.current) return false;
    if (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') {
      ++generation.current; listAbort.current?.abort(); moreAbort.current?.abort(); setScopeLost(true); setState(initial(key)); setMoreError('');
      if (failure.status === 401) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged();
      return true;
    }
    return false;
  }
  useEffect(() => {
    const request = new AbortController(), revision = ++generation.current;
    listAbort.current = request; moreAbort.current?.abort(); fetching.current = false; morePending.current = false; setLoadingMore(false); setMoreError('');
    if (scopeLost || !online) {
      setRefreshing(false);
      setState(previous => previous.key === key && previous.phase === 'ready' ? previous : { ...initial(key), phase: 'error' });
      return () => request.abort();
    }
    fetching.current = true; setRefreshing(true);
    setState(previous => previous.key === key && previous.phase === 'ready' ? { ...previous, error: '' } : initial(key));
    void analyticsApi.overview({ period: days, q, from, to, limit: 20 }, owner, request.signal).then(value => {
      if (!request.signal.aborted && generation.current === revision) setState({ key, phase: 'ready', result: value, error: '' });
    }).catch(failure => {
      if (request.signal.aborted || generation.current !== revision || accessError(failure)) return;
      setState(previous => ({ ...(previous.key === key && previous.phase === 'ready' ? previous : initial(key)), phase: previous.key === key && previous.phase === 'ready' ? 'ready' : 'error', error: message(failure, '방송 통계를 불러오지 못했어요.') }));
    }).finally(() => { if (!request.signal.aborted && generation.current === revision) { fetching.current = false; setRefreshing(false); } });
    return () => request.abort();
  }, [key, days, q, from, to, attempt, owner, online, scopeLost]);
  function refresh() { if (online && !fetching.current && !morePending.current && !scopeLost) { fetching.current = true; setRefreshing(true); setAttempt(value => value + 1); } }
  async function loadMore() {
    if (!online || !result?.nextCursor || fetching.current || morePending.current || scopeLost) return;
    const request = new AbortController(), revision = generation.current, cursor = result.nextCursor;
    moreAbort.current = request; morePending.current = true; setLoadingMore(true); setMoreError('');
    try {
      const next = await analyticsApi.overview({ period: days, q, from, to, limit: 20, cursor }, owner, request.signal);
      if (request.signal.aborted || !active.current || generation.current !== revision) return;
      if (next.nextCursor === cursor || next.fromDate !== result.fromDate || next.toDate !== result.toDate) throw Error('다음 통계 목록을 확인하지 못했어요. 새로고침해 주세요.');
      setState(previous => {
        if (previous.key !== key || !previous.result) return previous;
        const ids = new Set(previous.result.items.map(item => item.id));
        return { ...previous, result: { ...previous.result, items: [...previous.result.items, ...next.items.filter(item => !ids.has(item.id))], nextCursor: next.nextCursor } };
      });
    } catch (failure) {
      if (!request.signal.aborted && active.current && generation.current === revision && !accessError(failure)) setMoreError(message(failure, '다음 방송 통계를 불러오지 못했어요.'));
    } finally { if (active.current && generation.current === revision) { morePending.current = false; setLoadingMore(false); } }
  }
  function filters(values: Record<string, string>) {
    const next = new URLSearchParams(params); for (const [name, value] of Object.entries(values)) if (value) next.set(name, value); else next.delete(name);
    setFieldError(''); setParams(next, { replace: true });
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!online) return;
    const form = new FormData(event.currentTarget), start = String(form.get('analytics-from') ?? ''), end = String(form.get('analytics-to') ?? '');
    if ((start && (!isAnalyticsDate(start) || start < firstDay || start > today)) || (end && (!isAnalyticsDate(end) || end < firstDay || end > today))) {
      setFieldError(`조회 기간은 ${firstDay}부터 ${today}까지 선택해 주세요.`); endInput.current?.focus(); return;
    }
    if (start && end && start > end) { setFieldError('종료일은 시작일과 같거나 이후여야 해요.'); endInput.current?.focus(); return; }
    filters({ q: String(form.get('analytics-query') ?? '').trim(), from: start, to: end });
  }
  if (scopeLost) return <ManagementPage title="방송 분석" titleId="analytics-title"><EmptyState title="계정 정보를 다시 확인해 주세요" action={<button type="button" className={ui.button} onClick={onSessionChanged}>계정 다시 확인</button>} /></ManagementPage>;
  return <ManagementPage title="방송 분석" titleId="analytics-title" actions={<div className={styles.toolbar}>
    <label><span className={styles.srOnly}>통계 기간</span><select className={ui.control} aria-label="통계 기간" value={days} onChange={event => filters({ period: event.target.value === '30' ? '30' : '', from: '', to: '' })}><option value="7">최근 7일</option><option value="30">최근 30일</option></select></label>
    <button className={ui.button} type="button" aria-label="방송 통계 새로고침" disabled={!online || refreshing || loadingMore} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />새로고침</button>
  </div>}>
    <div className={base.layout}>
      <form key={key} className={styles.filters} aria-label="방송 통계 검색" role="search" noValidate onSubmit={search} onReset={() => filters({ q: '', from: '', to: '' })}>
        <label className={styles.field}>방송 제목<input className={ui.control} type="search" name="analytics-query" aria-label="방송 제목 검색" placeholder="방송 제목 검색" defaultValue={q} maxLength={120} /></label>
        <label className={styles.field}>시작일<input className={ui.control} type="date" name="analytics-from" min={firstDay} max={today} defaultValue={from} /></label>
        <label className={styles.field}>종료일<input ref={endInput} className={ui.control} type="date" name="analytics-to" min={firstDay} max={today} defaultValue={to} aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? 'analytics-range-error' : undefined} /></label>
        <div className={styles.filterActions}><button className={`${ui.button} ${ui.primary}`} type="submit" disabled={!online}>검색</button><button className={ui.button} type="reset" disabled={!online}>초기화</button></div>
      </form>
      {fieldError && <p className={`${styles.error} ${styles.errorArea}`} id="analytics-range-error" role="alert">{fieldError}</p>}
      {!online && <div className={styles.notice} role="status"><p>인터넷 연결이 끊겼어요. 입력한 검색 조건과 마지막 통계는 유지돼요.</p></div>}
      {data.error && <div className={styles.errorArea}><p className={styles.error} role="alert">{data.error}{result ? ' 마지막으로 불러온 통계를 표시하고 있어요.' : ''}</p><button className={ui.button} type="button" disabled={!online || refreshing} onClick={refresh}>통계 다시 시도</button></div>}
      {data.phase === 'loading' ? <p className={styles.loading} role="status">방송 통계를 불러오는 중이에요.</p> : result && <>
        {refreshing && <p className={styles.srOnly} role="status">방송 통계를 새로 불러오고 있어요.</p>}
        <div className={styles.meta}><p>조회 기간 <time dateTime={result.fromDate}>{result.fromDate}</time> – <time dateTime={result.toDate}>{result.toDate}</time> · 한국 시간 기준</p><p>조회 시각 <time dateTime={new Date(result.serverNowMs).toISOString()}>{dateTime.format(result.serverNowMs)}</time></p></div>
        <Summary metrics={result.summary} /><ViewerChart daily={result.daily} />
        <section aria-labelledby="analytics-broadcasts"><h2 id="analytics-broadcasts" className={styles.sectionHeading}>방송별 통계</h2>
          {result.items.length ? <BroadcastTable items={result.items} /> : <EmptyState icon={q || from || to ? <Search size={24} /> : <BarChart3 size={24} />} title={q || from || to ? '조건에 맞는 방송이 없어요' : '아직 집계된 방송이 없어요'} description={result.collectionStartedAtMs === null ? '방송이 시작되면 연결 통계를 수집해요.' : undefined} />}
          {result.nextCursor && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button className={ui.button} type="button" disabled={!online || refreshing || loadingMore} onClick={() => void loadMore()}>{loadingMore ? '불러오는 중…' : moreError ? '더 불러오기 다시 시도' : '더 불러오기'}</button></div>}
        </section>
        <aside className={styles.explanation} aria-label="통계 측정 안내"><p>서버가 관찰한 송출 시간과 활성 시청 세션을 5초 간격으로 집계해요. 실제 사람 수나 영상 재생 시간을 뜻하지 않아요.</p><p>수집 전이나 연결이 끊긴 구간은 방송 시간과 동시 접속 평균에서 제외돼요. 방송별 수치도 선택한 조회 기간 안에서 집계해요.</p><p>{result.collectionStartedAtMs === null ? '아직 수집된 방송이 없어요.' : <>수집 시작 <time dateTime={new Date(result.collectionStartedAtMs).toISOString()}>{dateTime.format(result.collectionStartedAtMs)}</time> · 이전 방송 통계는 포함하지 않아요.</>}</p></aside>
      </>}
    </div>
  </ManagementPage>;
}
