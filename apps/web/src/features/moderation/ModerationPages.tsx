import { MessagesSquare, Plus, ShieldCheck, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './ModerationPages.module.css';

function StudioDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  function dismiss() { dialogRef.current?.close(); onClose(); }

  return <dialog ref={dialogRef} aria-labelledby={titleId} className={ui.dialog} onCancel={event => {
    event.preventDefault();
    dismiss();
  }}>
    <header className={ui.dialogHeader}>
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label="닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    {children}
  </dialog>;
}

const tabs = [
  { id: 'settings', label: '설정' },
  { id: 'operators', label: '운영자' },
  { id: 'blocked', label: '차단 목록' },
  { id: 'messages', label: '메시지 기록' },
] as const;

const chatOptions = [
  { key: 'slow', name: '느린 채팅', help: '메시지 전송 간격을 제한해요.' },
  { key: 'followers', name: '팔로워 전용', help: '팔로우한 시청자만 채팅에 참여할 수 있어요.' },
  { key: 'links', name: '링크 차단', help: '허용되지 않은 링크를 숨겨요.' },
] as const;

const initialSettings = { slow: true, followers: false, links: true, interval: '5', bannedWords: '' };
const initialMessages = [
  { id: 'sample-1', name: '파도', time: '오후 8:02', text: '오늘도 잘 보고 있어요.' },
  { id: 'sample-2', name: '모아', time: '오후 8:01', text: '안녕하세요! 오늘은 어떤 작업부터 시작하나요?' },
];

type ChatRestriction = { name: string; duration: string; reason: string };

