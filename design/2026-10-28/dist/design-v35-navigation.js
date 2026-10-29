/* Creator navigation hierarchy only. Media renderers and settings controls stay unchanged. */
(() => {
  const F = window.F;
  if (!F?.sidebar || !F?.render) return;
  const sidebar = F.sidebar, render = F.render, navigate = F.navigate;
  const groups = [
    {id: 'studio', label: '방송 도구', parent: '방송하기', items: [['scenes', '장면 관리'], ['integrations', '외부 도구 연결']]},
    {id: 'moderation', label: '커뮤니티', parent: '커뮤니티 관리', items: [['reports', '신고 관리'], ['missions-manage', '미션 관리'], ['polls-manage', '투표 및 질문'], ['rewards-manage', '포인트 및 보상']]},
    {id: 'revenue', label: '수익', parent: '수익 관리', items: [['members', '멤버십 관리']]}
  ];
  const S = F.v35Navigation = {open: new Set(), initialized: false, lastPage: null};
  const groupFor = id => groups.find(group => group.id === id || group.items.some(([page]) => page === id));
  const entries = group => [[group.id, group.parent], ...group.items];
  const toggleLabel = (group, open) => `${group.parent} 하위 메뉴 ${open ? '접기' : '펼치기'}`;

  F.sidebar = active => {
    const changed = S.lastPage !== active;
    S.lastPage = active;
    const h = document.createElement('div');
    h.innerHTML = sidebar(active);
    const aside = h.querySelector('.sidebar.v3-sidebar');
    if (!aside || !aside.querySelector('[data-go="studio"]')) return h.innerHTML;
    const current = groupFor(active);
    if (!S.initialized) {
      S.initialized = true;
      if (current) S.open.add(current.id);
    } else if (changed && current) S.open.add(current.id);
    aside.dataset.v35Navigation = 'creator';
    aside.querySelectorAll('.v33-side-subnav').forEach(nav => nav.remove());
    aside.querySelectorAll('button[data-go]').forEach(button => {
      const selected = button.dataset.go === active;
      button.classList.toggle('nav-active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    groups.forEach(group => {
      const parent = aside.querySelector(`[data-go="${group.id}"]`);
      if (!parent) return;
      parent.removeAttribute('aria-expanded');
      parent.removeAttribute('aria-controls');
      parent.classList.add('v35-side-parent');
      parent.classList.toggle('is-current-group', current === group);
      const wrapper = document.createElement('div');
      wrapper.className = 'v35-side-group';
      wrapper.dataset.group = group.id;
      const row = document.createElement('div');
      row.className = 'v35-side-group-row';
      parent.before(wrapper);
      row.append(parent);
      const open = S.open.has(group.id), id = `v35-side-subnav-${group.id}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';toggle.id = `v35-side-toggle-${group.id}`;
      toggle.className = 'v35-side-toggle';toggle.dataset.action = 'v35-navigation-toggle';toggle.dataset.group = group.id;
      toggle.setAttribute('aria-expanded', String(open));toggle.setAttribute('aria-controls', id);
      toggle.setAttribute('aria-label', toggleLabel(group, open));toggle.title = toggleLabel(group, open);
      toggle.innerHTML = F.icon('chevron');row.append(toggle);
      const nav = document.createElement('nav');
      nav.id = id;nav.className = 'v35-side-subnav';nav.hidden = !open;
      nav.setAttribute('aria-label', group.label);
      nav.innerHTML = group.items.map(([page, label]) => F.go(page, `<span class="nav-label">${F.e(label)}</span>`, '', page === active ? 'nav-active' : '')).join('');
      nav.querySelectorAll('[data-go]').forEach(button => {
        if (button.dataset.go === active) button.setAttribute('aria-current', 'page');
      });
      wrapper.append(row, nav);
    });
    return h.innerHTML;
  };

  function mobileNavigation() {
    F.root.querySelectorAll('.v35-mobile-group-nav').forEach(nav => nav.remove());
    const page = F.currentBase, group = groupFor(page), main = F.root.querySelector('#main-content');
    if (!group || !main) return;
    const current = entries(group).find(([id]) => id === page);
    const nav = document.createElement('nav');
    nav.className = 'v35-mobile-group-nav';nav.setAttribute('aria-label', `${group.label} 메뉴`);
    nav.innerHTML = `<span class="v35-mobile-group-label">${F.e(group.label)}</span><button type="button" data-action="v35-navigation-mobile" data-group="${group.id}" aria-label="${F.e(group.label)} 메뉴, 현재 ${F.e(current[1])}" aria-haspopup="listbox" aria-expanded="false"><span>${F.e(current[1])}</span>${F.icon('chevron')}</button>`;
    main.prepend(nav);
  }

  window.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action !== 'v35-navigation-toggle' && action !== 'v35-navigation-mobile') return;
    const group = groups.find(item => item.id === button.dataset.group);
    if (!group) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (action === 'v35-navigation-toggle') {
      const open = !S.open.has(group.id);
      if (open) S.open.add(group.id);else S.open.delete(group.id);
      button.setAttribute('aria-expanded', String(open));button.setAttribute('aria-label', toggleLabel(group, open));button.title = toggleLabel(group, open);
      const nav = F.root.querySelector(`#${button.getAttribute('aria-controls')}`);
      if (nav) nav.hidden = !open;
      return;
    }
    const items = entries(group), selected = items.find(([id]) => id === F.currentBase);
    F.openChoice(button, items.map(([, label]) => label), selected?.[1], value => {
      const item = items.find(([, label]) => label === value);
      if (!item || item[0] === F.currentBase) return;
      F.navigate(item[0]);
      F.root.querySelector('.v35-mobile-group-nav button')?.focus({preventScroll: true});
    });
  }, true);

  F.navigate = (id, state, replace = false) => {
    const group = groupFor(id);
    if (group && id !== F.currentBase) S.open.add(group.id);
    return navigate(id, state, replace);
  };
  F.render = () => {render();mobileNavigation();};
  if (window.FRAME_PROTOTYPE) window.FRAME_PROTOTYPE.navigate = F.navigate;
  F.render();
})();
