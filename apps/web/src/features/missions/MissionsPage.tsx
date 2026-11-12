import { ManagementPage, StatusBadge, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { Target, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import styles from './MissionsPage.module.css';

const tabs = [
  { id: 'received', label: '접수' }, { id: 'running', label: '진행 중' }, { id: 'completed', label: '완료' },
  { id: 'rejected', label: '거절' }, { id: 'cancelled', label: '취소' }, { id: 'expired', label: '기한 만료' }, { id: 'failed', label: '실패' },
] as const;

type MissionStatus = typeof tabs[number]['label'];
type Mission = {
  id: string;
  title: string;
  proposer: string;
  typeLabel: string;
  deadline: string;
  receivedAt: string;
  status: MissionStatus;
  reason: string;
  history: readonly { status: MissionStatus; reason: string }[];
};

const transitions: Partial<Record<MissionStatus, readonly MissionStatus[]>> = {
  접수: ['진행 중', '거절', '취소', '기한 만료'],
  '진행 중': ['완료', '실패', '기한 만료', '취소'],
};

export function createPreviewMissions(): Mission[] {
  return [
    { id: 'mission-1', title: '오늘의 기능 완성하기', proposer: '모아', typeLabel: '무료 미션', deadline: '오늘 방송 종료 전', receivedAt: '2026-11-11', status: '접수', reason: '', history: [] },
    { id: 'mission-2', title: '제한 시간 안에 레벨 완료', proposer: '초록', typeLabel: '미션 후원 · 10,000원', deadline: '30분', receivedAt: '2026-11-10', status: '접수', reason: '', history: [] },
  ];
}

function StatusPill({ status }: { status: MissionStatus }) {
  return <StatusBadge tone={status === '접수' ? 'warning' : status === '진행 중' || status === '완료' ? 'positive' : status === '실패' ? 'danger' : 'neutral'}>{status}</StatusBadge>;
}

function MissionDialog({ mission, onClose, onTransition }: {
  mission: Mission;
  onClose: () => void;
  onTransition: (status: MissionStatus, reason: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const [error, setError] = useState('');
  const available = transitions[mission.status] ?? [];

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  function dismiss() {
    dialog.current?.close();
    onClose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = available.find(status => status === form.get('status'));
    const reason = String(form.get('reason') ?? '').trim();
    if (!next) { setError('변경할 상태를 선택해 주세요.'); return; }
    if (next !== '진행 중' && !reason) {
      setError('상태 변경 사유를 입력해 주세요.');
      document.getElementById(reasonId)?.focus();
      return;
    }
    dialog.current?.close();
    onTransition(next, reason);
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={titleId}>미션 상세</h2>
      <button type="button" className="icon-button" aria-label="상세 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    <h3 className={styles.missionTitle}>{mission.title}</h3>
    <dl className={styles.info}>
      <div><dt>제안자</dt><dd>{mission.proposer}</dd></div>
      <div><dt>유형</dt><dd>{mission.typeLabel}</dd></div>
      <div><dt>기한</dt><dd>{mission.deadline}</dd></div>
      <div><dt>상태</dt><dd><StatusPill status={mission.status} /></dd></div>
      <div><dt>사유</dt><dd>{mission.reason || '—'}</dd></div>
    </dl>
    {mission.history.length > 0 && <section className={styles.history} aria-label="상태 변경 이력">
      <h3>변경 이력</h3>
      <ol>{mission.history.map((entry, index) => <li key={index}><strong>{entry.status}</strong>{entry.reason && <p>{entry.reason}</p>}</li>)}</ol>
    </section>}
    {available.length ? <form className={styles.editor} onSubmit={submit}>
      <label>변경할 상태<select className={ui.control} name="status" defaultValue={available[0]}>{available.map(status => <option key={status}>{status}</option>)}</select></label>
      <label htmlFor={reasonId}>사유</label>
      <textarea className={ui.control} id={reasonId} name="reason" rows={3} maxLength={500} aria-invalid={Boolean(error)} aria-describedby={error ? `${reasonId}-error` : undefined} onChange={() => setError('')} />
      {error && <p id={`${reasonId}-error`} className={styles.error} role="alert">{error}</p>}
      <div className={ui.dialogActions}>
        <button type="button" className={ui.button} onClick={dismiss}>닫기</button>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>상태 변경</button>
      </div>
    </form> : <div className={ui.dialogActions}><button type="button" className={ui.button} onClick={dismiss}>닫기</button></div>}
  </dialog>;
}

const initialFilters = { query: '', from: '', to: '' };

export function MissionsPage({ items, onChange }: { items: readonly Mission[]; onChange: (items: Mission[]) => void }) {
  const [params, setParams] = useSearchParams();
  const endInput = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState(initialFilters);
  const [sort, setSort] = useState('recent');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = tabs.find(tab => tab.id === params.get('tab')) ?? tabs[0];
  const source = params.get('state') === 'empty' ? [] : items.filter(item => item.status === active.label);
  const rows = source.filter(item => `${item.title} ${item.proposer} ${item.typeLabel}`.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(filters.query) &&
    (!filters.from || item.receivedAt >= filters.from) && (!filters.to || item.receivedAt <= filters.to));
  rows.sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'ko')
    : sort === 'oldest' ? a.receivedAt.localeCompare(b.receivedAt) : b.receivedAt.localeCompare(a.receivedAt));
  const selected = items.find(item => item.id === selectedId);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get('from') ?? '');
    const to = String(form.get('to') ?? '');
    if (from && to && from > to) { setError('종료일은 시작일과 같거나 이후여야 해요.'); endInput.current?.focus(); return; }
    setFilters({ query: String(form.get('query') ?? '').normalize('NFKC').trim().toLocaleLowerCase('ko-KR'), from, to });
    setError('');
  }

  function transition(status: MissionStatus, reason: string) {
    if (!selected || !transitions[selected.status]?.includes(status)) return;
    onChange(items.map(item => item.id === selected.id ? { ...item, status, reason, history: [...item.history, { status, reason }] } : item));
    setSelectedId(null);
    const next = new URLSearchParams(params);
    const tab = tabs.find(tab => tab.label === status)!;
    next.set('tab', tab.id);
    setParams(next, { replace: true });
    setNotice(`‘${selected.title}’ 미션을 ${status} 상태로 변경했어요.`);
    requestAnimationFrame(() => document.getElementById(`mission-tab-${tab.id}`)?.focus());
  }

  return <ManagementPage title="미션 관리" titleId="missions-title">
    <nav className={ui.tabs} aria-label="미션 상태">
      {tabs.map(tab => {
        const next = new URLSearchParams(params);
        next.set('tab', tab.id);
        return <Link key={tab.id} id={`mission-tab-${tab.id}`} to={{ search: next.toString() }} aria-current={active.id === tab.id ? 'page' : undefined} onClick={() => setNotice('')}>{tab.label}</Link>;
      })}
    </nav>
    <form className={styles.filters} role="search" aria-label="미션 검색" onSubmit={search} onReset={() => {
      setFilters(initialFilters); setSort('recent'); setError('');
    }}>
      <input className={ui.control} type="search" name="query" aria-label="미션 또는 제안자 검색" placeholder="미션 또는 제안자 검색" maxLength={120} />
      <label className={styles.dateField}>시작일<input className={ui.control} type="date" name="from" /></label>
      <label className={styles.dateField}>종료일<input ref={endInput} className={ui.control} aria-invalid={Boolean(error)} aria-describedby={error ? 'missions-range-error' : undefined} type="date" name="to" /></label>
      <div className={styles.filterActions}>
        <button className={`${ui.button} ${ui.primary}`} type="submit">검색</button>
        <button className={ui.button} type="reset">초기화</button>
      </div>
    </form>
    <label className={`${ui.filterField} ${styles.sortField}`}>정렬<select className={ui.control} aria-label="미션 정렬" value={sort} onChange={event => setSort(event.currentTarget.value)}>
      <option value="recent">최신순</option><option value="oldest">오래된 순</option><option value="name">이름순</option>
    </select></label>
    {error && <p id="missions-range-error" className={styles.error} role="alert">{error}</p>}
    {rows.length ? <div className={ui.tableFrame}>
      <table className={ui.table} role="table" aria-label="미션 목록">
        <thead role="rowgroup"><tr role="row">{['미션', '제안자', '유형', '기한', '관리'].map(label => <th data-align={label === '금액' || label === '포인트' || label === '관리' ? 'end' : undefined} key={label} scope="col" role="columnheader">{label}</th>)}</tr></thead>
        <tbody role="rowgroup">{rows.map(item => <tr key={item.id} role="row">
          <th scope="row" role="rowheader" data-label="미션" data-primary="true">{item.title}</th>
          <td role="cell" data-label="제안자">{item.proposer}</td>
          <td role="cell" data-label="유형">{item.typeLabel}</td>
          <td role="cell" data-label="기한">{item.deadline}</td>
          <td role="cell" data-align="end"><button type="button" className={ui.button} aria-haspopup="dialog" aria-label={`${item.title} 상세`} onClick={() => setSelectedId(item.id)}>상세</button></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={<Target size={24} />} title={source.length ? '조건에 맞는 미션이 없어요' : '등록된 미션이 없어요'} />}
    <p className={styles.notice} role="status">{notice || `${rows.length}개`}</p>
    {selected && <MissionDialog key={selected.id} mission={selected} onClose={() => setSelectedId(null)} onTransition={transition} />}
  </ManagementPage>;
}
