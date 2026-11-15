// Fundo hacker interativo: letras/números parados que se espalham e brilham ao passar o cursor.
// Versão "manteiga": máxima fluidez sem perder o visual (campo, espalhar, brilho).
// - grade base pré-renderizada (1 blit por frame ativo) e só a área afetada é atualizada
// - loop pausa em repouso (custo zero quando parado)
// - brilho simulado sem shadowBlur (muito mais leve), DPR controlado, FPS adaptativo
(function () {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const body = document.body;
  const root = document.documentElement;
  const gfxLevel = root.getAttribute('data-gfx') || 'high';
  const lowGfx = gfxLevel === 'minimal' || gfxLevel === 'basic' || gfxLevel === 'low';
  const finePointer = !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
  const desktop = !!(window.matchMedia && window.matchMedia('(min-width: 769px) and (pointer: fine)').matches);
  const weak = !finePointer || ((navigator.hardwareConcurrency || 8) <= 4) || ((navigator.deviceMemory || 8) <= 4);

  // ---- Linha de status digitando ----
  const out = document.getElementById('cyType');
  if (out) {
    const text = out.getAttribute('data-text') || '';
    if (reduce) out.textContent = text;
    else {
      let i = 0;
      const tick = () => {
        out.textContent = text.slice(0, ++i);
        if (i < text.length) setTimeout(tick, 38 + Math.random() * 40);
      };
      setTimeout(tick, 500);
    }
  }

  function ensureBaseCss() {
    if (document.getElementById('cyberBaseCss')) return;
    const st = document.createElement('style');
    st.id = 'cyberBaseCss';
    st.textContent = [
      '#cyberRain{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;}',
      '.cy-grid{position:fixed;left:-60%;right:-60%;bottom:0;height:70vh;z-index:0;pointer-events:none;}',
      '.cy-scan{position:fixed;inset:0;z-index:2;pointer-events:none;overflow:hidden;}',
      'html.cy-interior>#cyberRain,html.cy-interior>.cy-grid,html.cy-interior>.cy-scan{z-index:-1;}',
      'html.cy-interior>#cyberRain{opacity:.72;}',
      'html.cy-interior>.cy-grid{opacity:.34;}',
      'html.cy-interior>.cy-scan{opacity:.38;}',
      '@media(prefers-reduced-motion:reduce){#cyberRain{display:none;}}'
    ].join('');
    document.head.appendChild(st);
  }

  // ---- Canvas de fundo (em todas as páginas) ----
  let canvas = document.getElementById('cyberRain');
  if (!canvas && !reduce && !lowGfx) {
    ensureBaseCss();
    canvas = document.createElement('canvas');
    canvas.id = 'cyberRain';
    canvas.setAttribute('aria-hidden', 'true');
    const grid = document.createElement('div');
    grid.className = 'cy-grid';
    grid.setAttribute('aria-hidden', 'true');
    const scan = document.createElement('div');
    scan.className = 'cy-scan';
    scan.setAttribute('aria-hidden', 'true');
    root.insertBefore(canvas, body);
    root.insertBefore(grid, body);
    root.insertBefore(scan, body);
    root.classList.add('cy-interior');
  } else if (canvas) {
    ensureBaseCss();
  }
  if (!canvas || reduce || lowGfx) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const glyphs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$#%&@*+<>/\\{}[]|=~^'.split('');
  const randGlyph = () => glyphs[(Math.random() * glyphs.length) | 0];

  let w = 0, h = 0, dpr = 1, cols = 0, rows = 0, rgb = '34,197,94';
  let particles = [];
  const active = new Set();

  const cell = weak ? 32 : (desktop ? 26 : 30);
  const fontSize = weak ? 15 : (desktop ? 15 : 14);
  const radius = weak ? 120 : (desktop ? 150 : 120);
  const radius2 = radius * radius;
  const strength = desktop ? 1.25 : 1.05;

  const pointer = { x: -9999, y: -9999, active: false };

  const baseCanvas = document.createElement('canvas');
  const bctx = baseCanvas.getContext('2d');

  let rafId = 0;
  let needsPresent = true;

  function isDarkTheme() { return root.getAttribute('data-theme') !== 'light'; }

  function requestPresent() {
    needsPresent = true;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function readColor() {
    const prev = rgb;
    const v = getComputedStyle(body).getPropertyValue('--cy-rgb').trim();
    if (v) rgb = v;
    if (rgb !== prev && particles.length) renderBase();
  }

  function build() {
    particles = [];
    active.clear();
    cols = Math.ceil(w / cell) + 1;
    rows = Math.ceil(h / cell) + 1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const ox = x * cell + cell * 0.5;
        const oy = y * cell + cell * 0.5;
        particles.push({
          ch: randGlyph(), ox: ox, oy: oy, x: ox, y: oy,
          vx: 0, vy: 0, heat: 0, base: 0.55 + Math.random() * 0.45
        });
      }
    }
    renderBase();
  }

  function renderBase() {
    if (!bctx) return;
    baseCanvas.width = Math.max(1, Math.floor(w * dpr));
    baseCanvas.height = Math.max(1, Math.floor(h * dpr));
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = isDarkTheme();
    bctx.fillStyle = dark ? 'rgb(0,0,0)' : 'rgb(255,255,255)';
    bctx.fillRect(0, 0, w, h);
    bctx.font = fontSize + 'px "Share Tech Mono", monospace';
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    const baseA = dark ? 0.20 : 0.14;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      bctx.fillStyle = 'rgba(' + rgb + ',' + (baseA * p.base) + ')';
      bctx.fillText(p.ch, p.ox, p.oy);
    }
    needsPresent = true;
  }

  function redrawCell(i) {
    if (!bctx) return;
    const p = particles[i];
    if (!p) return;
    const dark = isDarkTheme();
    const baseA = dark ? 0.20 : 0.14;
    const pad = cell * 0.6;
    bctx.fillStyle = dark ? 'rgb(0,0,0)' : 'rgb(255,255,255)';
    bctx.fillRect(p.ox - pad, p.oy - pad, pad * 2, pad * 2);
    bctx.font = fontSize + 'px "Share Tech Mono", monospace';
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    bctx.fillStyle = 'rgba(' + rgb + ',' + (baseA * p.base) + ')';
    bctx.fillText(p.ch, p.ox, p.oy);
  }

  function resize() {
    const maxDpr = weak ? 1 : 1.5;
    dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    requestPresent();
  }

  function setPointer(x, y) { pointer.x = x; pointer.y = y; pointer.active = true; requestPresent(); }
  function clearPointer() { pointer.active = false; pointer.x = -9999; pointer.y = -9999; requestPresent(); }

  window.addEventListener('mousemove', (e) => setPointer(e.clientX, e.clientY), { passive: true });
  window.addEventListener('mouseleave', clearPointer, { passive: true });
  window.addEventListener('blur', clearPointer);
  window.addEventListener('touchstart', (e) => { if (e.touches && e.touches[0]) setPointer(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  window.addEventListener('touchmove', (e) => { if (e.touches && e.touches[0]) setPointer(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  window.addEventListener('touchend', clearPointer, { passive: true });
  window.addEventListener('touchcancel', clearPointer, { passive: true });

  resize();
  readColor();
  window.addEventListener('resize', resize);

  const flickerTimer = setInterval(() => {
    if (!particles.length || document.hidden) return;
    let changed = false;
    for (let n = 0; n < 14; n++) {
      const i = (Math.random() * particles.length) | 0;
      const p = particles[i];
      if (p && p.heat < 0.05 && !active.has(i)) {
        p.ch = randGlyph();
        redrawCell(i);
        changed = true;
      }
    }
    if (changed) requestPresent();
  }, 220);

  let themeTimer = null;
  const scheduleThemeRender = () => {
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => { readColor(); renderBase(); requestPresent(); }, 60);
  };
  if (window.MutationObserver) {
    new MutationObserver(scheduleThemeRender).observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  }

  let minFrame = 1000 / 30;
  let avgCost = 0;

  function drawGlow(c, ch, x, y, glow, dark) {
    const o = 0.6 + glow * 1.4;
    c.fillText(ch, x - o, y);
    c.fillText(ch, x + o, y);
    c.fillText(ch, x, y - o);
    c.fillText(ch, x, y + o);
    if (glow > 0.35) {
      const o2 = o + 1.2;
      c.fillText(ch, x - o2, y - o2);
      c.fillText(ch, x + o2, y - o2);
      c.fillText(ch, x - o2, y + o2);
      c.fillText(ch, x + o2, y + o2);
    }
  }

  function frame(t) {
    rafId = 0;
    if (root.classList.contains('gfx-lite') || document.hidden || body.classList.contains('auth-exit')) {
      if (active.size || needsPresent) rafId = requestAnimationFrame(frame);
      return;
    }

    const hasWork = pointer.active || active.size > 0 || needsPresent;
    if (!hasWork) return;

    if (frame._last && t - frame._last < minFrame && !needsPresent && active.size === 0) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    frame._last = t;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

    if (pointer.active) {
      const px = pointer.x, py = pointer.y;
      const c0 = Math.max(0, Math.floor((px - radius) / cell));
      const c1 = Math.min(cols - 1, Math.ceil((px + radius) / cell));
      const r0 = Math.max(0, Math.floor((py - radius) / cell));
      const r1 = Math.min(rows - 1, Math.ceil((py + radius) / cell));
      for (let y = r0; y <= r1; y++) {
        for (let x = c0; x <= c1; x++) {
          const i = y * cols + x;
          const p = particles[i];
          if (!p) continue;
          const dx = p.x - px, dy = p.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 < radius2) {
            const dist = Math.sqrt(d2);
            const f = (radius - dist) / radius;
            const ang = Math.atan2(dy, dx);
            const push = f * strength * (0.85 + Math.random() * 0.35);
            p.vx += Math.cos(ang) * push;
            p.vy += Math.sin(ang) * push;
            if (f > p.heat) p.heat = f;
            if (f > 0.55 && Math.random() < 0.08) p.ch = randGlyph();
            active.add(i);
          }
        }
      }
    }

    ctx.drawImage(baseCanvas, 0, 0, w, h);
    if (active.size) {
      const dark = isDarkTheme();
      const baseA = dark ? 0.20 : 0.14;
      const bg = dark ? 'rgb(0,0,0)' : 'rgb(255,255,255)';
      ctx.font = fontSize + 'px "Share Tech Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const pad = cell * 0.6;

      for (const i of active) {
        const p = particles[i];
        if (!p) { active.delete(i); continue; }

        p.vx += (p.ox - p.x) * 0.085;
        p.vy += (p.oy - p.y) * 0.085;
        p.vx *= 0.82;
        p.vy *= 0.82;
        p.x += p.vx;
        p.y += p.vy;
        p.heat *= 0.90;

        ctx.fillStyle = bg;
        ctx.fillRect(p.ox - pad, p.oy - pad, pad * 2, pad * 2);

        const glow = p.heat;
        if (glow > 0.015) {
          const a = Math.min(1, baseA + glow * (dark ? 1.0 : 0.85));
          ctx.fillStyle = 'rgba(' + rgb + ',' + (a * (0.22 + glow * 0.25)) + ')';
          drawGlow(ctx, p.ch, p.x, p.y, glow, dark);
          ctx.fillStyle = 'rgba(' + rgb + ',' + a + ')';
          ctx.fillText(p.ch, p.x, p.y);
          if (glow > 0.25) {
            ctx.fillStyle = dark
              ? 'rgba(220,255,235,' + (0.18 + glow * 0.55) + ')'
              : 'rgba(255,255,255,' + (0.14 + glow * 0.45) + ')';
            ctx.fillText(p.ch, p.x, p.y);
          }
        } else {
          ctx.fillStyle = 'rgba(' + rgb + ',' + (baseA * p.base) + ')';
          ctx.fillText(p.ch, p.x, p.y);
        }

        if (p.heat < 0.01 && Math.abs(p.x - p.ox) < 0.05 && Math.abs(p.y - p.oy) < 0.05 && Math.abs(p.vx) < 0.02 && Math.abs(p.vy) < 0.02) {
          p.x = p.ox; p.y = p.oy; p.vx = 0; p.vy = 0; p.heat = 0;
          active.delete(i);
        }
      }
    }

    needsPresent = false;

    if (t0) {
      const cost = performance.now() - t0;
      avgCost = avgCost ? (avgCost * 0.85 + cost * 0.15) : cost;
      if (avgCost > 14) minFrame = 1000 / 30;
      else if (avgCost < 8 && !weak) minFrame = 1000 / 60;
    }

    if (pointer.active || active.size > 0) rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestPresent(); });

  window.addEventListener('pagehide', () => {
    clearInterval(flickerTimer);
    clearTimeout(themeTimer);
    if (rafId) cancelAnimationFrame(rafId);
  }, { once: true });
})();
