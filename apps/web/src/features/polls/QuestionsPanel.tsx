import { StatusBadge, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { MessageSquare, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import styles from './PollsPage.module.css';

export type PreviewQuestion = {
  id: string;
  text: string;
  author: string;
  receivedAt: string;
  answer: string;
  pinned: boolean;
};

type QuestionsPanelProps = {
  items: readonly PreviewQuestion[];
  onChange: (items: PreviewQuestion[]) => void;
  query: string;
  from: string;
  to: string;
  status: string;
};

function QuestionDialog({ question, onClose, onSave }: {
  question: PreviewQuestion;
  onClose: () => void;
  onSave: (answer: string, pinned: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const answerInput = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const answerId = useId();
  const errorId = useId();
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    answerInput.current?.focus();
    return () => element?.close();
  }, []);

  function dismiss() {
    dialog.current?.close();
    onClose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const answer = String(form.get('answer') ?? '').trim();
    if (!answer) {
      setError('답변을 입력해 주세요.');
      answerInput.current?.focus();
      return;
    }
    dialog.current?.close();
    onSave(answer, form.get('pinned') === 'on');
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    dismiss();
  }}>
    <header className={ui.dialogHeader}>
      <h2 id={titleId}>질문 답변</h2>
      <button type="button" className="icon-button" aria-label="상세 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    <dl className={styles.info}>
      <div><dt>질문</dt><dd>{question.text}</dd></div>
      <div><dt>작성자</dt><dd>{question.author}</dd></div>
      <div><dt>상태</dt><dd><StatusBadge tone={question.answer.trim() ? 'positive' : 'warning'}>{question.answer.trim() ? '답변 완료' : '대기'}</StatusBadge></dd></div>
    </dl>
    <form className={styles.editor} noValidate onSubmit={submit}>
      <label htmlFor={answerId}>답변</label>
      <textarea className={ui.control} ref={answerInput} id={answerId} name="answer" rows={4} maxLength={500} defaultValue={question.answer}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} required onChange={() => setError('')} />
      <label><input className={ui.checkbox} type="checkbox" name="pinned" defaultChecked={question.pinned} />질문 고정</label>
      {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
      <div className={ui.dialogActions}>
        <button type="button" className={ui.button} onClick={dismiss}>취소</button>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>답변 저장</button>
      </div>
    </form>
  </dialog>;
}

export function QuestionsPanel({ items, onChange, query, from, to, status }: QuestionsPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const term = query.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
  const rows = items.filter(question => {
    const answered = Boolean(question.answer.trim());
    const matchesStatus = status === 'waiting' ? !answered : status === 'answered' ? answered : true;
    return matchesStatus && (!from || question.receivedAt >= from) && (!to || question.receivedAt <= to) &&
      `${question.text} ${question.author}`.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(term);
  });
  const selected = items.find(question => question.id === selectedId);

  function saveAnswer(answer: string, pinned: boolean) {
    if (!selected) return;
    onChange(items.map(question => question.id === selected.id ? { ...question, answer, pinned } : question));
    setSelectedId(null);
    setNotice(`${selected.author} 님의 질문에 답변을 저장했어요.`);
  }

  return <section aria-label="질문 목록">
    {rows.length ? <div className={ui.tableFrame}>
      <table className={ui.table} role="table" aria-label="시청자 질문 목록">
        <thead role="rowgroup"><tr role="row">{['질문', '작성자', '상태', '관리'].map(label => <th data-align={label === '금액' || label === '포인트' || label === '관리' ? 'end' : undefined} key={label} role="columnheader" scope="col">{label}</th>)}</tr></thead>
        <tbody role="rowgroup">{rows.map(question => <tr key={question.id} role="row">
          <th role="rowheader" scope="row" data-label="질문" data-primary="true"><span>{question.pinned && <><StatusBadge>고정</StatusBadge> </>}{question.text}</span></th>
          <td role="cell" data-label="작성자">{question.author}</td>
          <td role="cell" data-label="상태"><StatusBadge tone={question.answer.trim() ? 'positive' : 'warning'}>{question.answer.trim() ? '답변 완료' : '대기'}</StatusBadge></td>
          <td role="cell" data-align="end"><button type="button" className={ui.button} aria-label={`${question.author} 질문 답변`} aria-haspopup="dialog" onClick={() => {
            setNotice('');
            setSelectedId(question.id);
          }}>답변</button></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={<MessageSquare size={24} />} title={items.length ? '조건에 맞는 질문이 없어요' : '등록된 질문이 없어요'} />}
    <p className={styles.notice} role="status">{notice || `${rows.length}개`}</p>
    {selected && <QuestionDialog key={selected.id} question={selected} onClose={() => setSelectedId(null)} onSave={saveAnswer} />}
  </section>;
}