export function ModerationPage() {
  const [params, setParams] = useSearchParams();
  const tab = tabs.find(item => item.id === params.get('tab'))?.id ?? 'settings';
  const [saved, setSaved] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings);
  const [operators, setOperators] = useState(['모아']);
  const [restrictions, setRestrictions] = useState<ChatRestriction[]>([]);
  const [messages, setMessages] = useState(initialMessages);
  const [pinned, setPinned] = useState<string>();
  const [addingOperator, setAddingOperator] = useState(false);
  const [restricting, setRestricting] = useState<string>();
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const helpId = useId();
  const formErrorId = useId();
  const dirty = Object.keys(saved).some(key => saved[key as keyof typeof saved] !== draft[key as keyof typeof draft]);
  const visibleOperators = params.get('state') === 'empty' ? [] : operators;

  function tabParams(target: typeof tab) {
    const next = new URLSearchParams(params);
    if (target === 'settings') next.delete('tab');
    else next.set('tab', target);
    return next;
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(draft);
    setNotice('채팅 설정을 저장했어요.');
  }

  function addOperator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (!name || visibleOperators.includes(name)) {
      setFormError(name ? '이미 등록된 운영자예요.' : '닉네임을 입력해 주세요.');
      event.currentTarget.querySelector<HTMLInputElement>('[name="name"]')?.focus();
      return;
    }
    const next = tabParams('operators');
    next.delete('state');
    setParams(next, { replace: true });
    setOperators([...visibleOperators, name]);
    event.currentTarget.closest('dialog')?.close();
    setAddingOperator(false);
    setNotice(`${name} 님을 운영자로 추가했어요.`);
  }

  function addRestriction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restricting) return;
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('reason') ?? '').trim();
    if (!reason) {
      setFormError('참여 제한 사유를 입력해 주세요.');
      event.currentTarget.querySelector<HTMLTextAreaElement>('[name="reason"]')?.focus();
      return;
    }
    setRestrictions(current => [...current, { name: restricting, reason, duration: String(form.get('duration')) }]);
    setNotice(`${restricting} 님의 채팅 참여를 제한했어요.`);
    event.currentTarget.closest('dialog')?.close();
    setRestricting(undefined);
    setParams(tabParams('blocked'));
  }

  return <ManagementPage title="채팅 관리" titleId="moderation-title">
    <nav className={ui.tabs} aria-label="채팅 관리 메뉴">
      {tabs.map(item => <Link key={item.id} to={{ search: tabParams(item.id).toString() }} aria-current={tab === item.id ? 'page' : undefined}>{item.label}</Link>)}
    </nav>

    {tab === 'settings' && <form className={styles.section} onSubmit={saveSettings}>
      <h2>채팅 설정</h2>
      {chatOptions.map(({ key, name, help }) => <label className={styles.switchRow} key={key}>
        <span><strong>{name}</strong><small id={`${helpId}-${key}`}>{help}</small></span>
        <input type="checkbox" role="switch" aria-label={name} aria-describedby={`${helpId}-${key}`} checked={draft[key]} onChange={event => {
          setDraft({ ...draft, [key]: event.target.checked });
          setNotice('');
        }} />
        <span className={styles.switch} aria-hidden="true" />
      </label>)}
      <div className={styles.fields}>
        <label>전송 간격 (초)<input className={ui.control} type="number" min={1} max={120} step={1} required disabled={!draft.slow} value={draft.interval} onChange={event => {
          setDraft({ ...draft, interval: event.target.value });
          setNotice('');
        }} /></label>
        <label>금칙어<textarea className={ui.control} rows={3} maxLength={1000} value={draft.bannedWords} placeholder="쉼표로 구분해 입력하세요" onChange={event => {
          setDraft({ ...draft, bannedWords: event.target.value });
          setNotice('');
        }} /></label>
      </div>
      <div className={ui.dialogActions}>
        <button type="button" className={ui.button} disabled={!dirty} onClick={() => { setDraft(saved); setNotice(''); }}>취소</button>
        <button type="submit" className={`${ui.button} ${ui.primary}`} disabled={!dirty}>저장</button>
      </div>
    </form>}

    {tab === 'operators' && <section className={styles.section} aria-labelledby="operator-title">
      <div className={styles.sectionHeading}>
        <h2 id="operator-title">채팅 운영자</h2>
        <button type="button" className={`${ui.button} ${ui.primary}`} onClick={() => { setFormError(''); setAddingOperator(true); }}><Plus size={16} aria-hidden="true" />운영자 추가</button>
      </div>
      {visibleOperators.length ? <ul className={styles.list}>
        {visibleOperators.map(name => <li className={styles.row} key={name}>
          <div><strong>{name}</strong><p>채팅 삭제 · 참여 제한</p></div>
          <button type="button" className={ui.button} aria-label={`${name} 운영자 권한 해제`} onClick={() => {
            setOperators(current => current.filter(operator => operator !== name));
            setNotice(`${name} 님의 운영자 권한을 해제했어요.`);
          }}>권한 해제</button>
        </li>)}
      </ul> : <EmptyState title="등록된 운영자가 없어요" icon={<ShieldCheck size={23} />} />}
    </section>}

    {tab === 'blocked' && <section className={styles.section} aria-labelledby="blocked-title">
      <h2 id="blocked-title">참여 제한 목록</h2>
      {restrictions.length ? <ul className={styles.list}>
        {restrictions.map(restriction => <li className={styles.row} key={restriction.name}>
          <div><strong>{restriction.name}</strong><p>{restriction.duration} · {restriction.reason}</p></div>
          <button type="button" className={ui.button} aria-label={`${restriction.name} 참여 제한 해제`} onClick={() => {
            setRestrictions(current => current.filter(item => item.name !== restriction.name));
            setNotice(`${restriction.name} 님의 참여 제한을 해제했어요.`);
          }}>제한 해제</button>
        </li>)}
      </ul> : <EmptyState title="채팅 참여가 제한된 사용자가 없어요" icon={<ShieldCheck size={23} />} />}
    </section>}

    {tab === 'messages' && <section className={styles.section} aria-labelledby="messages-title">
      <h2 id="messages-title">최근 메시지</h2>
      {messages.length ? <ul className={styles.list}>
        {messages.map(message => <li className={`${styles.row} ${styles.messageRow}`} key={message.id}>
          <div><strong>{message.name}</strong> <small>{message.time}</small>{pinned === message.id && <StatusBadge tone="info">고정됨</StatusBadge>}<p>{message.text}</p></div>
          <div className={styles.rowActions}>
            <button type="button" className={ui.button} onClick={() => setPinned(pinned === message.id ? undefined : message.id)}>{pinned === message.id ? '고정 해제' : '메시지 고정'}</button>
            <button type="button" className={ui.button} onClick={() => {
              setMessages(current => current.filter(item => item.id !== message.id));
              if (pinned === message.id) setPinned(undefined);
              setNotice('메시지를 삭제했어요.');
            }}>삭제</button>
            <button type="button" className={`${ui.button} ${ui.danger}`} disabled={restrictions.some(item => item.name === message.name)} onClick={() => {
              setFormError('');
              setRestricting(message.name);
            }}>참여 제한</button>
          </div>
        </li>)}
      </ul> : <EmptyState title="남아 있는 메시지가 없어요" icon={<MessagesSquare size={23} />} />}
    </section>}

    <p className={styles.notice} role="status">{notice}</p>

    {addingOperator && <StudioDialog title="운영자 추가" onClose={() => setAddingOperator(false)}>
      <form noValidate onSubmit={addOperator}>
        <div className={styles.fields}><label>닉네임<input className={ui.control} name="name" maxLength={20} required autoFocus aria-invalid={Boolean(formError)} aria-describedby={formError ? formErrorId : undefined} onInput={() => setFormError('')} /></label></div>
        {formError && <p className={styles.error} id={formErrorId} role="alert">{formError}</p>}
        <div className={ui.dialogActions}>
          <button type="button" className={ui.button} onClick={event => { event.currentTarget.closest('dialog')?.close(); setAddingOperator(false); }}>취소</button>
          <button type="submit" className={`${ui.button} ${ui.primary}`}>추가</button>
        </div>
      </form>
    </StudioDialog>}

    {restricting && <StudioDialog title="채팅 참여 제한" onClose={() => setRestricting(undefined)}>
      <form noValidate onSubmit={addRestriction}>
        <div className={styles.fields}>
          <label>대상<input className={ui.control} value={restricting} readOnly /></label>
          <label>기간<select className={ui.control} name="duration" defaultValue="10분"><option>10분</option><option>1시간</option><option>방송 종료까지</option></select></label>
          <label>사유<textarea className={ui.control} name="reason" rows={3} maxLength={500} required autoFocus aria-invalid={Boolean(formError)} aria-describedby={formError ? formErrorId : undefined} onInput={() => setFormError('')} /></label>
        </div>
        {formError && <p className={styles.error} id={formErrorId} role="alert">{formError}</p>}
        <div className={ui.dialogActions}>
          <button type="button" className={ui.button} onClick={event => { event.currentTarget.closest('dialog')?.close(); setRestricting(undefined); }}>취소</button>
          <button type="submit" className={`${ui.button} ${ui.primary}`}>참여 제한</button>
        </div>
      </form>
    </StudioDialog>}
  </ManagementPage>;
}

