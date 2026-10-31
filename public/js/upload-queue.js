// Fila visual de uploads: estado por arquivo, progresso e nova tentativa.
(function () {
  'use strict';

  const tasks = new Map();
  const IDLE_MINIMIZE_MS = 5000;
  let nextId = 1;
  let launcher, panel, list, count;
  let idleTimer = null;
  let panelDrag = null;
  let customPosition = false;
  let panelPositionCustom = false;
  let launcherPositionBeforeMinimize = null;

  const sizeLabel = bytes => {
    let size = Number(bytes) || 0;
    if (size < 1024) return size + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let unit = -1;
    do { size /= 1024; unit++; } while (size >= 1024 && unit < units.length - 1);
    return size.toLocaleString('pt-BR', { maximumFractionDigits: size < 10 ? 1 : 0 }) + ' ' + units[unit];
  };

  function ensureUI() {
    if (panel || !document.body) return;
    launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'fs-upload-launcher';
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-controls', 'fsUploadQueuePanel');
    launcher.innerHTML = '<i class="fas fa-cloud-arrow-up" aria-hidden="true"></i><span>Envios</span><span class="fs-upload-count" aria-live="polite">0</span>';
    count = launcher.querySelector('.fs-upload-count');

    panel = document.createElement('section');
    panel.id = 'fsUploadQueuePanel';
    panel.className = 'fs-upload-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Fila de envios');
    panel.innerHTML = '<header class="fs-upload-panel-head"><div><strong><i class="fas fa-cloud-arrow-up" aria-hidden="true"></i> Fila de envios</strong><small class="fs-upload-summary"></small></div><div class="fs-upload-panel-actions"><button type="button" class="fs-upload-clear" aria-label="Limpar falhas e cancelados" hidden>Limpar falhas</button><button type="button" class="fs-upload-close" aria-label="Fechar fila">&times;</button></div></header><div class="fs-upload-list" role="list"></div>';
    list = panel.querySelector('.fs-upload-list');
    launcher.addEventListener('click', event => {
      if (launcher.dataset.dragged === 'true') { launcher.dataset.dragged = 'false'; return; }
      if (event.target.closest('.fs-upload-count') && !panel.hidden) return;
      setOpen(panel.hidden);
    });
    enableDragging(launcher, false);
    enableDragging(panel.querySelector('.fs-upload-panel-head'), true);
    panel.querySelector('.fs-upload-clear').addEventListener('click', clearFailedAndCancelled);
    panel.querySelector('.fs-upload-close').addEventListener('click', () => setOpen(false, true));
    panel.addEventListener('click', event => {
      const cancelButton = event.target.closest('[data-upload-cancel]');
      if (cancelButton) { cancelUpload(cancelButton.dataset.uploadCancel); return; }
      const clearButton = event.target.closest('[data-upload-clear]');
      if (clearButton) { clearTask(clearButton.dataset.uploadClear); return; }
      const button = event.target.closest('[data-upload-retry]');
      if (button) retry(button.dataset.uploadRetry);
    });
    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focusin'].forEach(type => {
      panel.addEventListener(type, noteActivity, { passive: type === 'wheel' });
    });
    document.body.append(launcher, panel);
    window.addEventListener('resize', () => {
      if (customPosition) clampCustomPositions();
      else positionQueue();
    });
    positionQueue();
    render();
  }

  function positionQueue() {
    if (!launcher || !panel) return;
    if (customPosition) return;
    const sheet = document.getElementById('directMessagesSheet');
    const composer = sheet && sheet.style.display !== 'none' && sheet.querySelector('#directMessageForm');
    if (!composer || typeof composer.getBoundingClientRect !== 'function') {
      launcher.style.bottom = '';
      launcher.style.right = '';
      panel.style.bottom = '';
      panel.style.right = '';
      return;
    }
    const rect = composer.getBoundingClientRect();
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    const right = Math.max(12, window.innerWidth - rect.right + 14);
    launcher.style.bottom = `${bottom}px`;
    launcher.style.right = `${right}px`;
    panel.style.bottom = `${bottom + 56}px`;
    panel.style.right = `${right}px`;
  }

  function clampCustomPositions() {
    [launcher, panel].forEach(element => {
      if (!element || !element.style.left || !element.style.top) return;
      const maxLeft = Math.max(8, window.innerWidth - element.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - element.offsetHeight - 8);
      element.style.left = `${Math.max(8, Math.min(maxLeft, parseFloat(element.style.left) || 0))}px`;
      element.style.top = `${Math.max(8, Math.min(maxTop, parseFloat(element.style.top) || 0))}px`;
    });
  }

  function positionPanelByLauncher() {
    if (!customPosition || panelPositionCustom || !launcher || !panel || panel.hidden) return;
    const launcherRect = launcher.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - panelWidth - 8, launcherRect.right - panelWidth));
    const above = launcherRect.top - panelHeight - 8;
    const top = above >= 8 ? above : Math.min(window.innerHeight - panelHeight - 8, launcherRect.bottom + 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(8, top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  window.addEventListener('fileshare:direct-chat-open', positionQueue);
  window.addEventListener('fileshare:direct-chat-close', positionQueue);

  function setOpen(open) {
    const sideRail = arguments.length > 1 && arguments[1] === true;
    ensureUI();
    if (!panel) return;
    clearTimeout(idleTimer);
    idleTimer = null;
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    launcher.classList.toggle('is-side-rail', !open && sideRail);
    if (open && launcherPositionBeforeMinimize) {
      Object.assign(launcher.style, launcherPositionBeforeMinimize);
      launcherPositionBeforeMinimize = null;
    } else if (!open && sideRail && customPosition) {
      launcherPositionBeforeMinimize = {
        left: launcher.style.left,
        top: launcher.style.top,
        right: launcher.style.right,
        bottom: launcher.style.bottom
      };
      launcher.style.left = 'auto';
      launcher.style.top = '44%';
      launcher.style.right = '0px';
      launcher.style.bottom = 'auto';
    }
    positionQueue();
    if (open) {
      positionPanelByLauncher();
      noteActivity();
    }
  }

  function noteActivity() {
    if (!panel || panel.hidden) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => setOpen(false, true), IDLE_MINIMIZE_MS);
  }

  function enableDragging(handle, movePanel) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest('button')) return;
      const target = movePanel ? panel : launcher;
      const rect = target.getBoundingClientRect();
      panelDrag = {
        pointerId: event.pointerId,
        target,
        handle,
        movePanel,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false
      };
      handle.setPointerCapture(event.pointerId);
      if (!movePanel && launcher.classList.contains('is-side-rail')) {
        launcher.classList.remove('is-side-rail');
        launcherPositionBeforeMinimize = null;
        launcher.style.left = `${rect.left}px`;
        launcher.style.top = `${rect.top}px`;
        launcher.style.right = 'auto';
        launcher.style.bottom = 'auto';
      }
      if (movePanel) noteActivity();
    });
    handle.addEventListener('pointermove', event => {
      if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
      const dx = event.clientX - panelDrag.startX;
      const dy = event.clientY - panelDrag.startY;
      if (!panelDrag.moved && Math.hypot(dx, dy) < 6) return;
      panelDrag.moved = true;
      const target = panelDrag.target;
      const maxLeft = Math.max(8, window.innerWidth - target.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - target.offsetHeight - 8);
      target.style.left = `${Math.max(8, Math.min(maxLeft, panelDrag.left + dx))}px`;
      target.style.top = `${Math.max(8, Math.min(maxTop, panelDrag.top + dy))}px`;
      target.style.right = 'auto';
      target.style.bottom = 'auto';
      customPosition = true;
      if (panelDrag.movePanel) panelPositionCustom = true;
      if (!panelDrag.movePanel) launcher.dataset.dragged = 'true';
      panel.classList.toggle('is-dragging', panelDrag.movePanel);
      noteActivity();
      event.preventDefault();
    });
    const finishDrag = event => {
      if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
      const dragged = panelDrag.moved && !panelDrag.movePanel;
      const movedPanel = panelDrag.movePanel;
      panelDrag = null;
      if (movedPanel && panel) panel.classList.remove('is-dragging');
      if (dragged) setTimeout(() => { if (launcher) launcher.dataset.dragged = 'false'; }, 0);
      if (!panel.hidden) noteActivity();
    };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
  }

  function render() {
    if (!panel) return;
    positionQueue();
    const entries = [...tasks.values()];
    const active = entries.filter(task => task.state === 'uploading' || task.state === 'queued').length;
    const failed = entries.filter(task => task.state === 'failed').length;
    const summary = panel.querySelector('.fs-upload-summary');
    const cancelled = entries.filter(task => task.state === 'cancelled').length;
    summary.textContent = `${active} em andamento · ${failed} com falha` + (cancelled ? ` · ${cancelled} cancelados` : '') + (!failed && !cancelled ? ` · ${entries.filter(task => task.state === 'done').length} concluídos` : '');
    count.textContent = String(active + failed);
    launcher.classList.toggle('has-failure', failed > 0);
    panel.querySelector('.fs-upload-clear').hidden = !entries.some(task => ['failed', 'cancelled'].includes(task.state));
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'fs-upload-empty';
      empty.textContent = 'Seus próximos envios aparecerão aqui.';
      list.append(empty);
      return;
    }
    entries.slice(-30).reverse().forEach(task => {
      const row = document.createElement('article');
      row.className = `fs-upload-item is-${task.state}`;
      row.setAttribute('role', 'listitem');
      const icon = document.createElement('span');
      icon.className = 'fs-upload-file-icon';
      icon.innerHTML = task.state === 'done' ? '<i class="fas fa-circle-check" aria-hidden="true"></i>' : task.state === 'failed' ? '<i class="fas fa-triangle-exclamation" aria-hidden="true"></i>' : task.state === 'cancelled' ? '<i class="fas fa-ban" aria-hidden="true"></i>' : task.state === 'queued' ? '<i class="fas fa-clock" aria-hidden="true"></i>' : '<i class="fas fa-file" aria-hidden="true"></i>';
      const body = document.createElement('div');
      body.className = 'fs-upload-item-body';
      const name = document.createElement('strong');
      name.className = 'fs-upload-file-name';
      name.textContent = task.file.name;
      const meta = document.createElement('small');
      meta.textContent = `${task.destination} · ${sizeLabel(task.file.size)} · ${task.label}`;
      body.append(name, meta);
      if (task.error) {
        const error = document.createElement('small');
        error.className = 'fs-upload-error';
        error.textContent = task.error;
        body.append(error);
      }
      if (task.state === 'uploading' || task.state === 'queued') {
        const progress = document.createElement('progress');
        progress.max = 100;
        progress.value = task.state === 'queued' ? 0 : task.progress;
        if (task.state === 'queued') progress.removeAttribute('value');
        progress.setAttribute('aria-label', `Progresso de ${task.file.name}`);
        body.append(progress);
        const percent = document.createElement('small');
        percent.className = 'fs-upload-percent';
        percent.textContent = task.state === 'queued' ? 'Aguardando conexão para retomar' : `${task.progress}%`;
        body.append(percent);
      }
      row.append(icon, body);
      if (task.state === 'uploading' && task.controller && task.cancelable && task.phase !== 'finalizing') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fs-upload-cancel';
        button.dataset.uploadCancel = task.id;
        button.setAttribute('aria-label', `Cancelar envio de ${task.file.name}`);
        button.innerHTML = '<i class="fas fa-xmark" aria-hidden="true"></i> Cancelar';
        row.append(button);
      } else if (task.state === 'failed' || task.state === 'cancelled') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fs-upload-clear-item';
        button.dataset.uploadClear = task.id;
        button.setAttribute('aria-label', `Limpar envio de ${task.file.name}`);
        button.innerHTML = '<i class="fas fa-trash-can" aria-hidden="true"></i> Limpar';
        row.append(button);
      }
      if (task.state === 'failed' && task.backgroundId != null && task.backgroundRetry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fs-upload-retry';
        button.dataset.uploadRetry = task.id;
        button.innerHTML = '<i class="fas fa-rotate-right" aria-hidden="true"></i> Tentar novamente';
        row.append(button);
      } else if (task.state === 'failed' && task.retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'fs-upload-retry';
        button.dataset.uploadRetry = task.id;
        button.innerHTML = '<i class="fas fa-rotate-right" aria-hidden="true"></i> Tentar novamente';
        row.append(button);
      }
      list.append(row);
    });
  }

  function add(file, destination, taskId) {
    ensureUI();
    const id = taskId == null ? String(nextId++) : String(taskId);
    if (taskId != null) nextId++;
    tasks.set(id, { id, file, destination: destination || 'Site', state: 'queued', progress: 0, label: 'Na fila', error: '', retry: null, operation: null, onSuccess: null, controller: null, cancelable: false, phase: 'queued' });
    setOpen(true);
    render();
    return id;
  }

  function update(id, patch) {
    const task = tasks.get(String(id));
    if (!task) return;
    Object.assign(task, patch || {});
    render();
  }

  async function execute(task, operation) {
    task.operation = operation || task.operation;
    task.retry = null;
    task.controller = new AbortController();
    const controller = task.controller;
    task.canCancel = false;
    task.cancelable = false;
    task.phase = 'uploading';
    task.state = 'uploading';
    task.progress = 0;
    task.error = '';
    task.label = 'Enviando';
    render();
    try {
      const value = task.completedValue || await task.operation(percent => {
        task.progress = Math.max(0, Math.min(100, Number(percent) || 0));
        task.label = 'Enviando';
        render();
      }, controller.signal, phase => {
        task.phase = phase;
        task.cancelable = task.cancelAllowed && phase === 'uploading' && task.canCancel;
        render();
      }, canCancel => {
        task.canCancel = task.cancelAllowed && canCancel === true;
        task.cancelable = task.canCancel && task.phase === 'uploading';
        render();
      });
      if (controller.signal.aborted || task.state === 'cancelled') return { ok: false, cancelled: true };
      if (value && value.backgroundPending) {
        task.state = 'queued';
        task.label = 'Aguardando conexão';
        task.progress = 0;
        task.backgroundId = value.backgroundId;
        task.backgroundRetry = value.backgroundRetry || null;
      } else {
        task.completedValue = value;
        task.phase = 'finalizing';
        render();
        if (task.onSuccess) await task.onSuccess(value, controller.signal);
        if (controller.signal.aborted || task.state === 'cancelled') return { ok: false, cancelled: true };
        task.state = 'done';
        task.label = 'Concluído';
        task.progress = 100;
        task.error = '';
        task.completedValue = null;
      }
      render();
      window.dispatchEvent(new CustomEvent('fileshare:upload-queue-change', { detail: { id: task.id, state: task.state, destination: task.destination } }));
      return { ok: true, value };
    } catch (error) {
      if (controller.signal.aborted || task.state === 'cancelled') {
        task.state = 'cancelled';
        task.label = 'Envio cancelado';
        task.error = '';
        render();
        return { ok: false, cancelled: true, error };
      }
      task.state = 'failed';
      task.label = 'Falha no envio';
      task.error = String(error && error.message || error || 'Não foi possível enviar este arquivo.');
      task.retry = () => execute(task);
      render();
      return { ok: false, error };
    } finally {
      if (task.controller === controller) task.controller = null;
      if (task.state !== 'cancelled') task.phase = task.state;
      render();
    }
  }

  function cancelUpload(id) {
    const task = tasks.get(String(id));
    if (!task || task.state !== 'uploading' || !task.controller || !task.cancelable || task.phase === 'finalizing') return;
    task.state = 'cancelled';
    task.label = 'Envio cancelado';
    task.error = '';
    task.retry = null;
    task.controller.abort();
    render();
  }

  async function retry(id) {
    const task = tasks.get(String(id));
    if (task && task.state === 'failed' && task.backgroundRetry) {
      await task.backgroundRetry();
      return;
    }
    if (!task || task.state !== 'failed' || !task.retry) return;
    await task.retry();
  }

  function clearFailedAndCancelled() {
    for (const [id, task] of tasks) if (['failed', 'cancelled'].includes(task.state)) tasks.delete(id);
    render();
  }

  function clearTask(id) {
    const task = tasks.get(String(id));
    if (!task || !['failed', 'cancelled'].includes(task.state)) return;
    tasks.delete(task.id);
    render();
  }

  window.FileShareUploadQueue = {
    add,
    update,
    run(file, destination, operation, options) {
      options = options || {};
      const id = options.id != null ? String(options.id) : null;
      const taskId = id || add(file, destination);
      if (id && !tasks.has(taskId)) add(file, destination, taskId);
      const task = tasks.get(taskId);
      if (typeof options.onSuccess === 'function') task.onSuccess = options.onSuccess;
      task.cancelAllowed = options.cancelable === true;
      task.canCancel = false;
      task.cancelable = false;
      return execute(task, operation).then(result => ({ ...result, id: taskId }));
    },
    completeBackground(id) {
      if (id == null) return;
      for (const task of tasks.values()) {
        if (task.backgroundId != null && String(task.backgroundId) === String(id)) {
          task.state = 'done'; task.progress = 100; task.label = 'Concluído'; task.error = ''; task.backgroundRetry = null; render();
        }
      }
    },
    retryBackground(id, requestRetry) {
      const task = [...tasks.values()].find(entry => entry.backgroundId != null && String(entry.backgroundId) === String(id));
      if (!task) return;
      task.state = 'failed';
      task.label = 'Precisa de atenção';
      task.error = 'O envio em segundo plano falhou. Tente novamente agora.';
      task.backgroundRetry = async () => {
        task.state = 'uploading'; task.label = 'Solicitando nova tentativa'; task.error = ''; render();
        try { await requestRetry(); }
        catch (error) { task.state = 'failed'; task.label = 'Precisa de atenção'; task.error = String(error && error.message || error); render(); return; }
        task.state = 'failed';
        task.label = 'Precisa de atenção';
        task.error = 'A nova tentativa foi solicitada. Se ela falhar, tente novamente quando a conexão estabilizar.';
        render();
      };
      render();
    },
    failBackground(id, requestRetry) { this.retryBackground(id, requestRetry); }
  };
  window.addEventListener('fileshare:direct-chat-open', positionQueue);
  window.addEventListener('fileshare:direct-chat-close', positionQueue);
})();