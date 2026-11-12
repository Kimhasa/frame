import { CalendarDays, Plus, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import type { PreviewSchedule } from '../../preview/community-types';
import { AccountError } from '../account/account-client';
import type { ScheduleChanges, ScheduledBroadcast } from '../account/account-client';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './SchedulePage.module.css';

export type { ScheduledBroadcast } from '../account/account-client';

const timeZone = 'Asia/Seoul';
const dateFormat = new Intl.DateTimeFormat('ko-KR', { timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const timeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone, hour: 'numeric', minute: '2-digit' });

function kst(at: number) {
  const [date, time] = new Date(at + 9 * 3_600_000).toISOString().split('T');
  return { date, time: time.slice(0, 5) };
}

export function initialPreviewSchedule(): ScheduledBroadcast[] {
  const day = 86_400_000;
  return [
    { id: 'spring-s1', title: '작업실에서 같이 코딩해요', at: Date.parse(`${kst(Date.now() + day).date}T20:00+09:00`) },
    { id: 'spring-s2', title: '작은 기능 하나씩 완성하기', at: Date.parse(`${kst(Date.now() + 3 * day).date}T20:00+09:00`) },
    { id: 'spring-s3', title: '한 주의 작업 정리', at: Date.parse(`${kst(Date.now() - 2 * day).date}T15:00+09:00`) },
  ];
}

export function channelSchedule(items: readonly ScheduledBroadcast[]): PreviewSchedule[] {
  return items.filter(item => item.at >= Date.now()).sort((a, b) => a.at - b.at).map(item => ({
    id: item.id, title: item.title, dateLabel: dateFormat.format(item.at), timeLabel: timeFormat.format(item.at),
  }));
}

type Editor = { kind: 'edit'; item: ScheduledBroadcast | null } | { kind: 'cancel' | 'detail'; item: ScheduledBroadcast };

export function SchedulePage({ items, onChange, onSave, onCancelReservation }: {
  items: readonly ScheduledBroadcast[];
  onChange?: (items: ScheduledBroadcast[]) => void;
  onSave?: (changes: ScheduleChanges, id?: string) => Promise<void>;
  onCancelReservation?: (id: string) => Promise<void>;
}) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('date');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<'title' | 'date' | 'time' | null>(null);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const active = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dialogId = useId();
  const past = params.get('tab') === 'past';
  const now = Date.now();
  const displayed = import.meta.env.MODE === 'design' && params.get('state') === 'empty' ? [] : items;
  const pastCount = displayed.filter(item => item.at < now).length;
  const results = displayed.filter(item => (item.at < now) === past && item.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'ko') : past ? b.at - a.at : a.at - b.at);
  const editable = editor?.item;
  const fields = kst(editable?.at ?? now + 86_400_000);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  useEffect(() => {
    if (editor && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      dialog.current.querySelector('input')?.focus();
    }
  }, [editor]);

  function selectTab(nextPast: boolean) {
    const next = new URLSearchParams(params);
    if (nextPast) next.set('tab', 'past');
    else next.delete('tab');
    setParams(next);
  }

  function show(next: Editor, source?: HTMLElement) {
    if (saving.current) return;
    opener.current = source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setError('');
    setErrorField(null);
    setEditor(next);
  }

  function dialogClosed() {
    if (dialog.current?.open) return;
    setEditor(null);
    requestAnimationFrame(() => {
      const target = opener.current;
      if (target?.isConnected && !target.matches(':disabled')) target.focus();
      else addButton.current?.focus();
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    const title = String(form.get('title') ?? '').trim();
    const at = Date.parse(`${form.get('date')}T${form.get('time')}+09:00`);
    function invalid(field: 'title' | 'date' | 'time', message: string) {
      setError(message); setErrorField(field);
      element.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus();
    }
    if (!title) { invalid('title', '방송 제목을 입력해 주세요.'); return; }
    if ([...title].length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(title)) { invalid('title', '방송 제목은 제어 문자 없이 1~100자로 입력해 주세요.'); return; }
    if (!form.get('date')) { invalid('date', '방송 날짜를 선택해 주세요.'); return; }
    if (!form.get('time')) { invalid('time', '시작 시간을 선택해 주세요.'); return; }
    if (!Number.isFinite(at) || at <= Date.now()) { invalid('date', '현재 이후의 날짜와 시간을 선택해 주세요.'); return; }
    if (items.some(item => item.id !== editable?.id && item.at === at)) { invalid('time', '같은 시간에 예약된 방송이 있어요.'); return; }
    saving.current = true; setPending(true); setError(''); setErrorField(null); setNotice('');
    let focusField: 'title' | 'date' | 'time' | null = null;
    try {
      if (onSave) await onSave({ title, at }, editable?.id);
      else {
        const item = { id: editable?.id ?? `schedule-${at}`, title, at };
        onChange?.(editable ? items.map(row => row.id === editable.id ? item : row) : [...items, item]);
      }
      if (!active.current) return;
      dialog.current?.close();
      setNotice(editable ? '예약을 변경했어요.' : '예약을 추가했어요.');
      setQuery('');
      const next = new URLSearchParams(params);
      next.delete('tab'); next.delete('state'); setParams(next);
    } catch (failure) {
      if (!active.current) return;
      const code = failure instanceof AccountError ? failure.code : '';
      focusField = code === 'INVALID_SCHEDULE_TITLE' ? 'title' : code === 'INVALID_SCHEDULE_TIME' ? 'date' : code === 'SCHEDULE_CONFLICT' ? 'time' : null;
      setError(failure instanceof Error ? failure.message : '방송 예약을 저장하지 못했어요.'); setErrorField(focusField);
    } finally {
      saving.current = false;
      if (active.current) {
        setPending(false);
        if (focusField) requestAnimationFrame(() => element.querySelector<HTMLInputElement>(`[name="${focusField}"]`)?.focus());
      }
    }
  }

  async function cancel(item: ScheduledBroadcast) {
    if (saving.current) return;
    saving.current = true; setPending(true); setError(''); setNotice('');
    try {
      if (onCancelReservation) await onCancelReservation(item.id);
      else onChange?.(items.filter(row => row.id !== item.id));
      if (!active.current) return;
      dialog.current?.close(); setNotice('예약을 취소했어요.');
    } catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : '예약을 취소하지 못했어요.'); }
    finally { saving.current = false; if (active.current) setPending(false); }
  }

  return <ManagementPage title="방송 예약" titleId="schedule-title" actions={
        <button className={`${ui.button} ${ui.primary}`} ref={addButton} type="button" disabled={pending} aria-haspopup="dialog" onClick={event => show({ kind: 'edit', item: null }, event.currentTarget)}>
          <Plus size={18} aria-hidden="true" />예약 추가
        </button>
  }>
      <div className={ui.tabs} role="group" aria-label="방송 예약 구분">
        <button type="button" aria-pressed={!past} aria-current={!past ? 'page' : undefined} onClick={() => selectTab(false)}>예정된 방송 <span>{displayed.length - pastCount}</span></button>
        <button type="button" aria-pressed={past} aria-current={past ? 'page' : undefined} onClick={() => selectTab(true)}>지난 예약 <span>{pastCount}</span></button>
      </div>
      <div className={styles.tools}>
        <label className={`${ui.search} ${styles.search}`}><Search size={17} aria-hidden="true" /><input type="search" aria-label="방송 제목 검색" placeholder="방송 제목 검색" maxLength={100} value={query} onChange={event => setQuery(event.currentTarget.value)} /></label>
        <select className={ui.control} aria-label="예약 정렬" value={sort} onChange={event => setSort(event.currentTarget.value)}>
          <option value="date">{past ? '최근 일정순' : '가까운 일정순'}</option><option value="title">제목순</option>
        </select>
      </div>
      <p className={styles.status} role="status">{notice}</p>
      {results.length ? <div className={ui.tableFrame}>
        <table className={ui.table} aria-label="방송 예약 목록">
          <thead><tr><th scope="col">방송 제목</th><th scope="col">방송 일시 · 서울 시간</th><th scope="col">상태</th><th scope="col">관리</th></tr></thead>
          <tbody>{results.map(item => <tr key={item.id}>
            <td data-label="방송 제목" data-primary="true"><strong>{item.title}</strong></td>
            <td data-label="방송 일시"><time className={styles.when} dateTime={new Date(item.at).toISOString()}><span>{dateFormat.format(item.at)}</span><strong>{timeFormat.format(item.at)}</strong></time></td>
            <td data-label="상태"><StatusBadge tone={past ? 'neutral' : 'info'}>{past ? '지난 예약' : '예정'}</StatusBadge></td>
            <td><div className={styles.actions}>{past
              ? <button type="button" className={ui.button} aria-label={`${item.title} 지난 예약 상세`} onClick={event => show({ kind: 'detail', item }, event.currentTarget)}>상세</button>
              : <><button type="button" className={ui.button} onClick={event => show({ kind: 'edit', item }, event.currentTarget)} aria-label={`${item.title} 예약 수정`}>수정</button>
                <button type="button" className={ui.button} onClick={event => show({ kind: 'cancel', item }, event.currentTarget)} aria-label={`${item.title} 예약 취소`}>예약 취소</button></>}
            </div></td>
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState icon={<CalendarDays size={23} />} title={query.trim() ? '조건에 맞는 예약이 없어요' : past ? '지난 예약이 없어요' : '예정된 방송이 없어요'}
        action={query.trim() ? <button className={ui.button} type="button" onClick={() => setQuery('')}>검색어 지우기</button> : undefined} />}
    <dialog ref={dialog} className={ui.dialog} aria-labelledby={dialogId} aria-busy={pending} onCancel={event => { if (saving.current) event.preventDefault(); }} onClose={dialogClosed}>
      {editor && <>
        <header className={ui.dialogHeader}><h2 id={dialogId}>{editor.kind === 'cancel' ? '예약을 취소할까요?' : editor.kind === 'detail' ? '지난 예약' : editable ? '예약 수정' : '예약 추가'}</h2>
          <button type="button" className="icon-button" aria-label="닫기" disabled={pending} onClick={() => dialog.current?.close()}><X size={20} /></button></header>
        {editor.kind === 'edit' ? <form className={styles.form} noValidate onSubmit={submit} onInput={() => { setError(''); setErrorField(null); }}>
          <fieldset className={styles.fields} disabled={pending}>
            <label>방송 제목<input className={ui.control} name="title" maxLength={200} defaultValue={editable?.title} required aria-invalid={errorField === 'title'} aria-describedby={errorField === 'title' ? `${dialogId}-error` : undefined} /></label>
            <div className={styles.dateFields}>
              <label>날짜<input className={ui.control} name="date" type="date" defaultValue={fields.date} min={kst(now).date} required aria-invalid={errorField === 'date'} aria-describedby={errorField === 'date' ? `${dialogId}-error` : undefined} /></label>
              <label>시작 시간<input className={ui.control} name="time" type="time" defaultValue={editable ? fields.time : '20:00'} required aria-invalid={errorField === 'time'} aria-describedby={errorField === 'time' ? `${dialogId}-error` : undefined} /></label>
            </div>
            <p>서울 시간 기준이에요.</p>
            {error && <p className={styles.error} id={`${dialogId}-error`} role="alert">{error}</p>}
            <div className={ui.dialogActions}><button className={ui.button} type="button" onClick={() => dialog.current?.close()}>취소</button>
              <button className={`${ui.button} ${ui.primary}`} type="submit">{pending ? '저장 중' : editable ? '변경 사항 저장' : '예약하기'}</button></div>
          </fieldset>
        </form> : <div className={styles.summary}>
          <strong>{editor.item.title}</strong><p>{dateFormat.format(editor.item.at)} {timeFormat.format(editor.item.at)} · 서울 시간</p>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={ui.dialogActions}><button className={ui.button} type="button" disabled={pending} onClick={() => dialog.current?.close()}>{editor.kind === 'cancel' ? '돌아가기' : '닫기'}</button>
            {editor.kind === 'cancel' && <button className={`${ui.button} ${ui.danger}`} type="button" disabled={pending} onClick={() => void cancel(editor.item)}>{pending ? '취소 중' : '예약 취소'}</button>}</div>
        </div>}
      </>}
    </dialog>
  </ManagementPage>;
}
