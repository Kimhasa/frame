/* Account and studio review: local forms and accessibility, without replacing media controls. */
(() => {
  const F = window.F;
  if (!F?.accountDesign) return;
  const state = F.v33Account = {consent: false, loginEmail: '', connection: null, manual: null, keepRecording: true, operation: 0, detailsFailure: false};
  const pages = {login: F.pages.login, profile: F.pages.profile, security: F.pages.security, preferences: F.pages.preferences, channel: F.pages['channel-edit']};
  const modals = Object.fromEntries(['sources', 'broadcast-settings', 'connection', 'broadcast-details', 'broadcast-end', 'nickname', 'manual'].map(id => [id, F.modals[id]]));
  const studio = F.studio, render = F.render, closeModal = F.closeModal, navigate = F.navigate;
  const holder = html => {const node = document.createElement('div');node.innerHTML = html;return node;};
  const control = (scope, name) => scope.querySelector(`[name="${name}"]`);
  const stableStudioLabels = html => html.replace(/<input\b[^>]*data-v3-studio-field="(title|tags)"[^>]*>/g, (tag, key) => /\baria-label=/.test(tag) ? tag : tag.replace('<input ', `<input aria-label="${key === 'title' ? '방송 제목' : '태그'}" `));
  const stop = event => {event.preventDefault();event.stopImmediatePropagation();};
  const mark = (scope, name, message) => {
    const input = control(scope, name);if (!input) return;
    const field = input.closest('.v3-field,.field,.v3-studio-field') || input.parentElement;
    let error = field.querySelector('.v33-account-field-error');
    if (!error) {error = document.createElement('small');error.className = 'v33-account-field-error';error.id = `v33-error-${name}`;field.append(error);}
    error.textContent = message;error.setAttribute('role', 'alert');input.setAttribute('aria-invalid', 'true');input.setAttribute('aria-describedby', error.id);field.classList.add('v33-account-invalid');
  };
  const clearError = input => {
    const field = input.closest('.v3-field,.field,.v3-studio-field');
    field?.querySelector('.v33-account-field-error')?.remove();field?.classList.remove('v33-account-invalid');
    if (input.getAttribute('aria-describedby')?.startsWith('v33-error-')) {input.removeAttribute('aria-describedby');input.removeAttribute('aria-invalid');}
  };
  const firstInvalid = scope => scope.querySelector('[aria-invalid="true"]')?.focus({preventScroll: true});
  const alertRoles = root => root.querySelectorAll('.inline-notice.error,.v3-inline-error,.v3-studio-notice').forEach(node => node.setAttribute('role', 'alert'));

  F.pages.login = viewState => {
    const h = holder(pages.login(viewState));const page = h.querySelector('.v3-login');if (!page) return h.innerHTML;
    page.classList.add('v33-account-login');
    const form = page.querySelector('[data-v3-form="login"]');
    if (form) {form.noValidate = true;const email = control(form, 'email');if (email && !email.value) {email.value = state.loginEmail;email.setAttribute('value', state.loginEmail);}}
    if (viewState === '동의 필요' && F.accountDesign.loginStep === 'options') {
      const consent = document.createElement('label');consent.className = 'v33-account-consent';
      consent.innerHTML = `<input id="v33-account-consent" type="checkbox" data-v33-account-consent ${state.consent ? 'checked' : ''}><span>이용약관과 개인정보 처리방침을 확인했어요.</span>`;
      const policy = page.querySelector('.v3-login-policy');policy?.before(consent);
      page.querySelectorAll('[data-action="v3-account-login-provider"],[data-action="v3-account-login-email"]').forEach(button => {button.disabled = !state.consent;button.setAttribute('aria-describedby', 'v33-account-consent');});
    }
    alertRoles(page);return h.innerHTML;
  };
  F.pages.profile = viewState => pages.profile(viewState);
  F.pages.preferences = viewState => pages.preferences(viewState);
  F.pages.security = viewState => {
    const h = holder(pages.security(viewState));
    if (viewState === '재인증 필요') {
      const notice = h.querySelector('.v3-inline-error');
      if (notice) {notice.classList.add('v33-account-reauth');notice.append(holder(F.btn('다시 로그인', 'v33-account-reauth', 'user', 'v3-btn')).firstElementChild);}
    }
    return h.innerHTML;
  };
  F.pages['channel-edit'] = viewState => {
    if (viewState === '저장 오류') F.accountDesign.dirty.channel = true;
    const h = holder(pages.channel(viewState));const page = h.querySelector('.v3-channel-management');if (!page) return h.innerHTML;
    page.classList.add('v33-account-channel');
    const id = page.querySelector('[name="handle"][data-v3-scope="channel"]');
    if (id && F.accountDesign.errors.handle) {id.setAttribute('aria-invalid', 'true');const error = id.closest('.v3-field').querySelector('small');if (error) {error.id = 'v33-channel-handle-error';error.setAttribute('role', 'alert');id.setAttribute('aria-describedby', error.id);}}
    alertRoles(page);return h.innerHTML;
  };
  F.studio = viewState => {
    if (viewState === '방송 전') F.broadcasting = false;
    if (viewState === '방송 중') F.broadcasting = true;
    return stableStudioLabels(studio(viewState));
  };
  F.navigate = (id, viewState, replace = false) => navigate(id, id === 'studio' && !viewState && F.broadcasting ? '방송 중' : viewState, replace);

  F.modals.sources = viewState => {
    const cfg = modals.sources(viewState),h = holder(cfg.body),f = holder(cfg.footer);
    const cards = [...h.querySelectorAll('.source-card')];
    if (viewState === '창 닫힘') cards.filter(card => card.querySelector('.thumb-status')).forEach(card => {card.disabled = true;card.setAttribute('aria-disabled', 'true');card.setAttribute('aria-pressed', 'false');card.classList.remove('selected');card.querySelector('.selected-tick')?.remove();});
    const selected = cards.find(card => card.dataset.source === F.source && !card.disabled);
    const confirm = f.querySelector('[data-action="source-confirm"]');if (confirm) confirm.disabled = !selected;
    h.querySelectorAll('.thumb-status').forEach(status => {status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');});
    if (viewState === '불러오는 중') {h.querySelector('.source-grid')?.setAttribute('aria-busy', 'true');}
    const list = h.querySelector('.source-tabs');if (list) list.querySelectorAll('button').forEach(button => {button.tabIndex = button.getAttribute('aria-selected') === 'true' ? 0 : -1;});
    return {...cfg,body: h.innerHTML,footer: f.innerHTML,cls: `${cfg.cls || ''} v33-account-source`};
  };
  F.modals['broadcast-settings'] = viewState => {
    const cfg = modals['broadcast-settings'](viewState),h = holder(cfg.body);
    h.querySelectorAll('[data-action="toggle"]').forEach(button => {
      const name = button.dataset.key === 'bitrate-auto' ? '비트레이트 자동 설정' : button.dataset.key === 'recording' ? '방송 녹화' : button.closest('.setting-row')?.querySelector('strong')?.textContent || '설정';
      button.setAttribute('aria-label', name);button.setAttribute('role', 'switch');
      if (!button.hasAttribute('aria-checked')) button.setAttribute('aria-checked', 'false');
    });
    h.querySelectorAll('.field.invalid').forEach(field => {const input = field.querySelector('input,button');const error = field.querySelector('small');if (input && error) {error.id = 'v33-broadcast-setting-error';error.setAttribute('role', 'alert');input.setAttribute('aria-invalid', 'true');input.setAttribute('aria-describedby', error.id);}});
    return {...cfg,body: h.innerHTML};
  };

  function connectionModal(viewState, manual = false) {
    const id = manual ? 'manual' : 'connection',cfg = modals[id](viewState),h = holder(cfg.body),f = holder(cfg.footer);
    if (!state[id]) {state[id] = Object.fromEntries([...h.querySelectorAll('input[name]')].map(input => [input.name, input.value]));if (!manual) state.savedConnection = {...state[id]};}
    h.querySelectorAll('input[name]').forEach(input => {input.value = state[id][input.name] ?? input.value;input.setAttribute('value', input.value);input.dataset.v33AccountDraft = id;});
    const busy = viewState === (manual ? '연결 중' : '연결 확인 중');
    h.querySelectorAll('.inline-notice.error').forEach(notice => notice.setAttribute('role', 'alert'));
    if (busy) {
      const status = h.querySelector('.row.help');if (status) {status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');}
      const button = f.querySelector(`[data-action="${manual ? 'manual-connect' : 'connection-test'}"]`);if (button) {button.disabled = true;button.setAttribute('aria-disabled', 'true');}
      if (!manual) {const save = f.querySelector('[data-action="save-connection"]');if (save) save.disabled = true;}
    }
    return {...cfg,body: `<div class="v33-account-connection" ${busy ? 'aria-busy="true"' : ''}>${h.innerHTML}</div>`,footer: f.innerHTML,cls: `${cfg.cls || ''} v33-account-modal`};
  }
  F.modals.connection = viewState => connectionModal(viewState);
  F.modals.manual = viewState => connectionModal(viewState, true);
  F.modals['broadcast-details'] = viewState => {
    if (viewState !== '입력 오류') state.detailsFailure = false;
    if (viewState === '입력 오류' && !state.detailsFailure) {F.studioModalDraft = {...F.studioDraft, title: ''};F.studioTitleError = true;state.detailsFailure = true;}
    const cfg = modals['broadcast-details'](viewState);return {...cfg,body: stableStudioLabels(cfg.body),cls: `${cfg.cls || ''} v33-account-modal`};
  };
  F.modals['broadcast-end'] = viewState => {
    const cfg = modals['broadcast-end'](viewState),h = holder(cfg.body),f = holder(cfg.footer);
    if (viewState === '종료 확인') {
      if (F.studioDraft?.title) {const title = document.createElement('p');title.className = 'v33-account-broadcast-title';title.textContent = F.studioDraft.title;h.prepend(title);}
      const input = h.querySelector('input[type="checkbox"]');if (input) {input.checked = state.keepRecording;input.dataset.v33AccountRecording = '';if (input.checked) input.setAttribute('checked', '');else input.removeAttribute('checked');}
    } else if (!state.keepRecording) {h.querySelector('.help')?.remove();f.querySelector('[data-go="recordings"]')?.remove();}
    return {...cfg,body: h.innerHTML,footer: f.innerHTML,cls: `${cfg.cls || ''} v33-account-modal`};
  };
  F.modals.nickname = viewState => {
    const cfg = modals.nickname(viewState),h = holder(cfg.body);const input = control(h, 'nickname');
    if (input) {input.setAttribute('aria-label', '닉네임');input.setAttribute('maxlength', '20');if (viewState === '입력 오류') mark(h, 'nickname', '닉네임은 1~20자로 입력하세요.');}
    const form = h.querySelector('form');if (form) form.noValidate = true;
    return {...cfg,body: h.innerHTML,cls: `${cfg.cls || ''} v33-account-modal`};
  };

  function validateConnection(scope, manual) {
    const server = manual ? 'viewer-server' : 'server',port = manual ? 'viewer-port' : 'publish-port',stream = manual ? 'viewer-stream' : 'stream-id';
    let valid = true;
    const host = control(scope, server)?.value.trim() || '';
    let hostValid = false;
    try {const url = new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`);hostValid = !!host && !/[\s/@?#]/.test(host) && !url.port && !url.username && url.pathname === '/';} catch {}
    if (!hostValid) {mark(scope, server, '서버 IP 또는 호스트 이름을 입력하세요.');valid = false;}
    for (const name of manual ? [port] : ['publish-port', 'view-port']) {const input = control(scope, name),value = Number(input?.value);if (!input?.value.trim() || !Number.isInteger(value) || value < 1 || value > 65535) {mark(scope, name, '포트는 1~65535 사이의 정수로 입력하세요.');valid = false;}}
    if (!control(scope, stream)?.value.trim()) {mark(scope, stream, '스트림 ID를 입력하세요.');valid = false;}
    if (!valid) firstInvalid(scope);return valid;
  }
  // Window capture runs before the original document handlers, preserving valid original flows.
  window.addEventListener('submit', event => {
    const form = event.target;
    if (form.id === 'v3-account-login-form') {
      const email = control(form, 'email'),password = control(form, 'password');let valid = true;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {mark(form, 'email', '이메일 주소를 확인하세요.');valid = false;}
      if (!password.value.trim()) {mark(form, 'password', '비밀번호를 입력하세요.');valid = false;}
      if (!valid) {stop(event);firstInvalid(form);}
    }
    if (form.id === 'nickname-form') {const input = control(form, 'nickname');if (!input.value.trim() || input.value.trim().length > 20) {stop(event);mark(form, 'nickname', '닉네임은 1~20자로 입력하세요.');firstInvalid(form);}}
    if (form.dataset?.v3Form === 'channel') {
      const channel = F.accountDesign.channel,errors = {};
      if (!channel.name.trim()) errors.name = '채널 이름을 입력하세요.';
      if (!/^[a-z0-9][a-z0-9_-]{2,23}$/i.test(channel.handle)) errors.handle = '채널 주소는 영문·숫자로 시작하는 3~24자로 입력하세요.';
      if (Object.keys(errors).length) {stop(event);F.accountDesign.errors = errors;F.accountDesign.channelTab = '기본 정보';F.render();firstInvalid(F.root);}
    }
  }, true);
  window.addEventListener('click', event => {
    const button = event.target.closest?.('button');if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'connection-test' || action === 'save-connection' || action === 'manual-connect') {
      const manual = action === 'manual-connect';if (!validateConnection(F.dialog, manual)) {stop(event);return;}
      if (action === 'save-connection') state.connectionAccepted = true;
      if (action !== 'save-connection') {
        stop(event);const token = ++state.operation,id = manual ? 'manual' : 'connection';F.setState(manual ? '연결 중' : '연결 확인 중');
        setTimeout(() => {if (state.operation !== token || F.screen !== id) return;if (manual) F.navigate('watch');else {F.setState('기본');F.toast('입력 형식을 확인했어요.');}}, 650);
      }
    }
    if (action === 'apply-settings') {const input = control(F.dialog, 'bitrate');if (input && !input.disabled && (!Number.isFinite(Number(input.value)) || !input.value.trim() || Number(input.value) < .5 || Number(input.value) > 200)) {stop(event);mark(F.dialog, 'bitrate', '0.5~200 Mbps 사이의 값을 입력하세요.');firstInvalid(F.dialog);}}
    if (action === 'v3-account-email-preview') {const input = control(F.dialog, 'new-email');if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input?.value.trim() || '')) {stop(event);mark(F.dialog, 'new-email', '이메일 주소를 확인하세요.');firstInvalid(F.dialog);}}
    if (action === 'v3-account-member-add') {const input = control(F.dialog, 'member-name');if (!input?.value.trim()) {stop(event);mark(F.dialog, 'member-name', '추가할 닉네임 또는 이메일을 입력하세요.');firstInvalid(F.dialog);}}
    if (action === 'v33-account-reauth') {stop(event);F.authReturn = 'security';F.navigate('login');}
  }, true);
  window.addEventListener('input', event => {
    const input = event.target;
    if (input.closest?.('.v33-account-login,.v33-account-channel,.v33-account-modal,.v3-account-dialog')) clearError(input);
    if (input.dataset?.v3Scope === 'channel' && F.accountDesign.errors[input.name]) {const field = input.closest('.v3-field');field?.querySelector('small')?.remove();field?.classList.remove('has-error');input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}
    if (input.dataset?.v33AccountDraft) state[input.dataset.v33AccountDraft][input.name] = input.value;
    if (input.closest?.('#v3-account-login-form') && input.name === 'email') state.loginEmail = input.value;
  }, true);
  window.addEventListener('change', event => {
    if (event.target.hasAttribute?.('data-v33-account-consent')) {state.consent = event.target.checked;F.root.querySelectorAll('[data-action="v3-account-login-provider"],[data-action="v3-account-login-email"]').forEach(button => button.disabled = !state.consent);}
    if (event.target.hasAttribute?.('data-v33-account-recording')) state.keepRecording = event.target.checked;
  }, true);
  window.addEventListener('keydown', event => {
    const button = event.target.closest?.('.source-tabs [role="tab"]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    stop(event);const buttons = [...button.parentElement.querySelectorAll('button')],index = buttons.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    const tab = buttons[next].dataset.tab;buttons[next].click();
    F.dialog.querySelectorAll('.source-tabs button').forEach(candidate => {if (candidate.dataset.tab === tab) candidate.focus({preventScroll: true});});
  }, true);

  F.closeModal = () => {
    state.operation++;
    if (F.screen === 'connection') {if (state.connectionAccepted) state.savedConnection = {...state.connection};else if (state.savedConnection) state.connection = {...state.savedConnection};state.connectionAccepted = false;}
    if (F.screen === 'broadcast-details') {F.studioModalDraft = null;F.studioTitleError = false;state.detailsFailure = false;}
    return closeModal();
  };
  F.render = () => {
    const active = document.activeElement,channelSave = F.screen === 'channel-edit' && active?.closest?.('[data-v3-form="channel"]') && (active.matches('button[type="submit"]') || active.dataset.action === 'v3-account-reset');
    render();
    if (channelSave && F.currentBase === 'channel-edit' && !Object.keys(F.accountDesign.errors).length) {const title = F.root.querySelector('.v3-channel-management h1');if (title) {title.tabIndex = -1;title.focus({preventScroll: true});}}
  };
  if (window.FRAME_PROTOTYPE) window.FRAME_PROTOTYPE.navigate = F.navigate;
  F.render();
})();
