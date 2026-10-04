// Envio de arquivos para uma sala.
// Caminho principal: direto do navegador para o Vercel Blob (arquivos de até 100 MB).
// Reserva (servidor sem Blob, ex.: rodando local sem `vercel env pull`): envio pelo servidor, até 4 MB.
(function () {
  const MAX_LEGACY = 4 * 1024 * 1024;

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
    if (files.reduce((sum, f) => sum + f.size, 0) > MAX_LEGACY) {
      throw new Error('Limite de 4 MB por envio neste ambiente.');
    }
    const form = new FormData();
    files.forEach(f => form.append('files', f));
    const response = await fetch('/api/rooms/' + roomId + '/files', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Erro ao enviar arquivos');
  }

  window.uploadToRoom = async function (roomId, fileList, onStatus) {
    const files = Array.from(fileList);
    const say = onStatus || function () {};
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = '(' + (i + 1) + '/' + files.length + ') ' + file.name;
      say('Enviando ' + label + '...');
      const prep = await postJson('/api/rooms/' + roomId + '/upload-url', { name: file.name, size: file.size, type: file.type });
      if (prep.status === 501) return legacyUpload(roomId, files.slice(i));
      if (!prep.ok) throw new Error(prep.data.error || 'Falha ao preparar o envio');
      await putWithProgress(prep.data.presignedUrl, file, p => say('Enviando ' + label + ' ' + p + '%'));
      const done = await postJson('/api/rooms/' + roomId + '/files/register', {
        pathname: prep.data.pathname, name: file.name, size: file.size, mime: file.type
      });
      if (!done.ok) throw new Error(done.data.error || 'Falha ao registrar o arquivo');
    }
  };
})();
