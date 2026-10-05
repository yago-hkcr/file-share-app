/* FileShare — menus customizados para os seletores do painel ADM */
(() => {
  if (window.__fileShareSelectsReady) return;
  window.__fileShareSelectsReady = true;

  const labels = {
    prOwner: 'Filtrar salas pelo dono',
    aeOwner: 'Escolher novo dono da sala',
    amSel: 'Escolher pessoa para adicionar à sala',
    acRoom: 'Escolher sala para o monitor de chat',
    alA: 'Filtrar atividade por ação',
    bcY: 'Tipo do comunicado',
    anY: 'Tipo do aviso',
    syReg: 'Modo de cadastro',
    auS: 'Ordenar usuários',
    arRoom: 'Escolher sala para os atalhos'
  };
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const indexDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let sequence = 0;
  let activeSelect = null;
  let typeBuffer = '';
  let typeTimer = 0;

  function enhance(select) {
    if (!(select instanceof HTMLSelectElement) || select.dataset.fsSelectReady === 'true') return;
    const parent = select.parentNode;
    if (!parent) return;

    select.dataset.fsSelectReady = 'true';
    const wrap = document.createElement('div');
    wrap.className = 'fs-select';
    if (select.style.flex) wrap.style.flex = select.style.flex;
    if (select.style.minWidth) wrap.style.minWidth = select.style.minWidth;
    if (select.style.width) wrap.style.width = select.style.width;
    parent.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('fs-select__native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    const id = ++sequence;
    const label = select.getAttribute('aria-label')
      || Array.from(select.labels || []).map(item => item.textContent.trim()).filter(Boolean).join(' ')
      || labels[select.id]
      || 'Selecionar opção';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'fs-select__trigger';
    trigger.id = 'fs-select-trigger-' + id;
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-autocomplete', 'none');

    const value = document.createElement('span');
    value.className = 'fs-select__value';
    const hint = document.createElement('span');
    hint.className = 'fs-select__hint';
    hint.textContent = 'Selecionar';
    const chevron = document.createElement('span');
    chevron.className = 'fs-select__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(value, hint, chevron);

    const menu = document.createElement('div');
    menu.className = 'fs-select__menu';
    menu.id = 'fs-select-list-' + id;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label);
    menu.setAttribute('aria-labelledby', trigger.id);
    trigger.setAttribute('aria-controls', menu.id);
    wrap.appendChild(trigger);

    let expanded = false;
    let activeIndex = -1;
    let items = [];
    let closeTimer = 0;

    function optionLabel(option) {
      return (option.label || option.textContent || '').trim();
    }

    function setActive(index) {
      if (!items.length) return;
      let next = index;
      if (next < 0 || next >= items.length || select.options[next]?.disabled) return;
      activeIndex = next;
      items.forEach((item, itemIndex) => item.classList.toggle('is-active', itemIndex === activeIndex));
      trigger.setAttribute('aria-activedescendant', items[activeIndex].id);
      const item = items[activeIndex];
      const itemTop = item.offsetTop;
      const itemBottom = itemTop + item.offsetHeight;
      if (itemTop < menu.scrollTop) menu.scrollTop = itemTop;
      else if (itemBottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = itemBottom - menu.clientHeight;
    }

    function moveActive(direction) {
      if (!items.length) return;
      let index = activeIndex < 0 ? (direction > 0 ? -1 : 0) : activeIndex;
      for (let step = 0; step < items.length; step++) {
        index = (index + direction + items.length) % items.length;
        if (items[index].getAttribute('aria-disabled') !== 'true') {
          setActive(index);
          return;
        }
      }
    }

    function placeMenu() {
      if (!expanded || !wrap.isConnected) return;
      const rect = wrap.getBoundingClientRect();
      const viewWidth = window.innerWidth;
      const viewHeight = window.innerHeight;
      const width = Math.min(Math.max(rect.width, 188), viewWidth - 24);
      const left = Math.max(12, Math.min(rect.left, viewWidth - width - 12));
      const roomBelow = Math.max(0, viewHeight - rect.bottom - 16);
      const roomAbove = Math.max(0, rect.top - 16);
      const naturalHeight = Math.min(300, items.length * 48 + 14);
      const openAbove = roomBelow < naturalHeight && roomAbove > roomBelow;
      const available = Math.max(88, Math.min(300, (openAbove ? roomAbove : roomBelow) - 8));
      const menuHeight = Math.min(naturalHeight, available);
      const top = openAbove ? rect.top - menuHeight - 8 : rect.bottom + 8;
      menu.style.left = left + 'px';
      menu.style.top = Math.max(8, Math.min(top, viewHeight - menuHeight - 8)) + 'px';
      menu.style.width = width + 'px';
      menu.style.maxHeight = available + 'px';
      menu.classList.toggle('is-above', openAbove);
    }

    function render() {
      const options = Array.from(select.options);
      const selected = select.selectedIndex >= 0 ? options[select.selectedIndex] : null;
      value.textContent = selected ? optionLabel(selected) : (select.dataset.placeholder || 'Selecione uma opção');
      trigger.disabled = select.disabled || options.length === 0;
      trigger.setAttribute('aria-disabled', String(trigger.disabled));

      const oldActiveValue = activeIndex >= 0 ? items[activeIndex]?.dataset.value : null;
      menu.replaceChildren();
      items = options.map((option, index) => {
        const item = document.createElement('div');
        item.className = 'fs-select__option';
        item.id = 'fs-select-option-' + id + '-' + index;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === select.selectedIndex));
        item.setAttribute('aria-disabled', String(option.disabled));
        item.dataset.value = option.value;
        item.textContent = optionLabel(option);
        item.addEventListener('pointerenter', () => { if (!option.disabled) setActive(index); });
        item.addEventListener('pointerdown', event => event.preventDefault());
        item.addEventListener('click', () => choose(index));
        menu.appendChild(item);
        return item;
      });

      if (expanded) {
        if (!items.length) { closeMenu(false); return; }
        const preserved = oldActiveValue == null ? -1 : options.findIndex(option => option.value === oldActiveValue && !option.disabled);
        const selectedIndex = select.selectedIndex;
        const fallback = selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : options.findIndex(option => !option.disabled);
        activeIndex = preserved >= 0 ? preserved : fallback;
        placeMenu();
        if (activeIndex >= 0) setActive(activeIndex);
      } else {
        activeIndex = select.selectedIndex;
        trigger.removeAttribute('aria-activedescendant');
      }
    }

    function openMenu(direction) {
      if (trigger.disabled || expanded) return;
      if (activeSelect && activeSelect !== state) activeSelect.close(false);
      clearTimeout(closeTimer);
      expanded = true;
      activeSelect = state;
      if (menu.parentNode !== document.body) document.body.appendChild(menu);
      trigger.setAttribute('aria-expanded', 'true');
      wrap.classList.add('fs-select--open');
      render();
      const selectedIndex = select.selectedIndex;
      if (direction === 1) {
        const first = items.findIndex(item => item.getAttribute('aria-disabled') !== 'true');
        setActive(selectedIndex >= 0 && !select.options[selectedIndex]?.disabled ? selectedIndex : first);
      }
      if (direction === -1) {
        for (let index = items.length - 1; index >= 0; index--) {
          if (items[index].getAttribute('aria-disabled') !== 'true') { setActive(index); break; }
        }
      }
      placeMenu();
      requestAnimationFrame(() => { if (expanded) menu.classList.add('is-open'); });
      trigger.focus({ preventScroll: true });
    }

    function closeMenu(returnFocus) {
      if (!expanded) {
        if (returnFocus) trigger.focus({ preventScroll: true });
        return;
      }
      expanded = false;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      wrap.classList.remove('fs-select--open');
      menu.classList.remove('is-open');
      menu.classList.remove('is-above');
      if (activeSelect === state) activeSelect = null;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!expanded && menu.parentNode) menu.remove();
      }, 230);
      if (returnFocus) trigger.focus({ preventScroll: true });
    }

    function choose(index) {
      const option = select.options[index];
      if (!option || option.disabled) return;
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      render();
      closeMenu(true);
    }

    const state = {
      close: closeMenu,
      wrap,
      select,
      menu,
      place: placeMenu
    };

    trigger.addEventListener('click', () => expanded ? closeMenu(false) : openMenu());
    trigger.addEventListener('focus', () => wrap.classList.add('fs-select--focused'));
    trigger.addEventListener('blur', () => wrap.classList.remove('fs-select--focused'));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!expanded) openMenu(1);
        else moveActive(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!expanded) openMenu(-1);
        else moveActive(-1);
      } else if (event.key === 'Home' && expanded) {
        event.preventDefault();
        setActive(items.findIndex(item => item.getAttribute('aria-disabled') !== 'true'));
      } else if (event.key === 'End' && expanded) {
        event.preventDefault();
        for (let index = items.length - 1; index >= 0; index--) {
          if (items[index].getAttribute('aria-disabled') !== 'true') { setActive(index); break; }
        }
      } else if ((event.key === 'Enter' || event.key === ' ') && expanded) {
        event.preventDefault();
        choose(activeIndex);
      } else if ((event.key === 'Enter' || event.key === ' ') && !expanded) {
        event.preventDefault();
        openMenu();
      } else if (event.key === 'Escape' && expanded) {
        event.preventDefault();
        closeMenu(true);
      } else if (event.key === 'Tab' && expanded) {
        closeMenu(false);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typeBuffer += event.key.toLocaleLowerCase();
        clearTimeout(typeTimer);
        typeTimer = setTimeout(() => { typeBuffer = ''; }, 650);
        const match = Array.from(select.options).findIndex(option => !option.disabled && optionLabel(option).toLocaleLowerCase().startsWith(typeBuffer));
        if (match >= 0) {
          if (!expanded) openMenu();
          setActive(match);
        }
      }
    });

    select.addEventListener('change', render);
    select.addEventListener('input', render);
    const mutations = new MutationObserver(render);
    mutations.observe(select, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['selected', 'disabled', 'value', 'label'] });

    [[valueDescriptor, 'value'], [indexDescriptor, 'selectedIndex']].forEach(([descriptor, property]) => {
      if (!descriptor || !descriptor.get || !descriptor.set) return;
      try {
        Object.defineProperty(select, property, {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() { return descriptor.get.call(this); },
          set(next) { descriptor.set.call(this, next); render(); }
        });
      } catch (_) { /* o seletor segue funcional mesmo sem o espelhamento */ }
    });

    render();
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches('select')) enhance(node);
    node.querySelectorAll('select').forEach(enhance);
  }

  const observer = new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(scan));
    if (activeSelect && !activeSelect.wrap.isConnected) activeSelect.close(false);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('pointerdown', event => {
    if (!activeSelect) return;
    if (activeSelect.wrap.contains(event.target) || activeSelect.menu.contains(event.target)) return;
    activeSelect.close(false);
  }, true);

  window.addEventListener('resize', () => { if (activeSelect) activeSelect.place(); }, { passive: true });
  document.addEventListener('scroll', () => { if (activeSelect) activeSelect.place(); }, true);

  if (document.documentElement) scan(document.documentElement);
})();