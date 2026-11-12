import { ManagementPage, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { Gift, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { RedemptionsPanel } from './RedemptionsPanel';
import type { PreviewRedemption } from './RedemptionsPanel';
import styles from './RewardsPage.module.css';

const limits = ['방송당 1회', '무제한'] as const;
type RewardValues = { name: string; points: number; limit: typeof limits[number] };
type PreviewReward = RewardValues & { id: string; createdAt: string };
type RewardsPreview = { rewards: PreviewReward[]; requests: PreviewRedemption[] };

export function createPreviewRewards(): RewardsPreview {
  return {
    rewards: [
      { id: 'reward-1', name: '다음 작업 제안', points: 1000, limit: '방송당 1회', createdAt: '2026-11-11' },
      { id: 'reward-2', name: '화면 테마 고르기', points: 2000, limit: '무제한', createdAt: '2026-11-10' },
    ],
    requests: [
      { id: 'request-1', rewardName: '다음 작업 제안', user: '모아', cost: 1000, status: '신청 대기', receivedAt: '2026-11-11', reason: '' },
      { id: 'request-2', rewardName: '화면 테마 고르기', user: '초록', cost: 2000, status: '처리 중', receivedAt: '2026-11-10', reason: '' },
      { id: 'request-3', rewardName: '다음 작업 제안', user: '파도', cost: 1000, status: '제공 완료', receivedAt: '2026-11-09', reason: '제안한 작업을 방송에서 함께 살펴봤어요.' },
      { id: 'request-4', rewardName: '화면 테마 고르기', user: '산책', cost: 2000, status: '거절', receivedAt: '2026-11-08', reason: '현재 방송에서는 테마를 바꾸기 어려워요.' },
      { id: 'request-5', rewardName: '다음 작업 제안', user: '서재', cost: 1000, status: '취소', receivedAt: '2026-11-07', reason: '신청자가 취소를 요청했어요.' },
    ],
  };
}

function RewardEditor({ reward, onDismiss, onSave }: {
  reward: PreviewReward | null;
  onDismiss: () => void;
  onSave: (values: RewardValues) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errorId = useId();
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<'name' | 'points' | 'limit' | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    nameInput.current?.focus();
    return () => element?.close();
  }, []);

  function dismiss() {
    dialog.current?.close();
    onDismiss();
  }

  function invalid(field: 'name' | 'points' | 'limit', message: string) {
    setError(message);
    setErrorField(field);
    dialog.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();
  }

  function clearError(field: 'name' | 'points' | 'limit') {
    if (errorField !== field) return;
    setError('');
    setErrorField(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const points = Number(form.get('points'));
    const limit = limits.find(limit => limit === form.get('limit'));
    if (!name || name.length > 40) { invalid('name', '보상 이름을 40자 이내로 입력해 주세요.'); return; }
    if (!Number.isInteger(points) || points < 1 || points > 1_000_000) {
      invalid('points', '포인트는 1~1,000,000 사이 정수로 입력해 주세요.');
      return;
    }
    if (!limit) { invalid('limit', '교환 제한을 선택해 주세요.'); return; }
    dialog.current?.close();
    onSave({ name, points, limit });
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={titleId}>{reward ? '보상 수정' : '보상 추가'}</h2>
      <button type="button" className="icon-button" aria-label="상세 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    <form className={styles.editor} noValidate onSubmit={submit}>
      <label>보상 이름<input className={ui.control} ref={nameInput} name="name" maxLength={40} defaultValue={reward?.name ?? ''} required
        aria-invalid={errorField === 'name'} aria-describedby={errorField === 'name' ? errorId : undefined} onChange={() => clearError('name')} /></label>
      <label>필요 포인트<input className={ui.control} name="points" type="number" min={1} max={1_000_000} step={1} defaultValue={reward?.points ?? 1000} required
        aria-invalid={errorField === 'points'} aria-describedby={errorField === 'points' ? errorId : undefined} onChange={() => clearError('points')} /></label>
      <label>교환 제한<select className={ui.control} name="limit" defaultValue={reward?.limit ?? limits[0]} aria-invalid={errorField === 'limit'}
        aria-describedby={errorField === 'limit' ? errorId : undefined} onChange={() => clearError('limit')}>{limits.map(limit => <option key={limit}>{limit}</option>)}</select></label>
      {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
      <div className={ui.dialogActions}>
        <button type="button" className={ui.button} onClick={dismiss}>취소</button>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>저장</button>
      </div>
    </form>
  </dialog>;
}

const tabs = [{ id: 'settings', label: '보상 설정' }, { id: 'requests', label: '교환 요청' }] as const;
const requestStatuses: PreviewRedemption['status'][] = ['신청 대기', '처리 중', '제공 완료', '거절', '취소'];
const initialFilters = { query: '', from: '', to: '' };
const pointFormat = new Intl.NumberFormat('ko-KR');
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

export function RewardsPage({ preview, onChange }: { preview: RewardsPreview; onChange: (preview: RewardsPreview) => void }) {
  const [params, setParams] = useSearchParams();
  const endInput = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState(initialFilters);
  const [draft, setDraft] = useState(initialFilters);
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('recent');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<{ reward: PreviewReward | null } | null>(null);
  const tab = params.get('tab') === 'requests' ? 'requests' : 'settings';
  const source = params.get('state') === 'empty' ? { rewards: [], requests: [] } : preview;
  const rewards = source.rewards.filter(reward => reward.name.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(filters.query) &&
    (!filters.from || reward.createdAt >= filters.from) && (!filters.to || reward.createdAt <= filters.to));
  rewards.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'ko') : sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt));
  const requests = [...source.requests].sort((a, b) => sort === 'name' ? a.rewardName.localeCompare(b.rewardName, 'ko') : sort === 'oldest' ? a.receivedAt.localeCompare(b.receivedAt) : b.receivedAt.localeCompare(a.receivedAt));

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get('from') ?? '');
    const to = String(form.get('to') ?? '');
    if (from && to && from > to) { setError('종료일은 시작일과 같거나 이후여야 해요.'); endInput.current?.focus(); return; }
    setFilters({ query: String(form.get('query') ?? '').normalize('NFKC').trim().toLocaleLowerCase('ko-KR'), from, to });
    setError('');
  }

  function saveReward(values: RewardValues) {
    if (!editor) return;
    const reward = editor.reward;
    const nextRewards = reward
      ? preview.rewards.map(item => item.id === reward.id ? { ...item, ...values } : item)
      : [{ ...values, id: `reward-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: today.format(new Date()) }, ...preview.rewards];
    onChange({ ...preview, rewards: nextRewards });
    setEditor(null);
    setFilters(initialFilters);
    setDraft(initialFilters);
    setSort('recent');
    setError('');
    setNotice(reward ? '보상 설정을 변경했어요.' : '보상을 추가했어요.');
    const next = new URLSearchParams(params);
    next.delete('state');
    setParams(next, { replace: true });
  }

  return <ManagementPage title="포인트 및 보상" titleId="rewards-title" actions={tab === 'settings' && <button type="button" className={`${ui.button} ${ui.primary}`} aria-haspopup="dialog" onClick={() => setEditor({ reward: null })}>
        <Plus size={17} aria-hidden="true" />보상 추가
      </button>}>
    <nav className={ui.tabs} aria-label="포인트 및 보상 메뉴">
      {tabs.map(item => {
        const next = new URLSearchParams(params);
        next.set('tab', item.id);
        return <Link key={item.id} to={{ search: next.toString() }} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setNotice('')}>{item.label}</Link>;
      })}
    </nav>
    <form className={styles.filters} role="search" aria-label="보상 및 교환 요청 검색" onSubmit={search} onReset={() => {
      setFilters(initialFilters); setDraft(initialFilters); setStatus(''); setSort('recent'); setError('');
    }}>
      <input className={ui.control} type="search" name="query" aria-label="이름이나 내용 검색" placeholder="이름이나 내용 검색" maxLength={120}
        value={draft.query} onChange={event => setDraft({ ...draft, query: event.currentTarget.value })} />
      <label className={styles.dateField}>시작일<input className={ui.control} type="date" name="from" value={draft.from} onChange={event => setDraft({ ...draft, from: event.currentTarget.value })} /></label>
      <label className={styles.dateField}>종료일<input ref={endInput} className={ui.control} aria-invalid={Boolean(error)} aria-describedby={error ? 'rewards-range-error' : undefined} type="date" name="to" value={draft.to} onChange={event => setDraft({ ...draft, to: event.currentTarget.value })} /></label>
      <div className={styles.filterActions}>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button><button type="reset" className={ui.button}>초기화</button>
      </div>
    </form>
    <div className={styles.choices}>
      {tab === 'requests' && <label className={ui.filterField}>교환 상태<select className={ui.control} aria-label="교환 상태" value={status} onChange={event => setStatus(event.currentTarget.value)}>
        <option value="">전체 상태</option>{requestStatuses.map(status => <option key={status}>{status}</option>)}
      </select></label>}
      <label className={ui.filterField}>정렬<select className={ui.control} aria-label="목록 정렬" value={sort} onChange={event => setSort(event.currentTarget.value)}>
        <option value="recent">최신순</option><option value="oldest">오래된 순</option><option value="name">이름순</option>
      </select></label>
    </div>
    {error && <p id="rewards-range-error" className={styles.error} role="alert">{error}</p>}
    {tab === 'requests' ? <RedemptionsPanel items={requests} onChange={items => {
      onChange({ ...preview, requests: items });
      setStatus('');
    }} query={filters.query} from={filters.from} to={filters.to} status={status} /> : <>
      {rewards.length ? <div className={ui.tableFrame}>
        <table className={ui.table} role="table" aria-label="보상 목록">
          <thead role="rowgroup"><tr role="row">{['보상', '포인트', '교환 제한', '관리'].map(label => <th data-align={label === '금액' || label === '포인트' || label === '관리' ? 'end' : undefined} key={label} scope="col" role="columnheader">{label}</th>)}</tr></thead>
          <tbody role="rowgroup">{rewards.map(reward => <tr key={reward.id} role="row">
            <th scope="row" role="rowheader" data-label="보상" data-primary="true">{reward.name}</th>
            <td role="cell" data-label="포인트" data-align="end">{pointFormat.format(reward.points)} P</td>
            <td role="cell" data-label="교환 제한">{reward.limit}</td>
            <td role="cell" data-align="end"><button type="button" className={ui.button} aria-haspopup="dialog" aria-label={`${reward.name} 보상 수정`} onClick={() => setEditor({ reward })}>수정</button></td>
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState icon={<Gift size={24} />} title={source.rewards.length ? '조건에 맞는 보상이 없어요' : '등록된 보상이 없어요'} />}
      <p className={styles.notice} role="status">{notice || `${rewards.length}개`}</p>
    </>}
    {editor && <RewardEditor reward={editor.reward} onDismiss={() => setEditor(null)} onSave={saveReward} />}
  </ManagementPage>;
}
