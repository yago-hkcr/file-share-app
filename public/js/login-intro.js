/* Arquive Online — abertura de primeira visita.
   Só aparece uma vez por dispositivo: splash do logo e, em seguida, a
   apresentação animada com som (intro-cinema.js). Quem já usa o site abre
   direto no login. Para rever: ?intro=1 ou ArquiveIntroCinema.reset(). */
(function () {
  'use strict';

  var INTRO_DURATION = 5200;
  var cinema = function () { return window.ArquiveIntroCinema || null; };

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function forced() {
    try { return /(?:^|[?&])intro=1(?:&|$)/.test(window.location.search); } catch (e) { return false; }
  }

  function focusLogin() {
    var username = document.getElementById('username');
    if (username && typeof username.focus === 'function') {
      try { username.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function alreadySeen() {
    var api = cinema();
    if (api) return api.hasSeen();
    try { return localStorage.getItem('arquive_intro_v1') === '1'; } catch (e) { return false; }
  }

  function markSeen() {
    var api = cinema();
    if (api) { api.markSeen(); return; }
    try { localStorage.setItem('arquive_intro_v1', '1'); } catch (e) {}
  }

  function mount() {
    if (prefersReducedMotion()) { markSeen(); focusLogin(); return; }
    if (!forced() && alreadySeen()) { focusLogin(); return; }

    var reduced = false;

    // Remove any stale intro overlay from previous broken runs
    try {
      var stale = document.getElementById('splashIntro');
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    } catch (e) {}

    var overlay = document.createElement('div');
    overlay.id = 'splashIntro';
    overlay.className = 'splash-intro';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Introdução Arquive Online');
    overlay.tabIndex = -1;

    overlay.innerHTML =
      '<div class="splash-bg" aria-hidden="true">' +
        '<div class="splash-bg-grad"></div>' +
        '<div class="splash-bg-grid"></div>' +
        '<div class="splash-bg-glow"></div>' +
        '<div class="splash-bg-vignette"></div>' +
      '</div>' +
      '<div class="splash-center">' +
        '<div class="splash-logo-wrap">' +
          '<canvas id="splashLogo3d" aria-label="Logo Arquive Online"></canvas>' +
        '</div>' +
        '<p class="splash-hint"><span class="splash-hint-dot"></span> Inicializando</p>' +
      '</div>';

    try { document.body.appendChild(overlay); } catch (e) { return; }

    var canvas = overlay.querySelector('#splashLogo3d');
    var hint = overlay.querySelector('.splash-hint');
    var logo3d = null;
    var closed = false;
    var completed = false;
    var handedOff = false;
    var hardTimer = 0;
    var closeTimer = 0;
    var completeFallback = 0;

    function forceRemove() {
      try {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        else if (overlay && overlay.remove) overlay.remove();
      } catch (e) {}
    }

    // Depois do splash: apresenta o produto (com som) e devolve o foco ao login.
    function handoff() {
      if (handedOff) return;
      handedOff = true;
      var api = cinema();
      if (!api || typeof api.welcome !== 'function') {
        markSeen();
        focusLogin();
        return;
      }
      try {
        api.welcome({ onDone: focusLogin });
      } catch (e) {
        markSeen();
        focusLogin();
      }
    }

    function doClose() {
      if (closed) return;
      closed = true;
      try { clearTimeout(hardTimer); } catch (e) {}
      try { clearTimeout(closeTimer); } catch (e) {}
      try { clearTimeout(completeFallback); } catch (e) {}
      try { if (logo3d && logo3d.stop) logo3d.stop(); } catch (e) {}
      try { overlay.classList.add('leaving'); overlay.style.pointerEvents = 'none'; } catch (e) {}
      // transition/motion out, then hand over to the presentation
      setTimeout(function () {
        forceRemove();
        handoff();
      }, 650);
      // absolute guarantee removal even if transition callback logic fails
      setTimeout(function () {
        forceRemove();
        handoff();
      }, 1400);
    }

    function onComplete() {
      if (completed) return;
      completed = true;
      try {
        overlay.classList.add('ready');
        if (hint) hint.innerHTML = '<span class="splash-hint-dot"></span> Acessando...';
      } catch (e) {}
      // short pause for "motion" then enter
      closeTimer = setTimeout(doClose, reduced ? 300 : 500);
    }

    function startLogo() {
      if (!canvas || !window.ArquiveLogo3D) { onComplete(); return; }
      try {
        logo3d = new window.ArquiveLogo3D(canvas, {
          duration: reduced ? 1200 : INTRO_DURATION,
          onComplete: function () { onComplete(); }
        });
        var kick = function (tries) {
          if (closed || completed) return;
          tries = tries || 0;
          if (!canvas.isConnected) { if (tries < 40) requestAnimationFrame(function(){ kick(tries+1); }); else onComplete(); return; }
          var r = null;
          try { r = canvas.getBoundingClientRect(); } catch (e) {}
          if (!r || !r.width || !r.height) {
            if (tries < 60) requestAnimationFrame(function(){ kick(tries+1); }); else onComplete();
            return;
          }
          try { logo3d.resize(); } catch (e) {}
          try { logo3d.play(); } catch (e) { onComplete(); }
        };
        requestAnimationFrame(function () { requestAnimationFrame(function(){ kick(0); }); });
      } catch (e) {
        onComplete();
      }
    }

    // No skip UI: o splash é curto e a apresentação tem seu próprio "Pular".
    overlay.addEventListener('click', function (e) { e.stopPropagation(); });

    window.addEventListener('resize', function () {
      try { if (logo3d && logo3d.resize) logo3d.resize(); } catch (e) {}
    }, { passive: true });

    // Hard safety: never block login inputs
    hardTimer = setTimeout(function () {
      if (!closed) {
        if (!completed) onComplete(); else doClose();
      }
    }, reduced ? 3000 : 9000);

    // Independent of requestAnimationFrame: end the intro even if the canvas loop stalls.
    completeFallback = setTimeout(function () {
      if (!closed && !completed) onComplete();
    }, reduced ? 1600 : INTRO_DURATION + 1100);

    // Extra hard removal guarantee
    setTimeout(function () { if (!closed) doClose(); }, reduced ? 4500 : 12000);

    try {
      startLogo();
    } catch (e) {
      onComplete();
    }

    // If logo script not yet ready, wait briefly
    if (!window.ArquiveLogo3D) {
      setTimeout(function () {
        if (!closed && !completed && window.ArquiveLogo3D) {
          try { startLogo(); } catch (e) { onComplete(); }
        }
      }, 400);
      setTimeout(function () { if (!completed) onComplete(); }, 1800);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
