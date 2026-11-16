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

  // 3D flutuante + inclinação que acompanha o cursor nos cards de autenticação.
  (function initAuthTilt() {
    if (reduceMotion) return;
    const cards = Array.from(document.querySelectorAll('.auth-card, .auth-showcase'));
    if (!cards.length) return;

    const finePointer = !window.matchMedia || window.matchMedia('(pointer: fine)').matches;
    const base = { x: 4, y: -6, scale: 1 };

    const states = cards.map((el, i) => ({
      el,
      hovering: false,
      cx: base.x, cy: base.y, cs: base.scale, cf: 0,
      tx: base.x, ty: base.y, ts: base.scale,
      rect: null,
      phase: i * 1.3
    }));

    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const lerp = (a, b, t) => a + (b - a) * t;

    function refreshRects() {
      states.forEach(s => { s.rect = s.el.getBoundingClientRect(); });
    }

    states.forEach(s => {
      const onEnter = () => {
        s.hovering = true;
        s.rect = s.el.getBoundingClientRect();
        s.el.classList.add('is-tilting');
        s.ts = 1.015;
      };
      const onLeave = () => {
        s.hovering = false;
        s.el.classList.remove('is-tilting');
        s.tx = base.x; s.ty = base.y; s.ts = base.scale;
      };
      const onMove = (e) => {
        if (!finePointer) return;
        if (!s.rect) s.rect = s.el.getBoundingClientRect();
        const r = s.rect;
        const px = clamp((e.clientX - r.left) / r.width, 0, 1);
        const py = clamp((e.clientY - r.top) / r.height, 0, 1);
        const dx = (px - 0.5) * 2;
        const dy = (py - 0.5) * 2;
        const max = s.el.classList.contains('auth-showcase') ? 7 : 11;
        s.ty = base.y + dx * max;
        s.tx = base.x - dy * max;
      };
      s.el.addEventListener('pointerenter', onEnter);
      s.el.addEventListener('pointerleave', onLeave);
      s.el.addEventListener('pointermove', onMove);
    });

    window.addEventListener('resize', refreshRects, { passive: true });
    window.addEventListener('scroll', refreshRects, { passive: true });

    const start = performance.now();
    function frame(now) {
      const t = (now - start) / 1000;
      for (const s of states) {
        const floatAmp = s.hovering ? 3 : 6;
        const targetFloat = Math.sin(t * 1.5 + s.phase) * floatAmp;
        const k = s.hovering ? 0.12 : 0.08;
        s.cx = lerp(s.cx, s.tx, k);
        s.cy = lerp(s.cy, s.ty, k);
        s.cs = lerp(s.cs, s.ts, k);
        s.cf = lerp(s.cf, targetFloat, 0.08);
        s.el.style.setProperty('--tilt-x', s.cx.toFixed(3) + 'deg');
        s.el.style.setProperty('--tilt-y', s.cy.toFixed(3) + 'deg');
        s.el.style.setProperty('--card-scale', s.cs.toFixed(4));
        s.el.style.setProperty('--float-y', s.cf.toFixed(2) + 'px');
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })();

  // Salvaguarda: as animações de entrada (fx.css) duram ~1.1s; se depois disso
  // algum campo ainda estiver preso no estado inicial (motor de animação
  // congelado em aparelhos lentos), a classe abaixo zera as animações e
  // devolve todos os elementos ao estado visível normal.
  window.setTimeout(() => root.classList.add('auth-fx-done'), 2200);
})();