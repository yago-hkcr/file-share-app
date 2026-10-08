(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = value => {
    const node = document.createElement('span');
    node.textContent = String(value == null ? '' : value);
    return node.innerHTML;
  };
  const api = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
    return data;
  };

  let items = [];
  let shelves = [];
  let loading = false;
  let favoritesOnly = false;
  let signature = '';

  function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  }

  function formatSize(value) {
    let size = Number(value) || 0;
    if (size < 1024) return size + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { size /= 1024; i++; } while (size >= 1024 && i < units.length - 1);
    return size.toLocaleString('pt-BR', { maximumFractionDigits: size < 10 ? 1 : 0 }) + ' ' + units[i];
  }

  function formatDate(value) {
    if (!value) return 'Agora';
    const text = String(value);
    const date = new Date(text.includes('T') ? text : text.replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  }

  function fileIcon(item) {
    const mime = String(item.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) return 'fa-image';
    if (mime.startsWith('video/')) return 'fa-film';
    if (mime.startsWith('audio/')) return 'fa-headphones';
    if (mime.includes('pdf') || /\.pdf$/i.test(item.original_name || '')) return 'fa-file-pdf';
    if (/\.(doc|docx|odt)$/i.test(item.original_name || '')) return 'fa-file-word';
    if (/\.(xls|xlsx|csv)$/i.test(item.original_name || '')) return 'fa-file-excel';
    if (/\.(zip|rar|7z)$/i.test(item.original_name || '')) return 'fa-file-zipper';
    return 'fa-file-lines';
  }

  function renderShelves() {
    const select = $('libraryShelfFilter');
    const current = select.value;
    select.innerHTML = '<option value="">Todas as prateleiras</option>' + shelves.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    if (shelves.includes(current)) select.value = current;
  }

  function filteredItems() {
    const query = normalize($('librarySearch').value.trim());
    const shelf = $('libraryShelfFilter').value;
    return items.filter(item => {
      if (favoritesOnly && !item.is_favorite) return false;
      if (shelf && item.shelf !== shelf) return false;
      if (!query) return true;
      const text = normalize([item.original_name, item.room_name, item.uploader, item.shelf, item.note].join(' '));
      return text.includes(query);
    });
  }

  function render() {
    renderShelves();
    const filtered = filteredItems();
    const summary = $('librarySummary');
    summary.innerHTML = `<span><strong>${items.length}</strong> ${items.length === 1 ? 'arquivo guardado' : 'arquivos guardados'}</span><span><i class="fas fa-layer-group" aria-hidden="true"></i> ${shelves.length} ${shelves.length === 1 ? 'prateleira' : 'prateleiras'}</span>`;
    $('libraryFavoritesFilter').classList.toggle('is-active', favoritesOnly);
    $('libraryFavoritesFilter').setAttribute('aria-pressed', String(favoritesOnly));
    if (!filtered.length) {
      $('libraryGrid').innerHTML = items.length
        ? '<div class="library-empty"><i class="fas fa-magnifying-glass"></i><h3>Nada por aqui</h3><p>Altere a busca ou os filtros para encontrar seus arquivos.</p></div>'
        : '<div class="library-empty"><span class="library-empty-icon"><i class="fas fa-box-open"></i></span><h3>Seu espaço começa aqui</h3><p>Abra uma sala, escolha um arquivo e toque no marcador para guardar. Depois, adicione uma prateleira e uma anotação que ajude você a reencontrá-lo.</p><button class="btn btn-outline" type="button" data-library-go-rooms><i class="fas fa-door-open"></i> Explorar salas</button></div>';
      return;
    }
    $('libraryGrid').innerHTML = filtered.map((item, index) => `
      <article class="library-card" style="--library-order:${Math.min(index, 10)}">
        <div class="library-card-top"><span class="library-shelf"><i class="fas fa-layer-group" aria-hidden="true"></i> ${esc(item.shelf || 'Guardados')}</span><button type="button" class="library-star ${item.is_favorite ? 'is-active' : ''}" data-library-favorite="${esc(item.id)}" aria-label="${item.is_favorite ? 'Remover dos importantes' : 'Marcar como importante'}" aria-pressed="${Boolean(item.is_favorite)}"><i class="fas fa-star"></i></button></div>
        <div class="library-file-heading"><span class="library-file-icon"><i class="fas ${fileIcon(item)}" aria-hidden="true"></i></span><div class="library-file-copy"><h3 title="${esc(item.original_name)}">${esc(item.original_name)}</h3><p>${formatSize(item.size)} <span aria-hidden="true">·</span> guardado ${formatDate(item.saved_at)}</p></div></div>
        <div class="library-source"><i class="fas fa-folder-open" aria-hidden="true"></i><span>${esc(item.room_name || 'Sala')}</span><span class="library-source-separator">·</span><span>Enviado por ${esc(item.uploader || 'participante')}</span></div>
        ${item.note ? `<p class="library-note"><i class="fas fa-quote-left" aria-hidden="true"></i>${esc(item.note)}</p>` : '<p class="library-note library-note-empty">Adicione uma anotação pessoal para guardar o contexto.</p>'}
        <div class="library-card-actions"><button class="btn btn-sm btn-outline" type="button" data-library-preview="${esc(item.file_id)}" data-name="${esc(item.original_name)}" data-mime="${esc(item.mime_type)}" data-size="${Number(item.size) || 0}"><i class="fas fa-eye"></i> Visualizar</button><a class="btn btn-sm btn-green" href="/download/${encodeURIComponent(item.file_id)}"><i class="fas fa-download"></i> Baixar</a><button class="btn btn-sm btn-outline library-edit-action" type="button" data-library-edit="${esc(item.file_id)}"><i class="fas fa-sliders"></i> Organizar</button></div>
      </article>`).join('');
  }

  async function loadLibrary(silent = false) {
    if (loading) return;
    loading = true;
    if (!silent && !items.length) $('libraryGrid').innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Preparando seu Acervo...</div>';
    try {
      const result = await api('/api/library');
      const nextItems = Array.isArray(result.items) ? result.items : [];
      const nextShelves = Array.isArray(result.shelves) ? result.shelves : [];
      const nextSignature = JSON.stringify([nextItems, nextShelves]);
      if (nextSignature !== signature) {
        signature = nextSignature;
        items = nextItems;
        shelves = nextShelves;
        render();
      }
    } catch (error) {
      if (!silent) $('libraryGrid').innerHTML = `<div class="library-empty library-error"><i class="fas fa-triangle-exclamation"></i><h3>Não foi possível carregar seu Acervo</h3><p>${esc(error.message)}</p><button class="btn btn-outline" type="button" data-library-retry><i class="fas fa-rotate-right"></i> Tentar novamente</button></div>`;
    } finally {
      loading = false;
    }
  }

  function closeEditor() {
    const modal = $('libraryEditorModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  async function openEditor(fileId, fileName, saved) {
    if (saved && !items.some(item => item.file_id === String(fileId))) await loadLibrary(true);
    const item = items.find(entry => entry.file_id === String(fileId));
    $('libraryFileId').value = String(fileId);
    $('libraryItemId').value = item ? item.id : '';
    $('libraryEditorFileName').textContent = item ? item.original_name : String(fileName || 'Arquivo');
    $('libraryEditorShelf').value = item ? item.shelf : 'Guardados';
    $('libraryEditorNote').value = item ? item.note : '';
    $('libraryEditorFavorite').checked = Boolean(item && item.is_favorite);
    $('removeLibraryItem').hidden = !item;
    $('saveLibraryItem').innerHTML = item ? '<i class="fas fa-check"></i> Salvar organização' : '<i class="fas fa-bookmark"></i> Guardar arquivo';
    $('libraryEditorTitle').innerHTML = item ? '<i class="fas fa-bookmark"></i> Organizar no Meu Acervo' : '<i class="fas fa-bookmark"></i> Guardar no Meu Acervo';
    const modal = $('libraryEditorModal');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => $('libraryEditorShelf').focus(), 40);
  }

  window.openLibraryEditor = openEditor;
  window.loadLibrary = loadLibrary;

  $('librarySearch').addEventListener('input', render);
  $('libraryShelfFilter').addEventListener('change', render);
  $('libraryFavoritesFilter').addEventListener('click', () => { favoritesOnly = !favoritesOnly; render(); });
  $('refreshLibraryBtn').addEventListener('click', () => loadLibrary());
  $('libraryGrid').addEventListener('click', async event => {
    const goRooms = event.target.closest('[data-library-go-rooms]');
    if (goRooms) { $('roomsTab').click(); return; }
    if (event.target.closest('[data-library-retry]')) { loadLibrary(); return; }
    const preview = event.target.closest('[data-library-preview]');
    if (preview) { window.previewFile?.(preview.dataset.libraryPreview, preview.dataset.name, preview.dataset.mime, Number(preview.dataset.size)); return; }
    const edit = event.target.closest('[data-library-edit]');
    if (edit) { openEditor(edit.dataset.libraryEdit, '', true); return; }
    const favorite = event.target.closest('[data-library-favorite]');
    if (favorite) {
      favorite.disabled = true;
      const item = items.find(entry => entry.id === favorite.dataset.libraryFavorite);
      if (!item) return;
      try {
        await api('/api/library/' + encodeURIComponent(item.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_favorite: !item.is_favorite }) });
        signature = '';
        await loadLibrary(true);
      } catch (error) { window.toast?.(error.message, 'error'); favorite.disabled = false; }
    }
  });

  $('libraryEditorModal').addEventListener('click', event => {
    if (event.target.closest('[data-library-close]')) closeEditor();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('libraryEditorModal').getAttribute('aria-hidden') === 'false') {
      event.stopImmediatePropagation();
      closeEditor();
    }
  }, true);

  $('libraryEditorForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('saveLibraryItem');
    const itemId = $('libraryItemId').value;
    const fileId = $('libraryFileId').value;
    button.disabled = true;
    try {
      const body = JSON.stringify({ shelf: $('libraryEditorShelf').value, note: $('libraryEditorNote').value, is_favorite: $('libraryEditorFavorite').checked });
      await api(itemId ? '/api/library/' + encodeURIComponent(itemId) : '/api/library', {
        method: itemId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: itemId ? body : JSON.stringify({ file_id: fileId, shelf: $('libraryEditorShelf').value, note: $('libraryEditorNote').value, is_favorite: $('libraryEditorFavorite').checked })
      });
      closeEditor();
      signature = '';
      await loadLibrary(true);
      window.loadRooms?.();
      window.toast?.(itemId ? 'Seu Acervo foi atualizado.' : 'Arquivo guardado no seu Acervo.');
    } catch (error) { window.toast?.(error.message, 'error'); }
    finally { button.disabled = false; }
  });

  $('removeLibraryItem').addEventListener('click', async () => {
    const itemId = $('libraryItemId').value;
    if (!itemId || !window.confirm('Remover este arquivo do seu Acervo? O arquivo original continuará na sala.')) return;
    const button = $('removeLibraryItem');
    button.disabled = true;
    try {
      await api('/api/library/' + encodeURIComponent(itemId), { method: 'DELETE' });
      closeEditor();
      signature = '';
      await loadLibrary(true);
      window.loadRooms?.();
      window.toast?.('Arquivo removido do seu Acervo.');
    } catch (error) { window.toast?.(error.message, 'error'); }
    finally { button.disabled = false; }
  });

})();
