import { ArrowLeft, Bell, Camera, ChevronRight, Link2, Monitor, Play, Shield, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { channelPath } from '../../preview/community-types';
import styles from './SettingsPage.module.css';

type Profile = { name: string; handle: string; avatarUrl?: string | null };

const profileSection = { id: 'profile', title: '프로필', description: '채팅과 채널에 표시되는 내 정보를 관리하세요.' } as const;
const otherSections = [
  { id: 'connections', title: '계정 연결', description: '로그인에 사용할 계정을 관리하세요.', Icon: Link2 },
  { id: 'security', title: '보안 및 기기', description: '내 계정의 로그인 상태를 확인하세요.', Icon: Shield },
  { id: 'notifications', title: '알림', description: '받고 싶은 소식만 선택하세요.', Icon: Bell },
  { id: 'playback', title: '재생', description: '방송을 시청하는 방식을 선택하세요.', Icon: Play },
] as const;
const sections = [profileSection, ...otherSections];

const notificationPreferences = [
  { title: '방송 시작 알림', description: '팔로우한 채널', enabled: true },
  { title: '멘션 알림', description: '채팅에서 내 이름이 언급될 때', enabled: true },
  { title: '댓글 및 답글', enabled: false },
  { title: '업데이트 소식', enabled: false },
];
const playbackPreferences = [
  { title: '자동 재생', description: '방송을 선택하면 바로 재생', enabled: true },
  { title: '이어서 재생', enabled: true },
  { title: '채팅창 기본 표시', enabled: true },
];

function ProfileAvatar({ profile }: { profile: Profile }) {
  const [imageFailed, setImageFailed] = useState(false);
  const lastWord = profile.name.trim().split(/\s+/).at(-1) ?? '';
  return (
    <span className={styles.avatar} aria-hidden="true">
      {profile.avatarUrl && !imageFailed
        ? <img src={profile.avatarUrl} alt="" onError={() => setImageFailed(true)} />
        : Array.from(lastWord)[0] ?? 'F'}
    </span>
  );
}

function ChannelLink({ profile, compact = false }: { profile: Profile; compact?: boolean }) {
  return <Link className={styles.textLink} to={channelPath(profile.handle)}>
    {compact ? '내 채널' : '내 채널 보기'}{!compact && <ChevronRight size={17} aria-hidden="true" />}
  </Link>;
}

function ProfileDetails({ profile }: { profile: Profile }) {
  return <>
    <div className={styles.identity}>
      <ProfileAvatar profile={profile} />
      <strong>프로필 사진</strong>
      <button className={styles.button} type="button" disabled><Camera size={17} aria-hidden="true" />사진 변경</button>
    </div>
    <div className={styles.fields}>
      <div className={styles.field}>
        <label htmlFor="settings-nickname">닉네임</label>
        <input id="settings-nickname" value={profile.name} readOnly aria-describedby="settings-nickname-help" />
        <small id="settings-nickname-help">1~20자 이내로 입력하세요.</small>
      </div>
      <div className={styles.field}>
        <label htmlFor="settings-bio">자기소개</label>
        <textarea id="settings-bio" rows={3} value="좋아하는 것을 만들고, 배우는 시간을 나눠요." readOnly />
      </div>
      <div className={styles.field}>
        <label htmlFor="settings-handle">사용자 ID</label>
        <span className={styles.handleField}>
          <span aria-hidden="true">@</span>
          <input id="settings-handle" value={profile.handle} readOnly aria-describedby="settings-handle-help" />
        </span>
        <small id="settings-handle-help">영문·숫자로 시작하는 3~24자, 밑줄(_)·하이픈(-)을 사용할 수 있어요.</small>
      </div>
    </div>
    <div className={styles.saveBar}>
      <button className={styles.button} type="button" disabled>취소</button>
      <button className={`${styles.button} ${styles.saveButton}`} type="button" disabled>변경사항 저장</button>
    </div>
  </>;
}

function ConnectionDetails({ profile }: { profile: Profile }) {
  const email = `${profile.handle}@example.test`;
  return <>
    <ul className={styles.rows}>
      <li className={styles.row}>
        <span className={`${styles.rowIcon} ${styles.google}`} aria-hidden="true">G</span>
        <div><strong>Google</strong><span className={styles.tag}>연결됨</span><p>{email}</p></div>
        <button className={styles.button} type="button" disabled>관리</button>
      </li>
      <li className={styles.row}>
        <span className={`${styles.rowIcon} ${styles.naver}`} aria-hidden="true">N</span>
        <div><strong>네이버</strong></div>
        <button className={styles.button} type="button" disabled>연결</button>
      </li>
    </ul>
    <section className={styles.subsection} aria-label="알림 이메일">
      <h3>알림 이메일</h3>
      <div className={styles.emailRow}><span>{email}</span><button className={styles.button} type="button" disabled>변경</button></div>
    </section>
  </>;
}

function SecurityDetails() {
  return <>
    <div className={styles.row}>
      <span className={styles.rowIcon}><Shield size={22} aria-hidden="true" /></span>
      <div><strong>로그인 보안</strong><p>비밀번호와 추가 인증은 연결한 계정에서 관리해요.</p></div>
    </div>
    <section className={styles.subsection} aria-label="로그인한 기기">
      <h3>로그인한 기기 <small>2대</small></h3>
      <ul className={styles.rows}>
        <li className={styles.row}>
          <span className={styles.rowIcon}><Monitor size={22} aria-hidden="true" /></span>
          <div><strong>Windows · Chrome</strong><span className={styles.tag}>현재 사용 중</span></div>
        </li>
        <li className={styles.row}>
          <span className={styles.rowIcon}><Smartphone size={22} aria-hidden="true" /></span>
          <div><strong>iPhone · Safari</strong><p>마지막 활동 2일 전</p></div>
        </li>
      </ul>
    </section>
  </>;
}

type Preference = { title: string; description?: string; enabled: boolean };

function PreferenceSwitch({ preference }: { preference: Preference }) {
  return (
    <label className={styles.preference}>
      <span><strong>{preference.title}</strong>{preference.description && <small>{preference.description}</small>}</span>
      <input type="checkbox" role="switch" defaultChecked={preference.enabled} aria-label={preference.title} />
      <span className={styles.switch} aria-hidden="true" />
    </label>
  );
}

function NotificationDetails() {
  return <>
    {notificationPreferences.map(preference => <PreferenceSwitch key={preference.title} preference={preference} />)}
    <div className={styles.notificationFoot}>
      <p>채널별 방송 알림은 팔로잉에서 설정할 수 있어요.</p>
      <Link className={styles.textLink} to="/following">팔로잉 보기<ChevronRight size={17} aria-hidden="true" /></Link>
    </div>
  </>;
}

function PlaybackDetails() {
  return <>
    {playbackPreferences.map(preference => <PreferenceSwitch key={preference.title} preference={preference} />)}
    <section className={styles.subsection} aria-label="접근성">
      <h3>접근성</h3>
      <PreferenceSwitch preference={{ title: '움직임 줄이기', description: '화면 전환과 장식 애니메이션에 적용', enabled: false }} />
    </section>
    <section className={styles.subsection} aria-label="언어 및 지역">
      <h3>언어 및 지역</h3>
      <dl className={styles.locale}>
        <div><dt>언어</dt><dd>한국어</dd></div>
        <div><dt>표시 지역</dt><dd>대한민국</dd></div>
        <div><dt>시간대</dt><dd>서울 (대한민국)</dd></div>
      </dl>
    </section>
  </>;
}

export function SettingsPage({ profile }: { profile: Profile }) {
  const [params] = useSearchParams();
  const detail = sections.find(section => section.id === params.get('section'));
  const active = detail ?? profileSection;

  function sectionUrl(id: typeof active.id) {
    return `/settings?section=${id}`;
  }

  return (
    <section className={styles.page} data-detail={Boolean(detail)} aria-label="내 설정">
      <div className={styles.layout}>
        <h1 className={styles.title}>내 설정</h1>
        <nav className={styles.desktopNav} aria-label="내 설정 메뉴">
          {sections.map(section => (
            <Link key={section.id} to={sectionUrl(section.id)} aria-current={active.id === section.id ? 'page' : undefined}>{section.title}</Link>
          ))}
        </nav>
        {!detail && <div className={styles.hub}>
          <Link className={styles.profileCard} to={sectionUrl('profile')} aria-label={`${profile.name}, 프로필 설정`}>
            <ProfileAvatar profile={profile} />
            <span className={styles.profileName}><strong>{profile.name}</strong><small>@{profile.handle}</small></span>
            <ChevronRight size={20} aria-hidden="true" />
          </Link>
          <nav className={styles.mobileNav} aria-label="내 설정 항목">
            {otherSections.map(({ id, title, Icon }) => <Link to={sectionUrl(id)} key={id}>
              <Icon size={22} aria-hidden="true" /><span>{title}</span><ChevronRight size={18} aria-hidden="true" />
            </Link>)}
          </nav>
        </div>}
        {detail && <header className={styles.mobileBar}>
          <Link className={styles.back} to="/settings" aria-label="내 설정으로 돌아가기"><ArrowLeft size={22} aria-hidden="true" /></Link>
          <h1>{active.title}</h1>
          {active.id === 'profile' && <ChannelLink profile={profile} compact />}
        </header>}
        <section className={styles.content} data-section={active.id} aria-label={active.title}>
          <div className={styles.contentHeading}>
            <div><h2>{active.title}</h2><p>{active.description}</p></div>
            {active.id === 'profile' && <ChannelLink profile={profile} />}
          </div>
          {active.id === 'profile' && <ProfileDetails profile={profile} />}
          {active.id === 'connections' && <ConnectionDetails profile={profile} />}
          {active.id === 'security' && <SecurityDetails />}
          {active.id === 'notifications' && <NotificationDetails />}
          {active.id === 'playback' && <PlaybackDetails />}
        </section>
      </div>
    </section>
  );
}
