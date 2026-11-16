// One chat connection per broadcast. Product chat uses a one-use, cookie/CSRF-authenticated ticket; the legacy
// product-off relay keeps its nickname protocol. Drafts are never resent automatically after a disconnect or nack.
import type { ChatMessage, ChatView } from '../viewer-contract';
import { AccountError, accountApi } from '../features/account/account-client';
import { logRequest } from './runtime';
import { randomId, storageGet, storageSet } from './util';

const NAME_KEY = 'frame.chatName', KEEP = 300, ACK_TIMEOUT_MS = 10_000;
const RETRY = { tries: 6, maxMs: 30_000, longMs: 300_000 };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const messages: Record<string, string> = {
  CHAT_LOGIN_REQUIRED: '로그인하고 채팅에 참여해 주세요.',
  CHAT_AUTH_INVALID: '채팅 인증 정보를 다시 확인해 주세요.',
  CHAT_SESSION_EXPIRED: '로그인이 만료됐어요. 계정을 확인한 뒤 채팅에 다시 연결해 주세요.',
  SESSION_CHANGED: '로그인한 계정이 바뀌었어요. 채팅에 다시 연결해 주세요.',
  CHAT_BLOCKED: '이 채널에서 채팅 참여가 제한됐어요.',
  CHAT_FOLLOW_REQUIRED: '이 채널을 팔로우한 뒤 메시지를 보내 주세요.',
  CHAT_SLOW_MODE: '전송 간격을 지킨 뒤 다시 보내 주세요.',
  CHAT_LINK_BLOCKED: '이 채널에서는 링크를 보낼 수 없어요.',
  CHAT_WORD_BLOCKED: '채널의 채팅 규칙에 맞지 않는 내용이 있어요. 메시지를 수정해 주세요.',
  CHAT_CHANNEL_UNAVAILABLE: '아직 회원 채팅에 연결되지 않은 방송이에요.',
  CHAT_UNAVAILABLE: '채팅 권한을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
  CHAT_IDENTITY_FIXED: '채팅에서는 계정에 등록한 닉네임을 사용해요.',
};
const serverText: Record<string, string> = {
  '이름을 먼저 설정하십시오.': '닉네임을 먼저 설정해 주세요.',
  '메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내십시오.': '메시지를 너무 빠르게 보내고 있어요. 잠시 후 다시 보내 주세요.',
  '이미 사용 중인 이름입니다. 다른 이름을 설정하십시오.': '이미 사용 중인 닉네임이에요. 다른 닉네임을 입력해 주세요.',
  '사용할 수 없는 이름입니다.': '사용할 수 없는 닉네임이에요.',
  '1~20자의 이름을 입력하십시오.': '닉네임을 1~20자로 입력해 주세요.',
  '이름에 사용할 수 없는 문자가 있습니다.': '닉네임에 사용할 수 없는 문자가 있어요.',
  '이름을 확인하십시오.': '닉네임을 확인해 주세요.',
  '보낼 수 없는 문자가 있습니다.': '보낼 수 없는 문자가 있어요.',
  '메시지를 입력하십시오.': '메시지를 입력해 주세요.',
  '메시지를 확인하십시오.': '메시지를 확인해 주세요.',
  '메시지는 1000자까지 보낼 수 있습니다.': '메시지는 1,000자까지 보낼 수 있어요.',
};
const friendly = (value: unknown, fallback: string) => typeof value === 'string' && value ? serverText[value] ?? value : fallback;
type ServerMessage = { id?: unknown; broadcastId?: unknown; author?: unknown; text?: unknown; ts?: unknown; authorChannelId?: unknown; authorHandle?: unknown; isOwner?: unknown };

export class ChatClient {
  status: ChatView['status'] = 'connecting';
  nickname = '';
  messages: readonly ChatMessage[] = [];
  pending = false;
  error: string | null = null;
  lastAckId: string | null = null;
  account: ChatView['account'] = { state: 'checking', userId: null };
  canSend = false;
  restriction: ChatView['restriction'];
  policy: ChatView['policy'];

