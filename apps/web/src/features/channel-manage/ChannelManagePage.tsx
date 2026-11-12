import { Camera, Check, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PreviewChannel } from '../../preview/community-types';
import { channelPath } from '../../preview/community-types';
import studio from '../../preview/assets/creative-studio.webp';
import forest from '../../preview/assets/forest-game.webp';
import city from '../../preview/assets/night-drive.webp';
import { ManagementPage } from '../../components/management/ManagementUI';
import ui from '../../components/management/ManagementUI.module.css';
import styles from './ChannelManagePage.module.css';

const bannerPresets = [
  { label: '작업실', image: studio },
  { label: '숲', image: forest },
  { label: '도시', image: city },
];

const formatCount = new Intl.NumberFormat('ko-KR');

function ChannelAvatar({ channel }: { channel: PreviewChannel }) {
  const nameEnd = channel.displayName.trim().split(/\s+/).at(-1) ?? '';
  return (
    <span className={styles.avatar} aria-hidden="true">
      {channel.avatarUrl ? <img src={channel.avatarUrl} alt="" /> : (Array.from(nameEnd)[0] ?? 'F')}
    </span>
  );
}

function ChannelPreview({ channel, banner }: { channel: PreviewChannel; banner: string | null }) {
  return (
    <aside className={styles.preview} aria-label="채널 미리보기">
      <h2>채널 미리보기</h2>
      <div className={styles.previewCard}>
        <div className={styles.previewBanner}>{banner && <img src={banner} alt="채널 배너" />}</div>
        <div className={styles.previewProfile}>
          <ChannelAvatar channel={channel} />
          <strong>{channel.displayName}</strong>
          <span>@{channel.handle}</span>
          <p>{channel.description}</p>
          <span className={styles.followerCount}>팔로워 {formatCount.format(channel.followerCount)}명</span>
        </div>
        <div className={styles.previewTabs} aria-hidden="true">
          <strong>홈</strong><span>다시보기</span><span>클립</span><span>정보</span>
        </div>
      </div>
    </aside>
  );
}

function SaveBar({ onReset }: { onReset?: () => void }) {
  return (
    <div className={styles.saveBar}>
      <button type="button" className={ui.button} onClick={onReset} disabled={!onReset}>취소</button>
      <button type="button" className={`${ui.button} ${ui.primary}`} disabled>저장</button>
    </div>
  );
}

function BasicInfo({ channel }: { channel: PreviewChannel }) {
  const category = channel.liveBroadcast?.category;
  return (
    <section className={styles.editor} aria-label="기본 정보">
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>채널 이름</span>
          <input className={ui.control} value={channel.displayName} readOnly />
        </label>
        <label className={styles.field}>
          <span>채널 소개</span>
          <textarea className={ui.control} rows={3} value={channel.description} readOnly />
        </label>
        <div className={styles.field}>
          <label htmlFor="channel-manage-handle">채널 주소</label>
          <input className={ui.control} id="channel-manage-handle" value={`frame.app/@${channel.handle}`} aria-describedby="channel-manage-handle-help" readOnly />
          <small id="channel-manage-handle-help">영문·숫자로 시작하는 3~24자, 밑줄(_)·하이픈(-)을 사용할 수 있어요.</small>
        </div>
        <div className={styles.fieldPair}>
          <div className={styles.field}>
            <span id="channel-manage-category">주요 콘텐츠</span>
            <button type="button" className={`${ui.button} ${styles.choice}`} aria-labelledby="channel-manage-category channel-manage-category-value" disabled>
              <span id="channel-manage-category-value">{category === '개발' ? '개발 · 작업' : (category ?? '미설정')}</span>
              <ChevronDown size={17} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.field}>
            <span id="channel-manage-visibility">기본 공개 범위</span>
            <button type="button" className={`${ui.button} ${styles.choice}`} aria-labelledby="channel-manage-visibility channel-manage-visibility-value" disabled>
              <span id="channel-manage-visibility-value">전체 공개</span><ChevronDown size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
        <label className={styles.field}>
          <span>채널 공지</span>
          <textarea className={ui.control} rows={2} value={channel.handle === 'spring' ? '매주 화요일과 목요일 오후 8시에 만나요.' : ''} readOnly />
        </label>
      </div>
      <div className={styles.social}>
        <div className={styles.subheading}><h2>소셜 링크</h2><span>0 / 5</span></div>
        <button type="button" className={ui.button} disabled><Plus size={17} aria-hidden="true" />링크 추가</button>
      </div>
      <SaveBar />
    </section>
  );
}

function Branding({ channel, banner, onBanner }: {
  channel: PreviewChannel;
  banner: string | null;
  onBanner: (banner: string | null) => void;
}) {
  return (
    <section className={styles.editor} aria-label="브랜딩">
      <div className={styles.brandingBlock}>
        <div className={styles.subheading}><h2>프로필 사진</h2></div>
        <div className={styles.avatarEditor}>
          <ChannelAvatar channel={channel} />
          <button type="button" className={ui.button} disabled><Camera size={17} aria-hidden="true" />이미지 변경</button>
        </div>
      </div>
      <div className={styles.brandingBlock}>
        <div className={styles.subheading}>
          <h2>배너 이미지</h2>
          <button type="button" className={`${ui.button} ${ui.quiet}`} disabled><Camera size={17} aria-hidden="true" />이미지 선택</button>
        </div>
        <div className={styles.bannerEditor}>{banner && <img src={banner} alt="현재 채널 배너" />}</div>
        <div className={styles.bannerOptions} role="group" aria-label="배너 이미지 선택">
          {bannerPresets.map(({ label, image }) => (
            <button key={label} type="button" aria-label={`${label} 배너 선택`} aria-pressed={banner === image} onClick={() => onBanner(image)}>
              <img src={image} alt="" />
              {banner === image && <span className={styles.selectedMark}><Check size={14} aria-hidden="true" /></span>}
            </button>
          ))}
        </div>
        <p className={styles.bannerHint}>선택한 배너는 이 화면에서 미리 볼 수 있어요.</p>
      </div>
      <SaveBar onReset={banner === channel.bannerUrl ? undefined : () => onBanner(channel.bannerUrl)} />
    </section>
  );
}

export function ChannelManagePage({ channel }: { channel: PreviewChannel }) {
  const [params] = useSearchParams();
  const [banner, setBanner] = useState(channel.bannerUrl);
  const branding = params.get('tab') === 'branding';

  function tabTarget(tab: 'basic' | 'branding') {
    const next = new URLSearchParams(params);
    if (tab === 'branding') next.set('tab', tab);
    else next.delete('tab');
    const search = next.toString();
    return { search: search ? `?${search}` : '' };
  }

  return (
    <ManagementPage title="채널 관리" titleId="channel-manage-title" actions={
      <Link className={ui.button} to={channelPath(channel.handle)}><ChevronRight size={17} aria-hidden="true" />내 채널 보기</Link>
    }>
      <div className={styles.layout}>
        <nav className={ui.tabs} aria-label="채널 관리 메뉴">
          <Link to={tabTarget('basic')} aria-current={!branding ? 'page' : undefined}>기본 정보</Link>
          <Link to={tabTarget('branding')} aria-current={branding ? 'page' : undefined}>브랜딩</Link>
          <button type="button" disabled>권한</button>
        </nav>
        <div className={styles.grid}>
          {branding ? <Branding channel={channel} banner={banner} onBanner={setBanner} /> : <BasicInfo channel={channel} />}
          <ChannelPreview channel={channel} banner={banner} />
        </div>
      </div>
    </ManagementPage>
  );
}
