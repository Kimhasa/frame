import { CalendarDays, FileX2, History, Radio, Search, Settings2, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import type { HistoryFilters } from '../account/account-client';
import styles from './HistoryPage.module.css';

export const historyKinds = [
  { id: 'all', label: '전체' }, { id: 'live', label: '라이브' }, { id: 'vod', label: '다시보기' }, { id: 'clip', label: '클립' },
] as const;
export type HistoryEntry = {
  id: string; kind: 'live' | 'vod' | 'clip'; title: string; publisher: string; channelHref: string | null;
  thumbnailUrl: string | null; duration: string; progress: number; href: string | null; watchedAt: Date; unavailableLabel?: string;
};
export type HistoryRemoval = { kind: 'one'; ids: string[] } | { kind: 'selection'; ids: string[] } | { kind: 'all' };

const timeZone = 'Asia/Seoul';
const dayFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone, month: 'long', day: 'numeric', weekday: 'long' });
const timeFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone, hour: 'numeric', minute: '2-digit' });
export function historyDateKey(date: Date) { return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
export function historyFilterValues(params: URLSearchParams): { kind: NonNullable<HistoryFilters['kind']>; q: string; period: string; from: string; to: string } {
  const period = ['week', 'month', 'custom'].includes(params.get('period') ?? '') ? params.get('period')! : '';
  return {
    kind: historyKinds.find(kind => kind.id === params.get('kind'))?.id ?? 'all', q: (params.get('q') ?? '').slice(0, 120), period,
    from: period === 'week' ? historyDateKey(new Date(Date.now() - 6 * 86400000))
      : period === 'month' ? historyDateKey(new Date(Date.now() - 29 * 86400000)) : period === 'custom' ? params.get('from') ?? '' : '',
    to: period === 'custom' ? params.get('to') ?? '' : '',
  };
}

function HistoryRow({ entry, selecting, checked, pending, onSelect, onRemove }: {
  entry: HistoryEntry; selecting: boolean; checked: boolean; pending: boolean; onSelect: () => void; onRemove: () => void;
}) {
  const unavailable = entry.unavailableLabel ?? '삭제된 영상';
  const image = <>{entry.thumbnailUrl && <img src={entry.thumbnailUrl} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.hidden = true; }} />}
    <span className={styles.duration}>{entry.duration}</span>
    {entry.progress > 0 && <span className={styles.progress}><i style={{ width: `${entry.progress}%` }} /></span>}</>;
  return <article className={styles.row} data-selecting={selecting} aria-label={entry.title}>
    {selecting && <AuthCheckbox className={styles.check} aria-label={`${entry.title} 선택`} checked={checked} disabled={pending} onChange={onSelect}>{null}</AuthCheckbox>}
    {entry.href ? <Link to={entry.href} className={styles.thumbnail} tabIndex={-1} aria-hidden="true"><Radio size={25} />{image}</Link>
      : <div className={`${styles.thumbnail} ${styles.deleted}`} aria-hidden="true"><FileX2 size={25} /><span>{unavailable}</span></div>}
    <div className={styles.copy}>
      {entry.href ? <Link to={entry.href} className={styles.entryTitle}>{entry.title}</Link> : <strong className={styles.entryTitle}>{entry.title}</strong>}
      {entry.channelHref ? <Link to={entry.channelHref} className={styles.channel}>{entry.publisher}</Link> : <span className={styles.channel}>{entry.publisher}</span>}
      <div className={styles.meta}><span>{historyKinds.find(kind => kind.id === entry.kind)?.label}</span>
        <time dateTime={entry.watchedAt.toISOString()}>{timeFormatter.format(entry.watchedAt)}</time>{!entry.href && <span>{unavailable}</span>}</div>
    </div>
    {!selecting && <button type="button" className={styles.remove} disabled={pending} aria-label={`${entry.title} 시청 기록에서 삭제`} onClick={onRemove}><X size={19} aria-hidden="true" /></button>}
  </article>;
}

