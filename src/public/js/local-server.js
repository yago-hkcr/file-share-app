(function () {
  const request = async (url, options) => {
    const response = await fetch(url, options || {});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'NÃ£o foi possÃ­vel atualizar o servidor local.');
    return data;
  };
  const escapeHtml = value => {
    const node = document.createElement('span');
    node.textContent = String(value == null ? '' : value);
    return node.innerHTML;
  };

  let button, modal, state, working = false;

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'localServerModal';
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML =
      '<div class="modal-overlay"></div>' +
      '<div class="modal-content" style="max-width:560px;width:min(560px,calc(100vw - 24px))">' +
        '<div class="modal-header"><h3><i class="fas fa-network-wired"></i> Servidor da sala</h3><button class="modal-close" type="button" aria-label="Fechar">&times;</button></div>' +
        '<div class="modal-body">' +
          '<p id="localServerState" style="font-weight:700"></p>' +
          '<p class="text-muted">Quando ativo, os computadores conectados Ã  mesma rede podem abrir o FileShare. SÃ³ uma conta ADM pode iniciar ou parar o acesso.</p>' +
          '<div id="localServerAddresses"></div>' +
          '<p class="text-muted" style="font-size:13px">Parar o servidor bloqueia¶»§q«^