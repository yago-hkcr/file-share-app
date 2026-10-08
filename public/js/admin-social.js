// Painel ADM: salas privadas e amizades (ao vivo, a cada 2 s, com comparação por assinatura)
(function () {
  const $ = id => document.getElementById(id);
  const E = t => { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; };
  const call = async (url, method, body) => {
    const r = await fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Falha na operação'); return d;
  };
  const ok = m => showToast(m), bad = e => showToast(e.message || String(e), 'error');
  const when = s => s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('pt-BR') : '—';
  function sheet(id, title) {
    let el = $(id);
    if (!el) {
      el = document.createElement('div'); el.id = id; el.className = 'modal social-sheet'; el.style.display = 'none';
      el.innerHTML = '<div class="modal-overlay"></div><div class="modal-content"><div class="modal-header"><h3></h3><button class="modal-close" type="button">&times;</button></div><div class="modal-body"></div></div>';
      document.body.appendChild(el); el.querySelector('.modal-overlay').onclick = el.querySelector('.modal-close').onclick = () => { el.style.display = 'none'; };
    }
    el.querySelector('h3').innerHTML = title; return el;
  }

  // ---- aba e botão ----
  const nav = document.querySelector('.sidebar') || document.querySelector('nav');
  const btn = document.createElement('button'); btn.className = 'nav-item'; btn.id = 'navSocial';
  btn.innerHTML = '<i class="fas fa-user-lock"></i> Salas privadas e amizades'; btn.onclick = () => showTab('social');
  nav.appendChild(btn);
  const tab = document.createElement('div'); tab.id = 'tab-social'; tab.className = 'tab-content';
  tab.innerHTML =
    '<h2><i class="fas fa-user-lock"></i> Salas privadas e amizades</h2>' +
    '<div class="soc-box card"><h3><i class="fas fa-lock"></i> Salas privadas <span class="soc-meta" id="prCount"></span></h3>' +
    '<div class="soc-bar"><input id="prSearch" type="text" placeholder="Buscar sala, dono ou membro"><select id="prOwner"><option value="">Todos os donos</option></select></div><div id="prList"></div></div>' +
    '<div class="soc-box card"><h3><i class="fas fa-user-group"></i> Amizades e pedidos <span class="soc-meta" id="frCount"></span></h3>' +
    '<div class="soc-bar"><input id="frSearch" type="text" placeholder="Buscar por nome"></div>' +
    '<div class="soc-bar"><input id="frA" type="text" placeholder="Conta A"><input id="frB" type="text" placeholder="Conta B"><button class="btn btn-primary" id="frMake"><i class="fas fa-link"></i> Criar amizade</button></div><div id="frList"></div></div>';
  (document.getElementById('tab-rooms') || document.querySelector('.main-content')).parentNode.appendChild(tab);

  const _show = window.showTab;
  window.showTab = function (name) {
    if (name === 'social') {
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      tab.classList.add('active'); btn.classList.add('active'); sig.pr = sig.fr = ''; refresh();
    } else { btn.classList.remove('active'); _show(name); }
  };

  // ---- dados ao vivo ----
  const sig = { pr: '', fr: '' }; let PR = [], FR = [];
  function paintRooms() {
    const q = $('prSearch').value.trim().toLowerCase(), owner = $('prOwner').value;
    const owners = [...new Map(PR.map(r => [r.created_by, r.owner_name || '—'])).entries()];
    const sel = $('prOwner'), optSig = owners.map(o => o.join(':')).join('|');
    if (sel.dataset.sig !== optSig) { const cur = sel.value; sel.innerHTML = '<option value="">Todos os donos</option>' + owners.map(([id, n]) => '<option value="' + E(id) + '">' + E(n) + '</option>').join(''); sel.value = cur; sel.dataset.sig = optSig; }
    const list = PR.filter(r => (!owner || r.created_by === owner) && (!q || (r.name + ' ' + (r.owner_name || '') + ' ' + r.members.map(m => m.username).join(' ')).toLowerCase().includes(q)));
    $('prCount').textContent = '(' + list.length + ' de ' + PR.length + ')';
    $('prList').innerHTML = list.length ? list.map(r => '<div class="soc-row" style="flex-wrap:wrap"><span class="grow" style="white-space:normal"><i class="fas fa-lock"></i> ' + E(r.name) + '<br><span class="soc-meta">Dono: ' + E(r.owner_name || '—') + ' · ' + r.members.length + ' membro(s) · ' + r.files + ' arquivo(s) · ' + r.msgs + ' msg · ' + when(r.created_at) + '</span></span>' +
      '<button class="btn btn-outline btn-sm" data-a="edit" data-id="' + r.id + '"><i class="fas fa-pen"></i> Editar</button><button class="btn btn-outline btn-sm" data-a="members" data-id="' + r.id + '"><i class="fas fa-users"></i> Membros</button><button class="btn btn-outline btn-sm" data-a="chat" data-id="' + r.id + '"><i class="fas fa-comments"></i> Chat</button><button class="btn btn-outline btn-danger btn-sm" data-a="del" data-id="' + r.id + '"><i class="fas fa-trash"></i></button></div>').join('') : '<p class="text-muted">Nenhuma sala privada encontrada.</p>';
  }
  function paintFriends() {
    $('frCount').textContent = '(' + FR.length + ')';
    $('frList').innerHTML = FR.length ? FR.map(f => '<div class="soc-row"><span class="grow" style="white-space:normal">' + E(f.requester) + ' → ' + E(f.addressee) + ' <span class="badge ' + (f.status === 'accepted' ? 'badge-green' : 'badge-yellow') + '">' + (f.status === 'accepted' ? 'Amigos' : 'Pendente') + '</span><br><span class="soc-meta">' + when(f.created_at) + '</span></span>' +
      (f.status !== 'accepted' ? '<button class="btn btn-primary btn-sm" data-fa="accept" data-id="' + f.id + '">Forçar aceite</button>' : '') + '<button class="btn btn-outline btn-danger btn-sm" data-fa="del" data-id="' + f.id + '">Remover</button></div>').join('') : '<p class="text-muted">Nenhuma amizade encontrada.</p>';
  }
  let refreshing = false;
  async function refresh() {
    if (document.hidden || refreshing) return;
    refreshing = true;
    try {
      const [pr, fr] = await Promise.all([call('/api/admin/private-rooms'), call('/api/admin/friendships?q=' + encodeURIComponent($('frSearch').value.trim()))]);
      const s1 = JSON.stringify(pr), s2 = JSON.stringify(fr);
      if (s1 !== sig.pr) { sig.pr = s1; PR = pr; paintRooms(); }
      if (s2 !== sig.fr) { sig.fr = s2; FR = fr; paintFriends(); }
    } catch (e) { /* tenta de novo */ }
    finally { refreshing = false; }
  }
  setInterval(refresh, 2000);
  $('prSearch').addEventListener('input', paintRooms); $('prOwner').addEventListener('change', paintRooms);
  $('frSearch').addEventListener('input', () => { sig.fr = ''; refresh(); });
  $('frMake').onclick = async () => { try { await call('/api/admin/friendships', 'POST', { a: $('frA').value, b: $('frB').value }); $('frA').value = $('frB').value = ''; ok('Amizade criada'); sig.fr = ''; refresh(); } catch (e) { bad(e); } };
  $('frList').onclick = async e => {
    const b = e.target.closest('button[data-fa]'); if (!b) return;
    try {
      if (b.dataset.fa === 'accept') await call('/api/admin/friendships/' + b.dataset.id + '/accept', 'POST');
      else { if (!confirm('Remover esta amizade/pedido?')) return; await call('/api/admin/friendships/' + b.dataset.id, 'DELETE'); }
      ok('Feito'); sig.fr = ''; refresh();
    } catch (er) { bad(er); }
  };
  window.admRemoveFriendship = async id => { if (!confirm('Remover esta amizade/pedido?')) return; try { await call('/api/admin/friendships/' + id, 'DELETE'); ok('Removida'); sig.fr = ''; } catch (e) { bad(e); } };
  window.admAcceptFriendship = async id => { try { await call('/api/admin/friendships/' + id + '/accept', 'POST'); ok('Aceita'); sig.fr = ''; } catch (e) { bad(e); } };

  // ---- ações nas salas ----
  const room = id => PR.find(r => r.id === id);
  $('prList').onclick = async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return; const r = room(b.dataset.id); if (!r) return;
    if (b.dataset.a === 'del') { if (!confirm('Excluir a sala "' + r.name + '" com arquivos e chat?')) return; try { await call('/api/rooms/' + r.id, 'DELETE'); ok('Sala excluída'); sig.pr = ''; refresh(); } catch (er) { bad(er); } }
    else if (b.dataset.a === 'edit') editRoom(r); else if (b.dataset.a === 'members') membersRoom(r.id); else chatRoom(r);
  };
  function editRoom(r) {
    const s = sheet('admEdit', '<i class="fas fa-pen"></i> Editar sala'), body = s.querySelector('.modal-body');
    body.innerHTML = '<div class="soc-add"><input id="aeName" type="text" maxlength="60" value="' + E(r.name) + '"><button class="btn btn-primary" id="aeSave">Salvar nome</button></div>' +
      '<div class="soc-title">Visibilidade</div><div class="soc-bar"><button class="btn btn-outline" data-m="private">Privada</button><button class="btn btn-outline" data-m="public">Pública</button><button class="btn btn-outline" data-m="temporary">Temporária 30 min</button></div>' +
      '<div class="soc-title">Trocar dono</div><div class="soc-add"><select id="aeOwner"></select><button class="btn btn-primary" id="aeOwnerBtn">Trocar</button></div>';
    s.style.display = 'flex';
    call('/api/admin/users').then(us => { $('aeOwner').innerHTML = us.filter(u => u.status === 'approved' || u.role === 'admin').map(u => '<option value="' + E(u.id) + '"' + (u.id === r.created_by ? ' selected' : '') + '>' + E(u.username) + '</option>').join(''); }).catch(bad);
    $('aeSave').onclick = async () => { try { await call('/api/rooms/' + r.id, 'PATCH', { name: $('aeName').value }); ok('Nome salvo'); sig.pr = ''; refresh(); } catch (e) { bad(e); } };
    $('aeOwnerBtn').onclick = async () => { try { await call('/api/admin/rooms/' + r.id + '/owner', 'POST', { userId: $('aeOwner').value }); ok('Dono trocado'); sig.pr = ''; refresh(); } catch (e) { bad(e); } };
    body.querySelectorAll('[data-m]').forEach(x => x.onclick = async () => { try { await call('/api/admin/rooms/' + r.id + '/visibility', 'POST', { mode: x.dataset.m }); ok('Visibilidade alterada'); s.style.display = 'none'; sig.pr = ''; refresh(); } catch (e) { bad(e); } });
  }
  async function membersRoom(id) {
    const s = sheet('admMembers', '<i class="fas fa-users"></i> Membros'), body = s.querySelector('.modal-body'); s.style.display = 'flex';
    async function paint() {
      const [prs, us] = await Promise.all([call('/api/admin/private-rooms'), call('/api/admin/users')]); const r = prs.find(x => x.id === id); if (!r) { s.style.display = 'none'; return; }
      const inRoom = new Set(r.members.map(m => m.id));
      body.innerHTML = '<div class="soc-title">Na sala</div>' + r.members.map(m => '<div class="soc-row"><span class="avatar avatar-sm" style="background:' + E(m.avatar_color || '#8b5cf6') + '">' + (m.avatar_image ? '<img src="' + E(m.avatar_image) + '" alt="">' : E((m.username || '?')[0].toUpperCase())) + '</span><span class="grow">' + E(m.username) + (m.id === r.created_by ? ' (dono)' : '') + '</span>' + (m.id === r.created_by ? '' : '<button class="btn btn-outline btn-danger btn-sm" data-rm="' + m.id + '">Remover</button>') + '</div>').join('') +
        '<div class="soc-title">Adicionar (sem precisar ser amigo)</div><div class="soc-add"><select id="amSel">' + us.filter(u => !inRoom.has(u.id) && (u.status === 'approved' || u.role === 'admin')).map(u => '<option value="' + E(u.id) + '">' + E(u.username) + '</option>').join('') + '</select><button class="btn btn-primary" id="amAdd">Adicionar</button></div>';
      body.querySelectorAll('[data-rm]').forEach(x => x.onclick = async () => { try { await call('/api/rooms/' + id + '/private-members/' + x.dataset.rm, 'DELETE'); ok('Removido'); sig.pr = ''; paint(); } catch (e) { bad(e); } });
      $('amAdd').onclick = async () => { try { await call('/api/rooms/' + id + '/private-members', 'POST', { userId: $('amSel').value }); ok('Adicionado'); sig.pr = ''; paint(); } catch (e) { bad(e); } };
    }
    paint().catch(bad);
  }
  async function chatRoom(r) {
    const s = sheet('admChat', '<i class="fas fa-comments"></i> Chat · ' + E(r.name)), body = s.querySelector('.modal-body'); s.style.display = 'flex';
    async function paint() {
      const ms = await call('/api/rooms/' + r.id + '/messages');
      body.innerHTML = '<div class="soc-chat">' + (ms.length ? ms.map(m => '<div class="soc-row"><span class="avatar avatar-sm" style="background:' + E(m.avatar_color || '#8b5cf6') + '">' + (m.avatar_image ? '<img src="' + E(m.avatar_image) + '" alt="">' : E((m.username || '?')[0].toUpperCase())) + '</span><span class="grow" style="white-space:normal"><b>' + E(m.username) + '</b> ' + E(m.content) + '<br><span class="soc-meta">' + when(m.created_at) + '</span></span><button class="btn btn-outline btn-danger btn-sm" data-dm="' + m.id + '"><i class="fas fa-trash"></i></button></div>').join('') : '<p class="text-muted">Sem mensagens.</p>') + '</div>';
      body.querySelectorAll('[data-dm]').forEach(x => x.onclick = async () => { try { await call('/api/admin/messages/' + x.dataset.dm, 'DELETE'); ok('Mensagem excluída'); paint(); } catch (e) { bad(e); } });
    }
    paint().catch(bad);
  }
  window.admRoomMembers = id => membersRoom(id);
})();
