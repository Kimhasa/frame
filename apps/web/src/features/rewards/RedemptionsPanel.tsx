import { StatusBadge, EmptyState } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { Gift, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import styles from './RewardsPage.module.css';

export type PreviewRedemption = {
  id: string;
  rewardName: string;
  user: string;
  cost: number;
  status: '신청 대기' | '처리 중' | '제공 완료' | '거절' | '취소';
  receivedAt: string;
  reason: string;
};

type Status = PreviewRedemption['status'];

const transitions: Partial<Record<Status, readonly Status[]>> = {
  '신청 대기': ['처리 중', '제공 완료', '거절', '취소'],
  '처리 중': ['제공 완료', '거절', '취소'],
};

const points = new Intl.NumberFormat('ko-KR');

function StatusPill({ status }: { status: Status }) {
  return <StatusBadge tone={status === '제공 완료' ? 'positive' : ['신청 대기', '처리 중'].includes(status) ? 'warning' : status === '거절' ? 'danger' : 'neutral'}>{status}</StatusBadge>;
}

function RedemptionDialog({ redemption, onClose, onSave }: {
  redemption: PreviewRedemption;
  onClose: () => void;
  onSave: (status: Status, reason: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const errorId = useId();
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<'status' | 'reason' | null>(null);
  const available = transitions[redemption.status] ?? [];

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  function dismiss() {
    dialog.current?.close();
    onClose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = available.find(status => status === form.get('status'));
    const reason = String(form.get('reason') ?? '').trim();
    if (!next) {
      setError('처리할 상태를 선택해 주세요.');
      setErrorField('status');
      dialog.current?.querySelector<HTMLSelectElement>('[name="status"]')?.focus();
      return;
    }
    if ((next === '거절' || next === '취소') && !reason) {
      setError('거절 또는 취소 사유를 입력해 주세요.');
      setErrorField('reason');
      reasonInput.current?.focus();
      return;
    }
    dialog.current?.close();
    onSave(next, reason);
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    dismiss();
  }}>
    <header className={ui.dialogHeader}>
      <h2 id={titleId}>교환 요청</h2>
      <button type="button" className="icon-button" aria-label="상세 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    <dl className={styles.info}>
      <div><dt>요청 ID</dt><dd>{redemption.id}</dd></div>
      <div><dt>보상</dt><dd>{redemption.rewardName}</dd></div>
      <div><dt>사용자</dt><dd>{redemption.user}</dd></div>
      <div><dt>포인트</dt><dd>{points.format(redemption.cost)} P</dd></div>
      <div><dt>상태</dt><dd><StatusPill status={redemption.status} /></dd></div>
      {available.length === 0 && <div><dt>처리 사유</dt><dd>{redemption.reason || '—'}</dd></div>}
    </dl>
    {available.length ? <form className={styles.editor} onSubmit={submit}>
      <label>처리<select className={ui.control} name="status" defaultValue={available[0]} aria-invalid={errorField === 'status'}
        aria-describedby={errorField === 'status' ? errorId : undefined} onChange={event => {
          if (errorField === 'status' || (errorField === 'reason' && !['거절', '취소'].includes(event.currentTarget.value))) { setError(''); setErrorField(null); }
        }}>{available.map(status => <option key={status}>{status}</option>)}</select></label>
      <label>사유<textarea className={ui.control} ref={reasonInput} name="reason" rows={3} maxLength={500} defaultValue={redemption.reason}
        aria-invalid={errorField === 'reason'} aria-describedby={errorField === 'reason' ? errorId : undefined}
        onChange={() => { if (errorField === 'reason') { setError(''); setErrorField(null); } }} /></label>
      {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
      <div className={ui.dialogActions}>
        <button type="button" className={ui.button} onClick={dismiss}>닫기</button>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>처리 저장</button>
      </div>
    </form> : <div className={ui.dialogActions}><button type="button" className={ui.button} onClick={dismiss}>닫기</button></div>}
  </dialog>;
}

export function RedemptionsPanel({ items, onChange, query, from, to, status }: {
  items: readonly PreviewRedemption[];
  onChange: (items: PreviewRedemption[]) => void;
  query: string;
  from: string;
  to: string;
  status: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const term = query.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
  const rows = items.filter(item => (!status || item.status === status) &&
    (!from || item.receivedAt >= from) && (!to || item.receivedAt <= to) &&
    `${item.rewardName} ${item.user} ${item.id}`.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(term));
  const selected = items.find(item => item.id === selectedId);

  function save(status: Status, reason: string) {
    if (!selected || !transitions[selected.status]?.includes(status)) return;
    onChange(items.map(item => item.id === selected.id ? { ...item, status, reason } : item));
    setSelectedId(null);
    setNotice(`${selected.user} 님의 교환 요청을 ${status} 상태로 변경했어요.`);
  }

  return <section aria-label="교환 요청 목록">
    {rows.length ? <div className={ui.tableFrame}>
      <table className={ui.table} role="table" aria-label="보상 교환 요청 목록">
        <thead role="rowgroup"><tr role="row">
          {['보상', '사용자', '포인트', '상태', '관리'].map(label => <th data-align={label === '금액' || label === '포인트' || label === '관리' ? 'end' : undefined} key={label} role="columnheader" scope="col">{label}</th>)}
        </tr></thead>
        <tbody role="rowgroup">{rows.map(item => <tr key={item.id} role="row">
          <th role="rowheader" scope="row" data-label="보상">{item.rewardName}</th>
          <td role="cell" data-label="사용자">{item.user}</td>
          <td role="cell" data-label="포인트" data-align="end">{points.format(item.cost)} P</td>
          <td role="cell" data-label="상태"><StatusPill status={item.status} /></td>
          <td role="cell" data-align="end"><button type="button" className={ui.button} aria-haspopup="dialog"
            aria-label={`${item.user} ${item.rewardName} 교환 요청`} onClick={() => {
              setNotice('');
              setSelectedId(item.id);
            }}>{transitions[item.status] ? '처리' : '상세'}</button></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={<Gift size={24} />} title={items.length ? '조건에 맞는 교환 요청이 없어요' : '등록된 교환 요청이 없어요'} />}
    <p className={styles.notice} role="status">{notice || `${rows.length}개`}</p>
    {selected && <RedemptionDialog key={selected.id} redemption={selected} onClose={() => setSelectedId(null)} onSave={save} />}
  </section>;
}
