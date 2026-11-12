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

const transactions = [
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261111-0001",
    "date": "2026-11-11",
    "user": "밤의서재",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 3000,
    "id": "FR-20261111-0002",
    "date": "2026-11-11",
    "user": "푸른노트",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 2000,
    "id": "FR-20261111-0003",
    "date": "2026-11-11",
    "user": "브라운노트",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 1000,
    "id": "FR-20261110-0004",
    "date": "2026-11-10",
    "user": "별헤는밤",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261110-0005",
    "date": "2026-11-10",
    "user": "회색고양이",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261110-0006",
    "date": "2026-11-10",
    "user": "한줄기록",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261109-0007",
    "date": "2026-11-09",
    "user": "루프",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 5000,
    "id": "FR-20261109-0008",
    "date": "2026-11-09",
    "user": "느린걸음",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261109-0009",
    "date": "2026-11-09",
    "user": "모카포트",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 5000,
    "id": "FR-20261108-0010",
    "date": "2026-11-08",
    "user": "회색고양이",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261108-0011",
    "date": "2026-11-08",
    "user": "한줄기록",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261108-0012",
    "date": "2026-11-08",
    "user": "루프",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261107-0013",
    "date": "2026-11-07",
    "user": "느린걸음",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261107-0014",
    "date": "2026-11-07",
    "user": "모카포트",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 3000,
    "id": "FR-20261107-0015",
    "date": "2026-11-07",
    "user": "비밀정원",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 20000,
    "id": "FR-20261106-0016",
    "date": "2026-11-06",
    "user": "차분한호수",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261106-0017",
    "date": "2026-11-06",
    "user": "작은여백",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 30000,
    "id": "FR-20261106-0018",
    "date": "2026-11-06",
    "user": "민트라떼",
    "status": "환불 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 2000,
    "id": "FR-20261105-0019",
    "date": "2026-11-05",
    "user": "모카포트",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261105-0020",
    "date": "2026-11-05",
    "user": "비밀정원",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261105-0021",
    "date": "2026-11-05",
    "user": "차분한호수",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261104-0022",
    "date": "2026-11-04",
    "user": "작은여백",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 1000,
    "id": "FR-20261104-0023",
    "date": "2026-11-04",
    "user": "민트라떼",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 5000,
    "id": "FR-20261104-0024",
    "date": "2026-11-04",
    "user": "구름조각",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 3000,
    "id": "FR-20261103-0025",
    "date": "2026-11-03",
    "user": "매일조금씩",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 5000,
    "id": "FR-20261103-0026",
    "date": "2026-11-03",
    "user": "오렌지빛",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261103-0027",
    "date": "2026-11-03",
    "user": "오후네시",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261102-0028",
    "date": "2026-11-02",
    "user": "민트라떼",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 1000,
    "id": "FR-20261102-0029",
    "date": "2026-11-02",
    "user": "구름조각",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261102-0030",
    "date": "2026-11-02",
    "user": "매일조금씩",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 30000,
    "id": "FR-20261101-0031",
    "date": "2026-11-01",
    "user": "오렌지빛",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 20000,
    "id": "FR-20261101-0032",
    "date": "2026-11-01",
    "user": "오후네시",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261101-0033",
    "date": "2026-11-01",
    "user": "작은항해",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 3000,
    "id": "FR-20261031-0034",
    "date": "2026-10-31",
    "user": "포근한밤",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 2000,
    "id": "FR-20261031-0035",
    "date": "2026-10-31",
    "user": "가을편지",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 1000,
    "id": "FR-20261031-0036",
    "date": "2026-10-31",
    "user": "에버그린",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261030-0037",
    "date": "2026-10-30",
    "user": "오후네시",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261030-0038",
    "date": "2026-10-30",
    "user": "작은항해",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261030-0039",
    "date": "2026-10-30",
    "user": "포근한밤",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 5000,
    "id": "FR-20261029-0040",
    "date": "2026-10-29",
    "user": "가을편지",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261029-0041",
    "date": "2026-10-29",
    "user": "에버그린",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 5000,
    "id": "FR-20261029-0042",
    "date": "2026-10-29",
    "user": "별빛산책",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261028-0043",
    "date": "2026-10-28",
    "user": "소금빵",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261028-0044",
    "date": "2026-10-28",
    "user": "빈페이지",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261028-0045",
    "date": "2026-10-28",
    "user": "달의모서리",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261027-0046",
    "date": "2026-10-27",
    "user": "에버그린",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 3000,
    "id": "FR-20261027-0047",
    "date": "2026-10-27",
    "user": "별빛산책",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 20000,
    "id": "FR-20261027-0048",
    "date": "2026-10-27",
    "user": "소금빵",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261026-0049",
    "date": "2026-10-26",
    "user": "빈페이지",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 30000,
    "id": "FR-20261026-0050",
    "date": "2026-10-26",
    "user": "달의모서리",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 2000,
    "id": "FR-20261026-0051",
    "date": "2026-10-26",
    "user": "잠깐산책",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261025-0052",
    "date": "2026-10-25",
    "user": "코드한잔",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261025-0053",
    "date": "2026-10-25",
    "user": "달무리",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261025-0054",
    "date": "2026-10-25",
    "user": "파란책갈피",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 1000,
    "id": "FR-20261024-0055",
    "date": "2026-10-24",
    "user": "달의모서리",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 5000,
    "id": "FR-20261024-0056",
    "date": "2026-10-24",
    "user": "잠깐산책",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 3000,
    "id": "FR-20261024-0057",
    "date": "2026-10-24",
    "user": "코드한잔",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 5000,
    "id": "FR-20261023-0058",
    "date": "2026-10-23",
    "user": "달무리",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261023-0059",
    "date": "2026-10-23",
    "user": "파란책갈피",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261023-0060",
    "date": "2026-10-23",
    "user": "두부식빵",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 1000,
    "id": "FR-20261022-0061",
    "date": "2026-10-22",
    "user": "종이비행기",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261022-0062",
    "date": "2026-10-22",
    "user": "초록물결",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 30000,
    "id": "FR-20261022-0063",
    "date": "2026-10-22",
    "user": "모닝커피",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 20000,
    "id": "FR-20261021-0064",
    "date": "2026-10-21",
    "user": "파란책갈피",
    "status": "환불 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261021-0065",
    "date": "2026-10-21",
    "user": "두부식빵",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 3000,
    "id": "FR-20261021-0066",
    "date": "2026-10-21",
    "user": "종이비행기",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 2000,
    "id": "FR-20261020-0067",
    "date": "2026-10-20",
    "user": "초록물결",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 1000,
    "id": "FR-20261020-0068",
    "date": "2026-10-20",
    "user": "모닝커피",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261020-0069",
    "date": "2026-10-20",
    "user": "해질녘",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261019-0070",
    "date": "2026-10-19",
    "user": "라임소다",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261019-0071",
    "date": "2026-10-19",
    "user": "낮은목소리",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 5000,
    "id": "FR-20261019-0072",
    "date": "2026-10-19",
    "user": "밤의서재",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261018-0073",
    "date": "2026-10-18",
    "user": "모닝커피",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 5000,
    "id": "FR-20261018-0074",
    "date": "2026-10-18",
    "user": "해질녘",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261018-0075",
    "date": "2026-10-18",
    "user": "라임소다",
    "status": "결제 완료"
  },
  {
    "kind": "멤버십",
    "amount": 4900,
    "id": "FR-20261017-0076",
    "date": "2026-10-17",
    "user": "낮은목소리",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261017-0077",
    "date": "2026-10-17",
    "user": "밤의서재",
    "status": "결제 완료"
  },
  {
    "kind": "영상 후원",
    "amount": 10000,
    "id": "FR-20261017-0078",
    "date": "2026-10-17",
    "user": "푸른노트",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 3000,
    "id": "FR-20261016-0079",
    "date": "2026-10-16",
    "user": "브라운노트",
    "status": "결제 완료"
  },
  {
    "kind": "미션 후원",
    "amount": 20000,
    "id": "FR-20261016-0080",
    "date": "2026-10-16",
    "user": "별헤는밤",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 5000,
    "id": "FR-20261016-0081",
    "date": "2026-10-16",
    "user": "회색고양이",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 30000,
    "id": "FR-20261015-0082",
    "date": "2026-10-15",
    "user": "밤의서재",
    "status": "결제 완료"
  },
  {
    "kind": "음성 후원",
    "amount": 2000,
    "id": "FR-20261015-0083",
    "date": "2026-10-15",
    "user": "푸른노트",
    "status": "결제 완료"
  },
  {
    "kind": "메시지 후원",
    "amount": 10000,
    "id": "FR-20261015-0084",
    "date": "2026-10-15",
    "user": "브라운노트",
    "status": "결제 완료"
  }
] as const;

const payouts = [
  {
    "id": "PAY-202611-01",
    "date": "2026-11-25",
    "amount": 386400,
    "status": "지급 예정"
  },
  {
    "id": "PAY-202610-01",
    "date": "2026-10-25",
    "amount": 468200,
    "status": "지급 완료"
  },
  {
    "id": "PAY-202609-01",
    "date": "2026-09-25",
    "amount": 412600,
    "status": "지급 완료"
  },
  {
    "id": "PAY-202608-01",
    "date": "2026-08-25",
    "amount": 386400,
    "status": "지급 완료"
  },
  {
    "id": "PAY-202607-01",
    "date": "2026-07-25",
    "amount": 342800,
    "status": "지급 완료"
  },
  {
    "id": "PAY-202606-01",
    "date": "2026-06-25",
    "amount": 319500,
    "status": "지급 완료"
  }
] as const;

const statusTone = {
  '결제 완료': 'positive', '환불 완료': 'neutral', '미등록': 'neutral', '등록 완료': 'positive', '검토 중': 'warning',
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
        ['등록 상태', <StatusPill status={pending ? '검토 중' : '등록 완료'} />],
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
                ['상태', <StatusPill status={row.status} />],
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
