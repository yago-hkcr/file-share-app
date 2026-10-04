// Dashboard do usuário: amigos, salas privadas e membros (atualização a cada 2 s)
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
  const avatar = u => '<span class="avatar" style="background:' + esc(u.avatar_color || '#8b5cf6') + '">' + esc(String(u.username || '?')[0].toUpperCase()) + '</span>';
  const admTag = r => r === 'admin' ? '<span class="adm-tag">ADM</span>' : '';

  // ---------------- AMIGOS ----------------
  let F = { friends: [], incoming: [], outgoing: [] }, fSig = '', known = null;
  const friendsSheet = sheet('friendsSheet', '<i class="fas fa-user-group"></i> Amigos');
  friendsSheet.querySelector('.modal-body').innerHTML =
    '<div class="soc-add"><input id="friendName" type="text" maxlength="60" placeholder="Adicionar amigo pelo nome da conta" autocomplete="off"><button class="btn btn-primary" id="friendSend" type="button"><i class="fas fa-user-plus"></i> Enviar pedido</button></div><div id="friendLists"></div>';
  function paintFriends() {
    const row = (u, acts) => '<div class="soc-row">' + avatar(u) + '<span class="grow">' + esc(u.username) + admTag(u.role) + '</span>' + acts + '</div>';
    const list = (arr, fn) => arr.length ? arr.map(fn).join('') : '<div class="soc-empty">Nada por aqui.</div>';
    $('friendLists').innerHTML =
      '<div class="soc-title">Pedidos recebidos <span class="soc-count">' + F.incoming.length + '</span></div>' +
      list(F.incoming, u => row(u, '<button class="btn btn-primary" onclick="friendAccept(\'' + u.id + '\')">Aceitar</button><button class="btn btn-outline" onclick="friendRemove(\'' + u.id + '\',\'Recusar este pedido?\')">Recusar</button>')) +
      '<div class="soc-title">Pedidos enviados <span class="soc-count">' + F.outgoing.length + '</span></div>' +
      list(F.outgoing, u => row(u, '<button class="btn btn-outline" onclick="friendRemove(\'' + u.id + '\',\'Cancelar o pedido?\')">Cancelar</button>')) +
      '<div class="soc-title">Meus amigos <span class="soc-count">' + F.friends.length + '</span></div>' +
      list(F.friends, u => '<div class="soc-row"><span class="online-dot ' + (u.online ? 'on' : '') + '" title="' + (u.online ? 'Online' : 'Offline') + '"></span>' + avatar(u) + '<span class="grow">' + esc(u.username) + admTag(u.role) + '</span><button class="btn btn-outline btn-danger" onclick="friendRemove(\'' + u.id + '\',\'Remover ' + esc(u.username).replace(/'/g, '') + ' dos amigos? Ele também sai das suas salas privadas.\')">Remover</button></div>');
  }
  function badge() {
    const b = $('friendsBtn'); if (!b) return;
    b.querySelector('.soc-count') && b.querySelector('.soc-count').remove();
    if (F.incoming.length) b.insertAdjacentHTML('beforeend', ' <span class="soc-count">' + F.incoming.length + '</span>');
  }
  async function pollFriends() {
    if (document.hidden) return;
    try {
      const d = await api('/api/friends'); const sig = JSON.stringify(d);
      const ids = d.incoming.map(x => x.id);
      if (known !== null) d.incoming.filter(x => !known.includes(x.id)).forEach(x => toast(x.username + ' enviou um pedido de amizade', 'info'));
      known = ids;
      if (sig === fSig) return; fSig = sig; F = d; badge();
      if (friendsSheet.style.display !== 'none') paintFriends();
    } catch (e) { /* tenta de novo */ }
  }
  window.friendAccept = async id => { try { await send('/api/friends/' + id + '/accept'); toast('Amizade aceita'); fSig = ''; pollFriends(); } catch (e) { toast(e.message, 'error'); } };
  window.friendRemove = async (id, msg) => { if (!confirm(msg)) return; try { await remove('/api/friends/' + id); fSig = ''; pollFriends(); } catch (e) { toast(e.message, 'error'); } };
  async function sendRequest() {
    const input = $('friendName'), name = input.value.trim(); if (!name) return toast('Digite o nome da conta', 'error');
    try { const r = await send('/api/friends/request', { username: name }); input.value = ''; toast(r.accepted ? 'Agora vocês são amigos!' : 'Pedido enviado para ' + r.username); fSig = ''; pollFriends(); }
    catch (e) { toast(e.message, 'error'); }
  }
  $('friendSend').onclick = sendRequest;
  $('friendName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendRequest(); } });
  window.showFriends = () => { friendsSheet.style.display = 'flex'; paintFriends(); pollFriends(); };

  // botões no topo
  const actions = document.querySelector('.intro-actions');
  if (actions) {
    actions.insertAdjacentHTML('afterbegin', '<button id="friendsBtn" class="btn btn-outline" onclick="showFriends()"><i class="fas fa-user-group"></i> Amigos</button>');
    const nb = $('newRoomBtn'); if (nb) nb.innerHTML = '<i class="fas fa-plus"></i> Nova sala';
  }

  // ---------------- NOVA SALA: pública temporária ou privada ----------------
  let roomType = 'temp';
  const cm = $('createRoomModal');
  if (cm) {
    const body = cm.querySelector('.modal-body');
    body.insertAdjacentHTML('afterbegin', '<div class="type-pick" id="typePick"><button type="button" data-t="temp" class="active"><i class="fas fa-hourglass-half"></i> Pública temporária</button><button type="button" data-t="private"><i class="fas fa-lock"></i> Privada</button></div><p id="privHint" class="text-muted" style="display:none;font-size:13px"><i class="fas fa-lock"></i> Só você e os amigos que adicionar veem a sala. Não expira. Limite de 5 salas privadas.</p>');
    const dur = $('durationPick').closest('.form-group'), hint = body.querySelector('p.text-muted:not(#privHint)');
    $('typePick').addEventListener('click', e => {
      const b = e.target.closest('button[data-t]'); if (!b) return; roomType = b.dataset.t;
      document.querySelectorAll('#typePick button').forEach(x => x.classList.toggle('active', x === b));
      dur.style.display = hint && roomType === 'private' ? 'none' : ''; if (hint) hint.style.display = roomType === 'private' ? 'none' : ''; $('privHint').style.display = roomType === 'private' ? '' : 'none';
    });
    const h = cm.querySelector('.modal-header h3'); if (h) h.innerHTML = '<i class="fas fa-plus"></i> Nova sala';
    const sb = cm.querySelector('[onclick*="createTempRoom"]'); if (sb) sb.innerHTML = '<i class="fas fa-check"></i> Criar sala';
  }
  window.createTempRoom = async function () {
    const name = $('newRoomName').value.trim(); if (!name) return toast('Dê um nome para a sala', 'error');
    const priv = roomType === 'private';
    try {
      const room = await send('/api/rooms', priv ? { name, type: 'private' } : { name, duration_minutes: newRoomMinutes });
      $('newRoomName').value = ''; closeCreateRoom(); toast(priv ? 'Sala privada criada!' : 'Sala criada! Ela some em ' + newRoomMinutes + ' min');
      lastRoomsSig = ''; await loadRooms(); openRoom(room.id, room.name);
    } catch (e) { toast(e.message, 'error'); }
  };

  // ---------------- FERRAMENTAS DA SALA (dono / ADM) ----------------
  const _open = window.openRoom;
  window.openRoom = async function (id, name) { await _open(id, name); roomTools(); };
  function roomTools() {
    const r = (window.roomsById || {})[currentRoom], bar = document.querySelector('#roomModal .room-head-btns'); if (!bar) return;
    const old = $('roomTools'); if (old) old.remove();
    const lb = $('leaveRoomBtn');
    if (!r || !r.can_manage) return;
    if (r.is_owner && !r.is_public && lb) lb.style.display = 'none';
    bar.insertAdjacentHTML('afterbegin', '<span id="roomTools" class="room-tools"><button class="btn btn-sm btn-outline" onclick="openMembers()"><i class="fas fa-user-plus"></i> Membros</button><button class="btn btn-sm btn-outline" onclick="renameRoom()"><i class="fas fa-pen"></i> Renomear</button><button class="btn btn-sm btn-outline btn-danger" onclick="deleteRoom()"><i class="fas fa-trash"></i> Excluir</button></span>');
  }
  window.renameRoom = async function () {
    const r = (window.roomsById || {})[currentRoom]; if (!r) return;
    const name = prompt('Novo nome da sala:', r.name); if (name === null || !name.trim()) return;
    try { await send('/api/rooms/' + currentRoom, { name: name.trim() }, 'PATCH'); $('roomModalTitle').textContent = name.trim(); toast('Sala renomeada'); lastRoomsSig = ''; loadRooms(); } catch (e) { toast(e.message, 'error'); }
  };
  window.deleteRoom = async function () {
    if (!confirm('Excluir esta sala com todos os arquivos e o chat? Não dá para desfazer.')) return;
    try { await remove('/api/rooms/' + currentRoom); toast('Sala excluída'); closeRoom(); lastRoomsSig = ''; loadRooms(); } catch (e) { toast(e.message, 'error'); }
  };
  const _leave = window.leaveRoom;
  window.leaveRoom = async function (id) {
    const r = (window.roomsById || {})[id];
    if (r && r.is_owner && !r.is_public && !(me && me.role === 'admin')) {
      if (!confirm('Você é o dono. Se sair, a sala, os arquivos e o chat serão apagados. Continuar?')) return;
      try { await send('/api/rooms/' + id + '/leave'); toast('Sala excluída'); lastRoomsSig = ''; loadRooms(); } catch (e) { toast(e.message, 'error'); } return;
    }
    return _leave(id);
  };

  // ---------------- MEMBROS DA SALA PRIVADA ----------------
  const memSheet = sheet('membersSheet', '<i class="fas fa-users"></i> Membros da sala');
  memSheet.querySelector('.modal-body').innerHTML = '<div class="soc-add"><input id="memSearch" type="text" placeholder="Buscar amigo pelo nome" autocomplete="off"></div><div id="memLists"></div>';
  let MD = null, mSig = '';
  function paintMembers() {
    if (!MD) return; const q = $('memSearch').value.trim().toLowerCase();
    const inRoom = new Set(MD.room.members.map(m => m.id));
    const avail = MD.friends.friends.filter(f => !inRoom.has(f.user_id) && f.username.toLowerCase().includes(q));
    const canRemove = m => m.id !== MD.room.created_by;
    $('memLists').innerHTML =
      '<div class="soc-title">Na sala <span class="soc-count">' + MD.room.members.length + '</span></div>' +
      MD.room.members.map(m => '<div class="soc-row">' + avatar(m) + '<span class="grow">' + esc(m.username) + admTag(m.role) + (m.id === MD.room.created_by ? ' <span class="badge badge-blue"><i class="fas fa-crown"></i> Dono</span>' : '') + '</span>' + (canRemove(m) ? '<button class="btn btn-outline btn-danger" onclick="memRemove(\'' + m.id + '\')">Remover</button>' : '') + '</div>').join('') +
      '<div class="soc-title">Seus amigos fora da sala</div>' +
      (avail.length ? avail.map(f => '<div class="soc-row"><span class="online-dot ' + (f.online ? 'on' : '') + '"></span>' + avatar(f) + '<span class="grow">' + esc(f.username) + admTag(f.role) + '</span><button class="btn btn-primary" onclick="memAdd(\'' + f.user_id + '\')"><i class="fas fa-plus"></i> Adicionar</button></div>').join('') : '<div class="soc-empty">' + (MD.friends.friends.length ? 'Nenhum amigo encontrado.' : 'Você ainda não tem amigos. Adicione pelo botão Amigos.') + '</div>');
  }
  async function loadMembers() {
    if (!currentRoom) return;
    try {
      const [rooms, friends] = await Promise.all([api('/api/rooms'), api('/api/friends')]);
      const room = rooms.find(r => r.id === currentRoom); if (!room) return;
      const sig = JSON.stringify([room.members, friends.friends]); if (sig === mSig) return; mSig = sig; MD = { room, friends }; paintMembers();
    } catch (e) { /* tenta de novo */ }
  }
  $('memSearch').addEventListener('input', paintMembers);
  window.openMembers = () => { mSig = ''; MD = null; $('memLists').innerHTML = ''; $('memSearch').value = ''; memSheet.style.display = 'flex'; loadMembers(); };
  window.memAdd = async uid => { try { await send('/api/rooms/' + currentRoom + '/private-members', { userId: uid }); toast('Amigo adicionado'); mSig = ''; lastRoomsSig = ''; loadMembers(); } catch (e) { toast(e.message, 'error'); } };
  window.memRemove = async uid => { if (!confirm('Remover este membro da sala?')) return; try { await remove('/api/rooms/' + currentRoom + '/private-members/' + uid); toast('Membro removido'); mSig = ''; lastRoomsSig = ''; loadMembers(); } catch (e) { toast(e.message, 'error'); } };

  document.addEventListener('keydown', e => { if (e.key === 'Escape') ['friendsSheet', 'membersSheet'].forEach(id => { const m = $(id); if (m) m.style.display = 'none'; }); });
  setInterval(() => { pollFriends(); if (memSheet.style.display !== 'none') loadMembers(); }, 2000);
  pollFriends();
})();
