// Dashboard do usuÃ¡rio: amigos, salas privadas e membros (atualizaÃ§Ã£o a cada 2 s)
(function () {
  const $ = id => document.getElementById(id);
  const send = (url, body, method) => api(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const remove = url => api(url, { method: 'DELETE' });
  function sheet(id, title) {
    let el = $(id);
    if (!el) {
      el = document.createElement('div'); el.id = id; el.className = 'modal social-sheet'; el.style.display = 'none';
      el.innerHTML = '<div class="modal-overlay"></div><div class="modal-content"><div class="modal-header"><h3>' + title + '</h3><button class="modal-close" type="button">&times;</button></div><div class="modal-body"></div></div>';
      document.body.appendChild(el);
      el.querySelector('.modal-overlay').onclick = el.querySelector('.modal-close').onclick = () => { el.style.display = 'none'; };
    }
    return el;
  }
  const avatar = u => '<span class="avatar" style="background:' + esc(u.avatar_color || '#8b5cf6') + '">' + (u.avatar_image ? '<img src="' + esc(u.avatar_image) + '" alt="Foto de ' + esc(u.username || 'usuÃ¡rio') + '">' : esc(String(u.username || '?')[0].toUpperCase())) + '</span>';
  const admTag = r => r === 'admin' ? '<span class="adm-tag">ADM</span>' : '';

  // ---------------- AMIGOS ----------------
  let F = { friends: [], incoming: [], outgoing: [] }, fSig = '', known = null;
  const friendsSheet = sheet('frien¶»§q«^