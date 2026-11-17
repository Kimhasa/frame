import { Copy, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './ConnectedDeveloperPage.module.css';
import { keyScopes, webhookEvents } from './developer-client';
import type { KeyScope, WebhookDraft, WebhookEvent } from './developer-client';

export const scopeLabels: Record<KeyScope, string> = { 'broadcast:read': '방송 정보 읽기', 'analytics:read': '통계 읽기', 'chat:manage': '채팅 관리' };
export const eventLabels: Record<WebhookEvent, string> = { 'broadcast.started': '방송 시작', 'broadcast.ended': '방송 종료' };
export function dateText(value: number | null) { return value === null ? '없음' : new Date(value).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
export function Modal({ title, busy, locked = false, onClose, children }: { title: string; busy: boolean; locked?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), titleId = useId();
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal(); heading.current?.focus();
    return () => { dialog.current?.close(); restore.current?.focus(); };
  }, []);
  return <dialog ref={dialog} className={`${ui.dialog} ${styles.dialog}`} aria-labelledby={titleId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy && !locked) onClose(); }}>
    <header className={ui.dialogHeader}><h2 ref={heading} tabIndex={-1} id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="닫기" disabled={busy || locked} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
    {children}
  </dialog>;
}
export function SecretResult({ secret, label, onDone }: { secret: string; label: string; onDone: () => void }) {
  const [copy, setCopy] = useState(''), [copying, setCopying] = useState(false), input = useRef<HTMLTextAreaElement>(null), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function copySecret() {
    if (copying) return;
    setCopying(true);
    try { await navigator.clipboard.writeText(secret); if (active.current) setCopy('복사했어요. 안전한 곳에 저장해 주세요.'); }
    catch { if (active.current) { setCopy('자동 복사에 실패했어요. 선택된 키를 직접 복사해 주세요.'); input.current?.focus(); input.current?.select(); } }
    finally { if (active.current) setCopying(false); }
  }
  return <div className={styles.secret}>
    <p>이 키는 지금 한 번만 표시돼요. 안전한 곳에 저장한 뒤 닫아 주세요. 닫으면 다시 확인할 수 없어요.</p>
    <label>{label}<textarea ref={input} className={`${ui.control} ${styles.secretValue}`} value={secret} readOnly rows={3} spellCheck={false} autoComplete="off" /></label>
    <div className={styles.actions}><button type="button" className={ui.button} disabled={copying} onClick={() => void copySecret()}><Copy size={16} aria-hidden="true" />{copying ? '복사 중…' : '복사'}</button></div>
    <p className={styles.hint} role="status">{copy}</p>
    <div className={ui.dialogActions}><button type="button" className={`${ui.button} ${ui.primary}`} onClick={onDone}>안전하게 저장했어요</button></div>
  </div>;
}
export function ScopeFields({ value, onChange, disabled, errorId }: { value: KeyScope[]; onChange: (value: KeyScope[]) => void; disabled: boolean; errorId?: string }) {
  return <fieldset className={styles.checks} disabled={disabled} aria-describedby={errorId}><legend>API 권한</legend>{keyScopes.map(scope => <AuthCheckbox key={scope} checked={value.includes(scope)} onChange={event => onChange(event.currentTarget.checked ? [...value, scope] : value.filter(item => item !== scope))}>{scopeLabels[scope]} ({scope})</AuthCheckbox>)}</fieldset>;
}
export function WebhookFields({ value, onChange, disabled, errorId, nameRef }: { value: WebhookDraft; onChange: (value: WebhookDraft) => void; disabled: boolean; errorId?: string; nameRef?: RefObject<HTMLInputElement | null> }) {
  return <div className={styles.fields}>
    <label>웹훅 이름<input ref={nameRef} className={ui.control} value={value.name} disabled={disabled} maxLength={40} required aria-describedby={errorId} onChange={event => onChange({ ...value, name: event.currentTarget.value })} /></label>
    <label>수신 주소<input className={ui.control} type="url" value={value.url} disabled={disabled} maxLength={2000} placeholder="https://example.com/webhook" required aria-describedby={errorId} onChange={event => onChange({ ...value, url: event.currentTarget.value })} /></label>
    <p className={styles.hint}>사용자 이름·비밀번호가 없는 HTTPS 주소를 입력해 주세요. HTTP는 서버에서 허용한 로컬 개발 주소만 사용할 수 있어요.</p>
    <fieldset className={styles.checks} disabled={disabled} aria-describedby={errorId}><legend>수신 이벤트</legend>{webhookEvents.map(item => <AuthCheckbox key={item} checked={value.events.includes(item)} onChange={event => onChange({ ...value, events: event.currentTarget.checked ? [...value.events, item] : value.events.filter(candidate => candidate !== item) })}>{eventLabels[item]} ({item})</AuthCheckbox>)}</fieldset>
    <AuthCheckbox checked={value.enabled} disabled={disabled} onChange={event => onChange({ ...value, enabled: event.currentTarget.checked })}>웹훅 활성화</AuthCheckbox>
  </div>;
}
export function validWebhook(value: WebhookDraft): string {
  if (!value.name.trim() || [...value.name.trim()].length > 40) return '웹훅 이름을 1~40자로 입력해 주세요.';
  if (!value.events.length) return '수신 이벤트를 하나 이상 선택해 주세요.';
  try { const url = new URL(value.url.trim()); if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || /[\u0000-\u0020\u007f]/.test(value.url.trim())) throw new Error(); }
  catch { return '사용자 정보와 URL 조각(#)이 없는 올바른 수신 주소를 입력해 주세요.'; }
  return '';
}
export const emptyWebhook = (): WebhookDraft => ({ name: '', url: '', events: ['broadcast.started', 'broadcast.ended'], enabled: true });
