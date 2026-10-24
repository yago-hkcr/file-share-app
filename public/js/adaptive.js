(function () {
  'use strict';

  // Sistema adaptativo: reconhece o dispositivo (tamanho, orientação, entrada)
  // e expõe estado no <html> + variáveis CSS, além de "enquadrar" elementos
  // marcados com [data-fit] para que nunca ultrapassem o contêiner.
  var root = document.documentElement;

  function sizeClass(w) {
    if (w < 480) return 'xs';
    if (w < 768) return 'sm';
    if (w < 1024) return 'md';
    if (w < 1280) return 'lg';
    if (w < 1536) return 'xl';
    return 'xxl';
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
    root.style.setProperty('--vmin', Math.min(w, h) + 'px');
    root.style.setProperty('--vmax', Math.max(w, h) + 'px');
    root.style.setProperty('--dpr', String(dpr));

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

  // Garantia final: evita overflow horizontal residual no documento.
  function ensureNoHOverflow() {
    try {
      if (document.documentElement.scrollWidth > window.innerWidth + 2) {
        document.documentElement.style.overflowX = 'hidden';
        document.body.style.overflowX = 'hidden';
      }
    } catch (e) {}
  }
  window.addEventListener('load', ensureNoHOverflow);
  setTimeout(ensureNoHOverflow, 1200);

  window.fileShareAdaptive = { apply: apply, sizeClass: sizeClass };
})();
