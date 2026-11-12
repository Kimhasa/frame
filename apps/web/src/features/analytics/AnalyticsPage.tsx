import { BarChart3, Search } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './AnalyticsPage.module.css';

const seoulDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});
const number = new Intl.NumberFormat('ko-KR');
const samples = [
  { title: '조용히 개발해요 · 화면 공유 작업실', minutes: 134, average: 112, peak: 216, follows: 10 },
  { title: '작은 기능 하나씩 완성하기', minutes: 108, average: 84, peak: 146, follows: 6 },
  { title: '한 주의 작업 정리', minutes: 87, average: 62, peak: 105, follows: 4 },
  { title: '다시보기 화면을 같이 만들어요', minutes: 116, average: 95, peak: 167, follows: 7 },
  { title: '작업실에서 같이 코딩해요', minutes: 125, average: 103, peak: 173, follows: 8 },
  { title: '한 줄씩 고치는 플레이어', minutes: 92, average: 74, peak: 116, follows: 3 },
  { title: '다음 화면 준비하는 날', minutes: 76, average: 68, peak: 112, follows: 4 },
  { title: '댓글과 채팅 화면 정리하기', minutes: 92, average: 57, peak: 103, follows: 3 },
  { title: '함께 만드는 작은 작업실', minutes: 116, average: 82, peak: 124, follows: 5 },
  { title: '프론트엔드 작업 기록', minutes: 78, average: 53, peak: 95, follows: 2 },
] as const;

function previewBroadcasts() {
  const now = Date.now();
  return Array.from({ length: 30 }, (_, index) => ({
    ...samples[index % samples.length],
    date: seoulDate.format(now - index * 86_400_000),
  }));
}

type BroadcastStats = ReturnType<typeof previewBroadcasts>[number];

function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return [hours ? `${hours}시간` : '', remainder || !hours ? `${remainder}분` : ''].filter(Boolean).join(' ');
}

function Summary({ rows, days }: { rows: readonly BroadcastStats[]; days: number }) {
  const broadcastMinutes = rows.reduce((total, row) => total + row.minutes, 0);
  const watchMinutes = rows.reduce((total, row) => total + row.minutes * row.average, 0);
  const metrics = [
    { label: '누적 시청 시간', value: `${number.format(Math.round(watchMinutes / 60))}시간` },
    { label: '평균 시청자 수', value: `${number.format(Math.round(watchMinutes / broadcastMinutes))}명` },
    { label: '최고 시청자 수', value: `${number.format(Math.max(...rows.map(row => row.peak)))}명` },
    { label: '신규 팔로워', value: `${number.format(rows.reduce((total, row) => total + row.follows, 0))}명`, detail: `최근 ${days}일` },
  ];
  return <dl className={styles.metrics} aria-label="방송 요약 지표">
    {metrics.map(({ label, value, detail }) => <div key={label}>
      <dt>{label}</dt><dd>{value}{detail && <small>{detail}</small>}</dd>
    </div>)}
  </dl>;
}

