// Faixa de aviso global (definida pelo ADM). Aparece no topo para todos os usuários logados.
(function () {
  fetch('/api/announcement').then(r => r.ok ? r.json() : null).then(a => {
    if (!a || !a.text) return;
    const key = 'fs_ann_' + a.text.length + '_' + a.text.slice(0, 20);
    try { if (sessionStorage.getItem(key)) return; } catch (e) {}
    const colors = { info: '#2563eb', success: '#16a34a', warning: '#d97706', error: '#dc2626' };
    const bar = document.createElement('div');
    bar.style.cssText = 'position:relative;z-index:1500;padding:10px 44px 10px 16px;color:#fff;font:600 14px/1.35 Inter,sans-serif;text-align:center;background:' + (colors[a.type] || colors.info) + ';box-shadow:0 2px 12px rgba(0,0,0,.25)';
    const t = document.createElement('span'); t.textContent = '📢 ' + a.text; bar.appendChild(t);
    const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', 'Fechar aviso');
    x.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1';
    x.onclick = () => { bar.remove(); try { sessionStorage.setItem(key, '1'); } catch (e) {} };
    bar.appendChild(x);
    document.body.insertBefore(bar, document.body.firstChild);
  }).catch(() => {});
})();
