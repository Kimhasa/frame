import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { X } from 'lucide-react';
import { WebhookPanel } from './WebhookPanel';
import type { WebhookSettings } from './WebhookPanel';
import { ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './DeveloperPage.module.css';

const scopes = ['방송 정보 읽기', '채팅 관리', '통계 읽기'] as const;
type ApiKey = { name: string; scope: typeof scopes[number] };
type DeveloperPreview = { apiKey: ApiKey | null; webhook: WebhookSettings };
type KeyDialogView = { kind: 'create' | 'revoke'; key: ApiKey };

export function createPreviewDeveloper(): DeveloperPreview {
  return { apiKey: null, webhook: { url: '', event: '방송 시작·종료' } };
}

function KeyDialog({ view, onDismiss }: { view: KeyDialogView; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [serviceError, setServiceError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    cancelButton.current?.focus();
  }, [view.kind]);

  function dismiss() {
    dialog.current?.close();
    onDismiss();
  }

  function confirm() {
    setServiceError('API 키 서비스를 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={titleId}>{view.kind === 'create' ? 'API 키를 발급할까요?' : 'API 키를 폐기할까요?'}</h2>
      <button type="button" className="icon-button" aria-label="상세 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    <dl className={styles.info}>
      <div><dt>이름</dt><dd>{view.key.name}</dd></div>
      <div><dt>권한</dt><dd>{view.key.scope}</dd></div>
    </dl>
    {serviceError && <p className={styles.error} role="alert">{serviceError}</p>}
    <div className={ui.dialogActions}>
      <button ref={cancelButton} type="button" className={ui.button} onClick={dismiss}>취소</button>
      <button type="button" className={`${ui.button} ${view.kind === 'revoke' ? ui.danger : ui.primary}`} onClick={confirm}>
        {view.kind === 'revoke' ? '키 폐기' : '키 발급'}
      </button>
    </div>
  </dialog>;
}

export function DeveloperPage({ preview, onChange }: { preview: DeveloperPreview; onChange: (preview: DeveloperPreview) => void }) {
  const [name, setName] = useState(preview.apiKey?.name ?? '방송 알림 연동');
  const [scope, setScope] = useState<ApiKey['scope']>(preview.apiKey?.scope ?? scopes[0]);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<KeyDialogView | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const errorId = useId();

  function requestKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preview.apiKey) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 40) {
      setError('키 이름을 40자 이내로 입력해 주세요.');
      nameInput.current?.focus();
      return;
    }
    setError('');
    setDialog({ kind: 'create', key: { name: trimmed, scope } });
  }

  return <ManagementPage title="개발자 설정" titleId="developer-title">
    <section className={styles.panel} aria-labelledby="api-key-title">
      <h2 id="api-key-title">API 키</h2>
      <form noValidate onSubmit={requestKey}>
        <div className={styles.fields}>
          <label>이름<input className={ui.control} ref={nameInput} name="key-name" maxLength={40} value={preview.apiKey?.name ?? name} readOnly={Boolean(preview.apiKey)}
            aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
            onChange={event => { setName(event.currentTarget.value); setError(''); }} required /></label>
          <label>권한<select className={ui.control} name="key-scope" value={preview.apiKey?.scope ?? scope} disabled={Boolean(preview.apiKey)}
            onChange={event => setScope(event.currentTarget.value as ApiKey['scope'])}>
            {scopes.map(scope => <option key={scope}>{scope}</option>)}
          </select></label>
        </div>
        <p className={styles.keyCount}>{preview.apiKey ? '발급된 키 1개' : '발급된 키가 없어요.'}</p>
        {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          {preview.apiKey ? <button type="button" className={`${ui.button} ${ui.danger}`} aria-haspopup="dialog"
            onClick={() => setDialog({ kind: 'revoke', key: preview.apiKey! })}>키 폐기</button>
            : <button type="submit" className={`${ui.button} ${ui.primary}`} aria-haspopup="dialog">키 발급</button>}
        </div>
      </form>
    </section>
    <WebhookPanel settings={preview.webhook} onChange={webhook => onChange({ ...preview, webhook })} />
    {dialog && <KeyDialog view={dialog} onDismiss={() => setDialog(null)} />}
  </ManagementPage>;
}
