// Conversas privadas, notificações e preferências pessoais do dashboard.
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
    node.innerHTML = '<div class="modal-overlay" data-close></div><div class="modal-content"><div class="modal-header"><h3 id="' + id + 'Title">' + title + '</h3><button class="modal-close" type="button" data-close aria-label="Fechar">&times;</button></div><div class="modal-body"></div></div>';
    document.body.appendChild(node);
    node.addEventListener('click', event => { if (event.target.closest('[data-close]')) node.style.display = 'none'; });
    return node;
  };
  const open = el => { el.style.display = 'flex'; const focusable = el.querySelector('button:not([data-close]), input:not([type=file]), select, textarea'); if (focusable) setTimeout(() => focusable.focus(), 50); };

  // Atalhos no painel principal.
  const actions = document.querySelector('.intro-actions');
  if (actions) actions.insertAdjacentHTML('afterbegin',
    '<button class="btn btn-outline" id="directMessagesBtn" type="button"><i class="fas fa-message"></i> Conversas</button>' +
    '<button class="btn btn-outline personal-notice-button" id="notificationsBtn" type="button"><i class="fas fa-bell"></i> Avisos<span class="personal-count" id="notificationCount" hidden></span></button>' +
    '<button class="btn btn-outline" id="personalSettingsBtn" type="button"><i class="fas fa-sliders"></i> Configurações</button>');

  // Conversas diretas entre amigos.
  const dm = modal('directMessagesSheet', '<i class="fas fa-message"></i> Conversas', 'direct-sheet');
  dm.querySelector('.modal-content').classList.add('direct-modal-content');
  dm.querySelector('.modal-body').innerHTML = '<div class="direct-layout"><aside class="direct-sidebar"><div class="personal-subtitle">Amigos</div><div id="directFriendList" class="direct-friend-list"><div class="soc-empty">Carregando amigos…</div></div></aside><section class="direct-thread"><div id="directThreadHeading" class="direct-thread-heading"><span class="soc-empty">Escolha um amigo para começar uma conversa.</span></div><div id="directMessageList" class="direct-message-list" aria-live="polite"></div><div id="directReplyPreview" class="reply-preview" hidden><span><b>Respondendo a <span id="directReplyName"></span></b><span id="directReplyText"></span></span><button class="btn btn-outline" type="button" id="directReplyCancel" aria-label="Cancelar resposta"><i class="fas fa-xmark"></i></button></div><form id="directMessageForm" class="chat-compose direct-compose" autocomplete="off"><input id="directMessageInput" type="text" maxlength="1000" placeholder="Escreva uma mensagem…" aria-label="Mensagem" disabled><button class="btn btn-primary chat-send" type="submit" aria-label="Enviar mensagem" disabled><i class="fas fa-paper-plane"></i></button></form></section></div>';
  let dmFriends = [], activeFriend = null, lastDmSig = '', dmReply = null, initialDm = true, dmAvatarsLoaded = false;
  const renderDmFriends = conversations => {
    const host = $('directFriendList');
    if (!conversations.length) { host.innerHTML = '<div class="soc-empty">Adicione alguém pelo botão Amigos para iniciar uma conversa.</div>'; return; }
    host.innerHTML = conversations.map(friend => '<button class="direct-friend ' + (activeFriend && activeFriend.user_id === friend.id ? 'active' : '') + '" type="button" data-user-id="' + escHtml(friend.id) + '"><span class="online-dot ' + (friend.online ? 'on' : '') + '"></span>' + avatar(friend) + '<span class="direct-friend-copy"><b>' + escHtml(friend.username) + '</b><small>' + (friend.latest_content ? escHtml((friend.latest_from_me ? 'Você: ' : '') + friend.latest_content) : 'Começar conversa') + '</small></span><time>' + escHtml(humanTime(friend.latest_at)) + '</time></button>').join('');
  };
  async function loadDmFriends() {
    if (dm.style.display === 'none') return;
    try {
      const [friendData, conversations] = await Promise.all([api('/api/friends' + (dmAvatarsLoaded ? '' : '?avatars=1')), api('/api/dm/conversations')]);
      if (!dmAvatarsLoaded) dmAvatarsLoaded = true;
      const cachedAvatars = new Map(dmFriends.map(friend => [friend.id, friend.avatar_image]));
      dmFriends = friendData.friends.map(friend => {
        const conversation = conversations.find(item => item.id === friend.user_id) || {};
        return { ...friend, ...conversation, id: friend.user_id, avatar_image: friend.avatar_image || cachedAvatars.get(friend.user_id) || null };
      });
      renderDmFriends(dmFriends);
      if (activeFriend) {
        const refreshed = dmFriends.find(friend => friend.id === activeFriend.id);
        if (refreshed) { activeFriend = refreshed; renderDmHeading(); }
        else { activeFriend = null; lastDmSig = ''; renderDmHeading(); $('directMessageList').innerHTML = '<div class="soc-empty">Essa conversa não está disponível.</div>'; }
      }
    } catch (error) { $('directFriendList').innerHTML = '<div class="soc-empty">Não foi possível carregar seus amigos.</div>'; }
  }
  function renderDmHeading() {
    const title = $('directThreadHeading'), input = $('directMessageInput'), sendButton = $('directMessageForm').querySelector('button[type=submit]');
    if (!activeFriend) { title.innerHTML = '<span class="soc-empty">Escolha um amigo para começar uma conversa.</span>'; input.disabled = true; sendButton.disabled = true; return; }
    title.innerHTML = avatar(activeFriend) + '<span><b>' + escHtml(activeFriend.username) + '</b><small>Conversa privada entre amigos</small></span>';
    input.disabled = false; sendButton.disabled = false;
  }
  function showDmReply() {
    const box = $('directReplyPreview'); if (!box) return;
    const active = !!dmReply;
    box.hidden = !active; box.style.display = active ? 'flex' : 'none';
    if (active) { $('directReplyName').textContent = dmReply.name; $('directReplyText').textContent = dmReply.content; }
  }
  const clearDmReply = () => { dmReply = null; showDmReply(); };
  function paintDmMessages(messages) {
    const host = $('directMessageList'), sig = JSON.stringify(messages);
    if (sig === lastDmSig) return;
    const wasAtBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 70;
    const first = lastDmSig === ''; lastDmSig = sig;
    host.innerHTML = messages.length ? messages.map(message => {
      const mine = me && message.user_id === me.id;
      const reply = message.reply_to_id ? '<button class="reply-quote" type="button" data-jump-id="' + escHtml(message.reply_to_id) + '"><b>' + escHtml(message.reply_username || 'Mensagem respondida') + '</b><span>' + escHtml(message.reply_content || 'Mensagem indisponível') + '</span></button>' : '';
      return '<article class="direct-message ' + (mine ? 'mine' : '') + '" data-message-id="' + escHtml(message.id) + '"><div class="direct-bubble">' + reply + '<div class="direct-message-text">' + linkify(message.content) + '</div><footer><time>' + escHtml(humanTime(message.created_at)) + '</time><button type="button" data-reply-id="' + escHtml(message.id) + '" data-reply-name="' + escHtml(message.username) + '" data-reply-text="' + escHtml(message.content) + '" aria-label="Responder ' + escHtml(message.username) + '"><i class="fas fa-reply" aria-hidden="true"></i><span>Responder</span></button></footer></div></article>';
    }).join('') : '<div class="chat-empty"><i class="fas fa-comment-dots"></i><span>Esta conversa está começando. Envie a primeira mensagem.</span></div>';
    if (first || initialDm || wasAtBottom) host.scrollTop = host.scrollHeight;
    initialDm = false;
  }
  async function loadDmMessages() {
    if (!activeFriend || dm.style.display === 'none') return;
    const id = activeFriend.id;
    try { const messages = await api('/api/dm/' + encodeURIComponent(id) + '/messages'); if (activeFriend && activeFriend.id === id) paintDmMessages(messages); }
    catch (error) { $('directMessageList').innerHTML = '<div class="soc-empty">' + escHtml(error.message) + '</div>'; }
  }
  function selectFriend(id) {
    activeFriend = dmFriends.find(friend => friend.id === id) || null; lastDmSig = ''; initialDm = true; clearDmReply(); renderDmFriends(dmFriends); renderDmHeading();
    $('directMessageList').innerHTML = '<div class="chat-empty"><i class="fas fa-spinner fa-spin"></i><span>Carregando conversa…</span></div>';
    if (activeFriend) loadDmMessages();
  }
  dm.querySelector('#directFriendList').addEventListener('click', event => { const row = event.target.closest('[data-user-id]'); if (row) selectFriend(row.dataset.userId); });
  dm.querySelector('#directMessageList').addEventListener('click', event => {
    const quote = event.target.closest('[data-jump-id]');
    if (quote) { const target = dm.querySelector('[data-message-id="' + CSS.escape(quote.dataset.jumpId) + '"]'); if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('msg-highlight'); setTimeout(() => target.classList.remove('msg-highlight'), 1200); } return; }
    const reply = event.target.closest('[data-reply-id]'); if (!reply) return;
    dmReply = { id: reply.dataset.replyId, name: reply.dataset.replyName, content: reply.dataset.replyText }; showDmReply(); $('directMessageInput').focus();
  });
  $('directReplyCancel').addEventListener('click', clearDmReply);
  dm.querySelector('#directMessageForm').addEventListener('submit', async event => {
    event.preventDefault(); if (!activeFriend) return;
    const input = $('directMessageInput'), content = input.value.trim(); if (!content) return;
    const targetId = activeFriend.id;
    try { await post('/api/dm/' + encodeURIComponent(targetId) + '/messages', { content, reply_to_id: dmReply && dmReply.id }); input.value = ''; clearDmReply(); await Promise.all([loadDmMessages(), loadDmFriends()]); }
    catch (error) { toast(error.message, 'error'); }
  });
  window.openDirectChat = async (userId, username) => {
    open(dm); await loadDmFriends();
    const friend = dmFriends.find(item => item.id === userId) || { id: userId, username: username || 'Amigo' };
    if (!dmFriends.some(item => item.id === friend.id)) dmFriends.unshift(friend);
    selectFriend(friend.id); $('directMessageInput').focus();
  };
  $('directMessagesBtn')?.addEventListener('click', async () => { open(dm); await loadDmFriends(); if (!activeFriend && dmFriends.length) selectFriend(dmFriends[0].id); });

  // Notificações no site e no navegador, quando o FileShare estiver aberto.
  const notices = modal('notificationsSheet', '<i class="fas fa-bell"></i> Notificações', 'notice-sheet');
  notices.querySelector('.modal-body').innerHTML = '<div class="notice-toolbar"><p id="noticeSummary" class="text-muted">Avisos recentes da sua conta.</p><button id="markNoticesRead" class="btn btn-outline" type="button"><i class="fas fa-check-double"></i> Marcar tudo como lido</button></div><div id="noticeList" class="notice-list"></div>';
  let noticeIds = null, unreadCount = 0;
  function updateNoticeCount(count) {
    unreadCount = count; const badge = $('notificationCount'), button = $('notificationsBtn');
    if (!badge || !button) return;
    const hasUnread = Number(count) > 0;
    badge.hidden = !hasUnread; badge.style.display = hasUnread ? 'inline-grid' : 'none'; badge.textContent = hasUnread ? (count > 99 ? '99+' : String(count)) : '';
    button.setAttribute('aria-label', hasUnread ? 'Notificações, ' + count + ' não lidas' : 'Notificações');
  }
  async function pollNotices() {
    try {
      const list = await api('/api/notifications');
      const unread = list.filter(item => !Number(item.read)); updateNoticeCount(unread.length);
      const fresh = noticeIds === null ? [] : unread.filter(item => !noticeIds.includes(item.id));
      noticeIds = unread.map(item => item.id);
      const prefs = window.fileSharePreferences || {};
      if (prefs.browser_notifications && window.Notification && Notification.permission === 'granted' && document.hidden) fresh.forEach(item => new Notification(item.title, { body: item.message, icon: '/favicon.png', tag: 'fileshare-' + item.id }));
      if (notices.style.display !== 'none') paintNotices(list);
    } catch (error) {}
  }
  function paintNotices(list) {
    $('noticeSummary').textContent = unreadCount ? unreadCount + ' aviso(s) ainda não lido(s).' : 'Você está em dia.';
    $('noticeList').innerHTML = list.length ? list.map(item => '<article class="notice-item ' + (!Number(item.read) ? 'unread' : '') + '"><span class="notice-icon"><i class="fas fa-' + (item.type === 'success' ? 'circle-check' : item.type === 'error' ? 'circle-exclamation' : item.type === 'warning' ? 'triangle-exclamation' : 'bell') + '" aria-hidden="true"></i></span><div><b>' + escHtml(item.title) + '</b><p>' + escHtml(item.message) + '</p><time>' + escHtml(humanTime(item.created_at)) + '</time></div></article>').join('') : '<div class="chat-empty"><i class="fas fa-bell-slash"></i><span>Nenhuma notificação por enquanto.</span></div>';
  }
  $('notificationsBtn')?.addEventListener('click', async () => { open(notices); await pollNotices(); });
  $('markNoticesRead').addEventListener('click', async () => { try { await post('/api/notifications/read', {}); await pollNotices(); toast('Notificações marcadas como lidas'); } catch (error) { toast(error.message, 'error'); } });

  // Preferências de aparência, conforto, atualização e segurança da conta.
  const settings = modal('personalSettingsSheet', '<i class="fas fa-sliders"></i> Configurações', 'settings-sheet');
  settings.querySelector('.modal-body').innerHTML = '<form id="personalSettingsForm" class="settings-sections"><section class="settings-card"><div><h4><i class="fas fa-palette"></i> Aparência</h4><p>Escolha o visual e a densidade das listas.</p></div><label class="settings-field">Tema<select id="prefTheme"><option value="dark">Escuro</option><option value="light">Claro</option></select></label><label class="settings-switch"><input id="prefCompact" type="checkbox"><span><b>Visual compacto</b><small>Mostra mais salas e conversas na tela.</small></span></label></section><section class="settings-card"><div><h4><i class="fas fa-gauge-high"></i> Desempenho</h4><p>Defina a frequência de atualização automática.</p></div><label class="settings-field">Atualizar a cada<select id="prefRefresh"><option value="2">2 segundos</option><option value="5">5 segundos</option><option value="10">10 segundos</option></select></label><label class="settings-switch"><input id="prefMotion" type="checkbox"><span><b>Reduzir animações</b><small>Ajuda a evitar movimento visual excessivo.</small></span></label></section><section class="settings-card"><div><h4><i class="fas fa-shield-halved"></i> Segurança e avisos</h4><p>Controle de senha e notificações deste navegador.</p></div><button id="settingsPassword" class="btn btn-outline" type="button"><i class="fas fa-key"></i> Alterar senha</button><label class="settings-switch"><input id="prefBrowserNotifications" type="checkbox"><span><b>Notificações do navegador</b><small>Receba avisos enquanto o FileShare estiver aberto.</small></span></label><button id="requestNotificationPermission" class="btn btn-outline" type="button"><i class="fas fa-bell"></i> Permitir neste navegador</button><p id="notificationPermissionStatus" class="settings-hint" aria-live="polite"></p></section><section class="settings-card"><div><h4><i class="fas fa-user-circle"></i> Foto de perfil</h4><p>JPG, PNG ou WebP. A imagem será reduzida para caber no seu perfil.</p></div><div class="avatar-editor"><span id="settingsAvatarPreview" class="personal-avatar personal-avatar-large"></span><button id="chooseAvatar" class="btn btn-outline avatar-upload-button" type="button"><i class="fas fa-camera"></i> Escolher foto</button><input id="avatarFile" type="file" accept="image/jpeg,image/png,image/webp" hidden><button id="removeAvatar" class="btn btn-outline btn-danger" type="button">Remover foto</button></div><p id="avatarStatus" class="settings-hint" aria-live="polite"></p></section><div class="settings-actions"><button class="btn btn-primary" type="submit"><i class="fas fa-floppy-disk"></i> Salvar configurações</button></div></form>';

  // Editor de enquadramento da foto de perfil.
  const avatarCrop = modal('avatarCropSheet', '<i class="fas fa-crop-simple"></i> Enquadrar foto', 'avatar-crop-sheet');
  avatarCrop.querySelector('.modal-body').innerHTML = '<div class="avatar-crop-copy">Arraste a foto para posicionar e use o zoom para deixar o enquadramento perfeito.</div><div class="avatar-crop-stage"><canvas id="avatarCropCanvas" width="320" height="320"></canvas></div><label class="avatar-crop-zoom"><span><i class="fas fa-magnifying-glass-minus"></i> Zoom</span><input id="avatarCropZoom" type="range" min="1" max="3" step="0.01" value="1"><i class="fas fa-magnifying-glass-plus"></i></label><div class="avatar-crop-actions"><button id="avatarCropCancel" class="btn btn-outline" type="button">Cancelar</button><button id="avatarCropApply" class="btn btn-primary" type="button"><i class="fas fa-check"></i> Usar foto</button></div>';
  const cropCanvas = $('avatarCropCanvas'), cropCtx = cropCanvas.getContext('2d');
  let cropImage = null, cropZoom = 1, cropX = 0, cropY = 0, cropPointer = null, cropBusy = false;
  const CROP_SIZE = 320;
  function cropScale() { if (!cropImage) return 1; return Math.max(CROP_SIZE / cropImage.naturalWidth, CROP_SIZE / cropImage.naturalHeight) * cropZoom; }
  function clampCrop() {
    if (!cropImage) return;
    const scale = cropScale(), maxX = Math.max(0, (cropImage.naturalWidth * scale - CROP_SIZE) / 2), maxY = Math.max(0, (cropImage.naturalHeight * scale - CROP_SIZE) / 2);
    cropX = Math.max(-maxX, Math.min(maxX, cropX)); cropY = Math.max(-maxY, Math.min(maxY, cropY));
  }
  function drawCrop() {
    if (!cropCtx) return;
    cropCtx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
    cropCtx.fillStyle = '#0a0612'; cropCtx.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
    if (!cropImage) return;
    const scale = cropScale(); clampCrop();
    const w = cropImage.naturalWidth * scale, h = cropImage.naturalHeight * scale;
    cropCtx.drawImage(cropImage, (CROP_SIZE - w) / 2 + cropX, (CROP_SIZE - h) / 2 + cropY, w, h);
  }
  function openAvatarCrop(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        cropImage = image; cropZoom = 1; cropX = 0; cropY = 0; cropBusy = false;
        $('avatarCropZoom').value = '1'; drawCrop(); open(avatarCrop);
        const finish = value => { avatarCrop.style.display = 'none'; cropPointer = null; resolve(value); };
        const cancel = () => finish(null);
        const apply = () => { if (cropBusy || !cropImage) return; cropBusy = true; clampCrop(); let data = cropCanvas.toDataURL('image/jpeg', .84); if (data.length > 125000) data = cropCanvas.toDataURL('image/jpeg', .68); if (data.length > 136000) data = cropCanvas.toDataURL('image/jpeg', .52); if (data.length > 136000) { $('avatarStatus').textContent = 'A foto ficou grande demais. Diminua o zoom ou escolha outra imagem.'; cropBusy = false; return; } finish(data); };
        $('avatarCropCancel').onclick = cancel; $('avatarCropApply').onclick = apply;
        $('avatarCropZoom').oninput = event => { cropZoom = Number(event.target.value) || 1; clampCrop(); drawCrop(); };
        cropCanvas.onpointerdown = event => { cropCanvas.setPointerCapture?.(event.pointerId); cropPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; };
        cropCanvas.onpointermove = event => { if (!cropPointer || cropPointer.id !== event.pointerId) return; cropX += event.clientX - cropPointer.x; cropY += event.clientY - cropPointer.y; cropPointer.x = event.clientX; cropPointer.y = event.clientY; clampCrop(); drawCrop(); };
        cropCanvas.onpointerup = cropCanvas.onpointercancel = () => { cropPointer = null; };
        avatarCrop.querySelector('.modal-overlay').onclick = cancel;
        avatarCrop.querySelector('.modal-close').onclick = cancel;
      };
      image.onerror = () => reject(new Error('Não foi possível abrir essa foto.'));
      image.src = source;
    });
  }

  const defaults = { theme: document.documentElement.getAttribute('data-theme') || 'light', compact_mode: false, reduced_motion: false, refresh_seconds: 2, browser_notifications: false };
  window.fileSharePreferences = { ...defaults };
  let preferencesReady = false, queuedTheme = null;
  let themeSaveQueue = Promise.resolve();
  window.addEventListener('fileshare:theme-change', event => {
    const theme = event.detail && event.detail.theme === 'dark' ? 'dark' : 'light';
    if (!preferencesReady) { queuedTheme = theme; return; }
    window.fileSharePreferences.theme = theme;
    themeSaveQueue = themeSaveQueue.catch(() => {}).then(() => post('/api/preferences', window.fileSharePreferences, 'PUT')).catch(() => {});
  });
  function setTheme(theme) {
    const root = document.documentElement; const desired = theme === 'light' ? 'light' : 'dark';
    root.setAttribute('data-theme', desired);
    try { localStorage.setItem('fileshare-theme', desired); } catch (error) {}
    const toggle = document.querySelector('.theme-toggle');
    if (toggle) { toggle.innerHTML = desired === 'dark' ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>'; toggle.title = desired === 'dark' ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'; toggle.setAttribute('aria-label', toggle.title); }
  }
  function applyPreferences(prefs) {
    window.fileSharePreferences = { ...defaults, ...prefs };
    setTheme(window.fileSharePreferences.theme);
    document.body.classList.toggle('personal-compact', !!window.fileSharePreferences.compact_mode);
    document.documentElement.classList.toggle('personal-reduced-motion', !!window.fileSharePreferences.reduced_motion);
    if (typeof window.setDashboardRefresh === 'function') window.setDashboardRefresh(window.fileSharePreferences.refresh_seconds);
    $('prefTheme').value = window.fileSharePreferences.theme; $('prefCompact').checked = !!window.fileSharePreferences.compact_mode;
    $('prefMotion').checked = !!window.fileSharePreferences.reduced_motion; $('prefRefresh').value = String(window.fileSharePreferences.refresh_seconds);
    $('prefBrowserNotifications').checked = !!window.fileSharePreferences.browser_notifications;
    paintAvatarPreview(); permissionStatus();
  }
  async function loadPreferences() {
    try {
      const prefs = await api('/api/preferences'); if (!prefs.has_preferences) prefs.theme = defaults.theme;
      if (queuedTheme) { prefs.theme = queuedTheme; }
      applyPreferences(prefs); preferencesReady = true;
      if (queuedTheme) { window.fileSharePreferences.theme = queuedTheme; themeSaveQueue = themeSaveQueue.catch(() => {}).then(() => post('/api/preferences', window.fileSharePreferences, 'PUT')).catch(() => {}); queuedTheme = null; }
    } catch (error) { applyPreferences(defaults); preferencesReady = true; }
  }
  function currentAvatar() {
    const user = typeof me !== 'undefined' && me || {};
    return user.avatar_image ? '<img src="' + escHtml(user.avatar_image) + '" alt="Foto do perfil">' : escHtml(String(user.username || '?').slice(0, 1).toUpperCase());
  }
  function paintAvatarPreview() {
    const preview = $('settingsAvatarPreview'); if (preview) { preview.style.setProperty('--avatar-color', typeof me !== 'undefined' && me && me.avatar_color || '#8b5cf6'); preview.innerHTML = currentAvatar(); }
  }
  function permissionStatus() {
    const status = $('notificationPermissionStatus'); if (!status) return;
    if (!('Notification' in window)) status.textContent = 'Este navegador não oferece notificações do sistema.';
    else if (Notification.permission === 'granted') status.textContent = 'Permissão concedida neste navegador.';
    else if (Notification.permission === 'denied') status.textContent = 'Permissão bloqueada. Altere nas configurações do navegador.';
    else status.textContent = 'Permita as notificações para receber avisos neste aparelho.';
  }
  function paintUserAvatar() {
    const host = $('userAvatar'); if (!host || typeof me === 'undefined' || !me) return;
    host.style.background = me.avatar_color || '#8b5cf6'; host.innerHTML = currentAvatar();
  }
  $('personalSettingsBtn')?.addEventListener('click', async () => { open(settings); await loadPreferences(); paintAvatarPreview(); });
  $('settingsPassword').addEventListener('click', () => { settings.style.display = 'none'; if (typeof showPasswordModal === 'function') showPasswordModal(); });
  $('prefTheme').addEventListener('change', event => setTheme(event.target.value));
  $('personalSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const values = { theme: $('prefTheme').value, compact_mode: $('prefCompact').checked, reduced_motion: $('prefMotion').checked, refresh_seconds: Number($('prefRefresh').value), browser_notifications: $('prefBrowserNotifications').checked };
    try { const saved = await post('/api/preferences', values, 'PUT'); applyPreferences(saved); toast('Configurações salvas'); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('requestNotificationPermission').addEventListener('click', async () => {
    if (!('Notification' in window)) return permissionStatus();
    try { await Notification.requestPermission(); permissionStatus(); }
    catch (error) { $('notificationPermissionStatus').textContent = 'Não foi possível solicitar permissão neste navegador.'; }
  });
  $('prefBrowserNotifications').addEventListener('change', async event => {
    if (!event.target.checked || !('Notification' in window) || Notification.permission !== 'default') { permissionStatus(); return; }
    try { await Notification.requestPermission(); permissionStatus(); }
    catch (error) { $('notificationPermissionStatus').textContent = 'Não foi possível solicitar permissão neste navegador.'; }
  });
  $('avatarFile').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0]; event.target.value = '';
    if (!file) return;
    if (!/^image\/(?:jpeg|png|webp)$/.test(file.type)) { $('avatarStatus').textContent = 'Escolha uma imagem JPG, PNG ou WebP.'; return; }
    if (file.size > 12 * 1024 * 1024) { $('avatarStatus').textContent = 'Escolha uma foto com até 12 MB para preparar.'; return; }
    $('avatarStatus').textContent = 'Abrindo enquadramento…';
    try {
      const source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Não foi possível ler essa foto.')); reader.readAsDataURL(file); });
      const data = await openAvatarCrop(source);
      if (!data) { $('avatarStatus').textContent = 'Enquadramento cancelado.'; return; }
      $('avatarStatus').textContent = 'Salvando foto…';
      const result = await post('/api/profile/avatar', { image: data }, 'PUT');
      me.avatar_image = result.avatar_image; paintUserAvatar(); paintAvatarPreview();
      $('avatarStatus').textContent = 'Foto de perfil atualizada.'; toast('Foto de perfil atualizada');
    } catch (error) { $('avatarStatus').textContent = error.message || 'Não foi possível atualizar a foto.'; }
  });
  $('removeAvatar').addEventListener('click', async () => {
    try { await post('/api/profile/avatar', { image: null }, 'PUT'); if (typeof me !== 'undefined' && me) me.avatar_image = null; paintUserAvatar(); paintAvatarPreview(); $('avatarStatus').textContent = 'Foto removida.'; }
    catch (error) { $('avatarStatus').textContent = error.message; }
  });
  $('chooseAvatar').addEventListener('click', () => $('avatarFile').click());
  document.addEventListener('keydown', event => { if (event.key === 'Escape') [dm, notices, settings].forEach(item => { item.style.display = 'none'; }); });

  loadPreferences(); pollNotices();
  setInterval(() => { pollNotices(); if (dm.style.display !== 'none') { loadDmFriends(); loadDmMessages(); } }, 5000);
})();