type Report = {
  id: string;
  received: string;
  target: string;
  reason: string;
  content: string;
  assignee: string;
  review?: { decision: string; note: string };
};

const initialReports: Report[] = [
  { id: 'sample-1', received: '10.28 14:25', target: '사용자 012', reason: '도배 및 광고', content: '같은 광고 문구가 채팅에 여러 번 올라왔어요.', assignee: '미배정' },
  { id: 'sample-2', received: '10.27 18:42', target: '사용자 008', reason: '부적절한 표현', content: '특정 시청자를 향한 부적절한 표현이 포함되어 있었어요.', assignee: '모아', review: { decision: '경고', note: '반복 여부를 확인했어요.' } },
];

function ReportDialog({ report, onSave, onClose }: { report: Report; onSave: (report: Report) => void; onClose: () => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    event.currentTarget.closest('dialog')?.close();
    onSave({ ...report, assignee: String(form.get('assignee')), review: report.review ?? {
      decision: String(form.get('decision')), note: String(form.get('note') ?? '').trim(),
    } });
  }

  return <StudioDialog title="신고 상세" onClose={onClose}>
    <dl className={styles.details}>
      <div><dt>대상</dt><dd>{report.target}</dd></div>
      <div><dt>접수일</dt><dd>{report.received}</dd></div>
      <div><dt>사유</dt><dd>{report.reason}</dd></div>
      <div><dt>신고 내용</dt><dd>{report.content}</dd></div>
      {report.review && <>
        <div><dt>조치</dt><dd>{report.review.decision}</dd></div>
        <div><dt>검토 메모</dt><dd>{report.review.note || '—'}</dd></div>
      </>}
    </dl>
    <form onSubmit={submit}>
      <div className={styles.fields}>
        <label>담당<select className={ui.control} name="assignee" defaultValue={report.assignee}><option>미배정</option><option>봄</option><option>모아</option></select></label>
        {!report.review && <>
          <label>조치<select className={ui.control} name="decision" defaultValue="" required><option value="" disabled>조치를 선택해 주세요</option><option>경고</option><option>일시 제한</option><option>차단</option><option>조치 없음</option></select></label>
          <label>검토 메모<textarea className={ui.control} name="note" rows={3} maxLength={500} /></label>
        </>}
      </div>
      <div className={ui.dialogActions}>
        <button type="button" className={ui.button} onClick={event => { event.currentTarget.closest('dialog')?.close(); onClose(); }}>닫기</button>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>{report.review ? '담당 저장' : '검토 완료'}</button>
      </div>
    </form>
  </StudioDialog>;
}

