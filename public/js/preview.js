/* ===== FileShare: visualizador de arquivos ===== */
(function () {
  'use strict';

  const esc = value => {
    const node = document.createElement('div');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  };

  const sizeLabel = bytes => {
    const value = Number(bytes) || 0;
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
    return (value / Math.pow(1024, index)).toFixed(index ? 1 : 0) + ' ' + units[index];
  };

  const kind = (name, mime) => {
    const type = String(mime || '').toLowerCase();
    const fileName = String(name || '').toLowerCase();
    if (type.startsWith('image/')) return ['IMAGE', 'fa-image'];
    if (type.startsWith('video/')) return ['VIDEO', 'fa-film'];
    if (type.startsWith('audio/')) return ['AUDIO', 'fa-music'];
    if (type === 'application/pdf' || fileName.endsWith('.pdf')) return ['PDF', 'fa-file-pdf'];
    if (type.startsWith('text/') || /\.(txt|md|json|csv|log|js|css|html|xml|svg|yml|yaml|ini|conf)$/i.test(fileName)) return ['TEXTO', 'fa-file-code'];
    return ['ARQUIVO', 'fa-file'];
  };

  function close() {
    const overlay = document.getElementById('filePreviewOverlay');
    if (!overlay) return;
    overlay.remove();
    document.body.classList.remove('fp-opened');
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && document.getElementById('filePreviewOverlay')) close();
  }

  function showPreviewError(stage, meta) {
    if (!stage || !stage.isConnected) return;
    stage.innerHTML = '<div class="fp-empty"><i class="fas fa-triangle-exclamation"></i><strong>Não foi possível visualizar</strong><span>O arquivo não pôde ser carregado. Verifique a conexão e tente novamente.</span><button class="btn btn-outline" type="button" style="margin-top:16px">Tentar novamente</button></div>';
    const retry = stage.querySelector('button');
    if (retry) retry.onclick = () => previewFile(meta.id, meta.name, meta.mime, meta.size, { preview: meta.previewUrl, download: meta.downloadUrl });
  }

  function shell(meta, body) {
    const [label, icon] = kind(meta.name, meta.mime);
    const overlay = document.createElement('div');
    overlay.id = 'filePreviewOverlay';
    overlay.className = 'fp-overlay';
    overlay.innerHTML = '<div class="fp-shell" role="dialog" aria-modal="true" aria-label="Visualização do arquivo"><div class="fp-top"><div class="fp-icon"><i class="fas ' + icon + '"></i></div><div class="fp-heading"><h2 class="fp-title">' + esc(meta.name) + '</h2><div class="fp-sub">' + label + ' · ' + sizeLabel(meta.size) + '</div></div><button class="fp-close" type="button" aria-label="Fechar"><i class="fas fa-xmark"></i></button></div><div class="fp-stage">' + body + '</div><div class="fp-bottom"><div class="fp-meta">' + esc(meta.name) + '</div><a class="btn btn-green fp-open" data-fp-dl="1" href="' + esc(meta.downloadUrl) + '"><i class="fas fa-download"></i> Baixar</a></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.fp-close').onclick = close;
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('fp-opened');
    return overlay;
  }

  async function previewFile(id, name, mime, size, urls) {
    close();
    const meta = {
      id: String(id),
      name: name || 'Arquivo',
      mime: mime || '',
      size: size || 0,
      downloadUrl: (urls && urls.download) || '/download/' + encodeURIComponent(String(id)),
      previewUrl: (urls && urls.preview) || '/preview/' + encodeURIComponent(String(id))
    };
    const overlay = shell(meta, '<div class="fp-empty"><i class="fas fa-spinner fa-spin"></i><strong>Preparando visualização</strong><span>Carregando o arquivo com segurança...</span></div>');
    const stage = overlay.querySelector('.fp-stage');
    const url = meta.previewUrl;

    try {
      const type = String(meta.mime).toLowerCase();
      const fileName = String(meta.name).toLowerCase();
      if (type.startsWith('image/')) {
        stage.innerHTML = '<div class="fp-empty"><i class="fas fa-spinner fa-spin"></i><strong>Carregando imagem</strong></div>';
        const image = new Image();
        image.className = 'fp-media fp-image';
        image.alt = meta.name;
        image.onclick = event => event.currentTarget.classList.toggle('fp-zoomed');
        image.onload = () => { if (overlay.isConnected) stage.replaceChildren(image); };
        image.onerror = () => showPreviewError(stage, meta);
        image.src = url;
      } else if (type.startsWith('video/')) {
        stage.innerHTML = '<video class="fp-media fp-video" src="' + esc(url) + '" controls playsinline></video>';
        stage.querySelector('video').addEventListener('error', () => showPreviewError(stage, meta), { once: true });
      } else if (type.startsWith('audio/')) {
        stage.innerHTML = '<div class="fp-audio"><div class="fp-empty" style="width:auto;border:0;background:transparent;padding:18px"><i class="fas fa-music"></i><strong>' + esc(meta.name) + '</strong><span>Reprodução de áudio</span></div><audio src="' + esc(url) + '" controls style="width:100%"></audio></div>';
        stage.querySelector('audio').addEventListener('error', () => showPreviewError(stage, meta), { once: true });
      } else if (type === 'application/pdf' || fileName.endsWith('.pdf')) {
        stage.innerHTML = '<iframe class="fp-pdf" src="' + esc(url) + '" title="' + esc(meta.name) + '"></iframe>';
        stage.querySelector('iframe').addEventListener('error', () => showPreviewError(stage, meta), { once: true });
      } else if (type.startsWith('text/') || /\.(txt|md|json|csv|log|js|css|html|xml|svg|yml|yaml|ini|conf)$/i.test(fileName)) {
        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error('Não foi possível carregar o texto.');
        const code = document.createElement('pre');
        code.className = 'fp-code';
        code.textContent = await response.text();
        stage.replaceChildren(code);
      } else {
        stage.innerHTML = '<div class="fp-empty"><i class="fas fa-eye-slash"></i><strong>Pré-visualização indisponível</strong><span>Este formato não pode ser exibido diretamente no navegador. Use o botão Baixar.</span></div>';
      }
    } catch (error) {
      showPreviewError(stage, meta);
    }
  }

  window.previewFile = previewFile;
})();