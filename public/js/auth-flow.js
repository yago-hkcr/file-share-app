// Transição visual curta entre login e cadastro; os formulários continuam
// navegando pelas rotas existentes e a preferência de tema permanece intacta.
(function () {
  'use strict';

  const TRANSITION_KEY = 'fileshare-auth-transition';
  const root = document.documentElement;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let entering = false;
  try { entering = sessionStorage.getItem(TRANSITION_KEY) === '1'; } catch (_) {}
  try { sessionStorage.removeItem(TRANSITION_KEY); } catch (_) {}

  if (entering && !reduceMotion) {
    document.body.classList.add('auth-enter');
    window.setTimeout(() => document.body.classList.remove('auth-enter'), 760);
  }

  document.addEventListener('click', event => {
    const link = event.target.closest && event.target.closest('a.auth-switch');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = new URL(link.href, window.location.href);
    if (target.origin !== window.location.origin || !['/', '/register'].includes(target.pathname)) return;
    event.preventDefault();
    if (reduceMotion) { window.location.assign(target.href); return; }

    try { sessionStorage.setItem(TRANSITION_KEY, '1'); } catch (_) {}
    document.body.classList.add('auth-exit');
    window.setTimeout(() => window.location.assign(target.href), 300);
  });

  // O seletor de tema global também controla as cores de código e do painel.
  window.addEventListener('fileshare:theme-change', event => {
    root.dataset.theme = event.detail && event.detail.theme === 'dark' ? 'dark' : 'light';
  });

  // Salvaguarda: as animações de entrada (fx.css) duram ~1.1s; se depois disso
  // algum campo ainda estiver preso no estado inicial (motor de animação
  // congelado em aparelhos lentos), a classe abaixo zera as animações e
  // devolve todos os elementos ao estado visível normal.
  window.setTimeout(() => root.classList.add('auth-fx-done'), 1800);
})();