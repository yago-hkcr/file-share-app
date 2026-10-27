// Baixa o conteúdo original de uma mensagem como texto UTF-8, sem renderizar
// nem normalizar comandos, espaços, tabs ou quebras de linha.
(function () {
  'use strict';
  const messagesByScope = new Map();

  window.setMessageTextExportBatch = function (scope, messages) {
    const batch = new Map();
    (Array.isArray(messages) ? messages : []).forEach(message => {
      if (message && message.id != null) batch.set(String(message.id), message.content == null ? '' : String(message.content));
    });
    messagesByScope.set(String(scope), batch);
  };

  window.downloadMessageAsText = function (content, messageId) {
    const text = content == null ? '' : String(content);
    const safeId = String(messageId || 'mensagem').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'mensagem';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mensagem-' + safeId + '.txt';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  window.downloadMessageTextById = function (scope, messageId) {
    const batch = messagesByScope.get(String(scope));
    const id = String(messageId == null ? '' : messageId);
    if (!batch || !batch.has(id)) return;
    window.downloadMessageAsText(batch.get(id), id);
  };

  window.createMessageTextFileById = function (scope, messageId) {
    const batch = messagesByScope.get(String(scope));
    const id = String(messageId == null ? '' : messageId);
    if (!batch || !batch.has(id)) return null;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'mensagem';
    return new File([batch.get(id)], 'mensagem-' + safeId + '.txt', { type: 'text/plain;charset=utf-8' });
  };
})();