  private ws: WebSocket | null = null;
  private seen = new Set<string>();
  private retries = 0;
  private timer = 0;
  private ackTimer = 0;
  private nameTimer = 0;
  private joinTimer = 0;
  private restrictionTimer = 0;
  private pendingId: string | null = null;
  private closed = false;
  private paused = false;
  private started = false;
  private legacy = false;
  private generation = 0;
  private expectedUserId: string | null = null;
  private authAbort: AbortController | null = null;

  constructor(private readonly path: string, private readonly broadcastId: string, private readonly onChange: () => void,
    private readonly options: { readOnly?: boolean } = {}) {}

  open() { if (!this.started && !this.closed) { this.started = true; void this.connect(); } }
  close() {
    if (this.closed) return;
    this.closed = true; this.stopConnection();
    this.endPending('채팅 연결이 종료돼 메시지를 보내지 못했어요.');
    this.canSend = false; this.status = 'closed'; this.changed();
  }
  reconnect() {
    if (this.closed || !this.started) return;
    this.stopConnection(); this.endPending('연결을 다시 확인해 메시지를 보내지 못했어요.');
    this.paused = false; this.retries = 0; this.canSend = false; this.error = null; this.restriction = undefined;
    this.status = 'connecting'; this.changed(); void this.connect();
  }
  send(text: string) {
    if (this.options.readOnly) return;
    if (this.pending) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== 'connected' || this.paused) {
      this.error = '채팅에 연결되어 있지 않아요.'; this.changed(); return;
    }
    if (!this.canSend || (this.restriction?.retryAtMs ?? 0) > Date.now()) {
      this.error = this.restriction?.message ?? '지금은 채팅을 보낼 수 없어요.'; this.changed(); return;
    }
    const clientId = randomId(); this.pendingId = clientId; this.pending = true; this.error = null; this.restriction = undefined;
    try { ws.send(JSON.stringify({ type: 'send', clientId, text })); }
    catch { this.endPending('메시지를 보내지 못했어요. 연결을 다시 확인해 주세요.'); this.changed(); return; }
    window.clearTimeout(this.ackTimer);
    this.ackTimer = window.setTimeout(() => { this.endPending('전송 결과를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.'); this.changed(); }, ACK_TIMEOUT_MS);
    this.changed();
  }
  setNickname(name: string) {
    if (this.options.readOnly) return;
    if (this.account) { this.error = messages.CHAT_IDENTITY_FIXED; this.changed(); return; }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== 'connected') { this.error = '채팅에 연결되어 있지 않아요.'; this.changed(); return; }
    this.error = null; ws.send(JSON.stringify({ type: 'name', name }));
    window.clearTimeout(this.nameTimer);
    this.nameTimer = window.setTimeout(() => { this.error = '닉네임을 설정하지 못했어요. 다시 시도해 주세요.'; this.changed(); }, ACK_TIMEOUT_MS);
    this.changed();
  }
  private changed() { if (this.started) this.onChange(); }
  private endPending(error: string) {
    window.clearTimeout(this.ackTimer);
    if (!this.pending) return;
    this.pendingId = null; this.error = error; this.pending = false;
  }
  private stopConnection() {
    ++this.generation; this.authAbort?.abort(); this.authAbort = null;
    for (const timer of [this.timer, this.nameTimer, this.joinTimer, this.restrictionTimer]) window.clearTimeout(timer);
    const ws = this.ws; this.ws = null;
    try { ws?.close(1000); } catch { /* Already closed. */ }
  }
  private pauseAccount(state: 'expired' | 'changed', code: string, message: string) {
    this.stopConnection(); this.paused = true; this.canSend = false; this.status = 'closed';
    this.endPending(message); this.error = message;
    this.account = { state, userId: this.expectedUserId ?? this.account?.userId ?? null };
    this.restriction = { code, message }; this.changed();
  }
  private async connect() {
    if (this.closed || this.paused) return;
    const version = ++this.generation, abort = new AbortController(); this.authAbort?.abort(); this.authAbort = abort;
    this.canSend = false; this.account = this.options.readOnly ? undefined : { state: 'checking', userId: this.expectedUserId }; this.lastAckId = null; this.changed();
    let ticket: string | undefined;
    if (!this.options.readOnly) try {
      let session;
      try { session = await accountApi.session(abort.signal); }
      catch (failure) {
        // Only an absent product API enables the comparison relay's old nickname protocol.
        if (failure instanceof AccountError && failure.status === 404) { this.legacy = true; this.account = undefined; this.expectedUserId = null; }
        else throw failure;
      }
      if (abort.signal.aborted || this.closed || this.paused || this.generation !== version) return;
      if (session) {
        this.legacy = false; this.expectedUserId = session.user?.id ?? null;
        this.nickname = session.user?.displayName ?? '';
        this.account = { state: session.user ? 'checking' : 'anonymous', userId: this.expectedUserId };
        if (session.user) ticket = (await accountApi.createChatTicket({ path: this.path, broadcastId: this.broadcastId }, session.csrfToken, session.user.id, abort.signal)).ticket;
      }
    } catch (failure) {
      if (abort.signal.aborted || this.closed || this.generation !== version) return;
      if (failure instanceof AccountError && (failure.status === 401 || failure.code === 'SESSION_CHANGED' || failure.code === 'CSRF_INVALID')) {
        const expired = failure.status === 401;
        this.pauseAccount(expired ? 'expired' : 'changed', expired ? 'CHAT_SESSION_EXPIRED' : 'SESSION_CHANGED', expired ? messages.CHAT_SESSION_EXPIRED : messages.SESSION_CHANGED); return;
      }
      this.status = 'reconnecting'; this.error = friendly(failure instanceof Error ? failure.message : null, messages.CHAT_UNAVAILABLE);
      this.restriction = { code: 'CHAT_UNAVAILABLE', message: this.error }; this.changed(); this.retry(); return;
    }
    if (abort.signal.aborted || this.closed || this.paused || this.generation !== version) return;
    const url = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/${encodeURIComponent(this.path)}/chat`;
    logRequest(url);
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.status = 'reconnecting'; this.changed(); this.retry(); return; }
    this.ws = ws; this.seen = new Set();
    this.joinTimer = window.setTimeout(() => {
      if (this.ws !== ws || this.status === 'connected') return;
      this.ws = null; try { ws.close(1000); } catch { /* Ignore. */ }
      this.status = 'reconnecting'; this.error = '채팅 연결을 확인하지 못했어요. 다시 연결하고 있어요.'; this.changed(); this.retry();
    }, ACK_TIMEOUT_MS);
    ws.addEventListener('open', () => {
      if (this.ws !== ws || this.closed || this.generation !== version) return;
      ws.send(JSON.stringify({ type: 'join', broadcastId: this.broadcastId, ...(ticket ? { ticket } : {}), ...(this.legacy ? { name: storageGet(NAME_KEY) } : {}) })); ticket = undefined;
    });
    ws.addEventListener('message', event => { if (this.ws === ws && this.generation === version && typeof event.data === 'string') this.onMessage(ws, event.data); });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null; window.clearTimeout(this.joinTimer); window.clearTimeout(this.restrictionTimer);
      this.endPending('채팅 연결이 끊어져 메시지를 보내지 못했어요.'); window.clearTimeout(this.nameTimer); this.canSend = false;
      if (this.closed || this.paused) return;
      this.status = 'reconnecting'; this.changed(); this.retry();
    });
  }
  private retry() {
    if (this.closed || this.paused) return;
    const attempt = this.retries++, base = attempt >= RETRY.tries ? RETRY.longMs : Math.min(RETRY.maxMs, 1000 * 2 ** attempt);
    window.clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.connect(), base * (0.7 + Math.random() * 0.6));
  }
  private restrict(code: string, error: unknown, retryAfterMs?: unknown) {
    const message = messages[code] ?? friendly(error, '메시지를 보내지 못했어요.');
    const delay = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, 86400000) : 0;
    const restriction = { code, message, ...(delay ? { retryAtMs: Date.now() + delay } : {}) };
    this.restriction = restriction; this.error = message; window.clearTimeout(this.restrictionTimer);
    if (code === 'CHAT_BLOCKED' || code === 'CHAT_CHANNEL_UNAVAILABLE' || code === 'CHAT_LOGIN_REQUIRED') this.canSend = false;
    if (delay) this.restrictionTimer = window.setTimeout(() => {
      if (this.closed || this.paused || this.restriction !== restriction) return;
      if (code === 'CHAT_BLOCKED') {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'join', broadcastId: this.broadcastId }));
      } else { this.restriction = undefined; this.error = null; this.changed(); }
    }, delay + 50);
  }
  private toMessage(item: ServerMessage): ChatMessage | null {
    if (typeof item.id !== 'string' || typeof item.text !== 'string' || (typeof item.broadcastId === 'string' && item.broadcastId !== this.broadcastId)) return null;
    if (this.options.readOnly && (!item.id || item.id.length > 128 || item.text.length > 4000 || typeof item.author !== 'string' || item.author.length > 200
      || typeof item.ts !== 'number' || !Number.isSafeInteger(item.ts) || item.ts < 0)) return null;
    return { id: item.id, author: typeof item.author === 'string' ? item.author : '', text: item.text,
      sentAtMs: typeof item.ts === 'number' && Number.isFinite(item.ts) && item.ts >= 0 ? item.ts : Date.now(),
      ...(typeof item.authorChannelId === 'string' && uuid.test(item.authorChannelId) ? { authorChannelId: item.authorChannelId } : {}),
      ...(typeof item.authorHandle === 'string' && /^[a-z][a-z0-9_-]{2,23}$/.test(item.authorHandle) ? { authorHandle: item.authorHandle } : {}),
      ...(typeof item.isOwner === 'boolean' ? { isOwner: item.isOwner } : {}) };
  }
  private onMessage(ws: WebSocket, data: string) {
    let event: Record<string, unknown>;
    try { const value: unknown = JSON.parse(data); if (!value || typeof value !== 'object' || Array.isArray(value)) return; event = value as Record<string, unknown>; } catch { return; }
    if (typeof event.broadcastId === 'string' && event.broadcastId !== this.broadcastId) return;
    switch (event.type) {
      case 'state': {
        const code = typeof event.code === 'string' ? event.code : '';
        if (!this.options.readOnly && (code === 'CHAT_AUTH_INVALID' || code === 'CHAT_SESSION_EXPIRED' || code === 'SESSION_CHANGED')) {
          this.pauseAccount(code === 'CHAT_SESSION_EXPIRED' ? 'expired' : 'changed', code, messages[code] ?? messages.CHAT_AUTH_INVALID); return;
        }
        if (event.connected !== true) {
          this.closed = true; this.stopConnection(); this.endPending('채팅이 종료돼 메시지를 보내지 못했어요.'); this.canSend = false; this.status = 'closed'; break;
        }
        if (!this.options.readOnly && (!this.legacy || typeof event.authenticated === 'boolean')) {
          this.legacy = false;
          if (event.authenticated === true) {
            if (typeof event.userId !== 'string' || !uuid.test(event.userId) || event.userId !== this.expectedUserId) { this.pauseAccount('changed', 'SESSION_CHANGED', messages.SESSION_CHANGED); return; }
            this.account = { state: 'authenticated', userId: event.userId };
          } else if (event.authenticated === false && !this.expectedUserId) this.account = { state: 'anonymous', userId: null };
          else { this.pauseAccount('changed', 'CHAT_AUTH_INVALID', messages.CHAT_AUTH_INVALID); return; }
        }
        window.clearTimeout(this.joinTimer); window.clearTimeout(this.restrictionTimer); this.retries = 0; this.status = 'connected';
        this.nickname = typeof event.displayName === 'string' ? event.displayName : '';
        this.canSend = !this.options.readOnly && event.canSend === true && (!this.account || this.account.state === 'authenticated'); this.restriction = undefined; this.error = null;
        const policy = event.policy as Record<string, unknown> | null;
        if (policy && typeof policy.slowMode === 'boolean' && typeof policy.slowSeconds === 'number' && Number.isInteger(policy.slowSeconds) && policy.slowSeconds >= 1 && policy.slowSeconds <= 120
          && typeof policy.followersOnly === 'boolean' && typeof policy.blockLinks === 'boolean') this.policy = { slowMode: policy.slowMode, slowSeconds: policy.slowSeconds, followersOnly: policy.followersOnly, blockLinks: policy.blockLinks };
        if (code && !(this.options.readOnly && code === 'CHAT_LOGIN_REQUIRED')) this.restrict(code, event.error, event.retryAfterMs);
        break;
      }
      case 'history': {
        const list = Array.isArray(event.messages) ? event.messages : [], next: ChatMessage[] = []; this.seen = new Set();
        for (const value of list) { const message = value && typeof value === 'object' ? this.toMessage(value as ServerMessage) : null; if (!message || this.seen.has(message.id)) continue; this.seen.add(message.id); next.push(message); }
        this.messages = next.slice(-KEEP); break;
      }
      case 'message': {
        const message = this.toMessage(event as ServerMessage); if (!message || this.seen.has(message.id)) return;
        this.seen.add(message.id); this.messages = [...this.messages, message].slice(-KEEP);
        if (this.options.readOnly && this.seen.size > KEEP * 2) this.seen = new Set(this.messages.map(item => item.id));
        break;
      }
      case 'ack': {
        if (!this.pending || event.clientId !== this.pendingId) return;
        window.clearTimeout(this.ackTimer); this.pendingId = null; this.pending = false;
        if (event.ok === true) { this.error = null; this.restriction = undefined; this.lastAckId = typeof event.id === 'string' ? event.id : null; }
        else {
          const code = typeof event.code === 'string' ? event.code : '';
          if (code === 'CHAT_SESSION_EXPIRED' || code === 'CHAT_AUTH_INVALID' || code === 'SESSION_CHANGED') { this.pauseAccount(code === 'CHAT_SESSION_EXPIRED' ? 'expired' : 'changed', code, messages[code] ?? messages.CHAT_AUTH_INVALID); return; }
          if (code === 'CHAT_LOGIN_REQUIRED') {
            if (this.expectedUserId) { this.pauseAccount('expired', 'CHAT_SESSION_EXPIRED', messages.CHAT_SESSION_EXPIRED); return; }
            this.account = { state: 'anonymous', userId: null };
          }
          this.restrict(code, event.error, event.retryAfterMs);
        }
        break;
      }
      case 'name': {
        window.clearTimeout(this.nameTimer);
        if (this.account) { this.error = messages.CHAT_IDENTITY_FIXED; break; }
        if (typeof event.displayName === 'string') this.nickname = event.displayName;
        if (event.ok === true) { this.error = null; if (this.nickname) storageSet(NAME_KEY, this.nickname); }
        else this.error = friendly(event.error, '닉네임을 바꿀 수 없어요.'); break;
      }
      case 'closed': this.closed = true; this.stopConnection(); this.endPending('채팅이 종료돼 메시지를 보내지 못했어요.'); this.canSend = false; this.status = 'closed'; break;
      default: return;
    }
    this.changed();
  }
}
