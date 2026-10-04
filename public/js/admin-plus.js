// Painel ADM avançado: visão geral, usuários completos, arquivos, monitor de chat, atividade, comunicados e sistema.
(function () {
  const $ = id => document.getElementById(id);
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const size = b => { if (!b) return '0 B'; const k = 1024, u = ['B', 'KB', 'MB', 'GB']; const i = Math.min(3, Math.floor(Math.log(b) / Math.log(k))); return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + u[i]; };
  const dt = s => s ? new Date(s.replace(' ', 'T') + 'Z') : null;
  const when = s => { const d = dt(s); return d ? d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'; };
  const ago = s => { const d = dt(s); if (!d) return 'nunca'; const t = Math.max(0, (Date.now() - d) / 1000); if (t < 60) return 'agora'; if (t < 3600) return Math.round(t / 60) + ' min atrás'; if (t < 86400) return Math.floor(t / 3600) + ' h atrás'; return Math.floor(t / 86400) + ' d atrás'; };
  const toast = (m, t) => window.showToast && window.showToast(m, t || 'success');
  async function api(url, opt) {
    const r = await fetch(url, opt);
    if (r.status === 401) { location.href = '/'; throw new Error('401'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erro');
    return j;
  }
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const ACTIONS = {
    login: ['Login', 'sign-in-alt', '#16a34a'], logout: ['Saiu', 'sign-out-alt', '#6b7280'], login_falhou: ['Login falhou', 'shield-halved', '#dc2626'], login_bloqueado: ['Login bloqueado', 'ban', '#dc2626'], cadastro: ['Cadastro', 'user-plus', '#2563eb'],
    upload: ['Upload', 'cloud-arrow-up', '#8b5cf6'], arquivo_excluido: ['Arquivo excluído', 'trash', '#dc2626'], arquivo_renomeado: ['Arquivo renomeado', 'pen', '#d97706'], arquivos_excluidos_em_massa: ['Exclusão em massa', 'dumpster-fire', '#dc2626'],
    sala_criada: ['Sala criada', 'door-open', '#16a34a'], sala_excluida: ['Sala excluída', 'door-closed', '#dc2626'], entrou_sala: ['Entrou na sala', 'right-to-bracket', '#2563eb'], saiu_sala: ['Saiu da sala', 'right-from-bracket', '#6b7280'],
    sala_tempo_alterado: ['Tempo da sala', 'hourglass-half', '#d97706'], sala_permanente: ['Sala permanente', 'infinity', '#16a34a'], sala_visibilidade: ['Visibilidade', 'eye', '#2563eb'], chat_limpo: ['Chat limpo', 'broom', '#d97706'], mensagem_removida: ['Mensagem removida', 'comment-slash', '#dc2626'],
    usuario_aprovado: ['Aprovado', 'check', '#16a34a'], usuario_rejeitado: ['Rejeitado', 'xmark', '#dc2626'], usuario_excluido: ['Usuário excluído', 'user-xmark', '#dc2626'], usuario_suspenso: ['Suspenso', 'user-lock', '#dc2626'], usuario_reativado: ['Reativado', 'user-check', '#16a34a'],
    promovido_adm: ['Promovido a ADM', 'crown', '#f59e0b'], rebaixado_usuario: ['Rebaixado', 'arrow-down', '#d97706'], logout_forcado: ['Logout forçado', 'power-off', '#d97706'], senha_redefinida: ['Senha redefinida', 'key', '#d97706'], senha_alterada: ['Senha alterada', 'key', '#6b7280'],
    comunicado_enviado: ['Comunicado', 'bullhorn', '#2563eb'], configuracoes_alteradas: ['Configurações', 'gear', '#8b5cf6'], backup_exportado: ['Backup', 'download', '#16a34a']
  };
  const actBadge = a => { const x = ACTIONS[a] || [a, 'circle', '#6b7280']; return '<span class="ap-act" style="--c:' + x[2] + '"><i class="fas fa-' + x[1] + '"></i> ' + E(x[0]) + '</span>'; };
  const admTag = r => r === 'admin' ? ' <span class="adm-badge">ADM</span>' : '';

  // ---------- estilos ----------
  const st = document.createElement('style');
  st.textContent = `
  .ap-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:20px}
  .ap-card{padding:16px;border:1px solid var(--line,rgba(128,128,128,.25));border-radius:14px;background:var(--card,rgba(255,255,255,.04));min-width:0}
  .ap-card h4{margin:0 0 12px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85}
  .ap-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(128,128,128,.14);font-size:13px;min-width:0}
  .ap-row:last-child{border-bottom:0}.ap-row>.grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ap-bars{display:flex;align-items:flex-end;gap:8px;height:120px}
  .ap-bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;height:100%;font-size:11px}
  .ap-bar i{display:block;width:100%;min-height:3px;border-radius:6px 6px 2px 2px;background:linear-gradient(180deg,#22c55e,#8b5cf6);transition:height .4s}
  .ap-dot{width:9px;height:9px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;flex:none;animation:apPulse 1.6s infinite}.ap-dot.off{background:#9ca3af;box-shadow:none;animation:none}
  @keyframes apPulse{50%{opacity:.4}}
  .ap-act{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:700;color:var(--c);border:1px solid var(--c);background:rgba(128,128,128,.08);white-space:nowrap}
  .ap-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  .ap-tools input,.ap-tools select,.ap-form input,.ap-form select,.ap-form textarea{padding:10px 12px;border-radius:10px;border:1px solid var(--line,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;min-width:0}
  .ap-tools input[type=search]{flex:1;min-width:180px}
  .ap-chip{padding:7px 12px;border-radius:99px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer;font-size:12.5px;font-weight:600}
  .ap-chip.on{background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;border-color:#15803d}
  .ap-btns{display:flex;flex-wrap:wrap;gap:6px}
  .ap-ib{width:36px;height:36px;display:inline-grid;place-items:center;border-radius:10px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer}
  .ap-ib:hover{background:rgba(139,92,246,.18)}.ap-ib.danger{color:#dc2626;border-color:rgba(220,38,38,.5)}.ap-ib.ok{color:#16a34a;border-color:rgba(22,163,74,.5)}
  .ap-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;opacity:.78;margin-top:3px}
  .ap-form{display:flex;flex-direction:column;gap:10px}.ap-form label{font-size:12px;font-weight:700;opacity:.8}
  .ap-chat{max-height:55vh;overflow:auto;display:flex;flex-direction:column;gap:6px}
  .ap-msg{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:rgba(128,128,128,.08)}.ap-msg .grow{flex:1;min-width:0;overflow-wrap:anywhere}
  .ap-pw{font:700 22px 'Share Tech Mono',monospace;letter-spacing:.12em;padding:14px;text-align:center;border-radius:12px;background:rgba(34,197,94,.14);border:1px dashed #22c55e;user-select:all}
  .ap-sel{width:18px;height:18px;accent-color:#22c55e;flex:none}
  .ap-table-wrap{overflow-x:auto}
  @media(max-width:600px){.ap-grid{grid-template-columns:1fr}.ap-ib{width:42px;height:42px}}`;
  document.head.appendChild(st);

  // ---------- abas novas ----------
  const nav = document.querySelector('.sidebar');
  const main = document.querySelector('.main-content');
  const NEW = [['files', 'fa-folder-tree', 'Arquivos'], ['chat', 'fa-comments', 'Monitor de chat'], ['log', 'fa-clock-rotate-left', 'Atividade'], ['comms', 'fa-bullhorn', 'Comunicados'], ['system', 'fa-gear', 'Sistema']];
  NEW.forEach(([id, ic, label]) => {
    const b = document.createElement('button'); b.className = 'nav-item'; b.setAttribute('onclick', "showTab('" + id + "')"); b.innerHTML = '<i class="fas ' + ic + '"></i> ' + label; nav.appendChild(b);
    const d = document.createElement('div'); d.id = 'tab-' + id; d.className = 'tab-content'; main.appendChild(d);
  });
  $('tab-files').innerHTML = '<h2><i class="fas fa-folder-tree"></i> Central de Arquivos</h2><div class="ap-tools"><input type="search" id="afQ" placeholder="Buscar por arquivo, usuário ou sala..."><button class="btn btn-sm btn-outline" id="afAll">Selecionar tudo</button><button class="btn btn-sm btn-danger" id="afDel" disabled><i class="fas fa-trash"></i> Excluir selecionados (<span id="afN">0</span>)</button></div><div id="afList" class="card" style="padding:6px 14px"></div>';
  $('tab-chat').innerHTML = '<h2><i class="fas fa-comments"></i> Monitor de Chat</h2><div class="ap-tools"><select id="acRoom" style="flex:1;min-width:200px"></select><button class="btn btn-sm btn-outline" id="acClear"><i class="fas fa-broom"></i> Limpar chat</button></div><div id="acList" class="card ap-chat"></div>';
  $('tab-log').innerHTML = '<h2><i class="fas fa-clock-rotate-left"></i> Atividade e Segurança</h2><div class="ap-tools"><input type="search" id="alQ" placeholder="Buscar usuário, IP ou detalhe..."><select id="alA"><option value="">Todas as ações</option>' + Object.keys(ACTIONS).map(k => '<option value="' + k + '">' + ACTIONS[k][0] + '</option>').join('') + '</select><button class="btn btn-sm btn-outline" id="alCsv"><i class="fas fa-file-csv"></i> Exportar CSV</button></div><div id="alList" class="card" style="padding:6px 14px"></div>';
  $('tab-comms').innerHTML = '<h2><i class="fas fa-bullhorn"></i> Comunicados</h2><div class="ap-grid"><div class="ap-card"><h4>Notificar todos os usuários</h4><div class="ap-form"><input id="bcT" maxlength="80" placeholder="Título"><textarea id="bcM" rows="3" maxlength="500" placeholder="Mensagem"></textarea><select id="bcY"><option value="info">Informação</option><option value="success">Sucesso</option><option value="warning">Atenção</option><option value="error">Urgente</option></select><button class="btn btn-green" id="bcSend"><i class="fas fa-paper-plane"></i> Enviar para todos</button></div></div><div class="ap-card"><h4>Faixa de aviso no topo do site</h4><div class="ap-form"><textarea id="anT" rows="3" maxlength="300" placeholder="Ex.: Manutenção hoje às 22h. (vazio = sem aviso)"></textarea><select id="anY"><option value="info">Azul · info</option><option value="success">Verde · ok</option><option value="warning">Laranja · atenção</option><option value="error">Vermelho · urgente</option></select><button class="btn btn-green" id="anSave"><i class="fas fa-bullhorn"></i> Publicar aviso</button><button class="btn btn-outline" id="anClear">Remover aviso</button></div></div></div>';
  $('tab-system').innerHTML = '<h2><i class="fas fa-gear"></i> Sistema</h2><div class="ap-grid"><div class="ap-card"><h4>Novos cadastros</h4><div class="ap-form"><select id="syReg"><option value="approval">Exigir aprovação do ADM</option><option value="auto">Aprovar automaticamente</option><option value="closed">Fechar cadastros</option></select><button class="btn btn-green" id="sySave"><i class="fas fa-floppy-disk"></i> Salvar</button></div></div><div class="ap-card"><h4>Backup</h4><p class="text-muted" style="font-size:13px;margin-bottom:10px">Baixa usuários (sem senhas), salas, lista de arquivos e atividade em JSON.</p><a class="btn btn-green" href="/api/admin/export"><i class="fas fa-download"></i> Exportar dados</a></div></div>';

  // ---------- showTab ----------
  const LOAD = { stats: () => { window.loadStats && window.loadStats(); overview(); }, users: () => loadUsersPlus(true), rooms: () => window.loadRooms && window.loadRooms(), files: () => loadFiles(), chat: () => chatInit(), log: () => loadLog(), comms: loadComms, system: loadComms };
  window.showTab = function (name) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const t = $('tab-' + name); if (t) t.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => { if ((n.getAttribute('onclick') || '').indexOf("'" + name + "'") > -1) n.classList.add('active'); });
    if (LOAD[name]) LOAD[name]();
  };

  // ---------- visão geral ----------
  const ov = document.createElement('div'); ov.id = 'ovBox'; $('statsGrid').after(ov);
  async function overview() {
    let o; try { o = await api('/api/admin/overview'); } catch (e) { return; }
    const max = Math.max(1, ...o.days.map(d => d.n));
    const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); const f = o.days.find(x => x.d === d); days.push({ d, n: f ? f.n : 0 }); }
    const kpi = (ic, col, v, l) => '<div class="stat-card"><div class="stat-icon" style="background:' + col + '"><i class="fas ' + ic + '"></i></div><div><div class="stat-value">' + v + '</div><div class="stat-label">' + l + '</div></div></div>';
    ov.innerHTML =
      '<div class="stats-grid">' + kpi('fa-signal', '#22c55e', o.online, 'Online agora') + kpi('fa-cloud-arrow-up', '#8b5cf6', o.uploads24, 'Uploads (24h)') + kpi('fa-comments', '#2563eb', o.messages, 'Mensagens') + kpi('fa-hourglass-half', '#f59e0b', o.tempRooms, 'Salas temporárias') + kpi('fa-user-plus', '#06b6d4', o.newUsers, 'Novos (7 dias)') + kpi('fa-user-lock', '#dc2626', o.banned, 'Suspensos') + kpi('fa-shield-halved', o.fails24 > 5 ? '#dc2626' : '#6b7280', o.fails24, 'Logins falhos (24h)') + '</div>' +
      '<div class="ap-grid">' +
      '<div class="ap-card"><h4><i class="fas fa-chart-column"></i> Uploads · 7 dias</h4><div class="ap-bars">' + days.map(x => '<div class="ap-bar"><span>' + x.n + '</span><i style="height:' + Math.round(x.n / max * 90 + 3) + '%"></i><span>' + x.d.slice(8) + '/' + x.d.slice(5, 7) + '</span></div>').join('') + '</div></div>' +
      '<div class="ap-card"><h4><i class="fas fa-circle" style="color:#22c55e"></i> Online agora</h4>' + (o.onlineUsers.length ? o.onlineUsers.map(u => '<div class="ap-row"><span class="ap-dot"></span><span class="grow">' + E(u.username) + admTag(u.role) + '</span><span class="text-muted">' + ago(u.last_seen) + '</span></div>').join('') : '<p class="text-muted">Ninguém online.</p>') + '</div>' +
      '<div class="ap-card"><h4><i class="fas fa-trophy"></i> Quem mais envia</h4>' + (o.top.length ? o.top.map(u => '<div class="ap-row"><span class="grow">' + E(u.username) + admTag(u.role) + '</span><b>' + size(u.bytes) + '</b><span class="text-muted">' + u.n + ' arq.</span></div>').join('') : '<p class="text-muted">Sem uploads.</p>') + '</div>' +
      '<div class="ap-card"><h4><i class="fas fa-weight-hanging"></i> Maiores arquivos</h4>' + (o.big.length ? o.big.map(f => '<div class="ap-row"><span class="grow" title="' + E(f.original_name) + '">' + E(f.original_name) + '</span><b>' + size(f.size) + '</b></div>').join('') : '<p class="text-muted">Sem arquivos.</p>') + '</div>' +
      '<div class="ap-card" style="grid-column:1/-1"><h4><i class="fas fa-bolt"></i> Atividade recente</h4>' + (o.recent.length ? o.recent.map(a => '<div class="ap-row">' + actBadge(a.action) + '<span class="grow">' + E(a.username || '—') + admTag(a.role) + ' <span class="text-muted">' + E(a.detail) + '</span></span><span class="text-muted">' + ago(a.created_at) + '</span></div>').join('') : '<p class="text-muted">Nada ainda.</p>') + '</div></div>';
  }

  // ---------- usuários ----------
  let U = [], uFilter = 'all', uQ = '', uSort = 'status', uSig = '';
  const uTools = document.createElement('div'); uTools.className = 'ap-tools';
  uTools.innerHTML = '<input type="search" id="auQ" placeholder="Buscar usuário ou e-mail..."><select id="auS"><option value="status">Ordem: status</option><option value="seen">Visto por último</option><option value="storage">Mais armazenamento</option><option value="new">Mais novos</option><option value="name">Nome A–Z</option></select><button class="btn btn-sm btn-outline" id="auCsv"><i class="fas fa-file-csv"></i> CSV</button><div id="auChips" style="display:flex;gap:6px;flex-wrap:wrap;width:100%"></div>';
  $('usersList').before(uTools);
  const CH = [['all', 'Todos'], ['pending', 'Pendentes'], ['approved', 'Aprovados'], ['online', 'Online'], ['banned', 'Suspensos'], ['admin', 'ADM']];
  function chips() { $('auChips').innerHTML = CH.map(([k, l]) => { const n = U.filter(u => match(u, k)).length; return '<button class="ap-chip' + (uFilter === k ? ' on' : '') + '" data-k="' + k + '">' + l + ' ' + n + '</button>'; }).join(''); }
  const match = (u, k) => k === 'all' || (k === 'online' ? u.online : k === 'admin' ? u.role === 'admin' : u.status === k);
  async function loadUsersPlus(force) {
    let list; try { list = await api('/api/admin/users-plus'); } catch (e) { return; }
    const sig = JSON.stringify(list.map(u => [u.id, u.status, u.role, u.online, u.files, u.bytes, u.last_seen && u.last_seen.slice(0, 16)]));
    if (!force && sig === uSig) return; uSig = sig; U = list; renderUsers();
  }
  function renderUsers() {
    chips();
    let l = U.filter(u => match(u, uFilter) && (!uQ || (u.username + ' ' + u.email).toLowerCase().includes(uQ)));
    const so = { seen: (a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''), storage: (a, b) => b.bytes - a.bytes, new: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''), name: (a, b) => a.username.localeCompare(b.username) }[uSort];
    if (so) l = l.slice().sort(so);
    const sm = { pending: ['Pendente', 'badge-yellow'], approved: ['Aprovado', 'badge-green'], rejected: ['Rejeitado', 'badge-red'], banned: ['Suspenso', 'badge-red'] };
    $('usersList').innerHTML = l.length ? l.map(u => {
      const s = sm[u.status] || sm.pending, me = false;
      return '<div class="card card-row" style="flex-wrap:wrap"><div class="avatar" style="background:' + E(u.avatar_color) + '">' + E(u.username[0].toUpperCase()) + '</div>' +
        '<div class="card-row-info"><strong>' + E(u.username) + '</strong>' + admTag(u.role) + ' <span class="ap-dot' + (u.online ? '' : ' off') + '" title="' + (u.online ? 'Online' : 'Offline') + '" style="display:inline-block"></span>' +
        '<div class="ap-meta"><span>' + E(u.email) + '</span><span><i class="fas fa-eye"></i> ' + (u.online ? 'online agora' : ago(u.last_seen)) + '</span><span><i class="fas fa-file"></i> ' + u.files + ' (' + size(u.bytes) + ')</span><span><i class="fas fa-door-open"></i> ' + u.rooms + '</span><span><i class="fas fa-comment"></i> ' + u.msgs + '</span><span><i class="fas fa-calendar"></i> ' + when(u.created_at) + '</span></div></div>' +
        '<span class="badge ' + s[1] + '">' + s[0] + '</span>' +
        '<div class="ap-btns">' +
        (u.status === 'pending' ? '<button class="ap-ib ok" title="Aprovar" data-a="approve" data-id="' + u.id + '"><i class="fas fa-check"></i></button><button class="ap-ib danger" title="Rejeitar" data-a="reject" data-id="' + u.id + '"><i class="fas fa-times"></i></button>' : '') +
        '<button class="ap-ib" title="Detalhes" data-a="detail" data-id="' + u.id + '"><i class="fas fa-id-card"></i></button>' +
        (u.role !== 'admin' && u.status === 'banned' ? '<button class="ap-ib ok" title="Reativar" data-a="unban" data-id="' + u.id + '"><i class="fas fa-user-check"></i></button>' : '') +
        (u.role !== 'admin' && u.status === 'approved' ? '<button class="ap-ib danger" title="Suspender" data-a="ban" data-id="' + u.id + '" data-n="' + E(u.username) + '"><i class="fas fa-user-lock"></i></button>' : '') +
        (u.status === 'approved' || u.role === 'admin' ? '<button class="ap-ib" title="' + (u.role === 'admin' ? 'Rebaixar a usuário' : 'Promover a ADM') + '" data-a="role" data-id="' + u.id + '" data-r="' + (u.role === 'admin' ? 'user' : 'admin') + '" data-n="' + E(u.username) + '"><i class="fas fa-crown" style="color:#f59e0b"></i></button>' : '') +
        '<button class="ap-ib" title="Redefinir senha" data-a="pw" data-id="' + u.id + '" data-n="' + E(u.username) + '"><i class="fas fa-key"></i></button>' +
        '<button class="ap-ib" title="Forçar logout" data-a="logout" data-id="' + u.id + '" data-n="' + E(u.username) + '"><i class="fas fa-power-off"></i></button>' +
        (u.role !== 'admin' ? '<button class="ap-ib danger" title="Excluir" data-a="del" data-id="' + u.id + '" data-n="' + E(u.username) + '"><i class="fas fa-trash"></i></button>' : '') +
        '</div></div>';
    }).join('') : '<div class="empty-state"><i class="fas fa-users"></i><p>Nenhum usuário encontrado</p></div>';
  }
  window.loadUsers = () => loadUsersPlus(false);
  $('auQ').oninput = e => { uQ = e.target.value.trim().toLowerCase(); renderUsers(); };
  $('auS').onchange = e => { uSort = e.target.value; renderUsers(); };
  $('auChips').onclick = e => { const b = e.target.closest('[data-k]'); if (b) { uFilter = b.dataset.k; renderUsers(); } };
  $('auCsv').onclick = () => csv('usuarios.csv', [['usuario', 'email', 'cargo', 'status', 'arquivos', 'bytes', 'ultimo_acesso', 'criado_em']].concat(U.map(u => [u.username, u.email, u.role, u.status, u.files, u.bytes, u.last_seen || '', u.created_at])));
  function csv(name, rows) {
    const body = rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(';')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + body], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const ask = (text, fn) => window.confirmAction ? window.confirmAction(text, fn) : (confirm(text) && fn());
  $('usersList').onclick = async e => {
    const b = e.target.closest('[data-a]'); if (!b) return; const id = b.dataset.id, n = b.dataset.n, a = b.dataset.a;
    const run = async (url, msg, body) => { try { await post(url, body); toast(msg); loadUsersPlus(true); window.loadStats && window.loadStats(); } catch (er) { toast(er.message, 'error'); } };
    if (a === 'approve') run('/api/admin/users/' + id + '/approve', 'Usuário aprovado!');
    else if (a === 'reject') run('/api/admin/users/' + id + '/reject', 'Usuário rejeitado', {});
    else if (a === 'unban') run('/api/admin/users/' + id + '/unban', 'Usuário reativado');
    else if (a === 'ban') ask('Suspender ' + n + '? Ele será deslogado e não conseguirá entrar.', () => run('/api/admin/users/' + id + '/ban', 'Usuário suspenso'));
    else if (a === 'role') ask((b.dataset.r === 'admin' ? 'Promover ' : 'Rebaixar ') + n + (b.dataset.r === 'admin' ? ' a ADM? Ele terá acesso total.' : ' a usuário comum?'), () => run('/api/admin/users/' + id + '/role', 'Cargo alterado', { role: b.dataset.r }));
    else if (a === 'logout') ask('Deslogar ' + n + ' de todos os aparelhos?', () => run('/api/admin/users/' + id + '/logout', 'Logout forçado'));
    else if (a === 'del') ask('Excluir ' + n + ' definitivamente?', async () => { try { await api('/api/admin/users/' + id, { method: 'DELETE' }); toast('Usuário excluído'); loadUsersPlus(true); window.loadStats && window.loadStats(); } catch (er) { toast(er.message, 'error'); } });
    else if (a === 'pw') ask('Gerar uma senha temporária para ' + n + '? Ele será deslogado.', async () => { try { const r = await post('/api/admin/users/' + id + '/reset-password'); modal('<i class="fas fa-key"></i> Senha temporária de ' + E(n), '<p style="margin-bottom:10px">Envie esta senha ao usuário. Ela só aparece agora:</p><div class="ap-pw">' + E(r.password) + '</div>', '<button class="btn btn-green" onclick="navigator.clipboard.writeText(\'' + r.password + '\');this.textContent=\'Copiado!\'">Copiar</button>'); } catch (er) { toast(er.message, 'error'); } });
    else if (a === 'detail') userDetail(id);
  };
  function modal(title, body, footer) {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = '<div class="modal-overlay"></div><div class="modal-content" style="max-width:640px"><div class="modal-header"><h3>' + title + '</h3><button class="modal-close">&times;</button></div><div class="modal-body">' + body + '</div>' + (footer ? '<div class="modal-footer">' + footer + '</div>' : '') + '</div>';
    document.body.appendChild(m);
    const close = () => m.remove(); m.querySelector('.modal-overlay').onclick = close; m.querySelector('.modal-close').onclick = close; return m;
  }
  async function userDetail(id) {
    let d; try { d = await api('/api/admin/users/' + id + '/detail'); } catch (e) { return toast(e.message, 'error'); }
    const u = d.user;
    modal('<i class="fas fa-id-card"></i> ' + E(u.username) + (u.role === 'admin' ? ' · ADM' : ''),
      '<div class="ap-meta" style="margin-bottom:12px"><span>' + E(u.email) + '</span><span>Criado: ' + when(u.created_at) + '</span><span>Último login: ' + when(u.last_login) + '</span><span>Visto: ' + ago(u.last_seen) + '</span><span>IP: ' + E(u.last_ip || '—') + '</span><span>Sessões salvas: ' + d.sessions.length + '</span></div>' +
      '<h4 style="margin:10px 0 6px">Salas (' + d.rooms.length + ')</h4><div>' + (d.rooms.map(r => '<span class="badge badge-blue" style="margin:2px">' + E(r.name) + '</span>').join('') || '<span class="text-muted">Nenhuma</span>') + '</div>' +
      '<h4 style="margin:14px 0 6px">Arquivos recentes</h4>' + (d.files.map(f => '<div class="ap-row"><span class="grow">' + E(f.original_name) + '</span><span class="text-muted">' + E(f.room || '') + '</span><b>' + size(f.size) + '</b></div>').join('') || '<span class="text-muted">Nenhum</span>') +
      '<h4 style="margin:14px 0 6px">Atividade</h4>' + (d.activity.map(a => '<div class="ap-row">' + actBadge(a.action) + '<span class="grow text-muted">' + E(a.detail) + '</span><span class="text-muted">' + ago(a.created_at) + '</span></div>').join('') || '<span class="text-muted">Sem registros</span>'));
  }

  // ---------- arquivos ----------
  let F = [], sel = new Set(), fT;
  async function loadFiles() {
    try { F = await api('/api/admin/files?q=' + encodeURIComponent($('afQ').value)); } catch (e) { return; }
    sel = new Set([...sel].filter(id => F.some(f => f.id === id))); drawFiles();
  }
  function drawFiles() {
    $('afN').textContent = sel.size; $('afDel').disabled = !sel.size;
    $('afList').innerHTML = F.length ? F.map(f => '<div class="ap-row"><input type="checkbox" class="ap-sel" data-id="' + f.id + '"' + (sel.has(f.id) ? ' checked' : '') + '><div class="grow"><b>' + E(f.original_name) + '</b><div class="ap-meta"><span>' + E(f.uploader || '—') + admTag(f.uploader_role) + '</span><span><i class="fas fa-door-open"></i> ' + E(f.room || '—') + '</span><span>' + (window.fileKind ? E(window.fileKind(f.original_name, f.mime_type)) : '') + '</span><span>' + when(f.uploaded_at) + '</span></div></div><b>' + size(f.size) + '</b><a class="btn btn-sm btn-green" href="/download/' + f.id + '"><i class="fas fa-download"></i></a></div>').join('') : '<div class="empty-state"><i class="fas fa-inbox"></i><p>Nenhum arquivo</p></div>';
  }
  $('afQ').oninput = () => { clearTimeout(fT); fT = setTimeout(loadFiles, 300); };
  $('afList').onchange = e => { const c = e.target.closest('.ap-sel'); if (!c) return; c.checked ? sel.add(c.dataset.id) : sel.delete(c.dataset.id); drawFiles(); };
  $('afAll').onclick = () => { if (sel.size === F.length) sel.clear(); else F.forEach(f => sel.add(f.id)); drawFiles(); };
  $('afDel').onclick = () => ask('Excluir ' + sel.size + ' arquivo(s) definitivamente?', async () => { try { const r = await post('/api/admin/files/bulk-delete', { ids: [...sel] }); toast(r.deleted + ' arquivo(s) excluído(s)'); sel.clear(); loadFiles(); } catch (e) { toast(e.message, 'error'); } });

  // ---------- monitor de chat ----------
  let chatRoom = '', chatSig = '';
  async function chatInit() {
    try {
      const rooms = await api('/api/admin/rooms-lite');
      const cur = $('acRoom').value;
      $('acRoom').innerHTML = rooms.length ? rooms.map(r => '<option value="' + r.id + '">' + E(r.name) + ' (' + (Number(r.msgs) || 0) + ')</option>').join('') : '<option value="">Sem salas</option>';
      if (cur && rooms.some(r => r.id === cur)) $('acRoom').value = cur;
    } catch (e) { return; }
    chatLoad(true);
  }
  async function chatLoad(force) {
    chatRoom = $('acRoom').value; if (!chatRoom) { $('acList').innerHTML = '<p class="text-muted">Nenhuma sala.</p>'; return; }
    let msgs; try { msgs = await api('/api/rooms/' + chatRoom + '/messages'); } catch (e) { return; }
    const sig = chatRoom + JSON.stringify(msgs.map(m => m.id)); if (!force && sig === chatSig) return; chatSig = sig;
    const box = $('acList'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = msgs.length ? msgs.map(m => '<div class="ap-msg"><div class="avatar avatar-sm" style="background:' + E(m.avatar_color) + '">' + E(m.username[0].toUpperCase()) + '</div><div class="grow"><b>' + E(m.username) + '</b>' + admTag(m.role) + ' <span class="text-muted" style="font-size:11px">' + when(m.created_at) + '</span><div>' + (window.linkify ? window.linkify(m.content) : E(m.content)) + '</div></div><button class="ap-ib danger" title="Apagar mensagem" data-id="' + m.id + '"><i class="fas fa-trash"></i></button></div>').join('') : '<p class="text-muted">Sem mensagens nesta sala.</p>';
    if (force || atBottom) box.scrollTop = box.scrollHeight;
  }
  $('acRoom').onchange = () => chatLoad(true);
  $('acList').onclick = async e => { const b = e.target.closest('[data-id]'); if (!b) return; try { await api('/api/admin/messages/' + b.dataset.id, { method: 'DELETE' }); toast('Mensagem apagada'); chatLoad(true); } catch (er) { toast(er.message, 'error'); } };
  $('acClear').onclick = () => { if (!$('acRoom').value) return; ask('Apagar TODAS as mensagens desta sala?', async () => { try { await post('/api/admin/rooms/' + $('acRoom').value + '/clear-chat'); toast('Chat limpo'); chatLoad(true); } catch (e) { toast(e.message, 'error'); } }); };

  // ---------- atividade ----------
  let LG = [], lT;
  async function loadLog() {
    try { LG = await api('/api/admin/log?action=' + encodeURIComponent($('alA').value) + '&q=' + encodeURIComponent($('alQ').value)); } catch (e) { return; }
    $('alList').innerHTML = LG.length ? LG.map(a => '<div class="ap-row" style="flex-wrap:wrap">' + actBadge(a.action) + '<span class="grow" style="white-space:normal">' + E(a.username || '—') + admTag(a.role) + ' <span class="text-muted">' + E(a.detail) + '</span></span><span class="text-muted" style="font-size:12px">' + E(a.ip || '') + ' · ' + when(a.created_at) + '</span></div>').join('') : '<div class="empty-state"><i class="fas fa-clock-rotate-left"></i><p>Sem registros</p></div>';
  }
  $('alQ').oninput = () => { clearTimeout(lT); lT = setTimeout(loadLog, 300); };
  $('alA').onchange = loadLog;
  $('alCsv').onclick = () => csv('atividade.csv', [['data', 'usuario', 'acao', 'detalhe', 'ip', 'dispositivo']].concat(LG.map(a => [a.created_at, a.username, a.action, a.detail, a.ip, a.user_agent])));

  // ---------- comunicados / sistema ----------
  async function loadComms() {
    try { const s = await api('/api/admin/settings'); if (document.activeElement !== $('anT')) $('anT').value = s.announcement; $('anY').value = s.announcement_type; $('syReg').value = s.registration_mode; } catch (e) {}
  }
  $('bcSend').onclick = () => { const t = $('bcT').value.trim(), m = $('bcM').value.trim(); if (!t || !m) return toast('Preencha título e mensagem', 'error'); ask('Enviar este comunicado para TODOS os usuários?', async () => { try { const r = await post('/api/admin/broadcast', { title: t, message: m, type: $('bcY').value }); toast('Enviado para ' + r.sent + ' usuários'); $('bcT').value = ''; $('bcM').value = ''; } catch (e) { toast(e.message, 'error'); } }); };
  $('anSave').onclick = async () => { try { await post('/api/admin/settings', { announcement: $('anT').value, announcement_type: $('anY').value }); toast('Aviso publicado'); } catch (e) { toast(e.message, 'error'); } };
  $('anClear').onclick = async () => { try { await post('/api/admin/settings', { announcement: '' }); $('anT').value = ''; toast('Aviso removido'); } catch (e) { toast(e.message, 'error'); } };
  $('sySave').onclick = async () => { try { await post('/api/admin/settings', { registration_mode: $('syReg').value }); toast('Configuração salva'); } catch (e) { toast(e.message, 'error'); } };

  // ---------- controles extras nas salas (tempo / visibilidade / chat) ----------
  document.addEventListener('click', e => { /* reservado */ });
  const roomsTab = $('tab-rooms');
  const rTools = document.createElement('div'); rTools.className = 'ap-tools';
  rTools.innerHTML = '<span class="text-muted" style="font-size:13px">Atalhos de sala:</span><select id="arRoom" style="min-width:180px"></select><button class="btn btn-sm btn-outline" data-r="pub"><i class="fas fa-globe"></i> Pública</button><button class="btn btn-sm btn-outline" data-r="priv"><i class="fas fa-lock"></i> Privada</button><button class="btn btn-sm btn-outline" data-r="x10">+10 min</button><button class="btn btn-sm btn-outline" data-r="x60">+1 h</button><button class="btn btn-sm btn-outline" data-r="perm"><i class="fas fa-infinity"></i> Permanente</button>';
  roomsTab.querySelector('h2').after(rTools);
  async function fillRoomSel() { try { const rs = await api('/api/admin/rooms-lite'); const c = $('arRoom').value; $('arRoom').innerHTML = rs.map(r => '<option value="' + r.id + '">' + E(r.name) + (r.expires_at ? ' ⏳' : '') + '</option>').join(''); if (c) $('arRoom').value = c; } catch (e) {} }
  rTools.onclick = async e => {
    const b = e.target.closest('[data-r]'); const id = $('arRoom').value; if (!b || !id) return;
    try {
      if (b.dataset.r === 'pub' || b.dataset.r === 'priv') await post('/api/admin/rooms/' + id + '/visibility', { is_public: b.dataset.r === 'pub' });
      else await post('/api/admin/rooms/' + id + '/extend', { minutes: b.dataset.r === 'perm' ? 0 : b.dataset.r === 'x10' ? 10 : 60 });
      toast('Sala atualizada'); window.loadRooms && window.loadRooms();
    } catch (er) { toast(er.message, 'error'); }
  };
  const origShow = window.showTab; window.showTab = function (n) { origShow(n); if (n === 'rooms') fillRoomSel(); };

  // ---------- atualização automática ----------
  setInterval(() => {
    if (document.hidden) return;
    const a = document.querySelector('.tab-content.active'); const id = a ? a.id : '';
    if (id === 'tab-stats') overview();
    else if (id === 'tab-chat') chatLoad(false);
    else if (id === 'tab-log' && !$('alQ').value) loadLog();
  }, 4000);
  overview();
})();
