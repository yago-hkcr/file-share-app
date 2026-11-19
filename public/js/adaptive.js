(function () {
  'use strict';

  // Sistema adaptativo: reconhece o dispositivo (tamanho, orientação, entrada)
  // e expõe estado no <html> + variáveis CSS, além de "enquadrar" elementos
  // marcados com [data-fit] para que nunca ultrapassem o contêiner.
  var root = document.documentElement;

  // Faixas alinhadas ao responsive-engine.css. O estado é informativo; o
  // layout em si é decidido por media/container queries, não por JS.
  function sizeClass(w) {
    if (w < 360) return 'xxs';
    if (w < 480) return 'xs';
    if (w < 640) return 'sm';
    if (w < 768) return 'md';
    if (w < 1024) return 'lg';
    if (w < 1280) return 'xl';
    if (w < 1600) return 'xxl';
    if (w < 2160) return '2xl';
    return '3xl';
  }

  var rafId = 0;
  function apply() {
    rafId = 0;
    var vv = window.visualViewport;
    var w = vv ? Math.round(vv.width) : window.innerWidth;
    var h = vv ? Math.round(vv.height) : window.innerHeight;
    var dpr = window.devicePixelRatio || 1;
    var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
    var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    var orientation = w >= h ? 'landscape' : 'portrait';
    var sc = sizeClass(w);

    root.setAttribute('data-viewport', sc);
    root.setAttribute('data-orientation', orientation);
    root.setAttribute('data-input', touch ? 'touch' : 'mouse');
    root.setAttribute('data-pointer', coarse ? 'coarse' : 'fine');

    root.style.setProperty('--vw', w + 'px');
    root.style.setProperty('--vh', h + 'px');
    root.style.setProperty('--app-height', h + 'px');
    root.style.setProperty('--vmin', Math.min(w, h) + 'px');
    root.style.setProperty('--vmax', Math.max(w, h) + 'px');
    root.style.setProperty('--dpr', String(dpr));

    // Teclado virtual: expõe a área coberta sem redimensionar nem fixar
    // alturas. Componentes que precisam se proteger usam --keyboard-inset.
    var keyboard = Math.max(0, Math.round(window.innerHeight - h - (vv ? vv.offsetTop : 0)));
    root.style.setProperty('--keyboard-inset', keyboard > 80 ? keyboard + 'px' : '0px');
    if (keyboard > 80) root.setAttribute('data-keyboard', 'open');
    else root.removeAttribute('data-keyboard');

    try {
      window.dispatchEvent(new CustomEvent('fileshare:adaptive', {
        detail: { width: w, height: h, viewport: sc, orientation: orientation, touch: touch }
      }));
    } catch (e) {}
  }

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(apply);
  }

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedule);
    window.visualViewport.addEventListener('scroll', schedule);
  }
  if (window.matchMedia) {
    try { window.matchMedia('(pointer: coarse)').addEventListener('change', schedule); } catch (e) {}
    try { window.matchMedia('(orientation: landscape)').addEventListener('change', schedule); } catch (e) {}
  }

  apply();

  // Auto-fit: elementos com [data-fit] são escalados para caber no pai.
  if ('ResizeObserver' in window) {
    var ro = new ResizeObserver(function (entries) {
      entries.forEach(function (entry) {
        var el = entry.target;
        var parent = el.parentElement;
        if (!parent) return;
        el.style.transform = '';
        var pw = parent.clientWidth;
        var ph = parent.clientHeight;
        var ew = el.scrollWidth;
        var eh = el.scrollHeight;
        if (ew <= 0 || eh <= 0 || pw <= 0 || ph <= 0) return;
        var scale = Math.min(pw / ew, ph / eh);
        if (scale < 0.999) {
          el.style.transform = 'scale(' + scale.toFixed(4) + ')';
          el.style.transformOrigin = 'top left';
        } else {
          el.style.transform = '';
        }
      });
    });

    function observeAll() {
      document.querySelectorAll('[data-fit]').forEach(function (el) { ro.observe(el); });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', observeAll);
    } else {
      observeAll();
    }

    if ('MutationObserver' in window) {
      var mo = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (!n || n.nodeType !== 1) return;
            if (n.hasAttribute && n.hasAttribute('data-fit')) ro.observe(n);
            if (n.querySelectorAll) {
              n.querySelectorAll('[data-fit]').forEach(function (el) { ro.observe(el); });
            }
          });
        });
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // Altura real do header para posicionar rails sticky e âncoras. Usa apenas
  // getBoundingClientRect dentro de rAF (sem escrever no DOM a cada scroll).
  function measureHeader() {
    var header = document.querySelector('.header');
    if (!header) return;
    var rect = header.getBoundingClientRect();
    var height = Math.round(rect.height);
    if (!height) return;
    if (root.style.getPropertyValue('--header-h') !== height + 'px') {
      root.style.setProperty('--header-h', height + 'px');
    }
  }

  function scheduleHeader() {
    requestAnimationFrame(measureHeader);
  }

  window.addEventListener('load', scheduleHeader);
  document.addEventListener('DOMContentLoaded', scheduleHeader);
  scheduleHeader();

  if ('ResizeObserver' in window) {
    var headerTarget = document.querySelector('.header');
    if (headerTarget) new ResizeObserver(scheduleHeader).observe(headerTarget);
  }

  // Diagnóstico leve para testes automatizados; não altera estilos.
  window.fileShareLayoutMetrics = function () {
    var se = document.scrollingElement || document.documentElement;
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: se.scrollWidth,
      scrollHeight: se.scrollHeight,
      headerHeight: parseInt(root.style.getPropertyValue('--header-h'), 10) || 0,
      viewport: root.getAttribute('data-viewport'),
      orientation: root.getAttribute('data-orientation')
    };
  };

  window.fileShareAdaptive = { apply: apply, sizeClass: sizeClass };
})();