export function ReportsPage() {
  const [params] = useSearchParams();
  const [reports, setReports] = useState(initialReports);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('recent');
  const [activeReport, setActiveReport] = useState<Report>();
  const [notice, setNotice] = useState('');
  const source = params.get('state') === 'empty' ? [] : reports;
  const search = query.trim().toLocaleLowerCase('ko-KR');
  const filtered = source.filter(report => {
    const matchesStatus = status === 'all' || (status === 'resolved' ? Boolean(report.review) : !report.review);
    return matchesStatus && `${report.target} ${report.reason} ${report.content}`.toLocaleLowerCase('ko-KR').includes(search);
  });
  const visible = sort === 'oldest' ? filtered.reverse() : filtered;

  return <ManagementPage title="신고 관리" titleId="reports-title">
    <div className={styles.filters}>
      <label>목록 검색<input className={ui.control} type="search" placeholder="이름이나 내용 검색" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>상태<select className={ui.control} value={status} onChange={event => setStatus(event.target.value)}><option value="all">전체</option><option value="pending">검토 대기</option><option value="resolved">처리 완료</option></select></label>
      <label>정렬<select className={ui.control} value={sort} onChange={event => setSort(event.target.value)}><option value="recent">최신순</option><option value="oldest">오래된 순</option></select></label>
    </div>

    {visible.length ? <div className={ui.tableFrame}><table role="table" className={ui.table} aria-label="접수된 신고">
      <thead role="rowgroup"><tr role="row">{['접수일', '대상', '사유', '상태', '담당', '관리'].map(label => <th role="columnheader" key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody role="rowgroup">{visible.map(report => <tr role="row" key={report.id}>
        <td role="cell" data-label="접수일">{report.received}</td>
        <td role="cell" data-label="대상">{report.target}</td>
        <td role="cell" data-label="사유">{report.reason}</td>
        <td role="cell" data-label="상태"><StatusBadge tone={report.review ? 'neutral' : 'warning'}>{report.review ? '처리 완료' : '검토 대기'}</StatusBadge></td>
        <td role="cell" data-label="담당">{report.assignee}</td>
        <td role="cell"><button type="button" className={ui.button} aria-label={`${report.target} 신고 상세`} onClick={() => setActiveReport(report)}>상세</button></td>
      </tr>)}</tbody>
    </table></div> : <EmptyState title={source.length ? '조건에 맞는 신고가 없어요' : '접수된 신고가 없어요'}
      icon={source.length ? <MessagesSquare size={23} /> : <ShieldCheck size={23} />}
      action={source.length > 0 ? <button type="button" className={ui.button} onClick={() => { setQuery(''); setStatus('all'); setSort('recent'); }}>필터 초기화</button> : undefined} />}

    <p className={styles.notice} role="status">{notice}</p>
    {activeReport && <ReportDialog report={activeReport} onClose={() => setActiveReport(undefined)} onSave={report => {
      setReports(current => current.map(item => item.id === report.id ? report : item));
      setNotice(activeReport.review ? '담당을 저장했어요.' : '신고 검토를 완료했어요.');
      setActiveReport(undefined);
    }} />}
  </ManagementPage>;
}
