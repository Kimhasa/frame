/* Local source-selection transaction and review-state start guards; no capture or server checks. */
(() => {
  const F = window.F;
  if (!F?.modals?.sources || !F.studio) return;
  const sources = F.modals.sources, studio = F.studio, navigate = F.navigate, closeModal = F.closeModal, readUrl = F.readUrl;
  const sourceErrors = new Set(['화면 선택 전', '화면 연결 끊김', '선택 창 종료', '창 닫힘']);
  const closedStates = new Set(['선택 창 종료', '창 닫힘']);
  const S = F.v36SourceFlow = {open: false, committed: null, pending: null, pendingName: '', confirming: false, invalidSource: null};
  const holder = html => {const h = document.createElement('div');h.innerHTML = html;return h;};
  const stop = event => {event.preventDefault();event.stopImmediatePropagation();};
  const reason = state => state === '방송 연결 실패' ? 'connection' : sourceErrors.has(state) || !F.source || !!S.invalidSource && S.invalidSource === F.source ? 'source' : null;
  S.readiness = () => ({allowed: !reason(F.viewState), reason: reason(F.viewState), validation: 'local-review-state-only'});

  function begin() {
    if (S.open) return;
    S.open = true;S.committed = F.source;
    S.pending = F.screen === 'studio' && F.viewState === '화면 선택 전' ? null : F.source;
    S.pendingName = '';S.confirming = false;
  }
  function discard() {
    if (!S.open) return;
    F.source = S.committed;
    S.open = false;S.confirming = false;S.pending = null;S.pendingName = '';
  }
  function originalConfig(viewState) {
    const committed = F.source;
    let config;
    try {F.source = S.pending;config = sources(viewState);}
    finally {F.source = committed;}
    const h = holder(config.body), cards = [...h.querySelectorAll('.source-card')];
    const old = cards.find(card => card.dataset.source === S.committed);
    if (viewState === '창 닫힘' && old?.disabled) S.invalidSource = S.committed;
    const selected = cards.find(card => card.dataset.source === S.pending && !card.disabled);
    if (selected) S.pendingName = selected.querySelector('.source-name')?.textContent.trim() || S.pending;
    return {config, selected};
  }
  F.modals.sources = viewState => {
    begin();
    const {config, selected} = originalConfig(viewState);
    if (S.confirming && selected) return {
      ...config, title: '방송 화면을 변경할까요?', cls: 'medium v36-source-confirm',
      body: `<p class="v36-source-confirm-copy">선택한 화면이 시청자에게 바로 표시됩니다.</p><p class="v36-source-confirm-name">${F.e(S.pendingName)}</p>`,
      footer: `${F.btn('다시 선택', 'v36-source-back')}${F.btn('화면 변경', 'v36-source-apply', '', 'primary')}`
    };
    S.confirming = false;
    const footer = holder(config.footer), confirm = footer.querySelector('[data-action="source-confirm"]');
    if (confirm) confirm.disabled = !selected;
    return {...config, footer: footer.innerHTML};
  };

  function apply() {
    const {selected} = originalConfig(F.viewState);
    if (!selected) {S.confirming = false;F.renderModal();return;}
    const selectedSource = S.pending, changed = selectedSource !== S.committed;
    F.source = selectedSource;S.invalidSource = null;
    S.open = false;S.confirming = false;S.pending = null;S.pendingName = '';
    F.closeModal();
    if (F.currentBase === 'studio' && sourceErrors.has(F.viewState)) F.navigate('studio', F.broadcasting ? '방송 중' : '방송 전', true);
    if (changed) F.toast('공유할 화면을 변경했어요.');
  }

  F.studio = viewState => {
    const blocked = reason(viewState), displayState = closedStates.has(viewState) || !!S.invalidSource && S.invalidSource === F.source ? '화면 연결 끊김' : viewState;
    const h = holder(studio(displayState));
    h.querySelectorAll('[data-action="v3-studio-start"],[data-action="start-broadcast"]').forEach(button => {
      if (!blocked) return;
      button.disabled = true;button.setAttribute('aria-disabled', 'true');
      button.title = blocked === 'connection' ? '연결 설정을 확인해 주세요.' : '방송할 화면을 선택해 주세요.';
    });
    return h.innerHTML;
  };

  window.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'v3-studio-start' || action === 'start-broadcast') {
      const blocked = reason(F.viewState);
      if (blocked) {stop(event);F.navigate(blocked === 'connection' ? 'connection' : 'sources');}
      return;
    }
    if (button.disabled) return;
    if (F.screen !== 'sources' || !S.open) return;
    if (action === 'source-select') {
      stop(event);S.pending = button.dataset.source;S.confirming = false;F.renderModal();
      [...F.dialog.querySelectorAll('[data-source]')].find(card => card.dataset.source === S.pending)?.focus({preventScroll: true});
    } else if (action === 'source-confirm') {
      stop(event);
      const {selected} = originalConfig(F.viewState);
      if (!selected) {F.renderModal();return;}
      if (F.broadcasting && S.pending !== S.committed) {
        S.confirming = true;F.renderModal();F.dialog.querySelector('[data-action="v36-source-apply"]')?.focus({preventScroll: true});
      } else apply();
    } else if (action === 'v36-source-back') {
      stop(event);S.confirming = false;F.renderModal();F.dialog.querySelector('[data-action="source-confirm"]')?.focus({preventScroll: true});
    } else if (action === 'v36-source-apply') {stop(event);apply();}
  }, true);

  F.navigate = (id, state, replace = false) => {
    if (id === 'sources' && F.screen !== 'sources') begin();
    else if (id !== 'sources' && F.screen === 'sources' && S.open) discard();
    return navigate(id, state, replace);
  };
  F.closeModal = () => {if (F.screen === 'sources') discard();return closeModal();};
  F.readUrl = (...args) => {const result = readUrl(...args);if (F.screen !== 'sources') discard();return result;};
  if (window.FRAME_PROTOTYPE) window.FRAME_PROTOTYPE.navigate = F.navigate;
  F.render();
})();
