// Painel ADM avanÃ§ado: visÃ£o geral, usuÃ¡rios completos, arquivos, monitor de chat, atividade, comunicados e sistema.
(function () {
  const $ = id => document.getElementById(id);
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const size = b => { if (!b) return '0 B'; const k = 1024, u = ['B', 'KB', 'MB', 'GB']; const i = Math.min(3, Math.floor(Math.log(b) / Math.log(k))); return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + u[i]; };
  const dt = s => s ? new Date(s.replace(' ', 'T') + 'Z') : null;
  const when = s => { const d = dt(s); return d ? d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'â€”'; };
  const ago = s => { const d = dt(s); if (!d) return 'nunca'; const t = Math.max(0, (Date.now() - d) / 1000); if (t < 60) return 'agora'; if (t < 3600) return Math.round(t / 60) + ' min atrÃ¡s'; if (t < 86400) return Math.floor(t / 3600) + ' h atrÃ¡s'; return Math.floor(t / 86400) + ' d atrÃ¡s'; };
  const toast = (m, t) => window.showToast && window.showToast(m, t || 'success');
  async function api(url, opt) {
    const r = await fetch(url, opt);
    if (r.status === 401) { location.href = '/'; throw new Error('401'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erro');
    return j;
  }
  const post = (url, body) => api(url, { method: 'POS¶»§q«^