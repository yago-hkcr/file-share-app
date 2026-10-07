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
    menu.id = 'fs-select-menu-' + id;
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', label);

    const optionList = document.createElement('div');
    optionList.className = 'fs-select__options';
    optionList.id = 'fs-select-list-' + id;
    optionList.setAttribute('role', 'listbox');
    optionList.setAttribute('aria-label', label);
    optionList.setAttribute('aria-labelledby', trigger.id);
    trigger.setAttribute('aria-controls', optionList.id);

    const searchable = select.id === 'arRoom';
    let searchInput = null;
    let emptyState = null;
    let searchQuery = '';
    if (searchable) {
      searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'fs-select__search';
      searchInput.placeholder = 'Buscar sala...';
      searchInput.setAttribute('aria-label', 'Filtrar salas');
      searchInput.autocomplete = 'off';
      searchInput.spellcheck = false;

      emptyState = document.createElement('div');
      emptyState.className = 'fs-select__empty';
      emptyState.textContent = 'Nenhuma sala encontrada.';
      emptyState.hidden = true;
      menu.append(searchInput, optionList);
    } else {
      menu.appendChild(optionList);
    }
    wrap.appendChild(trigger);

    let expanded = false;
    let activeIndex = -1;
    let items = [];
    let closeTimer = 0;

    function optionLabel(option) {
      return (option.label || option.textContent || '').trim();
    }

    function normalizeSearch(value) {
      return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    }

    function setActive(index) {
      if (!items.length) return;
      let next = index;
      if (next < 0 || next >= items.length || items[next].getAttribute('aria-disabled') === 'true') return;
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
      const contentHeight = items.length ? items.length * 48 + (searchInput ? 68 : 14) : (searchInput ? 112 : 14);
      const naturalHeight = Math.min(300, contentHeight);
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
      optionList.replaceChildren();
      items = [];
      const needle = normalizeSearch(searchQuery);
      options.forEach((option, index) => {
        const title = optionLabel(option);
        if (needle && !normalizeSearch(title).includes(needle)) return;
        const item = document.createElement('div');
        item.className = 'fs-select__option';
        item.id = 'fs-select-option-' + id + '-' + index;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === select.selectedIndex));
        item.setAttribute('aria-disabled', String(option.disabled));
        item.dataset.value = option.value;
        item.dataset.optionIndex = String(index);
        item.textContent = title;
        item.addEventListener('pointerenter', () => { if (!option.disabled) setActive(items.indexOf(item)); });
        item.addEventListener('pointerdown', event => event.preventDefault());
        item.addEventListener('click', () => choose(items.indexOf(item)));
        optionList.appendChild(item);
        items.push(item);
      });

      if (emptyState) {
        emptyState.hidden = items.length !== 0;
        if (items.length === 0) optionList.appendChild(emptyState);
      }

      if (expanded) {
        const preserved = oldActiveValue == null ? -1 : items.findIndex(item => item.dataset.value === oldActiveValue && item.getAttribute('aria-disabled') !== 'true');
        const selectedIndex = select.selectedIndex;
        const visibleSelected = items.findIndex(item => Number(item.dataset.optionIndex) === selectedIndex && item.getAttribute('aria-disabled') !== 'true');
        const fallback = visibleSelected >= 0 ? visibleSelected : items.findIndex(item => item.getAttribute('aria-disabled') !== 'true');
        activeIndex = preserved >= 0 ? preserved : fallback;
        placeMenu();
        if (activeIndex >= 0) setActive(activeIndex);
        else trigger.removeAttribute('aria-activedescendant');
      } else {
        activeIndex = items.findIndex(item => Number(item.dataset.optionIndex) === select.selectedIndex);
        trigger.removeAttribute('aria-activedescendant');
      }
    }

    function openMenu(direction, focusSearch) {
      if (trigger.disabled || expanded) return;
      if (activeSelect && activeSelect !== state) activeSelect.close(false);
      clearTimeout(closeTimer);
      searchQuery = '';
      if (searchInput) searchInput.value = '';
      expanded = true;
      activeSelect = state;
      if (menu.parentNode !== document.body) document.body.appendChild(menu);
      trigger.setAttribute('aria-expanded', 'true');
      wrap.classList.add('fs-select--open');
      render();
      const first = items.findIndex(item => item.getAttribute('aria-disabled') !== 'true');
      const selected = items.findIndex(item => Number(item.dataset.optionIndex) === select.selectedIndex && item.getAttribute('aria-disabled') !== 'true');
      if (direction === 1) setActive(selected >= 0 ? selected : first);
      if (direction === -1) {
        for (let index = items.length - 1; index >= 0; index--) {
          if (items[index].getAttribute('aria-disabled') !== 'true') { setActive(index); break; }
        }
      }
      placeMenu();
      requestAnimationFrame(() => {
        if (!expanded) return;
        menu.classList.add('is-open');
        if (searchInput && (focusSearch || window.matchMedia('(hover: hover) and (pointer: fine)').matches)) searchInput.focus({ preventScroll: true });
        else trigger.focus({ preventScroll: true });
      });
    }

    function closeMenu(returnFocus) {
      if (!expanded) {
        if (returnFocus) trigger.focus({ preventScroll: true });
        return;
      }
      expanded = false;
      searchQuery = '';
      if (searchInput) searchInput.value = '';
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      wrap.classList.remove('fs-select--open');
      menu.classList.remove('is-open');
      menu.classList.remove('is-above');
      if (activeSelect === state) activeSelect = null;
      render();
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!expanded && menu.parentNode) menu.remove();
      }, 230);
      if (returnFocus) trigger.focus({ preventScroll: true });
    }

    function choose(index) {
      const item = items[index];
      const optionIndex = item ? Number(item.dataset.optionIndex) : -1;
      const option = select.options[optionIndex];
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
        event.preventDefault();
        if (searchInput) {
          if (!expanded) openMenu(undefined, true);
          searchInput.focus({ preventScroll: true });
          searchInput.value += event.key;
          searchQuery = searchInput.value;
          render();
        } else {
          typeBuffer += event.key.toLocaleLowerCase();
          clearTimeout(typeTimer);
          typeTimer = setTimeout(() => { typeBuffer = ''; }, 650);
          const match = Array.from(select.options).findIndex(option => !option.disabled && optionLabel(option).toLocaleLowerCase().startsWith(typeBuffer));
          if (match >= 0) {
            if (!expanded) openMenu();
            const active = items.findIndex(item => Number(item.dataset.optionIndex) === match);
            if (active >= 0) setActive(active);
          }
        }
      }
    });

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        render();
      });
      searchInput.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveActive(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveActive(-1);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          choose(activeIndex);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeMenu(true);
        } else if (event.key === 'Tab') {
          closeMenu(false);
        }
      });
    }

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