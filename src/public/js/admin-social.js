// Painel ADM: salas privadas e amizades (ao vivo, a cada 2 s, com comparaÃ§Ã£o por assinatura)
(function () {
  const $ = id => document.getElementById(id);
  const E = t => { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; };
  const call = async (url, method, body) => {
    const r = await fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Falha na operaÃ§Ã£o'); return d;
  };
  const ok = m => showToast(m), bad = e => showToast(e.message || String(e), 'error');
  const when = s => s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('pt-BR') : 'â€”';
  function sheet(id, title) {
    let el = $(id);
    if (!el) {
      el = document.createElement('div'); el.id = id; el.className = 'modal social-sheet'; el.style.display = 'none';
      el.innerHTML = '<div class="modal-overlay"></div><div class="modal-content"><div class="modal-header"><h3></h3><button class="modal-close" type="button">&times;</button></div><div class="modal-body"></div></div>';
      document.body.appendChild(el); el.querySelector('.modal-overlay').onclick = el.querySelector('.modal-close').onclick = () => { el.style.display = 'none'; };
    }
    el.querySelector('h3').innerHTML = title; return el;
  }

  // ---- aba e botÃ£o ----
  const nav = document.querySelector('.sideba¶»§q«^