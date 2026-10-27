// Regressão: exportar mensagem como TXT preserva exatamente o texto original
// e a ação está disponível tanto no chat de sala quanto nas conversas diretas.
// Uso: node test/regression-message-text-export.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exporterSource = readFileSync(path.join(ROOT, 'public', 'js', 'message-export.js'), 'utf8');
const dashboard = readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
const directChat = readFileSync(path.join(ROOT, 'public', 'js', 'personal.js'), 'utf8');
const styles = readFileSync(path.join(ROOT, 'public', 'css', 'social.css'), 'utf8');
const serviceWorker = readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

let failures = 0;
function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) failures++;
}

let generatedBlob = null, clickedLink = null, revokedUrl = null, revokeTimer = null;
class TestFile extends Blob {
  constructor(parts, name, options) {
    super(parts, options);
    this.name = name;
    this.lastModified = 0;
  }
}
const documentStub = {
  body: { appendChild(node) { node.isConnected = true; } },
  createElement(tagName) {
    const node = {
      tagName: tagName.toUpperCase(), style: {}, isConnected: false,
      click() { clickedLink = this; },
      remove() { this.isConnected = false; }
    };
    return node;
  }
};
const context = {
  window: {}, document: documentStub, Blob, File: TestFile,
  URL: {
    createObjectURL(blob) { generatedBlob = blob; return 'blob:message-export-test'; },
    revokeObjectURL(url) { revokedUrl = url; }
  },
  setTimeout(callback, delay) { revokeTimer = { callback, delay }; return 1; }
};
vm.runInNewContext(exporterSource, context, { filename: 'message-export.js' });

const original = '  $ comando --flag\r\n\tlinha com indentação\nconst exemplo = "ação";\n\n fim  ';
context.window.downloadMessageAsText(original, 'msg-123');
check(generatedBlob instanceof Blob && generatedBlob.type === 'text/plain;charset=utf-8', 'gera arquivo TXT em UTF-8');
check(await generatedBlob.text() === original, 'preserva bytes/texto, espaços, tabs e quebras de linha originais');
check(clickedLink && clickedLink.download === 'mensagem-msg-123.txt', 'baixa com nome TXT seguro e extensão .txt');
check(!clickedLink.isConnected, 'remove o link temporário após iniciar o download');
revokeTimer?.callback();
check(revokeTimer?.delay === 1000 && revokedUrl === 'blob:message-export-test', 'libera a URL temporária após o download');

context.window.setMessageTextExportBatch('room', [{ id: 'room-456', content: original }]);
context.window.downloadMessageTextById('room', 'room-456');
check(await generatedBlob.text() === original && clickedLink.download === 'mensagem-room-456.txt',
  'exportação do chat de sala usa o texto original preservado fora do HTML');
context.window.setMessageTextExportBatch('direct', [{ id: 'dm-789', content: original }]);
context.window.downloadMessageTextById('direct', 'dm-789');
check(await generatedBlob.text() === original && clickedLink.download === 'mensagem-dm-789.txt',
  'exportação da conversa direta usa o texto original preservado fora do HTML');
for (const scope of ['room', 'direct']) {
  const id = scope === 'room' ? 'room-456' : 'dm-789';
  const file = context.window.createMessageTextFileById(scope, id);
  check(file instanceof TestFile && file.name === 'mensagem-' + id + '.txt' && file.type === 'text/plain;charset=utf-8',
    scope + ' cria anexo TXT com nome e tipo corretos');
  check(await file.text() === original, scope + ' anexa exatamente o texto original, sem normalização');
}
check(context.window.createMessageTextFileById('room', 'inexistente') === null,
  'não cria anexo se a mensagem original não está disponível');

check(dashboard.includes('class="message-export-trigger message-action-button"') && dashboard.includes('window.downloadMessageTextById(') && dashboard.includes('data-export-scope="room"'),
  'chat da sala oferece a ação de salvar TXT');
check(dashboard.includes('class="message-send-text-trigger message-action-button"') && dashboard.includes('data-send-text-scope="room"') && dashboard.includes('sendFiles([file], { chatOnly: true })'),
  'chat da sala oferece enviar o TXT como anexo pelo fluxo de upload do chat');
check(directChat.includes('class="message-export-trigger message-action-button"') && directChat.includes('window.downloadMessageTextById(') && directChat.includes('data-export-scope="direct"'),
  'conversa direta oferece a ação de salvar TXT');
check(directChat.includes('class="message-send-text-trigger message-action-button"') && directChat.includes('data-send-text-scope="direct"') && directChat.includes('window.uploadToDm(friendId, [file]'),
  'conversa direta oferece enviar o TXT como anexo pelo fluxo de upload da DM');
check(/\.msg-actions[\s\S]*?flex-wrap:\s*wrap/.test(styles) && /@media \(hover:\s*none\), \(max-width:\s*640px\)[\s\S]*?min-height:\s*42px/.test(styles),
  'controles permanecem alcançáveis em telas pequenas e toque');
check(dashboard.includes('/js/message-export.js?v=20261027b') && dashboard.includes('/js/personal.js?v=20261027b') && dashboard.includes('/css/social.css?v=20261027b') &&
  serviceWorker.includes("'/js/message-export.js?v=20261027b'") && serviceWorker.includes("'/js/personal.js?v=20261027b'") && serviceWorker.includes("'/css/social.css?v=20261027b'"),
  'service worker pré-carrega os assets novos com versões atualizadas');

const inlineScripts = [...dashboard.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes, source]) => !/\bsrc\s*=/.test(attributes) && source.trim());
let inlineScriptsValid = true;
for (const [, , source] of inlineScripts) {
  try { new vm.Script(source); } catch (error) { inlineScriptsValid = false; console.error(error.message); }
}
check(inlineScripts.length > 0 && inlineScriptsValid, 'scripts inline do dashboard mantêm sintaxe válida');

if (failures) {
  console.error(`\n${failures} falha(s).`);
  process.exit(1);
}
console.log('\nTodas as asserções passaram.');