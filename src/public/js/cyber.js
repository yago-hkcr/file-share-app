// Fundo animado das telas de login/cadastro: chuva de cÃ³digo + linha de status "digitando".
(function () {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Linha de status digitando ----
  const out = document.getElementById('cyType');
  if (out) {
    const text = out.getAttribute('data-text') || '';
    if (reduce) out.textContent = text;
    else {
      let i = 0;
      const tick = () => { out.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(tick, 38 + Math.random() * 40); };
      setTimeout(tick, 500);
    }
  }

  // ---- Chuva de cÃ³digo ----
  const canvas = document.getElementById('cyberRain');
  if (!canvas || reduce) return;
  const ctx = canvas.getContext('2d');
  const chars = '01ABCDEF<>/{}[]#$%=+*'.split('');
  const size = 16;
  let cols = 0, drops = [], rgb = '255,107,74', w = 0, h = 0, last = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / size);
    drops = Array.from({ length: cols }, () => Math.random() * -50);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  }
  const readColor = () => {
    const v = getComputedStyle(document.body).getPropertyValue('--cy-rgb').trim();
    if (v) rgb = v;
  };
  resize(); readColor();
  w¶»§q«^