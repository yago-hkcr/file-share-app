// FX: partÃ­culas, luz interativa, tilt 3D, ondinha e contador. Leve: 30 fps, pausa fora da tela e reduz efeitos em aparelhos simples.
(function () {
  const root = document.documentElement;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { root.classList.add('fx-off'); return; }
  const $ = (s, r) => (r || document).querySelector(s);
  const mobile = matchMedia('(max-width: 700px)').matches;
  const weak = (navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 4) <= 4;
  if (weak) root.classList.add('fx-lite');

  function start() {
    // entrada da pÃ¡gina (some depois, para nÃ£o repetir nas atualizaÃ§Ãµes da lista)
    root.classList.add('fx-boot'); setTimeout(() => root.classList.remove('fx-boot'), 1600);
    ['a', 'b'].forEach(k => { const o = document.createElement('div'); o.className = 'fx-orb ' + k; o.setAttribute('aria-hidden', 'true'); document.body.prepend(o); });

    // ---- rede de partÃ­culas ----
    const cv = document.createElement('canvas'); cv.id = 'fxCanvas'; cv.setAttribute('aria-hidden', 'true'); document.body.prepend(cv);
    const ctx = cv.getContext('2d');
    const glow = document.createElement('div'); glow.className = 'fx-pointer-glow'; glow.setAttribute('aria-hidden', 'true'); document.body.insertBefore(glow, cv.nextSibling);
    let glowTimer = null;
    const moveGlow = e => {
      glow.style.setProperty('--fx-pointer-x', e.clientX + 'px'); glow.style.setProperty('--fx-pointer-y', e.clientY +¶»§q«^