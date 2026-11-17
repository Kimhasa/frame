import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { developerClient } from './developer-client';
import type { DeveloperWebhook, WebhookDraft } from './developer-client';
import { dateText, emptyWebhook, eventLabels, validWebhook, WebhookFields } from './DeveloperControls';
import { DeveloperWebhookDialog } from './DeveloperWebhookDialog';
import type { WebhookChoice } from './DeveloperWebhookDialog';
import { DeveloperDeliveryDialog } from './DeveloperDeliveryDialog';
import type { DeveloperAccessError } from './useDeveloperMutation';
import styles from './ConnectedDeveloperPage.module.css';

export function DeveloperWebhooks({ items, loading, loadError, api, online, onReload, onSaved, onAccessError }: { items: DeveloperWebhook[]; loading: boolean; loadError: string; api: ReturnType<typeof developerClient>; online: boolean; onReload: () => void; onSaved: (item: DeveloperWebhook) => void; onAccessError: DeveloperAccessError }) {
  const [draft, setDraft] = useState<WebhookDraft>(emptyWebhook), [error, setError] = useState(''), [choice, setChoice] = useState<WebhookChoice | null>(null), [delivery, setDelivery] = useState<{ item: DeveloperWebhook; test: boolean } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null), id = useId(), active = items.filter(item => item.revokedAtMs === null).length;
  const unavailable = loading || !online || Boolean(loadError), atLimit = active >= 5;
  function create(event: FormEvent) {
    event.preventDefault(); if (unavailable || atLimit || choice) return;
    const problem = validWebhook(draft);
    if (problem) {
      setError(problem);
      if (!draft.name.trim() || [...draft.name.trim()].length > 40) nameRef.current?.focus();
      else nameRef.current?.form?.querySelector<HTMLInputElement>(draft.events.length ? 'input[type="url"]' : 'input[type="checkbox"]')?.focus();
      return;
    }
    setError(''); setChoice({ kind: 'create', draft: { ...draft, name: draft.name.trim(), url: draft.url.trim(), events: [...draft.events] } });
  }
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <header className={styles.panelHeader}><div><h2 id={`${id}-title`}>웹훅</h2><p className={styles.hint}>방송 시작·종료 소식을 내 서버에서 받아요. 등록된 웹훅 {active}/5개</p></div><button type="button" className={ui.button} disabled={loading || !online || Boolean(choice) || Boolean(delivery)} onClick={onReload}>{loading ? '불러오는 중…' : '목록 새로고침'}</button></header>
    <form noValidate onSubmit={create}>
      <WebhookFields nameRef={nameRef} value={draft} disabled={unavailable || atLimit} onChange={value => { setDraft(value); setError(''); }} errorId={error ? `${id}-error` : undefined} />
      {error && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
      {atLimit && <p className={styles.hint}>웹훅은 최대 5개예요. 사용하지 않는 웹훅을 삭제하면 새로 등록할 수 있어요.</p>}
      <div className={styles.actions}><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={unavailable || atLimit} aria-haspopup="dialog">웹훅 등록</button></div>
    </form>
    {loadError && <p className={styles.error} role="alert">{loadError} 목록 새로고침으로 다시 확인해 주세요.</p>}
    <div className={styles.list}>{items.length ? <div className={ui.tableFrame}><table className={ui.table}><thead><tr><th>이름·수신 주소</th><th>이벤트</th><th>상태</th><th>관리</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><th scope="row" data-primary="true">{item.name}<span className={`${styles.subtext} ${styles.url}`}>{item.url}</span><span className={styles.subtext}>등록 {dateText(item.createdAtMs)}</span></th><td data-label="이벤트"><span>{item.events.map(event => eventLabels[event]).join(', ')}</span></td><td data-label="상태"><StatusBadge tone={item.revokedAtMs !== null ? 'neutral' : item.enabled ? 'positive' : 'warning'}>{item.revokedAtMs !== null ? '삭제됨' : item.enabled ? '활성' : '중지'}</StatusBadge></td><td><div className={styles.rowActions}>{item.revokedAtMs === null && <><button type="button" className={ui.button} disabled={unavailable} aria-label={`${item.name} 편집`} aria-haspopup="dialog" onClick={() => setChoice({ kind: 'edit', item })}>편집</button><button type="button" className={ui.button} disabled={unavailable || !item.enabled} aria-label={`${item.name} 테스트 전송`} aria-haspopup="dialog" onClick={() => setDelivery({ item, test: true })}>테스트 전송</button></>}<button type="button" className={ui.button} disabled={!online} aria-label={`${item.name} 전송 기록`} aria-haspopup="dialog" onClick={() => setDelivery({ item, test: false })}>전송 기록</button>{item.revokedAtMs === null && <button type="button" className={`${ui.button} ${ui.danger}`} disabled={unavailable} aria-label={`${item.name} 웹훅 삭제`} aria-haspopup="dialog" onClick={() => setChoice({ kind: 'delete', item })}>삭제</button>}</div></td></tr>)}</tbody></table></div> : <p className={styles.empty} role="status">{loading ? '웹훅을 불러오는 중이에요.' : loadError ? '웹훅 목록을 확인하지 못했어요.' : '등록된 웹훅이 없어요.'}</p>}</div>
    <details className={styles.signature}><summary>수신 서버의 서명 검증 방법</summary><p className={styles.hint}>등록할 때 받은 64자리 16진수 서명 키를 바이트로 변환해요. X-Frame-Timestamp, 마침표(.), 원문 요청 본문을 순서대로 연결한 UTF-8 바이트에 HMAC-SHA256을 계산해요. 결과의 소문자 16진수 앞에 sha256=을 붙여 X-Frame-Signature와 비교해 주세요. JSON을 다시 직렬화하면 서명이 달라져요.</p><p className={styles.hint}>X-Frame-Event-Id로 중복 이벤트를 확인할 수 있어요. 서명 키는 등록 응답에서 한 번만 표시하며 목록에서 다시 확인할 수 없어요.</p></details>
    {choice && <DeveloperWebhookDialog choice={choice} api={api} online={online} onClose={() => setChoice(null)} onSaved={item => { onSaved(item); if (choice.kind === 'create') setDraft(emptyWebhook()); }} onAccessError={onAccessError} />}
    {delivery && <DeveloperDeliveryDialog key={`${delivery.item.id}:${delivery.test}`} item={delivery.item} test={delivery.test} api={api} online={online} onClose={() => setDelivery(null)} onAccessError={onAccessError} />}
  </section>;
}
