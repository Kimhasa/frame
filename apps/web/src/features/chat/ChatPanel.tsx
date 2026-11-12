import { ArrowDown, Pencil, RefreshCw, UserRound, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, UIEvent } from 'react';
import { Link, useLocation } from 'react-router';
import type { ChatAccountActions, ChatView } from '../../viewer-contract';
import styles from './ChatPanel.module.css';

type ChatPanelProps = {
  chat: ChatView;
  onClose: () => void;
  accountActions?: ChatAccountActions;
  participation?: ReactNode;
};

const statusText = {
  connecting: '채팅에 연결하고 있어요.',
  connected: '',
  reconnecting: '채팅에 다시 연결하고 있어요.',
  closed: '채팅 연결이 종료됐어요.',
} satisfies Record<ChatView['status'], string>;

export function ChatPanel({ chat, onClose, accountActions, participation }: ChatPanelProps) {
  const { status, nickname, messages, pending, error, send, setNickname } = chat;
  const connected = status === 'connected';
  const location = useLocation();
  const account = chat.account;
  const identityMismatch = account?.state === 'authenticated' && accountActions?.currentUserId !== undefined && account.userId !== accountActions.currentUserId;
  const identityIssue = identityMismatch || account?.state === 'expired' || account?.state === 'changed';
  const canCompose = connected && (chat.canSend ?? true) && !identityIssue;
  const needsLogin = account?.state === 'anonymous' || account?.state === 'expired';
  const retryAt = chat.restriction?.retryAtMs ?? 0;
  const [now, setNow] = useState(Date.now);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const loginPath = `/login?${new URLSearchParams({ returnTo: location.pathname + location.search + location.hash })}`;
  const id = useId();
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [showLatest, setShowLatest] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState('');
  const [requestedName, setRequestedName] = useState<string | null>(null);
  const submitted = useRef<{ draft: string; wasPending: boolean; ackId?: string | null } | null>(null);
  const notifiedIdentity = useRef<string | null>(null);
  const followLatest = useRef(true);
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusComposer = useRef(false);

  useEffect(() => {
    const attempt = submitted.current;
    if (!attempt) return;
    if (pending) {
      attempt.wasPending = true;
      return;
    }

    submitted.current = null;
    const accepted = chat.lastAckId === undefined ? attempt.wasPending && connected && !error : chat.lastAckId !== null && chat.lastAckId !== attempt.ackId;
    if (accepted) {
      setDraft((current) => current === attempt.draft ? '' : current);
    }
  }, [connected, error, pending, chat.lastAckId]);
  useEffect(() => {
    setNow(Date.now());
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => { const next = Date.now(); setNow(next); if (next >= retryAt) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  useEffect(() => {
    if (account?.state !== 'expired' && account?.state !== 'changed') { notifiedIdentity.current = null; return; }
    const key = `${account.userId}:${account.state}`;
    if (notifiedIdentity.current === key) return;
    notifiedIdentity.current = key; accountActions?.onSessionChanged(account.userId ?? undefined);
  }, [account?.state, account?.userId, accountActions]);
  useEffect(() => { if (account) { dialogRef.current?.close(); setNameOpen(false); setRequestedName(null); } }, [Boolean(account)]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log?.clientHeight && followLatest.current) log.scrollTop = log.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const observer = new ResizeObserver(() => {
      if (log.clientHeight && followLatest.current) log.scrollTop = log.scrollHeight;
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (requestedName === null || nickname !== requestedName || !dialogRef.current?.open) return;
    focusComposer.current = true;
    dialogRef.current.close();
  }, [nickname, requestedName]);

  const namePending = requestedName !== null && connected && !error;
  const currentNameError = nameError || (requestedName !== null ? error : null);
  const composerError = draftError || (!nameOpen && (!account || canCompose) ? error : null);
  const accountNotice = identityMismatch ? '로그인한 계정이 바뀌었어요. 채팅에 다시 연결해 주세요.'
    : account?.state === 'checking' ? error || '계정 정보를 확인하고 있어요.'
    : chat.restriction?.message || error || (needsLogin ? '로그인하고 채팅에 참여해 주세요.' : '지금은 채팅을 보낼 수 없어요.');
  const canReconnect = Boolean(chat.reconnect) && (identityIssue || status === 'reconnecting' || (connected && Boolean(account) && !canCompose && !needsLogin));

  function openNameDialog() {
    if (account) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    focusComposer.current = false;
    setNameDraft(nickname);
    setNameError('');
    setRequestedName(null);
    setNameOpen(true);
    dialog.showModal();
    nameRef.current?.focus();
  }

  function closeNameDialog() {
    setNameOpen(false);
    setRequestedName(null);
    if (focusComposer.current) composerRef.current?.focus();
  }

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connected || namePending) return;
    const name = nameDraft.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!name || [...name].length > 20) {
      setNameError('닉네임을 1~20자로 입력해 주세요.');
      nameRef.current?.focus();
      return;
    }
    if (name === nickname) {
      focusComposer.current = true;
      dialogRef.current?.close();
      return;
    }
    setNameError('');
    setRequestedName(name);
    setNickname(name);
  }

  function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.normalize('NFC').trim();
    if (!canCompose || pending || remaining > 0 || !text) return;
    if ([...text].length > 1_000) {
      setDraftError('메시지는 1,000자까지 보낼 수 있어요.');
      return;
    }
    if (!nickname) {
      openNameDialog();
      return;
    }
    setDraftError('');
    submitted.current = { draft, wasPending: false, ackId: chat.lastAckId };
    send(text);
  }

  function onDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function onLogScroll(event: UIEvent<HTMLDivElement>) {
    const log = event.currentTarget;
    if (!log.clientHeight) return;
    followLatest.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 24;
    setShowLatest(!followLatest.current);
  }

  function jumpToLatest() {
    const log = logRef.current;
    if (!log) return;
    followLatest.current = true;
    log.scrollTop = log.scrollHeight;
    log.focus({ preventScroll: true });
    setShowLatest(false);
  }

  return (
    <aside className={styles.panel} aria-labelledby={`${id}-title`}>
      <header className={styles.header}>
        <h2 id={`${id}-title`}>채팅</h2>
        <button className={styles.iconButton} type="button" aria-label="채팅 닫기" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      {participation}

      <p className={status === 'connected' ? styles.srOnly : styles.status} role="status">
        {connected ? '채팅에 연결됐어요.' : statusText[status]}
      </p>
      {connected && <p className={styles.guideline}>서로를 배려하는 대화를 나눠주세요.</p>}

      <div className={styles.logWindow}>
        <div
          ref={logRef}
          className={styles.log}
          role="log"
          aria-label="채팅 메시지"
          aria-live="polite"
          aria-relevant="additions"
          tabIndex={0}
          onScroll={onLogScroll}
        >
          {messages.length ? (
            <ol className={styles.messages}>
              {messages.map((message) => (
                <li key={`${message.id}:${message.sentAtMs}`} className={styles.message}>
                  <strong>{message.authorChannelId ? <Link to={`/channel/id/${encodeURIComponent(message.authorChannelId)}`}>{message.author}</Link> : message.author}</strong>
                  {message.authorHandle && <Link className={styles.authorHandle} title={`@${message.authorHandle}`} to={message.authorChannelId ? `/channel/id/${encodeURIComponent(message.authorChannelId)}` : `/channel/${encodeURIComponent(message.authorHandle)}`}>@{message.authorHandle}</Link>}
                  {message.isOwner && <span className={styles.ownerBadge}>방송자</span>}{' '}
                  <span>{message.text}</span>
                </li>
              ))}
            </ol>
          ) : connected ? (
            <p className={styles.empty}>아직 메시지가 없어요.</p>
          ) : null}
        </div>
        {showLatest && (
          <button className={styles.latest} type="button" onClick={jumpToLatest}>
            <ArrowDown size={16} aria-hidden="true" /> 최신 메시지로
          </button>
        )}
      </div>

      <form className={styles.composer} onSubmit={submitDraft}>
        <label className={styles.srOnly} htmlFor={`${id}-message`}>채팅 메시지 입력</label>
        <textarea
          ref={composerRef}
          id={`${id}-message`}
          value={draft}
          rows={2}
          placeholder={needsLogin ? '로그인 후 채팅에 참여할 수 있어요' : canCompose ? '메시지 보내기' : '채팅을 보낼 수 없어요'}
          enterKeyHint="send"
          aria-describedby={composerError ? `${id}-message-error` : undefined}
          readOnly={!canCompose}
          onChange={(event) => { setDraft(event.target.value); setDraftError(''); }}
          onKeyDown={onDraftKeyDown}
        />
        {composerError && <p id={`${id}-message-error`} className={styles.error} role="alert">{composerError}</p>}
        {account && !canCompose && <p className={styles.hint} role="status">{accountNotice}</p>}
        {remaining > 0 && <p className={styles.hint} role="status">{remaining.toLocaleString('ko-KR')}초 후 다시 보낼 수 있어요.</p>}
        {chat.policy && <p className={styles.policy}>채널 설정: {[chat.policy.followersOnly ? '팔로워 채팅' : '', chat.policy.slowMode ? `${chat.policy.slowSeconds}초 간격` : '', chat.policy.blockLinks ? '링크 제한' : ''].filter(Boolean).join(' · ') || '일반 채팅'}</p>}
        <div className={styles.actions}>
          {account ? <span className={styles.identity}><UserRound size={15} aria-hidden="true" /><strong>{nickname || '회원 채팅'}</strong></span> : <button
            className={styles.nameButton}
            type="button"
            aria-haspopup="dialog"
            aria-label={nickname ? `채팅 닉네임 변경, 현재 ${nickname}` : '채팅 닉네임 설정'}
            disabled={!connected}
            onClick={openNameDialog}
          >
            <Pencil size={15} aria-hidden="true" />
            {nickname && <strong>{nickname}</strong>}
            <span>{nickname ? '변경' : '닉네임 설정'}</span>
          </button>}
          <button className={styles.primary} type="submit" disabled={!canCompose || pending || remaining > 0 || !draft.trim()}>
            {pending ? '보내는 중' : '보내기'}
          </button>
        </div>
        {account && (needsLogin || canReconnect) && <div className={styles.accountActions}>
          {needsLogin && (accountActions ? <button type="button" className={styles.secondary} onClick={accountActions.onRequireLogin}>{account.state === 'expired' ? '다시 로그인' : '로그인'}</button> : <Link className={styles.secondary} to={loginPath}>로그인</Link>)}
          {canReconnect && <button type="button" className={styles.secondary} disabled={pending} onClick={() => { accountActions?.onSessionChanged(accountActions.currentUserId ?? undefined); chat.reconnect?.(); }}><RefreshCw size={15} aria-hidden="true" />채팅 다시 연결</button>}
        </div>}
      </form>

      {!account && <dialog ref={dialogRef} className={styles.dialog} aria-labelledby={`${id}-name-title`} onClose={closeNameDialog}>
        <div className={styles.dialogHeader}>
          <h2 id={`${id}-name-title`}>{nickname ? '채팅 닉네임 변경' : '채팅 닉네임 설정'}</h2>
          <button className={styles.iconButton} type="button" aria-label="닉네임 설정 닫기" onClick={() => dialogRef.current?.close()}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <form className={styles.nameForm} onSubmit={submitName}>
          <label htmlFor={`${id}-nickname`}>닉네임</label>
          <input
            ref={nameRef}
            id={`${id}-nickname`}
            type="text"
            autoComplete="nickname"
            value={nameDraft}
            aria-describedby={`${id}-name-hint`}
            aria-invalid={Boolean(currentNameError)}
            readOnly={namePending}
            onChange={(event) => { setNameDraft(event.target.value); setNameError(''); setRequestedName(null); }}
          />
          <p
            id={`${id}-name-hint`}
            className={currentNameError ? styles.error : styles.hint}
            role={currentNameError ? 'alert' : undefined}
          >
            {currentNameError || (connected ? '1–20자' : statusText[status])}
          </p>
          <div className={styles.dialogActions}>
            <button className={styles.secondary} type="button" onClick={() => dialogRef.current?.close()}>취소</button>
            <button className={styles.primary} type="submit" disabled={!connected || namePending}>
              {namePending ? '저장 중' : nickname ? '변경하기' : '설정하기'}
            </button>
          </div>
        </form>
      </dialog>}
    </aside>
  );
}
