import { Bell, ChevronRight, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { channelPath, mediaWatchPath, type PreviewChannel } from '../../preview/community-types';
import { watchPath } from '../../viewer-contract';
import styles from './NotificationsPage.module.css';

type Notification = {
  id: string;
  channel: PreviewChannel;
  title: string;
  detail: string;
  time: string;
  href: string;
};

const readKey = 'frame.design-notifications.v1';

function readNotificationIds() {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(readKey) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function sampleNotifications(channels: readonly PreviewChannel[]) {
  const items: Notification[] = [];
  const live = channels.find(channel => channel.handle === 'spring');
  if (live?.liveBroadcast) items.push({
    id: `live-${live.liveBroadcast.id}`, channel: live, title: `${live.displayName} 님이 방송을 시작했어요.`,
    detail: live.liveBroadcast.title, time: '지금', href: watchPath(live.liveBroadcast),
  });

  const uploader = channels.find(channel => channel.handle === 'pado');
  const video = uploader?.videos.find(item => item.kind === 'vod');
  if (uploader && video) items.push({
    id: `vod-${video.id}`, channel: uploader, title: `${uploader.displayName} 님이 다시보기를 공개했어요.`,
    detail: video.title, time: '1시간 전', href: mediaWatchPath(video.kind, uploader.handle, video.id),
  });

  const host = channels.find(channel => channel.handle === 'green');
  const scheduled = host?.schedule[0];
  if (host && scheduled) items.push({
    id: `schedule-${scheduled.id}`, channel: host, title: `${host.displayName} 님의 방송이 곧 시작돼요.`,
    detail: `${scheduled.dateLabel} ${scheduled.timeLabel} · ${scheduled.title}`, time: '2시간 전',
    href: `${channelPath(host.handle)}?tab=schedule`,
  });
  return items;
}

export function NotificationsPage({ channels, signedIn, onLogin }: {
  channels: readonly PreviewChannel[];
  signedIn: boolean;
  onLogin: () => void;
}) {
  const [params] = useSearchParams();
  const [readIds, setReadIds] = useState(readNotificationIds);
  const items = signedIn && params.get('state') !== 'empty' ? sampleNotifications(channels) : [];
  const unreadCount = items.filter(item => !readIds.has(item.id)).length;

  function markRead(ids: string[]) {
    const next = new Set([...readIds, ...ids]);
    setReadIds(next);
    try { sessionStorage.setItem(readKey, JSON.stringify([...next])); }
    catch { /* Read status is still available for this visit. */ }
  }

  return (
    <section className={styles.page} aria-labelledby="notifications-title">
      <div className={styles.heading}>
        <h1 id="notifications-title">알림</h1>
        {signedIn && <button type="button" className={styles.readAll} disabled={unreadCount === 0}
          onClick={() => markRead(items.map(item => item.id))}>모두 읽기</button>}
      </div>
      {!signedIn ? (
        <div className={styles.notice}>
          <span className={styles.noticeIcon}><UserRound size={23} strokeWidth={1.7} aria-hidden="true" /></span>
          <h2>알림을 보려면 로그인하세요</h2>
          <button type="button" className={styles.primary} onClick={onLogin}>로그인</button>
        </div>
      ) : !items.length ? (
        <div className={styles.notice}>
          <span className={styles.noticeIcon}><Bell size={23} strokeWidth={1.7} aria-hidden="true" /></span>
          <h2>새로운 알림이 없어요</h2>
        </div>
      ) : (
        <ul className={styles.list}>
          {items.map(item => {
            const isRead = readIds.has(item.id);
            return (
              <li key={item.id}>
                <Link to={item.href} className={styles.item} data-read={isRead}
                  onClick={() => markRead([item.id])}>
                  <span className={styles.avatar} aria-hidden="true">
                    {item.channel.avatarUrl ? <img src={item.channel.avatarUrl} alt="" /> : Array.from(item.channel.displayName)[0]}
                  </span>
                  <span className={styles.copy}>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                    <small>{item.time}</small>
                  </span>
                  <span className={styles.visuallyHidden}>{isRead ? '읽음' : '읽지 않음'}</span>
                  {!isRead && <span className={styles.unread} aria-hidden="true" />}
                  <ChevronRight className={styles.chevron} size={18} aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className={styles.visuallyHidden} role="status">{signedIn && items.length ? `읽지 않은 알림 ${unreadCount}개` : ''}</p>
    </section>
  );
}
