import { ManagementPage, StatusBadge, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { ReceiptText, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import styles from './RevenuePage.module.css';

const examples = [
  { kind: '메시지 후원', amount: 5000 },
  { kind: '음성 후원', amount: 1000 },
  { kind: '영상 후원', amount: 10000 },
  { kind: '멤버십', amount: 4900 },
  { kind: '미션 후원', amount: 2000 },
];

const transactions = Array.from({ length: 26 }, (_, index) => ({
  ...examples[index % examples.length],
  id: `txn-${index + 1}`,
  date: new Date(Date.UTC(2026, 10, 2 - index)).toISOString().slice(0, 10),
  user: `사용자 ${String(index + 1).padStart(3, '0')}`,
  status: index % 8 === 0 ? '환불 완료' : '결제 완료',
} as const));

const payouts = [
  { id: 'payout-1', date: '2026-11-10', amount: 128400, status: '지급 예정' },
  { id: 'payout-2', date: '2026-10-10', amount: 94600, status: '지급 완료' },
  { id: 'payout-3', date: '2026-09-10', amount: 24000, status: '지급 실패', reason: '지급 계좌 확인 필요' },
] as const;

const statusTone = {
  '결제 완료': 'positive', '환불 완료': 'neutral', '미등록': 'neutral', '검토 중': 'warning',
  '지급 예정': 'warning', '지급 완료': 'positive', '지급 실패': 'danger',
} as const;

type Status = keyof typeof statusTone;
type DetailItem = readonly [label: string, value: ReactNode];
type Detail = { title: string; items: readonly DetailItem[] };

const won = new Intl.NumberFormat('ko-KR');
const money = (amount: number) => `${won.format(amount)}원`;
const dateLabel = (date: string) => date.replaceAll('-', '.');

function StatusPill({ status }: { status: Status }) {
  return <StatusBadge tone={statusTone[status]}>{status}</StatusBadge>;
}

function InfoList({ items, inDialog = false }: { items: readonly DetailItem[]; inDialog?: boolean }) {
  return <dl className={`${styles.info} ${inDialog ? styles.dialogInfo : ''}`}>
    {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function EmptyHistory({ filtered = false }: { filtered?: boolean }) {
  return <EmptyState icon={<ReceiptText size={24} />} title={filtered ? '조건에 맞는 내역이 없어요' : '아직 내역이 없어요'} />;
}

const dateFilters = { query: '', from: '', to: '' };
const initialChoices = { status: '', kind: '', sort: 'recent' };
const pageSize = 20;
const choiceFields = [
  { key: 'status', label: '결제 상태', options: [['', '전체 상태'], ['결제 완료', '결제 완료'], ['환불 완료', '환불 완료']] },
  { key: 'kind', label: '수익 구분', options: [['', '전체 구분'], ...examples.map(({ kind }) => [kind, kind])] },
  { key: 'sort', label: '내역 정렬', options: [['recent', '최신순'], ['oldest', '오래된 순'], ['amount', '금액순']] },
] as const;

function RevenueHistory({ onDetail }: { onDetail: (detail: Detail) => void }) {
  const [filters, setFilters] = useState(dateFilters);
  const [choices, setChoices] = useState(initialChoices);
  const [error, setError] = useState('');
  const endInput = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(0);
  const rows = transactions.filter(row => (
    `${row.user} ${row.kind} ${row.id}`.toLocaleLowerCase('ko-KR').includes(filters.query) &&
    (!filters.from || row.date >= filters.from) && (!filters.to || row.date <= filters.to) &&
    (!choices.status || row.status === choices.status) && (!choices.kind || row.kind === choices.kind)
  ));
  if (choices.sort === 'amount') rows.sort((a, b) => b.amount - a.amount);
  else if (choices.sort === 'oldest') rows.reverse();
  const pages = Math.ceil(rows.length / pageSize);
  const offset = page * pageSize;

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get('from') ?? '');
    const to = String(form.get('to') ?? '');
    if (from && to && from > to) {
      setError('종료일은 시작일과 같거나 이후여야 해요.');
      endInput.current?.focus();
      return;
    }
    setFilters({ query: String(form.get('query') ?? '').trim().toLocaleLowerCase('ko-KR'), from, to });
    setPage(0);
    setError('');
  }

  return <section aria-label="수익 내역">
    <form className={styles.filters} role="search" aria-label="수익 내역 검색" onSubmit={search} onReset={() => {
      setFilters(dateFilters);
      setChoices(initialChoices);
      setPage(0);
      setError('');
    }}>
      <input className={ui.control} type="search" name="query" aria-label="이름 또는 내역 검색" placeholder="이름 또는 내역 검색" maxLength={100} />
      <label className={styles.dateField}>시작일<input className={ui.control} type="date" name="from" onChange={() => setError('')} /></label>
      <label className={styles.dateField}>종료일<input ref={endInput} className={ui.control} type="date" name="to" aria-invalid={Boolean(error)} aria-describedby={error ? 'revenue-range-error' : undefined} onChange={() => setError('')} /></label>
      <div className={styles.filterActions}>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button>
        <button type="reset" className={ui.button}>초기화</button>
      </div>
    </form>
    <div className={styles.choices}>
      {choiceFields.map(({ key, label, options }) => (
        <label key={key} className={ui.filterField}>{label}<select className={ui.control} aria-label={label} value={choices[key]} onChange={event => {
          setChoices(current => ({ ...current, [key]: event.target.value }));
          setPage(0);
        }}>
          {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select></label>
      ))}
    </div>
    {error && <p id="revenue-range-error" className={styles.error} role="alert">{error}</p>}
    {rows.length ? <>
      <div className={ui.tableFrame}>
        <table className={ui.table} role="table" aria-label="수익 내역 목록">
          <thead role="rowgroup"><tr role="row">
            {['일시', '구분', '이용자', '금액', '상태', '관리'].map(label => <th data-align={label === '금액' || label === '포인트' || label === '관리' ? 'end' : undefined} key={label} role="columnheader" scope="col">{label}</th>)}
          </tr></thead>
          <tbody role="rowgroup">
            {rows.slice(offset, offset + pageSize).map(row => <tr key={row.id} role="row">
              <td role="cell" data-label="일시"><time dateTime={row.date}>{dateLabel(row.date)}</time></td>
              <td role="cell" data-label="구분">{row.kind}</td>
              <td role="cell" data-label="이용자">{row.user}</td>
              <td role="cell" data-label="금액" data-align="end" className={styles.amount}>{money(row.amount)}</td>
              <td role="cell" data-label="상태"><StatusPill status={row.status} /></td>
              <td role="cell" data-align="end"><button type="button" className={ui.button} aria-label={`${row.user} ${row.kind} 상세`} aria-haspopup="dialog" onClick={() => onDetail({
                title: '결제 상세', items: [
                  ['거래 번호', row.id], ['결제일', dateLabel(row.date)], ['내용', row.kind],
                  ['이용자', row.user], ['금액', money(row.amount)], ['상태', <StatusPill status={row.status} />],
                ],
              })}>상세</button></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <div className={styles.pagination}>
        <span role="status">{rows.length}개 · {page + 1} / {pages}</span>
        {pages > 1 && <div>
          <button type="button" className={ui.button} disabled={page === 0} onClick={() => setPage(page - 1)}>이전</button>
          <button type="button" className={ui.button} disabled={page + 1 === pages} onClick={() => setPage(page + 1)}>다음</button>
        </div>}
      </div>
    </> : <EmptyHistory filtered />}
  </section>;
}

function Settlement({ pending, onDetail }: { pending: boolean; onDetail: (detail: Detail) => void }) {
  return <>
    <section className={styles.settlement} aria-labelledby="settlement-info-title">
      <h2 id="settlement-info-title">정산 정보</h2>
      <InfoList items={[
        ['유형', '개인'],
        ['등록 상태', <StatusPill status={pending ? '검토 중' : '미등록'} />],
      ]} />
      {pending && <p>제출한 정산 정보를 확인하고 있어요.</p>}
    </section>
    <section className={styles.settlement} aria-labelledby="payout-title">
      <h2 id="payout-title">정산 내역</h2>
      <ul className={styles.payouts}>
        {payouts.map(row => (
          <li key={row.id}>
            <time dateTime={row.date}>{dateLabel(row.date)}</time>
            <strong className={styles.amount}>{money(row.amount)}</strong>
            <span><StatusPill status={row.status} /></span>
            <button type="button" className={ui.button} aria-label={`${dateLabel(row.date)} 정산 상세`} aria-haspopup="dialog" onClick={() => onDetail({
              title: '정산 상세', items: [
                ['정산 번호', row.id], ['지급일', dateLabel(row.date)], ['금액', money(row.amount)],
                ['상태', <StatusPill status={row.status} />], ...('reason' in row ? [['사유', row.reason] as const] : []),
              ],
            })}>상세</button>
          </li>
        ))}
      </ul>
    </section>
  </>;
}

const tabs = [{ id: 'income', label: '수익 내역' }, { id: 'settlement', label: '정산' }] as const;

export function RevenuePage() {
  const [params] = useSearchParams();
  const [detail, setDetail] = useState<Detail | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  const pending = params.get('state') === 'pending';
  const tab = tabs.find(item => item.id === params.get('tab'))?.id ?? (pending ? 'settlement' : 'income');

  useEffect(() => {
    const element = dialog.current;
    if (detail && element && !element.open) element.showModal();
  }, [detail]);

  return <ManagementPage title="수익·정산" titleId="revenue-title">
    <nav className={ui.tabs} aria-label="수익 관리 메뉴">
      {tabs.map(item => {
        const next = new URLSearchParams(params);
        next.set('tab', item.id);
        return <Link key={item.id} to={{ search: next.toString() }} aria-current={tab === item.id ? 'page' : undefined}>{item.label}</Link>;
      })}
    </nav>
    {tab === 'settlement' ? <Settlement pending={pending} onDetail={setDetail} />
      : params.get('state') === 'empty' ? <EmptyHistory /> : <RevenueHistory onDetail={setDetail} />}
    {detail && <dialog ref={dialog} className={ui.dialog} aria-labelledby={dialogTitle} onClose={() => setDetail(null)}>
      <header className={ui.dialogHeader}>
        <h2 id={dialogTitle}>{detail.title}</h2>
        <button type="button" className="icon-button" aria-label="상세 닫기" onClick={() => dialog.current?.close()}><X size={20} aria-hidden="true" /></button>
      </header>
      <InfoList items={detail.items} inDialog />
      <form method="dialog" className={ui.dialogActions}><button className={ui.button} type="submit">닫기</button></form>
    </dialog>}
  </ManagementPage>;
}
