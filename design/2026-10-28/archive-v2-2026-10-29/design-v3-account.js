(() => {
  const e = F.e;
  const ico = name => F.icon(name);
  const state = F.accountDesign = {
    section: '프로필', loginStep: 'options', loginProvider: '', loginError: '',
    profile: { nickname: F.nickname || '봄', bio: '좋아하는 것을 만들고, 배우는 시간을 나눠요.', handle: 'spring' },
    channel: { name: '개발하는 봄', bio: '만들고 배우는 시간을 나누는 작은 작업실. 편하게 들렀다 가세요.', handle: 'spring', category: '개발 · 작업', visibility: '전체 공개', notice: '매주 화요일과 목요일 오후 8시에 만나요.' },
    channelTab: '기본 정보', channelRole: '소유자', banner: 'creative-studio',
    avatar: '봄', avatarUrl: '', channelAvatarUrl: '', uploadedBanner: '',
    dirty: { profile: false, channel: false }, errors: {},
    prefs: { live: true, mentions: true, replies: false, news: false, autoplay: true, resume: true, chat: true, reducedMotion: false },
    devices: [{ id: 'current', name: 'Windows · Chrome', description: '현재 사용 중인 기기', current: true }, { id: 'phone', name: 'iPhone · Safari', description: '마지막 활동 2일 전', current: false }],
    members: [{ id: 'owner', name: '개발하는 봄', initial: '봄', role: '소유자', status: '사용 중' }, { id: 'moa', name: '모아', initial: '모', role: '채팅 운영자', status: '사용 중' }]
  };
  const action = (label, name, icon = '', cls = '', attrs = '') => `<button type="button" class="${cls}" data-action="v3-account-${name}" ${attrs}>${icon ? ico(icon) : ''}${label}</button>`;
  const go = (id, label, icon = '', cls = '') => `<button type="button" class="${cls}" data-go="${id}">${icon ? ico(icon) : ''}${label}</button>`;
  const avatar = (name, cls = '', channel = false) => {
    const url = channel ? state.channelAvatarUrl : state.avatarUrl;
    return url ? `<span class="v3-account-avatar ${cls}"><img src="${e(url)}" alt="프로필 사진"></span>` : `<span class="v3-account-avatar ${cls}">${F.avatar(name, 'round')}</span>`;
  };
  const error = key => state.errors[key] || '';
  const field = (label, name, value, scope, help = '', options = {}) => {
    const id = `v3-${scope}-${name}`;
    const err = error(name);
    const attrs = `id="${id}" name="${name}" data-v3-scope="${scope}" ${options.max ? `maxlength="${options.max}"` : ''} ${options.readonly ? 'readonly' : ''} ${options.disabled ? 'disabled' : ''} ${err ? `aria-invalid="true" aria-describedby="${id}-help"` : help ? `aria-describedby="${id}-help"` : ''}`;
    const control = options.area ? `<textarea ${attrs} rows="${options.rows || 3}">${e(value)}</textarea>` : `<input ${attrs} value="${e(value)}" type="${options.type || 'text'}" autocomplete="${options.autocomplete || 'off'}" placeholder="${e(options.placeholder || '')}">`;
    return `<div class="v3-field ${err ? 'has-error' : ''}"><label for="${id}">${label}</label>${control}${err || help ? `<small id="${id}-help">${e(err || help)}</small>` : ''}</div>`;
  };
  const choice = (label, key, value, options, scope = 'channel', disabled = false) => `<div class="v3-field"><label>${label}</label>${action(`<span>${e(value)}</span>${ico('chevron')}`, 'choice', '', 'v3-choice', `data-key="${key}" data-scope="${scope}" data-options="${e(JSON.stringify(options))}" aria-label="${label}" aria-haspopup="listbox" aria-expanded="false" ${disabled ? 'disabled' : ''}`)}</div>`;
  const toggle = (key, label) => action('<span></span>', 'toggle', '', 'v3-switch', `role="switch" aria-label="${label}" aria-checked="${state.prefs[key]}" data-key="${key}"`);
  const setting = (title, description, control, cls = '') => `<div class="v3-setting ${cls}"><div><strong>${title}</strong>${description ? `<p>${description}</p>` : ''}</div>${control}</div>`;
  const sectionHeading = (title, description = '') => `<div class="v3-section-heading"><h2>${title}</h2>${description ? `<p>${description}</p>` : ''}</div>`;
  const footer = (scope, disabled = false) => `<div class="v3-save-bar"><span class="v3-save-note" role="status">${state.dirty[scope] ? '저장하지 않은 변경사항이 있어요.' : ''}</span><div>${action('취소', 'reset', '', 'v3-btn', `data-scope="${scope}"`)}<button class="primary v3-btn" type="submit" ${disabled || !state.dirty[scope] ? 'disabled' : ''}>저장</button></div></div>`;
  const settingNavigation = active => `<nav class="v3-settings-nav" aria-label="내 설정 메뉴">${[['프로필', 'user', 'profile'], ['계정 연결', 'link', 'security'], ['보안 및 기기', 'shield', 'security'], ['알림', 'bell', 'preferences'], ['재생', 'play', 'preferences']].map(([label, icon, page]) => action(`<span>${label}</span>`, 'section', icon, active === label ? 'active' : '', `data-section="${label}" data-page="${page}" ${active === label ? 'aria-current="page"' : ''}`)).join('')}</nav>`;
  const settingsShell = (active, body) => `<div class="v3-account v3-settings"><div class="v3-page-heading"><div><h1>내 설정</h1><p>나에게 맞는 이용 환경을 설정하세요.</p></div></div><div class="v3-settings-layout">${settingNavigation(active)}<section class="v3-settings-body">${body}</section></div></div>`;

  function profilePage(viewState) {
    if (viewState === '닉네임 오류' && !state.errors.nickname) state.errors.nickname = '다른 닉네임을 입력해 주세요.';
    const p = state.profile;
    return settingsShell('프로필', `${sectionHeading('프로필', '채팅과 채널에 표시되는 내 정보를 관리하세요.')}<form id="v3-account-profile-form" data-v3-form="profile" novalidate><div class="v3-profile-identity">${avatar(p.nickname, 'large')}<div><strong>${e(p.nickname || '닉네임')}</strong><span>@${e(p.handle)}</span>${action('사진 변경', 'avatar', 'camera', 'v3-text-button', 'data-scope="profile"')}</div>${go('channel', '내 채널 보기', 'right', 'v3-text-button identity-channel-link')}</div><div class="v3-form-width">${field('닉네임', 'nickname', p.nickname, 'profile', '1~20자 이내로 입력하세요.', { max: 20, autocomplete: 'nickname' })}${field('소개', 'bio', p.bio, 'profile', '', { area: true, max: 160 })}<div class="v3-field"><label for="v3-profile-url">채널 주소</label><div class="v3-url-field"><span>frame.app/@</span><input id="v3-profile-url" name="handle" value="${e(p.handle)}" data-v3-scope="profile" aria-label="채널 주소" autocomplete="off" maxlength="24"></div>${error('handle') ? `<small class="v3-error">${error('handle')}</small>` : ''}</div></div>${footer('profile')}</form>`);
  }

  function accountPage(viewState) {
    if (state.section !== '보안 및 기기') state.section = '계정 연결';
    if (state.section === '보안 및 기기') return securityPage(viewState);
    return settingsShell('계정 연결', `${sectionHeading('계정 연결', '로그인에 사용할 계정을 관리하세요.')}<div class="v3-account-connected"><div class="v3-provider-icon google">G</div><div><strong>Google</strong><p>spring@example.test</p></div><span class="v3-connection-tag">연결됨</span>${action('관리', 'connection-details', 'right', 'v3-icon-button', 'aria-label="Google 연결 관리"')}</div><div class="v3-account-connected"><div class="v3-provider-icon naver">N</div><div><strong>네이버</strong><p>아직 연결하지 않았어요.</p></div>${action('연결', 'connect-provider', '', 'v3-btn', 'data-provider="네이버"')}</div><div class="v3-account-email-block">${sectionHeading('이메일')}<div class="v3-readonly-row"><span>알림을 받을 이메일</span><strong>spring@example.test</strong>${action('변경', 'email-change', '', 'v3-text-button')}</div></div>`);
  }

  function securityPage(viewState) {
    return settingsShell('보안 및 기기', `${sectionHeading('보안 및 기기', '내 계정의 로그인 상태를 확인하세요.')}${viewState === '재인증 필요' ? '<div class="v3-inline-error" role="alert">계속하려면 본인 확인이 필요해요.</div>' : ''}<div class="v3-security-summary"><span class="v3-security-icon">${ico('shield')}</span><div><strong>계정을 더 안전하게</strong><p>연결한 계정의 보안 설정을 함께 관리하세요.</p></div>${action('보안 설정', 'security-details', '', 'v3-btn')}</div><div class="v3-subsection-title"><h3>로그인한 기기</h3><span>${state.devices.length}개 기기</span></div><div class="v3-device-list">${state.devices.map(d => `<div class="v3-device"><span class="v3-device-icon">${ico('monitor')}</span><div><strong>${d.name}</strong><p>${d.description}</p></div>${d.current ? '<span class="v3-connection-tag">현재 기기</span>' : action('로그아웃', 'device-confirm', '', 'v3-text-button', `data-device="${d.id}"`)}</div>`).join('')}</div><div class="v3-section-actions">${action('다른 기기에서 모두 로그아웃', 'device-confirm', 'logout', 'v3-text-button', 'data-device="all"')}</div>`);
  }

  function preferencesPage() {
    if (!['알림', '재생'].includes(state.section)) state.section = '알림';
    if (state.section === '재생') return settingsShell('재생', `${sectionHeading('재생', '방송을 시청하는 방식을 선택하세요.')}<div class="v3-setting-group">${setting('자동 재생', '방송을 선택하면 바로 재생해요.', toggle('autoplay', '자동 재생'))}${setting('이어서 시청', '마지막으로 본 위치에서 다시 시작해요.', toggle('resume', '이어서 시청'))}${setting('채팅 기본 열기', '방송을 시청할 때 채팅을 함께 표시해요.', toggle('chat', '채팅 기본 열기'))}</div><div class="v3-subsection-title"><h3>접근성</h3></div>${setting('움직임 줄이기', '화면 전환과 장식 애니메이션을 줄여요.', toggle('reducedMotion', '움직임 줄이기'))}`);
    return settingsShell('알림', `${sectionHeading('알림', '받고 싶은 소식만 선택하세요.')}<div class="v3-setting-group">${setting('방송 시작', '팔로우한 채널이 라이브를 시작하면 알려드려요.', toggle('live', '방송 시작 알림'))}${setting('채팅 멘션', '채팅에서 내 닉네임을 언급하면 알려드려요.', toggle('mentions', '채팅 멘션 알림'))}${setting('댓글과 답글', '내 콘텐츠에 새로운 반응이 있으면 알려드려요.', toggle('replies', '댓글과 답글 알림'))}${setting('업데이트 소식', '새로운 기능과 서비스 소식을 알려드려요.', toggle('news', '업데이트 소식 알림'))}</div><div class="v3-notification-foot">${ico('bell')}<span>채널별 방송 알림은 팔로잉에서 설정할 수 있어요.</span>${go('following', '팔로잉 보기', 'right', 'v3-text-button')}</div>`);
  }

  const google = '<span class="v3-provider-symbol google">G</span>';
  const naver = '<span class="v3-provider-symbol naver">N</span>';
  function loginPage(viewState) {
    let body;
    if (state.loginStep === 'email') body = `<div class="v3-login-title">${action('', 'login-back', 'arrow', 'v3-icon-button', 'aria-label="로그인 방법으로 돌아가기"')}<h1>이메일로 로그인</h1><p>계정 정보를 입력해 주세요.</p></div><form id="v3-account-login-form" data-v3-form="login" novalidate>${field('이메일', 'email', '', 'login', '', { type: 'email', autocomplete: 'email', placeholder: '이메일 주소' })}${field('비밀번호', 'password', '', 'login', '', { type: 'password', autocomplete: 'current-password', placeholder: '비밀번호' })}${state.loginError ? `<p class="v3-login-error" role="alert">${e(state.loginError)}</p>` : ''}<button class="primary v3-login-submit" type="submit">로그인</button></form><div class="v3-login-assistance">${action('로그인에 도움이 필요하신가요?', 'login-help', '', 'v3-text-button')}</div>`;
    else if (state.loginStep === 'provider') body = `<div class="v3-login-title">${action('', 'login-back', 'arrow', 'v3-icon-button', 'aria-label="로그인 방법으로 돌아가기"')}<span class="v3-provider-name">${state.loginProvider === 'Google' ? google : naver}${e(state.loginProvider)}</span><h1>계속할 계정을 선택하세요</h1><p>FRAME에서 사용할 프로필을 확인해 주세요.</p></div><div class="v3-login-account">${avatar(state.profile.nickname)}<div><strong>${e(state.profile.nickname)}</strong><span>spring@example.test</span></div>${ico('check')}</div>${action('계속', 'login-complete', '', 'primary v3-login-submit')}<div class="v3-login-assistance">${action('다른 방법으로 로그인', 'login-back', '', 'v3-text-button')}</div>`;
    else body = `<div class="v3-login-title"><h1>FRAME에 로그인</h1><p>좋아하는 채널과 함께하는 시간을 이어가세요.</p></div>${viewState === '연동 실패' ? '<div class="v3-inline-error" role="alert">연결을 완료하지 못했어요. 다시 시도해 주세요.</div>' : ''}<div class="v3-login-providers">${action(`${google}<span>Google로 계속하기</span>`, 'login-provider', '', 'v3-provider-button', 'data-provider="Google"')}${action(`${naver}<span>네이버로 계속하기</span>`, 'login-provider', '', 'v3-provider-button', 'data-provider="네이버"')}</div><div class="v3-login-divider"><span>또는</span></div>${action('이메일로 로그인', 'login-email', 'user', 'v3-provider-button email')}<p class="v3-login-policy">계속하면 ${go('policy', '이용약관', '', 'v3-inline-link')}과<br>${go('policy', '개인정보 처리방침', '', 'v3-inline-link')}에 동의하게 됩니다.</p>`;
    return `<div class="v3-login"><div class="v3-login-welcome"><div class="v3-login-wordmark">${ico('frame')}FRAME</div><h2>좋아하는 순간을,<br>함께 나누세요.</h2><p>어디에서든 이어지는 라이브와 이야기.</p><div class="v3-login-visual" aria-hidden="true"><div class="v3-login-photo back"><img src="./assets/editorial/night-drive.png" alt=""></div><div class="v3-login-photo front"><img src="./assets/editorial/forest-game.png" alt=""><span>${ico('play')}</span></div><div class="v3-login-live"><span></span>LIVE</div></div></div><section class="v3-login-panel">${body}<div class="v3-login-browse">${go('live', '먼저 둘러보기', 'arrow', 'v3-text-button')}</div></section></div>`;
  }

  const canManage = () => ['소유자', '채널 관리자'].includes(state.channelRole);
  function channelPreview() {
    const c = state.channel;
    return `<aside class="v3-channel-preview"><div class="v3-preview-label">채널 미리보기${go('channel', '채널 보기', 'right', 'v3-text-button')}</div><div class="v3-channel-preview-card"><div class="v3-preview-banner"><img src="${e(state.uploadedBanner || `./assets/editorial/${state.banner}.png`)}" alt="채널 배너"></div><div class="v3-preview-profile">${avatar(state.avatar, 'large', true)}<strong class="v3-preview-channel-name">${e(c.name)}</strong><span>@${e(c.handle)}</span><p class="v3-preview-channel-bio">${e(c.bio)}</p><span class="v3-preview-followers">팔로워 1,284명</span></div><div class="v3-preview-tabs"><strong>홈</strong><span>다시보기</span><span>클립</span><span>정보</span></div></div></aside>`;
  }
  function channelPage(viewState) {
    const c = state.channel, disabled = !canManage();
    let body;
    if (state.channelTab === '브랜딩') body = `<form id="v3-account-channel-branding" data-v3-form="channel"><div class="v3-branding-block"><div class="v3-subsection-title"><div><h3>프로필 사진</h3><p>채널과 채팅에서 나를 보여주는 이미지예요.</p></div></div><div class="v3-brand-avatar">${avatar(state.avatar, 'large', true)}${action('이미지 변경', 'avatar', 'camera', 'v3-btn', `data-scope="channel" ${disabled ? 'disabled' : ''}`)}</div></div><div class="v3-branding-block"><div class="v3-subsection-title"><div><h3>배너 이미지</h3><p>채널 상단에 표시돼요.</p></div>${action('이미지 선택', 'banner-upload', 'camera', 'v3-text-button', disabled ? 'disabled' : '')}</div><div class="v3-banner-editor"><img src="${e(state.uploadedBanner || `./assets/editorial/${state.banner}.png`)}" alt="현재 채널 배너"></div><div class="v3-banner-options" aria-label="배너 이미지 선택">${[['creative-studio','작업실'],['forest-game','숲'],['night-drive','도시']].map(([name,label]) => action(`<img src="./assets/editorial/${name}.png" alt="${label}">${state.banner === name && !state.uploadedBanner ? `<span>${ico('check')}</span>` : ''}`, 'banner-preset', '', state.banner === name && !state.uploadedBanner ? 'selected' : '', `data-banner="${name}" aria-label="${label} 배너 선택" ${disabled ? 'disabled' : ''}`)).join('')}</div></div>${footer('channel', disabled)}</form>`;
    else if (state.channelTab === '권한') body = `<div class="v3-permissions"><div class="v3-subsection-title"><div><h3>채널 멤버</h3><p>역할에 따라 관리할 수 있는 범위가 달라요.</p></div>${action('멤버 추가', 'invite-member', 'plus', 'v3-btn', disabled ? 'disabled' : '')}</div><div class="v3-member-list">${state.members.map(m => `<div class="v3-member">${avatar(m.initial)}<div class="v3-member-name"><strong>${e(m.name)}</strong><span>${m.status}</span></div>${m.role === '소유자' ? '<span class="v3-member-owner">소유자</span>' : action(`${e(m.role)}${ico('chevron')}`, 'member-role', '', 'v3-member-role', `data-member="${m.id}" aria-label="${e(m.name)} 역할" ${disabled ? 'disabled' : ''}`)}${m.role === '소유자' ? '<span class="v3-member-placeholder"></span>' : action('', 'remove-member', 'trash', 'v3-icon-button', `data-member="${m.id}" aria-label="${e(m.name)} 멤버 삭제" ${disabled ? 'disabled' : ''}`)}</div>`).join('')}</div><div class="v3-role-descriptions"><div>${ico('shield')}<strong>채널 관리자</strong><p>방송 정보와 콘텐츠를 관리해요.</p></div><div>${ico('chat')}<strong>채팅 운영자</strong><p>채팅과 참여 제한을 관리해요.</p></div></div></div>`;
    else body = `<form id="v3-account-channel-form" data-v3-form="channel" novalidate>${field('채널 이름', 'name', c.name, 'channel', '', { max: 30, disabled })}${field('채널 소개', 'bio', c.bio, 'channel', '', { area: true, rows: 3, max: 240, disabled })}<div class="v3-field"><label for="v3-channel-handle">채널 주소</label><div class="v3-url-field"><span>frame.app/@</span><input id="v3-channel-handle" name="handle" data-v3-scope="channel" value="${e(c.handle)}" aria-label="채널 주소" maxlength="24" ${disabled ? 'disabled' : ''}></div>${error('handle') ? `<small class="v3-error">${error('handle')}</small>` : ''}</div><div class="v3-field-pair">${choice('주요 콘텐츠', 'category', c.category, ['개발 · 작업', '게임', '일상 · 이야기', '디자인 · 창작', '지식 · 탐색'], 'channel', disabled)}${choice('기본 공개 범위', 'visibility', c.visibility, ['전체 공개', '링크가 있는 사람', '멤버십 전용'], 'channel', disabled)}</div>${field('채널 공지', 'notice', c.notice, 'channel', '', { area: true, rows: 2, max: 160, disabled })}${footer('channel', disabled)}</form>`;
    return `<div class="v3-account v3-channel-management"><div class="v3-page-heading"><div><span class="v3-creator-eyebrow">방송 스튜디오</span><h1>채널 관리</h1><p>시청자가 만나는 내 채널을 꾸며보세요.</p></div>${go('channel', '내 채널 보기', 'right', 'v3-btn')}</div><div class="v3-account-tabs" aria-label="채널 관리 메뉴">${['기본 정보', '브랜딩', '권한'].map(tab => action(tab, 'channel-tab', '', tab === state.channelTab ? 'active' : '', `data-tab="${tab}" ${tab === state.channelTab ? 'aria-current="page"' : ''}`)).join('')}</div>${disabled ? `<div class="v3-readonly-notice">${ico('shield')}<span>현재 역할은 <strong>${e(state.channelRole)}</strong>예요. 채널 정보는 소유자나 채널 관리자가 수정할 수 있어요.</span></div>` : ''}${viewState === '저장 오류' ? '<div class="v3-inline-error" role="alert">변경사항을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.</div>' : ''}<div class="v3-channel-management-grid"><section class="v3-channel-editor">${body}</section>${channelPreview()}</div></div>`;
  }

  F.pages.login = loginPage;
  F.pages.profile = profilePage;
  F.pages.security = accountPage;
  F.pages.preferences = preferencesPage;
  F.pages['channel-edit'] = channelPage;

  function render() { F.render(); }
  function dirty(scope) {
    state.dirty[scope] = true;
    document.querySelectorAll(`[data-v3-form="${scope}"] .v3-save-bar button[type="submit"]`).forEach(b => b.disabled = !canManage() && scope === 'channel');
    document.querySelectorAll(`[data-v3-form="${scope}"] .v3-save-note`).forEach(el => el.textContent = '저장하지 않은 변경사항이 있어요.');
  }
  function save(scope) {
    state.errors = {};
    const data = state[scope];
    if (scope === 'profile' && (!data.nickname.trim() || data.nickname.trim().length > 20)) state.errors.nickname = '닉네임은 1~20자로 입력해 주세요.';
    if (scope === 'channel' && !data.name.trim()) state.errors.name = '채널 이름을 입력해 주세요.';
    if (!/^[a-z0-9][a-z0-9_-]{2,23}$/i.test(data.handle)) state.errors.handle = '주소는 영문·숫자·밑줄·하이픈으로 3~24자 입력해 주세요.';
    if (Object.keys(state.errors).length) { render(); document.querySelector('.v3-account [aria-invalid="true"]')?.focus(); return; }
    if (scope === 'profile') F.nickname = data.nickname.trim();
    state.dirty[scope] = false;
    state.savedProfile = scope === 'profile' ? {...data} : state.savedProfile;
    state.savedChannel = scope === 'channel' ? {...data} : state.savedChannel;
    render();
    F.toast('변경사항을 저장했어요.');
  }
  function finishLogin() {
    F.sessionLoggedIn = true;
    state.loginStep = 'options';
    const destination = F.authReturn || 'live';
    F.authReturn = null;
    F.navigate(destination);
  }
  function filePicker(scope, banner = false) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0]; if (!file) return;
      const url = URL.createObjectURL(file);
      if (banner) state.uploadedBanner = url;
      else if (scope === 'channel') state.channelAvatarUrl = url;
      else state.avatarUrl = url;
      state.dirty[scope] = true; render();
    });
    input.click();
  }
  function dialog(title, body, confirmLabel, confirmAction) {
    F.genericDialog(title, body, confirmLabel);
    const button = F.dialog.querySelector('[data-action="confirm-generic"]');
    if (button) button.dataset.action = `v3-account-${confirmAction}`;
  }
  document.addEventListener('click', event => {
    const b = event.target.closest('[data-action^="v3-account-"]');
    if (!b || b.disabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const name = b.dataset.action.slice('v3-account-'.length);
    if (name === 'section') { state.section = b.dataset.section; state.errors = {}; F.navigate(b.dataset.page); }
    else if (name === 'choice') F.openChoice(b, JSON.parse(b.dataset.options), state[b.dataset.scope][b.dataset.key], value => { state[b.dataset.scope][b.dataset.key] = value; state.dirty[b.dataset.scope] = true; render(); });
    else if (name === 'toggle') { const on = !state.prefs[b.dataset.key]; state.prefs[b.dataset.key] = on; b.setAttribute('aria-checked', String(on)); F.toast('설정을 저장했어요.'); }
    else if (name === 'reset') { const scope = b.dataset.scope; if (scope === 'profile') state.profile = {...(state.savedProfile || { nickname: F.nickname || '봄', bio: '좋아하는 것을 만들고, 배우는 시간을 나눠요.', handle: 'spring' })}; else state.channel = {...(state.savedChannel || { name: '개발하는 봄', bio: '만들고 배우는 시간을 나누는 작은 작업실. 편하게 들렀다 가세요.', handle: 'spring', category: '개발 · 작업', visibility: '전체 공개', notice: '매주 화요일과 목요일 오후 8시에 만나요.' })}; state.dirty[scope] = false; state.errors = {}; render(); }
    else if (name === 'avatar') filePicker(b.dataset.scope);
    else if (name === 'banner-upload') filePicker('channel', true);
    else if (name === 'banner-preset') { state.banner = b.dataset.banner; state.uploadedBanner = ''; state.dirty.channel = true; render(); }
    else if (name === 'channel-tab') { state.channelTab = b.dataset.tab; state.errors = {}; render(); }
    else if (name === 'login-email') { state.loginStep = 'email'; state.loginError = ''; render(); }
    else if (name === 'login-provider') { state.loginStep = 'provider'; state.loginProvider = b.dataset.provider; render(); }
    else if (name === 'login-back') { state.loginStep = 'options'; state.loginError = ''; render(); }
    else if (name === 'login-complete') finishLogin();
    else if (name === 'login-help') dialog('로그인 도움말', '<p class="v3-dialog-text">이메일 주소와 연결한 계정을 확인해 주세요.</p>', '확인', 'dialog-close');
    else if (name === 'dialog-close') F.closeModal();
    else if (name === 'connection-details') dialog('Google 계정 연결', '<p class="v3-dialog-text">이 계정으로 FRAME에 로그인할 수 있어요.</p><div class="v3-dialog-detail"><strong>Google</strong><span>spring@example.test</span></div>', '확인', 'dialog-close');
    else if (name === 'connect-provider') { state.loginProvider = b.dataset.provider; state.loginStep = 'provider'; F.authReturn = 'security'; F.navigate('login'); }
    else if (name === 'security-details') dialog('보안 설정', '<p class="v3-dialog-text">로그인한 계정의 비밀번호와 추가 인증은 연결된 계정에서 관리할 수 있어요.</p><div class="v3-dialog-detail"><strong>Google 계정</strong><span>비밀번호 · 추가 인증</span></div>', '확인', 'dialog-close');
    else if (name === 'email-change') dialog('이메일 변경', field('새 이메일', 'new-email', '', 'email', '', { type: 'email', placeholder: '이메일 주소' }), '변경 내용 확인', 'email-preview');
    else if (name === 'email-preview') { const value = F.dialog.querySelector('[name="new-email"]')?.value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '')) { F.toast('올바른 이메일 주소를 입력해 주세요.'); return; } F.closeModal(); F.toast('이메일 변경 내용을 확인했어요.'); }
    else if (name === 'device-confirm') { state.pendingDevice = b.dataset.device; dialog('기기에서 로그아웃할까요?', '<p class="v3-dialog-text">선택한 기기는 다음 이용 시 다시 로그인해야 해요.</p>', '로그아웃', 'device-remove'); }
    else if (name === 'device-remove') { state.devices = state.devices.filter(d => d.current || (state.pendingDevice !== 'all' && d.id !== state.pendingDevice)); F.closeModal(); F.toast('기기 목록을 업데이트했어요.'); }
    else if (name === 'invite-member') dialog('채널 멤버 추가', `${field('닉네임 또는 이메일', 'member-name', '', 'member', '', { placeholder: '추가할 멤버 입력' })}${choice('역할', 'inviteRole', state.inviteRole || '채팅 운영자', ['채널 관리자', '채팅 운영자'], 'accountDesign')}`, '추가', 'member-add');
    else if (name === 'member-add') { const value = F.dialog.querySelector('[name="member-name"]')?.value.trim(); if (!value) { F.toast('추가할 멤버를 입력해 주세요.'); return; } state.members.push({ id: `member-${Date.now()}`, name: value, initial: value[0], role: state.inviteRole || '채팅 운영자', status: '초대 대기' }); F.closeModal(); F.toast('멤버 목록에 추가했어요.'); }
    else if (name === 'member-role') { const member = state.members.find(m => m.id === b.dataset.member); if (member) F.openChoice(b, ['채널 관리자', '채팅 운영자'], member.role, role => { member.role = role; render(); }); }
    else if (name === 'remove-member') { state.pendingMember = b.dataset.member; dialog('채널 멤버를 삭제할까요?', '<p class="v3-dialog-text">이 멤버는 채널 관리 메뉴를 이용할 수 없게 돼요.</p>', '삭제', 'member-remove'); }
    else if (name === 'member-remove') { state.members = state.members.filter(m => m.id !== state.pendingMember); F.closeModal(); }
  }, true);

  // Keep local drafts while moving between settings sections; never submit credentials to a server.
  document.addEventListener('input', event => {
    const input = event.target;
    const scope = input.dataset.v3Scope;
    if (!['profile', 'channel'].includes(scope)) return;
    state[scope][input.name] = input.value;
    delete state.errors[input.name]; dirty(scope);
    if (scope === 'channel') {
      const name = document.querySelector('.v3-preview-channel-name');
      const bio = document.querySelector('.v3-preview-channel-bio');
      if (name) name.textContent = state.channel.name || '채널 이름';
      if (bio) bio.textContent = state.channel.bio;
    }
  }, true);
  document.addEventListener('submit', event => {
    const form = event.target.closest('[data-v3-form]');
    if (!form) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (form.dataset.v3Form === 'login') {
      const data = new FormData(form);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.get('email') || '')) || !String(data.get('password') || '').trim()) { state.loginError = '이메일 주소와 비밀번호를 확인해 주세요.'; render(); return; }
      finishLogin();
    } else save(form.dataset.v3Form);
  }, true);
})();
