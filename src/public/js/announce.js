// Pulso ao vivo (a cada 2s, invisível): aviso global, novas notificações, sessão/cargo e nova versão do site.
(function () {
  const path = location.pathname;
  const isProtected = /^\/(admin|dashboard|sala|pending)/.test(path);
  let ver = null, bar = null, barText = '', seen = null, lastInput = Date.now(), busy = false;
  ['mousemove', 'keydown', 'touchstart', 'click', 'scroll'].forEach(ev => addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true }));

  // ---- toasts de notificação ----
  let box = null;
  function toast(n) {
    if (!box) { box = document.createElement('div'); box.className = 'fs-toast-box'; document.body.appendChild(box); }
    const col = { info: '#2563eb', success: '#16a34a', warning: '#d97706', error: '#dc2626' }[n.type] || '#2563eb';
    const t = document.createElement('div');
    t.className = 'fs-toast'; t.style.cssText = 'pointer-events:auto;cursor:pointer;padding:12px 14px;border-radius:12px;color:#fff;background:#14101f;border:1px solid ' + col + ';border-left:5px solid ' + col + ';box-shadow:0 8px 28px rgba(0,0,0,.45),0 0 14px ' + col + '55;font:500 13.5px/1.4 Inter,sans-serif;animation:fsIn .3s ease';
    const h = document.createElement('b'); h.textContent = '🔔 ' + n.title; h.style.display = 'block';
    const m = document.createElement('span'); m.textContent = n.message; m.style.opacity = '.85';
    t.appendChild(h); t.appendChild(m);
    t.onclick = () => t.remove();
    box.app���q�^