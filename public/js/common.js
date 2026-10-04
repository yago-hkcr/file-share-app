// Recursos compartilhados por todas as páginas: tema claro/escuro e renomear arquivo.
(function () {
  const KEY = 'fileshare-theme';
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem(KEY); } catch (e) { return null; } })();
  root.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light'); // roda antes da página aparecer: sem "piscar"

  function paintButton(btn) {
    const dark = root.getAttribute('data-theme') === 'dark';
    btn.innerHTML = dark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
    btn.title = dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
    btn.setAttribute('aria-label', btn.title);
  }

  function addThemeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* sem armazenamento: vale só nesta página */ }
      paintButton(btn);
    });
    paintButton(btn);
    // Canto superior esquerdo: dentro do cabeçalho quando existe; senão, fixo na tela
    const host = document.querySelector('.header-left') || document.querySelector('.sala-left');
    if (host) host.insertBefore(btn, host.firstChild);
    else { btn.classList.add('theme-toggle-fixed'); document.body.appendChild(btn); }
  }

  const esc = t => { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; };

  // "enviado por fulano"
  window.uploaderTag = function (name, role) {
    if (!name) return '';
    const adm = role === 'admin';
    return '<span class="uploader-tag' + (adm ? ' is-admin' : '') + '" title="Enviado por ' + esc(name) + (adm ? ' (ADM)' : '') + '"><span class="uploader-dot">' +
      esc(name[0].toUpperCase()) + '</span>' + esc(name) + (adm ? ' <span class="adm-badge">ADM</span>' : '') + '</span>';
  };
  window.admBadge = role => role === 'admin' ? ' <span class="adm-badge">ADM</span>' : '';

  // Links clicáveis em textos (já escapa o HTML)
  window.linkify = function (text) {
    return esc(text).replace(/\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)"'\]])/gi, function (u) {
      const href = /^www\./i.test(u) ? 'https://' + u : u;
      return '<a class="chat-link" href="' + href + '" target="_blank" rel="noopener noreferrer nofollow">' + u + '</a>';
    });
  };

  // Tipo do arquivo (ex.: "PNG · Imagem")
  window.fileKind = function (name, mime) {
    const dot = (name || '').lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 6) : '';
    mime = mime || '';
    let cat = 'Arquivo';
    if (mime.startsWith('image/')) cat = 'Imagem';
    else if (mime.startsWith('video/')) cat = 'Vídeo';
    else if (mime.startsWith('audio/')) cat = 'Áudio';
    else if (mime.includes('pdf')) cat = 'PDF';
    else if (mime.includes('sheet') || mime.includes('excel') || mime.includes('csv')) cat = 'Planilha';
    else if (mime.includes('presentation') || mime.includes('powerpoint')) cat = 'Apresentação';
    else if (mime.includes('word') || mime.includes('document')) cat = 'Documento';
    else if (mime.includes('zip') || mime.includes('rar') || mime.includes('compress') || mime.includes('7z')) cat = 'Compactado';
    else if (mime.startsWith('text/')) cat = 'Texto';
    return (ext && ext !== cat.toUpperCase() ? ext + ' · ' : '') + cat;
  };
  window.kindBadge = (name, mime) => '<span class="kind-badge"><i class="fas fa-tag"></i> ' + esc(window.fileKind(name, mime)) + '</span>';

  // "há 5 min" a partir de "YYYY-MM-DD HH:MM:SS" (UTC)
  window.timeAgo = function (str) {
    if (!str) return '';
    const d = new Date(String(str).replace(' ', 'T') + 'Z');
    const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    let rel;
    if (s < 45) rel = 'agora há pouco';
    else if (s < 3600) rel = 'há ' + Math.round(s / 60) + ' min';
    else if (s < 86400) rel = 'há ' + Math.floor(s / 3600) + ' h';
    else rel = 'há ' + Math.floor(s / 86400) + ' d';
    const full = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return '<span class="time-ago" title="' + full + '"><i class="fas fa-clock"></i> ' + rel + ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '</span>';
  };

  // Ctrl+V: cola imagens/arquivos da área de transferência
  window.enablePaste = function (onFiles) {
    document.addEventListener('paste', function (e) {
      const items = e.clipboardData && e.clipboardData.files ? Array.from(e.clipboardData.files) : [];
      if (!items.length) return; // só texto: deixa colar normalmente
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
      const files = items.map(f => /^image\.(png|jpe?g|gif|webp)$/i.test(f.name)
        ? new File([f], 'imagem-' + stamp + f.name.slice(f.name.lastIndexOf('.')), { type: f.type })
        : f);
      e.preventDefault();
      onFiles(files);
    });
  };

  // Diálogo de renomear. A extensão (.pdf, .docx...) fica fixa para o arquivo não "perder o tipo".
  window.renameFile = function (id, currentName, onDone) {
    const dot = currentName.lastIndexOf('.');
    const ext = dot > 0 && currentName.length - dot <= 8 ? currentName.slice(dot) : '';
    const base = ext ? currentName.slice(0, dot) : currentName;

    const wrap = document.createElement('div');
    wrap.className = 'rename-modal';
    wrap.innerHTML =
      '<div class="rename-overlay"></div>' +
      '<form class="rename-box">' +
        '<h3><i class="fas fa-pen"></i> Renomear arquivo</h3>' +
        '<div class="rename-field"><input type="text" maxlength="150" required autocomplete="off">' +
        (ext ? '<span class="rename-ext">' + esc(ext) + '</span>' : '') + '</div>' +
        '<div class="rename-error" style="display:none"></div>' +
        '<div class="rename-actions"><button type="button" class="btn btn-outline rename-cancel">Cancelar</button>' +
        '<button type="submit" class="btn btn-primary">Salvar</button></div>' +
      '</form>';
    document.body.appendChild(wrap);
    const input = wrap.querySelector('input');
    const error = wrap.querySelector('.rename-error');
    input.value = base;
    input.focus(); input.select();

    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.querySelector('.rename-overlay').addEventListener('click', close);
    wrap.querySelector('.rename-cancel').addEventListener('click', close);
    wrap.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      try {
        const res = await fetch('/api/files/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name + ext })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Não foi possível renomear');
        close();
        if (onDone) onDone(data.original_name);
      } catch (err) {
        error.textContent = err.message;
        error.style.display = 'block';
      }
    });
  };


  // ---- Arrastar e soltar arquivos ----
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
  // Evita que o navegador abra o arquivo (e saia da página) se ele for solto fora da área certa
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });

  // root: elemento que contém as áreas; selector: quais elementos aceitam soltar; onDrop(elemento, arquivos)
  window.enableDrop = function (root, selector, onDrop) {
    let current = null;
    const clear = () => { if (current) { current.classList.remove('drag-over'); current = null; } };
    root.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      const t = e.target.closest ? e.target.closest(selector) : null;
      if (!t) { clear(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (current !== t) { clear(); current = t; t.classList.add('drag-over'); }
    });
    root.addEventListener('dragleave', e => { if (current && !current.contains(e.relatedTarget)) clear(); });
    root.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      const t = e.target.closest ? e.target.closest(selector) : null;
      clear();
      if (!t) return;
      e.preventDefault();
      onDrop(t, Array.from(e.dataTransfer.files));
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addThemeButton);
  else addThemeButton();
})();
