import { ArrowLeft, Check, Eye, EyeOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AuthCheckbox } from '../../components/AuthCheckbox';
import symbol from '../../assets/frame-symbol.svg';
import wordmark from '../../assets/frame-wordmark.svg';
import styles from './LoginPage.module.css';

type Provider = 'Google' | '네이버';
type Step = 'login' | 'register' | 'provider';

const serviceInformation = [
  { title: '이용약관', text: '다른 이용자의 권리를 존중하고, 계정과 비밀번호를 안전하게 관리해 주세요.' },
  { title: '개인정보 처리방침', text: '계정 정보는 다른 사람과 공유하지 마세요.' },
  { title: '고객지원', text: '계정, 방송, 영상 및 서비스 이용 관련 문의는 help@frame.example로 연락해 주세요.' },
  { title: '회사정보', text: '주식회사 프레임 · help@frame.example' },
] as const;

function ProviderMark({ provider }: { provider: Provider }) {
  if (provider === '네이버') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M6.3 6.5h3.6l4.2 6.1V6.5h3.6v11h-3.6l-4.2-6.1v6.1H6.3z" /></svg>;
  }
  return <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.7-.4-4H24v7.6h11a9.4 9.4 0 0 1-4.1 6.2v5h6.6c3.8-3.5 6.1-8.6 6.1-14.8Z" />
    <path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.2A20.4 20.4 0 0 0 24 44Z" />
    <path fill="#FBBC05" d="M12.6 27.8A12 12 0 0 1 12 24c0-1.3.2-2.6.6-3.8V15H5.8A20.2 20.2 0 0 0 3.6 24c0 3.2.8 6.2 2.2 9l6.8-5.2Z" />
    <path fill="#EA4335" d="M24 11.8c3 0 5.6 1 7.7 3l5.8-5.8A19.5 19.5 0 0 0 24 4 20.4 20.4 0 0 0 5.8 15l6.8 5.2c1.6-4.8 6.1-8.4 11.4-8.4Z" />
  </svg>;
}

