import { ManagementPage, StatusBadge, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { Plus, Vote, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { QuestionsPanel } from './QuestionsPanel';
import type { PreviewQuestion } from './QuestionsPanel';
import styles from './PollsPage.module.css';

type PreviewPoll = {
  id: string;
  question: string;
  options: readonly { id: string; text: string; votes: number }[];
  duration: number;
  open: boolean;
  createdAt: string;
};

type PollsPreview = { polls: PreviewPoll[]; questions: PreviewQuestion[] };

export function createPreviewPolls(): PollsPreview {
  return {
    polls: [
      { id: 'poll-1', question: '다음 작업은 무엇으로 할까요?', options: [
        { id: 'option-1', text: '화면 개선', votes: 0 }, { id: 'option-2', text: '새 기능', votes: 0 }, { id: 'option-3', text: '오류 수정', votes: 0 },
      ], duration: 5, open: true, createdAt: '2026-11-11' },
      { id: 'poll-2', question: '다음 방송은 언제가 좋을까요?', options: [
        { id: 'option-1', text: '평일 저녁', votes: 18 }, { id: 'option-2', text: '주말 오후', votes: 12 },
      ], duration: 3, open: false, createdAt: '2026-11-10' },
    ],
    questions: [
      { id: 'question-1', text: '오늘 작업한 화면은 다음 방송에서도 이어서 볼 수 있나요?', author: '모아', receivedAt: '2026-11-11', answer: '', pinned: false },
      { id: 'question-2', text: '방송은 보통 언제 시작하나요?', author: '파도', receivedAt: '2026-11-10', answer: '화요일과 목요일 저녁 8시에 만나요.', pinned: true },
      { id: 'question-3', text: '플레이어의 되감기 기능도 소개해 주세요.', author: '초록', receivedAt: '2026-11-09', answer: '', pinned: false },
    ],
  };
}

function percentages(poll: PreviewPoll) {
  const total = poll.options.reduce((sum, option) => sum + option.votes, 0);
  if (!total) return poll.options.map(() => 0);
  const exact = poll.options.map(option => option.votes / total * 100);
  const result = exact.map(Math.floor);
  const remainder = 100 - result.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order.slice(0, remainder)) result[index]++;
  return result;
}

function PollResults({ poll }: { poll: PreviewPoll }) {
  const values = percentages(poll);
  return <ul className={styles.results} aria-label="선택지별 투표 결과">
    {poll.options.map((option, index) => <li key={option.id}>
      <div><span>{option.text}</span><strong>{option.votes}표 · {values[index]}%</strong></div>
      <span className={styles.track} aria-hidden="true"><span style={{ width: `${values[index]}%` }} /></span>
    </li>)}
  </ul>;
}

type PollDialogView = { kind: 'create' } | { kind: 'close' | 'results'; poll: PreviewPoll };

function PollDialog({ view, onDismiss, onCreate, onClosePoll }: {
  view: PollDialogView;
  onDismiss: () => void;
  onCreate: (question: string, options: string[], duration: number) => void;
  onClosePoll: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const questionInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errorId = useId();
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<'question' | 'options' | 'duration' | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    if (view.kind === 'close') continueButton.current?.focus();
    if (view.kind === 'create') questionInput.current?.focus();
    return () => element?.close();
  }, []);

  function dismiss() { dialog.current?.close(); onDismiss(); }

  function invalid(field: 'question' | 'options' | 'duration', message: string) {
    setError(message);
    setErrorField(field);
    dialog.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();
  }

  function clearError(field: 'question' | 'options' | 'duration') {
    if (errorField !== field) return;
    setError('');
    setErrorField(null);
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const question = String(form.get('question') ?? '').trim();
    const options = String(form.get('options') ?? '').split('\n').map(option => option.trim()).filter(Boolean);
    if (!question || question.length > 100) { invalid('question', '질문을 100자 이내로 입력해 주세요.'); return; }
    if (options.length < 2 || options.length > 8 || options.some(option => option.length > 100) || new Set(options).size !== options.length) {
      invalid('options', '서로 다른 선택지를 2~8개, 각 100자 이내로 입력해 주세요.');
      return;
    }
    const duration = Number(form.get('duration'));
    if (![1, 3, 5, 10].includes(duration)) { invalid('duration', '진행 시간을 선택해 주세요.'); return; }
    dialog.current?.close();
    onCreate(question, options, duration);
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={titleId}>{view.kind === 'create' ? '투표 만들기' : view.kind === 'close' ? '투표를 마감할까요?' : '투표 결과'}</h2>
      <button type="button" className="icon-button" aria-label="상세 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    {view.kind === 'create' ? <form className={styles.editor} noValidate onSubmit={create}>
      <label>질문<input className={ui.control} ref={questionInput} name="question" maxLength={100} required
        aria-invalid={errorField === 'question'} aria-describedby={errorField === 'question' ? errorId : undefined} onChange={() => clearError('question')} /></label>
      <label>선택지<textarea className={ui.control} name="options" maxLength={807} rows={5} placeholder="한 줄에 하나씩, 2~8개" required
        aria-invalid={errorField === 'options'} aria-describedby={errorField === 'options' ? errorId : undefined} onChange={() => clearError('options')} /></label>
      <label>진행 시간<select className={ui.control} name="duration" defaultValue="5" aria-invalid={errorField === 'duration'}
        aria-describedby={errorField === 'duration' ? errorId : undefined} onChange={() => clearError('duration')}><option value="1">1분</option><option value="3">3분</option><option value="5">5분</option><option value="10">10분</option></select></label>
      {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
      <div className={ui.dialogActions}><button type="button" className={ui.button} onClick={dismiss}>취소</button><button type="submit" className={`${ui.button} ${ui.primary}`}>투표 시작</button></div>
    </form> : <>
      <h3 className={styles.detailTitle}>{view.poll.question}</h3>
      <PollResults poll={view.poll} />
      <p className={styles.total}>총 {view.poll.options.reduce((sum, option) => sum + option.votes, 0)}표 · 진행 시간 {view.poll.duration}분</p>
      <div className={ui.dialogActions}>
        <button ref={view.kind === 'close' ? continueButton : undefined} type="button" className={ui.button} onClick={dismiss}>{view.kind === 'close' ? '계속 진행' : '닫기'}</button>
        {view.kind === 'close' && <button type="button" className={`${ui.button} ${ui.danger}`} onClick={() => { dialog.current?.close(); onClosePoll(view.poll.id); }}>투표 마감</button>}
      </div>
    </>}
  </dialog>;
}

const tabs = [{ id: 'polls', label: '투표' }, { id: 'questions', label: '질문' }] as const;
const initialFilters = { query: '', from: '', to: '' };
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

export function PollsPage({ preview, onChange }: { preview: PollsPreview; onChange: (preview: PollsPreview) => void }) {
  const [params, setParams] = useSearchParams();
  const endInput = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState(initialFilters);
  const [draft, setDraft] = useState(initialFilters);
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('recent');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<PollDialogView | null>(null);
  const tab = params.get('tab') === 'questions' ? 'questions' : 'polls';
  const empty = params.get('state') === 'empty';
  const statuses = tab === 'polls' ? [['open', '진행 중'], ['closed', '마감']] : [['waiting', '대기'], ['answered', '답변 완료']];
  const activeStatus = statuses.some(([id]) => id === status) ? status : '';
  const source = empty ? [] : preview.polls;
  const polls = source.filter(poll => poll.question.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(filters.query) &&
    (!filters.from || poll.createdAt >= filters.from) && (!filters.to || poll.createdAt <= filters.to) &&
    (!activeStatus || poll.open === (activeStatus === 'open')));
  polls.sort((a, b) => sort === 'name' ? a.question.localeCompare(b.question, 'ko') : sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt));
  const questions = [...(empty ? [] : preview.questions)].sort((a, b) => sort === 'name' ? a.text.localeCompare(b.text, 'ko') : sort === 'oldest' ? a.receivedAt.localeCompare(b.receivedAt) : b.receivedAt.localeCompare(a.receivedAt));

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get('from') ?? '');
    const to = String(form.get('to') ?? '');
    if (from && to && from > to) { setError('종료일은 시작일과 같거나 이후여야 해요.'); endInput.current?.focus(); return; }
    setFilters({ query: String(form.get('query') ?? '').normalize('NFKC').trim().toLocaleLowerCase('ko-KR'), from, to });
    setError('');
  }

  function createPoll(question: string, options: string[], duration: number) {
    const poll = { id: `poll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, question, duration, open: true, createdAt: today.format(new Date()), options: options.map((text, index) => ({ id: `option-${index}`, text, votes: 0 })) };
    onChange({ ...preview, polls: [poll, ...preview.polls] });
    setDialog(null);
    setStatus('');
    setFilters(initialFilters);
    setDraft(initialFilters);
    setSort('recent');
    setError('');
    const next = new URLSearchParams(params);
    next.delete('state');
    setParams(next, { replace: true });
    setNotice('투표를 시작했어요.');
  }

  function closePoll(id: string) {
    onChange({ ...preview, polls: preview.polls.map(poll => poll.id === id ? { ...poll, open: false } : poll) });
    setDialog(null);
    setStatus('');
    setNotice('투표를 마감했어요. 결과를 확인할 수 있어요.');
    requestAnimationFrame(() => document.getElementById('polls-tab-polls')?.focus());
  }

  return <ManagementPage title="투표 및 질문 관리" titleId="polls-title" actions={tab === 'polls' && <button id="poll-create-trigger" type="button" className={`${ui.button} ${ui.primary}`}
        aria-haspopup="dialog" onClick={() => setDialog({ kind: 'create' })}>
        <Plus size={17} aria-hidden="true" />투표 만들기
      </button>}>
    <nav className={ui.tabs} aria-label="투표 및 질문 관리 메뉴">
      {tabs.map(item => {
        const next = new URLSearchParams(params);
        next.set('tab', item.id);
        return <Link key={item.id} id={`polls-tab-${item.id}`} to={{ search: next.toString() }}
          aria-current={tab === item.id ? 'page' : undefined} onClick={() => { setStatus(''); setNotice(''); }}>
          {item.label}
        </Link>;
      })}
    </nav>
    <form className={styles.filters} role="search" aria-label="투표 및 질문 검색" onSubmit={search} onReset={() => {
      setFilters(initialFilters);
      setDraft(initialFilters);
      setStatus('');
      setSort('recent');
      setError('');
    }}>
      <input className={ui.control} type="search" name="query" aria-label="이름이나 내용 검색" placeholder="이름이나 내용 검색" maxLength={120}
        value={draft.query} onChange={event => setDraft({ ...draft, query: event.currentTarget.value })} />
      <label className={styles.dateField}>시작일<input className={ui.control} type="date" name="from" value={draft.from}
        onChange={event => setDraft({ ...draft, from: event.currentTarget.value })} /></label>
      <label className={styles.dateField}>종료일<input ref={endInput} className={ui.control} aria-invalid={Boolean(error)} aria-describedby={error ? 'polls-range-error' : undefined} type="date" name="to" value={draft.to}
        onChange={event => setDraft({ ...draft, to: event.currentTarget.value })} /></label>
      <div className={styles.filterActions}>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>검색</button>
        <button type="reset" className={ui.button}>초기화</button>
      </div>
    </form>
    <div className={styles.choices}>
      <label className={ui.filterField}>상태<select className={ui.control} aria-label="상태 필터" value={activeStatus} onChange={event => setStatus(event.currentTarget.value)}><option value="">전체 상태</option>{statuses.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className={ui.filterField}>정렬<select className={ui.control} aria-label="목록 정렬" value={sort} onChange={event => setSort(event.currentTarget.value)}><option value="recent">최신순</option><option value="oldest">오래된 순</option><option value="name">이름순</option></select></label>
    </div>
    {error && <p id="polls-range-error" className={styles.error} role="alert">{error}</p>}
    {tab === 'questions' ? <QuestionsPanel items={questions} onChange={items => {
      onChange({ ...preview, questions: items });
      setStatus('');
    }} query={filters.query} from={filters.from} to={filters.to} status={activeStatus} /> : polls.length ? (
      <div className={ui.tableFrame}>
        <table className={ui.table} role="table" aria-label="투표 목록">
          <thead role="rowgroup"><tr role="row">
            {['질문', '결과', '상태', '관리'].map(label => <th data-align={label === '금액' || label === '포인트' || label === '관리' ? 'end' : undefined} key={label} scope="col" role="columnheader">{label}</th>)}
          </tr></thead>
          <tbody role="rowgroup">{polls.map(poll => <tr key={poll.id} role="row">
            <th scope="row" role="rowheader" data-label="질문" data-primary="true">{poll.question}</th>
            <td role="cell" data-label="결과"><PollResults poll={poll} /></td>
            <td role="cell" data-label="상태">
              <StatusBadge tone={poll.open ? 'positive' : 'neutral'}>{poll.open ? '진행 중' : '마감'}</StatusBadge>
            </td>
            <td role="cell" data-align="end">
              <button type="button" className={`${ui.button} ${poll.open ? ui.danger : ''}`}
                aria-haspopup="dialog" aria-label={`${poll.question} ${poll.open ? '투표 마감' : '결과'}`}
                onClick={() => setDialog({ kind: poll.open ? 'close' : 'results', poll })}>
                {poll.open ? '투표 마감' : '결과'}
              </button>
            </td>
          </tr>)}</tbody>
        </table>
      </div>
    ) : (
      <EmptyState icon={<Vote size={24} />} title={source.length ? '조건에 맞는 투표가 없어요' : '등록된 투표가 없어요'} />
    )}
    {tab === 'polls' && <p className={styles.notice} role="status">{notice || `${polls.length}개`}</p>}
    {dialog && <PollDialog view={dialog} onDismiss={() => setDialog(null)} onCreate={createPoll} onClosePoll={closePoll} />}
  </ManagementPage>;
}
