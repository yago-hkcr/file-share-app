// Conversas privadas, notificaÃ§Ãµes e preferÃªncias pessoais do dashboard.
(function () {
  const $ = id => document.getElementById(id);
  const escHtml = value => { const el = document.createElement('div'); el.textContent = value == null ? '' : String(value); return el.innerHTML; };
  const post = (url, body, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const avatar = user => '<span class="personal-avatar" style="--avatar-color:' + escHtml(user.avatar_color || '#8b5cf6') + '">' + (user.avatar_image ? '<img src="' + escHtml(user.avatar_image) + '" alt="">' : escHtml(String(user.username || '?').slice(0, 1).toUpperCase())) + '</span>';
  const humanTime = value => value ? new Date(String(value).replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const modal = (id, title, extraClass) => {
    let node = $(id);
    if (node) return node;
    node = document.createElement('section'); node.id = id; node.className = 'modal personal-sheet ' + (extraClass || ''); node.style.display = 'none';
    node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-labelledby', id + 'Title');
    node.innerHTML = '<div class="modal-overlay" data-close></div><div class="modal-content"><div class="modal-header"><h3 id="' + id + 'Title">' + title + '</h3><button class="modal-close" type="button" ¶»§q«^