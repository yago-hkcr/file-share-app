/* Arquive Online — game-style laser splash intro (centered). */
(function () {
  'use strict';

  var STORAGE_KEY = 'fileshare-login-intro-seen-v7-laser-splash';
  var INTRO_DURATION = 5600;
  var FALLBACK_CLOSE = 9500;

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function mount() {
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') return;
    } catch (e) { return; }

    // Don't show on pages without the login/auth shell if desired? intro is for entry experience.
    // But storage key is shared; only index/login shows naturally. Safe to show.
    if (document.getElementById('splashIntro')) return;

    var reduced = prefersReducedMotion();
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
          '<canvas id="splashLogo3d" aria-label="Animação da logo Arquive Online"></canvas>' +
        '</div>' +
        '<p class="splash-hint"><span class="splash-hint-dot"></span> Inicializando sistema seguro</p>' +
      '</div>' +
      '<div class="splash-actions">' +
        '<button type="button" class="splash-btn splash-skip" data-action="skip">Pular</button>' +
        '<button type="button" class="splash-btn splash-enter" data-action="enter">Entrar <i class="fas fa-arrow-right" aria-hidden="true"></i></button>' +
      '</div>' +
      '<div class="splash-corner">ARQUIVE ONLINE</div>';

    document.body.appendChild(overlay);

    var canvas = overlay.querySelector('#splashLogo3d');
    var enterBtn = overlay.querySelector('[data-action="enter"]');
    var skipBtn = overlay.querySelector('[data-action="skip"]');
    var hint = overlay.querySelector('.splash-hint');
    var logo3d = null;
    var closed = false;
    var readyToEnter = false;
    var closeTimer = 0;
    var fallbackTimer = 0;

    function markSeen() {
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
    }

    function doClose() {
      if (closed) return;
      closed = true;
      clearTimeout(closeTimer);
      clearTimeout(fallbackTimer);
      if (logo3d) { try { logo3d.stop(); } catch (e) {} }
      overlay.classList.add('leaving');
      markSeen();
      setTimeout(function () {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        var username = document.getElementById('username');
        if (username && typeof username.focus === 'function') {
          try { username.focus({ preventScroll: true }); } catch (e) {}
        }
      }, 650);
    }

    function revealEnter() {
      readyToEnter = true;
      overlay.classList.add('ready');
      if (hint) hint.innerHTML = '<span class="splash-hint-dot"></span> Pressione Entrar para continuar';
      // auto-enter shortly after reveal for "game loading" feel, but allow skip anytime
      clearTimeout(closeTimer);
      closeTimer = setTimeout(doClose, reduced ? 800 : 1800);
    }

    function startLogo() {
      if (!canvas || !window.ArquiveLogo3D) { revealEnter(); return; }
      try {
        logo3d = new window.ArquiveLogo3D(canvas, {
          duration: INTRO_DURATION,
          onComplete: function () { revealEnter(); }
        });
        var kick = function () {
          if (closed || !canvas.isConnected) return;
          try { logo3d.resize(); } catch (e) {}
          var r = canvas.getBoundingClientRect();
          if (!r.width || !r.height) { requestAnimationFrame(kick); return; }
          try { logo3d.play(); } catch (e) { revealEnter(); }
        };
        requestAnimationFrame(function () { requestAnimationFrame(kick); });
      } catch (e) {
        revealEnter();
      }
    }

    overlay.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn) {
        var a = btn.getAttribute('data-action');
        if (a === 'skip' || a === 'enter') { e.preventDefault(); doClose(); }
        return;
      }
      // click anywhere after ready also enters
      if (readyToEnter) doClose();
    });

    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        doClose();
      }
    });

    window.addEventListener('resize', function () {
      if (logo3d) try { logo3d.resize(); } catch (e) {}
    }, { passive: true });

    // absolute fallback: never trap the user on login
    fallbackTimer = setTimeout(function () {
      if (!closed) {
        if (!readyToEnter) revealEnter();
        else doClose();
      }
    }, reduced ? 2500 : FALLBACK_CLOSE);

    // start
    if (skipBtn) skipBtn.focus({ preventScroll: true });
    if (reduced) {
      // show static/quick reveal
      startLogo();
      setTimeout(revealEnter, 400);
    } else {
      startLogo();
    }

    // extra safety: if ArquiveLogo3D script missing, don't block
    setTimeout(function () {
      if (!window.ArquiveLogo3D && !readyToEnter) revealEnter();
    }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
