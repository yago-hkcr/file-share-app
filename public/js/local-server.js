(function () {
  const request = async (url, options) => {
    const response = await fetch(url, options || {});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível atualizar o servidor local.');
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
          '<p class="text-muted">Quando ativo, os computadores conectados à mesma rede podem abrir o FileShare. Só uma conta ADM pode iniciar ou parar o acesso.</p>' +
          '<div id="localServerAddresses"></div>' +
          '<p class="text-muted" style="font-size:13px">Parar o servidor bloqueia novas conexões da sala. Os dados continuam salvos neste computador.</p>' +
        '</div>' +
        '<div class="modal-footer"><button class="btn btn-outline" id="localServerClose" type="button">Fechar</button><button class="btn btn-green" id="localServerToggle" type="button">Iniciar servidor</button></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('.modal-overlay').addEventListener('click', close);
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.querySelector('#localServerClose').addEventListener('click', close);
    modal.querySelector('#localServerToggle').addEventListener('click', toggleServer);
    return modal;
  }

  function close() { if (modal) modal.style.display = 'none'; }

  function render() {
    if (!state) return;
    ensureModal();
    const active = state.active;
    modal.querySelector('#localServerState').innerHTML = active
      ? '<span style="color:#22c55e"><i class="fas fa-circle-check"></i> Ativo na porta ' + Number(state.port) + '</span>'
      : '<span style="color:#f59e0b"><i class="fas fa-circle-pause"></i> Desligado para a rede</span>';
    const list = modal.querySelector('#localServerAddresses');
    list.innerHTML = active && state.addresses && state.addresses.length
      ? '<h4>Endereço para compartilhar</h4>' + state.addresses.map(item =>
          '<div class="card-row" style="gap:8px;flex-wrap:wrap"><a class="grow" style="overflow-wrap:anywhere" href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener">' + escapeHtml(item.url) + '</a><button class="btn btn-sm btn-outline" type="button" data-copy="' + escapeHtml(item.url) + '"><i class="fas fa-copy"></i> Copiar</button></div>'
        ).join('')
      : '<div class="empty-state"><i class="fas fa-wifi"></i><p>' + (active ? 'Não encontrei um endereço de rede. Conecte este computador ao Wi-Fi ou roteador da sala.' : 'Inicie o servidor para liberar um endereço para a sala.') + '</p></div>';
    list.querySelectorAll('[data-copy]').forEach(copyButton => copyButton.addEventListener('click', async () => {
      const value = copyButton.dataset.copy;
      try { await navigator.clipboard.writeText(value); window.showToast('Endereço copiado!', 'success'); }
      catch (error) { window.prompt('Copie o endereço para compartilhar:', value); }
    }));
    const toggle = modal.querySelector('#localServerToggle');
    toggle.disabled = working;
    toggle.className = active ? 'btn btn-danger' : 'btn btn-green';
    toggle.innerHTML = active ? '<i class="fas fa-stop"></i> Parar servidor' : '<i class="fas fa-play"></i> Iniciar servidor';
  }

  async function refresh() {
    state = await request('/api/admin/local-server/status');
    if (!state.available) return false;
    render();
    return true;
  }

  async function toggleServer() {
    if (working || !state) return;
    working = true;
    render();
    try {
      const action = state.active ? 'stop' : 'start';
      await request('/api/admin/local-server/' + action, { method: 'POST' });
      await refresh();
      window.showToast(state.active ? 'Servidor da sala iniciado.' : 'Servidor da sala parado.', 'success');
    } catch (error) {
      window.showToast(error.message, 'error');
      try { await refresh(); } catch (e) {}
    } finally {
      working = false;
      render();
    }
  }

  async function init() {
    try {
      state = await request('/api/admin/local-server/status');
      if (!state.available) return;
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-outline';
      button.innerHTML = '<i class="fas fa-network-wired"></i> Servidor da sala';
      button.title = 'Liberar ou parar o acesso pela rede local';
      button.addEventListener('click', async () => {
        ensureModal().style.display = 'flex';
        try { await refresh(); } catch (error) { window.showToast(error.message, 'error'); }
      });
      const header = document.querySelector('.header-right');
      const notifications = document.getElementById('notifBtn');
      header.insertBefore(button, notifications || header.firstChild);
    } catch (error) {
      // A instalação hospedada na Vercel não oferece controle do servidor local.
    }
  }

  init();
})();