export function HistoryView({ entries, signedIn, onLogin, onRemove, onUndo, phase = 'ready', error = '', onRetry,
  hasMore = false, loadingMore = false, moreError = '', onLoadMore }: {
  entries: readonly HistoryEntry[]; signedIn: boolean; onLogin: () => void; onRemove: (request: HistoryRemoval) => Promise<void>;
  onUndo?: () => void; phase?: 'loading' | 'ready' | 'error'; error?: string; onRetry?: () => void;
  hasMore?: boolean; loadingMore?: boolean; moreError?: string; onLoadMore?: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const filters = historyFilterValues(params);
  const { kind, q: query, period: range, from, to } = filters;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [pendingDelete, setPendingDelete] = useState<'all' | 'selection'>('all');
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [feedback, setFeedback] = useState('');
  const confirmation = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const removing = useRef(false);
  const active = useRef(true);
  const today = historyDateKey(new Date());
  const yesterday = historyDateKey(new Date(Date.now() - 86400000));
  const activeFilter = kind !== 'all' || Boolean(query || range);
  const selectable = entries.slice(0, 200);
  const allSelected = selectable.length > 0 && selectable.every(entry => selected.has(entry.id));
  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const day = historyDateKey(entry.watchedAt), group = groups.get(day);
    if (group) group.push(entry); else groups.set(day, [entry]);
  }
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const ids = new Set(entries.map(entry => entry.id));
    setSelected(previous => [...previous].every(id => ids.has(id)) ? previous : new Set([...previous].filter(id => ids.has(id))));
  }, [entries]);

  function updateFilters(changes: Record<string, string>) {
    if (removing.current) return;
    setSelected(new Set()); setSelecting(false); setMutationError(''); setFeedback('');
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }
  function resetFilters() { updateFilters({ kind: '', q: '', period: '', from: '', to: '' }); }
  function restoreFocus() {
    requestAnimationFrame(() => { if (opener.current?.isConnected && !opener.current.matches(':disabled')) opener.current.focus(); else heading.current?.focus(); });
  }
  function confirmDeletion(mode: 'all' | 'selection') {
    if (removing.current) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingDelete(mode); setDialogError('');
    requestAnimationFrame(() => { if (active.current && confirmation.current && !confirmation.current.open) confirmation.current.showModal(); });
  }
  async function remove(request: HistoryRemoval, inDialog = false) {
    if (removing.current) return;
    removing.current = true; setPending(true); setMutationError(''); setDialogError(''); setFeedback('');
    try {
      await onRemove(request);
      if (!active.current) return;
      setSelected(new Set()); setSelecting(false);
      setFeedback(request.kind === 'all' ? '시청 기록을 모두 삭제했어요.' : '시청 기록을 삭제했어요.');
      if (inDialog) confirmation.current?.close(); else restoreFocus();
    } catch (failure) {
      if (active.current) {
        const message = failure instanceof Error ? failure.message : '시청 기록을 삭제하지 못했어요.';
        if (inDialog) setDialogError(message); else setMutationError(message);
      }
    } finally { removing.current = false; if (active.current) setPending(false); }
  }
  function submitDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void remove(pendingDelete === 'all' ? { kind: 'all' } : { kind: 'selection', ids: [...selected] }, true);
  }

  return <section className={styles.page} aria-labelledby="history-title" aria-busy={phase === 'loading' || pending}>
    <div className={styles.heading}><h1 ref={heading} id="history-title" tabIndex={-1}>시청 기록</h1>
      {signedIn && entries.length > 0 && <div className={styles.headingActions}>
        {!selecting && <button type="button" className={styles.button} disabled={pending || phase !== 'ready'} onClick={() => { setSelecting(true); setFeedback(''); setMutationError(''); }}>선택</button>}
        <button type="button" className={styles.button} disabled={pending || phase !== 'ready'} onClick={() => confirmDeletion('all')}><Settings2 size={16} aria-hidden="true" />기록 관리</button>
      </div>}
    </div>
    {!signedIn ? <div className={styles.notice}><span className={styles.noticeIcon}><UserRound size={23} strokeWidth={1.7} aria-hidden="true" /></span>
      <h2>로그인하고 시청 기록을 확인하세요</h2><button type="button" className={styles.primary} onClick={onLogin}>로그인</button></div> : <>
      {(entries.length > 0 || activeFilter || phase !== 'ready') && <>
        <div className={styles.toolbar}>
          <form className={styles.search} role="search" aria-label="시청 기록" onSubmit={event => {
            event.preventDefault(); const text = new FormData(event.currentTarget).get('history-query'); updateFilters({ q: typeof text === 'string' ? text.trim().slice(0, 120) : '' });
          }}><Search size={19} aria-hidden="true" /><input key={query} name="history-query" type="search" aria-label="시청 기록 검색" placeholder="시청 기록 검색" disabled={pending}
            autoComplete="off" maxLength={120} defaultValue={query} /><button type="submit" disabled={pending}>검색</button></form>
          <label className={styles.period}><CalendarDays size={17} aria-hidden="true" /><select aria-label="시청 기록 기간" disabled={pending} value={range}
            onChange={event => updateFilters({ period: event.currentTarget.value, from: '', to: '' })}>
            <option value="">전체 기간</option><option value="week">최근 7일</option><option value="month">최근 30일</option><option value="custom">기간 선택</option></select></label>
        </div>
        {range === 'custom' && <div className={styles.dates}>
          <label>시작일<input type="date" value={from} max={to || today} disabled={pending} onChange={event => updateFilters({ from: event.currentTarget.value })} /></label>
          <label>종료일<input type="date" value={to} min={from || undefined} max={today} disabled={pending} onChange={event => updateFilters({ to: event.currentTarget.value })} /></label>
        </div>}
        <div className={styles.filterRow}><div className={styles.filters} aria-label="시청 기록 종류" role="group">
          {historyKinds.map(item => <button type="button" key={item.id} aria-pressed={kind === item.id} disabled={pending}
            onClick={() => updateFilters({ kind: item.id === 'all' ? '' : item.id })}>{item.label}</button>)}</div>
          <div className={styles.filterActions}><span role="status">{phase === 'ready' ? `${query ? '검색 결과 ' : ''}${entries.length}개${hasMore ? ' 표시' : ''}` : ''}</span>
            {activeFilter && <button type="button" className={styles.button} disabled={pending} onClick={resetFilters}>초기화</button>}</div>
        </div>
      </>}
      {mutationError && <div className={styles.mutationError}><p className={styles.error} role="alert">{mutationError}</p>
        {onRetry && <button type="button" className={styles.button} disabled={pending} onClick={onRetry}>목록 새로고침</button>}</div>}
      {selecting && phase === 'ready' && <div className={styles.selection}>
        <AuthCheckbox checked={allSelected} indeterminate={!allSelected && selected.size > 0} disabled={pending || !selectable.length}
          onChange={event => { setSelected(new Set(event.currentTarget.checked ? selectable.map(entry => entry.id) : [])); setMutationError(''); }}>{entries.length > 200 ? '최대 200개 선택' : '전체 선택'}</AuthCheckbox>
        <span role="status">{selected.size}개 선택</span><button type="button" className={styles.button} disabled={pending} onClick={() => { setSelected(new Set()); setSelecting(false); }}>취소</button>
        <button type="button" className={styles.danger} disabled={pending || !selected.size} onClick={() => confirmDeletion('selection')}>삭제</button>
      </div>}
      {phase === 'loading' ? <p className={styles.loading} role="status">시청 기록을 불러오는 중이에요.</p> : phase === 'error'
        ? <div className={styles.notice}><span className={styles.noticeIcon}><History size={23} aria-hidden="true" /></span><h2>시청 기록을 불러오지 못했어요</h2>
          <p className={styles.error} role="alert">{error}</p>{onRetry && <button type="button" className={styles.primary} onClick={onRetry}>다시 시도</button>}</div>
        : !entries.length ? <div className={styles.notice}><span className={styles.noticeIcon}>{activeFilter ? <Search size={23} aria-hidden="true" /> : <History size={23} aria-hidden="true" />}</span>
          <h2>{activeFilter ? '조건에 맞는 시청 기록이 없어요' : '아직 시청 기록이 없어요'}</h2>
          {activeFilter ? <button type="button" className={styles.primary} onClick={resetFilters}>필터 초기화</button> : <Link className={styles.primary} to="/live">라이브 둘러보기</Link>}</div>
        : Array.from(groups, ([date, items]) => <section className={styles.day} key={date} aria-label={date}>
          <h2><time dateTime={date}>{date === today ? '오늘' : date === yesterday ? '어제' : dayFormatter.format(items[0].watchedAt)}</time></h2>
          {items.map(entry => <HistoryRow key={entry.id} entry={entry} selecting={selecting} checked={selected.has(entry.id)} pending={pending}
            onSelect={() => {
              const next = new Set(selected);
              if (next.has(entry.id)) next.delete(entry.id);
              else { if (next.size >= 200) { setMutationError('한 번에 200개까지 선택할 수 있어요.'); return; } next.add(entry.id); }
              setSelected(next); setMutationError('');
            }} onRemove={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; void remove({ kind: 'one', ids: [entry.id] }); }} />)}
        </section>)}
      {phase === 'ready' && hasMore && <div className={styles.loadMore}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}
        <button type="button" className={styles.button} aria-busy={loadingMore} disabled={loadingMore || pending} onClick={onLoadMore}>{loadingMore ? '불러오는 중' : moreError ? '다시 시도' : '더 보기'}</button></div>}
      {feedback && <div className={styles.feedback}><span role="status">{feedback}</span>{onUndo && <button type="button" onClick={() => { onUndo(); setFeedback(''); }}>실행 취소</button>}
        <button type="button" aria-label="삭제 안내 닫기" onClick={() => setFeedback('')}><X size={17} aria-hidden="true" /></button></div>}
    </>}
    <dialog ref={confirmation} className={styles.dialog} aria-labelledby="history-confirm-title" aria-busy={pending}
      onCancel={event => { if (removing.current) event.preventDefault(); }} onClose={event => { if (!event.currentTarget.open) { setDialogError(''); restoreFocus(); } }}>
      <form onSubmit={submitDeletion}><h2 id="history-confirm-title">{pendingDelete === 'all' ? '시청 기록을 모두 삭제할까요?' : `선택한 시청 기록 ${selected.size}개를 삭제할까요?`}</h2>
        <p>계정의 시청 기록에서 삭제돼요.</p>{dialogError && <>
          <p className={styles.error} role="alert">{dialogError}</p>
          {onRetry && <button type="button" className={styles.button} disabled={pending} onClick={() => {
            confirmation.current?.close(); setSelected(new Set()); setSelecting(false); onRetry();
          }}>목록 새로고침</button>}
        </>}
        <div className={styles.dialogActions}><button type="button" className={styles.button} disabled={pending} autoFocus onClick={() => confirmation.current?.close()}>취소</button>
          <button type="submit" className={styles.danger} disabled={pending || (pendingDelete === 'selection' && !selected.size)}>{pending ? '삭제 중' : '삭제'}</button></div>
      </form>
    </dialog>
  </section>;
}