export function LoginPage({ onPreviewSignIn, backTo, onBack, followRequired = false }: {
  onPreviewSignIn: (remember: boolean) => void;
  backTo: string;
  onBack?: () => void;
  followRequired?: boolean;
}) {
  const [params] = useSearchParams();
  const [step, setStep] = useState<Step>(() => params.get('mode') === 'register' ? 'register' : 'login');
  const [provider, setProvider] = useState<Provider>('Google');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${step === 'register' ? '회원가입' : '로그인'} · FRAME`;
    return () => { document.title = previousTitle; };
  }, [step]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  useEffect(() => {
    if (notice && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
  }, [notice]);

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onPreviewSignIn(remember);
  }

  function returnToLogin() {
    setShowPassword(false);
    setStep('login');
  }

  function openProvider(next: Provider) {
    setProvider(next);
    setStep('provider');
  }

  function recovery(kind: 'ID' | '비밀번호') {
    setNotice({ title: `${kind} 찾기`, text: `${kind} 찾기 서비스를 아직 사용할 수 없어요.` });
  }

  const PasswordIcon = showPassword ? EyeOff : Eye;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          {step === 'login' && !onBack
            ? <Link to={backTo} replace className={styles.iconButton} aria-label="이전 화면으로"><ArrowLeft size={22} /></Link>
            : <button type="button" className={styles.iconButton} onClick={step === 'login' ? onBack : returnToLogin} aria-label={step === 'login' ? '이전 화면으로' : '로그인 방법으로 돌아가기'}><ArrowLeft size={22} /></button>}
        </div>
      </header>
      <main className={styles.main}>
        <div className={styles.panel}>
          {(step === 'login' || step === 'register') && <>
            <div className={styles.brand}>
              <img src={symbol} alt="" width={41} height={41} />
              <img src={wordmark} alt="FRAME" width={128} />
            </div>
            <h1 ref={headingRef} className={step === 'register' ? styles.heading : styles.visuallyHidden} tabIndex={-1}>{step === 'register' ? '회원가입' : '로그인'}</h1>
            {followRequired && step === 'login' && <p className={styles.previewNote} id="preview-login-note">채널을 팔로우하려면 로그인해 주세요.</p>}
            <form className={styles.form} onSubmit={signIn} autoComplete="off" aria-describedby={followRequired && step === 'login' ? 'preview-login-note' : undefined}>
              <label className={styles.visuallyHidden} htmlFor="preview-login-email">이메일</label>
              <input className={styles.input} id="preview-login-email" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="이메일" maxLength={254} />
              {step === 'register' && <>
                <label className={styles.visuallyHidden} htmlFor="preview-register-name">닉네임</label>
                <input className={`${styles.input} ${styles.formGap}`} id="preview-register-name" autoComplete="off" placeholder="닉네임" maxLength={60} />
              </>}
              <div className={styles.passwordField}>
                <label className={styles.visuallyHidden} htmlFor="preview-login-password">비밀번호</label>
                <input className={styles.input} id="preview-login-password" type={showPassword ? 'text' : 'password'} autoComplete={step === 'register' ? 'new-password' : 'current-password'} placeholder={step === 'register' ? '비밀번호 (10자 이상)' : '비밀번호'} />
                <button type="button" className={`${styles.iconButton} ${styles.passwordToggle}`} onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 표시'}>
                  <PasswordIcon size={20} />
                </button>
              </div>
              {step === 'register' ? <>
                <label className={styles.visuallyHidden} htmlFor="preview-register-confirm">비밀번호 확인</label>
                <input className={`${styles.input} ${styles.formGap}`} id="preview-register-confirm" type="password" autoComplete="new-password" placeholder="비밀번호 확인" />
                <fieldset className={styles.agreements}>
                  <legend className={styles.visuallyHidden}>약관 동의</legend>
                  <AuthCheckbox className={styles.agreementAll} checked={termsAccepted && privacyAccepted} indeterminate={termsAccepted !== privacyAccepted} onChange={event => { setTermsAccepted(event.target.checked); setPrivacyAccepted(event.target.checked); }}>전체 동의</AuthCheckbox>
                  <div className={styles.agreementLine}><AuthCheckbox name="termsAccepted" checked={termsAccepted} onChange={event => setTermsAccepted(event.target.checked)} required>이용약관 동의 (필수)</AuthCheckbox><button type="button" className={styles.agreementButton} aria-haspopup="dialog" aria-label="이용약관 보기" onClick={() => setNotice(serviceInformation[0])}>보기</button></div>
                  <div className={styles.agreementLine}><AuthCheckbox name="privacyAccepted" checked={privacyAccepted} onChange={event => setPrivacyAccepted(event.target.checked)} required>개인정보 처리방침 동의 (필수)</AuthCheckbox><button type="button" className={styles.agreementButton} aria-haspopup="dialog" aria-label="개인정보 처리방침 보기" onClick={() => setNotice(serviceInformation[1])}>보기</button></div>
                </fieldset>
              </> : <AuthCheckbox className={styles.remember} checked={remember} onChange={event => setRemember(event.target.checked)}>로그인 상태 유지</AuthCheckbox>}
              <button className={styles.primary} type="submit">{step === 'register' ? '회원가입' : '로그인'}</button>
            </form>
            <nav className={styles.links} aria-label="계정 도움말">
              <button type="button" className={styles.textButton} onClick={() => { setShowPassword(false); setStep(step === 'register' ? 'login' : 'register'); }}>{step === 'register' ? '로그인' : '회원가입'}</button>
              <button type="button" className={styles.textButton} onClick={() => recovery('ID')} aria-haspopup="dialog">ID 찾기</button>
              <button type="button" className={styles.textButton} onClick={() => recovery('비밀번호')} aria-haspopup="dialog">비밀번호 찾기</button>
            </nav>
            {step === 'login' && <>
            <div className={styles.divider}><span>또는</span></div>
            <div className={styles.providers}>
              <button type="button" className={styles.provider} onClick={() => openProvider('Google')} aria-label="Google로 계속하기" title="Google로 계속하기"><ProviderMark provider="Google" /></button>
              <button type="button" className={`${styles.provider} ${styles.naver}`} onClick={() => openProvider('네이버')} aria-label="네이버로 계속하기" title="네이버로 계속하기"><ProviderMark provider="네이버" /></button>
            </div>
            </>}
          </>}
          {step === 'provider' && <>
            <span className={`${styles.provider} ${provider === '네이버' ? styles.naver : ''}`}><ProviderMark provider={provider} /></span>
            <h1 ref={headingRef} className={styles.heading} tabIndex={-1}>{provider}로 계속하기</h1>
            <div className={styles.account}>
              <span className={styles.avatar} aria-hidden="true">봄</span>
              <div><strong>봄</strong><span>spring@example.test</span></div>
              <Check size={20} aria-hidden="true" />
            </div>
            <button type="button" className={styles.primary} onClick={() => onPreviewSignIn(remember)}>계속</button>
            <div className={styles.links}><button type="button" className={styles.textButton} onClick={returnToLogin}>다른 방법으로 로그인</button></div>
          </>}
        </div>
      </main>
      <footer className={styles.footer}>
        <nav aria-label="서비스 안내">
          {serviceInformation.map(item => <button type="button" key={item.title} onClick={() => setNotice(item)} aria-haspopup="dialog">{item.title}</button>)}
        </nav>
        <p><span>주식회사 프레임</span><span>help@frame.example</span></p>
        <small>© 2026 FRAME</small>
      </footer>
      {notice && <dialog ref={dialogRef} className={styles.dialog} onClose={() => setNotice(null)} aria-labelledby="preview-login-info">
        <div className={styles.dialogHeading}>
          <h2 id="preview-login-info">{notice.title}</h2>
          <button type="button" className={styles.iconButton} onClick={() => dialogRef.current?.close()} aria-label="닫기"><X size={20} /></button>
        </div>
        <p>{notice.text}</p>
      </dialog>}
    </div>
  );
}
