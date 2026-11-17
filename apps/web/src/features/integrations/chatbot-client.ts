import { AccountError } from '../account/account-client';

export type ChatBotCommand = { id: string; command: string; response: string; enabled: boolean; cooldownSeconds: number };
export type ChatBotInput = { version: number; enabled: boolean; commands: ChatBotCommand[] };
export type ChatBotSettings = ChatBotInput & { userId: string; channelId: string; updatedAtMs: number };

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const normalizeBotCommand = (text: string) => text.normalize('NFC').trim().toLowerCase();
export const normalizeBotResponse = (text: string) => text.normalize('NFC').trim().replace(/\s+/gu, ' ');
export const validBotCommand = (text: string) => /^![a-z0-9_가-힣]{1,20}$/.test(text);
export const validBotResponse = (text: string) => [...text].length >= 1 && [...text].length <= 500 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new AccountError('채팅봇 설정 응답을 확인하지 못했어요. 다시 확인해 주세요.', 'INVALID_RESPONSE', 0); }

function settings(value: unknown, userId: string, channelId: string): ChatBotSettings {
  if (!record(value) || typeof value.userId !== 'string' || !uuid.test(value.userId) || typeof value.channelId !== 'string' || !uuid.test(value.channelId)) invalid();
  if (value.userId !== userId || value.channelId !== channelId) throw new AccountError('로그인한 계정이나 채널이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 0 || !Number.isSafeInteger(value.updatedAtMs) || Number(value.updatedAtMs) < 0
    || !Number.isFinite(new Date(Number(value.updatedAtMs)).getTime()) || typeof value.enabled !== 'boolean' || !Array.isArray(value.commands) || value.commands.length > 20) invalid();
  const commands = value.commands.map((item: unknown): ChatBotCommand => {
    if (!record(item) || typeof item.id !== 'string' || !uuid.test(item.id) || typeof item.command !== 'string' || !validBotCommand(item.command)
      || normalizeBotCommand(item.command) !== item.command || typeof item.response !== 'string' || !validBotResponse(item.response)
      || normalizeBotResponse(item.response) !== item.response || typeof item.enabled !== 'boolean' || !Number.isSafeInteger(item.cooldownSeconds)
      || Number(item.cooldownSeconds) < 5 || Number(item.cooldownSeconds) > 3600) invalid();
    return { id: item.id, command: item.command, response: item.response, enabled: item.enabled, cooldownSeconds: Number(item.cooldownSeconds) };
  });
  if (new Set(commands.map(item => item.id)).size !== commands.length || new Set(commands.map(item => item.command)).size !== commands.length) invalid();
  return { userId, channelId, version: Number(value.version), updatedAtMs: Number(value.updatedAtMs), enabled: value.enabled, commands };
}

async function request(userId: string, channelId: string, signal: AbortSignal, input?: ChatBotInput, csrfToken?: string): Promise<ChatBotSettings> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-FRAME-USER-ID': userId };
  if (input) {
    if (!csrfToken) throw new AccountError('로그인 정보를 다시 확인해 주세요.', 'SESSION_REQUIRED', 401);
    headers['Content-Type'] = 'application/json'; headers['X-CSRF-TOKEN'] = csrfToken;
  }
  let response: Response;
  try {
    response = await fetch('/api/v1/me/chat/bot', { method: input ? 'PATCH' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers,
      ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  } catch (failure) {
    if (signal.aborted) throw failure;
    throw new AccountError('서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.', 'NETWORK_ERROR', 0);
  }
  let value: unknown;
  try { value = await response.json(); } catch { value = null; }
  if (!response.ok) {
    const body = record(value) ? value : {};
    const raw = response.headers.get('Retry-After');
    const retryAfterMs = raw && /^\d{1,6}$/.test(raw) ? Math.min(Number(raw) * 1000, 86400000) : undefined;
    throw new AccountError(typeof body.detail === 'string' ? body.detail.slice(0, 300) : '채팅봇 설정 요청을 처리하지 못했어요.',
      typeof body.code === 'string' ? body.code : 'REQUEST_FAILED', response.status, retryAfterMs);
  }
  if (response.status !== 200) invalid();
  return settings(value, userId, channelId);
}

export const chatBotApi = {
  settings: (userId: string, channelId: string, signal: AbortSignal) => request(userId, channelId, signal),
  save: (input: ChatBotInput, csrfToken: string, userId: string, channelId: string, signal: AbortSignal) => request(userId, channelId, signal, input, csrfToken),
};
