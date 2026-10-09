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
  let modalBookcaseId = '';
  let pendingLibraryEditor = null;

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

  function orderedSpaces() {
    const counts = new Map();
    items.forEach(item => counts.set(item.space_id, (counts.get(item.space_id) || 0) + 1));
    return [...spaces].sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.name.localeCompare(b.name, 'pt-BR'));
  }

  function displayBookcaseName(name) {
    return name === 'Geral' ? 'Principal' : name;
  }

  function filterLabel(value) {
    if (!value) return 'Todos os espaços';
    if (value.startsWith('space:')) return spaces.find(space => space.id === value.slice(6))?.name || 'Todos os espaços';
    if (value.startsWith('bookcase:')) {
      const bookcase = allBookcases().find(entry => entry.id === value.slice(9));
      return bookcase ? `${bookcase.space_name} · ${displayBookcaseName(bookcase.name)}` : 'Todos os espaços';
    }
    return 'Todos os espaços';
  }

  function placePickerMenu(button, menu) {
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(rect.width, window.innerWidth - margin * 2);
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const below = window.innerHeight - rect.bottom - margin * 2;
    const above = rect.top - margin * 2;
    const openBelow = below >= 180 || below >= above;
    const available = Math.max(64, Math.min(360, openBelow ? below : above));
    menu.classList.add('is-floating');
    menu.style.left = left + 'px';
    menu.style.width = width + 'px';
    menu.style.maxHeight = available + 'px';
    if (openBelow) {
      menu.style.top = Math.min(window.innerHeight - available - margin, rect.bottom + 7) + 'px';
      menu.style.bottom = 'auto';
    } else {
      menu.style.top = 'auto';
      menu.style.bottom = Math.max(margin, window.innerHeight - rect.top + 7) + 'px';
    }
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
    const validSpace = current.startsWith('space:') && spaces.some(space => space.id === current.slice(6));
    const validBookcase = current.startsWith('bookcase:') && allBookcases().some(bookcase => bookcase.id === current.slice(9));
    select.value = validSpace || validBookcase ? current : '';
    const selected = select.value;
    $('libraryShelfFilterLabel').textContent = filterLabel(selected);
    $('libraryShelfFilterMenu').innerHTML = [
      `<button class="library-filter-option ${selected ? '' : 'is-selected'}" type="button" role="option" data-library-filter="" aria-selected="${!selected}"><i class="fas fa-layer-group" aria-hidden="true"></i><span>Todos os espaços</span></button>`,
      ...orderedSpaces().map(space => {
        const value = `space:${space.id}`;
        const shelves = (space.shelves || []).length > 1 ? space.shelves.map(bookcase => {
          const shelfValue = `bookcase:${bookcase.id}`;
          return `<button class="library-filter-option is-nested ${selected === shelfValue ? 'is-selected' : ''}" type="button" role="option" data-library-filter="${esc(shelfValue)}" aria-selected="${selected === shelfValue}"><i class="fas fa-bookmark" aria-hidden="true"></i><span>${esc(displayBookcaseName(bookcase.name))}</span></button>`;
        }).join('') : '';
        return `<div class="library-filter-group" role="group"><button class="library-filter-option ${selected === value ? 'is-selected' : ''}" type="button" role="option" data-library-filter="${esc(value)}" aria-selected="${selected === value}"><i class="fas fa-folder" aria-hidden="true"></i><span>${esc(space.name)}</span></button>${shelves}</div>`;
      })
    ].join('');
    const trigger = $('libraryShelfFilterButton');
    trigger.setAttribute('aria-expanded', String(!($('libraryShelfFilterMenu').hidden)));
  }

  function renderEditorBookcases(preferredId = $('libraryEditorShelf').value) {
    const spaceId = $('libraryEditorSpace').value;
    const space = spaces.find(entry => entry.id === spaceId);
    const bookcases = space?.shelves || [];
    $('libraryEditorShelf').innerHTML = bookcases.length
      ? bookcases.map(bookcase => `<option value="${esc(bookcase.id)}">${esc(displayBookcaseName(bookcase.name))}</option>`).join('')
      : '<option value="">Crie uma prateleira</option>';
    if (bookcases.some(bookcase => bookcase.id === preferredId)) $('libraryEditorShelf').value = preferredId;
    else if (bookcases.length) $('libraryEditorShelf').value = bookcases[0].id;
    $('libraryCreateBookcaseFromEditor').disabled = !space;
    renderEditorPicker('shelf');
  }

  function renderEditorPicker(kind) {
    const isSpace = kind === 'space';
    const select = $(isSpace ? 'libraryEditorSpace' : 'libraryEditorShelf');
    const button = $(isSpace ? 'libraryEditorSpaceButton' : 'libraryEditorShelfButton');
    const label = $(isSpace ? 'libraryEditorSpaceLabel' : 'libraryEditorShelfLabel');
    const menu = $(isSpace ? 'libraryEditorSpaceMenu' : 'libraryEditorShelfMenu');
    const options = isSpace
      ? spaces.map(space => ({ id: space.id, name: space.name }))
      : (spaces.find(space => space.id === $('libraryEditorSpace').value)?.shelves || []).map(shelf => ({ id: shelf.id, name: displayBookcaseName(shelf.name) }));
    const selected = options.find(option => option.id === select.value);
    label.textContent = selected?.name || (isSpace ? 'Escolha um espaço' : 'Escolha uma prateleira');
    button.disabled = !options.length;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    menu.innerHTML = options.length
      ? options.map(option => `<button class="library-filter-option ${option.id === select.value ? 'is-selected' : ''}" type="button" role="option" data-library-editor-choice="${kind}" data-value="${esc(option.id)}" aria-selected="${option.id === select.value}"><i class="fas ${isSpace ? 'fa-folder' : 'fa-bookmark'}" aria-hidden="true"></i><span>${esc(option.name)}</span></button>`).join('')
      : `<div class="library-picker-empty">${isSpace ? 'Crie um espaço para continuar.' : 'Crie uma prateleira neste espaço.'}</div>`;
  }

  function renderEditorLocations() {
    const select = $('libraryEditorSpace');
    const current = select.value;
    select.innerHTML = spaces.length
      ? spaces.map(space => `<option value="${esc(space.id)}">${esc(space.name)}</option>`).join('')
      : '<option value="">Crie um espaço primeiro</option>';
    if (spaces.some(space => space.id === current)) select.value = current;
    else if (spaces.length) select.value = spaces[0].id;
    renderEditorBookcases();
    renderEditorPicker('space');
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
      const text = normalize([item.original_name, item.room_name, item.uploader_name, item.uploader, item.space_name, item.bookcase_name, item.note].join(' '));
      return text.includes(query);
    });
  }

  function renderSpaceTiles() {
    const current = $('libraryShelfFilter').value;
    const counts = new Map();
    items.forEach(item => counts.set(item.space_id, (counts.get(item.space_id) || 0) + 1));
    if (!spaces.length) {
      $('librarySpaces').innerHTML = `<button class="library-space-tile library-space-setup" type="button" data-library-create-space><span class="library-space-icon"><i class="fas fa-folder-plus" aria-hidden="true"></i></span><span class="library-space-copy"><strong>Criar meu primeiro espaço</strong><small>Ex.: Trabalho, Estudos, Viagens</small></span></button>`;
      return;
    }
    $('librarySpaces').innerHTML = `<button class="library-space-tile library-space-all ${current ? '' : 'is-active'}" type="button" data-library-space="" aria-pressed="${!current}"><span class="library-space-icon"><i class="fas fa-layer-group" aria-hidden="true"></i></span><span class="library-space-copy"><strong>Todos</strong><small>${items.length} ${items.length === 1 ? 'arquivo' : 'arquivos'}</small></span></button>` + orderedSpaces().map(space => {
      const count = counts.get(space.id) || 0;
      const active = selectedSpaceId() === space.id;
      const shelfCount = (space.shelves || []).length;
      const details = count ? count + (count === 1 ? ' arquivo' : ' arquivos') + ' · ' + shelfCount + (shelfCount === 1 ? ' prateleira' : ' prateleiras') : 'Vazio · ' + shelfCount + (shelfCount === 1 ? ' prateleira' : ' prateleiras');
      return `<div class="library-space-option"><button class="library-space-tile ${active ? 'is-active' : ''}" type="button" data-library-space="${esc(space.id)}" aria-pressed="${active}" title="Abrir o espaço ${esc(space.name)}"><span class="library-space-icon"><i class="fas fa-folder" aria-hidden="true"></i></span><span class="library-space-copy"><strong>${esc(space.name)}</strong><small>${esc(details)}</small></span></button><div class="library-location-actions"><button type="button" data-library-edit-space="${esc(space.id)}" title="Renomear o espaço ${esc(space.name)}" aria-label="Renomear o espaço ${esc(space.name)}"><i class="fas fa-pen" aria-hidden="true"></i></button><button type="button" class="is-danger" data-library-delete-space="${esc(space.id)}" title="Excluir o espaço ${esc(space.name)}" aria-label="Excluir o espaço ${esc(space.name)}"><i class="fas fa-trash" aria-hidden="true"></i></button></div></div>`;
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
    $('libraryBookcases').innerHTML = `<button class="library-bookcase-tile ${current === 'space:' + space.id ? 'is-active' : ''}" type="button" data-library-bookcase="space:${esc(space.id)}" aria-pressed="${current === 'space:' + space.id}"><i class="fas fa-layer-group" aria-hidden="true"></i><span><strong>Todas as prateleiras</strong><small>${spaceItemCount} ${spaceItemCount === 1 ? 'arquivo' : 'arquivos'}</small></span></button>` + (space.shelves || []).map(bookcase => {
      const count = counts.get(bookcase.id) || 0;
      const active = current === `bookcase:${bookcase.id}`;
      return `<div class="library-bookcase-option"><button class="library-bookcase-tile ${active ? 'is-active' : ''}" type="button" data-library-bookcase="bookcase:${esc(bookcase.id)}" aria-pressed="${active}" title="Filtrar pela prateleira ${esc(displayBookcaseName(bookcase.name))}"><i class="fas fa-bookmark" aria-hidden="true"></i><span><strong>${esc(displayBookcaseName(bookcase.name))}</strong><small>${count} ${count === 1 ? 'arquivo' : 'arquivos'}</small></span></button><div class="library-location-actions"><button type="button" data-library-edit-bookcase="${esc(bookcase.id)}" data-library-space-id="${esc(space.id)}" title="Renomear a prateleira ${esc(displayBookcaseName(bookcase.name))}" aria-label="Renomear a prateleira ${esc(displayBookcaseName(bookcase.name))}"><i class="fas fa-pen" aria-hidden="true"></i></button><button type="button" class="is-danger" data-library-delete-bookcase="${esc(bookcase.id)}" data-library-space-id="${esc(space.id)}" title="Excluir a prateleira ${esc(displayBookcaseName(bookcase.name))}" aria-label="Excluir a prateleira ${esc(displayBookcaseName(bookcase.name))}"><i class="fas fa-trash" aria-hidden="true"></i></button></div></div>`;
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
        <div class="library-card-top"><span class="library-shelf"><i class="fas fa-folder-tree" aria-hidden="true"></i> ${esc(item.space_name || 'Guardados')} <span aria-hidden="true">/</span> ${esc(displayBookcaseName(item.bookcase_name || item.shelf || 'Geral'))}</span><button type="button" class="library-star ${item.is_favorite ? 'is-active' : ''}" data-library-favorite="${esc(item.id)}" aria-label="${item.is_favorite ? 'Remover dos importantes' : 'Marcar como importante'}" aria-pressed="${Boolean(item.is_favorite)}"><i class="fas fa-star"></i></button></div>
        <div class="library-file-heading"><span class="library-file-icon"><i class="fas ${fileIcon(item)}" aria-hidden="true"></i></span><div class="library-file-copy"><h3 title="${esc(item.original_name)}">${esc(item.original_name)}</h3><p>${formatSize(item.size)} <span aria-hidden="true">·</span> guardado ${formatDate(item.saved_at)}</p></div></div>
        <div class="library-source"><i class="fas fa-folder-open" aria-hidden="true"></i><span>${esc(item.room_name || 'Envio direto')}</span><span class="library-source-separator">·</span><span>Cópia sua${item.uploader_name ? ' · original de ' + esc(item.uploader_name) : ''}</span></div>
        ${item.note ? `<p class="library-note"><i class="fas fa-quote-left" aria-hidden="true"></i>${esc(item.note)}</p>` : '<p class="library-note library-note-empty">Adicione uma anotação pessoal para guardar o contexto.</p>'}
        <div class="library-card-actions"><button class="btn btn-sm btn-outline" type="button" data-library-preview="${esc(item.id)}" data-library-item="1" data-name="${esc(item.original_name)}" data-mime="${esc(item.mime_type)}" data-size="${Number(item.size) || 0}" title="Visualizar ${esc(item.original_name)}" aria-label="Visualizar ${esc(item.original_name)}"><i class="fas fa-eye" aria-hidden="true"></i></button><a class="btn btn-sm btn-green" href="/download/library/${encodeURIComponent(item.id)}" title="Baixar ${esc(item.original_name)}" aria-label="Baixar ${esc(item.original_name)}"><i class="fas fa-download" aria-hidden="true"></i></a><button class="btn btn-sm btn-outline library-edit-action" type="button" data-library-edit="${esc(item.id)}" data-library-item="1" title="Mover, renomear ou anotar" aria-label="Mover, renomear ou anotar"><i class="fas fa-sliders" aria-hidden="true"></i></button><button class="btn btn-sm btn-outline is-danger" type="button" data-library-delete-item="${esc(item.id)}" title="Apagar esta cópia do Acervo" aria-label="Apagar esta cópia do Acervo"><i class="fas fa-trash" aria-hidden="true"></i></button></div>
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
    ['Space', 'Shelf'].forEach(name => {
      $('libraryEditor' + name + 'Menu').hidden = true;
      $('libraryEditor' + name + 'Button').setAttribute('aria-expanded', 'false');
    });
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  function openSpaceModal(mode = 'space', spaceId = '', bookcaseId = '') {
    modalMode = mode;
    modalSpaceId = spaceId || selectedSpaceId() || $('libraryEditorSpace').value || '';
    modalBookcaseId = bookcaseId || '';
    const isBookcase = mode === 'bookcase' || mode === 'edit-bookcase';
    const isEdit = mode === 'edit-space' || mode === 'edit-bookcase';
    const space = spaces.find(entry => entry.id === modalSpaceId);
    const bookcase = isBookcase && space ? (space.shelves || []).find(entry => entry.id === modalBookcaseId) : null;
    if (isBookcase && !space) { window.toast?.('Escolha um espaço primeiro.', 'error'); return; }
    if (mode === 'edit-bookcase' && !bookcase) { window.toast?.('Esta prateleira não foi encontrada.', 'error'); return; }
    $('librarySpaceForm').reset();
    $('librarySpaceTitle').innerHTML = isBookcase
      ? (isEdit ? '<i class="fas fa-pen"></i> Renomear prateleira' : '<i class="fas fa-books"></i> Criar prateleira')
      : (isEdit ? '<i class="fas fa-pen"></i> Renomear espaço' : '<i class="fas fa-folder-plus"></i> Criar espaço pessoal');
    $('librarySpaceNameLabel').textContent = isBookcase ? 'Nome da prateleira' : 'Nome do espaço';
    $('librarySpaceName').placeholder = isBookcase ? 'Ex.: Para ler, Receitas, Viagens' : 'Ex.: Trabalho, documentos, viagens';
    $('librarySpaceHelp').textContent = isBookcase
      ? 'Esta prateleira ficará dentro de “' + space.name + '”.'
      : 'Cada espaço pode ter suas próprias prateleiras. Só você vê esta organização.';
    $('saveLibrarySpace').innerHTML = isEdit
      ? '<i class="fas fa-check"></i> Salvar nome'
      : (isBookcase ? '<i class="fas fa-plus"></i> Criar prateleira' : '<i class="fas fa-folder-plus"></i> Criar espaço');
    $('librarySpaceName').value = isEdit ? (isBookcase ? bookcase.name : space.name) : '';
    const modal = $('librarySpaceModal');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => $('librarySpaceName').focus(), 40);
  }

  function closeSpaceModal() {
    pendingLibraryEditor = null;
    const modal = $('librarySpaceModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  async function deleteSpace(spaceId) {
    const space = spaces.find(entry => entry.id === spaceId);
    if (!space) return;
    const content = 'Excluir o espaço “' + space.name + '”? Os atalhos deste espaço sairão do Meu Acervo, mas os arquivos originais continuarão nas salas.';
    if (!window.confirm(content)) return;
    try {
      await api('/api/library/spaces/' + encodeURIComponent(spaceId), { method: 'DELETE' });
      if (selectedSpaceId() === spaceId) $('libraryShelfFilter').value = '';
      signature = '';
      await loadLibrary(true);
      window.loadRooms?.();
      window.toast?.('Espaço excluído. Os arquivos originais continuam nas salas.');
    } catch (error) { window.toast?.(error.message, 'error'); }
  }

  async function deleteBookcase(spaceId, bookcaseId) {
    const space = spaces.find(entry => entry.id === spaceId);
    const bookcase = space?.shelves?.find(entry => entry.id === bookcaseId);
    if (!space || !bookcase) return;
    if (space.shelves.length <= 1) {
      window.toast?.('Todo espaço precisa ter uma prateleira. Crie outra antes de excluir esta.', 'error');
      return;
    }
    const destination = space.shelves.find(entry => entry.id !== bookcaseId);
    const content = 'Excluir a prateleira “' + displayBookcaseName(bookcase.name) + '”? Os arquivos guardados nela serão movidos para “' + displayBookcaseName(destination.name) + '”. Os originais continuam nas salas.';
    if (!window.confirm(content)) return;
    try {
      const result = await api('/api/library/spaces/' + encodeURIComponent(spaceId) + '/shelves/' + encodeURIComponent(bookcaseId), { method: 'DELETE' });
      if ($('libraryShelfFilter').value === 'bookcase:' + bookcaseId) $('libraryShelfFilter').value = 'space:' + spaceId;
      signature = '';
      await loadLibrary(true);
      window.toast?.(result.moved_count
        ? result.moved_count + ' arquivo(s) movido(s) para “' + displayBookcaseName(result.destination) + '”.'
        : 'Prateleira excluída.');
    } catch (error) { window.toast?.(error.message, 'error'); }
  }

  async function openEditor(itemId, fileName) {
    if (!items.some(item => item.id === String(itemId))) await loadLibrary(true);
    if (!spaces.length) {
      window.toast?.('Crie seu primeiro espaço para organizar este arquivo.');
      pendingLibraryEditor = { itemId, fileName };
      openSpaceModal('space');
      return;
    }
    const item = items.find(entry => entry.id === String(itemId));
    if (!item) { window.toast?.('Item não encontrado no seu Acervo.', 'error'); return; }
    renderShelves();
    $('libraryItemId').value = item.id;
    $('libraryEditorFileName').textContent = item.original_name || String(fileName || 'Arquivo');
    const currentSpace = item.space_id || selectedSpaceId() || spaces[0]?.id || '';
    $('libraryEditorSpace').value = currentSpace;
    renderEditorBookcases(item.bookcase_id || '');
    renderEditorPicker('space');
    $('libraryEditorNote').value = item.note || '';
    $('libraryEditorFavorite').checked = Boolean(item.is_favorite);
    $('removeLibraryItem').hidden = false;
    $('saveLibraryItem').innerHTML = '<i class="fas fa-check"></i> Salvar organização';
    $('libraryEditorTitle').innerHTML = '<i class="fas fa-bookmark"></i> Organizar no Meu Acervo';
    const modal = $('libraryEditorModal');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => $('libraryEditorSpaceButton').focus(), 40);
  }

  window.openLibraryEditor = openEditor;
  window.loadLibrary = loadLibrary;

  // Guardar arquivo da sala no Acervo: cria a COPIA independente (snapshot).
  window.saveRoomFileToLibrary = async function (fileId) {
    if (!spaces.length) {
      try { await loadLibrary(true); } catch (e) {}
    }
    if (!spaces.length) {
      window.toast?.('Crie seu primeiro espaço para guardar este arquivo.');
      pendingLibraryEditor = { pendingFileId: String(fileId) };
      openSpaceModal('space');
      return;
    }
    const spaceId = selectedSpaceId() || spaces[0].id;
    const space = spaces.find(entry => entry.id === spaceId) || spaces[0];
    const bookcaseId = (space.shelves && space.shelves[0] && space.shelves[0].id) || '';
    try {
      window.toast?.('Guardando cópia no seu Acervo...');
      const saved = await api('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: String(fileId), space_id: space.id, bookcase_id: bookcaseId })
      });
      signature = '';
      await loadLibrary(true);
      window.loadRooms?.();
      window.toast?.('Cópia guardada no seu Acervo. Ela fica mesmo se a sala for excluída.');
      openEditor(saved.id, '');
    } catch (error) { window.toast?.(error.message, 'error'); }
  };

  $('librarySearch').addEventListener('input', render);
  $('librarySearchClear').addEventListener('click', () => { $('librarySearch').value = ''; render(); $('librarySearch').focus(); });
  $('libraryShelfFilterButton').addEventListener('click', () => {
    const menu = $('libraryShelfFilterMenu');
    menu.hidden = !menu.hidden;
    if (!menu.hidden) placePickerMenu($('libraryShelfFilterButton'), menu);
    $('libraryShelfFilterButton').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('libraryShelfFilterMenu').addEventListener('click', event => {
    const option = event.target.closest('[data-library-filter]');
    if (!option) return;
    $('libraryShelfFilter').value = option.dataset.libraryFilter;
    $('libraryShelfFilterMenu').hidden = true;
    $('libraryShelfFilterButton').setAttribute('aria-expanded', 'false');
    render();
  });
  document.addEventListener('click', event => {
    if (event.target.closest('.library-filter-picker')) return;
    $('libraryShelfFilterMenu').hidden = true;
    $('libraryShelfFilterButton').setAttribute('aria-expanded', 'false');
    if (!event.target.closest('.library-select-picker')) {
      ['Space', 'Shelf'].forEach(name => {
        const menu = $('libraryEditor' + name + 'Menu');
        const button = $('libraryEditor' + name + 'Button');
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      });
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!$('libraryShelfFilterMenu').hidden) {
        $('libraryShelfFilterMenu').hidden = true;
        $('libraryShelfFilterButton').setAttribute('aria-expanded', 'false');
        $('libraryShelfFilterButton').focus();
      }
      ['Space', 'Shelf'].forEach(name => {
        const menu = $('libraryEditor' + name + 'Menu');
        const button = $('libraryEditor' + name + 'Button');
        if (!menu.hidden) {
          menu.hidden = true;
          button.setAttribute('aria-expanded', 'false');
          button.focus();
        }
      });
    }
  });
  $('libraryEditorSpace').addEventListener('change', () => renderEditorBookcases());
  [['Space', 'libraryEditorSpace'], ['Shelf', 'libraryEditorShelf']].forEach(([name]) => {
    const button = $('libraryEditor' + name + 'Button');
    const menu = $('libraryEditor' + name + 'Menu');
    button.addEventListener('click', () => {
      const nextOpen = menu.hidden;
      ['Space', 'Shelf'].forEach(other => {
        $('libraryEditor' + other + 'Menu').hidden = true;
        $('libraryEditor' + other + 'Button').setAttribute('aria-expanded', 'false');
      });
      menu.hidden = !nextOpen;
      if (!menu.hidden) placePickerMenu(button, menu);
      button.setAttribute('aria-expanded', String(!menu.hidden));
    });
  });
  $('libraryFavoritesFilter').addEventListener('click', () => { favoritesOnly = !favoritesOnly; render(); });
  $('createLibrarySpaceBtn').addEventListener('click', () => openSpaceModal('space'));
  $('createLibraryBookcaseBtn').addEventListener('click', () => openSpaceModal('bookcase'));
  $('uploadLibraryBtn')?.addEventListener('click', () => {
    if (!spaces.length) {
      window.toast?.('Crie seu primeiro espaço para enviar arquivos.');
      openSpaceModal('space');
      return;
    }
    $('uploadLibraryInput').click();
  });
  $('uploadLibraryInput')?.addEventListener('change', async () => {
    const input = $('uploadLibraryInput');
    const picked = Array.from(input.files || []);
    input.value = '';
    if (!picked.length) return;
    const spaceId = selectedSpaceId() || spaces[0]?.id || '';
    const space = spaces.find(entry => entry.id === spaceId) || spaces[0];
    if (!space) { window.toast?.('Crie seu primeiro espaço para enviar arquivos.', 'error'); return; }
    const bookcaseId = (space.shelves && space.shelves[0] && space.shelves[0].id) || '';
    const form = new FormData();
    picked.slice(0, 5).forEach(file => form.append('files', file));
    form.append('space_id', space.id);
    if (bookcaseId) form.append('bookcase_id', bookcaseId);
    try {
      window.toast?.('Enviando ' + Math.min(picked.length, 5) + ' arquivo(s) ao Acervo...');
      const res = await fetch('/api/library/upload', { method: 'POST', credentials: 'same-origin', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível enviar.');
      signature = '';
      await loadLibrary(true);
      window.toast?.('Arquivo(s) guardado(s) no seu Acervo.');
    } catch (error) { window.toast?.(error.message, 'error'); }
  });
  $('libraryCreateSpaceFromEditor').addEventListener('click', () => openSpaceModal('space'));
  $('libraryCreateBookcaseFromEditor').addEventListener('click', () => openSpaceModal('bookcase', $('libraryEditorSpace').value));
  $('refreshLibraryBtn').addEventListener('click', () => loadLibrary());
  // Celular: tocar no titulo dobra/abre espacos e prateleiras (sem afetar os botoes).
  const isMobileView = () => window.matchMedia('(max-width: 800px)').matches;
  $('librarySpacesHeading')?.addEventListener('click', event => {
    if (!isMobileView() || event.target.closest('button, a')) return;
    $('librarySpacesHeading').classList.toggle('is-collapsed');
    $('librarySpaces').classList.toggle('is-collapsed');
  });
  $('libraryBookcasesHeading')?.addEventListener('click', event => {
    if (!isMobileView() || event.target.closest('button, a')) return;
    $('libraryBookcasesHeading').classList.toggle('is-collapsed');
    $('libraryBookcases').classList.toggle('is-collapsed');
  });
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
    if (preview) {
      if (preview.dataset.libraryItem) {
        const id = preview.dataset.libraryPreview;
        window.previewFile?.(id, preview.dataset.name, preview.dataset.mime, Number(preview.dataset.size), { preview: '/preview/library/' + encodeURIComponent(id), download: '/download/library/' + encodeURIComponent(id) });
      } else {
        window.previewFile?.(preview.dataset.libraryPreview, preview.dataset.name, preview.dataset.mime, Number(preview.dataset.size));
      }
      return;
    }
    const edit = event.target.closest('[data-library-edit]');
    if (edit) { openEditor(edit.dataset.libraryEdit, ''); return; }
    const delItem = event.target.closest('[data-library-delete-item]');
    if (delItem) {
      const target = items.find(entry => entry.id === delItem.dataset.libraryDeleteItem);
      if (!target) return;
      if (!window.confirm('Apagar "' + (target.original_name || 'esta cópia') + '" do seu Acervo? Ela sai só daqui; nada muda nas salas.')) return;
      delItem.disabled = true;
      try {
        await api('/api/library/' + encodeURIComponent(target.id), { method: 'DELETE' });
        signature = '';
        await loadLibrary(true);
        window.toast?.('Cópia apagada do seu Acervo.');
      } catch (error) { window.toast?.(error.message, 'error'); delItem.disabled = false; }
      return;
    }
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
    const edit = event.target.closest('[data-library-edit-space]');
    if (edit) { openSpaceModal('edit-space', edit.dataset.libraryEditSpace); return; }
    const remove = event.target.closest('[data-library-delete-space]');
    if (remove) { deleteSpace(remove.dataset.libraryDeleteSpace); return; }
    const tile = event.target.closest('[data-library-space]');
    if (!tile) return;
    $('libraryShelfFilter').value = tile.dataset.librarySpace ? `space:${tile.dataset.librarySpace}` : '';
    render();
  });

  $('libraryBookcases').addEventListener('click', event => {
    const edit = event.target.closest('[data-library-edit-bookcase]');
    if (edit) { openSpaceModal('edit-bookcase', edit.dataset.librarySpaceId, edit.dataset.libraryEditBookcase); return; }
    const remove = event.target.closest('[data-library-delete-bookcase]');
    if (remove) { deleteBookcase(remove.dataset.librarySpaceId, remove.dataset.libraryDeleteBookcase); return; }
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
      let saved;
      const isBookcase = modalMode === 'bookcase' || modalMode === 'edit-bookcase';
      const isEdit = modalMode === 'edit-space' || modalMode === 'edit-bookcase';
      const json = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) };
      if (isBookcase && isEdit) {
        saved = await api('/api/library/spaces/' + encodeURIComponent(modalSpaceId) + '/shelves/' + encodeURIComponent(modalBookcaseId), { ...json, method: 'PATCH' });
        spaces = spaces.map(space => space.id === modalSpaceId ? { ...space, shelves: space.shelves.map(shelf => shelf.id === saved.id ? saved : shelf) } : space);
      } else if (isBookcase) {
        saved = await api('/api/library/spaces/' + encodeURIComponent(modalSpaceId) + '/shelves', { ...json, method: 'POST' });
        spaces = spaces.map(space => space.id === modalSpaceId ? { ...space, shelves: [...space.shelves, saved] } : space);
        $('libraryShelfFilter').value = 'bookcase:' + saved.id;
        if ($('libraryEditorModal').getAttribute('aria-hidden') === 'false') {
          $('libraryEditorSpace').value = modalSpaceId;
          renderEditorBookcases(saved.id);
        }
      } else if (isEdit) {
        saved = await api('/api/library/spaces/' + encodeURIComponent(modalSpaceId), { ...json, method: 'PATCH' });
        spaces = spaces.map(space => space.id === saved.id ? { ...space, ...saved } : space);
      } else {
        saved = await api('/api/library/spaces', { ...json, method: 'POST' });
        spaces = [...spaces.filter(space => space.id !== saved.id), { ...saved, shelves: saved.shelves || [] }];
        $('libraryShelfFilter').value = 'space:' + saved.id;
        if ($('libraryEditorModal').getAttribute('aria-hidden') === 'false') {
          renderEditorLocations();
          $('libraryEditorSpace').value = saved.id;
          renderEditorBookcases(saved.shelves?.[0]?.id || '');
          renderEditorPicker('space');
        }
      }
      signature = '';
      render();
      await loadLibrary(true);
      const continueEditor = !isEdit && !isBookcase ? pendingLibraryEditor : null;
      pendingLibraryEditor = null;
      const modal = $('librarySpaceModal');
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
      window.toast?.(isEdit
        ? (isBookcase ? 'Prateleira renomeada.' : 'Espaço renomeado.')
        : (isBookcase ? 'Prateleira criada.' : 'Espaço criado.'));
      if (continueEditor) {
        if (continueEditor.pendingFileId) {
          const pending = continueEditor.pendingFileId;
          pendingLibraryEditor = null;
          window.saveRoomFileToLibrary?.(pending);
        } else {
          openEditor(continueEditor.itemId, continueEditor.fileName);
        }
      }
    } catch (error) { window.toast?.(error.message, 'error'); }
    finally { button.disabled = false; }
  });

  $('libraryEditorModal').addEventListener('click', event => {
    const choice = event.target.closest('[data-library-editor-choice]');
    if (choice) {
      const isSpace = choice.dataset.libraryEditorChoice === 'space';
      const select = $(isSpace ? 'libraryEditorSpace' : 'libraryEditorShelf');
      select.value = choice.dataset.value;
      ['Space', 'Shelf'].forEach(name => {
        $('libraryEditor' + name + 'Menu').hidden = true;
        $('libraryEditor' + name + 'Button').setAttribute('aria-expanded', 'false');
      });
      if (isSpace) {
        renderEditorBookcases();
        renderEditorPicker('space');
      }
      else renderEditorPicker('shelf');
      return;
    }
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
    if (!itemId) { closeEditor(); return; }
    if (!$('libraryEditorSpace').value || !$('libraryEditorShelf').value) {
      window.toast?.('Escolha ou crie uma prateleira para guardar este arquivo.', 'error');
      return;
    }
    button.disabled = true;
    try {
      const common = { space_id: $('libraryEditorSpace').value, bookcase_id: $('libraryEditorShelf').value, note: $('libraryEditorNote').value, is_favorite: $('libraryEditorFavorite').checked };
      await api('/api/library/' + encodeURIComponent(itemId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(common)
      });
      closeEditor();
      signature = '';
      await loadLibrary(true);
      window.loadRooms?.();
      window.toast?.('Seu Acervo foi atualizado.');
    } catch (error) { window.toast?.(error.message, 'error'); }
    finally { button.disabled = false; }
  });

  $('removeLibraryItem').addEventListener('click', async () => {
    const itemId = $('libraryItemId').value;
    if (!itemId || !window.confirm('Apagar esta cópia do seu Acervo? Ela sai só daqui; nada muda nas salas.')) return;
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
