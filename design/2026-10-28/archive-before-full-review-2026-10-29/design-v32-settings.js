/* Settings presentation only; original account drafts, forms and actions stay in charge. */
(() => {
  const F = window.F;
  if (!F?.accountDesign || !F.pages?.profile) return;
  const originals = {profile: F.pages.profile, security: F.pages.security, preferences: F.pages.preferences};
  const render = F.render;
  const userIdHelp = '영문·숫자로 시작하는 3~24자, 밑줄(_)·하이픈(-)을 사용할 수 있어요.';
  const make = (tag, className, value = '') => {const node = document.createElement(tag);node.className = className;if (value) node.textContent = value;return node;};
  const sectionIds = {'프로필': 'profile', '계정 연결': 'connections', '보안 및 기기': 'security', '알림': 'notifications', '재생': 'playback'};
  const preferenceCopy = {
    live: ['방송 시작 알림', '팔로우한 채널'],
    mentions: ['멘션 알림', '채팅에서 내 이름이 언급될 때'],
    replies: ['댓글 및 답글', ''],
    news: ['업데이트 소식', ''],
    autoplay: ['자동 재생', '방송을 선택하면 바로 재생'],
    resume: ['이어서 재생', ''],
    chat: ['채팅창 기본 표시', ''],
    reducedMotion: ['움직임 줄이기', '화면 전환과 장식 애니메이션에 적용']
  };

  function navigation(page) {
    const nav = page.querySelector('.v3-settings-nav');
    const panel = page.querySelector('.v3-settings-body');
    if (!nav || !panel) return '';
    const current = nav.querySelector('button.active');
    const name = current?.dataset.section || '프로필';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', '내 설정');
    panel.id = 'v32-settings-panel';panel.setAttribute('role', 'tabpanel');
    nav.querySelectorAll('button').forEach(button => {
      const selected = button === current;
      button.id = `v32-settings-tab-${sectionIds[button.dataset.section] || 'profile'}`;
      button.setAttribute('role', 'tab');button.setAttribute('aria-selected', String(selected));
      button.setAttribute('aria-controls', panel.id);button.tabIndex = selected ? 0 : -1;
    });
    if (current) panel.setAttribute('aria-labelledby', current.id);
    return name;
  }

  function profile(page) {
    const identity = page.querySelector('.v3-profile-identity');
    const copy = identity?.querySelector(':scope>div');
    const photo = identity?.querySelector('[data-action="v3-account-avatar"]');
    const publicChannel = identity?.querySelector('[data-go="channel"]');
    if (copy) {
      copy.querySelector('strong').textContent = '프로필 사진';
      copy.querySelector('span')?.remove();
    }
    if (photo) {
      photo.className = 'v3-btn v32-settings-photo-button';
      identity.append(photo);
    }
    if (publicChannel) {
      publicChannel.classList.add('v32-settings-channel-link');
      publicChannel.innerHTML = `내 채널 보기${F.icon('right')}`;
      page.querySelector('.v3-section-heading').append(publicChannel);
    }
    const handle = page.querySelector('[name="handle"][data-v3-scope="profile"]');
    if (handle) {
      const field = handle.closest('.v3-field');
      field.querySelector('label').textContent = '사용자 ID';
      handle.setAttribute('aria-label', '사용자 ID');
      handle.parentElement.querySelector('span').textContent = '@';
      let helper = field.querySelector('small');
      if (!helper) {helper = make('small', '');field.append(helper);}
      helper.id = 'v32-settings-user-id-help';
      if (!F.accountDesign.errors.handle) helper.textContent = userIdHelp;
      else {helper.textContent = '사용자 ID는 영문·숫자로 시작하는 3~24자로 입력하세요.';helper.classList.add('v3-error');handle.setAttribute('aria-invalid', 'true');field.classList.add('has-error');}
      handle.setAttribute('aria-describedby', helper.id);
    }
    const bioLabel = page.querySelector('label[for="v3-profile-bio"]');
    if (bioLabel) bioLabel.textContent = '자기소개';
    const footer = page.querySelector('.v3-save-bar');
    if (footer) {
      footer.classList.toggle('has-changes', !!F.accountDesign.dirty.profile);
      const note = footer.querySelector('.v3-save-note');
      note.textContent = F.accountDesign.dirty.profile ? '저장하지 않은 변경사항이 있어요.' : '';
      note.setAttribute('aria-live', 'polite');
      footer.querySelector('[type="submit"]').textContent = '변경사항 저장';
    }
  }

  function connections(page) {
    const rows = [...page.querySelectorAll('.v3-account-connected')];
    if (rows.length) {
      const list = make('div', 'v32-settings-connections');rows[0].before(list);
      rows.forEach(row => {
        const content = row.querySelector(':scope>div:nth-child(2)');
        const title = content?.querySelector('strong');
        const status = row.querySelector('.v3-connection-tag');
        if (title) {const titleLine = make('div', 'v32-settings-provider-title');title.before(titleLine);titleLine.append(title);if (status) titleLine.append(status);}
        const manage = row.querySelector('[data-action="v3-account-connection-details"]');
        if (manage) {manage.className = 'v3-btn v32-settings-provider-manage';manage.innerHTML = `관리${F.icon('right')}`;}
        const naver = row.querySelector('.v3-provider-icon.naver');
        if (naver) content?.querySelector('p')?.remove();
        list.append(row);
      });
    }
    const emailBlock = page.querySelector('.v3-account-email-block');
    if (emailBlock) {
      const heading = emailBlock.querySelector('.v3-section-heading');
      if (heading) {heading.innerHTML = '<h3>알림 이메일</h3>';heading.classList.add('v32-settings-block-heading');}
      const row = emailBlock.querySelector('.v3-readonly-row');
      row?.querySelector(':scope>span')?.remove();
      row?.querySelector('[data-action="v3-account-email-change"]')?.classList.add('v3-btn');
    }
  }

  function security(page) {
    const summary = page.querySelector('.v3-security-summary');
    if (summary) {
      summary.querySelector('strong').textContent = '로그인 보안';
      summary.querySelector('p').textContent = '비밀번호와 추가 인증은 연결한 계정에서 관리해요.';
    }
    page.querySelectorAll('.v3-device').forEach((row, index) => {
      const device = F.accountDesign.devices[index];
      if (!device) return;
      if (device.current) {
        const tag = row.querySelector('.v3-connection-tag');
        if (tag) {tag.textContent = '현재 사용 중';row.querySelector(':scope>div').append(tag);}
        row.querySelector('p')?.remove();
        row.classList.add('is-current');
      }
      if (/iPhone|Android|모바일|iPad/i.test(device.name)) {
        row.querySelector('.v3-device-icon').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 5h4m-3 14h2"/></svg>';
      }
    });
    const count = page.querySelector('.v3-subsection-title>span');
    if (count) count.textContent = `${F.accountDesign.devices.length}대`;
    const all = page.querySelector('[data-action="v3-account-device-confirm"][data-device="all"]');
    if (all) {
      all.innerHTML = `${F.icon('logout')}다른 기기에서 로그아웃`;all.disabled = !F.accountDesign.devices.some(device => !device.current);
      if (all.disabled) all.before(make('span', 'v32-settings-device-note', F.accountDesign.devices.length ? '현재 기기만 로그인되어 있어요.' : '로그인한 다른 기기가 없어요.'));
    }
    if (!F.accountDesign.devices.length) page.querySelector('.v3-device-list')?.append(make('p', 'v32-settings-device-empty', '로그인한 기기가 없어요.'));
  }

  function preferences(page, viewState, section) {
    page.querySelectorAll('.v3-setting').forEach(row => {
      const button = row.querySelector('[data-action="v3-account-toggle"]');
      const copy = preferenceCopy[button?.dataset.key];
      if (!button || !copy) return;
      row.querySelector('strong').textContent = copy[0];
      const description = row.querySelector('p');
      if (copy[1]) {if (description) description.textContent = copy[1];}
      else description?.remove();
      row.classList.toggle('has-description', !!copy[1]);
      row.dataset.action = 'v32-settings-toggle-row';
      button.setAttribute('aria-label', copy[0]);
    });
    const foot = page.querySelector('.v3-notification-foot');
    if (foot) {foot.querySelector('span')?.remove();foot.querySelector('button').innerHTML = `채널별 알림 설정${F.icon('right')}`;}
    if (section === '알림' && viewState === '알림 차단') {
      const heading = page.querySelector('.v3-settings-body>.v3-section-heading');
      const notice = make('div', 'v32-settings-permission');notice.setAttribute('role', 'status');
      notice.innerHTML = `${F.icon('bell')}<div><strong>브라우저 알림이 차단되어 있어요.</strong><p>알림을 받으려면 사이트 설정에서 허용하세요.</p></div><button type="button" class="v3-text-button" data-action="v32-settings-permission-help">설정 방법${F.icon('right')}</button>`;
      heading.after(notice);
    }
  }

  function refine(html, id, viewState) {
    const holder = document.createElement('div');holder.innerHTML = html;
    const page = holder.querySelector('.v3-settings');
    if (!page) return html;
    page.classList.add('v32-settings');
    page.querySelector('.v3-page-heading p')?.remove();
    const section = navigation(page);
    page.dataset.settingsSection = sectionIds[section] || 'profile';
    const heading = page.querySelector('.v3-settings-body>.v3-section-heading');
    heading?.querySelector('p')?.remove();
    if (id === 'profile') profile(page);
    else if (section === '계정 연결') connections(page);
    else if (section === '보안 및 기기') security(page);
    else preferences(page, viewState, section);
    return holder.innerHTML;
  }

  for (const id of Object.keys(originals)) F.pages[id] = state => refine(originals[id](state), id, state);

  F.render = () => {
    const active = document.activeElement;
    const profile = F.screen === 'profile' && active?.closest?.('.v32-settings [data-v3-form="profile"]');
    const action = active?.dataset?.action;
    const submitted = profile && (active.matches('button[type="submit"]') || action === 'v3-account-reset' || (!F.accountDesign.dirty.profile && active.matches('input,textarea')));
    render();
    if (submitted && F.currentBase === 'profile' && !Object.keys(F.accountDesign.errors).length) {
      const heading = F.root.querySelector('.v32-settings .v3-settings-body>.v3-section-heading h2');
      if (heading) {heading.tabIndex = -1;heading.focus({preventScroll: true});}
    }
  };

  document.addEventListener('click', event => {
    const help = event.target.closest?.('[data-action="v32-settings-permission-help"]');
    if (help) {
      event.preventDefault();event.stopImmediatePropagation();
      F.currentBase = F.screen;
      F.genericDialog('브라우저 알림 설정', '<div class="v32-settings v32-settings-help"><p>주소창 왼쪽의 사이트 정보를 열고 알림 권한을 확인하세요.</p><p>브라우저에서 허용한 뒤 이 화면으로 돌아오세요.</p></div>', '닫기');
      const close = F.dialog.querySelector('[data-action="confirm-generic"]');
      if (close) close.dataset.action = 'v32-settings-dialog-close';
      F.dialog.querySelector('.modal-footer [data-action="close-modal"]')?.remove();
      return;
    }
    if (event.target.closest?.('[data-action="v32-settings-dialog-close"]')) {event.preventDefault();event.stopImmediatePropagation();F.closeModal();return;}
    const row = event.target.closest?.('[data-action="v32-settings-toggle-row"]');
    if (!row || event.target.closest('button,a,input,textarea')) return;
    event.preventDefault();event.stopImmediatePropagation();
    row.querySelector('[data-action="v3-account-toggle"]')?.click();
  }, true);
  document.addEventListener('input', event => {
    if (event.target.dataset?.v3Scope !== 'profile') return;
    const page = event.target.closest('.v32-settings');if (!page) return;
    page.querySelector('.v3-save-bar')?.classList.add('has-changes');
    const field = event.target.closest('.v3-field');
    if (field?.classList.contains('has-error') || event.target.getAttribute('aria-invalid') === 'true') {
      field?.classList.remove('has-error');event.target.removeAttribute('aria-invalid');
      const help = field?.querySelector('small');
      if (help) {help.classList.remove('v3-error');help.textContent = event.target.name === 'handle' ? userIdHelp : event.target.name === 'nickname' ? '1~20자 이내로 입력하세요.' : '';}
    }
    if (F.screen === 'profile' && F.viewState === '닉네임 오류') {F.viewState = '기본';F.writeUrl(true);}
  }, true);

  if (['profile', 'security', 'preferences'].includes(F.currentBase)) F.render();
})();
