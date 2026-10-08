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
  let spaces = [];
  let loading = false;
  let favoritesOnly = false;
  let signature = '';
  let reloadQueued = false;

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
    const editor = $('libraryEditorShelf');
    const editorCurrent = editor.value;
    const names = [...new Set([...shelves, ...spaces.map(space => space.name), ...items.map(item => item.shelf)].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    select.innerHTML = '<option value="">Todos os espaços</option>' + names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    if (names.includes(current)) select.value = current;
    editor.innerHTML = (names.includes('Guardados') ? '' : '<option value="Guardados">Guardados</option>') + names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    if (names.includes(editorCurrent) || editorCurrent === 'Guardados') editor.value = editorCurrent;
    else editor.value = names[0] || 'Guardados';
    return names;
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
    const names = renderShelves();
    const spaceCounts = new Map();
    items.forEach(item => spaceCounts.set(item.shelf || 'Guardados', (spaceCounts.get(item.shelf || 'Guardados') || 0) + 1));
    $('librarySpaces').innerHTML = `<button class="library-space-tile ${$('libraryShelfFilter').value ? '' : 'is-active'}" type="button" data-library-space="" aria-pressed="${!$('libraryShelfFilter').value}"><span class="library-space-icon"><i class="fas fa-layer-group" aria-hidden="true"></i></span><span class="library-space-copy"><strong>Todos</strong><small>${items.length} ${items.length === 1 ? 'arquivo' : 'arquivos'}</small></span></button>` + names.map(name => {
      const count = spaceCounts.get(name) || 0;
      const active = $('libraryShelfFilter').value === name;
      return `<button class="library-space-tile ${active ? 'is-active' : ''}" type="button" data-library-space="${esc(name)}" aria-pressed="${active}"><span class="library-space-icon"><i class="fas fa-folder" aria-hidden="true"></i></span><span class="library-space-copy"><strong>${esc(name)}</strong><small>${count} ${count === 1 ? 'arquivo' : 'arquivos'}</small></span></button>`;
    }).join('');
    const filtered = filteredItems();
    const summary = $('librarySummary');
    summary.innerHTML = `<span><strong>${filtered.length}</strong> ${filtered.length === 1 ? 'arquivo' : 'arquivos'} encontrados</span><span><i class="fas fa-folder-open" aria-hidden="true"></i> ${names.length} ${names.length === 1 ? 'espaço' : 'espaços'}</span>`;
    $('libraryFavoritesFilter').classList.toggle('is-active', favoritesOnly);
    $('libraryFavoritesFilter').setAttribute('aria-pressed', String(favoritesOnly));
    $('librarySearchClear').hidden = !$('librarySearch').value;
    if (!filtered.length) {
      const hasFilters = Boolean($('librarySearch').value || $('libraryShelfFilter').value || favoritesOnly);
      $('libraryGrid').innerHTML = hasFilters
        ? '<div class="library-empty"><i class="fas fa-magnifying-glass"></i><h3>Nenhum arquivo encontrado</h3><p>Tente outro termo ou limpe os filtros para ver seu Acervo.</p><button class="btn btn-outline" type="button" data-library-clear-filters><i class="fas fa-filter-circle-xmark"></i> Limpar filtros</button></div>'
        : names.length
          ? '<div class="library-empty"><span class="library-empty-icon"><i class="fas fa-folder-open"></i></span><h3>Seus espaços já estão prontos</h3><p>Guarde arquivos das salas e escolha em qual espaço pessoal quer organizá-los.</p><button class="btn btn-outline" type="button" data-library-go-rooms><i class="fas fa-door-open"></i> Explorar salas</button></div>'
          : '<div class="library-empty"><span class="library-empty-icon"><i class="fas fa-box-open"></i></span><h3>Seu Acervo começa aqui</h3><p>Crie um espaço para separar seus arquivos. Depois, abra uma sala e toque no marcador de um arquivo para guardá-lo no seu Acervo.</p><button class="btn btn-outline" type="button" data-library-create-space><i class="fas fa-folder-plus"></i> Criar meu primeiro espaço</button><button class="btn btn-outline" type="button" data-library-go-rooms><i class="fas fa-door-open"></i> Explorar salas</button></div>';
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
    if (loading) { reloadQueued = true; return; }
    loading = true;
    if (!silent && !items.length) $('libraryGrid').innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Preparando seu Acervo...</div>';
    try {
      const result = await api('/api/library');
      const nextItems = Array.isArray(result.items) ? result.items : [];
      const nextShelves = Array.isArray(result.shelves) ? result.shelves : [];
      const nextSpaces = Array.isArray(result.spaces) ? result.spaces : [];
      const nextSignature = JSON.stringify([nextItems, nextShelves, nextSpaces]);
      if (nextSignature !== signature) {
        signature = nextSignature;
        items = nextItems;
        shelves = nextShelves;
        spaces = nextSpaces;
        render();
      }
    } catch (error) {
      if (!silent) $('libraryGrid').innerHTML = `<div class="library-empty library-error"><i class="fas fa-triangle-exclamation"></i><h3>Não foi possível carregar seu Acervo</h3><p>${esc(error.message)}</p><button class="btn btn-outline" type="button" data-library-retry><i class="fas fa-rotate-right"></i> Tentar novamente</button></div>`;
    } finally {
      loading = false;
      if (reloadQueued) {
        reloadQueued = false;
        loadLibrary(true);
      }
    }
  }

  function closeEditor() {
    const modal = $('libraryEditorModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  function openSpaceModal() {
    const modal = $('librarySpaceModal');
    $('librarySpaceForm').reset();
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => $('librarySpaceName').focus(), 40);
  }

  function closeSpaceModal() {
    const modal = $('librarySpaceModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  async function openEditor(fileId, fileName, saved) {
    if (saved && !items.some(item => item.file_id === String(fileId))) await loadLibrary(true);
    const item = items.find(entry => entry.file_id === String(fileId));
    renderShelves();
    $('libraryFileId').value = String(fileId);
    $('libraryItemId').value = item ? item.id : '';
    $('libraryEditorFileName').textContent = item ? item.original_name : String(fileName || 'Arquivo');
    $('libraryEditorShelf').value = item ? item.shelf : ($('libraryShelfFilter').value || 'Guardados');
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
  $('librarySearchClear').addEventListener('click', () => { $('librarySearch').value = ''; render(); $('librarySearch').focus(); });
  $('libraryShelfFilter').addEventListener('change', render);
  $('libraryFavoritesFilter').addEventListener('click', () => { favoritesOnly = !favoritesOnly; render(); });
  $('createLibrarySpaceBtn').addEventListener('click', openSpaceModal);
  $('libraryCreateSpaceFromEditor').addEventListener('click', openSpaceModal);
  $('refreshLibraryBtn').addEventListener('click', () => loadLibrary());
  $('libraryGrid').addEventListener('click', async event => {
    const goRooms = event.target.closest('[data-library-go-rooms]');
    if (goRooms) { $('roomsTab').click(); return; }
    if (event.target.closest('[data-library-create-space]')) { openSpaceModal(); return; }
    if (event.target.closest('[data-library-clear-filters]')) {
      $('librarySearch').value = '';
      $('libraryShelfFilter').value = '';
      favoritesOnly = false;
      render();
      return;
    }
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

  $('librarySpaces').addEventListener('click', event => {
    const tile = event.target.closest('[data-library-space]');
    if (!tile) return;
    $('libraryShelfFilter').value = tile.dataset.librarySpace;
    render();
  });

  $('librarySpaceModal').addEventListener('click', event => {
    if (event.target.closest('[data-library-space-close]')) closeSpaceModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('librarySpaceModal').getAttribute('aria-hidden') === 'false') {
      event.stopImmediatePropagation();
      closeSpaceModal();
    }
  }, true);

  $('librarySpaceForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('saveLibrarySpace');
    const name = $('librarySpaceName').value.trim();
    if (!name) { $('librarySpaceName').focus(); return; }
    button.disabled = true;
    try {
      const created = await api('/api/library/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      $('libraryShelfFilter').value = created.name;
      spaces = [...spaces.filter(space => space.name.toLocaleLowerCase('pt-BR') !== created.name.toLocaleLowerCase('pt-BR')), created];
      shelves = [...new Set([...shelves, created.name])];
      signature = '';
      render();
      await loadLibrary(true);
      renderShelves();
      if ($('libraryEditorModal').getAttribute('aria-hidden') === 'false') $('libraryEditorShelf').value = created.name;
      closeSpaceModal();
      window.toast?.(`Espaço “${created.name}” criado.`);
    } catch (error) { window.toast?.(error.message, 'error'); }
    finally { button.disabled = false; }
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
