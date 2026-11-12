import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { channelPath, mediaWatchPath, type PreviewChannel } from '../../preview/community-types';
import { watchPath } from '../../viewer-contract';
import { HistoryView, historyDateKey, historyFilterValues } from './HistoryView';
import type { HistoryEntry, HistoryRemoval } from './HistoryView';

const removedKey = 'frame.design-history-removed.v1';
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '');

function sampleEntries(channels: readonly PreviewChannel[]): HistoryEntry[] {
  const firstLive = channels.find(channel => channel.liveBroadcast);
  const entries: Omit<HistoryEntry, 'watchedAt'>[] = [];
  if (firstLive?.liveBroadcast) {
    const live = firstLive.liveBroadcast;
    entries.push({ id: 'live-' + live.id, publisher: firstLive.displayName, channelHref: channelPath(firstLive.handle),
      title: live.title, kind: 'live', thumbnailUrl: live.thumbnailUrl, duration: '라이브', progress: 0, href: watchPath(live) });
  }
  for (const [index, channel] of channels.entries()) {
    for (const [videoIndex, video] of channel.videos.entries()) {
      entries.push({ id: video.id, publisher: channel.displayName, channelHref: channelPath(channel.handle), kind: video.kind,
        title: video.title, thumbnailUrl: video.thumbnailUrl, duration: video.durationLabel, progress: [38, 67, 22, 100][(index + videoIndex) % 4],
        href: mediaWatchPath(video.kind, channel.handle, video.id) });
    }
  }
  if (firstLive) entries.push({ id: 'deleted-preview', publisher: firstLive.displayName, channelHref: channelPath(firstLive.handle),
    kind: 'vod', title: '지난 작업실 방송', thumbnailUrl: null, duration: '', progress: 0, href: null });
  const today = new Date(), midnight = new Date(today).setHours(0, 0, 0, 0);
  return entries.map((entry, index) => {
    const watchedAt = new Date(today);
    if (index < 3) watchedAt.setTime(Math.max(midnight, today.getTime() - index * 14 * 60_000));
    else { watchedAt.setDate(today.getDate() - Math.floor(index / 3)); watchedAt.setHours(21 - index % 3 * 2, 15, 0, 0); }
    return { ...entry, watchedAt };
  });
}
function readRemoved() {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(removedKey) ?? '[]'); return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []); }
  catch { return new Set<string>(); }
}

// Design-only fixture ownership stays outside the connected history view and its production bundle.
export function HistoryPage({ channels, signedIn, onLogin }: { channels: readonly PreviewChannel[]; signedIn: boolean; onLogin: () => void }) {
  const [params] = useSearchParams();
  const [fixtures] = useState(() => sampleEntries(channels));
  const [removed, setRemoved] = useState(readRemoved);
  const [lastRemoved, setLastRemoved] = useState<string[]>([]);
  const { kind, q, from, to } = historyFilterValues(params);
  const term = normalize(q);
  const entries = params.get('state') === 'empty' ? [] : fixtures.filter(entry => {
    const day = historyDateKey(entry.watchedAt);
    return !removed.has(entry.id) && (kind === 'all' || entry.kind === kind) && (!from || day >= from) && (!to || day <= to)
      && (!term || normalize(entry.title + ' ' + entry.publisher).includes(term));
  });
  function saveRemoved(next: Set<string>) {
    setRemoved(next);
    try { sessionStorage.setItem(removedKey, JSON.stringify([...next])); } catch { /* This design visit still keeps its selection. */ }
  }
  async function remove(request: HistoryRemoval) {
    const ids = request.kind === 'all' ? fixtures.filter(entry => !removed.has(entry.id)).map(entry => entry.id) : request.ids;
    saveRemoved(new Set([...removed, ...ids])); setLastRemoved(ids);
  }
  return <HistoryView entries={entries} signedIn={signedIn} onLogin={onLogin} onRemove={remove}
    onUndo={() => { saveRemoved(new Set([...removed].filter(id => !lastRemoved.includes(id)))); setLastRemoved([]); }} />;
}
