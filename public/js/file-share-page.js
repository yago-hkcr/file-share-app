// Página pública de um arquivo compartilhado: metadados, senha opcional,
// download e pré-visualização sem exigir login.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const token = (() => {
    const match = window.location.pathname.match(/^\/f\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : '';
  })();
  const validToken = /^[A-Za-z0-9_-]{43}$/.test(token);

  const formatBytes = value => {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1).replace('.', ',') + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1).replace('.', ',') + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  };
  const formatDate = value => {
    if (!value) return '';
    const date = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const formatNumber = value => Number(value || 0).toLocaleString('pt-BR');
  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function fileKind(meta) {
    const mime = String(meta.mime || '').toLowerCase();
    const name = String(meta.name || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    if (mime.startsWith('image/')) return { kind: 'image', icon: 'fa-file-image' };
    if (mime.startsWith('video/')) return { kind: 'video', icon: 'fa-file-video' };
    if (mime.startsWith('audio/')) return { kind: 'audio', icon: 'fa-file-audio' };
    if (mime === 'application/pdf' || ext === 'pdf') return { kind: 'pdf', icon: 'fa-file-pdf' };
    if (mime.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'xml', 'log'].includes(ext)) return { kind: 'text', icon: 'fa-file-lines' };
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { kind: 'archive', icon: 'fa-file-zipper' };
    if (['doc', 'docx'].includes(ext)) return { kind: 'doc', icon: 'fa-file-word' };
    if (['xls', 'xlsx', 'csv'].includes(ext)) return { kind: 'sheet', icon: 'fa-file-excel' };
    return { kind: 'file', icon: 'fa-file' };
  }

  function showOnly(id) {
    ['shareLoading', 'shareError', 'shareLocked', 'shareReady'].forEach(section => {
      const node = $(section);
      if (node) node.hidden = section !== id;
    });
  }

  function showError(message) {
    const text = $('shareErrorText');
    if (text) text.textContent = message || 'Este link não existe, expirou ou foi revogado.';
    showOnly('shareError');
  }

  function render(meta) {
    if (!meta || meta.state !== 'ok') {
      showError(meta && meta.error ? meta.error : 'Este link não está mais disponível.');
      return;
    }
    if (meta.needs_password) {
      showOnly('shareLocked');
      const input = $('sharePassword');
      if (input) window.setTimeout(() => input.focus(), 120);
      return;
    }
    const info = fileKind(meta);
    const name = meta.name || 'arquivo';
    showOnly('shareReady');
    $('shareName').textContent = name;
    $('shareFileIcon').className = 'fas ' + info.icon;
    $('shareDescription').textContent = 'Arquivo disponível para download' + (meta.allow_preview ? ' e visualização' : '') + '.';
    const chunks = [];
    if (meta.size) chunks.push('<span class="share-chip"><i class="fas fa-weight-hanging" aria-hidden="true"></i> ' + escapeHtml(formatBytes(meta.size)) + '</span>');
    if (meta.remaining_downloads === null || typeof meta.remaining_downloads === 'undefined') {
      chunks.push('<span class="share-chip"><i class="fas fa-infinity" aria-hidden="true"></i> downloads ilimitados</span>');
    } else {
      const low = Number(meta.remaining_downloads) <= 2;
      chunks.push('<span class="share-chip' + (low ? ' is-warn' : '') + '"><i class="fas fa-download" aria-hidden="true"></i> ' + escapeHtml(formatNumber(meta.remaining_downloads)) + ' download(s) restante(s)</span>');
    }
    if (meta.expires_at) {
      const date = formatDate(meta.expires_at);
      chunks.push('<span class="share-chip"><i class="fas fa-clock" aria-hidden="true"></i> expira em ' + escapeHtml(date) + '</span>');
    } else {
      chunks.push('<span class="share-chip"><i class="fas fa-calendar" aria-hidden="true"></i> sem validade</span>');
    }
    if (meta.has_password) chunks.push('<span class="share-chip"><i class="fas fa-lock" aria-hidden="true"></i> protegido por senha</span>');
    $('shareBadges').innerHTML = chunks.join('');

    const download = $('shareDownload');
    download.href = '/f/' + encodeURIComponent(token) + '/download';
    download.setAttribute('download', name);
    const previewButton = $('sharePreviewBtn');
    const previewable = meta.allow_preview && ['image', 'video', 'audio', 'pdf', 'text'].includes(info.kind);
    previewButton.hidden = !previewable;
    previewButton.dataset.kind = info.kind;
    previewButton.dataset.name = name;

    $('shareFooterMeta').textContent = meta.created_at
      ? 'Link criado em ' + formatDate(meta.created_at) + '. Links podem expirar ou ser revogados a qualquer momento.'
      : 'Links podem expirar ou ser revogados a qualquer momento.';
  }

  async function load() {
    if (!validToken) return showError('Este link é inválido.');
    try {
      const response = await fetch('/api/file-shares/public/' + encodeURIComponent(token), { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 410 || response.status === 404) return showError(data.error);
        return showError(data.error || 'Não foi possível verificar o link agora. Tente novamente.');
      }
      render(data);
    } catch (error) {
      showError('Não foi possível conectar ao servidor. Verifique sua internet e tente novamente.');
    }
  }

  async function unlock(event) {
    event.preventDefault();
    const input = $('sharePassword');
    const error = $('unlockError');
    const button = $('unlockBtn');
    if (!input || !input.value) { if (input) input.focus(); return; }
    if (error) error.hidden = true;
    button.disabled = true;
    const original = button.innerHTML;
    button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Conferindo...';
    try {
      const response = await fetch('/api/file-shares/public/' + encodeURIComponent(token) + '/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: input.value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 410 || response.status === 404) return showError(data.error);
        throw new Error(data.error || 'Senha incorreta.');
      }
      render(data);
    } catch (err) {
      if (error) { error.textContent = err.message || 'Não foi possível desbloquear.'; error.hidden = false; }
      input.select();
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  function closePreview() {
    const overlay = $('sharePreview');
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    $('sharePreviewStage').innerHTML = '';
    document.body.style.overflow = '';
  }

  function previewFallback() {
    const stage = $('sharePreviewStage');
    if (!stage) return;
    stage.innerHTML = '<div class="share-preview-fallback"><i class="fas fa-circle-exclamation" aria-hidden="true"></i><p>Este navegador não conseguiu exibir o arquivo. Baixe para abrir no seu dispositivo.</p></div>';
  }

  function openPreview(kind, name) {
    const overlay = $('sharePreview');
    const stage = $('sharePreviewStage');
    if (!overlay || !stage) return;
    const url = '/f/' + encodeURIComponent(token) + '/preview';
    stage.innerHTML = '';
    let node;
    if (kind === 'image') {
      node = document.createElement('img');
      node.src = url;
      node.alt = name;
      node.decoding = 'async';
      node.addEventListener('error', previewFallback);
    } else if (kind === 'video') {
      node = document.createElement('video');
      node.src = url;
      node.controls = true;
      node.autoplay = true;
      node.playsInline = true;
      node.setAttribute('controlsList', 'nodownload');
      node.addEventListener('error', previewFallback);
    } else if (kind === 'audio') {
      node = document.createElement('audio');
      node.src = url;
      node.controls = true;
      node.autoplay = true;
      node.addEventListener('error', previewFallback);
    } else if (kind === 'pdf' || kind === 'text') {
      node = document.createElement('iframe');
      node.src = url;
      node.title = name;
      node.setAttribute('loading', 'eager');
    } else {
      previewFallback();
    }
    if (node) stage.appendChild(node);
    $('sharePreviewName').textContent = name;
    $('sharePreviewDownload').href = '/f/' + encodeURIComponent(token) + '/download';
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    const close = $('sharePreviewClose');
    if (close) close.focus();
  }

  function boot() {
    const form = $('unlockForm');
    if (form) form.addEventListener('submit', unlock);
    const previewButton = $('sharePreviewBtn');
    if (previewButton) previewButton.addEventListener('click', () => openPreview(previewButton.dataset.kind, previewButton.dataset.name));
    const close = $('sharePreviewClose');
    if (close) close.addEventListener('click', closePreview);
    const overlay = $('sharePreview');
    if (overlay) overlay.addEventListener('click', event => { if (event.target === overlay) closePreview(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closePreview(); });
    if (!validToken) return showError('Este link é inválido.');
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
