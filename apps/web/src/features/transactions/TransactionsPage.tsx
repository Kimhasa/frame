import { ManagementPage, StatusBadge, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { ReceiptText } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { TransactionDialog } from './TransactionDialog';
import { money, transactionDay, transactionStatus } from './transactions-preview';
import type { PreviewTransaction } from './transactions-preview';
import styles from './TransactionsPage.module.css';

const initialFilters = { query: '', from: '', to: '' };
const initialChoices = { status: '', kind: '', sort: 'recent' };
const pageSize = 20;
const statuses = ['결제 완료', '결제 확인 대기', '환불 완료', '신청 취소', '환불 요청 접수', '환불 검토 중', '환불 요청 거절', '환불 요청 취소'];
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');

function StatusPill({ status }: { status: string }) {
  const tone = status === '결제 완료' ? 'positive' : ['결제 확인 대기', '환불 요청 접수', '환불 검토 중'].includes(status) ? 'warning' : status === '환불 요청 거절' ? 'danger' : 'neutral';
  return <StatusBadge tone={tone}>{status}</StatusBadge>;
}

export function TransactionsPage({ items }: { items: PreviewTransaction[] }) {
  const [params] = useSearchParams();
  const [filters, setFilters] = useState(initialFilters);
  const [draft, setDraft] = useState(initialFilters);
  const [choices, setChoices] = useState(initialChoices);
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dateEnd = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const source = params.get('state') === 'empty' ? [] : items;
  const kinds = [...new Set(items.map(item => item.kind))];
  const filtered = Boolean(filters.query || filters.from || filters.to || choices.status || choices.kind);
  const selected = items.find(item => item.id === selectedId);
  const rows = source.filter(item => {
    const status = transactionStatus(item);
    const matchesQuery = normalize([item.id, item.channel, item.kind, status, item.refund?.reason ?? ''].join(' ')).includes(filters.query);
    const date = transactionDay(item.createdAt);
    return matchesQuery && (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to) &&
      (!choices.status || status === choices.status) && (!choices.kind || item.kind === choices.kind);
  }).sort((a, b) => choices.sort === 'amount' ? b.amount - a.amount || Date.parse(b.createdAt) - Date.parse(a.createdAt)
    : choices.sort === 'oldest' ? Date.parse(a.createdAt) - Date.parse(b.createdAt) : Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const section = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      setError('종료일은 시작일과 같거나 이후여야 해요.');
      dateEnd.current?.focus();
      return;
    }
    setFilters({ ...draft, query: normalize(draft.query) });
    setPage(0);
    setError('');
  }

  function dismiss() {
    setSelectedId(null);
    requestAnimationFrame(() => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
      else heading.current?.focus({ preventScroll: true });
    });
  }

  return <ManagementPage title="결제 내역" titleId="transactions-title" titleRef={heading}>
    <form className={styles.filters} role="search" aria-label="결제 내역 검색" noValidate onSubmit={search} onReset={() => {
      setFilters(initialFilters); setDraft(initialFilters); setChoices(initialChoices); setPage(0); setError(''); setNotice('');
    }}>
      <input className={ui.control} type="search" name="query" aria-label="이름 또는 내역 검색" placeholder="이름 또는 내역 검색" maxLength={100} value={draft.query}
        onChange={event => setDraft({ ...draft, query: event.target.value })} />
      <label className={styles.dateField}>시작일<input className={ui.control} type="date" name="from" value={draft.from} onChange={event => { setDraft({ ...draft, from: event.target.value }); setError(''); }} /></label>
      <label className={styles.dateField}>종료일<input className={ui.control} ref={dateEnd} type="date" name="to" value={draft.to} aria-invalid={Boolean(error)} aria-describedby={error ? 'transactions-range-error' : undefined}
        onChange={event => { setDraft({ ...draft, to: event.target.value }); setError(''); }} /></label>
      <div className={styles.filterActions}><button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button><button type="reset" className={ui.button}>초기화</button></div>
    </form>
    <div className={styles.choices}>
      <label className={ui.filterField}>상태<select className={ui.control} aria-label="결제 및 환불 상태" value={choices.status} onChange={event => { setChoices({ ...choices, status: event.target.value }); setPage(0); }}>
        <option value="">전체 상태</option>{statuses.map(status => <option key={status}>{status}</option>)}
      </select></label>
      <label className={ui.filterField}>구분<select className={ui.control} aria-label="결제 구분" value={choices.kind} onChange={event => { setChoices({ ...choices, kind: event.target.value }); setPage(0); }}>
        <option value="">전체 구분</option>{kinds.map(kind => <option key={kind}>{kind}</option>)}
      </select></label>
      <label className={ui.filterField}>정렬<select className={ui.control} aria-label="내역 정렬" value={choices.sort} onChange={event => { setChoices({ ...choices, sort: event.target.value }); setPage(0); }}>
        <option value="recent">최신순</option><option value="oldest">오래된순</option><option value="amount">금액순</option>
      </select></label>
    </div>
    {error && <p className={styles.error} id="transactions-range-error" role="alert">{error}</p>}
    {section.length ? <>
      <div className={ui.tableFrame}><table className={ui.table} role="table" aria-label="결제 내역 목록">
        <thead role="rowgroup"><tr role="row">{['결제일', '내용', '금액', '상태', '관리'].map(label => <th data-align={label === '금액' || label === '포인트' || label === '관리' ? 'end' : undefined} key={label} role="columnheader" scope="col">{label}</th>)}</tr></thead>
        <tbody role="rowgroup">{section.map(item => <tr key={item.id} role="row">
          <td role="cell" data-label="결제일"><time dateTime={item.createdAt}>{transactionDay(item.createdAt).replaceAll('-', '.')}</time></td>
          <td role="cell" data-label="내용"><div className={styles.description}><strong>{item.kind}</strong><span>{item.channel}</span></div></td>
          <td role="cell" data-label="금액" data-align="end" className={styles.amount}>{money(item.amount)}</td>
          <td role="cell" data-label="상태"><StatusPill status={transactionStatus(item)} /></td>
          <td role="cell" data-align="end"><button type="button" className={ui.button} aria-haspopup="dialog" aria-label={`${item.id} ${item.kind} 상세`} onClick={event => {
            returnFocus.current = event.currentTarget; setSelectedId(item.id); setNotice('');
          }}>상세</button></td>
        </tr>)}</tbody>
      </table></div>
      <nav className={styles.pagination} aria-label="결제 내역 페이지"><span role="status">{rows.length}개 · {currentPage + 1} / {pages}</span>
        {pages > 1 && <div><button type="button" className={ui.button} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</button>
          <button type="button" className={ui.button} disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>다음</button></div>}
      </nav>
    </> : <EmptyState icon={<ReceiptText size={24} />} title={filtered ? '조건에 맞는 내역이 없어요' : '아직 결제 내역이 없어요'} />}
    <p className={styles.notice} role="status">{notice}</p>
    {selected && <TransactionDialog transaction={selected} onDismiss={dismiss} />}
  </ManagementPage>;
}
