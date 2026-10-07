(function () {
  const root = document.getElementById('collectionPublicRoot');
  const token = window.location.pathname.split('/').filter(Boolean).pop() || '';
  const base = '/api/coletas/enviar/' + encodeURIComponent(token);
  const COLLECTION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  let collection = null, pendingFiles = [], reviewing = false, busy = false, senderName = '', collectionSignature = '', stateFetchPromise = null, statePollTimer = null;
  const esc = value => { const div = document.createElement('div'); div.textContent = String(value == null ? '' : value); return div.innerHTML; };
  const sizeLabel = value => {
    const bytes = Number(value) || 0;
    if (bytes >= 1024 ** 3) return (bytes / (1024 ** 3)).toFixed(1) + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / (1024 ** 2)).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  };
  const dateLabel = value => {
    const date = new Date(String(value || '').replace(' ', 'T') + (String(value || '').endsWith('Z') ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? 'Prazo nÃ£o disponÃ­vel' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  };
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || 'NÃ£o foi possÃ­vel concluir o¶»§q«^