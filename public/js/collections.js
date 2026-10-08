(function () {
  const $ = id => document.getElementById(id);
  const esc = value => { const div = document.createElement('div'); div.textContent = String(value == null ? '' : value); return div.innerHTML; };
  const api = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
    return data;
  };
  const collectionUrl = token => window.location.origin + '/enviar/' + encodeURIComponent(token);
  const dateLabel = value => {
    const date = new Date(String(value || '').replace(' ', 'T') + (String(value || '').endsWith('Z') ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? 'Prazo indisponível' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  };
  const timeValue = value => {
    const text = String(value || '');
    const date = new Date(text.replace(' ', 'T') + (text.endsWith('Z') ? '' : 'Z'));
    return date.getTime();
  };
  const statuses = {
    pending: ['Aguardando envio', ''], in_progress: ['Envio parcial', 'is-progress'], sending: ['Enviando agora', 'is-sending'],
    submitted: ['Enviado', 'is-submitted'], revoked: ['Suspenso pelo organizador', 'is-revoked'], expired: ['Prazo não cumprido', 'is-expired']
  };
  let roomsCache = [], friendsCache = [], friendsLoaded = false, friendsLoading = false, participantNames = [], collectionsCache = [], collectionsSignature = '', collectionsLoading = false, historyOpen = false, exclusiveBeforeMultiUse = false;

  async function copyText(text, button) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement('textarea'); input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
        document.body.appendChild(input); input.select();
        if (!document.execCommand('copy')) throw new Error('Não foi possível copiar o link.');
        input.remove();
      }
      if (button) { const previous = button.innerHTML; button.innerHTML = '<i class="fas fa-check"></i> Copiado'; setTimeout(() => { if (button.isConnected) button.innerHTML = previous; }, 1400); }
      if (window.toast) toast('Link copiado');
    } catch (error) { if (window.toast) toast(error.message || 'Não foi possível copiar o link.', 'error'); }
  }
  function showCreatedLinks(collection, recipients) {
    const box = $('collectionCreatedLinks');
    box.hidden = false;
    const single = collection ? collection.single_link : recipients.length === 1 && (!recipients[0].participant_name || recipients[0].participant_name === 'Link único');
    const multiUse = !!(collection && collection.multi_use_link);
    box.innerHTML = '<h3><i class="fas fa-circle-check"></i> Links prontos</h3><p>' +
      (multiUse ? 'Compartilhe o mesmo link com várias pessoas. Cada uma informa o nome antes de enviar; o link continua aberto até o prazo.' : single ? 'Compartilhe este link. Quem enviar deverá informar o próprio nome; o link será encerrado após a confirmação.' : 'Envie cada link apenas para a pessoa indicada. Ele será encerrado depois que o envio for confirmado.') +
      (collection && collection.exclusive_access ? (multiUse ? ' Uma pessoa pode enviar por vez; ao terminar, o link fica disponível para a próxima.' : ' Enquanto alguém estiver com o link aberto, outras pessoas serão bloqueadas. Se a página for fechada sem concluir, o acesso libera em até 2 minutos.') : '') + '</p>' +
      recipients.map(recipient => {
        const url = collectionUrl(recipient.token);
        const label = recipient.participant_name || 'Link único';
        return '<div class="collection-link-row"><div><strong>' + esc(label) + '</strong><span class="collection-link-value" title="' + esc(url) + '">' + esc(url) + '</span></div><button class="btn btn-sm btn-outline" type="button" data-copy-link="' + esc(url) + '"><i class="fas fa-copy"></i> Copiar</button></div>';
      }).join('');
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderParticipants() {
    const host = $('collectionParticipantChips');
    host.innerHTML = participantNames.map((name, index) => '<span class="collection-participant-chip">' + esc(name) + '<button type="button" data-remove-participant="' + index + '" aria-label="Remover ' + esc(name) + '"><i class="fas fa-xmark"></i></button></span>').join('');
  }
  function updateCollectionSubmitLabel() {
    const label = $('createCollectionSubmit')?.querySelector('span');
    if (!label) return;
    label.textContent = $('collectionMultiUseLink').checked ? 'Criar link multiuso' : 'Criar links de envio';
  }
  function participantExists(name) { return participantNames.some(existing => existing.toLocaleLowerCase() === String(name).toLocaleLowerCase()); }
  function renderFriendPicker(message) {
    const host = $('collectionFriendNames');
    if (!host) return;
    if (message) { host.innerHTML = '<p class="collection-friends-empty">' + esc(message) + '</p>'; return; }
    if (!friendsCache.length) { host.innerHTML = '<p class="collection-friends-empty">Nenhuma amizade adicionada ainda.</p>'; return; }
    host.innerHTML = friendsCache.map(friend => {
      const name = String(friend.username || '').trim();
      if (!name) return '';
      const selected = participantExists(name);
      return '<button class="collection-friend-option" type="button" data-add-friend="' + esc(name) + '" aria-pressed="' + selected + '" ' + (selected ? 'disabled' : '') + '><span>' + esc(name) + '</span>' + (selected ? '<i class="fas fa-check" aria-label="Adicionado"></i>' : '') + '</button>';
    }).join('');
  }
  async function loadFriends() {
    if (friendsLoading) return;
    friendsLoading = true;
    renderFriendPicker('Carregando membros...');
    try {
      const result = await api('/api/friends');
      friendsCache = (result.friends || []).filter(friend => friend && friend.username);
      friendsLoaded = true;
      renderFriendPicker();
    } catch (error) { renderFriendPicker('Não foi possível carregar suas amizades.'); }
    finally { friendsLoading = false; }
  }
  function addParticipant(value) {
    const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name) return false;
    if (participantExists(name)) {
      toast('Esse nome já está na lista.', 'error');
      $('collectionParticipantInput').focus();
      return false;
    }
    if (participantNames.length >= 100) { toast('O limite é de 100 participantes por coleta.', 'error'); return false; }
    participantNames.push(name);
    $('collectionParticipantInput').value = '';
    renderParticipants();
    renderFriendPicker();
    $('collectionParticipantInput').focus();
    return true;
  }
  async function loadRoomsForSelect() {
    const select = $('collectionRoom');
    try {
      roomsCache = await api('/api/rooms');
      const previous = select.value;
      const available = roomsCache.filter(room => room.isMember);
      select.innerHTML = '<option value="">Escolha uma sala</option>' + available.map(room => '<option value="' + esc(room.id) + '">' + esc(room.name) + '</option>').join('');
      if (available.some(room => room.id === previous)) select.value = previous;
      if (!available.length) select.innerHTML = '<option value="">Entre em uma sala para criar uma coleta</option>';
    } catch (error) { select.innerHTML = '<option value="">Não foi possível carregar as salas</option>'; }
  }
  function participantMarkup(recipient, collectionId, singleLink) {
    const status = statuses[recipient.status] || ['Aguardando envio', ''];
    const canReissue = ['pending', 'in_progress', 'revoked'].includes(recipient.status);
    const canSuspend = ['pending', 'in_progress'].includes(recipient.status);
    const label = recipient.participant_name || (singleLink ? 'Link único' : 'Participante');
    const closedAt = recipient.closed_at || recipient.submitted_at || recipient.revoked_at;
    return '<div class="collection-participant"><div><strong>' + esc(label) + '</strong><small>' + esc(status[0]) + (recipient.upload_count ? ' · ' + recipient.upload_count + (recipient.upload_count === 1 ? ' arquivo' : ' arquivos') : '') + (closedAt ? ' · ' + esc(dateLabel(closedAt)) : '') + '</small></div><div class="collection-participant-actions"><span class="collection-status ' + status[1] + '">' + esc(status[0]) + '</span>' +
      (canReissue ? '<button class="btn btn-sm btn-outline" type="button" data-reissue="' + esc(collectionId) + '" data-recipient="' + esc(recipient.id) + '"><i class="fas fa-rotate"></i> Novo link</button>' : '') +
      (canSuspend ? '<button class="btn btn-sm btn-outline btn-danger" type="button" data-revoke="' + esc(collectionId) + '" data-recipient="' + esc(recipient.id) + '"><i class="fas fa-ban"></i> Suspender</button>' : '') +
      '</div></div>';
  }
  function collectionBucket(collection) {
    const recipients = collection.recipients || [];
    const terminal = recipients.length > 0 && recipients.every(recipient => ['submitted', 'revoked', 'expired'].includes(recipient.status));
    if (!terminal) return 'active';
    const terminalAt = Math.max(...recipients.map(recipient => timeValue(recipient.closed_at || recipient.submitted_at || recipient.revoked_at || (recipient.status === 'expired' ? collection.expires_at : ''))).filter(Number.isFinite));
    if (!Number.isFinite(terminalAt)) return 'recent';
    return Date.now() >= terminalAt + 5 * 60 * 1000 ? 'history' : 'recent';
  }
  function collectionCardMarkup(collection) {
      const completedRecipients = collection.recipients.filter(recipient => recipient.status === 'submitted');
      const multiUse = !!Number(collection.multi_use_link);
      const submissions = collection.submissions || [];
      const completed = multiUse ? submissions.length : completedRecipients.length;
      const allSubmitted = !multiUse && collection.recipients.length > 0 && completed === collection.recipients.length;
      const allEnded = collection.recipients.length > 0 && collection.recipients.every(recipient => ['submitted', 'revoked', 'expired'].includes(recipient.status));
      const hasExpired = collection.recipients.some(recipient => recipient.status === 'expired');
      const hasSuspended = collection.recipients.some(recipient => recipient.status === 'revoked');
      const statusText = allSubmitted ? 'Todos enviaram' : hasExpired && allEnded ? 'Encerrada · prazo não cumprido' : hasSuspended && allEnded ? 'Encerrada · link suspenso' : allEnded ? 'Encerrada' : 'Coleta aberta';
      const statusClass = hasExpired ? 'is-expired' : allSubmitted ? 'is-submitted' : hasSuspended && allEnded ? 'is-revoked' : '';
      const items = collection.items.map(item => esc(item.label) + (Number(item.quantity) > 1 ? ' × ' + Number(item.quantity) : '') + (Number(item.required) ? ' *' : ' (opcional)')).join(' · ');
      const mode = multiUse ? '<span class="collection-mode-badge"><i class="fas fa-users"></i> Link multiuso</span>' : collection.single_link ? '<span class="collection-mode-badge"><i class="fas fa-link"></i> Link único</span>' : '<span class="collection-mode-badge"><i class="fas fa-users"></i> Links individuais</span>';
      const accessMode = Number(collection.exclusive_access) ? '<span class="collection-mode-badge"><i class="fas fa-lock"></i> Uma pessoa por vez</span>' : '';
      const senderNames = [...new Set((multiUse ? submissions.map(submission => submission.sender_name) : completedRecipients.map(recipient => recipient.participant_name)).filter(Boolean))];
      const senderLabel = senderNames.slice(0, 3).join(', ') + (senderNames.length > 3 ? ' +' + (senderNames.length - 3) : '');
      const tray = completed ? '<div class="collection-download-tray"><div class="collection-download-senders"><strong>Enviado por</strong><span title="' + esc(senderNames.join(', ')) + '">' + esc(senderLabel) + '</span></div><button class="btn btn-sm btn-green" type="button" data-download="' + esc(collection.id) + '"><i class="fas fa-file-zipper"></i> Baixar tudo · ZIP</button></div>' : '';
      return '<div class="collection-card-wrap"><article class="collection-card"><div class="collection-card-head"><div><h3>' + esc(collection.title) + '</h3><div class="collection-card-meta"><i class="fas fa-folder"></i> ' + esc(collection.room_name) + ' · prazo ' + esc(dateLabel(collection.expires_at)) + '</div>' + mode + accessMode + '</div><span class="collection-status ' + statusClass + '">' + esc(statusText) + '</span></div>' +
        (collection.instructions ? '<p class="collection-card-meta collection-instructions">' + esc(collection.instructions) + '</p>' : '') +
        '<p class="collection-card-meta">' + (multiUse ? completed + (completed === 1 ? ' envio recebido' : ' envios recebidos') + ' · link ativo até o prazo' : completed + ' de ' + collection.recipients.length + ' concluíram') + ' · ' + esc(items) + '</p>' +
        '<div class="collection-participant-list">' + collection.recipients.map(recipient => participantMarkup(multiUse ? { ...recipient, participant_name: 'Link multiuso' } : recipient, collection.id, collection.single_link)).join('') + '</div></article>' + tray + '</div>';
  }
  function renderCollections(collections) {
    const host = $('collectionsList');
    const active = collections.filter(collection => collectionBucket(collection) === 'active');
    const recent = collections.filter(collection => collectionBucket(collection) === 'recent');
    const history = collections.filter(collection => collectionBucket(collection) === 'history');
    host.innerHTML = '<div class="collection-list-heading"><div><strong>Em andamento</strong><small>' + active.length + (active.length === 1 ? ' coleta ativa' : ' coletas ativas') + '</small></div><button id="toggleCollectionHistory" class="btn btn-sm btn-outline" type="button" aria-expanded="' + historyOpen + '" aria-controls="collectionHistoryPanel"><i class="fas fa-box-archive"></i> Histórico <span>' + history.length + '</span><i class="fas fa-chevron-' + (historyOpen ? 'up' : 'down') + '"></i></button></div>' +
      '<div class="collection-active-list">' + (active.length ? active.map(collectionCardMarkup).join('') : '<div class="collection-empty"><i class="fas fa-inbox"></i><p>Nenhuma coleta em andamento.</p></div>') + '</div>' +
      (recent.length ? '<section class="collection-recent-list" aria-label="Coletas encerradas recentemente"><h3><i class="fas fa-hourglass-half"></i> Encerradas recentemente <small>Entram no histórico 5 minutos após o último link ser fechado.</small></h3>' + recent.map(collectionCardMarkup).join('') + '</section>' : '') +
      (historyOpen ? '<section id="collectionHistoryPanel" class="collection-history-panel" aria-label="Histórico de coletas"><div class="collection-history-heading"><h3><i class="fas fa-box-archive"></i> Histórico</h3>' + (history.length ? '<button id="clearCollectionHistory" class="btn btn-sm btn-outline btn-danger" type="button"><i class="fas fa-trash"></i> Limpar histórico</button>' : '') + '</div>' + (history.length ? history.map(collectionCardMarkup).join('') : '<div class="collection-empty"><i class="fas fa-clock-rotate-left"></i><p>Coletas concluídas ou encerradas aparecerão aqui.</p></div>') + '</section>' : '');
  }
  async function loadCollections(silent = false) {
    const host = $('collectionsList');
    if (collectionsLoading) return;
    collectionsLoading = true;
    if (!silent) host.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Carregando coletas...</div>';
    try {
      const latest = await api('/api/coletas');
      const signature = JSON.stringify(latest) + '|' + latest.map(collectionBucket).join(',');
      collectionsCache = latest;
      if (signature !== collectionsSignature) { collectionsSignature = signature; renderCollections(collectionsCache); }
    } catch (error) { if (!silent) host.innerHTML = '<div class="alert alert-error">' + esc(error.message) + '</div>'; }
    finally { collectionsLoading = false; }
  }
  function setTab(active) {
    const isCollections = active === 'collections';
    $('roomsPanel').hidden = isCollections; $('collectionsPanel').hidden = !isCollections;
    $('roomsTab').classList.toggle('is-active', !isCollections); $('collectionsTab').classList.toggle('is-active', isCollections);
    $('roomsTab').setAttribute('aria-selected', String(!isCollections)); $('collectionsTab').setAttribute('aria-selected', String(isCollections));
    if (isCollections) { loadRoomsForSelect(); loadCollections(); }
  }
  $('roomsTab').addEventListener('click', () => setTab('rooms'));
  $('collectionsTab').addEventListener('click', () => setTab('collections'));
  $('refreshCollectionsBtn').addEventListener('click', loadCollections);
  setInterval(() => { if (!document.hidden && !$('collectionsPanel').hidden) loadCollections(true); }, 2000);

  $('addCollectionItem').addEventListener('click', () => {
    const host = $('collectionItems');
    if (host.children.length >= 30) { toast('O limite é de 30 itens por coleta.', 'error'); return; }
    const row = document.createElement('div'); row.className = 'collection-item-input';
    row.innerHTML = '<input type="text" maxlength="120" placeholder="Ex.: Foto" required><label class="collection-quantity-label">Qtd.<input type="number" min="1" max="200" value="1" inputmode="numeric" aria-label="Quantidade solicitada"></label><label class="collection-required-label"><input type="checkbox" checked> Obrigatório</label><button class="btn btn-sm btn-outline collection-remove-item" type="button" title="Remover item" aria-label="Remover item"><i class="fas fa-xmark"></i></button>';
    host.appendChild(row); row.querySelector('input[type=text]').focus();
  });
  $('collectionItems').addEventListener('click', event => {
    const button = event.target.closest('.collection-remove-item'); if (!button) return;
    const host = $('collectionItems');
    if (host.children.length <= 1) { host.firstElementChild.querySelector('input[type=text]').value = ''; return; }
    button.closest('.collection-item-input').remove();
  });
  $('addCollectionParticipant').addEventListener('click', () => addParticipant($('collectionParticipantInput').value));
  $('collectionFriendsBtn').addEventListener('click', async event => {
    const button = event.currentTarget;
    const opening = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(opening));
    $('collectionFriendPicker').hidden = !opening;
    if (opening && !friendsLoaded) await loadFriends();
  });
  $('collectionFriendNames').addEventListener('click', event => {
    const button = event.target.closest('[data-add-friend]');
    if (!button || button.disabled) return;
    if (addParticipant(button.dataset.addFriend)) renderFriendPicker();
  });
  $('collectionParticipantInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addParticipant(event.currentTarget.value); }
  });
  $('collectionParticipantChips').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-participant]'); if (!button) return;
    participantNames.splice(Number(button.dataset.removeParticipant), 1); renderParticipants(); renderFriendPicker();
  });
  $('collectionMultiUseLink').addEventListener('change', event => {
    if (event.currentTarget.checked) {
      exclusiveBeforeMultiUse = $('collectionExclusiveAccess').checked;
      $('collectionExclusiveAccess').checked = true;
    } else {
      $('collectionExclusiveAccess').checked = exclusiveBeforeMultiUse;
    }
    $('collectionExclusiveAccess').disabled = event.currentTarget.checked;
    $('collectionParticipantsGroup').hidden = event.currentTarget.checked;
    if (event.currentTarget.checked) { participantNames = []; renderParticipants(); $('collectionFriendPicker').hidden = true; $('collectionFriendsBtn').setAttribute('aria-expanded', 'false'); }
    updateCollectionSubmitLabel();
  });
  $('collectionForm').addEventListener('submit', async event => {
    event.preventDefault();
    const multiUseLink = $('collectionMultiUseLink').checked;
    if (!multiUseLink && !participantNames.length) { toast('Adicione pelo menos um participante.', 'error'); $('collectionParticipantInput').focus(); return; }
    const items = Array.from($('collectionItems').querySelectorAll('.collection-item-input')).map(row => ({
      label: row.querySelector('input[type=text]').value.trim(),
      quantity: Math.max(1, Math.min(200, Number(row.querySelector('input[type=number]').value) || 1)),
      required: row.querySelector('.collection-required-label input[type=checkbox]').checked
    })).filter(item => item.label);
    if (items.reduce((total, item) => total + item.quantity, 0) > 200) { toast('A soma das quantidades não pode passar de 200 arquivos por pessoa.', 'error'); return; }
    const deadline = new Date($('collectionDeadline').value);
    if (!Number.isFinite(deadline.getTime())) { toast('Escolha um prazo para a coleta.', 'error'); return; }
    const submit = event.submitter || $('collectionForm').querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const created = await api('/api/coletas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title: $('collectionTitle').value.trim(), room_id: $('collectionRoom').value,
        instructions: $('collectionInstructions').value.trim(), expires_at: deadline.toISOString(), items,
        participants: multiUseLink ? [] : participantNames, multi_use_link: multiUseLink,
        exclusive_access: multiUseLink || $('collectionExclusiveAccess').checked
      }) });
      showCreatedLinks(created, created.recipients);
      $('collectionForm').reset(); $('collectionExclusiveAccess').disabled = false; exclusiveBeforeMultiUse = false; participantNames = []; renderParticipants(); $('collectionParticipantsGroup').hidden = false;
      updateCollectionSubmitLabel();
      $('collectionItems').innerHTML = '<div class="collection-item-input"><input type="text" maxlength="120" placeholder="Ex.: Foto" required><label class="collection-quantity-label">Qtd.<input type="number" min="1" max="200" value="1" inputmode="numeric" aria-label="Quantidade solicitada"></label><label class="collection-required-label"><input type="checkbox" checked> Obrigatório</label><button class="btn btn-sm btn-outline collection-remove-item" type="button" title="Remover item" aria-label="Remover item"><i class="fas fa-xmark"></i></button></div>';
      $('collectionFriendPicker').hidden = true; $('collectionFriendsBtn').setAttribute('aria-expanded', 'false'); await loadCollections(); toast('Coleta criada e links gerados.');
    } catch (error) { toast(error.message, 'error'); }
    finally { submit.disabled = false; }
  });

  document.addEventListener('click', async event => {
    const historyToggle = event.target.closest('#toggleCollectionHistory');
    if (historyToggle) { historyOpen = !historyOpen; renderCollections(collectionsCache); return; }
    const clearHistory = event.target.closest('#clearCollectionHistory');
    if (clearHistory) {
      if (!confirm('Limpar as coletas do histórico? Os arquivos enviados continuarão disponíveis nas salas.')) return;
      clearHistory.disabled = true;
      try {
        const result = await api('/api/coletas/historico', { method: 'DELETE' });
        toast(result.cleared_count ? 'Histórico limpo. Os arquivos continuam nas salas.' : 'Não há coletas disponíveis para limpar.');
        await loadCollections();
      } catch (error) { toast(error.message, 'error'); }
      finally { if (clearHistory.isConnected) clearHistory.disabled = false; }
      return;
    }
    const copy = event.target.closest('[data-copy-link]');
    if (copy) { await copyText(copy.dataset.copyLink, copy); return; }
    const reissue = event.target.closest('[data-reissue]');
    if (reissue) {
      reissue.disabled = true;
      try {
        const result = await api('/api/coletas/' + encodeURIComponent(reissue.dataset.reissue) + '/participantes/' + encodeURIComponent(reissue.dataset.recipient) + '/reemitir', { method: 'POST' });
        showCreatedLinks(null, [{ participant_name: result.participant_name || 'Link único', token: result.token }]);
        toast('Novo link gerado. O link anterior foi encerrado.'); await loadCollections();
      } catch (error) { toast(error.message, 'error'); }
      finally { reissue.disabled = false; }
      return;
    }
    const revoke = event.target.closest('[data-revoke]');
    if (revoke) {
      if (!confirm('Suspender este link e remover os arquivos enviados parcialmente?')) return;
      revoke.disabled = true;
      try { await api('/api/coletas/' + encodeURIComponent(revoke.dataset.revoke) + '/participantes/' + encodeURIComponent(revoke.dataset.recipient) + '/revogar', { method: 'POST' }); toast('Link suspenso pelo organizador.'); await loadCollections(); }
      catch (error) { toast(error.message, 'error'); }
      finally { revoke.disabled = false; }
      return;
    }
    const download = event.target.closest('[data-download]');
    if (download) window.location.href = '/api/coletas/' + encodeURIComponent(download.dataset.download) + '/zip';
  });
  loadRoomsForSelect();
})();
