// Envio de arquivos para uma sala.
// Caminho principal: direto do navegador para o Vercel Blob (arquivos de até 100 MB).
// Reserva (servidor sem Blob, ex.: rodando local sem `vercel env pull`): envio pelo servidor.
// O limite por arquivo vem do servidor (/api/me → max_upload_bytes), então o aviso nunca fica desatualizado.
(function () {
  let limitBytes = null;
  const mbLabel = b => { const mb = b / 1048576; return (Number.isInteger(mb) || mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + ' MB'; };

  window.limitLabel = () => (limitBytes ? mbLabel(limitBytes) : '…');
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
    if (files.reduce((sum, f) => sum + f.size, 0) > max) {
      throw new Error('Limite de ' + mbLabel(max) + ' por envio neste ambiente.');
    }
    const form = new FormData();
    files.forEach(f => form.append('files', f));
    const response = await fetch('/api/rooms/' + roomId + '/files', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Erro ao enviar arquivos');
  }

  // Texto de aviso para arquivos que ficaram de fora (grandes demais, vazios ou pastas)
  window.skippedMessage = function (result) {
    if (!result || !result.skipped || !result.skipped.length) return '';
    const names = result.skipped.map(s => s.name).slice(0, 3).join(', ');
    const more = result.skipped.length > 3 ? ' e mais ' + (result.skipped.length - 3) : '';
    return 'Não enviado: ' + names + more + ' (limite de ' + window.limitLabel() + ' por arquivo; pastas e arquivos vazios não valem)';
  };

  // Devolve { sent, skipped }
  window.uploadToRoom = async function (roomId, fileList, onStatus) {
    const all = Array.from(fileList); // copia já: o <input> pode ser limpo logo depois
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
      const prep = await postJson('/api/rooms/' + roomId + '/upload-url', { name: file.name, size: file.size, type: file.type });
      if (prep.status === 501) {
        const rest = files.slice(i);
        await legacyUpload(roomId, rest);
        return { sent: sent + rest.length, skipped };
      }
      if (!prep.ok) throw new Error(prep.data.error || 'Falha ao preparar o envio');
      await putWithProgress(prep.data.presignedUrl, file, p => say('Enviando ' + label + ' ' + p + '%'));
      const done = await postJson('/api/rooms/' + roomId + '/files/register', {
        pathname: prep.data.pathname, name: file.name, size: file.size, mime: file.type
      });
      if (!done.ok) throw new Error(done.data.error || 'Falha ao registrar o arquivo');
      sent++;
    }
    return { sent, skipped };
  };
})();
