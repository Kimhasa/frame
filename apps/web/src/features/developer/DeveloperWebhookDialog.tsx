import { useRef, useState } from 'react';
import ui from '../../components/management/ManagementUI.module.css';
import { developerClient, developerFailure } from './developer-client';
import type { DeveloperWebhook, WebhookDraft } from './developer-client';
import { eventLabels, Modal, SecretResult, validWebhook, WebhookFields } from './DeveloperControls';
import { useDeveloperMutation } from './useDeveloperMutation';
import type { DeveloperAccessError } from './useDeveloperMutation';
import styles from './ConnectedDeveloperPage.module.css';

export type WebhookChoice = { kind: 'create'; draft: WebhookDraft } | { kind: 'edit' | 'delete'; item: DeveloperWebhook };
export function DeveloperWebhookDialog({ choice, api, online, onClose, onSaved, onAccessError }: { choice: WebhookChoice; api: ReturnType<typeof developerClient>; online: boolean; onClose: () => void; onSaved: (item: DeveloperWebhook) => void; onAccessError: DeveloperAccessError }) {
  const [base, setBase] = useState(choice.kind === 'create' ? null : choice.item);
  const [draft, setDraft] = useState<WebhookDraft>(choice.kind === 'create' ? choice.draft : { name: choice.item.name, url: choice.item.url, events: [...choice.item.events], enabled: choice.item.enabled });
  const [validation, setValidation] = useState(''), [reloading, setReloading] = useState(false), [notice, setNotice] = useState('');
  const frozen = useRef({ draft, base });
  const mutation = useDeveloperMutation({
    run: async requestId => {
      const value = frozen.current;
      if (choice.kind === 'create') return api.createWebhook(value.draft, requestId);
      return { item: choice.kind === 'edit' ? await api.editWebhook(value.base!, value.draft, requestId) : await api.removeWebhook(value.base!, requestId) };
    },
    verify: requestId => choice.kind === 'create' ? api.webhookReceipt(requestId) : api.webhookMutation(choice.item.id, requestId),
    onSaved, onAccessError,
  });
  const done = mutation.phase === 'done', creating = choice.kind === 'create', editing = choice.kind === 'edit';
  async function latest() {
    if (reloading || mutation.busy || mutation.locked) return;
    setReloading(true); setValidation('');
    try {
      const values = await api.webhooks(), current = values.find(item => item.id === base?.id);
      if (!current || current.revokedAtMs !== null) { setValidation('이 웹훅은 삭제되었어요. 창을 닫고 목록을 새로고침해 주세요.'); return; }
      setBase(current); setNotice('최신 상태를 확인했어요. 입력한 내용은 보존했어요. 내용을 검토한 뒤 다시 저장해 주세요.');
    } catch (failure) { if (!onAccessError(failure)) setValidation(developerFailure(failure).message); }
    finally { setReloading(false); }
  }
  function submit() {
    if (mutation.phase === 'idle') {
      const problem = choice.kind === 'delete' ? '' : validWebhook(draft);
      if (problem) { setValidation(problem); return; }
      frozen.current = { base, draft: { ...draft, name: draft.name.trim(), url: draft.url.trim(), events: [...draft.events] } };
    }
    setValidation(''); void mutation.submit();
  }
  const title = done ? creating ? '웹훅이 등록되었어요' : editing ? '웹훅을 수정했어요' : '웹훅을 삭제했어요' : creating ? '웹훅을 등록할까요?' : editing ? '웹훅 편집' : '웹훅을 삭제할까요?';
  return <Modal title={title} busy={mutation.busy || reloading} locked={mutation.locked || Boolean(mutation.secret)} onClose={onClose}>
    {mutation.secret ? <SecretResult secret={mutation.secret} label="발급된 웹훅 서명 키" onDone={onClose} /> : <>
      {editing && !done ? <WebhookFields value={draft} disabled={mutation.busy || mutation.locked || reloading} onChange={value => { setDraft(value); setValidation(''); }} errorId={validation ? 'webhook-edit-error' : undefined} /> : <dl className={styles.summary}><div><dt>이름</dt><dd>{draft.name}</dd></div><div><dt>수신 주소</dt><dd>{draft.url}</dd></div><div><dt>이벤트</dt><dd>{draft.events.map(event => eventLabels[event]).join(', ')}</dd></div><div><dt>상태</dt><dd>{draft.enabled ? '활성' : '중지'}</dd></div></dl>}
      {choice.kind === 'delete' && !done && <p>앞으로 이 주소로 이벤트를 보내지 않아요. 진행 중인 전송은 이미 도착했을 수 있어요. 삭제한 웹훅은 복구할 수 없어요.</p>}
      {creating && !done && <p>등록 후 서명 키를 한 번만 표시해요. 수신 서버는 이 키로 요청의 서명을 확인할 수 있어요.</p>}
      {done && mutation.recovered && creating && <p className={styles.warning}>등록 내역을 확인했어요. 응답을 받지 못한 서명 키는 다시 표시할 수 없어요. 이 웹훅을 삭제한 뒤 새로 등록해 주세요.</p>}
      {notice && <p className={styles.hint} role="status">{notice}</p>}
      {(validation || mutation.error) && <p id="webhook-edit-error" className={styles.error} role="alert">{validation || mutation.error}</p>}
      {!online && <p className={styles.error} role="status">인터넷 연결을 확인해 주세요.</p>}
      <div className={ui.dialogActions}>{done ? <button type="button" className={ui.button} onClick={onClose}>확인</button> : <>
        {!mutation.locked && <button type="button" className={ui.button} disabled={mutation.busy || reloading} onClick={onClose}>취소</button>}
        {!creating && !mutation.locked && <button type="button" className={ui.button} disabled={!online || mutation.busy || reloading} onClick={() => void latest()}>최신 상태 확인</button>}
        {mutation.locked && <button type="button" className={ui.button} disabled={!online || mutation.busy} onClick={() => void mutation.check()}>결과 확인</button>}
        {(!mutation.locked || mutation.phase === 'absent') && <button type="button" className={`${ui.button} ${choice.kind === 'delete' ? ui.danger : ui.primary}`} disabled={!online || mutation.busy || reloading} onClick={submit}>{mutation.busy ? '처리 중…' : mutation.phase === 'absent' ? '같은 요청으로 다시 시도' : creating ? '등록 확인' : editing ? '변경 저장' : '삭제 확인'}</button>}
      </>}</div>
    </>}
  </Modal>;
}
