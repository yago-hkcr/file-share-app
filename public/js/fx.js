// FX cyber: rede holográfica, grid neon, pulsos de dados e interação magnética.
(function () {
  const root = document.documentElement;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { root.classList.add('fx-off'); return; }
  const $ = (s, r) => (r || document).querySelector(s);
  const mobile = matchMedia('(max-width: 700px)').matches;
  const weak = (navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 4) <= 4;
  if (weak) root.classList.add('fx-lite');

  function start() {
    // entrada da página (some depois, para não repetir nas atualizações da lista)
    root.classList.add('fx-boot'); setTimeout(() => root.classList.remove('fx-boot'), 1600);
    ['a', 'b'].forEach(k => { const o = document.createElement('div'); o.className = 'fx-orb ' + k; o.setAttribute('aria-hidden', 'true'); document.body.prepend(o); });

    // ---- rede de partículas ----
    const cv = document.createElement('canvas'); cv.id = 'fxCanvas'; cv.setAttribute('aria-hidden', 'true'); document.body.prepend(cv);
    const ctx = cv.getContext('2d');
    const glow = document.createElement('div'); glow.className = 'fx-pointer-glow'; glow.setAttribute('aria-hidden', 'true'); document.body.insertBefore(glow, cv.nextSibling);
    let glowTimer = null;
    const moveGlow = e => {
      glow.style.setProperty('--fx-pointer-x', e.clientX + 'px'); glow.style.setProperty('--fx-pointer-y', e.clientY + 'px'); glow.classList.add('is-visible');
      if (glowTimer) clearTimeout(glowTimer);
      if (e.pointerType === 'touch' || e.pointerType === 'pen') glowTimer = setTimeout(() => glow.classList.remove('is-visible'), 1350);
    };
    addEventListener('pointermove', moveGlow, { passive:true }); addEventListener('pointerdown', moveGlow, { passive:true });
    addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && e.pointerType !== 'pen') glow.classList.remove('is-visible'); });
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let W = 0, H = 0, N = mobile ? 18 : (weak ? 30 : 46), nodes = [], pulses = [], mx = -999, my = -999, rgb = '99,102,241';
    const LINK = mobile ? 110 : 140;
    const rnd = (a, b) => a + Math.random() * (b - a);
    function size() { W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    function seed() { nodes = Array.from({ length: N }, () => ({ x: rnd(0, W), y: rnd(0, H), vx: rnd(-.25, .25), vy: rnd(-.25, .25), r: rnd(1, 2.2) })); }
    function color() {
      const v = getComputedStyle(document.body).getPropertyValue('--cy-rgb').trim();
      rgb = v || (root.getAttribute('data-theme') === 'dark' ? '168,85,247' : '255,107,74');
    }
    addEventListener('resize', () => { size(); seed(); }, { passive: true });
    addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; }, { passive: true });
    addEventListener('pointerleave', () => { mx = my = -999; });
    size(); seed(); color();

    const GRID = mobile ? 46 : 58;
    const drawCyberGrid = t => {
      const ox = (t * .006) % GRID, oy = (t * .003) % GRID;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(' + rgb + ',.045)';
      ctx.beginPath();
      for (let x = -GRID + ox; x < W + GRID; x += GRID) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = -GRID + oy; y < H + GRID; y += GRID) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();

      ctx.strokeStyle = 'rgba(' + rgb + ',.065)';
      ctx.beginPath();
      for (let y = ((t * .018) % 120) - 120; y < H + 120; y += 120) {
        ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
    };

    let last = 0, running = true, slow = 0, count = 0, tick = 0, nextPulse = 0;
    function frame(t) {
      if (!running) return;
      requestAnimationFrame(frame);
      if (t - last < 33) return; // ~30 fps
      const t0 = performance.now(); last = t;
      if (++tick % 90 === 0) color();
      ctx.clearRect(0, 0, W, H);
      drawCyberGrid(t);
      for (const n of nodes) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < -10) n.x = W + 10; else if (n.x > W + 10) n.x = -10;
        if (n.y < -10) n.y = H + 10; else if (n.y > H + 10) n.y = -10;
      }
      ctx.lineWidth = 1;
      const L2 = LINK * LINK, links = [];
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
          if (d < L2) { ctx.strokeStyle = 'rgba(' + rgb + ',' + (0.34 * (1 - d / L2)).toFixed(3) + ')'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); links.push([a, b]); }
        }
        const mdx = a.x - mx, mdy = a.y - my, md = mdx * mdx + mdy * mdy;
        if (md < 190 * 190) { ctx.strokeStyle = 'rgba(' + rgb + ',' + (0.55 * (1 - md / (190 * 190))).toFixed(3) + ')'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mx, my); ctx.stroke(); a.x -= mdx * 0.0009; a.y -= mdy * 0.0009; }
      }
      ctx.fillStyle = 'rgba(' + rgb + ',.75)';
      for (const n of nodes) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.2832); ctx.fill(); }
      // pacotes de dados correndo pelas ligações
      if (t > nextPulse && links.length && pulses.length < 6) { pulses.push({ l: links[(Math.random() * links.length) | 0], p: 0 }); nextPulse = t + rnd(500, 1400); }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const s = pulses[i]; s.p += 0.035;
        if (s.p >= 1) { pulses.splice(i, 1); continue; }
        const x = s.l[0].x + (s.l[1].x - s.l[0].x) * s.p, y = s.l[0].y + (s.l[1].y - s.l[0].y) * s.p;
        ctx.fillStyle = 'rgba(' + rgb + ',.2)'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 6.2832); ctx.fill();
      }
      // se o aparelho sofrer, reduz sozinho e por fim desliga
      if (++count > 40) { count = 0; slow = (performance.now() - t0) > 7 ? slow + 1 : Math.max(0, slow - 1); }
      if (slow >= 3) { slow = 0; if (nodes.length > 14) nodes.length = Math.floor(nodes.length * .7); else { running = false; cv.remove(); } }
    }
    requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', () => { if (document.hidden) running = false; else if (!running && document.getElementById('fxCanvas')) { running = true; requestAnimationFrame(frame); } });
  }

  // ---- ondinha no clique ----
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest && e.target.closest('.btn'); if (!b || b.disabled) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2, s = document.createElement('span');
    s.className = 'fx-ripple'; s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
    b.appendChild(s); setTimeout(() => s.remove(), 650);
  }, { passive: true });

  // ---- inclinação 3D nos cartões (só com mouse) ----
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    let cur = null, raf = 0, ev = null;
    const SEL = '.room-card, .stat-card, .sala-file-card';
    const apply = () => { raf = 0; if (!cur || !ev) return; const r = cur.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width - .5, y = (ev.clientY - r.top) / r.height - .5;
      cur.style.transform = 'perspective(750px) rotateX(' + (-y * 9).toFixed(2) + 'deg) rotateY(' + (x * 11).toFixed(2) + 'deg) translateZ(6px)'; };
    const reset = () => { if (cur) { cur.style.transform = ''; cur.classList.remove('fx-tilt'); cur = null; } };
    document.addEventListener('pointermove', e => {
      const c = e.target.closest && e.target.closest(SEL);
      if (c !== cur) { reset(); cur = c; if (cur) cur.classList.add('fx-tilt'); }
      if (cur) { ev = e; if (!raf) raf = requestAnimationFrame(apply); }
    }, { passive: true });
    document.addEventListener('pointerleave', reset);
  }

  // ---- números das estatísticas sobem contando ----
  const seen = new WeakMap();
  function countUp(el) {
    const txt = el.textContent.trim(); if (!/^\d+$/.test(txt)) return;
    const to = +txt, from = seen.has(el) ? seen.get(el) : 0; seen.set(el, to);
    if (from === to) return;
    const t0 = performance.now(), dur = 700; el.__anim = 1;
    (function step(t) { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = p < 1 ? Math.round(from + (to - from) * e) : to;
      if (p < 1) requestAnimationFrame(step); else setTimeout(() => { el.__anim = 0; }, 50); })(t0);
  }
  new MutationObserver(ms => { for (const m of ms) { const el = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (el && el.classList && el.classList.contains('stat-value') && !el.__anim) countUp(el); } })
    .observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
