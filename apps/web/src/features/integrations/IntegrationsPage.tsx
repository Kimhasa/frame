import { CodeXml, Link2, MessagesSquare, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { broadcastPath, developerPath } from '../../preview/community-types';
import { ManagementPage, StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './IntegrationsPage.module.css';

type Status = '설정됨' | '미설정';

type Integration = {
  id: string;
  title: string;
  Icon: LucideIcon;
  status?: Status;
  fields: readonly { label: string; value: string }[];
};

const integrations: readonly Integration[] = [
  { id: 'broadcast', title: '방송 도구', Icon: Link2, fields: [] },
  {
    id: 'overlay', title: '브라우저 오버레이', Icon: Link2, status: '설정됨',
    fields: [{ label: '위젯 주소', value: 'https://frame.example/overlay/spring' }],
  },
  {
    id: 'bot', title: '채팅봇', Icon: MessagesSquare, status: '설정됨',
    fields: [
      { label: '명령어', value: '!방송' },
      { label: '자동 응답', value: '오늘도 함께해 주셔서 감사합니다.' },
    ],
  },
  {
    id: 'developer', title: 'API 및 웹훅', Icon: CodeXml,
    fields: [],
  },
];

function ConnectionStatus({ status }: { status: Status }) {
  return <StatusBadge tone={status === '설정됨' ? 'positive' : 'neutral'}>{status}</StatusBadge>;
}

export function IntegrationsPage() {
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<Integration | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  const empty = params.get('state') === 'empty';

  useEffect(() => {
    const element = dialog.current;
    if (selected && element && !element.open) element.showModal();
  }, [selected]);

  return (
    <ManagementPage title="외부 도구 연결" titleId="integrations-title">
      <ul className={styles.list}>
        {integrations.map(tool => (
          <li key={tool.id} className={styles.row}>
            <span className={styles.icon} aria-hidden="true"><tool.Icon size={21} /></span>
            <div className={styles.summary}>
              <h2>{tool.title}</h2>
              {tool.status && <ConnectionStatus status={empty ? '미설정' : tool.status} />}
            </div>
            {tool.id === 'broadcast'
              ? <Link className={ui.button} to={`${broadcastPath}?tab=stream`}>송출 정보</Link>
              : tool.id === 'developer'
              ? <Link className={ui.button} to={developerPath}>개발자 설정</Link>
              : <button type="button" className={ui.button} aria-haspopup="dialog"
                aria-label={`${tool.title} 상세`} onClick={() => setSelected(tool)}>상세</button>}
          </li>
        ))}
      </ul>
      {selected && (
        <dialog className={ui.dialog} ref={dialog} aria-labelledby={dialogTitle} onClose={() => setSelected(null)}>
          <header className={ui.dialogHeader}>
            <h2 id={dialogTitle}>{selected.status ? selected.title : '개발자 설정'}</h2>
            <button type="button" className="icon-button" aria-label="상세 닫기" onClick={() => dialog.current?.close()}>
              <X size={20} aria-hidden="true" />
            </button>
          </header>
          <dl className={styles.details}>
            {selected.status && <div><dt>상태</dt><dd><ConnectionStatus status={empty ? '미설정' : selected.status} /></dd></div>}
            {selected.fields.map(({ label, value }) => <div key={label}>
              <dt>{label}</dt><dd>{empty && selected.status ? '미설정' : value}</dd>
            </div>)}
          </dl>
          <form method="dialog" className={ui.dialogActions}>
            <button type="submit" className={ui.button}>닫기</button>
          </form>
        </dialog>
      )}
    </ManagementPage>
  );
}
