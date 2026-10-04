// Fundo animado das telas de login/cadastro: chuva de código + linha de status "digitando".
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

  // ---- Chuva de código ----
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
  window.addEventListener('resize', resize);
  setInterval(readColor, 400); // acompanha a troca de tema

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden || t - last < 55) return; // ~18 quadros/s: leve e com ar "de terminal"
    last = t;
    ctx.fillStyle = 'rgba(8,4,14,0.16)'; // deixa o rastro esmaecer
    ctx.fillRect(0, 0, w, h);
    ctx.font = size + 'px "Share Tech Mono", monospace';
    for (let i = 0; i < cols; i++) {
      if (Math.random() > 0.55) { drops[i] += 1; if (drops[i] * size > h && Math.random() > 0.96) drops[i] = 0; continue; }
      const x = i * size, y = drops[i] * size;
      ctx.fillStyle = 'rgba(' + rgb + ',0.85)';
      ctx.fillText(chars[(Math.random() * chars.length) | 0], x, y);
      drops[i] += 1;
      if (y > h && Math.random() > 0.96) drops[i] = 0;
    }
  }
  requestAnimationFrame(frame);
})();
