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
    box.appendChild(t); setTimeout(() => t.remove(), 7000);
  }
  const css = document.createElement('style'); css.textContent = '@keyframes fsIn{from{opacity:0;transform:translate3d(30px,0,0)}to{opacity:1;transform:none}}'; document.head.appendChild(css);

  // ---- faixa de aviso ----
  const colors = { info: '#2563eb', success: '#16a34a', warning: '#d97706', error: '#dc2626' };
  function dismissed(text) { try { return sessionStorage.getItem('fs_ann_' + text) === '1'; } catch (e) { return false; } }
  function renderBar(a) {
    const text = a && a.text ? a.text : '';
    if (!text || dismissed(text)) { if (bar) { bar.remove(); bar = null; barText = ''; } return; }
    if (bar && barText === text) { bar.style.background = colors[a.type] || colors.info; return; }
    if (bar) bar.remove();
    barText = text;
    bar = document.createElement('div');
    bar.style.cssText = 'position:relative;z-index:1500;padding:10px 44px 10px 16px;color:#fff;font:600 14px/1.35 Inter,sans-serif;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.25);animation:fsIn .3s ease;background:' + (colors[a.type] || colors.info);
    const s = document.createElement('span'); s.textContent = '📢 ' + text; bar.appendChild(s);
    const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', 'Fechar aviso');
    x.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1';
    x.onclick = () => { try { sessionStorage.setItem('fs_ann_' + text, '1'); } catch (e) {} bar.remove(); bar = null; barText = ''; };
    bar.appendChild(x);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // ---- recarregar só quando é seguro (nada sendo digitado/enviado) ----
  function safeToReload() {
    if (window.__fsBusy > 0) return false;
    if (Date.now() - lastInput < 6000) return false;
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && (a.value || '').length) return false;
    const open = Array.from(document.querySelectorAll('.modal, .rename-modal')).some(m => m.offsetParent !== null || getComputedStyle(m).display !== 'none');
    return !open;
  }

  async function tick() {
    if (document.hidden || busy) return;
    busy = true;
    try {
      const r = await fetch('/api/live', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      // nova versão publicada
      if (j.v) { if (ver === null) ver = j.v; else if (j.v !== ver && safeToReload()) { location.reload(); return; } }
      if (isProtected) {
        if (!j.auth) { location.href = '/'; return; }
        if (/^\/admin/.test(path) && j.role !== 'admin') { location.href = '/dashboard'; return; }
        if (/^\/(dashboard|sala)/.test(path) && j.role !== 'admin' && j.status !== 'approved') { location.href = '/pending'; return; }
      }
      if (j.auth) {
        renderBar(j.ann);
        const ids = (j.latest || []).map(n => n.id);
        if (seen === null) seen = new Set(ids);
        else (j.latest || []).slice().reverse().forEach(n => { if (!seen.has(n.id)) { seen.add(n.id); toast(n); } });
      } else renderBar(null);
    } catch (e) { /* tenta de novo em 2s */ }
    finally { busy = false; }
  }
  setInterval(tick, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
})();
