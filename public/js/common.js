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
  window.uploaderTag = function (name) {
    if (!name) return '';
    return '<span class="uploader-tag" title="Enviado por ' + esc(name) + '"><span class="uploader-dot">' +
      esc(name[0].toUpperCase()) + '</span>' + esc(name) + '</span>';
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addThemeButton);
  else addThemeButton();
})();
