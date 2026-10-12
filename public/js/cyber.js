// Fundo animado: chuva de código no login/cadastro + versão sutil nas páginas internas.
(function () {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const body = document.body;
  const root = document.documentElement;
  // Desktop (tela maior com ponteiro fino): o fundo pode ser mais presente sem pesar.
  const desktop = !!(window.matchMedia && window.matchMedia('(min-width: 769px) and (pointer: fine)').matches);

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
  // Páginas internas (painel/sala/admin/coleta) ganham a mesma chuva, porém mais sutil e atrás do conteúdo.
  const interior = !reduce && (body.classList.contains('app-page') || body.classList.contains('sala-page') || body.classList.contains('collection-page'));
  let canvas = document.getElementById('cyberRain');
  const created = !canvas && interior;
  if (created) {
    canvas = document.createElement('canvas');
    canvas.id = 'cyberRain';
    canvas.className = 'cyber-subtle';
    const scan = document.createElement('div');
    scan.className = 'cy-scan cyber-subtle';
    // Inseridos como filhos do <html> com z-index:-1: ficam acima do fundo do documento,
    // mas sempre atrás de todo o conteúdo e do fundo do body (grade inclusa).
    root.insertBefore(scan, body);
    root.insertBefore(canvas, scan);
  }
  if (!canvas || reduce) return;
  const ctx = canvas.getContext('2d');
  const chars = '01ABCDEF<>/{}[]#$%=+*'.split('');
  const size = created ? 20 : 16;
  let cols = 0, drops = [], rgb = '34,197,94', w = 0, h = 0, last = 0;

  function isDarkTheme() {
    return root.getAttribute('data-theme') !== 'light';
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / size);
    drops = Array.from({ length: cols }, () => Math.random() * -50);
    if (created) {
      ctx.clearRect(0, 0, w, h); // interno: canvas transparente para não cobrir a grade de fundo
    } else {
      ctx.fillStyle = isDarkTheme() ? 'rgb(0,0,0)' : 'rgb(255,255,255)';
      ctx.fillRect(0, 0, w, h);
    }
  }
  const readColor = () => {
    const v = getComputedStyle(body).getPropertyValue('--cy-rgb').trim();
    if (v) rgb = v;
  };
  resize(); readColor();
  window.addEventListener('resize', resize);
  setInterval(readColor, 400); // acompanha a troca de tema

  function frame(t) {
    requestAnimationFrame(frame);
    const step = created ? (desktop ? 80 : 110) : 55;
    if (document.hidden || body.classList.contains('auth-exit') || t - last < step) return; // interno: leve; pausa durante a saída do login
    last = t;
    if (created) {
      // Apaga gradualmente em vez de pintar por cima: o canvas permanece transparente.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,' + (desktop ? 0.1 : 0.12) + ')';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.fillStyle = isDarkTheme() ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.22)'; // esmaece o rastro sem escurecer o tema claro
      ctx.fillRect(0, 0, w, h);
    }
    ctx.font = size + 'px "Share Tech Mono", monospace';
    const alpha = created ? (isDarkTheme() ? (desktop ? 0.72 : 0.5) : (desktop ? 0.45 : 0.35)) : (isDarkTheme() ? 0.85 : 0.55);
    for (let i = 0; i < cols; i++) {
      if (Math.random() > (created ? (desktop ? 0.62 : 0.72) : 0.55)) { drops[i] += 1; if (drops[i] * size > h && Math.random() > 0.96) drops[i] = 0; continue; }
      const x = i * size, y = drops[i] * size;
      ctx.fillStyle = 'rgba(' + rgb + ',' + alpha + ')';
      ctx.fillText(chars[(Math.random() * chars.length) | 0], x, y);
      drops[i] += 1;
      if (y > h && Math.random() > 0.96) drops[i] = 0;
    }
  }
  requestAnimationFrame(frame);
})();
