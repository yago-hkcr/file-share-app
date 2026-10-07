// Envio de arquivos para uma sala.
// Arquivos atÃ© 100 MB usam URL assinada; acima disso, upload multipart direto ao Blob (limite 50 GB).
// Reserva (servidor sem Blob, ex.: rodando local sem `vercel env pull`): envio pelo servidor.
// O limite por arquivo vem do servidor (/api/me â†’ max_upload_bytes), entÃ£o o aviso nunca fica desatualizado.
(function () {
  let limitBytes = null;
  const sizeLabel = b => {
    const gb = b / (1024 ** 3);
    if (gb >= 1) return (Number.isInteger(gb) ? gb : gb.toFixed(1)) + ' GB';
    const mb = b / 1048576;
    return (Number.isInteger(mb) || mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + ' MB';
  };

  window.limitLabel = () => (limitBytes ? sizeLabel(limitBytes) : 'â€¦');
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
      xhr.onload = () => (xhr.status >= 200 && xhr.s¶»§q«^