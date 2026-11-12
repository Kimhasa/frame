import { FolderOpen, Search, Settings, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './RecordingsPage.module.css';

type Status = '완료' | '녹화 중' | '누락' | '손상' | '삭제됨';
type Recording = { id: string; file: string; date: string; duration: string; size: number | null; status: Exclude<Status, '삭제됨'> };
type Editor = { type: 'file'; recording: Recording } | { type: 'delete'; ids: readonly string[] } | { type: 'retention' };

const recordings: readonly Recording[] = [
  { id: 'workspace', file: '2026-10-28_개발작업실.mp4', date: '2026-10-28T20:00:00+09:00', duration: '2:14:36', size: 7.8, status: '완료' },
  { id: 'small-feature', file: '2026-10-27_작은기능.mp4', date: '2026-10-27T19:30:00+09:00', duration: '1:48:12', size: 6.2, status: '완료' },
  { id: 'first-review', file: '2026-10-26_첫화면점검.mp4', date: '2026-10-26T21:00:00+09:00', duration: '0:24:06', size: null, status: '누락' },
  { id: 'screen-test', file: '2026-10-24_화면공유시험.mp4', date: '2026-10-24T20:00:00+09:00', duration: '0:07:28', size: 0.4, status: '손상' },
  { id: 'broadcast-test', file: '2026-10-23_시험송출.mp4', date: '2026-10-23T18:00:00+09:00', duration: '0:12:32', size: 0.7, status: '녹화 중' },
];
const statuses = ['전체', '완료', '녹화 중', '누락', '손상', '삭제됨'] as const;
const retentionOptions = ['7일', '30일', '90일', '계속 보관'] as const;
type Retention = typeof retentionOptions[number];
type Preferences = { deleted: string[]; retention: Retention };
const storageKey = 'frame.design-recordings.v1';
const formatDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' });

function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Partial<Preferences> | null;
    if (saved && Array.isArray(saved.deleted) && saved.retention && retentionOptions.includes(saved.retention)) {
      return { deleted: recordings.filter(row => row.status !== '녹화 중' && saved.deleted?.includes(row.id)).map(row => row.id), retention: saved.retention };
    }
  } catch { /* Keep this preview usable when browser storage is unavailable. */ }
  return { deleted: [], retention: '30일' };
}

function sizeLabel(size: Recording['size']) {
  return size === null ? '—' : `${size.toFixed(1)} GB`;
}

