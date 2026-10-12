// Transição visual entre login e cadastro; os formulários continuam
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
    window.setTimeout(() => document.body.classList.remove('auth-enter'), 800);
  }

  // Aquece a próxima página: prefetch no ocioso e ao passar o mouse/focar no link,
  // para a troca login↔cadastro começar quase instantaneamente.
  let prefetched = false;
  const prefetch = href => {
    if (prefetched || !href) return;
    prefetched = true;
    try {
      const hint = document.createElement('link');
      hint.rel = 'prefetch';
      hint.href = href;
      document.head.appendChild(hint);
    } catch (_) {}
  };
  const otherPage = window.location.pathname === '/register' ? '/' : '/register';
  window.setTimeout(() => prefetch(otherPage), 1800);
  document.addEventListener('pointerover', event => {
    const link = event.target.closest && event.target.closest('a.auth-switch');
    if (link) prefetch(link.href);
  }, { passive: true });
  document.addEventListener('focusin', event => {
    const link = event.target.closest && event.target.closest('a.auth-switch');
    if (link) prefetch(link.href);
  });

  document.addEventListener('click', event => {
    const link = event.target.closest && event.target.closest('a.auth-switch');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = new URL(link.href, window.location.href);
    if (target.origin !== window.location.origin || !['/', '/register'].includes(target.pathname)) return;
    event.preventDefault();
    if (reduceMotion) { window.location.assign(target.href); return; }

    try { sessionStorage.setItem(TRANSITION_KEY, '1'); } catch (_) {}
    document.body.classList.add('auth-exit');
    // 320ms: a cortina (wash) termina de cobrir a tela em ~280ms e a navegação
    // acontece logo em seguida — sem o congelamento que havia com 500ms.
    // A página destino já foi pré-buscada (hover/ocioso) para a troca ser rápida.
    const timer = window.setTimeout(() => {
      // Se por algum motivo a navegação não aconteceu, força o redirect
      // limpando a flag para não criar loop de transição.
      try { sessionStorage.removeItem(TRANSITION_KEY); } catch (_) {}
      window.location.assign(target.href);
    }, 320);
    // Cancelar o timer de fallback se a navegação real começar antes.
    window.addEventListener('pageshow', () => clearTimeout(timer), { once: true });
  });

  // O seletor de tema global também controla as cores de código e do painel.
  window.addEventListener('fileshare:theme-change', event => {
    root.dataset.theme = event.detail && event.detail.theme === 'dark' ? 'dark' : 'light';
  });

  // Salvaguarda: as animações de entrada (fx.css) duram ~1.1s; se depois disso
  // algum campo ainda estiver preso no estado inicial (motor de animação
  // congelado em aparelhos lentos), a classe abaixo zera as animações e
  // devolve todos os elementos ao estado visível normal.
  window.setTimeout(() => root.classList.add('auth-fx-done'), 2200);
})();