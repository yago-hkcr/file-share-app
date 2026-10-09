// Nivel de graficos (engrenagem no login): alto, medio ou baixo. Salvo no navegador,
// vale no site todo e deixa o site mais leve em aparelhos simples.
(function () {
  'use strict';
  var KEY = 'fileshare-gfx';
  var root = document.documentElement;

  function normalize(value) {
    return value === 'medium' || value === 'low' ? value : 'high';
  }

  function current() {
    try { return normalize(localStorage.getItem(KEY)); }
    catch (e) { return 'high'; }
  }

  function apply(level) {
    var gfx = normalize(level);
    if (gfx === 'high') root.removeAttribute('data-gfx');
    else root.setAttribute('data-gfx', gfx);
    document.querySelectorAll('[data-gfx-option]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.gfxOption === gfx);
      btn.setAttribute('aria-pressed', String(btn.dataset.gfxOption === gfx));
    });
    return gfx;
  }

  window.fileShareGfx = function (level) {
    var gfx = apply(level);
    try { localStorage.setItem(KEY, gfx); } catch (e) {}
    return gfx;
  };

  apply(current());

  document.addEventListener('click', function (event) {
    var openBtn = event.target.closest && event.target.closest('#authSettingsBtn');
    if (openBtn) {
      var modal = document.getElementById('gfxModal');
      if (modal) { modal.style.display = 'flex'; modal.setAttribute('aria-hidden', 'false'); }
      return;
    }
    if (event.target.closest && event.target.closest('[data-gfx-close]')) {
      var modal2 = document.getElementById('gfxModal');
      if (modal2) { modal2.style.display = 'none'; modal2.setAttribute('aria-hidden', 'true'); }
      return;
    }
    var option = event.target.closest && event.target.closest('[data-gfx-option]');
    if (option) {
      window.fileShareGfx(option.dataset.gfxOption);
      if (typeof window.toast === 'function') window.toast('Gráficos ajustados.');
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var modal = document.getElementById('gfxModal');
    if (modal && modal.style.display !== 'none') { modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); }
  });
})();
