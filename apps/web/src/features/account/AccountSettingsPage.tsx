import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { channelPath } from '../../preview/community-types';
import type { AccountSession } from './account-client';
import styles from '../settings/SettingsPage.module.css';
import connected from './ConnectedAccount.module.css';

export function AccountSettingsPage({ session, onSave }: { session: AccountSession; onSave: (name: string) => Promise<AccountSession> }) {
  const user = session.user!;
  const [name, setName] = useState(user.displayName);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = name.trim() !== user.displayName;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving.current || !dirty) return;
    if (![...name.trim()].length || [...name.trim()].length > 30) { setError('닉네임은 1~30자로 입력해 주세요.'); return; }
    saving.current = true; setPending(true); setError(''); setNotice('');
    try { const updated = await onSave(name.trim()); setName(updated.user!.displayName); setNotice('프로필을 저장했어요.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '프로필을 저장하지 못했어요.'); }
    finally { saving.current = false; setPending(false); }
  }
  return <section className={styles.page} aria-label="내 설정"><div className={styles.layout}>
    <h1 className={styles.title}>내 설정</h1>
    <nav className={styles.desktopNav} aria-label="내 설정 메뉴"><Link to="/settings" aria-current="page">프로필</Link></nav>
    <section className={styles.content} aria-labelledby="account-profile-title">
      <div className={styles.contentHeading}><div><h2 id="account-profile-title">프로필</h2><p>계정에 표시되는 내 정보를 관리하세요.</p></div>{session.channel && <Link className={styles.textLink} to={channelPath(session.channel.handle)}>내 채널 보기</Link>}</div>
      <form onSubmit={submit} aria-busy={pending}>
        <div className={styles.identity}><span className={styles.avatar} aria-hidden="true">{Array.from(name.trim())[0] ?? 'F'}</span><strong>{user.displayName}</strong></div>
        <fieldset className={connected.formFields} disabled={pending}>
          <div className={styles.field}><label htmlFor="profile-name">닉네임</label><input id="profile-name" name="displayName" autoComplete="nickname" value={name} maxLength={60} required aria-describedby="profile-name-help" onChange={event => { setName(event.target.value); setError(''); setNotice(''); }} /><small id="profile-name-help">1~30자 이내로 입력하세요.</small></div>
          <div className={styles.field}><label htmlFor="profile-email">이메일</label><input id="profile-email" value={user.email} type="email" readOnly /></div>
          {session.channel && <div className={styles.field}><label htmlFor="profile-handle">채널 ID</label><input id="profile-handle" value={`@${session.channel.handle}`} readOnly /><small>채널 ID는 가입 후 변경할 수 없어요.</small></div>}
          {error && <p className={connected.error} role="alert">{error}</p>}{notice && <p className={connected.notice} role="status">{notice}</p>}
          <div className={styles.saveBar}><button className={styles.button} type="button" disabled={!dirty} onClick={() => { setName(user.displayName); setError(''); setNotice(''); }}>취소</button><button className={`${styles.button} ${connected.profilePrimary}`} type="submit" disabled={!dirty}>{pending ? '저장 중' : '변경사항 저장'}</button></div>
        </fieldset>
      </form>
    </section>
  </div></section>;
}
