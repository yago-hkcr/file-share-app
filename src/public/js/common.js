// Recursos compartilhados por todas as pÃ¡ginas: tema claro/escuro, renomear e substituir arquivos.
(function () {
  const KEY = 'fileshare-theme';
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem(KEY); } catch (e) { return null; } })();
  root.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light');

  function paintButton(btn) {
    const dark = root.getAttribute('data-theme') === 'dark';
    btn.innerHTML = dark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
    btn.title = dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
    btn.setAttribute('aria-label', btn.title);
  }

  function addThemeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      paintButton(btn);
      window.dispatchEvent(new CustomEvent('fileshare:theme-change', { detail: { theme: next } }));
    });
    paintButton(btn);
    const host = document.querySelector('.header-left') || document.querySelector('.sala-left');
    if (host) host.insertBefore(btn, host.firstChild);
    else { btn.classList.add('theme-toggle-fixed'); document.body.appendChild(btn); }
  }

  const esc = t => { const d = document.createElement('div'¶»§q«^