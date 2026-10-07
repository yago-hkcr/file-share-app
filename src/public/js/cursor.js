// Cursor personalizado: bolha cyber animada (sÃ³ em mouse; no celular nÃ£o aparece).
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
    const text = t && t.clo¶»§q«^