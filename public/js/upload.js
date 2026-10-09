// Envio de arquivos para uma sala.
// Arquivos até 100 MB usam URL assinada; acima disso, upload multipart direto ao Blob (limite 50 GB).
// Reserva (servidor sem Blob, ex.: rodando local sem `vercel env pull`): envio pelo servidor.
// O limite por arquivo vem do servidor (/api/me → max_upload_bytes), então o aviso nunca fica desatualizado.
(function () {
  let limitBytes = null;
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
    .then(u => { if (u && u.max_upload_bytes) limitBytes = Number(u.max_upload_bytes); window.fillLimitNotes(); })
    .catch(() => {});

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

  async function legacyUpload(roomId, files) {
    const max = limitBytes || 4 * 1024 * 1024;
    for (const file of files) {
      if (file.size > max) throw new Error('Limite de ' + sizeLabel(max) + ' por arquivo neste ambiente.');
      const form = new FormData();
      form.append('files', file);
      const response = await fetch('/api/rooms/' + roomId + '/files', { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Erro ao enviar arquivos');
    }
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
          '<button type="submit" class="btn btn-green">Enviar ' + items.length + (items.length === 1 ? ' arquivo' : ' arquivos') + '</button></div></form>';
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

  // Devolve { sent, skipped }
  const _uploadInner = async function (roomId, fileList, onStatus) {
    let all = Array.from(fileList); // copia já: o <input> pode ser limpo logo depois
    all = await window.confirmUpload(all);
    if (!all) return { sent: 0, skipped: [], cancelled: true };
    const say = onStatus || function () {};
    await limitReady;
    const files = [], skipped = [];
    all.forEach(f => {
      if (!f.size) skipped.push({ name: f.name, reason: 'vazio' });
      else if (limitBytes && f.size > limitBytes) skipped.push({ name: f.name, reason: 'grande demais' });
      else files.push(f);
    });
    let sent = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = '(' + (i + 1) + '/' + files.length + ') ' + file.name;
      say('Enviando ' + label + '...');
      let pathname;
      if (file.size > 100 * 1024 * 1024) {
        try {
          const { uploadPresigned } = await import('https://esm.sh/@vercel/blob@2.8.0/client?bundle');
          const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'arquivo';
          const objectPath = 'rooms/' + roomId + '/' + crypto.randomUUID() + '-' + safe;
          const blob = await uploadPresigned(objectPath, file, {
            access: 'private',
            handleUploadUrl: '/api/rooms/' + roomId + '/upload-token',
            clientPayload: JSON.stringify({ size: file.size }),
            multipart: true,
            onUploadProgress: event => say('Enviando ' + label + ' ' + Math.round(event.percentage) + '%')
          });
          pathname = blob.pathname;
        } catch (error) {
          throw new Error(error && error.message ? error.message : 'Falha no envio multipart. Confira sua conexão e tente novamente.');
        }
      } else {
        const prep = await postJson('/api/rooms/' + roomId + '/upload-url', { name: file.name, size: file.size, type: file.type });
        if (prep.status === 501) {
          const rest = files.slice(i);
          await legacyUpload(roomId, rest);
          return { sent: sent + rest.length, skipped };
        }
        if (!prep.ok) throw new Error(prep.data.error || 'Falha ao preparar o envio');
        // URL pre-assinada: o servidor valida e devolve um link PUT; enviamos o arquivo
        // direto ao Blob (mesmo fluxo estavel das Coletas, sem callback de token do SDK).
        if (!prep.data.presignedUrl) throw new Error('Falha ao preparar o envio (link indisponivel).');
        await putWithProgress(prep.data.presignedUrl, file, percent => say('Enviando ' + label + ' ' + percent + '%'));
        pathname = prep.data.pathname;
      }
      const done = await postJson('/api/rooms/' + roomId + '/files/register', {
        pathname, name: file.name, size: file.size, mime: file.type
      });
      if (!done.ok) throw new Error(done.data.error || 'Falha ao registrar o arquivo');
      sent++;
    }
    return { sent, skipped };
  };
  window.__fsBusy = 0;
  window.uploadToRoom = async function (roomId, fileList, onStatus) {
    window.__fsBusy++;
    try { return await _uploadInner(roomId, fileList, onStatus); }
    finally { window.__fsBusy = Math.max(0, window.__fsBusy - 1); }
  };
})();
