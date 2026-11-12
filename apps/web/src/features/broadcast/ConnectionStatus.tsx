import { CircleCheck, Laptop, LoaderCircle, RotateCw, Unplug, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './ConnectionStatus.module.css';

export function ConnectionStatus({ failed, live, onConnected, onDismiss }: {
  failed: boolean;
  live: boolean;
  onConnected: () => void;
  onDismiss: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState<'ready' | 'failed' | 'checking'>(failed ? 'failed' : 'ready');
  const busy = status === 'checking';

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { window.clearTimeout(timer.current); element?.close(); };
  }, []);

  function dismiss() {
    window.clearTimeout(timer.current);
    dialog.current?.close();
    onDismiss();
  }

  function retry() {
    if (busy) return;
    setStatus('checking');
    // Local preview only. Actual app connection belongs to the native/backend integration.
    timer.current = window.setTimeout(() => { setStatus('ready'); onConnected(); }, 650);
  }

  return <dialog ref={dialog} className={ui.dialog} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className={ui.dialogHeader}>
      <h2 id={`${id}-title`}>연결 상태</h2>
      <button type="button" className="icon-button" aria-label="연결 상태 닫기" onClick={dismiss}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className={styles.summary}>
      <span className={styles.appIcon} aria-hidden="true"><Laptop size={24} /></span>
      <div><strong>FRAME 송출 앱</strong><p>화면과 소리를 방송에 전달해요.</p></div>
    </div>
    <dl className={styles.details}>
      <div><dt>앱 연결</dt><dd><StatusBadge tone="positive">연결됨</StatusBadge></dd></div>
      <div><dt>방송 연결</dt><dd><StatusBadge tone={status === 'failed' ? 'warning' : live && status === 'ready' ? 'positive' : 'neutral'}>
        {busy ? '확인 중' : status === 'failed' ? '연결 실패' : live ? '수신 중' : '방송 시작 대기'}
      </StatusBadge></dd></div>
    </dl>
    <div className={styles.state} data-state={status} role={status === 'failed' ? 'alert' : 'status'} aria-busy={busy}>
      {busy ? <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" /> : status === 'failed' ? <Unplug size={18} aria-hidden="true" /> : <CircleCheck size={18} aria-hidden="true" />}
      <p>{busy ? '방송 연결을 확인하고 있어요.' : status === 'failed' ? '송출 앱에서 방송 연결을 다시 시도한 뒤 확인해 주세요.' : live ? '화면과 소리를 전송하고 있어요.' : '방송할 화면과 소리를 확인한 뒤 방송을 시작해 주세요.'}</p>
    </div>
    <footer className={ui.dialogActions}>
      <button type="button" className={ui.button} disabled={busy} onClick={retry}><RotateCw size={16} aria-hidden="true" />{busy ? '확인 중' : '다시 확인'}</button>
      <button type="button" className={`${ui.button} ${ui.primary}`} onClick={dismiss}>닫기</button>
    </footer>
  </dialog>;
}
