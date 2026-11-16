import { RefreshCw, Scissors } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import type { AccountSession } from '../account/account-client';
import { ClipBadge, ClipEditor, seconds } from './ClipEditor';
import { clipsApi } from './clips-client';
import type { OwnerClip, OwnerClipPage } from './clips-client';
import styles from './ClipTools.module.css';

export function ClipManagementPanel({ sourceVodId, sourcePublished, refreshToken, session, online, disabled = false, onAccessError, onBusyChange }: {
  sourceVodId: string; sourcePublished: boolean; refreshToken: string; session: AccountSession; online: boolean; disabled?: boolean; onAccessError: (error: unknown) => boolean; onBusyChange: (busy: boolean) => void;
}) {
  const owner = session.user!.id, scope = owner + '/' + sourceVodId;
  const [filters, setFilters] = useState({ q: '', status: 'all' }), [query, setQuery] = useState(''), [selectedStatus, setSelectedStatus] = useState('all'), [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([scope, filters.q, filters.status]);
  const [state, setState] = useState<{ key: string; data: OwnerClipPage | null; error: string; loading: boolean }>({ key, data: null, error: '', loading: true });
  const [more, setMore] = useState(false), [moreError, setMoreError] = useState(''), [selected, setSelected] = useState<OwnerClip | null>(null), [childBusy, setChildBusy] = useState(false);
  const active = useRef(true), scopeRef = useRef(scope), busy = useRef(false), reading = useRef(false), generation = useRef(0), request = useRef<AbortController | null>(null), moreRequest = useRef<AbortController | null>(null), opener = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement>(null), callbacks = useRef({ onAccessError, onBusyChange });
  callbacks.current = { onAccessError, onBusyChange }; scopeRef.current = scope;
  const current = state.key === key ? state : { key, data: null, loading: true, error: '' }, data = current.data;
  useEffect(() => { active.current = true; return () => { active.current = false; callbacks.current.onBusyChange(false); request.current?.abort(); moreRequest.current?.abort(); }; }, [scope]);
  useEffect(() => {
    const controller = new AbortController(), revision = ++generation.current; request.current = controller; moreRequest.current?.abort(); setMore(false); setMoreError(''); reading.current = true;
    if (!online) { reading.current = false; setState(old => ({ key, data: old.key === key ? old.data : null, loading: false, error: '' })); return () => { controller.abort(); ++generation.current; }; }
    setState(old => ({ key, data: old.key === key ? old.data : null, loading: true, error: '' }));
    void clipsApi.ownedList({ sourceVodId, ...filters, limit: 20 }, owner, controller.signal).then(result => { if (!controller.signal.aborted && generation.current === revision) setState({ key, data: result, loading: false, error: '' }); }).catch(failure => { if (!controller.signal.aborted && generation.current === revision && !callbacks.current.onAccessError(failure)) setState(old => ({ key, data: old.key === key ? old.data : null, loading: false, error: failure instanceof Error ? failure.message : '클립 목록을 불러오지 못했어요.' })); }).finally(() => { if (generation.current === revision) reading.current = false; });
    return () => { controller.abort(); moreRequest.current?.abort(); ++generation.current; };
  }, [key, scope, owner, sourceVodId, filters, attempt, online, refreshToken]);
  function refresh() { if (online && !disabled && !busy.current && !reading.current) setAttempt(value => value + 1); }
  async function loadMore() {
    if (!online || disabled || busy.current || reading.current || !data?.nextCursor) return;
    const controller = new AbortController(), revision = generation.current, expected = scope, cursor = data.nextCursor; moreRequest.current = controller; reading.current = true; setMore(true); setMoreError('');
    try {
      const result = await clipsApi.ownedList({ sourceVodId, ...filters, cursor, limit: 20 }, owner, controller.signal);
      if (!active.current || controller.signal.aborted || generation.current !== revision || scopeRef.current !== expected) return;
      if (result.nextCursor === cursor) throw Error('다음 클립을 확인하지 못했어요. 목록을 새로고침해 주세요.');
      setState(old => { if (old.key !== key || !old.data) return old; const ids = new Set(old.data.items.map(item => item.id)); return { ...old, data: { ...result, items: [...old.data.items, ...result.items.filter(item => !ids.has(item.id))] } }; });
    } catch (failure) { if (active.current && !controller.signal.aborted && generation.current === revision && !callbacks.current.onAccessError(failure)) setMoreError(failure instanceof Error ? failure.message : '다음 클립을 불러오지 못했어요.'); }
    finally { if (generation.current === revision) { reading.current = false; setMore(false); } }
  }
  function open(item: OwnerClip) { if (busy.current || disabled) return; opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSelected(item); }
  function close() { if (busy.current || disabled) return; setSelected(null); if (opener.current?.isConnected) opener.current.focus(); else heading.current?.focus(); }
  function updated(item: OwnerClip) { setState(old => old.data ? { ...old, data: { ...old.data, items: old.data.items.map(previous => previous.id === item.id ? item : previous) } } : old); }
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!online || disabled || busy.current) return; setFilters({ q: query.trim(), status: selectedStatus }); }
  return <section className={styles.section} aria-label="다시보기 클립 관리" aria-busy={current.loading || more || childBusy}>
    <header className={styles.heading}><h3 ref={heading} tabIndex={-1}>클립 관리</h3><button className="icon-button" type="button" aria-label="관리 클립 목록 새로고침" disabled={!online || disabled || childBusy || current.loading || more} onClick={refresh}><RefreshCw size={17} aria-hidden="true" /></button></header>
    <p className={styles.hint}>이 다시보기에서 만든 클립을 관리해요. 원본 공개를 중단해도 클립 설정은 보존돼요. 클립을 따로 비공개로 바꿀 수도 있어요.</p>
    <form className={styles.form} onSubmit={search}><label>클립 제목<input className={ui.control} type="search" aria-label="관리 클립 제목 검색" maxLength={120} value={query} disabled={disabled || childBusy} onChange={event => setQuery(event.target.value)} /></label><div className={styles.actions}><select className={ui.control} aria-label="관리 클립 준비 상태" value={selectedStatus} disabled={disabled || childBusy} onChange={event => setSelectedStatus(event.target.value)}><option value="all">모든 상태</option><option value="preparing">준비 중</option><option value="ready">준비 완료</option><option value="failed">준비 실패</option></select><button type="submit" className={ui.button} disabled={!online || disabled || childBusy || current.loading}>클립 검색</button></div></form>
    {!online && <p className={styles.hint} role="status">인터넷 연결을 확인해 주세요. 마지막 목록과 입력은 유지돼요.</p>}{current.error && <div><p className={styles.hint + ' ' + styles.error} role="alert">{current.error}</p><button type="button" className={ui.button} disabled={!online || disabled || childBusy || current.loading} onClick={refresh}>관리 클립 목록 다시 시도</button></div>}
    {current.loading && !data ? <p className={styles.hint} role="status">클립을 불러오는 중이에요.</p> : data && (data.items.length ? <ul className={styles.list}>{data.items.map(item => <li key={item.id} className={styles.row} data-clip-id={item.id}><div><h4>{item.title}</h4><p><ClipBadge item={sourcePublished ? item : { ...item, sourcePublished: false, published: false }} /><span>{seconds(item.startMs)}–{seconds(item.endMs)}초</span></p></div><button className={ui.button} type="button" disabled={disabled || childBusy} onClick={() => open(item)}>클립 관리</button></li>)}</ul> : <EmptyState icon={<Scissors size={23} />} title={filters.q || filters.status !== 'all' ? '조건에 맞는 클립이 없어요' : '아직 만든 클립이 없어요'} description="공개된 내 다시보기의 시청 화면에서 클립을 만들 수 있어요." />)}
    {data?.nextCursor && <div className={styles.more}>{moreError && <p className={styles.hint + ' ' + styles.error} role="alert">{moreError}</p>}<button className={ui.button} type="button" disabled={!online || disabled || childBusy || current.loading || more} onClick={() => void loadMore()}>{more ? '불러오는 중…' : '관리 클립 더 불러오기'}</button></div>}
    {selected && <ClipEditor key={scope + '/' + selected.id} initial={selected} session={session} online={online} disabled={disabled} sourcePublished={sourcePublished} refreshToken={refreshToken} onAccessError={onAccessError} onBusyChange={value => { busy.current = value; setChildBusy(value); callbacks.current.onBusyChange(value); }} onUpdated={updated} onClose={close} />}
  </section>;
}
