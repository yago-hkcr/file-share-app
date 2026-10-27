// Fila visual de uploads: estado por arquivo, progresso e nova tentativa.
(function () {
  'use strict';

  const tasks = new Map();
  let nextId = 1;
  let launcher, panel, list, count;

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
    panel.innerHTML = '<header class="fs-upload-panel-head"><div><strong><i class="fas fa-cloud-arrow-up" aria-hidden="true"></i> Fila de envios</strong><small class="fs-upload-summary"></small></div><div class="fs-upload-panel-actions"><button type="button" class="fs-upload-clear" hidden>Limpar concluídos</button><button type="button" class="fs-upload-close" aria-label="Fechar fila">&times;</button></div></header><div class="fs-upload-list" role="list"></div>';
    list = panel.querySelector('.fs-upload-list');
    launcher.addEventListener('click', () => setOpen(panel.hidden));
    panel.querySelector('.fs-upload-close').addEventListener('click', () => setOpen(false));
    panel.querySelector('.fs-upload-clear').addEventListener('click', clearCompleted);
    panel.addEventListener('click', event => {
      const button = event.target.closest('[data-upload-retry]');
      if (button) retry(button.dataset.uploadRetry);
    });
    document.body.append(launcher, panel);
    render();
  }

  function setOpen(open) {
    ensureUI();
    if (!panel) return;
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
  }

  function render() {
    if (!panel) return;
    const entries = [...tasks.values()];
    const active = entries.filter(task => task.state === 'uploading' || task.state === 'queued').length;
    const failed = entries.filter(task => task.state === 'failed').length;
    const summary = panel.querySelector('.fs-upload-summary');
    summary.textContent = failed ? `${active} em andamento · ${failed} com falha` : `${active} em andamento · ${entries.filter(task => task.state === 'done').length} concluídos`;
    count.textContent = String(active + failed);
    launcher.classList.toggle('has-failure', failed > 0);
    panel.querySelector('.fs-upload-clear').hidden = !entries.some(task => task.state === 'done');
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
      icon.innerHTML = task.state === 'done' ? '<i class="fas fa-circle-check" aria-hidden="true"></i>' : task.state === 'failed' ? '<i class="fas fa-triangle-exclamation" aria-hidden="true"></i>' : task.state === 'queued' ? '<i class="fas fa-clock" aria-hidden="true"></i>' : '<i class="fas fa-file" aria-hidden="true"></i>';
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
    tasks.set(id, { id, file, destination: destination || 'Site', state: 'queued', progress: 0, label: 'Na fila', error: '', retry: null, operation: null, onSuccess: null });
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
      });
      if (value && value.backgroundPending) {
        task.state = 'queued';
        task.label = 'Aguardando conexão';
        task.progress = 0;
        task.backgroundId = value.backgroundId;
        task.backgroundRetry = value.backgroundRetry || null;
      } else {
        task.completedValue = value;
        task.state = 'done';
        task.label = 'Concluído';
        task.progress = 100;
        task.error = '';
        if (task.onSuccess) await task.onSuccess(value);
        task.completedValue = null;
      }
      render();
      window.dispatchEvent(new CustomEvent('fileshare:upload-queue-change', { detail: { id: task.id, state: task.state, destination: task.destination } }));
      return { ok: true, value };
    } catch (error) {
      task.state = 'failed';
      task.label = 'Falha no envio';
      task.error = String(error && error.message || error || 'Não foi possível enviar este arquivo.');
      task.retry = () => execute(task);
      render();
      return { ok: false, error };
    }
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

  function clearCompleted() {
    for (const [id, task] of tasks) if (task.state === 'done') tasks.delete(id);
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
})();