// Envio de arquivos para uma sala.
// Arquivos até 100 MB usam Google Drive em blocos autenticados ou URL Blob; arquivos maiores usam Blob multipart.
// Reserva (servidor sem Blob, ex.: rodando local sem `vercel env pull`): envio pelo servidor.
// O limite por arquivo vem do servidor (/api/me → max_upload_bytes), então o aviso nunca fica desatualizado.
(function () {
  let limitBytes = null;
  let currentUserId = '';
  let driveUploadEnabled = false;
  let blobUploadEnabled = false;
  const sizeLabel = b => {
    const gb = b / (1024 ** 3);
    if (gb >= 1) return (Number.isInteger(gb) ? gb : gb.toFixed(1)) + ' GB';
    const mb = b / 1048576;
    return (Number.isInteger(mb) || mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + ' MB';
  };

  window.limitLabel = () => (limitBytes ? sizeLabel(limitBytes) : '…');
  window.fillLimitNotes = () => document.querySelectorAll('.limit-note').forEach(el => { el.textContent = window.limitLabel(); });

  const limitReady = fetch('/api/me')
    .then(r => r.json())
    .then(u => { if (u && u.max_upload_bytes) limitBytes = Number(u.max_upload_bytes); if (u && u.id) currentUserId = String(u.id); driveUploadEnabled = Boolean(u && u.drive_upload_enabled); blobUploadEnabled = Boolean(u && u.blob_upload_enabled); window.fillLimitNotes(); })
    .catch(() => {});
  const driveChunkSize = 4 * 1024 * 1024;

  function putWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
        ? resolve()
        : reject(new Error('Falha no envio (' + xhr.status + ')'));
      xhr.onerror = () => reject(new Error('Falha de rede durante o envio'));
      xhr.send(file);
    });
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
  }

  async function uploadDriveInChunks(session, file, onProgress) {
    const chunkSize = Number(session.chunk_bytes) || driveChunkSize;
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + chunkSize, file.size);
      const chunk = file.slice(offset, end);
      const response = await fetch('/api/google-drive/uploads/' + encodeURIComponent(session.upload_id) + '/chunk', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + file.size }, body: chunk
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Falha ao enviar bloco ao Google Drive.');
      offset = Number(result.next_offset);
      if (!Number.isSafeInteger(offset) || offset <= 0 || offset > file.size) throw new Error('O Google Drive retornou uma posição de envio inválida.');
      if (onProgress) onProgress(Math.round(offset / file.size * 100));
    }
  }

  function postFormWithProgress(url, form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = event => { if (event.lengthComputable && onProgress) onProgress(Math.round(event.loaded / event.total * 100)); };
      xhr.onload = () => {
        const data = (() => { try { return JSON.parse(xhr.responseText || '{}'); } catch (_) { return {}; } })();
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Erro ao enviar arquivos (' + xhr.status + ')'));
      };
      xhr.onerror = () => reject(new Error('Falha de rede durante o envio'));
      xhr.send(form);
    });
  }

  async function legacyUpload(roomId, files, onProgress) {
    const max = limitBytes || 4 * 1024 * 1024;
    const inserted = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > max) throw new Error('Limite de ' + sizeLabel(max) + ' por arquivo neste ambiente.');
      const form = new FormData();
      form.append('files', file);
      const data = await postFormWithProgress('/api/rooms/' + roomId + '/files', form, onProgress && (percent => onProgress(i, percent)));
      if (Array.isArray(data)) inserted.push(...data);
      else if (data && data.id) inserted.push(data);
    }
    return inserted;
  }

  // Texto de aviso para arquivos que ficaram de fora (grandes demais, vazios ou pastas)
  window.skippedMessage = function (result) {
    if (!result || !result.skipped || !result.skipped.length) return '';
    const names = result.skipped.map(s => s.name).slice(0, 3).join(', ');
    const more = result.skipped.length > 3 ? ' e mais ' + (result.skipped.length - 3) : '';
    return 'Não enviado: ' + names + more + ' (limite de ' + window.limitLabel() + ' por arquivo; pastas e arquivos vazios não valem)';
  };

  // Tela de confirmação antes de enviar: renomear, remover e ver prévia de imagens.
  // Devolve a lista final de File (renomeados) ou null se cancelou.
  window.confirmUpload = function (files) {
    return new Promise(resolve => {
      const items = files.map(f => {
        const dot = f.name.lastIndexOf('.');
        const ext = dot > 0 && f.name.length - dot <= 8 ? f.name.slice(dot) : '';
        return { file: f, ext, base: ext ? f.name.slice(0, dot) : f.name, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : null };
      });
      const e2 = t => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
      const wrap = document.createElement('div');
      wrap.className = 'rename-modal confirm-modal';
      document.body.appendChild(wrap);
      const finish = val => { items.forEach(i => i.url && URL.revokeObjectURL(i.url)); document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(val); };
      const onKey = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(null); } };
      document.addEventListener('keydown', onKey, true);
      function render() {
        wrap.innerHTML =
          '<div class="rename-overlay"></div><form class="rename-box confirm-box">' +
          '<h3><i class="fas fa-paper-plane"></i> Confirmar envio</h3>' +
          '<div class="confirm-list">' + items.map((it, i) =>
            '<div class="confirm-item">' +
              (it.url ? '<img class="confirm-thumb" src="' + it.url + '" alt="prévia">' : '<div class="confirm-thumb confirm-icon"><i class="fas fa-file"></i><span>' + e2((it.ext || '').slice(1).toUpperCase() || 'ARQ') + '</span></div>') +
              '<div class="confirm-info"><div class="rename-field"><input type="text" data-i="' + i + '" maxlength="150" required autocomplete="off" value="' + e2(it.base).replace(/"/g, '&quot;') + '">' +
              (it.ext ? '<span class="rename-ext">' + e2(it.ext) + '</span>' : '') + '</div>' +
              '<small>' + e2(window.fileKind ? window.fileKind(it.file.name, it.file.type) : '') + ' · ' + sizeLabel(it.file.size) + '</small></div>' +
              '<button type="button" class="btn btn-sm btn-outline confirm-del" data-del="' + i + '" title="Remover"><i class="fas fa-xmark"></i></button>' +
            '</div>').join('') + '</div>' +
          '<div class="rename-actions"><button type="button" class="btn btn-outline rename-cancel">Cancelar</button>' +
          '<button type="submit" class="btn btn-green btn-upload">Enviar ' + items.length + (items.length === 1 ? ' arquivo' : ' arquivos') + '</button></div></form>';
        wrap.querySelector('.rename-overlay').onclick = () => finish(null);
        wrap.querySelector('.rename-cancel').onclick = () => finish(null);
        wrap.querySelectorAll('input[data-i]').forEach(inp => inp.oninput = () => { items[inp.dataset.i].base = inp.value; });
        wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const it = items.splice(Number(b.dataset.del), 1)[0]; if (it.url) URL.revokeObjectURL(it.url); if (!items.length) finish(null); else render(); });
        wrap.querySelector('form').onsubmit = ev => {
          ev.preventDefault();
          finish(items.map(it => {
            const name = (it.base.replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'arquivo') + it.ext;
            return name === it.file.name ? it.file : new File([it.file], name, { type: it.file.type, lastModified: it.file.lastModified });
          }));
        };
        const first = wrap.querySelector('input[data-i]'); if (first) { first.focus(); first.select(); }
      }
      render();
    });
  };

  // Devolve { sent, skipped, files }
  const _uploadInner = async function (roomId, fileList, onStatus, options) {
    options = options || {};
    let all = Array.from(fileList); // copia já: o <input> pode ser limpo logo depois
    if (!options.skipConfirm) all = await window.confirmUpload(all);
    if (!all) return { sent: 0, skipped: [], cancelled: true, files: [] };
    const say = onStatus || function () {};
    await limitReady;
    const files = [], skipped = [];
    all.forEach(f => {
      if (!f.size) skipped.push({ name: f.name, reason: 'vazio' });
      else if (limitBytes && f.size > limitBytes) skipped.push({ name: f.name, reason: 'grande demais' });
      else files.push(f);
    });
    const uploaded = [];
    let sent = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = '(' + (i + 1) + '/' + files.length + ') ' + file.name;
      say('Enviando ' + label + '...');
      const reportProgress = percent => {
        const value = Math.max(0, Math.min(100, Number(percent) || 0));
        say('Enviando ' + label + ' ' + value + '%');
        if (typeof options.onProgress === 'function') options.onProgress(value);
      };
      let pathname;
      let uploadUrl;
      let uploadCompleted = false;
      let bgKind = null;
      try {
      if (file.size > 100 * 1024 * 1024 && blobUploadEnabled) {
        bgKind = 'multipart';
        try {
          const { uploadPresigned } = await import('/js/vendor/vercel-blob-client.mjs');
          const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'arquivo';
          const objectPath = 'rooms/' + roomId + '/' + crypto.randomUUID() + '-' + safe;
          const blob = await uploadPresigned(objectPath, file, {
            access: 'private',
            handleUploadUrl: '/api/rooms/' + roomId + '/upload-token',
            clientPayload: JSON.stringify({ size: file.size }),
            multipart: true,
            onUploadProgress: event => reportProgress(event.percentage)
          });
          pathname = blob.pathname;
          uploadCompleted = true;
        } catch (error) {
          throw new Error(error && error.message ? error.message : 'Falha no envio multipart. Confira sua conexão e tente novamente.');
        }
      } else {
        if (driveUploadEnabled) {
          bgKind = 'drive';
          const prep = await postJson('/api/rooms/' + roomId + '/drive-upload-session', { name: file.name, size: file.size, mime: file.type });
          if (!prep.ok) throw new Error(prep.data.error || 'Falha ao preparar o envio ao Google Drive.');
          await uploadDriveInChunks(prep.data, file, reportProgress);
          const done = await postJson('/api/rooms/' + roomId + '/drive-files/register', { upload_id: prep.data.upload_id, chat_only: options.chatOnly ? 1 : 0 });
          if (!done.ok) throw new Error(done.data.error || 'Falha ao registrar o arquivo do Google Drive.');
          uploaded.push({ id: done.data.id, name: done.data.original_name || file.name, size: done.data.size || file.size, mime: done.data.mime_type || file.type || 'application/octet-stream' });
          sent++;
          continue;
        }
        if (!blobUploadEnabled && file.size > 100 * 1024 * 1024) throw new Error('Arquivos acima de 100 MB exigem Blob multipart, que não está disponível neste ambiente.');
        const prep = await postJson('/api/rooms/' + roomId + '/upload-url', { name: file.name, size: file.size, type: file.type });
        if (prep.status === 501) {
          const rest = files.slice(i);
          const inserted = await legacyUpload(roomId, rest, (index, percent) => { if (index === 0) reportProgress(percent); });
          (inserted || []).forEach(item => uploaded.push({ id: item.id, name: item.original_name || item.name, size: item.size || 0, mime: item.mime_type || file.type || 'application/octet-stream' }));
          sent += rest.length;
          return { sent, skipped, files: uploaded };
        }
        if (!prep.ok) throw new Error(prep.data.error || 'Falha ao preparar o envio');
        // URL pre-assinada: o servidor valida e devolve um link PUT; enviamos o arquivo
        // direto ao Blob (mesmo fluxo estavel das Coletas, sem callback de token do SDK).
        if (!prep.data.presignedUrl) throw new Error('Falha ao preparar o envio (link indisponivel).');
        uploadUrl = prep.data.presignedUrl;
        pathname = prep.data.pathname;
        await putWithProgress(uploadUrl, file, reportProgress);
        uploadCompleted = true;
      }
      const done = await postJson('/api/rooms/' + roomId + '/files/register', {
        pathname, name: file.name, size: file.size, mime: file.type, chat_only: options.chatOnly ? 1 : 0
      });
      if (!done.ok) throw new Error(done.data.error || 'Falha ao registrar o arquivo');
      uploaded.push({ id: done.data.id, name: done.data.original_name || file.name, size: done.data.size || file.size, mime: file.type || 'application/octet-stream' });
      sent++;
      } catch (error) {
        const msg = String(error && error.message ? error.message : error);
        const isNetwork = error.name === 'TypeError' || /rede|conexão|conexao|failed to fetch|network|offline|failed to execute/i.test(msg);
        if (isNetwork && ((bgKind === 'presigned' && uploadUrl && pathname) || (bgKind === 'multipart' && uploadCompleted && pathname))) {
          say('Sem conexão — arquivo enfileirado para confirmar quando voltar online.');
          const item = {
            kind: bgKind,
            stage: uploadCompleted ? 'register' : 'upload',
            roomId,
            file,
            pathname,
            uploadUrl,
            name: file.name,
            size: file.size,
            mime: file.type,
            chatOnly: !!options.chatOnly,
            replyToId: options.replyToId || null,
            ownerId: String(document.body.dataset.userId || '')
          };
          try {
            const queueId = await window.enqueueBackgroundUpload(item);
            uploaded.push({ id: 'pending', name: file.name, size: file.size, mime: file.type || 'application/octet-stream', pending: true, queueId });
            sent++;
            continue;
          } catch (enqueueError) {
            say('Falha ao enfileirar: ' + String(enqueueError && enqueueError.message ? enqueueError.message : enqueueError));
          }
        } else if (isNetwork) {
          say(bgKind === 'multipart'
            ? 'A conexão caiu durante o envio multipart. Esse arquivo não pode ser retomado em segundo plano; tente novamente.'
            : 'A conexão caiu antes da preparação segura do envio. Tente novamente quando estiver online.');
        }
        throw error;
      }
    }
    return { sent, skipped, files: uploaded };
  };
  window.__fsBusy = 0;

  // ---------------------------------------------------------------
  // Upload em segundo plano: quando a rede falha, o arquivo é
  // enfileirado no Service Worker (IndexedDB) e reenviado assim que
  // o navegador volta online (Background Sync). Funciona mesmo se a
  // aba for fechada.
  // ---------------------------------------------------------------
  async function toArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }

  window.enqueueBackgroundUpload = async function (item) {
    if (!navigator.serviceWorker) {
      throw new Error('Service Worker não está ativo.');
    }
    if (!item.ownerId) {
      const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Não foi possível confirmar a conta para o envio em segundo plano.');
      const user = await response.json();
      item.ownerId = String(user.id || '');
    }
    if (!item.ownerId) throw new Error('Não foi possível associar o envio à conta atual.');
    const needsFileBytes = item.kind === 'presigned' && item.stage === 'upload' && item.file;
    const buffer = needsFileBytes ? await toArrayBuffer(item.file) : null;
    const queuedItem = { ...item };
    // File não transferido seria clonado junto com a mensagem, duplicando RAM;
    // envie os bytes uma única vez pelo ArrayBuffer transferível.
    delete queuedItem.file;
    const registration = await navigator.serviceWorker.ready;
    const worker = navigator.serviceWorker.controller || registration.active;
    if (!worker) throw new Error('Service Worker ainda não está pronto.');
    // O ArrayBuffer viaja com a mensagem (transferable) para o SW recriar o Blob.
    const channel = new MessageChannel();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('Tempo esgotado ao salvar o upload para segundo plano.')); }, 15000);
      channel.port1.onmessage = e => {
        clearTimeout(timeout);
        channel.port1.close();
        if (e.data && e.data.type === 'fs-enqueued') resolve(e.data.id);
        else reject(new Error(e.data && e.data.error ? e.data.error : 'Falha ao enfileirar'));
      };
      channel.port1.onerror = () => { clearTimeout(timeout); channel.port1.close(); reject(new Error('Canal do Service Worker com erro.')); };
      try {
        worker.postMessage(
          { type: 'fs-enqueue-upload', item: queuedItem, buffer },
          buffer ? [channel.port2, buffer] : [channel.port2]
        );
      } catch (error) {
        clearTimeout(timeout);
        channel.port1.close();
        reject(error);
      }
    });
  };

  // Alguns navegadores não implementam Background Sync. Neles, retoma a fila
  // quando a rede volta ou quando o painel é aberto novamente.
  async function resumeQueuedUploads(throwOnError) {
    if (!navigator.onLine || !navigator.serviceWorker) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      if (registration.sync) await registration.sync.register('fs-upload-sync');
      else (navigator.serviceWorker.controller || registration.active)?.postMessage({ type: 'fs-process-uploads' });
    } catch (error) {
      console.warn('[Upload] Não foi possível retomar a fila offline:', error);
      if (throwOnError) throw error;
    }
  }
  window.addEventListener('online', resumeQueuedUploads);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resumeQueuedUploads, { once: true });
  else resumeQueuedUploads();
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', event => {
    if (!event.data) return;
    if (event.data.type === 'fs-upload-done') {
      if (window.FileShareUploadQueue) window.FileShareUploadQueue.completeBackground(event.data.id);
      const message = 'Um upload em segundo plano foi concluído.';
      if (typeof window.toast === 'function') window.toast(message, 'success');
      else if (typeof window.showToast === 'function') window.showToast(message, 'success');
      window.dispatchEvent(new CustomEvent('fileshare:background-upload-complete', { detail: event.data }));
    } else if (event.data.type === 'fs-upload-failed') {
      const message = 'Um upload pendente precisa de atenção. Entre na conta que iniciou o envio e tente novamente.';
      if (typeof window.toast === 'function') window.toast(message, 'error');
      else if (typeof window.showToast === 'function') window.showToast(message, 'error');
      if (window.FileShareUploadQueue) window.FileShareUploadQueue.failBackground(event.data.id, () => resumeQueuedUploads(true));
    }
  });

  async function uploadToRoomDirect(roomId, fileList, onStatus, options) {
    window.__fsBusy++;
    try { return await _uploadInner(roomId, fileList, onStatus, options); }
    finally { window.__fsBusy = Math.max(0, window.__fsBusy - 1); }
  }

  async function uploadToDmDirect(friendId, fileList, onStatus, options) {
    options = options || {};
    window.__fsBusy++;
    try {
      let all = Array.from(fileList);
      if (!options.skipConfirm) all = await window.confirmUpload(all);
      if (!all) return { sent: 0, skipped: [], cancelled: true, files: [] };
      const say = onStatus || function () {};
      await limitReady;
      const files = [], skipped = [];
      all.forEach(f => {
        if (!f.size) skipped.push({ name: f.name, reason: 'vazio' });
        else if (limitBytes && f.size > limitBytes) skipped.push({ name: f.name, reason: 'grande demais' });
        else files.push(f);
      });
      const uploaded = [];
      let sent = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const label = '(' + (i + 1) + '/' + files.length + ') ' + file.name;
        say('Enviando ' + label + '...');
        const reportProgress = percent => {
          const value = Math.max(0, Math.min(100, Number(percent) || 0));
          say('Enviando ' + label + ' ' + value + '%');
          if (typeof options.onProgress === 'function') options.onProgress(value);
        };
        let pathname;
        if (file.size > 100 * 1024 * 1024) {
          if (!currentUserId) throw new Error('Não foi possível identificar sua conta para preparar o upload. Atualize a página e tente novamente.');
          const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'arquivo';
          const objectPath = 'dm/' + currentUserId + '/' + crypto.randomUUID() + '-' + safe;
          const { uploadPresigned } = await import('/js/vendor/vercel-blob-client.mjs');
          const blob = await uploadPresigned(objectPath, file, {
            access: 'private',
            handleUploadUrl: '/api/dm/' + friendId + '/upload-token',
            multipart: true,
            onUploadProgress: event => reportProgress(event.percentage)
          });
          pathname = blob.pathname;
        } else {
          const prep = await postJson('/api/dm/' + friendId + '/upload-url', { name: file.name, size: file.size, type: file.type });
          if (!prep.ok) throw new Error(prep.data.error || 'Falha ao preparar o envio');
          if (!prep.data.presignedUrl) throw new Error('Falha ao preparar o envio (link indisponível).');
          await putWithProgress(prep.data.presignedUrl, file, reportProgress);
          pathname = prep.data.pathname;
        }
        const done = await postJson('/api/dm/' + friendId + '/files/register', { pathname, name: file.name, size: file.size, mime: file.type });
        if (!done.ok) throw new Error(done.data.error || 'Falha ao registrar o arquivo');
        uploaded.push({ id: done.data.id, name: done.data.original_name || file.name, size: done.data.size || file.size, mime: file.type || 'application/octet-stream' });
        sent++;
      }
      return { sent, skipped, files: uploaded };
    } finally { window.__fsBusy = Math.max(0, window.__fsBusy - 1); }
  }

  async function uploadWithQueue(fileList, destination, onStatus, options, operation) {
    options = options || {};
    let files = Array.from(fileList || []);
    if (!options.skipConfirm) files = await window.confirmUpload(files);
    if (!files) return { sent: 0, skipped: [], failed: [], cancelled: true, files: [] };
    await limitReady;
    const eligible = [], skipped = [];
    for (const file of files) {
      if (!file.size) skipped.push({ name: file.name, reason: 'vazio' });
      else if (limitBytes && file.size > limitBytes) skipped.push({ name: file.name, reason: 'grande demais' });
      else eligible.push(file);
    }
    const say = typeof onStatus === 'function' ? onStatus : function () {};
    const uploaded = [], failed = [];
    let sent = 0;
    for (let index = 0; index < eligible.length; index++) {
      const file = eligible[index];
      const taskOperation = async progress => {
        const result = await operation(file, index, eligible.length, progress);
        if (!result || result.cancelled || !result.sent || !Array.isArray(result.files) || !result.files.length) {
          throw new Error((result && window.skippedMessage(result)) || 'O servidor não confirmou o envio deste arquivo.');
        }
        const pending = result.files.find(item => item.pending);
        return pending ? { ...result, backgroundPending: true, backgroundId: pending.queueId, backgroundRetry: () => resumeQueuedUploads() } : result;
      };
      const progress = await window.FileShareUploadQueue.run(file, destination, taskOperation, {
        onSuccess: value => options.onFileSuccess ? options.onFileSuccess(value, file, index) : undefined
      });
      if (!progress.ok) { failed.push({ name: file.name, error: progress.error && progress.error.message || 'Falha no envio.' }); continue; }
      uploaded.push(...progress.value.files);
      sent += progress.value.sent;
    }
    return { sent, skipped, failed, files: uploaded };
  }

  window.uploadToRoom = function (roomId, fileList, onStatus, options) {
    options = options || {};
    if (options.skipQueue || !window.FileShareUploadQueue) return uploadToRoomDirect(roomId, fileList, onStatus, options);
    const operation = (file, index, total, progress) => uploadToRoomDirect(roomId, [file], text => {
      if (typeof onStatus === 'function') onStatus(text);
    }, { ...options, skipConfirm: true, onProgress: progress });
    return uploadWithQueue(fileList, 'Sala', onStatus, options, operation);
  };

  window.uploadToDm = function (friendId, fileList, onStatus, options) {
    options = options || {};
    if (options.skipQueue || !window.FileShareUploadQueue) return uploadToDmDirect(friendId, fileList, onStatus, options);
    const operation = (file, index, total, progress) => uploadToDmDirect(friendId, [file], text => {
      if (typeof onStatus === 'function') onStatus(text);
    }, { ...options, skipConfirm: true, onProgress: progress });
    return uploadWithQueue(fileList, 'Conversa direta', onStatus, options, operation);
  };
})();
