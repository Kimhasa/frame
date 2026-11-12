import { ArrowUpRight, BarChart3, CalendarDays, CodeXml, Flag, Folder, Gift, Link2, ListChecks, MessagesSquare, Radio, Target, UserRound, UsersRound, Wallet } from 'lucide-react';
import { Link, NavLink } from 'react-router';
import { analyticsPath, broadcastPath, channelManagePath, channelPath, developerPath, integrationsPath, membersPath, missionsPath, moderationPath, operatorReportsPath, pollsPath, recordingsPath, reportsPath, revenuePath, rewardsPath, schedulePath } from '../../preview/community-types';
import styles from './CreatorSidebar.module.css';

const groups = [
  { label: '방송', items: [
    { label: '방송하기', Icon: Radio, href: broadcastPath },
    { label: '방송 예약', Icon: CalendarDays, href: schedulePath },
    { label: '녹화 관리', Icon: Folder, href: recordingsPath },
  ] },
  { label: '채널 운영', items: [
    { label: '채널 관리', Icon: UserRound, href: channelManagePath },
    { label: '채팅 관리', Icon: MessagesSquare, href: moderationPath },
    { label: '신고 관리', Icon: Flag, href: reportsPath },
    { label: '멤버십 관리', Icon: UsersRound, href: membersPath },
  ] },
  { label: '시청자 참여', items: [
    { label: '미션 관리', Icon: Target, href: missionsPath },
    { label: '투표 및 질문', Icon: ListChecks, href: pollsPath },
    { label: '포인트 및 보상', Icon: Gift, href: rewardsPath },
  ] },
  { label: '성과', items: [
    { label: '방송 분석', Icon: BarChart3, href: analyticsPath },
    { label: '수익·정산', Icon: Wallet, href: revenuePath },
  ] },
  { label: '연동', items: [
    { label: '외부 도구 연결', Icon: Link2, href: integrationsPath },
    { label: '개발자 설정', Icon: CodeXml, href: developerPath },
  ] },
];

export function CreatorSidebar({ channelName, initial, channelHandle, onNavigate, isOperator = false, showLegacyReports = true }: {
  channelName: string; initial: string; channelHandle: string; onNavigate: () => void; isOperator?: boolean; showLegacyReports?: boolean;
}) {
  const visibleGroups = groups.map(group => ({ ...group, items: group.items.filter(item => showLegacyReports || item.href !== reportsPath) }));
  if (isOperator) visibleGroups.unshift({ label: '플랫폼 관리', items: [{ label: '신고 관리', Icon: Flag, href: operatorReportsPath }] });
  return <>
    <Link to={channelPath(channelHandle)} className={styles.context} onClick={onNavigate} aria-label={`${channelName} 채널 보기`}>
      <span className={styles.avatar} aria-hidden="true">{initial}</span>
      <strong className={styles.contextText}>{channelName}</strong><ArrowUpRight className={styles.channelArrow} size={15} aria-hidden="true" />
    </Link>
    <nav className={styles.navigation} aria-label="크리에이터 메뉴">
      {visibleGroups.map(group => <div key={group.label} className={styles.group}>
        <h2>{group.label}</h2>
        <div className={styles.items}>{group.items.map(({ label, Icon, href }) => <NavLink key={href} to={href} className="nav-link" onClick={onNavigate} title={label}>
          <Icon size={22} aria-hidden="true" /><span>{label}</span>
        </NavLink>)}</div>
      </div>)}
    </nav>
    <nav className={styles.exit} aria-label="시청 화면으로 이동">
      <Link to="/live" className="nav-link" onClick={onNavigate} title="시청 화면으로"><ArrowUpRight size={22} aria-hidden="true" /><span>시청 화면으로</span></Link>
    </nav>
  </>;
}
