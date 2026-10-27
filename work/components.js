const FrameControls = (() => {
  function mount(definitions) {
    const popup = document.getElementById('select-popup');
    const controls = Object.entries(definitions).map(([id, options]) => ({ id, options, input: document.getElementById(id), trigger: document.getElementById(id + '-trigger'), label: document.getElementById(id + '-value') }));
    let current = null, active = 0, buffer = '', typedAt = 0;
    function close(restoreFocus = false) {
      if (!current) return;
      const previous = current;
      previous.trigger.setAttribute('aria-expanded', 'false');
      previous.trigger.removeAttribute('aria-activedescendant');
      popup.hidden = true; current = null; buffer = '';
      if (restoreFocus && !previous.trigger.disabled) previous.trigger.focus({ preventScroll: true });
    }
    function sync() {
      for (const control of controls) {
        control.label.textContent = control.options.find(option => option.value === control.input.value)?.label || control.input.value;
        control.trigger.disabled = control.input.disabled;
        if (current === control && control.input.disabled) close();
      }
    }
    function position() {
      if (!current) return;
      const rect = current.trigger.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upward = below < Math.min(260, popup.scrollHeight) && above > below;
      const room = Math.max(100, upward ? above : below);
      popup.style.width = rect.width + 'px';
      popup.style.maxHeight = Math.min(310, room) + 'px';
      popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8)) + 'px';
      popup.style.top = (upward ? Math.max(8, rect.top - Math.min(popup.scrollHeight, 310, room) - 6) : rect.bottom + 6) + 'px';
      popup.dataset.direction = upward ? 'up' : 'down';
    }
    function highlight(scroll = false) {
      if (!current) return;
      const items = [...popup.children];
      items.forEach((item, index) => item.classList.toggle('is-active', index === active));
      current.trigger.setAttribute('aria-activedescendant', items[active].id);
      if (scroll) items[active].scrollIntoView({ block: 'nearest' });
    }
    function commit() {
      if (!current) return;
      const control = current, value = control.options[active].value;
      close(true);
      if (control.input.value !== value) {
        control.input.value = value;
        control.input.dispatchEvent(new Event('input', { bubbles: true }));
        control.input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      sync();
    }
    function open(control) {
      const host = control.trigger.closest('dialog[open]') || document.body;
      if (popup.parentElement !== host) host.append(popup);
      if (control.trigger.disabled) return;
      if (current) close();
      current = control;
      active = Math.max(0, control.options.findIndex(option => option.value === control.input.value));
      popup.replaceChildren();
      popup.setAttribute('aria-labelledby', control.id + '-label');
      control.options.forEach((option, index) => {
        const item = document.createElement('div');
        item.id = 'choice-' + control.id + '-' + index;
        item.className = 'select-option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.value === control.input.value));
        const content = document.createElement('span'); content.className = 'select-option-copy';
        const label = document.createElement('span'); label.className = 'select-option-label'; label.textContent = option.label; content.append(label);
        if (option.detail) { const detail = document.createElement('span'); detail.className = 'select-option-detail'; detail.textContent = option.detail; content.append(detail); }
        const check = document.createElement('span'); check.className = 'select-option-check'; check.innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>';
        item.append(content, check);
        item.addEventListener('pointerdown', event => event.preventDefault());
        item.addEventListener('pointermove', () => { active = index; highlight(); });
        item.addEventListener('click', () => { active = index; commit(); });
        popup.append(item);
      });
      popup.hidden = false;
      control.trigger.setAttribute('aria-expanded', 'true');
      position(); highlight(true);
    }
    for (const control of controls) {
      control.trigger.addEventListener('click', () => current === control ? close() : open(control));
      control.trigger.addEventListener('keydown', event => {
        const key = event.key;
        if (key === 'Escape' && current === control) { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (key === 'Tab') { if (current === control) commit(); return; }
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(key)) {
          event.preventDefault();
          const wasOpen = current === control;
          if (!wasOpen) open(control);
          else if (key === 'Enter' || key === ' ') { commit(); return; }
          else if (key === 'ArrowDown') active = Math.min(control.options.length - 1, active + 1);
          else if (key === 'ArrowUp') active = Math.max(0, active - 1);
          else if (key === 'PageDown') active = Math.min(control.options.length - 1, active + 5);
          else if (key === 'PageUp') active = Math.max(0, active - 5);
          if (key === 'Home') active = 0;
          if (key === 'End') active = control.options.length - 1;
          highlight(true); return;
        }
        if (key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault();
          if (current !== control) open(control);
          const now = Date.now(); buffer = now - typedAt < 700 ? buffer + key.toLowerCase() : key.toLowerCase(); typedAt = now;
          let match = control.options.findIndex(option => option.label.toLowerCase().startsWith(buffer));
          if (match < 0) { buffer = key.toLowerCase(); match = control.options.findIndex(option => option.label.toLowerCase().startsWith(buffer)); }
          if (match >= 0) { active = match; highlight(true); }
        }
      });
    }
    document.addEventListener('pointerdown', event => { if (current && !popup.contains(event.target) && !current.trigger.contains(event.target)) close(); });
    window.addEventListener('resize', () => close());
    window.addEventListener('scroll', event => { if (current && !(event.target instanceof Node && popup.contains(event.target))) close(); }, true);
    sync();
    return { sync, close };
  }
  return { mount };
})();
