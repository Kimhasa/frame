import { Bell, Check, CheckCheck, ChevronRight, Flag, Radio, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { watchPath } from '../../viewer-contract';
import { AccountError, accountApi } from '../account/account-client';
import type { AccountSession, ProductNotification } from '../account/account-client';
import base from './NotificationsPage.module.css';
import styles from './ConnectedNotificationsPage.module.css';

const calendar = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayKey = (value: number) => new Date(value + 9 * 3600000).toISOString().slice(0, 10);
function relativeTime(value: number) {
  const minutes = Math.floor(Math.max(0, Date.now() - value) / 60000);
  return minutes < 1 ? '방금' : minutes < 60 ? `${minutes}분 전` : minutes < 1440 ? `${Math.floor(minutes / 60)}시간 전` : timestamp.format(value);
}
const channelHref = (id: string) => `/channel/id/${encodeURIComponent(id)}`;
type State = { key: string; phase: 'loading' | 'ready' | 'error'; items: ProductNotification[]; nextCursor: string | null; unreadCount: number; error: string };
const initial = (key: string): State => ({ key, phase: 'loading', items: [], nextCursor: null, unreadCount: 0, error: '' });

function NotificationDialog({ title, pending = false, onDismiss, children }: { title: string; pending?: boolean; onDismiss: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), opener = useRef(document.activeElement), id = useId();
  useEffect(() => {
    const element = dialog.current; element?.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected && !opener.current.matches(':disabled')) opener.current.focus({ preventScroll: true });
      else document.getElementById('notifications-title')?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} aria-busy={pending}
    onCancel={event => { event.preventDefault(); if (!pending) onDismiss(); }}>
    <header className={styles.dialogHeader}><h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{title}</h2>
      <button type="button" className="icon-button" disabled={pending} aria-label="알림 상세 닫기" onClick={onDismiss}><X size={20} aria-hidden="true" /></button></header>
    {children}
  </dialog>;
}

export function ConnectedNotificationsPage({ session, onRequireLogin, onSessionChanged, onUnreadCountChange, unreadCount }: {
  session: AccountSession; onRequireLogin: () => void; onSessionChanged: () => void;
  onUnreadCountChange?: (count: number) => void; unreadCount?: number;
}) {
  const owner = session.user!.id, [params, setParams] = useSearchParams();
  const filter = params.get('filter') === 'unread' ? 'unread' : 'all';
  const kind = ['live', 'report'].includes(params.get('kind') ?? '') ? params.get('kind') as 'live' | 'report' : 'all';
  const key = JSON.stringify([filter, kind]), [state, setState] = useState<State>(() => initial(key));
  const [attempt, setAttempt] = useState(0), [morePending, setMorePending] = useState(false), [moreError, setMoreError] = useState('');
  const [pending, setPending] = useState<string | null>(null), [mutationError, setMutationError] = useState(''), [feedback, setFeedback] = useState('');
  const [confirmClear, setConfirmClear] = useState(false), [selected, setSelected] = useState<ProductNotification | null>(null), [scopeLost, setScopeLost] = useState(false);
  const active = useRef(true), generation = useRef(0), writing = useRef(false), moreInFlight = useRef(false);
  const listAbort = useRef<AbortController | null>(null), moreAbort = useRef<AbortController | null>(null), currentKey = useRef(key); currentKey.current = key;
  const callbacks = useRef({ onRequireLogin, onSessionChanged, onUnreadCountChange }); callbacks.current = { onRequireLogin, onSessionChanged, onUnreadCountChange };
  const data = state.key === key ? state : initial(key);
  useEffect(() => { active.current = true; return () => { active.current = false; listAbort.current?.abort(); moreAbort.current?.abort(); }; }, []);
  function loseScope(login: boolean) {
    ++generation.current; listAbort.current?.abort(); moreAbort.current?.abort(); setState(initial(key)); setSelected(null); setConfirmClear(false); setScopeLost(true);
    if (login) callbacks.current.onRequireLogin(); else callbacks.current.onSessionChanged();
  }
  function accessError(failure: unknown) {
    if (!(failure instanceof AccountError)) return false;
    if (failure.status === 401) { loseScope(true); return true; }
    if (failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') { loseScope(false); return true; }
    return false;
  }
  function accept(result: { userId: string; unreadCount: number }) {
    if (result.userId !== owner) { if (active.current) loseScope(false); else callbacks.current.onSessionChanged(); return false; }
    callbacks.current.onUnreadCountChange?.(result.unreadCount); return true;
  }
  useEffect(() => {
    const abort = new AbortController(), version = ++generation.current;
    listAbort.current?.abort(); moreAbort.current?.abort(); listAbort.current = abort; moreInFlight.current = false;
    setMorePending(false); setMoreError('');
    setState(previous => previous.key === key && previous.phase === 'ready' ? previous : initial(key));
    if (scopeLost || writing.current) return () => abort.abort();
    accountApi.notificationList({ filter, kind, limit: 50 }, abort.signal, owner).then(result => {
      if (abort.signal.aborted || generation.current !== version || !accept(result)) return;
      setState({ key, phase: 'ready', ...result, error: '' });
    }).catch(failure => {
      if (abort.signal.aborted || generation.current !== version || accessError(failure)) return;
      const message = failure instanceof Error ? failure.message : '알림을 불러오지 못했어요.';
      setState(previous => previous.key === key && previous.phase === 'ready' ? { ...previous, error: message } : { ...initial(key), phase: 'error', error: message });
    });
    return () => abort.abort();
  }, [key, attempt, owner, scopeLost]);
  useEffect(() => {
    function refresh() { if (document.visibilityState === 'visible' && navigator.onLine && !writing.current && !selected && !confirmClear) setAttempt(value => value + 1); }
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [selected, confirmClear]);
  async function loadMore() {
    if (!data.nextCursor || moreInFlight.current || writing.current || scopeLost) return;
    const abort = new AbortController(), version = generation.current, cursor = data.nextCursor;
    moreAbort.current = abort; moreInFlight.current = true; setMorePending(true); setMoreError('');
    try {
      const result = await accountApi.notificationList({ filter, kind, limit: 50, cursor }, abort.signal, owner);
      if (abort.signal.aborted || !active.current || generation.current !== version || !accept(result)) return;
      if (result.nextCursor === cursor) throw Error('다음 알림 목록을 확인하지 못했어요.');
      setState(previous => {
        if (previous.key !== key) return previous;
        const known = new Set(previous.items.map(item => item.id));
        return { ...previous, items: [...previous.items, ...result.items.filter(item => !known.has(item.id))], nextCursor: result.nextCursor, unreadCount: result.unreadCount };
      });
    } catch (failure) {
      if (abort.signal.aborted || !active.current || generation.current !== version || accessError(failure)) return;
      setMoreError(failure instanceof Error ? failure.message : '다음 알림 목록을 불러오지 못했어요.');
    } finally { if (active.current && generation.current === version) { moreInFlight.current = false; setMorePending(false); } }
  }
  async function mutate(action: 'read' | 'readAll' | 'remove' | 'clear', item?: ProductNotification) {
    if (writing.current || scopeLost || (action === 'read' && item?.readAtMs !== null)) return;
    writing.current = true; setPending(action + (item?.id ?? '')); setMutationError(''); setFeedback('');
    ++generation.current; listAbort.current?.abort(); moreAbort.current?.abort(); moreInFlight.current = false; setMorePending(false); setMoreError('');
    let refresh = false; const opener = document.activeElement;
    try {
      const result = action === 'read' ? await accountApi.readNotification(item!.id, session.csrfToken, owner)
        : action === 'readAll' ? await accountApi.readAllNotifications(session.csrfToken, owner)
        : action === 'remove' ? await accountApi.removeNotification(item!.id, session.csrfToken, owner) : await accountApi.clearNotifications(session.csrfToken, owner);
      if (!accept(result) || !active.current) return;
      const now = Date.now();
      const rows = action === 'clear' ? [] : data.items.flatMap(entry => {
        if (action === 'remove' && entry.id === item!.id) return [];
        const updated = action === 'readAll' || (action === 'read' && entry.id === item!.id) ? { ...entry, readAtMs: entry.readAtMs ?? now } : entry;
        return filter === 'unread' && updated.readAtMs !== null ? [] : [updated];
      });
      if (currentKey.current === key) setState({ ...data, items: rows, unreadCount: result.unreadCount, nextCursor: action === 'clear' || (action === 'readAll' && filter === 'unread') ? null : data.nextCursor });
      if (action === 'read') setSelected(previous => previous?.id === item!.id ? { ...previous, readAtMs: previous.readAtMs ?? now } : previous);
      if (action === 'clear') { setConfirmClear(false); setFeedback('알림을 모두 삭제했어요.'); }
      else setFeedback(action === 'remove' ? '알림을 삭제했어요.' : action === 'readAll' ? '알림을 모두 읽음으로 표시했어요.' : '읽음으로 표시했어요.');
      refresh = currentKey.current !== key || action === 'clear' || (action === 'readAll' && filter === 'unread') || (!rows.length && Boolean(data.nextCursor));
    } catch (failure) {
      if (active.current && !accessError(failure)) setMutationError(failure instanceof Error ? failure.message : '알림을 변경하지 못했어요. 다시 시도해 주세요.');
      else if (!active.current && failure instanceof AccountError && (failure.status === 401 || ['SESSION_CHANGED', 'CSRF_INVALID'].includes(failure.code))) callbacks.current.onSessionChanged();
    } finally {
      writing.current = false;
      if (active.current) {
        setPending(null); if (refresh) setAttempt(value => value + 1);
        requestAnimationFrame(() => { if (active.current && opener instanceof HTMLElement && !opener.isConnected && !document.querySelector('dialog[open]')) document.getElementById('notifications-title')?.focus({ preventScroll: true }); });
      }
    }
  }
  function filters(values: Record<string, string>) {
    if (writing.current) return;
    const next = new URLSearchParams(params);
    for (const [field, value] of Object.entries(values)) if (value && value !== 'all') next.set(field, value); else next.delete(field);
    setSelected(null); setFeedback(''); setMutationError(''); setParams(next, { replace: true });
  }
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86400000), groups = new Map<string, ProductNotification[]>();
  for (const item of data.items) { const date = dayKey(item.createdAtMs), group = groups.get(date); if (group) group.push(item); else groups.set(date, [item]); }
  const newAvailable = unreadCount !== undefined && data.phase === 'ready' && unreadCount > data.unreadCount;
  if (scopeLost) return <section className={base.page}><p role="status">계정 정보를 다시 확인하고 있어요.</p></section>;

  return <section className={base.page} aria-labelledby="notifications-title" aria-busy={data.phase === 'loading' || Boolean(pending)}>
    <div className={base.heading}><h1 id="notifications-title" tabIndex={-1}>알림</h1><div className={styles.headingActions}>
      <button type="button" className={styles.iconButton} aria-label="알림 새로고침" disabled={Boolean(pending) || data.phase === 'loading'} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={18} aria-hidden="true" /></button>
      <button type="button" className={base.readAll} disabled={Boolean(pending) || data.phase !== 'ready' || (unreadCount ?? data.unreadCount) === 0} onClick={() => void mutate('readAll')}><CheckCheck size={16} aria-hidden="true" />모두 읽기</button>
      <button type="button" className={styles.iconButton} aria-label="알림 모두 삭제" disabled={Boolean(pending) || data.phase !== 'ready' || data.items.length === 0} onClick={() => { setMutationError(''); setConfirmClear(true); }}><Trash2 size={18} aria-hidden="true" /></button>
    </div></div>
    <div className={styles.toolbar}><div className={styles.tabs} role="group" aria-label="알림 읽음 상태">
      <button type="button" aria-pressed={filter === 'all'} disabled={Boolean(pending)} onClick={() => filters({ filter: '' })}>전체</button>
      <button type="button" aria-pressed={filter === 'unread'} disabled={Boolean(pending)} onClick={() => filters({ filter: 'unread' })}>읽지 않음{unreadCount !== undefined && unreadCount > 0 && <span>{unreadCount > 99 ? '99+' : unreadCount}</span>}</button>
    </div><select className={styles.select} name="notification-kind" aria-label="알림 종류" value={kind} disabled={Boolean(pending)} onChange={event => filters({ kind: event.target.value })}><option value="all">전체 알림</option><option value="live">방송 시작</option><option value="report">신고 결과</option></select></div>
    {newAvailable && <button type="button" className={styles.newNotice} disabled={Boolean(pending)} onClick={() => { if (kind !== 'all') filters({ kind: '' }); setAttempt(value => value + 1); }}><Bell size={16} aria-hidden="true" />새 알림 확인</button>}
    {mutationError && !confirmClear && !selected && <div className={styles.errorArea}><p className={styles.error} role="alert">{mutationError}</p><button type="button" className={styles.textButton} disabled={Boolean(pending)} onClick={() => setAttempt(value => value + 1)}>목록 새로고침</button></div>}
    {data.phase === 'ready' && data.error && <div className={styles.errorArea}><p className={styles.error} role="alert">{data.error}</p><button type="button" className={styles.textButton} disabled={Boolean(pending)} onClick={() => setAttempt(value => value + 1)}>다시 시도</button></div>}
    {feedback && <p className={styles.success} role="status">{feedback}</p>}
    {data.phase === 'loading' ? <div className={styles.skeleton} role="status" aria-label="알림을 불러오는 중"><span /><span /><span /></div> : data.phase === 'error' ? <div className={base.notice}>
      <span className={base.noticeIcon}><Bell size={23} aria-hidden="true" /></span><h2>알림을 불러오지 못했어요</h2><p className={styles.error} role="alert">{data.error}</p><button type="button" className={base.readAll} onClick={() => setAttempt(value => value + 1)}>다시 시도</button>
    </div> : data.items.length === 0 ? <div className={base.notice}><span className={base.noticeIcon}><Bell size={23} aria-hidden="true" /></span><h2>{filter === 'unread' ? '읽지 않은 알림이 없어요' : kind !== 'all' ? '이 종류의 알림이 없어요' : '아직 받은 알림이 없어요'}</h2>
      {(filter !== 'all' || kind !== 'all') && <button type="button" className={base.readAll} onClick={() => filters({ filter: '', kind: '' })}>전체 알림 보기</button>}</div> : <>
      {[...groups].map(([date, items]) => <section key={date} className={styles.group} aria-label={date === today ? '오늘 알림' : date === yesterday ? '어제 알림' : calendar.format(items[0].createdAtMs)}>
        <h2>{date === today ? '오늘' : date === yesterday ? '어제' : calendar.format(items[0].createdAtMs)}</h2><ul className={base.list}>{items.map(item => {
          const isRead = item.readAtMs !== null, target = item.kind === 'live' ? item.target : null;
          const content = <><span className={base.avatar} aria-hidden="true">{item.kind === 'live' ? <Radio size={22} /> : <Flag size={21} />}</span><span className={base.copy}><strong>{item.title}</strong><span>{item.body}</span>
            <small><time dateTime={new Date(item.createdAtMs).toISOString()} title={timestamp.format(item.createdAtMs)}>{relativeTime(item.createdAtMs)}</time><span className={styles.destination}>{item.kind === 'report' ? '결과 확인' : target?.available ? '방송 보기' : '채널 보기'}</span></small></span><ChevronRight className={base.chevron} size={17} aria-hidden="true" /></>;
          return <li key={item.id} data-notification-id={item.id}><article className={`${base.item} ${styles.row}`} data-read={isRead} aria-label={item.title}>
            {target ? <Link className={styles.open} to={target.available ? watchPath({ id: target.broadcastId, path: target.path }) : channelHref(target.channelId)} onClick={() => { if (!isRead) void mutate('read', item); }}>{content}</Link>
              : <button type="button" className={styles.open} aria-label={`${item.title} 알림 열기`} onClick={() => { setSelected(item); setMutationError(''); if (!isRead) void mutate('read', item); }}>{content}</button>}
            <div className={styles.rowActions}>{!isRead && <button type="button" className={styles.iconButton} aria-label={`알림 ${item.id} 읽음 처리`} disabled={Boolean(pending)} onClick={() => void mutate('read', item)}><Check size={17} aria-hidden="true" /></button>}
              <button type="button" className={styles.iconButton} aria-label={`알림 ${item.id} 삭제`} disabled={Boolean(pending)} onClick={() => void mutate('remove', item)}><X size={17} aria-hidden="true" /></button></div>
            <span className={base.visuallyHidden}>{isRead ? '읽음' : '읽지 않음'}</span>{!isRead && <span className={styles.unreadDot} aria-hidden="true" />}
          </article></li>;
        })}</ul>
      </section>)}
      {(data.nextCursor || moreError) && <div className={styles.more}>{moreError && <p className={styles.error} role="alert">{moreError}</p>}<button type="button" className={base.readAll} disabled={morePending || Boolean(pending)} onClick={() => void loadMore()}>{morePending ? '불러오는 중…' : moreError ? '다음 알림 다시 시도' : '더 보기'}</button></div>}
    </>}
    {confirmClear && <NotificationDialog title="알림을 모두 삭제할까요?" pending={Boolean(pending)} onDismiss={() => { if (!writing.current) setConfirmClear(false); }}>
      <p className={styles.dialogCopy}>현재 필터와 관계없이 계정의 알림을 모두 삭제합니다.</p>{mutationError && <p className={styles.error} role="alert">{mutationError}</p>}
      <div className={styles.dialogActions}><button type="button" className={base.readAll} disabled={Boolean(pending)} onClick={() => setConfirmClear(false)}>취소</button><button type="button" className={`${base.readAll} ${styles.danger}`} disabled={Boolean(pending)} onClick={() => void mutate('clear')}>{pending ? '삭제 중…' : '모두 삭제'}</button></div>
    </NotificationDialog>}
    {selected?.kind === 'report' && <NotificationDialog title="신고 검토 결과" pending={Boolean(pending)} onDismiss={() => { if (!writing.current) setSelected(null); }}>
      <span className={styles.resultIcon} aria-hidden="true"><Flag size={24} /></span><h3 className={styles.resultTitle}>{selected.title}</h3><p className={styles.dialogCopy}>{selected.body}</p>
      <dl className={styles.resultFacts}><div><dt>검토 결과</dt><dd>{selected.report.status === 'resolved' ? '검토 완료' : '기각'}</dd></div><div><dt>신고 번호</dt><dd>{selected.report.id}</dd></div><div><dt>안내일</dt><dd>{timestamp.format(selected.createdAtMs)}</dd></div></dl>
      {mutationError && <p className={styles.error} role="alert">{mutationError}</p>}<div className={styles.dialogActions}>{selected.readAtMs === null && <button type="button" className={base.readAll} disabled={Boolean(pending)} onClick={() => void mutate('read', selected)}>읽음 처리</button>}<button type="button" className={base.readAll} disabled={Boolean(pending)} onClick={() => setSelected(null)}>확인</button></div>
    </NotificationDialog>}
  </section>;
}
