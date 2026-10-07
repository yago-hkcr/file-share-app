(function () {
  const $ = id => document.getElementById(id);
  const esc = value => { const div = document.createElement('div'); div.textContent = String(value == null ? '' : value); return div.innerHTML; };
  const api = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'NÃ£o foi possÃ­vel concluir a operaÃ§Ã£o.');
    return data;
  };
  const collectionUrl = token => window.location.origin + '/enviar/' + encodeURIComponent(token);
  const dateLabel = value => {
    const date = new Date(String(value || '').replace(' ', 'T') + (String(value || '').endsWith('Z') ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? 'Prazo indisponÃ­vel' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  };
  const timeValue = value => {
    const text = String(value || '');
    const date = new Date(text.replace(' ', 'T') + (text.endsWith('Z') ? '' : 'Z'));
    return date.getTime();
  };
  const statuses = {
    pending: ['Aguardando envio', ''], in_progress: ['Envio parcial', 'is-progress'], sending: ['Enviando agora', 'is-sending'],
    submitted: ['Enviado', 'is-submitted'], revoked: ['Suspenso pelo organizador', 'is-revoked'], expired: ['Prazo nÃ£o cumprido', 'is-expired']
  };
  let roomsCache = [], friendsCache = [], friendsLoaded = false, friendsLoading = false, participantNames = []¶»§q«^