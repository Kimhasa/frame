import { ManagementPage, StatusBadge, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { UsersRound, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import styles from './MembersPage.module.css';

const statusTone = {
  '이용 중': 'positive', '가입 확인 대기': 'warning', '갱신 예정': 'positive',
  '해지 예약': 'warning', '만료': 'neutral', '갱신 실패': 'danger',
} as const;

type Member = {
  id: string;
  name: string;
  joinedAt: string;
  status: keyof typeof statusTone;
  nextPayment: string;
  endsAt: string;
};

const members: readonly Member[] = [
  { id: 'member-1', name: '모아', joinedAt: '2026-11-11', status: '이용 중', nextPayment: '2026.12.11', endsAt: '2026.12.10' },
  { id: 'member-2', name: '파도', joinedAt: '2026-11-10', status: '가입 확인 대기', nextPayment: '결제 확인 후 안내', endsAt: '결제 확인 후 안내' },
  { id: 'member-3', name: '산책', joinedAt: '2026-11-08', status: '갱신 예정', nextPayment: '2026.12.08', endsAt: '2026.12.07' },
  { id: 'member-4', name: '초록', joinedAt: '2026-11-05', status: '해지 예약', nextPayment: '자동 결제 없음', endsAt: '2026.12.04' },
  { id: 'member-5', name: '햇살', joinedAt: '2026-11-02', status: '이용 중', nextPayment: '2026.12.02', endsAt: '2026.12.01' },
  { id: 'member-6', name: '달빛', joinedAt: '2026-10-31', status: '이용 중', nextPayment: '2026.11.30', endsAt: '2026.11.29' },
  { id: 'member-7', name: '서재', joinedAt: '2026-10-10', status: '갱신 실패', nextPayment: '결제 확인 후 안내', endsAt: '2026.11.09' },
  { id: 'member-8', name: '새벽', joinedAt: '2026-10-05', status: '만료', nextPayment: '자동 결제 없음', endsAt: '2026.11.04' },
];

const initialBenefits = '멤버십 배지\n전용 이모티콘\n멤버십 방송';
const benefitsKey = 'frame.design-membership-benefits.v1';
const initialFilters = { query: '', from: '', to: '' };
const dateLabel = (date: string) => date.replaceAll('-', '.');
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ko-KR').trim();

function readBenefits() {
  try {
    const stored = sessionStorage.getItem(benefitsKey);
    if (stored?.trim()) return stored.slice(0, 500);
  } catch { /* Keep the preview usable without browser storage. */ }
  return initialBenefits;
}

function StatusPill({ status }: { status: Member['status'] }) {
  return <StatusBadge tone={statusTone[status]}>{status}</StatusBadge>;
}

type DialogView = { kind: 'member'; member: Member } | { kind: 'benefits' };

export function MembersPage() {
  const [params] = useSearchParams();
  const [filters, setFilters] = useState(initialFilters);
  const [status, setStatus] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);
  const [benefits, setBenefits] = useState(readBenefits);
  const [view, setView] = useState<DialogView | null>(null);
  const [filterError, setFilterError] = useState('');
  const [benefitsError, setBenefitsError] = useState('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const endInput = useRef<HTMLInputElement>(null);
  const dialogTitle = useId();
  const benefitInputId = useId();
  const source = params.get('state') === 'empty' ? [] : members;
  const rows = source.filter(member => (
    normalize(member.name).includes(filters.query) && (!status || member.status === status) &&
    (!filters.from || member.joinedAt >= filters.from) && (!filters.to || member.joinedAt <= filters.to)
  ));
  if (oldestFirst) rows.reverse();

  useEffect(() => {
    const element = dialog.current;
    if (view && element && !element.open) element.showModal();
  }, [view]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get('from') ?? '');
    const to = String(form.get('to') ?? '');
    if (from && to && from > to) {
      setFilterError('종료일은 시작일과 같거나 이후여야 해요.');
      endInput.current?.focus();
      return;
    }
    setFilters({ query: normalize(String(form.get('query') ?? '')), from, to });
    setFilterError('');
  }

  function saveBenefits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('benefits') ?? '').trim();
    if (!text) {
      setBenefitsError('멤버십 혜택을 입력해 주세요.');
      return;
    }
    setBenefits(text);
    try { sessionStorage.setItem(benefitsKey, text); }
    catch { /* Keep the edited benefits for this visit. */ }
    setNotice('멤버십 혜택을 저장했어요.');
    dialog.current?.close();
  }

  return <ManagementPage title="멤버십 관리" titleId="members-title">
    {source.length > 0 && <>
      <form className={styles.filters} role="search" aria-label="가입자 검색" onSubmit={search} onReset={() => {
        setFilters(initialFilters);
        setStatus('');
        setOldestFirst(false);
        setFilterError('');
      }}>
        <input className={ui.control} type="search" name="query" aria-label="닉네임 검색" placeholder="닉네임 검색" maxLength={100} />
        <label className={styles.dateField}>시작일<input className={ui.control} type="date" name="from" onChange={() => setFilterError('')} /></label>
        <label className={styles.dateField}>종료일<input ref={endInput} className={ui.control} type="date" name="to" aria-invalid={Boolean(filterError)} aria-describedby={filterError ? 'members-range-error' : undefined} onChange={() => setFilterError('')} /></label>
        <div className={styles.filterActions}>
          <button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button>
          <button type="reset" className={ui.button}>초기화</button>
        </div>
      </form>
      <div className={styles.choices}>
        <label className={ui.filterField}>가입 상태<select className={ui.control} aria-label="가입 상태" value={status} onChange={event => setStatus(event.currentTarget.value)}>
          <option value="">전체 상태</option>
          {Object.keys(statusTone).map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label className={ui.filterField}>정렬<select className={ui.control} aria-label="가입자 정렬" value={oldestFirst ? 'oldest' : 'recent'} onChange={event => setOldestFirst(event.currentTarget.value === 'oldest')}>
          <option value="recent">최신순</option><option value="oldest">오래된 순</option>
        </select></label>
      </div>
    </>}
    {filterError && <p id="members-range-error" className={styles.error} role="alert">{filterError}</p>}
    {rows.length ? <>
      <div className={ui.tableFrame}>
        <table className={ui.table} role="table" aria-label="멤버십 가입자 목록">
          <thead role="rowgroup"><tr role="row">{['가입일', '닉네임', '가입 상태', '기간', '관리'].map(label => <th data-align={label === '금액' || label === '포인트' || label === '관리' ? 'end' : undefined} key={label} role="columnheader" scope="col">{label}</th>)}</tr></thead>
          <tbody role="rowgroup">{rows.map(member => <tr key={member.id} role="row">
            <td role="cell" data-label="가입일"><time dateTime={member.joinedAt}>{dateLabel(member.joinedAt)}</time></td>
            <th role="rowheader" scope="row" data-label="닉네임">{member.name}</th>
            <td role="cell" data-label="가입 상태"><StatusPill status={member.status} /></td>
            <td role="cell" data-label="기간">{member.endsAt}</td>
            <td role="cell" data-align="end"><button type="button" className={ui.button} aria-label={`${member.name} 멤버십 상세`} aria-haspopup="dialog" onClick={() => setView({ kind: 'member', member })}>상세</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className={styles.count} role="status">{rows.length}명</p>
    </> : <EmptyState icon={<UsersRound size={24} />} title={source.length ? '조건에 맞는 가입자가 없어요' : '가입한 멤버가 없어요'} />}
    <section className={styles.benefits} aria-labelledby="benefits-title">
      <h2 id="benefits-title">멤버십 혜택</h2>
      <p>{benefits}</p>
      <button type="button" className={ui.button} aria-haspopup="dialog" onClick={() => {
        setBenefitsError('');
        setNotice('');
        setView({ kind: 'benefits' });
      }}>혜택 수정</button>
      <p className={styles.notice} role="status">{notice}</p>
    </section>
    {view && <dialog className={ui.dialog} ref={dialog} aria-labelledby={dialogTitle} onClose={() => setView(null)}>
      <header className={ui.dialogHeader}>
        <h2 id={dialogTitle}>{view.kind === 'member' ? '멤버십 상세' : '멤버십 혜택 수정'}</h2>
        <button type="button" className="icon-button" aria-label="상세 닫기" onClick={() => dialog.current?.close()}><X size={20} aria-hidden="true" /></button>
      </header>
      {view.kind === 'member' ? <>
        <dl className={styles.info}>
          <div><dt>닉네임</dt><dd>{view.member.name}</dd></div>
          <div><dt>상태</dt><dd><StatusPill status={view.member.status} /></dd></div>
          <div><dt>다음 결제일</dt><dd>{view.member.nextPayment}</dd></div>
          <div><dt>이용 종료일</dt><dd>{view.member.endsAt}</dd></div>
        </dl>
        <form method="dialog" className={ui.dialogActions}><button className={ui.button} type="submit">닫기</button></form>
      </> : <form className={styles.editor} onSubmit={saveBenefits}>
        <label htmlFor={benefitInputId}>혜택</label>
        <textarea className={ui.control} id={benefitInputId} name="benefits" rows={6} maxLength={500} defaultValue={benefits} placeholder="혜택을 한 줄에 하나씩 입력" required autoFocus
          aria-invalid={Boolean(benefitsError)} aria-describedby={benefitsError ? `${benefitInputId}-error` : undefined} onChange={() => setBenefitsError('')} />
        {benefitsError && <p id={`${benefitInputId}-error`} className={styles.error} role="alert">{benefitsError}</p>}
        <div className={ui.dialogActions}>
          <button className={ui.button} type="button" onClick={() => dialog.current?.close()}>취소</button>
          <button className={`${ui.button} ${ui.primary}`} type="submit">저장</button>
        </div>
      </form>}
    </dialog>}
  </ManagementPage>;
}