function ViewerChart({ rows }: { rows: readonly BroadcastStats[] }) {
  const ceiling = Math.ceil(Math.max(...rows.map(row => row.average)) / 25) * 25;
  return <section className={styles.chart} aria-labelledby="analytics-viewers">
    <h2 id="analytics-viewers">평균 시청자 수</h2>
    <div className={styles.chartScroll} tabIndex={rows.length > 7 ? 0 : undefined} role="region" aria-label="일별 평균 시청자 수 그래프">
      <ul className={styles.bars} style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(30px, 1fr))` }}>
        {[...rows].reverse().map(row => <li key={row.date}>
          <time dateTime={row.date}>{row.date.slice(5)}</time>
          <span className={styles.track} aria-hidden="true"><span style={{ height: `${row.average / ceiling * 100}%` }} /></span>
          <strong>{number.format(row.average)}명</strong>
        </li>)}
      </ul>
    </div>
  </section>;
}

const emptyFilters = { query: '', start: '', end: '' };
const pageSize = 20;

function BroadcastTable({ rows }: { rows: readonly BroadcastStats[] }) {
  const [filters, setFilters] = useState(emptyFilters);
  const [oldestFirst, setOldestFirst] = useState(false);
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const endInput = useRef<HTMLInputElement>(null);
  const matches = rows.filter(row => row.title.toLocaleLowerCase('ko-KR').includes(filters.query) &&
    (!filters.start || row.date >= filters.start) && (!filters.end || row.date <= filters.end));
  if (oldestFirst) matches.reverse();
  const offset = page * pageSize;

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const start = String(form.get('start') ?? '');
    const end = String(form.get('end') ?? '');
    if (start && end && start > end) {
      setError('종료일은 시작일과 같거나 이후여야 해요.');
      endInput.current?.focus();
      return;
    }
    const query = String(form.get('query') ?? '').trim().toLocaleLowerCase('ko-KR');
    setFilters({ query, start, end });
    setError('');
    setPage(0);
  }

  return <section aria-label="방송별 통계">
    <form className={styles.filters} role="search" aria-label="방송별 통계 검색" onSubmit={search} onReset={() => {
      setFilters(emptyFilters);
      setOldestFirst(false);
      setError('');
      setPage(0);
    }}>
      <div className={styles.search}>
        <input className={ui.control} type="search" name="query" aria-label="방송 제목 검색" placeholder="방송 제목 검색" maxLength={120} />
        <button className={`${ui.button} ${ui.primary}`} type="submit">검색</button>
        <button className={ui.button} type="reset">초기화</button>
      </div>
      <label className={styles.field}>정렬<select className={ui.control} value={oldestFirst ? 'oldest' : 'recent'} onChange={event => {
        setOldestFirst(event.currentTarget.value === 'oldest');
        setPage(0);
      }}><option value="recent">최신순</option><option value="oldest">오래된 순</option></select></label>
      <label className={styles.field}>시작일<input className={ui.control} type="date" name="start" /></label>
      <label className={styles.field}>종료일<input className={ui.control} ref={endInput} type="date" name="end" aria-invalid={Boolean(error)} aria-describedby={error ? 'analytics-range-error' : undefined} /></label>
    </form>
    {error && <p id="analytics-range-error" className={styles.error} role="alert">{error}</p>}
    {matches.length ? <div className={ui.tableFrame}>
      <table className={ui.table} role="table" aria-label="방송별 통계 목록">
        <thead role="rowgroup"><tr role="row">
          <th role="columnheader" scope="col">방송</th><th role="columnheader" scope="col">날짜</th>
          <th role="columnheader" scope="col" data-align="end">평균 시청자</th><th role="columnheader" scope="col" data-align="end">방송 시간</th>
        </tr></thead>
        <tbody role="rowgroup">
          {matches.slice(offset, offset + pageSize).map(row => <tr key={row.date} role="row">
            <th role="rowheader" scope="row" data-label="방송">{row.title}</th>
            <td role="cell" data-label="날짜"><time dateTime={row.date}>{row.date}</time></td>
            <td role="cell" data-label="평균 시청자" data-align="end">{number.format(row.average)}명</td>
            <td role="cell" data-label="방송 시간" data-align="end">{duration(row.minutes)}</td>
          </tr>)}
        </tbody>
      </table>
      <div className={styles.pagination}>
        <span role="status">{offset + 1}–{Math.min(offset + pageSize, matches.length)} / {matches.length}개</span>
        {matches.length > pageSize && <div>
          <button className={ui.button} type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>이전</button>
          <button className={ui.button} type="button" disabled={offset + pageSize >= matches.length} onClick={() => setPage(page + 1)}>다음</button>
        </div>}
      </div>
    </div> : <EmptyState icon={<Search size={24} />} title="조건에 맞는 방송이 없어요" />}
  </section>;
}

export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const [broadcasts] = useState(previewBroadcasts);
  const days = params.get('period') === '30' ? 30 : 7;
  const rows = params.get('state') === 'empty' ? [] : broadcasts.slice(0, days);

  return <ManagementPage title="방송 분석" titleId="analytics-title" actions={<label className={styles.period}>
          <select className={ui.control} aria-label="통계 기간" value={days} onChange={event => {
            const next = new URLSearchParams(params);
            if (event.currentTarget.value === '30') next.set('period', '30');
            else next.delete('period');
            setParams(next);
          }}><option value="7">최근 7일</option><option value="30">최근 30일</option></select>
        </label>}>
    <div className={styles.layout}>
      {rows.length ? <>
        <Summary rows={rows} days={days} />
        <ViewerChart rows={rows} />
        <BroadcastTable key={days} rows={rows} />
      </> : <EmptyState icon={<BarChart3 size={26} />} title="아직 통계가 없어요" description="첫 방송이 끝나면 통계를 확인할 수 있어요." />}
    </div>
  </ManagementPage>;
}
