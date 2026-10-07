/* FileShare - suporte adicional para aparelhos móveis.
   O CSS responsivo faz o trabalho principal; este arquivo apenas adiciona
   classes úteis sem interferir no desktop. */
(function () {
  'use strict';

  var root = document.documentElement;

  function updateDeviceClass() {
    var isMobile = window.matchMedia('(max-width: 800px)').matches;
    root.classList.toggle('is-mobile', isMobile);
  }

  updateDeviceClass();
  window.addEventListener('resize', updateDeviceClass, { passive: true });
})();
