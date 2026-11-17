import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { developerClient } from './developer-client';
import type { DeveloperKey, KeyScope } from './developer-client';
import { dateText, Modal, ScopeFields, scopeLabels, SecretResult } from './DeveloperControls';
import { useDeveloperMutation } from './useDeveloperMutation';
import type { DeveloperAccessError } from './useDeveloperMutation';
import styles from './ConnectedDeveloperPage.module.css';

type Api = ReturnType<typeof developerClient>;
type Choice = { kind: 'create'; name: string; scopes: KeyScope[] } | { kind: 'revoke'; item: DeveloperKey };
function KeyDialog({ choice, api, online, onClose, onSaved, onAccessError }: { choice: Choice; api: Api; online: boolean; onClose: () => void; onSaved: (item: DeveloperKey) => void; onAccessError: DeveloperAccessError }) {
  const mutation = useDeveloperMutation({
    run: async requestId => choice.kind === 'create' ? api.issueKey(choice.name, choice.scopes, requestId) : { item: await api.revokeKey(choice.item, requestId) },
    verify: requestId => choice.kind === 'create' ? api.keyReceipt(requestId) : api.keyMutation(choice.item.id, requestId), onSaved, onAccessError,
  });
  const created = choice.kind === 'create', done = mutation.phase === 'done';
  return <Modal title={done ? created ? 'API 키가 발급되었어요' : 'API 키를 폐기했어요' : created ? 'API 키를 발급할까요?' : 'API 키를 폐기할까요?'} busy={mutation.busy} locked={mutation.locked || Boolean(mutation.secret)} onClose={onClose}>
    {mutation.secret ? <SecretResult secret={mutation.secret} label="발급된 API 키" onDone={onClose} /> : <>
      <dl className={styles.summary}><div><dt>이름</dt><dd>{created ? choice.name : choice.item.name}</dd></div><div><dt>권한</dt><dd>{(created ? choice.scopes : choice.item.scopes).map(scope => scopeLabels[scope]).join(', ')}</dd></div></dl>
      {!created && !done && <p>이 키를 사용하는 연동은 즉시 중단돼요. 폐기한 키는 복구할 수 없어요.</p>}
      {done && mutation.recovered && created && <p className={styles.warning}>발급된 내역을 확인했어요. 응답을 받지 못한 키의 원문은 다시 표시할 수 없어요. 목록에서 이 키를 폐기한 뒤 새 키를 발급해 주세요.</p>}
      {mutation.error && <p className={styles.error} role="alert">{mutation.error}</p>}
      {!online && <p className={styles.error} role="status">인터넷 연결을 확인해 주세요.</p>}
      <div className={ui.dialogActions}>
        {done ? <button type="button" className={ui.button} onClick={onClose}>확인</button> : <>
          {!mutation.locked && <button type="button" className={ui.button} disabled={mutation.busy} onClick={onClose}>취소</button>}
          {mutation.locked && <button type="button" className={ui.button} disabled={!online || mutation.busy} onClick={() => void mutation.check()}>결과 확인</button>}
          {(!mutation.locked || mutation.phase === 'absent') && <button type="button" className={`${ui.button} ${created ? ui.primary : ui.danger}`} disabled={!online || mutation.busy} onClick={() => void mutation.submit()}>{mutation.busy ? '처리 중…' : mutation.phase === 'absent' ? '같은 요청으로 다시 시도' : created ? '발급 확인' : '폐기 확인'}</button>}
        </>}
      </div>
    </>}
  </Modal>;
}
export function DeveloperKeys({ items, loading, loadError, api, online, onReload, onSaved, onAccessError }: { items: DeveloperKey[]; loading: boolean; loadError: string; api: Api; online: boolean; onReload: () => void; onSaved: (item: DeveloperKey) => void; onAccessError: DeveloperAccessError }) {
  const [name, setName] = useState(''), [scopes, setScopes] = useState<KeyScope[]>(['broadcast:read']), [error, setError] = useState(''), [choice, setChoice] = useState<Choice | null>(null);
  const nameRef = useRef<HTMLInputElement>(null), id = useId(), active = items.filter(item => item.revokedAtMs === null).length;
  const unavailable = loading || !online || Boolean(loadError), atLimit = active >= 5;
  function create(event: FormEvent) {
    event.preventDefault(); if (unavailable || atLimit || choice) return;
    if (!name.trim() || [...name.trim()].length > 40) { setError('키 이름을 1~40자로 입력해 주세요.'); nameRef.current?.focus(); return; }
    if (!scopes.length) { setError('API 권한을 하나 이상 선택해 주세요.'); nameRef.current?.form?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus(); return; }
    setError(''); setChoice({ kind: 'create', name: name.trim(), scopes: [...scopes] });
  }
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <header className={styles.panelHeader}><div><h2 id={`${id}-title`}>API 키</h2><p className={styles.hint}>외부 서비스가 내 채널에 접근할 권한을 선택해요. 활성 키 {active}/5개</p></div><button type="button" className={ui.button} disabled={loading || !online || Boolean(choice)} onClick={onReload}>{loading ? '불러오는 중…' : '목록 새로고침'}</button></header>
    <form noValidate onSubmit={create}>
      <div className={styles.fields}><label>키 이름<input ref={nameRef} className={ui.control} value={name} maxLength={40} required disabled={unavailable || atLimit} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setName(event.currentTarget.value); setError(''); }} /></label><ScopeFields value={scopes} onChange={value => { setScopes(value); setError(''); }} disabled={unavailable || atLimit} errorId={error ? `${id}-error` : undefined} /></div>
      {error && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
      {atLimit && <p className={styles.hint}>활성 키는 최대 5개예요. 사용하지 않는 키를 폐기하면 새 키를 발급할 수 있어요.</p>}
      <div className={styles.actions}><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={unavailable || atLimit} aria-haspopup="dialog">키 발급</button></div>
    </form>
    {loadError && <p className={styles.error} role="alert">{loadError} 목록 새로고침으로 다시 확인해 주세요.</p>}
    <div className={styles.list}>{items.length ? <div className={ui.tableFrame}><table className={ui.table}><thead><tr><th>이름·키</th><th>권한</th><th>상태·사용</th><th>관리</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><th scope="row" data-primary="true">{item.name}<span className={`${styles.subtext} ${styles.masked}`}>{item.prefix}••••{item.last4}</span><span className={styles.subtext}>발급 {dateText(item.createdAtMs)}</span></th><td data-label="권한"><span>{item.scopes.map(scope => scopeLabels[scope]).join(', ')}</span></td><td data-label="상태·사용"><div><StatusBadge tone={item.revokedAtMs === null ? 'positive' : 'neutral'}>{item.revokedAtMs === null ? '활성' : '폐기됨'}</StatusBadge><span className={styles.subtext}>최근 사용 {dateText(item.lastUsedAtMs)}</span>{item.revokedAtMs !== null && <span className={styles.subtext}>폐기 {dateText(item.revokedAtMs)}</span>}</div></td><td>{item.revokedAtMs === null && <button type="button" className={`${ui.button} ${ui.danger}`} disabled={unavailable} aria-label={`${item.name} 키 폐기`} aria-haspopup="dialog" onClick={() => setChoice({ kind: 'revoke', item })}>키 폐기</button>}</td></tr>)}</tbody></table></div> : <p className={styles.empty} role="status">{loading ? 'API 키를 불러오는 중이에요.' : loadError ? 'API 키 목록을 확인하지 못했어요.' : '발급된 API 키가 없어요.'}</p>}</div>
    {choice && <KeyDialog choice={choice} api={api} online={online} onClose={() => setChoice(null)} onSaved={item => { onSaved(item); if (choice.kind === 'create') { setName(''); setScopes(['broadcast:read']); } }} onAccessError={onAccessError} />}
  </section>;
}
