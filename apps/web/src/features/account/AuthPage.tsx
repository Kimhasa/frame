import { ArrowLeft, ChevronRight, Eye, EyeOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import symbol from '../../assets/frame-symbol.svg';
import wordmark from '../../assets/frame-wordmark.svg';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import styles from '../login/LoginPage.module.css';
import accountStyles from './ConnectedAccount.module.css';
import authStyles from './AuthPage.module.css';
import { accountApi, AccountError, safeReturnPath } from './account-client';
import type { AccountPolicies, AccountSession } from './account-client';

type Info = 'terms' | 'privacy' | 'id' | 'password';

function AuthInfoDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (before instanceof HTMLElement && before.isConnected) before.focus(); };
  }, []);
  return <dialog ref={dialog} className={authStyles.dialog} aria-labelledby="auth-dialog-title" onClose={event => { if (!event.currentTarget.open) onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className={authStyles.dialogBody}>
      <header className={authStyles.dialogHeader}><h2 id="auth-dialog-title">{title}</h2><button type="button" className={authStyles.close} aria-label="닫기" onClick={onClose}><X size={20} /></button></header>
      <div className={authStyles.dialogContent}>{children}</div>
      <div className={authStyles.dialogFooter}><button type="button" onClick={onClose}>확인</button></div>
    </div>
  </dialog>;
}

export function AuthPage({ session, onAuthenticated }: { session: AccountSession; onAuthenticated: (session: AccountSession) => Promise<void> }) {
  const [params] = useSearchParams();
  const registering = params.get('mode') === 'register';
  const [pending, setPending] = useState(false);
  const [csrfToken, setCsrfToken] = useState(session.csrfToken);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [consentTried, setConsentTried] = useState(false);
  const [consentChanged, setConsentChanged] = useState(false);
  const [policies, setPolicies] = useState<AccountPolicies | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState('');
  const [policyReload, setPolicyReload] = useState(0);
  const [info, setInfo] = useState<Info | null>(null);
  const password = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const title = registering ? '회원가입' : '로그인';
  const back = safeReturnPath(params.get('returnTo'));
  const allAccepted = termsAccepted && privacyAccepted;
  const consentMissing = consentTried && !allAccepted;

  useEffect(() => { setCsrfToken(session.csrfToken); }, [session.csrfToken]);

  useEffect(() => {
    const before = document.title;
    document.title = `${title} · FRAME`;
    setError(''); setInfo(null); setShowPassword(false); setConsentChanged(false);
    return () => { document.title = before; };
  }, [title]);
  useEffect(() => {
    if (!registering) return;
    const controller = new AbortController();
    setPolicies(null); setPolicyLoading(true); setPolicyError('');
    setTermsAccepted(false); setPrivacyAccepted(false); setConsentTried(false);
    accountApi.policies(controller.signal).then(value => { if (!controller.signal.aborted) setPolicies(value); }).catch(failure => {
      if (!controller.signal.aborted) setPolicyError(failure instanceof Error ? failure.message : '약관을 불러오지 못했어요.');
    }).finally(() => { if (!controller.signal.aborted) setPolicyLoading(false); });
    return () => controller.abort();
  }, [registering, policyReload]);

  function switchPath() {
    const next = new URLSearchParams(params);
    if (registering) next.delete('mode'); else next.set('mode', 'register');
    return `/login?${next}`;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const secret = String(form.get('password') ?? '');
    if (registering && ([...secret].length < 10 || [...secret].length > 128)) {
      setError('비밀번호를 10~128자로 입력해 주세요.'); password.current?.focus(); return;
    }
    if (registering && secret !== String(form.get('passwordConfirmation') ?? '')) {
      setError('비밀번호가 서로 달라요. 다시 확인해 주세요.'); confirmation.current?.focus(); return;
    }
    if (registering && (!policies || policyLoading)) { setError('약관을 불러온 뒤 다시 시도해 주세요.'); return; }
    if (registering && !allAccepted) {
      setConsentTried(true); setError('');
      document.getElementById(termsAccepted ? 'account-privacy' : 'account-terms')?.focus();
      return;
    }
    inFlight.current = true; setPending(true); setError('');
    try {
      const result = registering && policies
        ? await accountApi.register({ email, password: secret, displayName: String(form.get('displayName') ?? '').trim(),
          termsAccepted, privacyAccepted,
          termsVersion: policies.terms.version, privacyVersion: policies.privacy.version }, csrfToken)
        : await accountApi.login({ email, password: secret, remember }, csrfToken);
      if (!result.user) throw new Error('로그인 상태를 확인하지 못했어요.');
      await onAuthenticated(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '로그인을 완료하지 못했어요.');
      if (failure instanceof AccountError && failure.code === 'CONSENT_VERSION_CHANGED') {
        setError(''); setConsentChanged(true); setPolicyReload(value => value + 1);
      }
      if (failure instanceof AccountError && failure.code === 'CSRF_INVALID') {
        try {
          const fresh = await accountApi.session();
          setCsrfToken(fresh.csrfToken);
          setError('연결이 만료되어 다시 확인했어요. 다시 시도해 주세요.');
        } catch (refreshFailure) { setError(refreshFailure instanceof Error ? refreshFailure.message : '연결을 다시 확인하지 못했어요.'); }
      }
    } finally { inFlight.current = false; setPending(false); }
  }
  const PasswordIcon = showPassword ? EyeOff : Eye;
  const viewedPolicy = info === 'terms' || info === 'privacy' ? policies?.[info] : null;
  return <div className={styles.page}>
    <header className={styles.header}><div className={styles.headerInner}><Link to={back} className={styles.iconButton} aria-label="이전 화면으로" aria-disabled={pending || undefined} tabIndex={pending ? -1 : undefined} onClick={event => { if (pending) event.preventDefault(); }}><ArrowLeft size={22} /></Link></div></header>
    <main className={styles.main}><div className={styles.panel}>
      <div className={styles.brand}><img src={symbol} alt="" width={41} height={41} /><img src={wordmark} alt="FRAME" width={128} /></div>
      <h1 className={registering ? styles.heading : styles.visuallyHidden}>{title}</h1>
      <form className={styles.form} onSubmit={submit} aria-busy={pending}>
        <fieldset disabled={pending} className={accountStyles.authFields}>
          <label className={styles.visuallyHidden} htmlFor="account-email">이메일</label>
          <input className={styles.input} id="account-email" name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} placeholder="이메일" required />
          {registering && <>
            <label className={styles.visuallyHidden} htmlFor="account-display-name">닉네임</label>
            <input className={styles.input} id="account-display-name" name="displayName" autoComplete="nickname" maxLength={60} placeholder="닉네임 (1~30자)" required />
          </>}
          <div className={styles.passwordField}>
            <label className={styles.visuallyHidden} htmlFor="account-password">비밀번호</label>
            <input ref={password} className={styles.input} id="account-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={registering ? 'new-password' : 'current-password'} maxLength={256} placeholder={registering ? '비밀번호 (10자 이상)' : '비밀번호'} required />
            <button type="button" className={`${styles.iconButton} ${styles.passwordToggle}`} aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 표시'} onClick={() => setShowPassword(value => !value)}><PasswordIcon size={20} /></button>
          </div>
          {registering && <><label className={styles.visuallyHidden} htmlFor="account-password-confirmation">비밀번호 확인</label><input ref={confirmation} className={styles.input} id="account-password-confirmation" name="passwordConfirmation" type="password" autoComplete="new-password" maxLength={256} placeholder="비밀번호 확인" required /></>}
          {!registering && <AuthCheckbox className={styles.remember} id="account-remember" name="remember" checked={remember} onChange={event => setRemember(event.target.checked)}>로그인 상태 유지</AuthCheckbox>}
          {registering && <>
            <AuthCheckbox className={authStyles.all} id="account-agree-all" checked={allAccepted} indeterminate={!allAccepted && (termsAccepted || privacyAccepted)} disabled={!policies || policyLoading}
              onChange={event => { setTermsAccepted(event.target.checked); setPrivacyAccepted(event.target.checked); if (event.target.checked) setConsentChanged(false); }}>전체 동의</AuthCheckbox>
            <div className={authStyles.agreementRow}>
              <AuthCheckbox id="account-terms" name="termsAccepted" checked={termsAccepted} disabled={!policies || policyLoading}
                aria-invalid={consentMissing && !termsAccepted || undefined} aria-describedby={consentMissing && !termsAccepted ? 'account-consent-error' : undefined}
                onChange={event => { setTermsAccepted(event.target.checked); if (event.target.checked && privacyAccepted) setConsentChanged(false); }}><span className={authStyles.required}>[필수]</span>이용약관 동의</AuthCheckbox>
              <button type="button" className={authStyles.view} aria-label="이용약관 보기" disabled={!policies || policyLoading} onClick={() => setInfo('terms')}><ChevronRight size={18} /></button>
            </div>
            <div className={authStyles.agreementRow}>
              <AuthCheckbox id="account-privacy" name="privacyAccepted" checked={privacyAccepted} disabled={!policies || policyLoading}
                aria-invalid={consentMissing && !privacyAccepted || undefined} aria-describedby={consentMissing && !privacyAccepted ? 'account-consent-error' : undefined}
                onChange={event => { setPrivacyAccepted(event.target.checked); if (event.target.checked && termsAccepted) setConsentChanged(false); }}><span className={authStyles.required}>[필수]</span>개인정보 수집·이용 동의</AuthCheckbox>
              <button type="button" className={authStyles.view} aria-label="개인정보 수집·이용 내용 보기" disabled={!policies || policyLoading} onClick={() => setInfo('privacy')}><ChevronRight size={18} /></button>
            </div>
            {policyLoading && <div className={authStyles.policyStatus} role="status">약관을 불러오는 중이에요.</div>}
            {consentChanged && !policyLoading && <div className={authStyles.policyStatus} role="status">약관 내용이 변경되었어요. 확인 후 다시 동의해 주세요.</div>}
            {policyError && <div className={authStyles.policyStatus} role="alert"><p>{policyError}</p><button type="button" className={authStyles.retry} onClick={() => setPolicyReload(value => value + 1)}>다시 시도</button></div>}
            {consentMissing && <p id="account-consent-error" className={authStyles.consentError} role="alert">필수 약관 두 항목에 동의해 주세요.</p>}
          </>}
          {error && <p className={accountStyles.error} role="alert">{error}</p>}
          <button className={styles.primary} type="submit" disabled={registering && (!policies || policyLoading)}>{pending ? '확인 중' : title}</button>
        </fieldset>
      </form>
      <nav className={styles.links} aria-label="계정 안내"><Link className={styles.textButton} to={switchPath()} aria-disabled={pending || undefined} tabIndex={pending ? -1 : undefined} onClick={event => { if (pending) event.preventDefault(); }}>{registering ? '로그인' : '회원가입'}</Link><button type="button" className={styles.textButton} disabled={pending} onClick={() => setInfo('id')}>ID 찾기</button><button type="button" className={styles.textButton} disabled={pending} onClick={() => setInfo('password')}>비밀번호 찾기</button></nav>
    </div></main>
    <footer className={styles.footer}><small>© 2026 FRAME</small></footer>
    {info && <AuthInfoDialog key={info} title={viewedPolicy?.title ?? (info === 'id' ? 'ID 찾기' : '비밀번호 찾기')} onClose={() => setInfo(null)}>
      {viewedPolicy ? <><p className={authStyles.version}>시행일 {viewedPolicy.version}</p>{viewedPolicy.sections.map(section => <section key={section.heading}><h3>{section.heading}</h3>{section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>)}</>
        : info === 'id' ? <p>가입할 때 입력한 이메일이 로그인 ID예요.</p> : <p>비밀번호 재설정 기능은 아직 준비 중이에요.</p>}
    </AuthInfoDialog>}
  </div>;
}
