(function () {
  const root = document.getElementById('collectionPublicRoot');
  const token = window.location.pathname.split('/').filter(Boolean).pop() || '';
  const base = '/api/coletas/enviar/' + encodeURIComponent(token);
  const COLLECTION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  const UPLOAD_STALE_MS = 90 * 1000;
  const UPLOAD_STALL_TIMEOUT_MS = 90 * 1000;
  const senderDraftKey = 'fs_collection_sender:' + token;
  const initialSenderDraft = (() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(senderDraftKey) || '{}');
      const name = String(saved.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return { name, confirmed: Boolean(name && saved.confirmed) };
    } catch (_) { return { name: '', confirmed: false }; }
  })();
  let collection = null, pendingFiles = [], reviewing = false, busy = false, senderName = initialSenderDraft.name, nameConfirmed = initialSenderDraft.confirmed, collectionSignature = '', stateFetchPromise = null, statePollTimer = null, stateHeartbeatTimer = null;
  function persistSenderDraft(confirmed = nameConfirmed) {
    try { sessionStorage.setItem(senderDraftKey, JSON.stringify({ name: senderName, confirmed: Boolean(confirmed && senderName) })); } catch (_) {}
  }
  function clearSenderDraft() { try { sessionStorage.removeItem(senderDraftKey); } catch (_) {} }
  const esc = value => { const div = document.createElement('div'); div.textContent = String(value == null ? '' : value); return div.innerHTML; };
  const sizeLabel = value => {
    const bytes = Number(value) || 0;
    if (bytes >= 1024 ** 3) return (bytes / (1024 ** 3)).toFixed(1) + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / (1024 ** 2)).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  };
  const dateLabel = value => {
    const date = new Date(String(value || '').replace(' ', 'T') + (String(value || '').endsWith('Z') ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? 'Prazo não disponível' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  };
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || 'Não foi possível concluir o envio.'); error.state = data.state; throw error; }
    return data;
  }
  function showMessage(message, success = false) {
    root.querySelectorAll('.collection-public-message').forEach(node => node.remove());
    root.insertAdjacentHTML('beforeend', '<div class="collection-public-message ' + (success ? 'is-success' : '') + '" role="status">' + esc(message) + '</div>');
  }
  function stopStatePolling() {
    if (statePollTimer) { clearInterval(statePollTimer); statePollTimer = null; }
  }
  function stopAccessHeartbeat() {
    if (stateHeartbeatTimer) { clearInterval(stateHeartbeatTimer); stateHeartbeatTimer = null; }
  }
  function startAccessHeartbeat() {
    if (!stateHeartbeatTimer) stateHeartbeatTimer = setInterval(refreshAccessLease, 30000);
  }
  function startStatePolling() {
    if (!statePollTimer) statePollTimer = setInterval(pollState, 2000);
  }
  function renderNameGate() {
    const multiUse = !!collection.multi_use_link;
    const eyebrow = multiUse ? 'LINK MULTIUSO' : 'LIBERAR ENVIO';
    const heading = multiUse ? 'Antes de começar, qual é o seu nome?' : 'Qual é o seu nome?';
    const description = multiUse
      ? 'Assim quem organizou a coleta saberá de quem são os arquivos.'
      : 'Informe seu nome para identificar seus arquivos na sala e liberar o envio.';
    const note = multiUse
      ? 'O mesmo link continuará disponível para as próximas pessoas até o prazo.'
      : 'Depois de confirmar o envio, este link será encerrado.';
    root.classList.add('is-name-gate');
    root.innerHTML = '<section class="collection-name-gate" aria-labelledby="collectionNameHeading"><div class="collection-name-gate-icon"><i class="fas fa-user-pen" aria-hidden="true"></i></div><p class="collection-eyebrow">' + eyebrow + '</p><h1 id="collectionNameHeading">' + heading + '</h1><p>' + description + '</p><form data-sender-name-form><label class="collection-sender-field"><span>Seu nome <b>obrigatório</b></span><input id="collectionSenderName" name="participant_name" type="text" maxlength="80" autocomplete="name" placeholder="Digite seu nome" value="' + esc(senderName) + '" required></label><button class="btn btn-primary" type="submit"><i class="fas fa-arrow-right"></i> Continuar</button></form><small>' + note + '</small></section>';
  }
  function showSubmitting(message) {
    collection = null; collectionSignature = ''; busy = false;
    root.classList.remove('is-name-gate');
    root.innerHTML = '<div class="collection-complete"><i class="fas fa-spinner fa-spin"></i><h1>Confirmando envio</h1><p>' + esc(message || 'O envio está sendo confirmado. A página será atualizada automaticamente.') + '</p></div>';
  }
  function showClosed(message, state = 'closed') {
    stopStatePolling();
    stopAccessHeartbeat();
    if (['submitted', 'suspended', 'expired', 'replaced', 'invalid', 'closed'].includes(state)) clearSenderDraft();
    root.classList.remove('is-name-gate');
    pendingFiles.forEach(entry => URL.revokeObjectURL(entry.previewUrl)); pendingFiles = [];
    const reasons = {
      submitted: ['fa-circle-check', 'Envio concluído', 'Seus arquivos foram recebidos. Este link foi encerrado após o envio.'],
      suspended: ['fa-ban', 'Envio suspenso', 'O organizador suspendeu este link. Ele não aceita novos arquivos.'],
      expired: ['fa-clock', 'Prazo encerrado', 'O envio não foi concluído dentro do prazo.'],
      replaced: ['fa-link-slash', 'Link substituído', 'O organizador gerou outro link. Peça o endereço mais recente para enviar.'],
      in_use: ['fa-user-lock', 'Link em uso', 'Outra pessoa está usando este link no momento. Tente novamente quando ela sair.'],
      invalid: ['fa-link-slash', 'Link indisponível', 'Este endereço está incompleto ou não é válido.'],
      closed: ['fa-link-slash', 'Link encerrado', 'Este link não aceita novos envios.']
    };
    const reason = reasons[state] || reasons.closed;
    const retry = state === 'in_use' ? '<button class="btn btn-outline" type="button" data-retry-access><i class="fas fa-rotate"></i> Tentar novamente</button>' : '';
    root.innerHTML = '<div class="collection-complete is-' + esc(state) + '"><i class="fas ' + reason[0] + '"></i><p class="collection-close-eyebrow">STATUS DO LINK</p><h1>' + reason[1] + '</h1><p>' + esc(message || reason[2]) + '</p>' + retry + '</div>';
    if (state === 'in_use') startStatePolling();
  }
  function showMultiUseSuccess() {
    stopStatePolling(); stopAccessHeartbeat();
    pendingFiles.forEach(entry => URL.revokeObjectURL(entry.previewUrl)); pendingFiles = [];
    clearSenderDraft();
    root.classList.remove('is-name-gate');
    root.innerHTML = '<div class="collection-complete is-submitted"><i class="fas fa-circle-check"></i><p class="collection-close-eyebrow">ENVIO RECEBIDO</p><h1>Obrigado, ' + esc(senderName) + '!</h1><p>Seus arquivos foram entregues. O link continua aberto até o prazo para outras pessoas enviarem os delas.</p><button class="btn btn-primary" type="button" data-next-sender><i class="fas fa-user-plus"></i> Preparar outro envio</button></div>';
    collection = null; collectionSignature = ''; reviewing = false; busy = false; nameConfirmed = false;
  }
  function readyUploads(itemId) { return (collection.uploads || []).filter(file => file.item_id === itemId && file.status === 'ready'); }
  function uploadIsActive(file) {
    const timestamp = new Date(String(file.uploaded_at || '').replace(' ', 'T') + (String(file.uploaded_at || '').endsWith('Z') ? '' : 'Z')).getTime();
    return file.status === 'uploading' && Number.isFinite(timestamp) && Date.now() - timestamp < UPLOAD_STALE_MS;
  }
  function selectedFiles(itemId) { return pendingFiles.map((entry, index) => ({ ...entry, index })).filter(entry => entry.itemId === itemId); }
  function itemFileCount(itemId) { return readyUploads(itemId).length + selectedFiles(itemId).length; }
  function requestedQuantity(item) { return Math.max(1, Number(item.quantity) || 1); }
  function missingRequired() {
    return collection.items.filter(item => Number(item.required) && itemFileCount(item.id) < requestedQuantity(item));
  }
  function previewMarkup(entry) {
    const type = String(entry.file.type || '').toLowerCase();
    const image = type.startsWith('image/');
    const canPreview = image || type === 'application/pdf' || type.startsWith('video/') || type.startsWith('audio/');
    return (image ? '<img class="collection-preview-thumb" src="' + esc(entry.previewUrl) + '" alt="Prévia de ' + esc(entry.file.name) + '">' : '<i class="fas ' + (type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-lines') + ' collection-preview-icon" aria-hidden="true"></i>') +
      '<span class="collection-file-preview-info"><strong>' + esc(entry.file.name) + '</strong><small>' + sizeLabel(entry.file.size) + '</small>' +
      (canPreview ? '<a href="' + esc(entry.previewUrl) + '" target="_blank" rel="noopener">Visualizar</a>' : '') + '</span>';
  }
  function itemMarkup(item) {
    const saved = (collection.uploads || []).filter(file => file.item_id === item.id);
    const queued = selectedFiles(item.id);
    const quantity = requestedQuantity(item);
    const current = Math.min(itemFileCount(item.id), quantity);
    return '<div class="collection-request-item" data-request-item="' + esc(item.id) + '"><div class="collection-request-item-head"><div><strong>' + esc(item.label) + '</strong><small class="collection-quantity-progress">' + current + ' de ' + quantity + ' selecionado' + (quantity === 1 ? '' : 's') + '</small></div><span class="' + (Number(item.required) ? 'collection-required' : 'collection-optional') + '">' + (Number(item.required) ? 'Obrigatório' : 'Opcional') + (quantity > 1 ? ' · ' + quantity + ' arquivos' : '') + '</span></div>' +
      '<label class="collection-drop-zone" data-drop-item="' + esc(item.id) + '"><i class="fas fa-cloud-arrow-up" aria-hidden="true"></i><span><strong>Arraste os arquivos aqui</strong><small>ou toque para escolher no celular</small></span><input type="file" multiple data-item-id="' + esc(item.id) + '" ' + (busy ? 'disabled' : '') + ' aria-label="Escolher arquivos para ' + esc(item.label) + '"></label>' +
      '<div class="collection-selected-list">' + saved.map(file => {
        const active = uploadIsActive(file);
        const status = file.status === 'uploading' ? (active ? ' · envio em andamento em outra aba' : ' · envio interrompido') : ' · pronto';
        return '<div class="collection-saved-file"><i class="fas fa-file-circle-check" aria-hidden="true"></i><span>' + esc(file.original_name) + '<small>' + sizeLabel(file.size) + status + '</small></span><button type="button" data-remove-upload="' + esc(file.id) + '" title="Remover este arquivo" aria-label="Remover este arquivo" ' + (busy || active ? 'disabled' : '') + '><i class="fas fa-xmark"></i></button></div>';
      }).join('') +
      queued.map(entry => '<div class="collection-preview-card">' + previewMarkup(entry) + '<button type="button" data-remove-selected="' + entry.index + '" title="Remover da seleção" aria-label="Remover ' + esc(entry.file.name) + ' da seleção" ' + (busy ? 'disabled' : '') + '><i class="fas fa-xmark"></i></button></div>').join('') +
      '</div></div>';
  }
  function reviewMarkup() {
    const groups = collection.items.map(item => {
      const saved = readyUploads(item.id).map(file => file.original_name);
      const queued = selectedFiles(item.id).map(entry => entry.file.name);
      const names = saved.concat(queued);
      return '<li><strong>' + esc(item.label) + (requestedQuantity(item) > 1 ? ' · ' + names.length + '/' + requestedQuantity(item) : '') + ':</strong> ' + (names.length ? names.map(esc).join(', ') : '<span>nenhum arquivo' + (Number(item.required) ? ' · obrigatório' : ' · opcional') + '</span>') + '</li>';
    }).join('');
    return '<div class="collection-review"><h2><i class="fas fa-clipboard-check"></i> Revise antes de confirmar</h2><p>Confira os arquivos. ' + (collection.multi_use_link ? 'Depois da confirmação, este envio será registrado e o link continuará ativo até o prazo.' : 'Depois da confirmação, este link será encerrado.') + '</p><ul>' + groups + '</ul></div>';
  }
  function render() {
    if (!collection) return;
    root.classList.remove('is-name-gate');
    if ((collection.multi_use_link || collection.single_link) && !nameConfirmed) return renderNameGate();
    const requiredMissing = missingRequired();
    const savedCount = (collection.uploads || []).length;
    root.innerHTML = '<div class="collection-title-row"><span class="collection-title-icon"><i class="fas fa-inbox"></i></span><div><p class="collection-eyebrow">ENVIO SEGURO</p><h1>' + esc(collection.title) + '</h1></div></div>' +
      (collection.multi_use_link || collection.single_link ? '<p class="collection-public-intro">Olá, ' + esc(senderName) + '. Prepare os arquivos solicitados abaixo.</p>' : '<p class="collection-public-intro">Olá, ' + esc(collection.participant_name) + '. Prepare os arquivos solicitados abaixo.</p>') +
      (collection.exclusive_access ? '<p class="collection-exclusive-notice"><i class="fas fa-user-lock" aria-hidden="true"></i> Acesso exclusivo: enquanto você estiver usando este link, outras pessoas não poderão entrar.</p>' : '') +
      (collection.instructions ? '<section class="collection-request-instructions" aria-label="Instruções de quem pediu"><div><i class="fas fa-circle-info" aria-hidden="true"></i><strong>Instruções de quem pediu</strong></div><p>' + esc(collection.instructions) + '</p></section>' : '') +
      '<div class="collection-deadline"><i class="fas fa-clock"></i><span>Prazo <strong>' + esc(dateLabel(collection.expires_at)) + '</strong></span><span class="collection-deadline-separator"></span><span>Limite <strong>' + sizeLabel(collection.max_upload_bytes) + '</strong> por arquivo</span></div>' +
      '<div class="collection-request-list">' + collection.items.map(itemMarkup).join('') + '</div>' +
      (reviewing ? reviewMarkup() : '') +
      '<div class="collection-upload-progress" id="collectionUploadProgress" aria-live="polite"></div>' +
      '<div class="collection-public-actions">' +
        (reviewing ? '<button class="btn btn-outline" type="button" data-back><i class="fas fa-arrow-left"></i> Voltar</button><button class="btn btn-primary" type="button" data-confirm ' + (requiredMissing.length || busy ? 'disabled' : '') + '><i class="fas fa-lock"></i> Confirmar envio</button>' : '<button class="btn btn-primary" type="button" data-review ' + (busy ? 'disabled' : '') + '><i class="fas fa-eye"></i> Revisar seleção ' + (savedCount ? '(' + savedCount + ' pronto' + (savedCount === 1 ? '' : 's') + ')' : '') + '</button>') +
      '</div>' + (requiredMissing.length ? '<div class="collection-public-meta collection-missing"><i class="fas fa-circle-exclamation"></i> Ainda faltam: ' + requiredMissing.map(item => esc(item.label) + (requestedQuantity(item) > 1 ? ' (' + itemFileCount(item.id) + '/' + requestedQuantity(item) + ')' : '')).join(', ') + '</div>' : '');
  }
  function putWithProgress(url, file, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = event => { if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total); };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Falha no envio (' + xhr.status + ').'));
      xhr.onerror = () => reject(new Error('Falha de rede durante o envio.'));
      xhr.onabort = () => reject(new Error('O envio foi interrompido.'));
      const abort = () => xhr.abort();
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { xhr.abort(); return; }
      }
      xhr.send(file);
    });
  }
  async function uploadOne(entry, onProgress) {
    if (!collection.blob_enabled) {
      const form = new FormData(); form.append('file', entry.file, entry.file.name); form.append('item_id', entry.itemId);
      const response = await fetch(base + '/upload', { method: 'POST', body: form, credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Não foi possível enviar ' + entry.file.name + '.');
      return data;
    }
    const reserved = await api(base + '/reservar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      item_id: entry.itemId, name: entry.file.name, size: entry.file.size, mime: entry.file.type
    }) });
    const abortController = new AbortController();
    let lastProgressAt = Date.now(), lastLoaded = -1, stalled = false;
    let heartbeatPending = false;
    const heartbeat = async () => {
      if (heartbeatPending || Date.now() - lastProgressAt > 30000) return;
      heartbeatPending = true;
      try {
        await api(base + '/upload-heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: reserved.id }), signal: abortController.signal });
      } catch (_) {
      } finally {
        heartbeatPending = false;
      }
    };
    const reportProgress = (loaded, total) => {
      if (Number(loaded) !== lastLoaded) { lastLoaded = Number(loaded); lastProgressAt = Date.now(); }
      if (Number(total) > 0) onProgress(Math.min(100, Math.round(Number(loaded) / Number(total) * 100)));
    };
    const heartbeatTimer = setInterval(heartbeat, 15000);
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt <= UPLOAD_STALL_TIMEOUT_MS) return;
      stalled = true;
      abortController.abort();
    }, 5000);
    try {
      if (reserved.multipart) {
        const { uploadPresigned } = await import('https://esm.sh/@vercel/blob@2.8.0/client?bundle');
        await uploadPresigned(reserved.pathname, entry.file, {
          access: 'private', handleUploadUrl: base + '/upload-token', clientPayload: JSON.stringify({ uploadId: reserved.id }), multipart: true,
          abortSignal: abortController.signal,
          onUploadProgress: event => reportProgress(event.loaded, event.total)
        });
      } else {
        await putWithProgress(reserved.presignedUrl, entry.file, reportProgress, abortController.signal);
      }
      lastProgressAt = Date.now();
      await heartbeat();
      return await api(base + '/registrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: reserved.id }) });
    } catch (error) {
      clearInterval(heartbeatTimer);
      clearInterval(stallTimer);
      abortController.abort();
      const state = await api(base).catch(() => null);
      const saved = state && Array.isArray(state.uploads) && state.uploads.find(file => file.id === reserved.id && file.status === 'ready');
      if (saved) return { success: true, id: reserved.id, recovered: true };
      const cancelled = await api(base + '/uploads/' + encodeURIComponent(reserved.id) + '/cancel', { method: 'POST' }).catch(() => null);
      if (cancelled && cancelled.ready) return { success: true, id: reserved.id, recovered: true };
      if (stalled) error.message = 'O envio ficou sem progresso e foi cancelado. Remova o arquivo e tente novamente.';
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      clearInterval(stallTimer);
    }
  }
  function addFiles(itemId, fileList) {
    if (!collection || busy) return;
    const item = collection.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const files = Array.from(fileList || []);
    const currentItemCount = itemFileCount(itemId);
    const available = Math.max(0, requestedQuantity(item) - currentItemCount);
    const totalAvailable = Math.max(0, 200 - (collection.uploads || []).length - pendingFiles.length);
    if (!available || !totalAvailable) { showMessage('A quantidade solicitada para este item já foi selecionada.'); return; }
    const allowed = [];
    for (const file of files) {
      if (file.size > Number(collection.max_upload_bytes)) { showMessage(file.name + ' excede o limite de ' + sizeLabel(collection.max_upload_bytes) + '.'); continue; }
      if (allowed.length >= available || allowed.length >= totalAvailable) break;
      allowed.push(file);
    }
    if (files.length > allowed.length && allowed.length) showMessage('Foram adicionados ' + allowed.length + ' arquivos para completar a quantidade solicitada.');
    if (allowed.length) {
      pendingFiles.push(...allowed.map(file => ({ itemId, file, previewUrl: URL.createObjectURL(file) })));
      reviewing = false; render();
    }
  }
  async function finalizeSubmission() {
    if (busy) return;
    const missing = missingRequired();
    if (missing.length) { showMessage('Selecione a quantidade solicitada para: ' + missing.map(item => item.label + ' (' + itemFileCount(item.id) + '/' + requestedQuantity(item) + ')').join(', ')); return; }
    if (collection.single_link || collection.multi_use_link) {
      senderName = String(document.getElementById('collectionSenderName')?.value || senderName).trim().replace(/\s+/g, ' ');
      if (!senderName) { showMessage('Informe seu nome para continuar.'); document.getElementById('collectionSenderName')?.focus(); return; }
    }
    busy = true; render();
    try {
      const queue = pendingFiles.slice();
      for (let index = 0; index < queue.length; index++) {
        const entry = queue[index];
        const progress = document.getElementById('collectionUploadProgress');
        const update = percent => { if (progress) progress.textContent = 'Enviando ' + entry.file.name + (percent == null ? '…' : ' · ' + percent + '%'); };
        update(0);
        await uploadOne(entry, update);
        const queuedIndex = pendingFiles.findIndex(item => item.file === entry.file && item.itemId === entry.itemId);
        if (queuedIndex >= 0) pendingFiles.splice(queuedIndex, 1);
        URL.revokeObjectURL(entry.previewUrl);
      }
      const progress = document.getElementById('collectionUploadProgress'); if (progress) progress.textContent = 'Confirmando o envio…';
      stopAccessHeartbeat();
      await api(base + '/finalizar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ participant_name: senderName }) });
      if (collection.multi_use_link) showMultiUseSuccess();
      else showClosed('Seus arquivos foram recebidos e o link foi encerrado após o envio.', 'submitted');
    } catch (error) {
      if (error.state === 'submitted') return showClosed(error.message, 'submitted');
      if (error.state === 'submitting') { busy = false; return loadState(); }
      if (error.state) return showClosed(error.message, error.state);
      if (error.message.includes('prazo') || error.message.includes('encerrado')) return showClosed(error.message, 'closed');
      busy = false;
      try { await loadState(); } catch (loadError) { if (loadError.state) return showClosed(loadError.message, loadError.state); }
      render(); showMessage(error.message || 'Não foi possível concluir o envio.');
    }
  }
  async function loadState() {
    if (stateFetchPromise) return stateFetchPromise;
    stateFetchPromise = (async () => {
      const data = await api(base);
      if (data.state === 'submitting') { showSubmitting(data.message); return; }
      const signature = JSON.stringify(data);
      if (signature !== collectionSignature) { collectionSignature = signature; collection = data; if (!busy) render(); }
      if (data.exclusive_access) startAccessHeartbeat();
    })();
    try { await stateFetchPromise; }
    finally { stateFetchPromise = null; }
  }
  async function pollState() {
    if (!statePollTimer || document.hidden || busy || stateFetchPromise) return;
    try { await loadState(); }
    catch (error) { if (error.state) showClosed(error.message, error.state); }
  }
  async function refreshAccessLease() {
    if (!collection || !collection.exclusive_access) return;
    try { await api(base + '/heartbeat', { method: 'POST' }); }
    catch (error) { if (error.state) showClosed(error.message, error.state); }
  }
  root.addEventListener('input', event => {
    if (event.target.id === 'collectionSenderName') { senderName = event.target.value; persistSenderDraft(false); }
  });
  root.addEventListener('submit', event => {
    if (!event.target.matches('[data-sender-name-form]')) return;
    event.preventDefault();
    senderName = String(event.target.querySelector('#collectionSenderName')?.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!senderName) { showMessage('Informe seu nome para continuar.'); event.target.querySelector('#collectionSenderName')?.focus(); return; }
    nameConfirmed = true;
    persistSenderDraft(true);
    render();
  });
  root.addEventListener('change', event => {
    const input = event.target.closest('input[type=file][data-item-id]');
    if (!input) return;
    const files = Array.from(input.files || []); input.value = ''; addFiles(input.dataset.itemId, files);
  });
  root.addEventListener('dragover', event => {
    const zone = event.target.closest('[data-drop-item]');
    if (!zone || busy) return;
    event.preventDefault(); zone.classList.add('is-dragging');
  });
  root.addEventListener('dragleave', event => {
    const zone = event.target.closest('[data-drop-item]');
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('is-dragging');
  });
  root.addEventListener('drop', event => {
    const zone = event.target.closest('[data-drop-item]');
    if (!zone || busy) return;
    event.preventDefault(); zone.classList.remove('is-dragging'); addFiles(zone.dataset.dropItem, event.dataTransfer.files);
  });
  root.addEventListener('click', async event => {
    if (event.target.closest('[data-retry-access]')) {
      collectionSignature = '';
      root.innerHTML = '<div class="collection-complete"><i class="fas fa-spinner fa-spin"></i><h1>Verificando acesso</h1><p>Aguarde enquanto verificamos se o link está disponível.</p></div>';
      loadState().then(startStatePolling).catch(error => showClosed(error.message, error.state || 'closed'));
      return;
    }
    if (event.target.closest('[data-next-sender]')) {
      senderName = ''; nameConfirmed = false; collectionSignature = ''; collection = null;
      clearSenderDraft();
      root.innerHTML = '<div class="collection-complete"><i class="fas fa-spinner fa-spin"></i><h1>Preparando o próximo envio</h1><p>Verificando se o link está disponível.</p></div>';
      try { await loadState(); startStatePolling(); }
      catch (error) { showClosed(error.message, error.state || 'closed'); }
      return;
    }
    const removeSelected = event.target.closest('[data-remove-selected]');
    if (removeSelected) { const [removed] = pendingFiles.splice(Number(removeSelected.dataset.removeSelected), 1); if (removed) URL.revokeObjectURL(removed.previewUrl); render(); return; }
    const removeUpload = event.target.closest('[data-remove-upload]');
    if (removeUpload) {
      removeUpload.disabled = true;
      try { await api(base + '/uploads/' + encodeURIComponent(removeUpload.dataset.removeUpload), { method: 'DELETE' }); await loadState(); }
      catch (error) {
        if (error.state) showClosed(error.message, error.state);
        else { removeUpload.disabled = false; showMessage(error.message); }
      }
      return;
    }
    if (event.target.closest('[data-review]')) {
      if (collection.single_link || collection.multi_use_link) {
        senderName = String(document.getElementById('collectionSenderName')?.value || senderName).trim().replace(/\s+/g, ' ');
        if (!senderName) { showMessage('Informe seu nome para continuar.'); document.getElementById('collectionSenderName')?.focus(); return; }
      }
      const missing = missingRequired();
      if (missing.length) { showMessage('Selecione a quantidade solicitada para: ' + missing.map(item => item.label + ' (' + itemFileCount(item.id) + '/' + requestedQuantity(item) + ')').join(', ')); return; }
      reviewing = true; render(); return;
    }
    if (event.target.closest('[data-back]')) { reviewing = false; render(); return; }
    if (event.target.closest('[data-confirm]')) await finalizeSubmission();
  });
  if (!COLLECTION_TOKEN_RE.test(token)) return showClosed('O endereço do link está incompleto ou inválido.', 'invalid');
  loadState().catch(error => showClosed(error.message, error.state || 'closed'));
  startStatePolling();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollState(); });
})();
