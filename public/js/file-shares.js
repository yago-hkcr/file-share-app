// Compartilhamento público de arquivos: cria links com validade, senha,
// limite de downloads e QR code, além de listar e revogar links ativos.
(function () {
  'use strict';

  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const api = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
    return data;
  };
  const post = (url, body, method = 'POST') => api(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const parseDate = value => {
    if (!value) return null;
    const iso = String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z');
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const formatDate = value => {
    const date = parseDate(value);
    return date ? date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  };
  const formatNumber = value => Number(value || 0).toLocaleString('pt-BR');

  let sheet = null;
  let source = null;
  let lastUrl = '';
  let busy = false;

  function endpoint() {
    if (!source) return '';
    return source.kind === 'library' ? '/api/library/' + encodeURIComponent(source.id) + '/shares' : '/api/files/' + encodeURIComponent(source.id) + '/shares';
  }

  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement('section');
    sheet.id = 'fileShareSheet';
    sheet.className = 'modal file-share-modal';
    sheet.style.display = 'none';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'fileShareTitle');
    sheet.innerHTML = `
      <div class="modal-overlay" data-fs-close></div>
      <div class="modal-content fs-modal-card">
        <header class="fs-head">
          <div class="fs-head-copy">
            <span class="fs-eyebrow"><i class="fas fa-link" aria-hidden="true"></i> Compartilhar</span>
            <h3 id="fileShareTitle">Link público do arquivo</h3>
            <p id="fsFileLine" class="fs-file-line"></p>
          </div>
          <button class="modal-close" type="button" data-fs-close aria-label="Fechar">&times;</button>
        </header>
        <div class="fs-body">
          <form id="fsForm" class="fs-form" novalidate>
            <div class="fs-grid">
              <label class="fs-field">Validade
                <select id="fsExpiry">
                  <option value="3600">1 hora</option>
                  <option value="86400">24 horas</option>
                  <option value="604800" selected>7 dias</option>
                  <option value="2592000">30 dias</option>
                  <option value="0">Nunca expira</option>
                </select>
              </label>
              <label class="fs-field">Limite de downloads
                <input id="fsMax" type="number" inputmode="numeric" min="0" max="100000" step="1" value="0">
                <small>Use 0 para downloads ilimitados.</small>
              </label>
            </div>
            <label class="fs-switch">
              <input id="fsPreview" type="checkbox" checked>
              <span><b>Permitir visualização</b><small>Mostra o arquivo no navegador (quando o formato permite) antes de baixar.</small></span>
            </label>
            <label class="fs-field">Senha do link <span class="fs-optional">opcional</span>
              <span class="fs-password-wrap">
                <input id="fsPassword" type="password" minlength="4" maxlength="1024" autocomplete="new-password" placeholder="ex.: 1234">
                <button type="button" class="fs-eye" data-fs-eye aria-label="Mostrar senha"><i class="fas fa-eye" aria-hidden="true"></i></button>
              </span>
              <small>Se preencher, quem receber o link precisará digitar esta senha. Mínimo de 4 caracteres.</small>
            </label>
            <p id="fsError" class="fs-error" role="alert" hidden></p>
            <button class="btn btn-primary btn-full fs-submit" type="submit">
              <i class="fas fa-shield-halved" aria-hidden="true"></i> Gerar link seguro
            </button>
          </form>

          <section id="fsResult" class="fs-result" hidden>
            <div class="fs-success-head"><span class="fs-success-icon"><i class="fas fa-check" aria-hidden="true"></i></span><div><b>Link criado</b><small>Copie e envie para quem precisa do arquivo.</small></div></div>
            <div class="fs-result-grid">
              <div class="fs-qr"><img id="fsQr" alt="QR code do link" loading="lazy"></div>
              <div class="fs-result-copy">
                <div class="fs-link-row">
                  <input id="fsLink" type="text" readonly aria-label="Link público">
                  <button type="button" class="btn btn-outline" data-fs-copy>Copiar</button>
                </div>
                <div class="fs-share-actions">
                  <a id="fsOpen" class="btn btn-outline" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> Abrir</a>
                  <a id="fsWhats" class="btn btn-outline" target="_blank" rel="noopener"><i class="fab fa-whatsapp" aria-hidden="true"></i> WhatsApp</a>
                  <a id="fsMail" class="btn btn-outline"><i class="fas fa-envelope" aria-hidden="true"></i> E-mail</a>
                </div>
                <p id="fsMeta" class="fs-meta"></p>
              </div>
            </div>
            <button type="button" class="btn btn-outline btn-full" data-fs-new><i class="fas fa-plus" aria-hidden="true"></i> Criar outro link</button>
          </section>

          <section class="fs-existing">
            <div class="fs-existing-head"><h4><i class="fas fa-clock-rotate-left" aria-hidden="true"></i> Links ativos</h4><button type="button" class="fs-refresh" data-fs-refresh aria-label="Atualizar links"><i class="fas fa-rotate" aria-hidden="true"></i></button></div>
            <div id="fsList" class="fs-list"><p class="fs-empty"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Carregando links...</p></div>
          </section>
        </div>
      </div>`;
    document.body.appendChild(sheet);

    sheet.addEventListener('click', handleClick);
    sheet.querySelector('#fsForm').addEventListener('submit', createLink);
    sheet.querySelector('#fsPassword').addEventListener('input', event => {
      if (event.target.value && event.target.value.length < 4) event.target.setCustomValidity('Use pelo menos 4 caracteres.');
      else event.target.setCustomValidity('');
    });
    return sheet;
  }

  function handleClick(event) {
    const close = event.target.closest('[data-fs-close]');
    if (close) { closeSheet(); return; }
    const copy = event.target.closest('[data-fs-copy]');
    if (copy) { copyText(lastUrl, copy); return; }
    const copyExisting = event.target.closest('[data-fs-copy-url]');
    if (copyExisting) { copyText(copyExisting.dataset.fsCopyUrl || '', copyExisting); return; }
    const revoke = event.target.closest('[data-fs-revoke]');
    if (revoke) { revokeLink(revoke.dataset.fsRevoke, revoke); return; }
    const refresh = event.target.closest('[data-fs-refresh]');
    if (refresh) { loadLinks(); return; }
    const again = event.target.closest('[data-fs-new]');
    if (again) { resetForm(); return; }
    const eye = event.target.closest('[data-fs-eye]');
    if (eye) {
      const input = sheet.querySelector('#fsPassword');
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      eye.setAttribute('aria-label', showing ? 'Mostrar senha' : 'Ocultar senha');
      eye.innerHTML = '<i class="fas fa-eye' + (showing ? '' : '-slash') + '" aria-hidden="true"></i>';
    }
  }

  function openSheet() {
    ensureSheet();
    sheet.style.display = 'flex';
    document.body.classList.add('fs-modal-open');
    const focusable = sheet.querySelector('#fsExpiry');
    if (focusable) window.setTimeout(() => focusable.focus(), 60);
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.style.display = 'none';
    document.body.classList.remove('fs-modal-open');
    lastUrl = '';
  }

  function resetForm() {
    const form = sheet.querySelector('#fsForm');
    form.reset();
    sheet.querySelector('#fsExpiry').value = '604800';
    sheet.querySelector('#fsMax').value = '0';
    sheet.querySelector('#fsPreview').checked = true;
    sheet.querySelector('#fsPassword').type = 'password';
    const eye = sheet.querySelector('[data-fs-eye]');
    eye.innerHTML = '<i class="fas fa-eye" aria-hidden="true"></i>';
    eye.setAttribute('aria-label', 'Mostrar senha');
    sheet.querySelector('#fsError').hidden = true;
    sheet.querySelector('#fsResult').hidden = true;
    form.hidden = false;
    lastUrl = '';
    loadLinks();
  }

  async function createLink(event) {
    event.preventDefault();
    if (busy) return;
    const error = sheet.querySelector('#fsError');
    const password = sheet.querySelector('#fsPassword');
    error.hidden = true;
    if (password.value && password.value.length < 4) {
      error.textContent = 'A senha do link precisa ter pelo menos 4 caracteres.';
      error.hidden = false;
      password.focus();
      return;
    }
    const button = sheet.querySelector('.fs-submit');
    const original = button.innerHTML;
    busy = true;
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Gerando link...';
    try {
      const result = await post(endpoint(), {
        expires_in: Number(sheet.querySelector('#fsExpiry').value),
        max_downloads: Math.max(0, Math.floor(Number(sheet.querySelector('#fsMax').value) || 0)),
        allow_preview: sheet.querySelector('#fsPreview').checked,
        password: password.value || ''
      });
      showResult(result);
      await loadLinks();
    } catch (err) {
      error.textContent = err.message || 'Não foi possível criar o link.';
      error.hidden = false;
    } finally {
      busy = false;
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  function showResult(result) {
    const share = result.share || {};
    lastUrl = result.url || '';
    sheet.querySelector('#fsForm').hidden = true;
    const box = sheet.querySelector('#fsResult');
    box.hidden = false;
    const qr = sheet.querySelector('#fsQr');
    const qrWrap = sheet.querySelector('.fs-qr');
    if (result.qr) { qr.src = result.qr; qrWrap.hidden = false; }
    else { qr.removeAttribute('src'); qrWrap.hidden = true; }
    sheet.querySelector('#fsLink').value = lastUrl;
    const open = sheet.querySelector('#fsOpen');
    open.href = lastUrl;
    const name = (source && source.name) || 'arquivo';
    sheet.querySelector('#fsWhats').href = 'https://wa.me/?text=' + encodeURIComponent('Arquivo: ' + name + '\n' + lastUrl);
    sheet.querySelector('#fsMail').href = 'mailto:?subject=' + encodeURIComponent('Arquivo compartilhado: ' + name) + '&body=' + encodeURIComponent('Olá! Segue o link para baixar o arquivo "' + name + '":\n\n' + lastUrl);
    const expiry = Number(share.max_downloads) > 0 ? 'Limite de ' + formatNumber(share.max_downloads) + ' download(s)' : 'Downloads ilimitados';
    const expires = share.expires_at ? 'Expira em ' + formatDate(share.expires_at) : 'Não expira';
    sheet.querySelector('#fsMeta').textContent = expires + ' · ' + expiry + (share.has_password ? ' · protegido por senha' : '');
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function loadLinks() {
    const list = sheet.querySelector('#fsList');
    if (!list) return;
    list.innerHTML = '<p class="fs-empty"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Carregando links...</p>';
    try {
      const result = await api(endpoint());
      const shares = Array.isArray(result.shares) ? result.shares : [];
      if (!shares.length) {
        list.innerHTML = '<p class="fs-empty"><i class="fas fa-link-slash" aria-hidden="true"></i> Nenhum link ativo. Crie o primeiro acima.</p>';
        return;
      }
      list.innerHTML = shares.map(item => {
        const expired = item.expires_at && parseDate(item.expires_at) && parseDate(item.expires_at).getTime() <= Date.now();
        const limitReached = Number(item.max_downloads) > 0 && Number(item.download_count) >= Number(item.max_downloads);
        const state = expired ? 'Expirado' : limitReached ? 'Limite atingido' : 'Ativo';
        const stateClass = expired || limitReached ? 'is-off' : 'is-on';
        const downloads = Number(item.max_downloads) > 0 ? formatNumber(item.download_count) + ' / ' + formatNumber(item.max_downloads) : formatNumber(item.download_count) + ' / ilimitado';
        return '<article class="fs-item">' +
          '<div class="fs-item-top"><span class="fs-state ' + stateClass + '"><i class="fas fa-circle" aria-hidden="true"></i> ' + state + '</span>' +
          '<span class="fs-item-date">criado ' + esc(formatDate(item.created_at)) + '</span></div>' +
          '<div class="fs-item-meta"><span><i class="fas fa-download" aria-hidden="true"></i> ' + downloads + '</span>' +
          '<span><i class="fas fa-calendar" aria-hidden="true"></i> ' + (item.expires_at ? esc(formatDate(item.expires_at)) : 'sem validade') + '</span>' +
          (item.has_password ? '<span class="fs-badge"><i class="fas fa-lock" aria-hidden="true"></i> senha</span>' : '') +
          (item.allow_preview ? '<span class="fs-badge"><i class="fas fa-eye" aria-hidden="true"></i> visualização</span>' : '') + '</div>' +
          '<div class="fs-item-actions">' +
          (item.url ? '<button type="button" class="btn btn-sm btn-outline" data-fs-copy-url="' + esc(item.url) + '"><i class="fas fa-copy" aria-hidden="true"></i> Copiar</button>' : '') +
          '<button type="button" class="btn btn-sm btn-outline is-danger" data-fs-revoke="' + esc(item.id) + '"><i class="fas fa-ban" aria-hidden="true"></i> Revogar</button>' +
          '</div></article>';
      }).join('');
    } catch (error) {
      list.innerHTML = '<p class="fs-empty fs-error-line"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> ' + esc(error.message) + '</p>';
    }
  }

  async function revokeLink(id, button) {
    if (!id || busy) return;
    if (!window.confirm('Revogar este link? Quem já tiver a URL não conseguirá mais baixar o arquivo.')) return;
    busy = true;
    button.disabled = true;
    try {
      await api('/api/file-shares/' + encodeURIComponent(id), { method: 'DELETE' });
      if (window.toast) window.toast('Link revogado');
      await loadLinks();
    } catch (error) {
      if (window.toast) window.toast(error.message, 'error');
      else window.alert(error.message);
    } finally {
      busy = false;
      if (button.isConnected) button.disabled = false;
    }
  }

  async function copyText(text, button) {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      if (button) {
        const original = button.innerHTML;
        button.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> Copiado';
        window.setTimeout(() => { if (button.isConnected) button.innerHTML = original; }, 1800);
      }
    } catch (error) {
      window.prompt('Copie o link abaixo:', text);
    }
  }

  window.openFileShareDialog = function (options) {
    const data = options || {};
    if (!data.id) return;
    source = { kind: data.kind === 'library' ? 'library' : 'file', id: String(data.id), name: String(data.name || 'arquivo') };
    ensureSheet();
    sheet.querySelector('#fileShareTitle').textContent = source.kind === 'library' ? 'Compartilhar item do Acervo' : 'Compartilhar arquivo da sala';
    sheet.querySelector('#fsFileLine').innerHTML = '<i class="fas fa-file" aria-hidden="true"></i> ' + esc(source.name) + ' <span>· ' + (source.kind === 'library' ? 'Acervo' : 'Sala') + '</span>';
    resetForm();
    openSheet();
  };
  window.ArquiveFileShares = { open: window.openFileShareDialog, close: closeSheet };
})();
