import { AccountError, accountRequest, historyItem } from '../account/account-client';
import type { WatchHistoryItem } from '../account/account-client';

export type ArchiveKind = 'vod' | 'clip';
export type ArchiveHistoryItem = Extract<WatchHistoryItem, { kind: ArchiveKind }>;
export type ArchiveHistoryReceipt = { userId: string; item: ArchiveHistoryItem | null; epoch: number; serverNowMs: number };
export type ArchiveHistoryUpdate = { epoch: number; id: string | null; version: number; positionMs: number; completed: boolean };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function receipt(value: unknown, kind: ArchiveKind, mediaId: string, owner: string): ArchiveHistoryReceipt {
  const data = value as ArchiveHistoryReceipt | null;
  if (!data || typeof data.userId !== 'string' || !uuid.test(data.userId)) throw new AccountError('시청 기록 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  if (data.userId !== owner) throw new AccountError('로그인한 계정이 바뀌었어요. 계정 정보를 다시 확인해 주세요.', 'SESSION_CHANGED', 409);
  if (!Number.isSafeInteger(data.epoch) || data.epoch < 0 || !Number.isSafeInteger(data.serverNowMs) || data.serverNowMs <= 0 || !Number.isFinite(new Date(data.serverNowMs).getTime())) {
    throw new AccountError('시청 기록 정보를 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  }
  const item = data.item === null ? null : historyItem(data.item);
  if (item && (item.kind !== kind || item.mediaId !== mediaId || !item.available)) throw new AccountError('영상의 시청 기록을 확인하지 못했어요.', 'INVALID_RESPONSE', 0);
  return { ...data, item: item as ArchiveHistoryItem | null };
}

const path = (kind: ArchiveKind, id: string) => `/me/history/media/${kind}/${encodeURIComponent(id)}`;
export const archiveHistoryApi = {
  async get(kind: ArchiveKind, id: string, owner: string, signal: AbortSignal) {
    return receipt(await accountRequest(path(kind, id), { signal, headers: { 'X-FRAME-USER-ID': owner } }), kind, id, owner);
  },
  async put(kind: ArchiveKind, id: string, input: ArchiveHistoryUpdate, owner: string, csrf: string, signal: AbortSignal) {
    return receipt(await accountRequest(path(kind, id), { method: 'PUT', signal, keepalive: true, headers: { 'X-FRAME-USER-ID': owner }, body: JSON.stringify(input) }, csrf), kind, id, owner);
  },
};

export function sameArchiveReceipt(a: ArchiveHistoryReceipt, b: ArchiveHistoryReceipt) {
  return a.epoch === b.epoch && a.item?.id === b.item?.id && a.item?.version === b.item?.version
    && a.item?.positionMs === b.item?.positionMs && a.item?.completed === b.item?.completed;
}
