// Baixa o conteúdo original de uma mensagem como texto UTF-8, sem renderizar
// nem normalizar comandos, espaços, tabs ou quebras de linha.
(function () {
  'use strict';
  const messagesByScope = new Map();
  const LONG_MESSAGE_THRESHOLD = 12000;
  const countCharacters = value => Array.from(String(value == null ? '' : value)).length;

  function detectSourceFormat(text) {
    const source = String(text == null ? '' : text);
    const trimmed = source.trim();
    const fenced = trimmed.match(/^```\s*([\w+#.-]+)\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fenced) {
      const language = fenced[1].toLowerCase();
      const extensions = { js: 'js', javascript: 'js', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx', py: 'py', python: 'py', html: 'html', htm: 'html', css: 'css', scss: 'scss', sql: 'sql', json: 'json', sh: 'sh', bash: 'sh', shell: 'sh', md: 'md', markdown: 'md', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', 'c#': 'cs', cs: 'cs', csharp: 'cs', go: 'go', rust: 'rs', rs: 'rs', php: 'php', ruby: 'rb', rb: 'rb', yaml: 'yml', yml: 'yml', xml: 'xml', kotlin: 'kt', kt: 'kt', swift: 'swift', dart: 'dart', scala: 'scala', perl: 'pl', pl: 'pl', lua: 'lua', r: 'r', powershell: 'ps1', ps1: 'ps1', dockerfile: 'dockerfile', toml: 'toml', ini: 'ini', diff: 'diff', graphql: 'graphql', gql: 'graphql', vue: 'vue', svelte: 'svelte', objectivec: 'm', objc: 'm', fsharp: 'fs', elixir: 'ex', haskell: 'hs', clojure: 'clj', erlang: 'erl' };
      if (extensions[language]) return { kind: 'code', extension: extensions[language], fencedCode: true, mime: 'text/plain;charset=utf-8' };
    }
    if (/^\s*<!doctype\s+html\b|^\s*<html\b|<\/(?:html|body|head)>/im.test(source)) return { kind: 'code', extension: 'html', mime: 'text/plain;charset=utf-8' };
    if (/^\s*(?:SELECT|WITH|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW|DATABASE)|ALTER\s+TABLE|DROP\s+(?:TABLE|DATABASE))\b/im.test(source) && /\b(?:FROM|WHERE|JOIN|VALUES|SET|TABLE|SELECT)\b/i.test(source)) return { kind: 'code', extension: 'sql', mime: 'text/plain;charset=utf-8' };
    if (/^\s*(?:@media\b|:root\s*\{|[.#][\w-]+(?:\s+[.#][\w-]+)*\s*\{)[\s\S]*\b(?:color|background|display|margin|padding|font|width|height)\s*:/im.test(source)) return { kind: 'code', extension: 'css', mime: 'text/plain;charset=utf-8' };
    if (/^\s*[\[{]/.test(source)) {
      try { JSON.parse(source); return { kind: 'code', extension: 'json', mime: 'text/plain;charset=utf-8' }; } catch (error) { /* pode ser outra linguagem */ }
    }
    if (/^\s*#!.*\b(?:bash|sh|zsh)\b|^\s*(?:set\s+-[euo]|export\s+[A-Za-z_]|(?:sudo\s+)?(?:apt|npm|pnpm|yarn|git|docker|kubectl)\s+)/m.test(source)) return { kind: 'code', extension: 'sh', mime: 'text/plain;charset=utf-8' };
    if (/^\s*(?:def\s+\w+\s*\(|async\s+def\s+\w+\s*\(|from\s+\w[\w.]*\s+import\s+|import\s+\w[\w.]*\s*$|class\s+\w+\s*(?:\([^)]*\))?\s*:|if\s+__name__\s*==\s*['"]__main__['"])/m.test(source) || /^\s*(?:print\s*\(|(?:for|while|if|elif|else|try|except|with)\b[^\n]*:\s*(?:\r?\n|$)){2,}/m.test(source)) return { kind: 'code', extension: 'py', mime: 'text/plain;charset=utf-8' };
    if (/^\s*(?:import\s+.+\s+from\s+['"]|export\s+(?:default|const|function|class|\{)|(?:const|let|var)\s+[\w$]+\s*=|(?:async\s+)?function\s+[\w$]+\s*\(|console\.(?:log|error|warn)\s*\(|document\.(?:querySelector|getElementById)\s*\()/m.test(source)) return { kind: 'code', extension: 'js', mime: 'text/plain;charset=utf-8' };
    if (/^\s*(?:#include\s*[<"]|int\s+main\s*\(|public\s+(?:class|static\s+void\s+main)\b|class\s+\w+\s*\{)/m.test(source)) {
      const extension = /^\s*#include/m.test(source) ? (/\bstd::|#include\s*<iostream>/m.test(source) ? 'cpp' : 'c') : 'java';
      return { kind: 'code', extension, mime: 'text/plain;charset=utf-8' };
    }
    if (/^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|```/m.test(source)) return { kind: 'markdown', extension: 'md', mime: 'text/plain;charset=utf-8' };
    const prompt = /\b(?:prompt|system prompt|you are|act as|your task is|must follow|respond in|output format|objetivo|instru[cç][aã]o|voc[eê] [eé]|atue como|sua tarefa|responda em|formato de sa[ií]da)\b/i.test(source);
    return { kind: prompt ? 'prompt' : 'text', extension: 'txt', mime: 'text/plain;charset=utf-8' };
  }

  window.classifyLongMessage = function (content) {
    const text = String(content == null ? '' : content);
    const characterCount = countCharacters(text);
    if (characterCount <= LONG_MESSAGE_THRESHOLD) return { isLong: false, characterCount, threshold: LONG_MESSAGE_THRESHOLD };
    return { isLong: true, characterCount, threshold: LONG_MESSAGE_THRESHOLD, ...detectSourceFormat(text) };
  };

  window.createLongMessageFile = function (content) {
    const text = String(content == null ? '' : content);
    const classification = window.classifyLongMessage(text);
    if (!classification.isLong || typeof File !== 'function') return null;
    const prefix = classification.kind === 'code' ? 'codigo' : classification.kind === 'prompt' ? 'prompt' : classification.kind === 'markdown' ? 'documento' : 'texto';
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    // Delimitadores Markdown informam a linguagem, mas não fazem parte do
    // arquivo fonte; o corpo permanece byte a byte, inclusive CRLF e recuos.
    const fenced = classification.fencedCode && text.trim().match(/^```\s*[\w+#.-]+\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
    const fileContent = fenced ? fenced[1] : text;
    const file = new File([fileContent], prefix + '-' + timestamp + '.' + classification.extension, { type: classification.mime, lastModified: Date.now() });
    return { file, ...classification };
  };

  window.describeLongMessage = function (content) {
    const classification = window.classifyLongMessage(content);
    if (!classification.isLong) return '';
    const labels = { code: 'código', prompt: 'prompt', markdown: 'documento Markdown', text: 'texto longo' };
    return 'Conteúdo longo detectado (' + classification.characterCount.toLocaleString('pt-BR') + ' caracteres): ' + labels[classification.kind] + ' · será enviado como .' + classification.extension + ' para preservar a estrutura.';
  };

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