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
  let spaces = [];
  let loading = false;
  let favoritesOnly = false;
  let signature = '';
  let reloadQueued = false;
  let modalMode = 'space';
  let modalSpaceId = '';

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

  function allBookcases() {
    return spaces.flatMap(space => (space.shelves || []).map(bookcase => ({ ...bookcase, space_id: space.id, space_name: space.name })));
  }

  function selectedSpaceId() {
    const value = $('libraryShelfFilter').value;
    if (value.startsWith('space:')) return value.slice(6);
    if (value.startsWith('bookcase:')) return allBookcases().find(bookcase => bookcase.id === value.slice(9))?.space_id || '';
    return '';
  }

  function renderFilterOptions() {
    const select = $('libraryShelfFilter');
    const current = select.value;
    select.innerHTML = '<option value="">Todos os espaços</option>' + spaces.map(space => {
      const shelvesOptions = (space.shelves || []).map(bookcase => `<option value="bookcase:${esc(bookcase.id)}">　↳ ${esc(bookcase.name)}</option>`).join('');
      return `<optgroup label="${esc(space.name)}"><option value="space:${esc(space.id)}">${esc(space.name)} · espaço</option>${shelvesOptions}</optgroup>`;
    }).join('');
    const validSpace = current.startsWith('space:') && spaces.some(space => space.id === current.slice(6));
    const validBookcase = current.startsWith('bookcase:') && allBookcases().some(bookcase => bookcase.id === current.slice(9));
    select.value = validSpace || validBookcase ? current : '';
  }

  function renderEditorBookcases(preferredId = $('libraryEditorShelf').value) {
    const spaceId = $('libraryEditorSpace').value;
    const space = spaces.find(entry => entry.id === spaceId);
    const bookcases = space?.shelves || [];
    $('libraryEditorShelf').innerHTML = bookcases.length
      ? bookcases.map(bookcase => `<option value="${esc(bookcase.id)}">${esc(bookcase.name)}</option>`).join('')
      : '<option value="">Crie uma prateleira</option>';
    if (bookcases.some(bookcase => bookcase.id === preferredId)) $('libraryEditorShelf').value = preferredId;
    else if (bookcases.length) $('libraryEditorShelf').value = bookcases[0].id;
    $('libraryCreateBookcaseFromEditor').disabled = !space;
  }

  function renderEditorLocations() {
    const select = $('libraryEditorSpace');
    const current = select.value;
    select.innerHTML = spaces.map(space => `<option value="${esc(space.id)}">${esc(space.name)}</option>`).join('');
    if (spaces.some(space => space.id === current)) select.value = current;
    else if (spaces.length) select.value = spaces[0].id;
    renderEditorBookcases();
  }

  function renderShelves() {
    renderFilterOptions();
    renderEditorLocations();
    return spaces;
  }

  function filteredItems() {
    const query = normalize($('librarySearch').value.trim());
    const filter = $('libraryShelfFilter').value;
    return items.filter(item => {
      if (favoritesOnly && !item.is_favorite) return false;
      if (filter.startsWith('space:') && item.space_id !== filter.slice(6)) return false;
      if (filter.startsWith('bookcase:') && item.bookcase_id !== filter.slice(9)) return false;
      if (!query) return true;
      const text = normalize([item.original_name, item.room_name, item.uploader, item.space_name, item.bookcase_name, item.note].join(' '));
      return text.includes(query);
    });
  }

  function renderSpaceTiles() {
    const current = $('libraryShelfFilter').value;
    const counts = new Map();
    items.forEach(item => counts.set(item.space_id, (counts.get(item.space_id) || 0) + 1));
    $('librarySpaces').innerHTML = `<button class="library-space-tile ${current ? '' : 'is-active'}" type="button" data-library-space="" aria-pressed="${!current}"><span class="library-space-icon"><i class="fas fa-layer-group" aria-hidden="true"></i></span><span class="library-space-copy"><strong>Todos</strong><small>${items.length} ${items.length === 1 ? 'arquivo' : 'arquivos'}</small></span></button>` + spaces.map(space => {
      const count = counts.get(space.id) || 0;
      const active = selectedSpaceId() === space.id;
      const shelfCount = (space.shelves || []).length;
      return `<button class="library-space-tile ${active ? 'is-active' : ''}" type="button" data-library-space="${esc(space.id)}" aria-pressed="${active}"><span class="library-space-icon"><i class="fas fa-folder" aria-hidden="true"></i></span><span class="library-space-copy"><strong>${esc(space.name)}</strong><small>${count} ${count === 1 ? 'arquivo' : 'arquivos'} · ${shelfCount} ${shelfCount === 1 ? 'prateleira' : 'prateleiras'}</small></span></button>`;
    }).join('');
  }

  function renderBookcaseTiles() {
    const spaceId = selectedSpaceId();
    const space = spaces.find(entry => entry.id === spaceId);
    const panel = $('libraryBookcasesPanel');
    panel.hidden = !space;
    if (!space) return;
    $('libraryBookcasesTitle').innerHTML = `<i class="fas fa-books" aria-hidden="true"></i> Prateleiras de ${esc(space.name)}`;
    const current = $('libraryShelfFilter').value;
    const counts = new Map();
    items.filter(item => item.space_id === space.id).forEach(item => counts.set(item.bookcase_id, (counts.get(item.bookcase_id) || 0) + 1));
    const spaceItemCount = items.filter(item => item.space_id === space.id).length;
    $('libraryBookcases').innerHTML = `<button class="library-bookcase-tile ${current === `space:${space.id}` ? 'is-active' : ''}" type="button" data-library-bookcase="space:${esc(space.id)}" aria-pressed="${current === `space:${space.id}`}"><i class="fas fa-layer-group" aria-hidden="true"></i><span><strong>Todas as prateleiras</strong><small>${spaceItemCount} ${spaceItemCount === 1 ? 'arquivo' : 'arquivos'}</small></span></button>` + (space.shelves || []).map(bookcase => {
      const count = counts.get(bookcase.id) || 0;
      const active = current === `bookcase:${bookcase.id}`;
      return `<button class="library-bookcase-tile ${active ? 'is-active' : ''}" type="button" data-library-bookcase="bookcase:${esc(bookcase.id)}" aria-pressed="${active}"><i class="fas fa-bookmark" aria-hidden="true"></i><span><strong>${esc(bookcase.name)}</strong><small>${count} ${count === 1 ? 'arquivo' : 'arquivos'}</small></span></button>`;
    }).join('');
  }

  function render() {
    renderShelves();
    renderSpaceTiles();
    renderBookcaseTiles();
    const filtered = filteredItems();
    const summary = $('librarySummary');
    summary.innerHTML = `<span><strong>${filtered.length}</strong> ${filtered.length === 1 ? 'arquivo' : 'arquivos'} encontrados</span><span><i class="fas fa-folder-open" aria-hidden="true"></i> ${spaces.length} ${spaces.length === 1 ? 'espaço' : 'espaços'}</span>`;
    $('libraryFavoritesFilter').classList.toggle('is-active', favoritesOnly);
    $('libraryFavoritesFilter').setAttribute('aria-pressed', String(favoritesOnly));
    $('librarySearchClear').hidden = !$('librarySearch').value;
    if (!filtered.length) {
      const hasFilters = Boolean($('librarySearch').value || $('libraryShelfFilter').value || favoritesOnly);
      $('libraryGrid').innerHTML = hasFilters
        ? '<div class="library-empty"><i class="fas fa-magnifying-glass"></i><h3>Nenhum arquivo encontrado</h3><p>Tente outro termo ou limpe os filtros para ver seu Acervo.</p><button class="btn btn-outline" type="button" data-library-clear-filters><i class="fas fa-filter-circle-xmark"></i> Limpar filtros</button></div>'
        : '<div class="library-empty"><span class="library-empty-icon"><i class="fas fa-box-open"></i></span><h3>Seu Acervo está pronto</h3><p>Crie espaços e prateleiras para organizar seus arquivos. Depois, guarde arquivos das salas no espaço certo.</p><button class="btn btn-outline" type="button" data-library-create-space><i class="fas fa-folder-plus"></i> Criar espaço</button><button class="btn btn-outline" type="button" data-library-go-rooms><i class="fas fa-door-open"></i> Explorar salas</button></div>';
      return;
    }
    $('libraryGrid').innerHTML = filtered.map((item, index) => `
      <article class="library-card" style="--library-order:${Math.min(index, 10)}">
        <div class="library-card-top"><span class="library-shelf"><i class="fas fa-folder-tree" aria-hidden="true"></i> ${esc(item.space_name || 'Guardados')} <span aria-hidden="true">/</span> ${esc(item.bookcase_name || item.shelf || 'Geral')}</span><button type="button" class="library-star ${item.is_favorite ? 'is-active' : ''}" data-library-favorite="${esc(item.id)}" aria-label="${item.is_favorite ? 'Remover dos importantes' : 'Marcar como importante'}" aria-pressed="${Boolean(item.is_favorite)}"><i class="fas fa-star"></i></button></div>
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
      const nextSpaces = Array.isArray(result.spaces) ? result.spaces : [];
      const nextSignature = JSON.stringify([nextItems, nextSpaces]);
      if (nextSignature !== signature) {
        signature = nextSignature;
        items = nextItems;
        spaces = nextSpaces.map(space => ({ ...space, shelves: Array.isArray(space.shelves) ? space.shelves : [] }));
        render();
      }
    } catch (error) {
      if (!silent) $('libraryGrid').innerHTML = `<div class="library-empty library-error"><i class="fas fa-triangle-exclamation"></i><h3>Não foi possível carregar seu Acervo</h3><p>${esc(error.message)}</p><button class="btn btn-outline" type="button" data-library-retry><i class="fas fa-rotate-right"></i> Tentar novamente</button></div>`;
    } finally {
      loading = false;
      if (reloadQueued) { reloadQueued = false; loadLibrary(true); }
    }
  }

  function closeEditor() {
    const modal = $('libraryEditorModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  function openSpaceModal(mode = 'space', spaceId = '') {
    modalMode = mode;
    modalSpaceId = spaceId || selectedSpaceId() || $('libraryEditorSpace').value || '';
    const isBookcase = mode === 'bookcase';
    const space = spaces.find(entry => entry.id === modalSpaceId);
    if (isBookcase && !space) { window.toast?.('Escolha um espaço primeiro.', 'error'); return; }
    $('librarySpaceForm').reset();
    $('librarySpaceTitle').innerHTML = isBookcase ? '<i class="fas fa-books"></i> Criar prateleira' : '<i class="fas fa-folder-plus"></i> Criar espaço pessoal';
    $('librarySpaceNameLabel').textContent = isBookcase ? 'Nome da prateleira' : 'Nome do espaço';
    $('librarySpaceName').placeholder = isBookcase ? 'Ex.: Para ler, Receitas, Viagens' : 'Ex.: Trabalho, documentos, viagens';
    $('librarySpaceHelp').textContent = isBookcase ? `Esta prateleira ficará dentro de “${space.name}”.` : 'Cada espaço pode ter suas próprias prateleiras. Só você vê esta organização.';
    $('saveLibrarySpace').innerHTML = isBookcase ? '<i class="fas fa-plus"></i> Criar prateleira' : '<i class="fas fa-folder-plus"></i> Criar espaço';
    const modal = $('librarySpaceModal');
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
    const currentSpace = item?.space_id || selectedSpaceId() || spaces[0]?.id || '';
    $('libraryEditorSpace').value = currentSpace;
    renderEditorBookcases(item?.bookcase_id || '');
    $('libraryEditorNote').value = item ? item.note : '';
    $('libraryEditorFavorite').checked = Boolean(item && item.is_favorite);
    $('removeLibraryItem').hidden = !item;
    $('saveLibraryItem').innerHTML = item ? '<i class="fas fa-check"></i> Salvar organização' : '<i class="fas fa-bookmark"></i> Guardar arquivo';
    $('libraryEditorTitle').innerHTML = item ? '<i class="fas fa-bookmark"></i> Organizar no Meu Acervo' : '<i class="fas fa-bookmark"></i> Guardar no Meu Acervo';
    const modal = $('libraryEditorModal');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => $('libraryEditorSpace').focus(), 40);
  }

  window.openLibraryEditor = openEditor;
  window.loadLibrary = loadLibrary;

  $('librarySearch').addEventListener('input', render);
  $('librarySearchClear').addEventListener('click', () => { $('librarySearch').value = ''; render(); $('librarySearch').focus(); });
  $('libraryShelfFilter').addEventListener('change', render);
  $('libraryEditorSpace').addEventListener('change', () => renderEditorBookcases());
  $('libraryFavoritesFilter').addEventListener('click', () => { favoritesOnly = !favoritesOnly; render(); });
  $('createLibrarySpaceBtn').addEventListener('click', () => openSpaceModal('space'));
  $('createLibraryBookcaseBtn').addEventListener('click', () => openSpaceModal('bookcase'));
  $('libraryCreateSpaceFromEditor').addEventListener('click', () => openSpaceModal('space'));
  $('libraryCreateBookcaseFromEditor').addEventListener('click', () => openSpaceModal('bookcase', $('libraryEditorSpace').value));
  $('refreshLibraryBtn').addEventListener('click', () => loadLibrary());
  $('libraryGrid').addEventListener('click', async event => {
    const goRooms = event.target.closest('[data-library-go-rooms]');
    if (goRooms) { $('roomsTab').click(); return; }
    if (event.target.closest('[data-library-create-space]')) { openSpaceModal('space'); return; }
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
    $('libraryShelfFilter').value = tile.dataset.librarySpace ? `space:${tile.dataset.librarySpace}` : '';
    render();
  });

  $('libraryBookcases').addEventListener('click', event => {
    const tile = event.target.closest('[data-library-bookcase]');
    if (!tile) return;
    $('libraryShelfFilter').value = tile.dataset.libraryBookcase;
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
      let created;
      if (modalMode === 'bookcase') {
        created = await api(`/api/library/spaces/${encodeURIComponent(modalSpaceId)}/shelves`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        spaces = spaces.map(space => space.id === modalSpaceId ? { ...space, shelves: [...space.shelves, created] } : space);
        $('libraryShelfFilter').value = `bookcase:${created.id}`;
        if ($('libraryEditorModal').getAttribute('aria-hidden') === 'false') {
          $('libraryEditorSpace').value = modalSpaceId;
          renderEditorBookcases(created.id);
        }
      } else {
        created = await api('/api/library/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        spaces = [...spaces.filter(space => space.id !== created.id), { ...created, shelves: created.shelves || [] }];
        $('libraryShelfFilter').value = `space:${created.id}`;
        if ($('libraryEditorModal').getAttribute('aria-hidden') === 'false') {
          renderEditorLocations();
          $('libraryEditorSpace').value = created.id;
          renderEditorBookcases(created.shelves?.[0]?.id || '');
        }
      }
      signature = '';
      render();
      await loadLibrary(true);
      closeSpaceModal();
      window.toast?.(modalMode === 'bookcase' ? `Prateleira “${created.name}” criada.` : `Espaço “${created.name}” criado.`);
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
    if (!$('libraryEditorSpace').value || !$('libraryEditorShelf').value) {
      window.toast?.('Escolha ou crie uma prateleira para guardar este arquivo.', 'error');
      return;
    }
    button.disabled = true;
    try {
      const placement = { space_id: $('libraryEditorSpace').value, bookcase_id: $('libraryEditorShelf').value };
      const common = { ...placement, note: $('libraryEditorNote').value, is_favorite: $('libraryEditorFavorite').checked };
      await api(itemId ? '/api/library/' + encodeURIComponent(itemId) : '/api/library', {
        method: itemId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemId ? common : { file_id: fileId, ...common })
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
