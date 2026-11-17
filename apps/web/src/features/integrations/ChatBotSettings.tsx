import { Bot, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import { StatusBadge } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import { AccountError } from '../account/account-client';
import type { AccountSession } from '../account/account-client';
import { chatBotApi, normalizeBotCommand, normalizeBotResponse, validBotCommand, validBotResponse } from './chatbot-client';
import type { ChatBotCommand, ChatBotInput, ChatBotSettings as SavedSettings } from './chatbot-client';
import row from './ConnectedIntegrationsPage.module.css';
import styles from './ChatBotSettings.module.css';

type DraftCommand = Omit<ChatBotCommand, 'cooldownSeconds'> & { cooldownSeconds: string };
type Draft = { enabled: boolean; commands: DraftCommand[] };
type Props = { session: AccountSession; onRequireLogin: () => void; onSessionChanged?: () => void };
type Invalid = { rule: string; field: 'command' | 'response' | 'cooldownSeconds' } | null;
const toDraft = (value: SavedSettings): Draft => ({ enabled: value.enabled, commands: value.commands.map(item => ({ ...item, cooldownSeconds: String(item.cooldownSeconds) })) });
const sameSettings = (value: SavedSettings, input: ChatBotInput) => value.enabled === input.enabled && JSON.stringify(value.commands) === JSON.stringify(input.commands);
const dates = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

export function ChatBotSettings({ session, onRequireLogin, onSessionChanged }: Props) {
  const userId = session.user!.id, channelId = session.channel!.id, id = useId();
  const [saved, setSaved] = useState<SavedSettings | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState<ChatBotInput | null>(null);
  const [access, setAccess] = useState<'login' | 'session' | 'forbidden' | null>(null), [online, setOnline] = useState(() => navigator.onLine);
  const [invalid, setInvalid] = useState<Invalid>(null), [retryAt, setRetryAt] = useState(0), [clock, setClock] = useState(Date.now);
  const active = useRef(false), busy = useRef(false), request = useRef<AbortController | null>(null), generation = useRef(0);
  const savedRef = useRef(saved), draftRef = useRef(draft), focusRule = useRef<string | null>(null);
  const commandInputs = useRef(new Map<string, HTMLInputElement>()), form = useRef<HTMLFormElement>(null), addButton = useRef<HTMLButtonElement>(null), feedback = useRef<HTMLParagraphElement>(null);
  savedRef.current = saved; draftRef.current = draft;
  const dirty = Boolean(saved && draft && JSON.stringify(toDraft(saved)) !== JSON.stringify(draft));

  const accessFailure = useCallback((failure: unknown) => {
    if (!(failure instanceof AccountError)) return false;
    if (failure.status === 401) { setAccess('login'); setError('로그인이 만료됐어요. 입력한 내용은 유지돼요. 로그인한 뒤 다시 확인해 주세요.'); return true; }
    if (failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID') { setAccess('session'); setError('로그인한 계정이 바뀌었거나 로그인 정보를 다시 확인해야 해요. 입력한 내용은 유지돼요.'); return true; }
    if (failure.status === 403) { setAccess('forbidden'); setError('이 채널의 채팅봇 설정을 변경할 권한을 확인하지 못했어요. 입력한 내용은 유지돼요.'); return true; }
    return false;
  }, []);

  const load = useCallback(async (mode: 'initial' | 'refresh' | 'verify', expected?: ChatBotInput) => {
    if (busy.current) return;
    if (!navigator.onLine) { setError('인터넷 연결을 확인한 뒤 다시 시도해 주세요. 입력한 내용은 유지돼요.'); setLoading(false); return; }
    busy.current = true; const operation = ++generation.current, abort = new AbortController(); request.current?.abort(); request.current = abort;
    setPending(true); setError(''); setNotice('');
    if (!savedRef.current) setLoading(true);
    try {
      const value = await chatBotApi.settings(userId, channelId, abort.signal);
      if (!active.current || abort.signal.aborted || generation.current !== operation) return;
      setSaved(value); setAccess(null); setConflict(false); setUncertain(null); setInvalid(null);
      if (!draftRef.current || mode === 'initial') setDraft(toDraft(value));
      else if (mode === 'verify' && expected && value.version > expected.version && sameSettings(value, expected)) {
        setDraft(toDraft(value)); setNotice('서버에 저장된 채팅봇 설정을 확인했어요.');
      } else if (mode === 'verify') setError('서버의 현재 설정을 확인했어요. 입력한 내용은 유지돼요. 확인 후 다시 저장해 주세요.');
      else setNotice('최신 설정을 확인했어요. 입력한 내용은 유지돼요. 확인 후 다시 저장해 주세요.');
    } catch (failure) {
      if (!active.current || abort.signal.aborted || generation.current !== operation || accessFailure(failure)) return;
      setError(mode === 'verify' ? '저장 결과를 확인하지 못했어요. 입력한 내용은 유지돼요. 저장 결과를 다시 확인해 주세요.'
        : '채팅봇 설정을 불러오지 못했어요. 입력한 내용은 유지돼요. 다시 시도해 주세요.');
      if (failure instanceof AccountError && failure.retryAfterMs) setRetryAt(Date.now() + failure.retryAfterMs);
    } finally {
      if (active.current && generation.current === operation) { busy.current = false; setLoading(false); setPending(false); }
    }
  }, [userId, channelId, accessFailure]);

  useEffect(() => {
    active.current = true; void load('initial');
    return () => { active.current = false; ++generation.current; request.current?.abort(); busy.current = false; };
  }, [load]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!retryAt || clock >= retryAt) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(1000, retryAt - clock));
    return () => window.clearTimeout(timer);
  }, [retryAt, clock]);
  useEffect(() => {
    if (!focusRule.current) return;
    const input = commandInputs.current.get(focusRule.current); focusRule.current = null;
    if (input) input.focus(); else addButton.current?.focus();
  }, [draft?.commands.length]);
  useEffect(() => { if (notice) feedback.current?.focus({ preventScroll: true }); }, [notice]);

  function changed() { setNotice(''); setInvalid(null); if (!conflict && !uncertain && !access) setError(''); }
  function updateRule(ruleId: string, patch: Partial<DraftCommand>) {
    setDraft(current => current ? { ...current, commands: current.commands.map(item => item.id === ruleId ? { ...item, ...patch } : item) } : current); changed();
  }
  function addRule() {
    if (!draft || draft.commands.length >= 20 || busy.current) return;
    const ruleId = crypto.randomUUID(); focusRule.current = ruleId;
    setDraft({ ...draft, commands: [...draft.commands, { id: ruleId, command: '', response: '', enabled: true, cooldownSeconds: '15' }] }); changed();
  }
  function deleteRule(ruleId: string) {
    if (!draft || busy.current) return;
    const position = draft.commands.findIndex(item => item.id === ruleId);
    focusRule.current = draft.commands[position + 1]?.id ?? draft.commands[position - 1]?.id ?? 'add';
    setDraft({ ...draft, commands: draft.commands.filter(item => item.id !== ruleId) }); changed();
  }
  function reject(rule: string, field: NonNullable<Invalid>['field'], message: string) {
    setInvalid({ rule, field }); setError(message);
    form.current?.querySelector<HTMLElement>(`[name="chatbot-${field === 'cooldownSeconds' ? 'cooldown' : field}-${rule}"]`)?.focus();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !saved || !dirty || busy.current || conflict || uncertain || access || !navigator.onLine || Date.now() < retryAt) return;
    if (draft.commands.length > 20) { setError('명령어는 사용하지 않는 항목을 포함해 최대 20개까지 등록할 수 있어요.'); return; }
    const names = new Set<string>(), commands: ChatBotCommand[] = [];
    for (const item of draft.commands) {
      const command = normalizeBotCommand(item.command), response = normalizeBotResponse(item.response), cooldownSeconds = Number(item.cooldownSeconds);
      if (!validBotCommand(command)) { reject(item.id, 'command', '명령어는 ! 뒤에 영문·숫자·밑줄·한글을 1~20자 입력해 주세요.'); return; }
      if (names.has(command)) { reject(item.id, 'command', '중복된 명령어가 있어요. 대소문자를 구분하지 않아요.'); return; }
      if (!validBotResponse(response)) { reject(item.id, 'response', '응답을 1~500자로 입력해 주세요. 사용할 수 없는 문자는 제외해 주세요.'); return; }
      if (!/^\d+$/.test(item.cooldownSeconds) || !Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 5 || cooldownSeconds > 3600) {
        reject(item.id, 'cooldownSeconds', '응답 간격은 5~3,600초 사이의 정수로 입력해 주세요.'); return;
      }
      names.add(command); commands.push({ id: item.id, command, response, enabled: item.enabled, cooldownSeconds });
    }
    const input: ChatBotInput = { version: saved.version, enabled: draft.enabled, commands };
    busy.current = true; const operation = ++generation.current, abort = new AbortController(); request.current = abort;
    setPending(true); setError(''); setNotice(''); setInvalid(null);
    let verify = false;
    try {
      const value = await chatBotApi.save(input, session.csrfToken, userId, channelId, abort.signal);
      if (!active.current || abort.signal.aborted || generation.current !== operation) return;
      if (value.version <= input.version || !sameSettings(value, input)) throw new AccountError('저장 응답을 다시 확인해야 해요.', 'INVALID_RESPONSE', 0);
      setSaved(value); setDraft(toDraft(value)); setNotice('채팅봇 설정을 저장했어요.');
    } catch (failure) {
      if (!active.current || abort.signal.aborted || generation.current !== operation || accessFailure(failure)) return;
      if (failure instanceof AccountError && failure.code === 'CHAT_BOT_SETTINGS_CONFLICT') {
        setConflict(true); setError('다른 곳에서 채팅봇 설정이 변경됐어요. 입력한 내용은 유지돼요. 최신 설정을 확인해 주세요.');
      } else if (!(failure instanceof AccountError) || failure.status === 0 || failure.status >= 500 || failure.status === 408) {
        setUncertain(input); setError('저장 결과를 확인하고 있어요. 입력한 내용은 유지돼요.'); verify = true;
      } else {
        setError(failure.message || '채팅봇 설정을 저장하지 못했어요. 입력한 내용은 유지돼요.');
        if (failure.retryAfterMs) { setRetryAt(Date.now() + failure.retryAfterMs); setClock(Date.now()); }
      }
    } finally {
      if (active.current && generation.current === operation) { busy.current = false; setPending(false); }
    }
    if (verify && active.current) await load('verify', input);
  }

  const locked = pending || Boolean(access), waitingRetry = clock < retryAt;
  return <li className={`${row.row} ${row.overlayRow}`} data-chatbot-settings>
    <span className={row.icon} aria-hidden="true"><Bot size={21} /></span>
    <div className={row.summary}>
      <div className={row.heading}><h2 id={`${id}-title`}>채팅봇</h2><span data-chatbot-saved-state data-enabled={saved ? String(saved.enabled) : undefined}><StatusBadge tone={saved?.enabled ? 'positive' : 'neutral'}>{saved ? saved.enabled ? '사용 중' : '사용 안 함' : loading ? '불러오는 중' : '확인 필요'}</StatusBadge></span></div>
      <p>시청자가 명령어를 보내면 FRAME 봇이 설정한 응답을 보내요.</p>
    </div>
    <div className={`${row.overlayBody} ${styles.body}`}>
      {!online && <p className={styles.warning} role="status">인터넷에 연결되어 있지 않아요. 입력한 내용은 유지돼요. 연결 후 다시 시도해 주세요.</p>}
      {loading && !draft && <p className={styles.hint} role="status">채팅봇 설정을 불러오는 중이에요.</p>}
      {draft && saved && <form ref={form} className={styles.form} noValidate onSubmit={save} aria-labelledby={`${id}-title`} aria-busy={pending} data-chatbot-form>
        <div className={styles.topline}>
          <AuthCheckbox name="chatbot-enabled" checked={draft.enabled} disabled={locked} onChange={event => { setDraft({ ...draft, enabled: event.target.checked }); changed(); }}>채팅봇 사용</AuthCheckbox>
          {dirty && <StatusBadge tone="warning">저장하지 않은 변경</StatusBadge>}
        </div>
        <p className={styles.hint} id={`${id}-help`}>명령어 전체가 일치할 때 응답해요. 대소문자는 구분하지 않으며, 같은 명령어는 설정한 간격마다 한 번 응답해요.</p>
        <div className={styles.commandHeading}><h3>명령어와 자동 응답 <span>{draft.commands.length} / 20개</span></h3><button ref={addButton} type="button" className={ui.button} disabled={locked || draft.commands.length >= 20} onClick={addRule} data-chatbot-add><Plus size={16} aria-hidden="true" />명령어 추가</button></div>
        {draft.commands.length ? <ol className={styles.rules} aria-label="채팅봇 명령어">
          {draft.commands.map((item, index) => <li key={item.id} className={styles.rule} data-chatbot-rule data-command-id={item.id}>
            <div className={styles.ruleHeader}><AuthCheckbox name={`chatbot-rule-enabled-${item.id}`} checked={item.enabled} disabled={locked} onChange={event => updateRule(item.id, { enabled: event.target.checked })}>{index + 1}번 명령어 사용</AuthCheckbox><button type="button" className={`${ui.button} ${ui.quiet}`} disabled={locked} aria-label={`${index + 1}번 명령어 삭제`} onClick={() => deleteRule(item.id)} data-chatbot-delete><Trash2 size={16} aria-hidden="true" />삭제</button></div>
            <div className={styles.fields}>
              <label className={styles.field}>명령어<input ref={element => { if (element) commandInputs.current.set(item.id, element); else commandInputs.current.delete(item.id); }} className={ui.control} name={`chatbot-command-${item.id}`} value={item.command} maxLength={50} autoComplete="off" spellCheck={false} placeholder="!안내" disabled={locked} aria-invalid={invalid?.rule === item.id && invalid.field === 'command'} aria-describedby={invalid?.rule === item.id && invalid.field === 'command' ? `${id}-error` : `${id}-help`} onChange={event => updateRule(item.id, { command: event.target.value })} /></label>
              <label className={styles.field}>응답 간격<span className={styles.cooldown}><input className={ui.control} name={`chatbot-cooldown-${item.id}`} type="number" min={5} max={3600} step={1} inputMode="numeric" value={item.cooldownSeconds} disabled={locked} aria-invalid={invalid?.rule === item.id && invalid.field === 'cooldownSeconds'} aria-describedby={invalid?.rule === item.id && invalid.field === 'cooldownSeconds' ? `${id}-error` : `${id}-cooldown-help`} onChange={event => updateRule(item.id, { cooldownSeconds: event.target.value })} /><span>초</span></span></label>
              <label className={`${styles.field} ${styles.response}`}>자동 응답<textarea className={ui.control} name={`chatbot-response-${item.id}`} rows={2} value={item.response} maxLength={2000} placeholder="시청자에게 보낼 내용을 입력해 주세요" disabled={locked} aria-invalid={invalid?.rule === item.id && invalid.field === 'response'} aria-describedby={invalid?.rule === item.id && invalid.field === 'response' ? `${id}-error` : `${id}-response-help`} onChange={event => updateRule(item.id, { response: event.target.value })} /><small>{[...normalizeBotResponse(item.response)].length} / 500자</small></label>
            </div>
          </li>)}
        </ol> : <div className={styles.empty}><strong>등록된 명령어가 없어요.</strong><p>명령어를 추가하고 시청자에게 보낼 응답을 입력해 주세요.</p></div>}
        <p className={styles.hint}><span id={`${id}-cooldown-help`}>응답 간격 5~3,600초</span> · <span id={`${id}-response-help`}>응답의 줄바꿈과 연속 공백은 한 칸으로 저장돼요.</span></p>
        <div className={styles.footer}><p>{saved.updatedAtMs ? `최근 저장 ${dates.format(saved.updatedAtMs)}` : '아직 저장한 설정이 없어요.'}</p><div className={styles.actions}><button type="button" className={ui.button} disabled={locked || !dirty || conflict || Boolean(uncertain)} onClick={() => { setDraft(toDraft(saved)); setInvalid(null); setError(''); setNotice('변경한 내용을 취소했어요.'); }} data-chatbot-reset>변경 취소</button><button type="submit" className={`${ui.button} ${ui.primary}`} disabled={locked || !dirty || conflict || Boolean(uncertain) || !online || waitingRetry} data-chatbot-save>{pending ? '확인 중…' : '채팅봇 설정 저장'}</button></div></div>
      </form>}
      {error && <p id={`${id}-error`} className={styles.error} role="alert">{error}</p>}
      {access && <div className={styles.actions}><button type="button" className={ui.button} onClick={access === 'login' ? onRequireLogin : onSessionChanged ?? onRequireLogin}>{access === 'login' ? '로그인' : '계정 정보 새로고침'}</button></div>}
      {!access && !loading && !draft && <div><button type="button" className={ui.button} disabled={pending || !online || waitingRetry} onClick={() => void load('initial')} data-chatbot-retry><RefreshCw size={16} aria-hidden="true" />채팅봇 설정 다시 시도</button></div>}
      {conflict && !access && <div><button type="button" className={ui.button} disabled={pending || !online || waitingRetry} onClick={() => void load('refresh')} data-chatbot-refresh><RefreshCw size={16} aria-hidden="true" />최신 설정 확인</button></div>}
      {uncertain && !access && <div><button type="button" className={ui.button} disabled={pending || !online || waitingRetry} onClick={() => void load('verify', uncertain)} data-chatbot-verify><RefreshCw size={16} aria-hidden="true" />저장 결과 다시 확인</button></div>}
      {waitingRetry && <p className={styles.hint} role="status">요청이 많아요. {Math.max(1, Math.ceil((retryAt - clock) / 1000))}초 후 다시 시도해 주세요.</p>}
      <p ref={feedback} className={styles.success} role="status" aria-live="polite" tabIndex={-1}>{notice}</p>
    </div>
  </li>;
}
