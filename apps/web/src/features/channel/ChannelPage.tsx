import { BadgeCheck, Bell, BellRing, CalendarDays, ChevronRight, Clapperboard, Heart, Link2, Play, Radio, Share2, Shield, Video } from 'lucide-react';
import { useId, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { mediaWatchPath, type PreviewChannel, type PreviewVideo } from '../../preview/community-types';
import { type BroadcastSummary, watchPath } from '../../viewer-contract';
import { ChannelDetails, channelLinks } from './ChannelDetails';
import type { ChannelDetailMode, ChannelReportInput } from './ChannelDetails';
import styles from './ChannelPage.module.css';

const tabs = [
  { id: 'home', label: '홈' },
  { id: 'videos', label: '다시보기' },
  { id: 'clips', label: '클립' },
  { id: 'schedule', label: '방송 일정' },
  { id: 'about', label: '정보' },
  { id: 'posts', label: '게시글' },
] as const;

type ChannelTab = (typeof tabs)[number]['id'];

interface ChannelPageProps {
  channel: PreviewChannel | null;
  state: 'ready' | 'restricted';
  followed: boolean;
  notificationsOn: boolean;
  onToggleFollow: () => void;
  onToggleNotifications: () => void;
  actions?: ReactNode;
  pending?: boolean;
  actionError?: string;
  ownChannel?: boolean;
  notice?: string;
  scheduleFeedback?: ReactNode;
  signedIn?: boolean;
  onRequireLogin?: () => void;
  onReport?: (input: ChannelReportInput) => Promise<void>;
}

const count = new Intl.NumberFormat('ko-KR');

function Avatar({ name, src }: { name: string; src: string | null }) {
  return (
    <span className={styles.avatar} aria-hidden="true">
      {Array.from(name.trim())[0] ?? '?'}
      {src && <img key={src} src={src} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />}
    </span>
  );
}

function ChannelNotice({ title, icon, children, missing = false }: { title: string; icon: ReactNode; children?: ReactNode; missing?: boolean }) {
  return (
    <div className={styles.notice}>
      <span aria-hidden="true">{icon}</span>
      {missing ? <h1>{title}</h1> : <h2>{title}</h2>}
      {children}
    </div>
  );
}

function LiveCard({ broadcast, channel }: { broadcast: BroadcastSummary; channel: PreviewChannel }) {
  return (
    <Link className={styles.card} to={watchPath(broadcast)} aria-label={`${broadcast.title} 시청하기`}>
      <span className={styles.thumbnail}>
        <Radio size={29} aria-hidden="true" />
        {broadcast.thumbnailUrl && (
          <img key={broadcast.thumbnailUrl} src={broadcast.thumbnailUrl} alt="" decoding="async" onError={(event) => { event.currentTarget.hidden = true; }} />
        )}
        <span className={styles.play}><Play size={35} fill="currentColor" aria-hidden="true" /></span>
        <span className={styles.badge}>LIVE</span>
        {broadcast.viewerCount !== null && <span className={styles.viewers}>{count.format(broadcast.viewerCount)}명 시청</span>}
      </span>
      <span className={styles.cardDetails}>
        <Avatar name={channel.displayName} src={channel.avatarUrl} />
        <span><strong>{broadcast.title}</strong><small>{channel.displayName}</small></span>
      </span>
    </Link>
  );
}

function VideoList({ videos, handle }: { videos: readonly PreviewVideo[]; handle: string }) {
  return (
    <ul className={styles.videoGrid}>
      {videos.map((video) => (
        <li key={video.id} className={styles.videoItem}>
          <Link to={mediaWatchPath(video.kind, handle, video.id)} className={styles.videoLink}>
            <span className={styles.thumbnail} aria-hidden="true">
              <Video size={26} />
              <img src={video.thumbnailUrl} alt="" loading="lazy" decoding="async" onError={(event) => { event.currentTarget.hidden = true; }} />
              <span className={styles.duration}>{video.durationLabel}</span>
            </span>
            <h3>{video.title}</h3>
          </Link>
          <p>조회 {count.format(video.views)}회 · {video.publishedLabel}</p>
        </li>
      ))}
    </ul>
  );
}

function ChannelContent({ channel, activeTab, selectTab, scheduleFeedback, onShowDetails }: { channel: PreviewChannel; activeTab: ChannelTab; selectTab: (tab: ChannelTab) => void; scheduleFeedback?: ReactNode; onShowDetails: () => void }) {
  if (activeTab === 'videos' || activeTab === 'clips') {
    const isClip = activeTab === 'clips';
    const videos = channel.videos.filter((video) => video.kind === (isClip ? 'clip' : 'vod'));
    if (videos.length === 0) {
      return <ChannelNotice title={isClip ? '아직 클립이 없어요' : '아직 다시보기가 없어요'} icon={isClip ? <Clapperboard size={22} /> : <Video size={22} />} />;
    }
    return <><h2 className={styles.heading}>{isClip ? '클립' : '다시보기'}</h2><VideoList videos={videos} handle={channel.handle} /></>;
  }

  if (activeTab === 'schedule') {
    if (scheduleFeedback) return <><h2 className={styles.heading}>방송 일정</h2>{scheduleFeedback}</>;
    if (!channel.schedule.length) return <ChannelNotice title="예정된 방송이 없어요" icon={<CalendarDays size={22} />} />;
    return (
      <>
        <h2 className={styles.heading}>방송 일정</h2>
        <ul className={styles.entries}>
          {channel.schedule.map((item) => (
            <li key={item.id} className={styles.scheduleEntry}>
              <CalendarDays size={20} aria-hidden="true" />
              <div><h3>{item.title}</h3><p>{item.dateLabel} · {item.timeLabel}</p></div>
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (activeTab === 'about') {
    return (
      <div className={styles.about}>
        <h2 className={styles.heading}>채널 소개</h2>
        <p>{channel.description || '아직 등록된 채널 소개가 없어요.'}</p>
        <dl>
          <div><dt>채널 주소</dt><dd>@{channel.handle}</dd></div>
          <div><dt>팔로워</dt><dd>{count.format(channel.followerCount)}명</dd></div>
        </dl>
        <button type="button" className={styles.button} onClick={onShowDetails}>채널 정보 더보기<ChevronRight size={16} aria-hidden="true" /></button>
      </div>
    );
  }

  if (activeTab === 'posts') {
    if (!channel.posts.length) return <ChannelNotice title="아직 게시글이 없어요" icon={<Clapperboard size={22} />} />;
    return (
      <>
        <h2 className={styles.heading}>게시글</h2>
        <ul className={styles.entries}>
          {channel.posts.map((post) => (
            <li key={post.id} className={styles.post}>
              <h3>{post.title}</h3><small>{post.publishedLabel}</small><p>{post.body}</p>
            </li>
          ))}
        </ul>
      </>
    );
  }

  const upcoming = channel.schedule[0];
  const recent = channel.videos.filter((video) => video.kind === 'vod').slice(0, 3);
  return (
    <>
      <div className={styles.home}>
        {channel.liveBroadcast ? (
          <div><h2 className={styles.heading}>라이브</h2><LiveCard broadcast={channel.liveBroadcast} channel={channel} /></div>
        ) : (
          <div className={styles.offline}>
            <Video size={24} aria-hidden="true" />
            <div><h2>지금은 방송 중이 아니에요</h2><p>방송 일정을 확인하거나 다시보기를 둘러보세요.</p></div>
          </div>
        )}
        <div className={styles.summary}>
          <h2>방송 일정</h2>
          {scheduleFeedback ?? <p>{upcoming ? `${upcoming.dateLabel} · ${upcoming.timeLabel}` : '예정된 방송이 없어요.'}</p>}
          <button type="button" onClick={() => selectTab('schedule')}><ChevronRight size={17} aria-hidden="true" />방송 일정 보기</button>
        </div>
      </div>
      {recent.length > 0 && (
        <section className={styles.recent}>
          <div className={styles.sectionHeading}>
            <h2 className={styles.heading}>최근 다시보기</h2>
            <button type="button" className={styles.button} onClick={() => selectTab('videos')}>모두 보기<ChevronRight size={16} aria-hidden="true" /></button>
          </div>
          <VideoList videos={recent} handle={channel.handle} />
        </section>
      )}
    </>
  );
}

export function ChannelPage({ channel, state, followed, notificationsOn, onToggleFollow, onToggleNotifications, actions, pending = false, actionError, ownChannel = false, notice, scheduleFeedback, signedIn = false, onRequireLogin, onReport }: ChannelPageProps) {
  const [params, setParams] = useSearchParams();
  const tabId = useId();
  const requestedTab = params.get('tab');
  const activeTab = tabs.find((tab) => tab.id === requestedTab)?.id ?? 'home';
  const [detailMode, setDetailMode] = useState<ChannelDetailMode | null>(null);

  function selectTab(tab: ChannelTab, replace = false) {
    if (tab === activeTab) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (tab === 'home') next.delete('tab');
      else next.set('tab', tab);
      return next;
    }, { replace, preventScrollReset: true });
  }

  function focusTab(tab: ChannelTab) {
    document.getElementById(`${tabId}-${tab}`)?.focus();
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, current: ChannelTab) {
    const index = tabs.findIndex((tab) => tab.id === current);
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else return;
    event.preventDefault();
    selectTab(tabs[next].id, true);
    focusTab(tabs[next].id);
  }

  if (!channel) {
    return (
      <section className={styles.page}>
        <ChannelNotice title="채널을 찾을 수 없어요" icon={<Radio size={23} />} missing>
          <p>주소를 확인하거나 다른 방송을 둘러보세요.</p>
          <Link to="/live" className={styles.button}>라이브 목록</Link>
        </ChannelNotice>
      </section>
    );
  }

  const links = channelLinks(channel);

  return (
    <section className={styles.page} aria-label={`${channel.displayName} 채널`}>
      <div className={styles.cover}>
        {channel.bannerUrl && <img key={channel.bannerUrl} src={channel.bannerUrl} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <p aria-hidden="true">{channel.displayName}</p>
      </div>
      <header className={styles.profile}>
        <Avatar name={channel.displayName} src={channel.avatarUrl} />
        <div className={styles.profileCopy}>
          <h1>{channel.displayName}{channel.verified && <BadgeCheck className={styles.verified} size={20} role="img" aria-label="인증된 채널" />}</h1>
          <p className={styles.metadata}><span>@{channel.handle}</span><span>팔로워 {count.format(channel.followerCount)}명</span>
            {typeof channel.videoCount === 'number' && <span>동영상 {count.format(channel.videoCount)}개</span>}</p>
          <div className={styles.bioRow}>{channel.description && <p className={styles.bio}>{channel.description}</p>}
            {state === 'ready' && <button type="button" className={styles.more} aria-label="채널 정보 더보기" onClick={() => setDetailMode('about')}>{channel.description ? '더보기' : '채널 정보'}<ChevronRight size={14} aria-hidden="true" /></button>}</div>
          {state === 'ready' && links.length > 0 && <div className={styles.profileLinks}><Link2 size={15} aria-hidden="true" />
            <a href={links[0].url} target="_blank" rel="noopener noreferrer">{links[0].host}</a>
            {links.length > 1 && <button type="button" onClick={() => setDetailMode('about')}>외 링크 {links.length - 1}개</button>}</div>}
        </div>
        {state === 'ready' && (
          <div className={styles.actions}>
            {actions}
            <button type="button" className={styles.button} aria-label="채널 공유" onClick={() => setDetailMode('share')}><Share2 size={16} aria-hidden="true" />공유</button>
            {!ownChannel && <button type="button" className={`${styles.button} ${styles.follow}`} disabled={pending} onClick={onToggleFollow} aria-label={followed ? '팔로잉, 팔로우 취소' : '팔로우'} aria-pressed={followed}>
              <Heart size={17} fill={followed ? 'currentColor' : 'none'} aria-hidden="true" />{followed ? '팔로잉' : '팔로우'}
            </button>}
            {followed && !ownChannel && (
              <button type="button" className={`${styles.button} ${styles.notifications}`} disabled={pending} onClick={onToggleNotifications} aria-label={notificationsOn ? '알림 켜짐, 방송 알림 끄기' : '알림 받기, 방송 알림 켜기'} aria-pressed={notificationsOn}>
                {notificationsOn ? <BellRing size={17} aria-hidden="true" /> : <Bell size={17} aria-hidden="true" />}{notificationsOn ? '알림 켜짐' : '알림 받기'}
              </button>
            )}
          </div>
        )}
      </header>
      {actionError && <p className={styles.actionError} role="alert">{actionError}</p>}
      {notice && <p className={styles.channelNotice}>{notice}</p>}
      {state === 'restricted' ? (
        <ChannelNotice title="접근할 수 없는 채널이에요" icon={<Shield size={23} />}>
          <p>채널의 공개 범위를 확인해 주세요.</p>
          <Link to="/live" className={styles.button}>다른 방송 보기</Link>
        </ChannelNotice>
      ) : (
        <>
          <div className={styles.tabs} role="tablist" aria-label="채널 메뉴">
            {tabs.map((tab) => (
              <button type="button" key={tab.id} role="tab" id={`${tabId}-${tab.id}`} aria-controls={`${tabId}-panel`}
                aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => onTabKey(event, tab.id)}>{tab.label}</button>
            ))}
          </div>
          <div className={styles.panel} role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${activeTab}`} tabIndex={0}>
            <ChannelContent channel={channel} activeTab={activeTab} scheduleFeedback={scheduleFeedback} selectTab={(tab) => { selectTab(tab); focusTab(tab); }} onShowDetails={() => setDetailMode('about')} />
          </div>
        </>
      )}
      {detailMode && state === 'ready' && <ChannelDetails channel={channel} mode={detailMode} onModeChange={setDetailMode} onDismiss={() => setDetailMode(null)}
        ownChannel={ownChannel} signedIn={signedIn} onRequireLogin={onRequireLogin} onReport={onReport} />}
    </section>
  );
}
