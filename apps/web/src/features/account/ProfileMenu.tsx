import { CircleHelp, Flag, LogOut, Pencil, Radio, Settings, UserRound, Wallet } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { broadcastPath, channelManagePath, operatorReportsPath, transactionsPath } from '../../preview/community-types';
import styles from './ProfileMenu.module.css';

type ProfileMenuProps = {
  profile: { name: string; handle: string; avatarUrl?: string | null };
  channelName: string;
  channelHref: string;
  onNavigate: () => void;
  onSignOut: () => void;
  isOperator?: boolean;
};

export function ProfileMenu({ profile, channelName, channelHref, onNavigate, onSignOut, isOperator = false }: ProfileMenuProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLElement>(null);
  const initial = Array.from(profile.name)[0];
  const avatar = profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : initial;

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('a')?.focus({ preventScroll: true });
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(event.target as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowUp' ? (index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length)
      : (index + 1) % items.length;
    items[next].focus();
  }

  function selectLink() {
    setOpen(false);
    onNavigate();
  }

  return (
    <div className={styles.anchor} ref={anchor} onKeyDown={handleKey} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button type="button" className={styles.trigger} ref={trigger} aria-label="내 계정"
        aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)}>
        <span className={styles.avatar} aria-hidden="true">{avatar}</span>
      </button>
      <nav id={id} ref={menu} className={styles.menu} aria-label="내 계정 메뉴" hidden={!open}>
        <div className={styles.summary}>
          <span className={styles.avatar} aria-hidden="true">{avatar}</span>
          <div><strong>{channelName}</strong><span>@{profile.handle}</span></div>
        </div>
        {isOperator && <div className={styles.group}>
          <Link to={operatorReportsPath} onClick={selectLink}><Flag aria-hidden="true" />신고 관리</Link>
        </div>}
        <div className={styles.group}>
          <Link to={channelHref} onClick={selectLink}><UserRound aria-hidden="true" />내 채널</Link>
          <Link to={channelManagePath} onClick={selectLink}><Pencil aria-hidden="true" />채널 관리</Link>
          <Link to={broadcastPath} onClick={selectLink}><Radio aria-hidden="true" />방송 스튜디오</Link>
        </div>
        <div className={styles.group}>
          <Link to="/settings" onClick={selectLink}><Settings aria-hidden="true" />내 설정</Link>
          <button type="button" disabled><CircleHelp aria-hidden="true" />도움말</button>
          <Link to={transactionsPath} onClick={selectLink}><Wallet aria-hidden="true" />결제 내역</Link>
          <button type="button" onClick={() => { setOpen(false); onSignOut(); }}><LogOut aria-hidden="true" />로그아웃</button>
        </div>
      </nav>
    </div>
  );
}
