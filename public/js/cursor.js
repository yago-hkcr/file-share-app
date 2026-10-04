// Cursor personalizado: bolha cyber animada (só em mouse; no celular não aparece).
(function () {
  if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('has-bubble');

  const bubble = document.createElement('div');
  bubble.className = 'cy-bubble';
  bubble.innerHTML = '<span class="cy-b-ring"></span><span class="cy-b-shine"></span>';
  const dot = document.createElement('div');
  dot.className = 'cy-dot';
  const add = () => { document.body.appendChild(bubble); document.body.appendChild(dot); };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);

  let mx = -100, my = -100, bx = -100, by = -100, shown = false, lastTrail = 0;
  const html = document.documentElement;

  window.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    dot.style.transform = 'translate(' + mx + 'px,' + my + 'px)';
    if (!shown) { shown = true; bx = mx; by = my; html.classList.add('bubble-on'); }
    const now = performance.now();
    if (!reduce && now - lastTrail > 55) { lastTrail = now; trail(mx, my); }
    const t = e.target && e.target.closest ? e.target : null;
    const link = t && t.closest('a, button, label, summary, [role="button"], .btn, select, input[type="checkbox"], input[type="radio"], input[type="file"]');
    const text = t && t.closest('input:not([type]), input[type="text"], input[type="password"], input[type="email"], input[type="search"], textarea');
    bubble.classList.toggle('is-link', !!link && !text);
    bubble.classList.toggle('is-text', !!text);
  }, { passive: true });
  document.addEventListener('mouseleave', () => { shown = false; html.classList.remove('bubble-on'); });
  document.addEventListener('mouseenter', () => { html.classList.add('bubble-on'); shown = true; });
  window.addEventListener('mousedown', e => {
    bubble.classList.add('is-down');
    if (reduce) return;
    const r = document.createElement('span');
    r.className = 'cy-ripple';
    r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 650);
  });
  window.addEventListener('mouseup', () => bubble.classList.remove('is-down'));

  function trail(x, y) {
    const p = document.createElement('span');
    p.className = 'cy-trail';
    const s = 4 + Math.random() * 7;
    p.style.cssText = 'left:' + (x + (Math.random() * 10 - 5)) + 'px;top:' + (y + (Math.random() * 10 - 5)) + 'px;width:' + s + 'px;height:' + s + 'px';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 800);
  }

  (function loop() {
    const k = reduce ? 1 : 0.18;
    bx += (mx - bx) * k; by += (my - by) * k;
    bubble.style.transform = 'translate(' + bx + 'px,' + by + 'px)';
    requestAnimationFrame(loop);
  })();
})();
