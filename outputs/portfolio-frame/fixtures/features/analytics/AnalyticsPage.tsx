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
  {
    "title": "퇴근 후 사이드 프로젝트 | 오늘도 조금씩",
    "minutes": 172,
    "average": 1048,
    "peak": 1742,
    "follows": 58
  },
  {
    "title": "월요일 모각코, 밀린 일부터 정리해요",
    "minutes": 158,
    "average": 986,
    "peak": 1624,
    "follows": 46
  },
  {
    "title": "일요일 작업실 | 커피 한 잔과 코딩",
    "minutes": 221,
    "average": 1096,
    "peak": 1886,
    "follows": 79
  },
  {
    "title": "주말엔 느긋하게, 같이 작업해요",
    "minutes": 248,
    "average": 1082,
    "peak": 1854,
    "follows": 83
  },
  {
    "title": "금요일 밤 코딩하고 수다도 조금",
    "minutes": 194,
    "average": 1017,
    "peak": 1716,
    "follows": 62
  },
  {
    "title": "퇴근하고 두 시간만 집중해 봅니다",
    "minutes": 146,
    "average": 947,
    "peak": 1588,
    "follows": 42
  },
  {
    "title": "비 오는 수요일, 조용한 작업실",
    "minutes": 164,
    "average": 972,
    "peak": 1629,
    "follows": 48
  },
  {
    "title": "사이드 프로젝트 하는 날 | 질문도 받아요",
    "minutes": 178,
    "average": 1006,
    "peak": 1693,
    "follows": 55
  },
  {
    "title": "월요병은 코딩으로 달래기",
    "minutes": 151,
    "average": 928,
    "peak": 1547,
    "follows": 39
  },
  {
    "title": "일요일 저녁, 다음 한 주 준비하기",
    "minutes": 236,
    "average": 1068,
    "peak": 1842,
    "follows": 72
  },
  {
    "title": "주말 모각코 | 각자 할 일 가져와요",
    "minutes": 261,
    "average": 1112,
    "peak": 1894,
    "follows": 87
  },
  {
    "title": "금요일은 조금 늦게까지",
    "minutes": 183,
    "average": 994,
    "peak": 1668,
    "follows": 56
  },
  {
    "title": "오랜만에 켜는 평일 작업실",
    "minutes": 143,
    "average": 902,
    "peak": 1512,
    "follows": 35
  },
  {
    "title": "오늘 할 일 세 가지, 같이 끝내요",
    "minutes": 167,
    "average": 946,
    "peak": 1591,
    "follows": 44
  },
  {
    "title": "퇴근 후 작업실 | 음악과 사이드 프로젝트",
    "minutes": 156,
    "average": 914,
    "peak": 1548,
    "follows": 40
  },
  {
    "title": "월요일엔 천천히 시작해요",
    "minutes": 149,
    "average": 887,
    "peak": 1472,
    "follows": 32
  },
  {
    "title": "일요일 낮, 책상 앞에 모여요",
    "minutes": 228,
    "average": 1034,
    "peak": 1776,
    "follows": 66
  },
  {
    "title": "토요일 작업실 | 저녁까지 달려봅니다",
    "minutes": 244,
    "average": 1072,
    "peak": 1848,
    "follows": 76
  },
  {
    "title": "금요일엔 코딩 반, 수다 반",
    "minutes": 187,
    "average": 962,
    "peak": 1634,
    "follows": 51
  },
  {
    "title": "오늘은 집중 모드 | 두 시간 모각코",
    "minutes": 152,
    "average": 874,
    "peak": 1468,
    "follows": 31
  },
  {
    "title": "수요일의 작은 작업실",
    "minutes": 169,
    "average": 918,
    "peak": 1557,
    "follows": 43
  },
  {
    "title": "퇴근하고 잠깐, 어제 하던 것부터",
    "minutes": 161,
    "average": 896,
    "peak": 1504,
    "follows": 37
  },
  {
    "title": "월요일도 무사히 | 같이 작업해요",
    "minutes": 147,
    "average": 842,
    "peak": 1418,
    "follows": 29
  },
  {
    "title": "일요일 저녁 모각코와 주간 회고",
    "minutes": 218,
    "average": 1019,
    "peak": 1743,
    "follows": 62
  },
  {
    "title": "주말 작업실 | 느리지만 꾸준하게",
    "minutes": 252,
    "average": 1056,
    "peak": 1812,
    "follows": 71
  },
  {
    "title": "불금 대신 코딩, 와서 쉬었다 가요",
    "minutes": 192,
    "average": 937,
    "peak": 1589,
    "follows": 47
  },
  {
    "title": "목요일 밤 | 오늘도 작은 진도",
    "minutes": 145,
    "average": 824,
    "peak": 1406,
    "follows": 26
  },
  {
    "title": "따뜻한 차와 조용한 모각코",
    "minutes": 159,
    "average": 861,
    "peak": 1452,
    "follows": 33
  },
  {
    "title": "퇴근 후 사이드 프로젝트 | 다시 시작",
    "minutes": 174,
    "average": 908,
    "peak": 1538,
    "follows": 41
  },
  {
    "title": "월요일 작업실, 이번 주 계획 세우기",
    "minutes": 153,
    "average": 836,
    "peak": 1426,
    "follows": 28
  }
] as const;

function previewBroadcasts() {
  const now = Date.parse('2026-11-10T22:30:00+09:00');
  return samples.map((sample, index) => ({
    ...sample,
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
