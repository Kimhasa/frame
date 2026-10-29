(() => {
  const F = window.F;
  if (!F || !F.modals?.donate) return;

  const state = F.v3DonationDraft = { amount: '5000', message: '', consent: false, manual: false };
  const digits = value => String(value ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, 15);
  const money = value => digits(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const valid = () => Number(state.amount) >= 1000;
  const originalDonate = F.modals.donate;
  F.modals.donate = viewState => {
    const config = originalDonate(viewState);
    config.cls = `${config.cls || ''} v3-donation-dialog`.trim();
    if (viewState === '완료') {
      config.body = config.body.replace('5,000원을', `${money(state.amount)}원을`);
      return config;
    }
    if (viewState === '처리 중') return config;
    config.body = config.body.replace(/<input\b(?=[^>]*\bname="donation-amount")[^>]*>/, `<div class="v3-donation-amount"><input id="v3-donation-amount" name="donation-amount" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="19" placeholder="1,000" aria-label="후원 금액" aria-describedby="v3-donation-error" value="${money(state.amount)}"><span aria-hidden="true">원</span></div><small id="v3-donation-error" class="v3-donation-error" hidden>1,000원 이상 입력해 주세요.</small>`);
    config.body = config.body.replaceAll('data-action="amount"', 'data-action="v3-components-amount"');
    config.body = config.body.replace(/(<textarea\b[^>]*name="donation-message"[^>]*>)[\s\S]*?(<\/textarea>)/, (_, open, close) => `${open}${F.e(state.message)}${close}`);
    if (state.consent) config.body = config.body.replace('id="payment-consent" type="checkbox"', 'id="payment-consent" type="checkbox" checked');
    const payment = F.values?.payment;
    if (payment) config.body = config.body.replace(/(data-key="payment"[^>]*><span>)[\s\S]*?(<\/span>)/, (_, open, close) => `${open}${F.e(payment)}${close}`);
    config.body = config.body.replace(/(<button\b[^>]*data-action="v3-components-amount"[^>]*>)/g, tag => {
      const amount = tag.match(/data-amount="([^"]+)"/)?.[1];
      const selected = amount === '직접 입력' ? state.manual : !state.manual && digits(amount) === state.amount;
      return tag.replace(/class="([^"]*)"/, (_, classes) => `class="${classes.split(/\s+/).filter(c => c && c !== 'selected').concat(selected ? ['selected'] : []).join(' ')}"`).replace(/>$/, ` aria-pressed="${selected}">`);
    });
    config.footer = config.footer.replace('5,000원 후원하기', `${money(state.amount) || '0'}원 후원하기`);
    return config;
  };

  // Keep the shared dropdown API and keyboard behavior; only eligible form menus get this surface.
  if (typeof F.openChoice === 'function') {
    const originalChoice = F.openChoice;
    F.openChoice = (anchor, ...args) => {
      originalChoice(anchor, ...args);
      const protectedControl = anchor.closest('.preserved-player,.player,.studio-preview,[class*="locked-"],.product-dialog:has([name="bitrate"])');
      if (!protectedControl) F.activeSelect?.menu.classList.add('v3-component-choice');
    };
  }

  const activeDialog = () => F.dialog?.classList.contains('v3-donation-dialog') ? F.dialog : null;
  const showError = show => {
    const dialog = activeDialog();
    const input = dialog?.querySelector('[name="donation-amount"]');
    const error = dialog?.querySelector('#v3-donation-error');
    if (input) input.setAttribute('aria-invalid', String(show));
    if (error) error.hidden = !show;
  };
  const updateAmount = (input, maintainCaret = false) => {
    const before = input.value;
    const caretDigits = digits(before.slice(0, input.selectionStart ?? before.length)).length;
    state.amount = digits(before);
    input.value = money(state.amount);
    if (maintainCaret && document.activeElement === input) {
      let position = 0, seen = 0;
      while (position < input.value.length && seen < caretDigits) if (/\d/.test(input.value[position++])) seen++;
      input.setSelectionRange(position, position);
    }
    const dialog = activeDialog();
    const button = dialog?.querySelector('[data-action="donate"]');
    if (button) button.textContent = `${money(state.amount) || '0'}원 후원하기`;
    dialog?.querySelectorAll('[data-action="v3-components-amount"]').forEach(b => {
      const selected = b.dataset.amount === '직접 입력' ? state.manual : !state.manual && digits(b.dataset.amount) === state.amount;
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
    showError(false);
  };

  document.addEventListener('click', event => {
    const b = event.target.closest('button');
    const dialog = activeDialog();
    if (!b || !dialog?.contains(b)) return;
    if (b.dataset.action === 'v3-components-amount') {
      event.preventDefault(); event.stopImmediatePropagation();
      const input = dialog.querySelector('[name="donation-amount"]');
      state.manual = b.dataset.amount === '직접 입력';
      if (!state.manual) input.value = b.dataset.amount;
      updateAmount(input);
      if (state.manual) { input.focus({ preventScroll: true }); input.select(); }
    } else if (b.dataset.action === 'donate' && !valid()) {
      event.preventDefault(); event.stopImmediatePropagation();
      showError(true);
      dialog.querySelector('[name="donation-amount"]')?.focus({ preventScroll: true });
    }
  }, true);
  document.addEventListener('input', event => {
    const input = event.target;
    if (!activeDialog()?.contains(input)) return;
    if (input.name === 'donation-amount') {
      event.stopImmediatePropagation();
      state.manual = true;
      if (!event.isComposing) updateAmount(input, true);
    } else if (input.name === 'donation-message') state.message = input.value;
  }, true);
  document.addEventListener('compositionend', event => {
    if (event.target.name === 'donation-amount' && activeDialog()?.contains(event.target)) updateAmount(event.target, true);
  }, true);
  document.addEventListener('change', event => {
    if (event.target.id === 'payment-consent' && activeDialog()?.contains(event.target)) state.consent = event.target.checked;
  }, true);
  document.addEventListener('focusout', event => {
    if (event.target.name === 'donation-amount' && activeDialog()?.contains(event.target)) showError(!valid());
  }, true);

  // design.js can have rendered a direct donation URL before this extension loads.
  if (F.screen === 'donate' && F.dialog?.open) F.renderModal();
})();