export function RecordingsPage() {
  const [params] = useSearchParams();
  const [preferences, setPreferences] = useState(readPreferences);
  const [filter, setFilter] = useState<typeof statuses[number]>('전체');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const scenario = params.get('state');
  const full = scenario === 'full';
  const available = scenario === 'empty' ? [] : recordings.filter(row => !full || row.status !== '녹화 중');
  const usage = full ? 100 : Math.round(available.reduce((sum, row) => sum + (row.size ?? 0), 0));
  const term = query.trim().toLocaleLowerCase('ko-KR');

  function statusFor(recording: Recording): Status {
    return preferences.deleted.includes(recording.id) ? '삭제됨' : recording.status;
  }

  const rows = available.filter(row => {
    const status = statusFor(row);
    return (filter === '전체' ? status !== '삭제됨' : status === filter) && row.file.toLocaleLowerCase('ko-KR').includes(term);
  });
  const selectable = rows.filter(row => row.status !== '녹화 중' && statusFor(row) !== '삭제됨');
  const file = editor?.type === 'file' ? editor.recording : null;

  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(preferences)); }
    catch { /* The current state stays in memory. */ }
  }, [preferences]);

  useEffect(() => {
    if (editor && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (editor?.type === 'delete') cancelDelete.current?.focus();
  }, [editor]);

  function finish(message: string, focusList = false) {
    dialog.current?.close();
    setNotice(message);
    if (focusList) search.current?.focus();
  }

  function remove(ids: readonly string[]) {
    setPreferences(current => ({ ...current, deleted: [...new Set([...current.deleted, ...ids])] }));
    setSelected([]);
    finish(`${ids.length}개 항목을 목록에서 삭제했어요.`, true);
  }

  function restore(id: string) {
    setPreferences(current => ({ ...current, deleted: current.deleted.filter(item => item !== id) }));
    setFilter('전체');
    finish('녹화 항목을 복원했어요.', true);
  }

  return <ManagementPage title="녹화 관리" titleId="recordings-title" actions={
    <button className={ui.button} type="button" aria-haspopup="dialog" onClick={() => setEditor({ type: 'retention' })}><Settings size={17} aria-hidden="true" />보관 설정</button>
  }>
      {full && <p className={styles.warning} role="alert"><TriangleAlert size={19} aria-hidden="true" />서버 저장 공간이 부족해 녹화를 멈췄어요.</p>}
      <div className={styles.toolbar}>
        <label className={`${ui.search} ${styles.search}`}>
          <Search size={17} aria-hidden="true" />
          <input ref={search} type="search" aria-label="녹화 파일 검색" placeholder="파일 이름 검색" maxLength={120} value={query} onChange={event => {
            setQuery(event.currentTarget.value);
            setSelected([]);
          }} />
        </label>
        <select className={ui.control} aria-label="녹화 상태" value={filter} onChange={event => {
          setFilter(event.currentTarget.value as typeof filter);
          setSelected([]);
        }}>
          {statuses.map(status => <option key={status}>{status}</option>)}
        </select>
      </div>
      <p className={styles.notice} role="status">{notice}</p>
      {rows.length > 0 ? <>
        <label className={styles.mobileSelectAll}><input className={ui.checkbox} type="checkbox" aria-label="녹화 모두 선택" disabled={!selectable.length}
          checked={selectable.length > 0 && selectable.every(row => selected.includes(row.id))}
          ref={element => { if (element) element.indeterminate = selected.length > 0 && !selectable.every(row => selected.includes(row.id)); }}
          onChange={event => setSelected(event.currentTarget.checked ? selectable.map(row => row.id) : [])} />모두 선택</label>
        {selected.length > 0 && <div className={styles.selection}>
          <strong>{selected.length}개 선택</strong>
          <button type="button" className={ui.button} disabled={!selected.length} onClick={() => setSelected([])}>{selected.length}개 선택 해제</button>
          <button type="button" className={`${ui.button} ${ui.danger}`} disabled={!selected.length} onClick={() => setEditor({ type: 'delete', ids: selected })}>선택 삭제</button>
        </div>}
        <div className={ui.tableFrame}>
          <table className={ui.table} aria-label="녹화 파일 목록">
            <thead><tr><th scope="col"><label className={styles.selectAll}><input className={ui.checkbox} type="checkbox" aria-label="선택 가능한 녹화 모두 선택" disabled={!selectable.length}
              checked={selectable.length > 0 && selectable.every(row => selected.includes(row.id))}
              ref={element => { if (element) element.indeterminate = selected.length > 0 && !selectable.every(row => selected.includes(row.id)); }}
              onChange={event => setSelected(event.currentTarget.checked ? selectable.map(row => row.id) : [])} />파일</label></th><th scope="col" data-align="end">길이</th><th scope="col" data-align="end">크기</th><th scope="col">상태</th><th scope="col">관리</th></tr></thead>
            <tbody>{rows.map(row => {
              const status = statusFor(row);
              return <tr key={row.id}>
                <td data-label="파일" data-primary="true">
                  <label className={styles.file}>
                    <input className={ui.checkbox} type="checkbox" aria-label={`${row.file} 선택`} disabled={status === '삭제됨' || status === '녹화 중'} checked={selected.includes(row.id)} onChange={event => {
                      const checked = event.currentTarget.checked;
                      setSelected(current => checked ? [...current, row.id] : current.filter(id => id !== row.id));
                    }} />
                    <span><strong>{row.file}</strong><time dateTime={row.date}>{formatDate.format(new Date(row.date))}</time></span>
                  </label>
                </td>
                <td data-label="길이" data-align="end">{row.duration}</td>
                <td data-label="크기" data-align="end">{sizeLabel(row.size)}</td>
                <td data-label="상태"><StatusBadge tone={status === '완료' ? 'positive' : status === '녹화 중' ? 'live' : status === '누락' || status === '손상' ? 'danger' : 'neutral'}>{status}</StatusBadge></td>
                <td><button className={ui.button} type="button" aria-label={`${row.file} 파일 정보`} aria-haspopup="dialog" onClick={() => setEditor({ type: 'file', recording: row })}>파일 정보</button></td>
              </tr>;
            })}</tbody>
          </table>
          <p className={styles.count}>{rows.length}개 항목</p>
        </div>
      </> : <EmptyState icon={<FolderOpen size={23} />} title={query || filter !== '전체' ? '조건에 맞는 녹화가 없어요' : '저장된 녹화 파일이 없어요'}
        description={query || filter !== '전체' ? '검색어나 상태 필터를 확인해 주세요.' : 'FRAME 서버에 보관한 방송 녹화가 여기에 표시돼요. OBS의 로컬 녹화는 OBS에서 확인해 주세요.'} />}
      <section className={styles.storage} aria-labelledby="recordings-storage-title">
        <h2 id="recordings-storage-title">저장 공간</h2>
        <p><span>사용 {usage} GB / 한도 100 GB</span><strong>{usage}%</strong></p>
        <progress className={full ? styles.full : undefined} aria-label="녹화 저장 공간 사용량" value={usage} max={100} />
        <p className={styles.help}>OBS가 내 PC에 저장한 녹화 파일은 포함하지 않아요.</p>
      </section>
      {editor && <dialog className={ui.dialog} ref={dialog} aria-labelledby={dialogId} onClose={() => setEditor(null)}>
        <header className={ui.dialogHeader}>
          <h2 id={dialogId}>{editor.type === 'retention' ? '녹화 보관' : editor.type === 'delete' ? '녹화 목록에서 삭제할까요?' : '녹화 파일'}</h2>
          <button type="button" className="icon-button" aria-label="닫기" onClick={() => dialog.current?.close()}><X size={20} aria-hidden="true" /></button>
        </header>
        {file && <>
          <dl className={styles.details}>
            <div><dt>파일 이름</dt><dd>{file.file}</dd></div>
            <div><dt>상태</dt><dd><StatusBadge tone={statusFor(file) === '완료' ? 'positive' : statusFor(file) === '녹화 중' ? 'live' : statusFor(file) === '누락' || statusFor(file) === '손상' ? 'danger' : 'neutral'}>{statusFor(file)}</StatusBadge></dd></div>
            <div><dt>크기</dt><dd>{sizeLabel(file.size)}</dd></div>
            <div><dt>보관 영역</dt><dd>FRAME 서버</dd></div>
            <div><dt>보관 기간</dt><dd>{preferences.retention}</dd></div>
          </dl>
          <p className={styles.help}>OBS가 내 PC에 저장한 녹화 파일은 OBS에서 확인해 주세요.</p>
          {file.status !== '녹화 중' && <div className={ui.dialogActions}>
            {statusFor(file) === '삭제됨'
              ? <button type="button" className={`${ui.button} ${ui.primary}`} onClick={() => restore(file.id)}>복원</button>
              : <button type="button" className={`${ui.button} ${ui.danger}`} onClick={() => setEditor({ type: 'delete', ids: [file.id] })}>목록에서 삭제</button>}
          </div>}
        </>}
        {editor.type === 'delete' && <>
          <p className={styles.help}>{editor.ids.length}개 항목을 목록에서 삭제해요. 삭제됨 필터에서 복원할 수 있어요.</p>
          <div className={ui.dialogActions}>
            <button ref={cancelDelete} type="button" className={ui.button} onClick={() => dialog.current?.close()}>취소</button>
            <button type="button" className={`${ui.button} ${ui.danger}`} onClick={() => remove(editor.ids)}>목록에서 삭제</button>
          </div>
        </>}
        {editor.type === 'retention' && <form className={styles.form} onSubmit={event => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get('retention');
          const retention = retentionOptions.find(option => option === value);
          if (!retention) return;
          setPreferences(current => ({ ...current, retention }));
          finish('녹화 보관 기간을 저장했어요.');
        }}>
          <label>보관 기간<select className={ui.control} name="retention" defaultValue={preferences.retention}>{retentionOptions.map(option => <option key={option}>{option}</option>)}</select></label>
          <p className={styles.help}>방송 녹화의 보관 기간을 설정해 주세요.</p>
          <div className={ui.dialogActions}><button className={`${ui.button} ${ui.primary}`} type="submit">저장</button></div>
        </form>}
      </dialog>}
  </ManagementPage>;
}
