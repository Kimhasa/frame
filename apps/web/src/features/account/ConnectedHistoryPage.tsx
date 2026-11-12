import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { channelPath } from '../../preview/community-types';
import { watchPath } from '../../viewer-contract';
import { HistoryView, historyFilterValues } from '../history/HistoryView';
import type { HistoryEntry, HistoryRemoval } from '../history/HistoryView';
import { accountApi, AccountError } from './account-client';
import type { AccountSession, HistoryFilters, WatchHistoryItem } from './account-client';

type HistoryState = { key: string; phase: 'loading' | 'ready' | 'error'; items: WatchHistoryItem[]; nextCursor: string | null; error: string };
const initial = (key: string): HistoryState => ({ key, phase: 'loading', items: [], nextCursor: null, error: '' });

export function ConnectedHistoryPage({ session, onRequireLogin }: { session: AccountSession; onRequireLogin: () => void }) {
  const [params] = useSearchParams();
  const { kind, q, from, to } = historyFilterValues(params);
  const filters: HistoryFilters = { kind, q, from, to, limit: 50 };
  const key = JSON.stringify([kind, q, from, to]);
  const [state, setState] = useState<HistoryState>(() => initial(key));
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const active = useRef(true);
  const generation = useRef(0);
  const morePending = useRef(false);
  const moreAbort = useRef<AbortController | null>(null);
  const currentKey = useRef(key); currentKey.current = key;
  const login = useRef(onRequireLogin); login.current = onRequireLogin;
  const data = state.key === key ? state : initial(key);
  useEffect(() => { active.current = true; return () => { active.current = false; moreAbort.current?.abort(); }; }, []);
  function requireLogin(failure: unknown) {
    if (active.current && failure instanceof AccountError && failure.status === 401 && ['UNAUTHENTICATED', 'SESSION_REQUIRED'].includes(failure.code)) login.current();
  }
  useEffect(() => {
    const abort = new AbortController(), version = ++generation.current;
    moreAbort.current?.abort(); morePending.current = false;
    setLoadingMore(false); setMoreError(''); setState(initial(key));
    accountApi.historyList(filters, abort.signal).then(result => {
      if (!abort.signal.aborted && generation.current === version) setState({ key, phase: 'ready', ...result, error: '' });
    }).catch(failure => {
      if (abort.signal.aborted || generation.current !== version) return;
      requireLogin(failure);
      setState({ ...initial(key), phase: 'error', error: failure instanceof Error ? failure.message : '시청 기록을 불러오지 못했어요.' });
    });
    return () => abort.abort();
  }, [key, attempt, session.user?.id]);

  async function loadMore() {
    if (morePending.current || !data.nextCursor || data.phase !== 'ready') return;
    morePending.current = true; setLoadingMore(true); setMoreError('');
    const abort = new AbortController(), version = generation.current, cursor = data.nextCursor;
    moreAbort.current = abort;
    try {
      const result = await accountApi.historyList({ ...filters, cursor }, abort.signal);
      if (abort.signal.aborted || !active.current || version !== generation.current) return;
      if (result.nextCursor === cursor) throw new AccountError('시청 기록의 다음 목록을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
      setState(previous => {
        if (previous.key !== key) return previous;
        const known = new Set(previous.items.map(item => item.id));
        return { ...previous, items: [...previous.items, ...result.items.filter(item => !known.has(item.id))], nextCursor: result.nextCursor };
      });
    } catch (failure) {
      if (abort.signal.aborted || !active.current || version !== generation.current) return;
      requireLogin(failure); setMoreError(failure instanceof Error ? failure.message : '다음 시청 기록을 불러오지 못했어요.');
    } finally {
      if (active.current && version === generation.current) { morePending.current = false; setLoadingMore(false); }
    }
  }
  async function remove(request: HistoryRemoval) {
    moreAbort.current?.abort(); morePending.current = false; ++generation.current;
    setLoadingMore(false); setMoreError('');
    try {
      if (request.kind === 'all') await accountApi.clearHistory(session.csrfToken);
      else if (request.kind === 'one') await accountApi.removeHistory(request.ids[0], session.csrfToken);
      else await accountApi.removeHistorySelection(request.ids, session.csrfToken);
      if (!active.current) return;
      if (currentKey.current !== key) { setAttempt(value => value + 1); return; }
      const removed = new Set(request.kind === 'all' ? [] : request.ids);
      const remaining = request.kind === 'all' ? [] : data.items.filter(item => !removed.has(item.id));
      setState({ ...data, items: remaining, nextCursor: request.kind === 'all' ? null : data.nextCursor });
      if (request.kind !== 'all' && !remaining.length && data.nextCursor) setAttempt(value => value + 1);
    } catch (failure) { requireLogin(failure); throw failure; }
  }
  const entries = useMemo<HistoryEntry[]>(() => data.items.map(item => ({
    id: item.id, kind: item.kind, title: item.title, publisher: item.publisher,
    channelHref: item.channelHandle ? channelPath(item.channelHandle) : null,
    thumbnailUrl: item.available ? item.thumbnailUrl : null, duration: item.available ? '라이브' : '', progress: 0,
    href: item.available ? watchPath({ path: item.path, id: item.broadcastId }) : null,
    watchedAt: new Date(item.watchedAtMs), unavailableLabel: '방송 종료',
  })), [data.items]);

  return <HistoryView entries={entries} signedIn={Boolean(session.user)} onLogin={onRequireLogin} onRemove={remove}
    phase={data.phase} error={data.error} onRetry={() => setAttempt(value => value + 1)} hasMore={Boolean(data.nextCursor)}
    loadingMore={loadingMore} moreError={moreError} onLoadMore={() => void loadMore()} />;
}
