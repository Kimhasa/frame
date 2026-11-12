import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './DeveloperPage.module.css';

const eventNames = {
  '방송 시작·종료': 'broadcast.started',
  '후원 이벤트': 'donation.created',
  '채팅 이벤트': 'chat.message',
} as const;

export type WebhookSettings = {
  url: string;
  event: keyof typeof eventNames;
};

export function WebhookPanel({ settings, onChange }: Readonly<{
  settings: Readonly<WebhookSettings>;
  onChange: (settings: WebhookSettings) => void;
}>) {
  const [draft, setDraft] = useState<WebhookSettings>(() => ({ ...settings }));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const sectionTitle = useId();
  const dialogTitle = useId();
  const errorId = useId();
  const events = Object.keys(eventNames) as WebhookSettings['event'][];

  useEffect(() => {
    const element = dialog.current;
    if (previewOpen && element && !element.open) element.showModal();
  }, [previewOpen]);

  function dismissPreview() {
    dialog.current?.close();
    setPreviewOpen(false);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let url: URL;
    try {
      url = new URL(draft.url.trim());
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid webhook URL');
    } catch {
      setError('사용자 정보가 없는 HTTPS 주소를 입력해 주세요.');
      setNotice('');
      urlInput.current?.focus();
      return;
    }
    const next = { url: url.href, event: draft.event };
    onChange(next);
    setDraft(next);
    setError('');
    setNotice('웹훅 설정을 저장했어요.');
  }

  return <section className={styles.panel} aria-labelledby={sectionTitle}>
    <h2 id={sectionTitle}>웹훅</h2>
    <form onSubmit={save} noValidate>
      <div className={styles.fields}>
        <label>수신 주소<input className={ui.control} ref={urlInput} name="url" type="url" placeholder="https://example.test/webhook"
          value={draft.url} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
          onChange={event => {
            setDraft({ ...draft, url: event.currentTarget.value });
            setError('');
            setNotice('');
          }} />
        </label>
        <label>이벤트<select className={ui.control} name="event" value={draft.event} onChange={event => {
          const selected = events.find(value => value === event.currentTarget.value);
          if (selected) setDraft({ ...draft, event: selected });
          setNotice('');
        }}>
          {events.map(value => <option key={value}>{value}</option>)}
        </select></label>
      </div>
      {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={ui.button} aria-haspopup="dialog" onClick={() => setPreviewOpen(true)}>요청 내용</button>
        <button type="submit" className={`${ui.button} ${ui.primary}`}>저장</button>
      </div>
    </form>
    <p className={styles.notice} role="status">{notice}</p>
    {previewOpen && <dialog ref={dialog} className={ui.dialog} aria-labelledby={dialogTitle} onCancel={event => {
      event.preventDefault();
      dismissPreview();
    }}>
      <header className={ui.dialogHeader}>
        <h2 id={dialogTitle}>웹훅 요청 내용</h2>
        <button type="button" className="icon-button" aria-label="상세 닫기" onClick={dismissPreview}><X size={20} aria-hidden="true" /></button>
      </header>
      <dl className={styles.info}>
        <div><dt>요청 방식</dt><dd>POST</dd></div>
        <div><dt>수신 주소</dt><dd>{draft.url.trim() || '미입력'}</dd></div>
        <div><dt>이벤트</dt><dd>{draft.event}</dd></div>
      </dl>
      <pre className={styles.payload}>{JSON.stringify({ event: eventNames[draft.event], channel: 'spring' }, null, 2)}</pre>
      <div className={ui.dialogActions}><button type="button" className={ui.button} onClick={dismissPreview}>닫기</button></div>
    </dialog>}
  </section>;
}
