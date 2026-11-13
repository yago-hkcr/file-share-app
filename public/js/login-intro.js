/* Arquive Online — game-style laser splash intro (centered, no skip). */
(function () {
  'use strict';

  var STORAGE_KEY = 'fileshare-login-intro-seen-v9-smooth-laser';
  var INTRO_DURATION = 5600;

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function focusLogin() {
    var username = document.getElementById('username');
    if (username && typeof username.focus === 'function') {
      try { username.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function mount() {
    var reduced = prefersReducedMotion();
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') return;
    } catch (e) { return; }

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
    var hardTimer = 0;
    var closeTimer = 0;
    var completeFallback = 0;

    function markSeen() {
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
    }

    function forceRemove() {
      try {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        else if (overlay && overlay.remove) overlay.remove();
      } catch (e) {}
    }

    function doClose() {
      if (closed) return;
      closed = true;
      try { clearTimeout(hardTimer); } catch (e) {}
      try { clearTimeout(closeTimer); } catch (e) {}
      try { clearTimeout(completeFallback); } catch (e) {}
      try { if (logo3d && logo3d.stop) logo3d.stop(); } catch (e) {}
      markSeen();
      try { overlay.classList.add('leaving'); overlay.style.pointerEvents = 'none'; } catch (e) {}
      // transition/motion out, then remove and enable typing
      setTimeout(function () {
        forceRemove();
        focusLogin();
      }, 650);
      // absolute guarantee removal even if transition callback logic fails
      setTimeout(function () {
        forceRemove();
        focusLogin();
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
      closeTimer = setTimeout(doClose, reduced ? 350 : 900);
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

    // No skip UI; keep Enter/Escape as accessibility-only emergency? user asked for no skip option.
    // Still close on completion/fallbacks so user can type.
    overlay.addEventListener('click', function (e) {
      // prevent clicks passing through? overlay covers screen; allow default (no skip action)
      e.stopPropagation();
    });

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
    setTimeout(function () { if (!closed) { markSeen(); doClose(); } }, reduced ? 4500 : 12000);

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
