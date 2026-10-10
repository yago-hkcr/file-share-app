/* ===== FileShare: shell acessível do dashboard ===== */
(function () {
  'use strict';

  const shell = document.getElementById('dashboardShell');
  const sidebar = document.getElementById('dashboardSidebar');
  const menuToggle = document.getElementById('dashboardMenuToggle');
  const compactToggle = document.getElementById('dashboardCompactToggle');
  const workspaceTitle = document.getElementById('workspaceTitle');
  if (!shell || !sidebar) return;

  const tabs = Array.from(sidebar.querySelectorAll('[role="tab"]'));
  const panels = {
    rooms: document.getElementById('roomsPanel'),
    collections: document.getElementById('collectionsPanel'),
    library: document.getElementById('libraryPanel')
  };
  const titles = { rooms: 'Salas', collections: 'Coletas', library: 'Meu Acervo' };
  const tabKey = tab => tab && tab.id === 'collectionsTab' ? 'collections' : tab && tab.id === 'libraryTab' ? 'library' : 'rooms';
  function setMenu(open) {
    shell.classList.toggle('menu-open', open);
    if (menuToggle) {
      menuToggle.setAttribute('aria-expanded', String(open));
      menuToggle.setAttribute('aria-label', open ? 'Fechar menu de navegação' : 'Abrir menu de navegação');
    }
  }

  function isMobile() {
    return window.matchMedia ? window.matchMedia('(max-width: 760px)').matches : window.innerWidth <= 760;
  }

  function setCompact(compact) {
    shell.classList.toggle('is-compact', compact);
    if (compactToggle) {
      compactToggle.setAttribute('aria-pressed', String(compact));
      compactToggle.setAttribute('aria-label', compact ? 'Expandir menu lateral' : 'Recolher menu lateral');
      const label = compactToggle.querySelector('span');
      if (label) label.textContent = compact ? 'Expandir menu' : 'Recolher menu';
    }
    try { localStorage.setItem('fileshare-dashboard-compact', compact ? '1' : '0'); } catch (error) {}
  }

  function announcePanel(key) {
    if (workspaceTitle) workspaceTitle.textContent = titles[key] || titles.rooms;
    const badge = document.getElementById('sectionBadge');
    if (badge) badge.textContent = titles[key] || titles.rooms;
  }

  function selectTab(tab, options) {
    if (!tab) return;
    const key = tabKey(tab);
    tabs.forEach(candidate => {
      const selected = candidate === tab;
      candidate.classList.toggle('is-active', selected);
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    });
    Object.entries(panels).forEach(([panelKey, panel]) => {
      if (!panel) return;
      panel.hidden = panelKey !== key;
    });
    announcePanel(key);
    try { localStorage.setItem('fileshare-dashboard-tab', key); } catch (error) {}
    if (isMobile() && !(options && options.keepMenuOpen)) setMenu(false);
  }

  function chooseInitialTab() {
    let saved = '';
    try { saved = localStorage.getItem('fileshare-dashboard-tab') || ''; } catch (error) {}
    const tab = tabs.find(candidate => tabKey(candidate) === saved) || tabs.find(candidate => candidate.getAttribute('aria-selected') === 'true') || tabs[0];
    // O clique também aciona o carregamento legado de Coletas/Acervo em collections.js.
    tab.click();
  }

  tabs.forEach((tab, index) => {
    tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Enter' || event.key === ' ') { selectTab(tab); return; }
      const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + direction + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      selectTab(tabs[nextIndex]);
    });
  });

  if (menuToggle) menuToggle.addEventListener('click', () => setMenu(!shell.classList.contains('menu-open')));
  if (compactToggle) compactToggle.addEventListener('click', () => setCompact(!shell.classList.contains('is-compact')));

  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'dashboard-menu-backdrop';
  backdrop.setAttribute('aria-label', 'Fechar menu');
  backdrop.tabIndex = -1;
  shell.insertBefore(backdrop, shell.firstChild);
  backdrop.addEventListener('click', () => setMenu(false));

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && shell.classList.contains('menu-open')) setMenu(false);
  });

  function makeCollapsible(heading, content, label) {
    if (!heading || !content || heading.dataset.dashboardCollapsible === 'true') return;
    heading.dataset.dashboardCollapsible = 'true';
    heading.classList.add('dashboard-collapsible-heading');
    heading.setAttribute('role', 'button');
    heading.setAttribute('tabindex', '0');
    heading.setAttribute('aria-expanded', 'true');
    if (label) heading.setAttribute('aria-label', label);
    const icon = document.createElement('i');
    icon.className = 'fas fa-chevron-down dashboard-collapse-icon';
    icon.setAttribute('aria-hidden', 'true');
    heading.appendChild(icon);
    content.classList.add('dashboard-collapsible-content');
    const toggle = () => {
      const expanded = heading.getAttribute('aria-expanded') !== 'false';
      heading.setAttribute('aria-expanded', String(!expanded));
      content.hidden = expanded;
    };
    heading.addEventListener('click', toggle);
    heading.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });
  }

  makeCollapsible(document.getElementById('librarySpacesHeading'), document.getElementById('librarySpaces'), 'Mostrar ou ocultar espaços pessoais');
  makeCollapsible(document.getElementById('libraryBookcasesHeading'), document.getElementById('libraryBookcases'), 'Mostrar ou ocultar prateleiras');

  let compact = false;
  try { compact = localStorage.getItem('fileshare-dashboard-compact') === '1'; } catch (error) {}
  setCompact(compact && !isMobile());
  setMenu(false);
  chooseInitialTab();
  window.addEventListener('resize', () => {
    if (!isMobile() && shell.classList.contains('menu-open')) setMenu(false);
    if (isMobile() && shell.classList.contains('is-compact')) setCompact(false);
  });
})();