// Regressão ponta a ponta do cliente: a fila precisa executar o upload real
// selecionado no formulário antes de concluir a coleta.
//
// Uso: node test/regression-collections-upload-queue.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = readFileSync(path.join(ROOT, 'public', 'js', 'collection-upload.js'), 'utf8');
const publicPage = readFileSync(path.join(ROOT, 'public', 'coleta.html'), 'utf8');
const serviceWorker = readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const listeners = new Map();
const root = {
  innerHTML: '<div class="loading">Abrindo seu link seguro...</div>',
  classList: { add() {}, remove() {} },
  addEventListener(name, handler) { listeners.set(name, handler); },
  querySelectorAll() { return []; },
  insertAdjacentHTML() {}
};
const progressNode = { textContent: '' };
const file = new File(['conteúdo real do arquivo de teste\n'], 'comprovante.txt', { type: 'text/plain' });
const item = { id: 'item-comprovante', label: 'Comprovante', quantity: 1, required: 1 };
const collection = {
  title: 'Coleta de teste', participant_name: 'Participante de teste',
  single_link: false, multi_use_link: false, exclusive_access: false,
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  max_upload_bytes: 10_000_000, server_upload_max_bytes: 4 * 1024 * 1024, blob_enabled: true,
  items: [item], uploads: []
};
let uploadRequest = null;
let finalized = false;
let queueInvocation = null;

class MockXHR {
  constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
  open(method, url) { this.method = method; this.url = url; }
  send(body) {
    uploadRequest = { method: this.method, url: this.url, fileName: body.get('file')?.name, itemId: body.get('item_id') };
    this.upload.onprogress?.({ lengthComputable: true, loaded: file.size, total: file.size });
    this.status = 201;
    this.responseText = JSON.stringify({ id: 'uploaded-file-id' });
    queueMicrotask(() => this.onload?.());
  }
  abort() { this.onabort?.(); }
  setRequestHeader() {}
}

const context = {
  document: {
    hidden: false,
    body: {},
    getElementById(id) {
      if (id === 'collectionPublicRoot') return root;
      if (id === 'collectionUploadProgress') return progressNode;
      return null;
    },
    createElement() {
      return {
        set textContent(value) { this._text = String(value); },
        get innerHTML() {
          return this._text.replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
          })[character]);
        }
      };
    },
    addEventListener(name, handler) { listeners.set(`document:${name}`, handler); }
  },
  window: {
    location: { pathname: '/enviar/' + 'A'.repeat(43), origin: 'https://example.test' },
    FileShareUploadQueue: {
      async run(uploadFile, destination, operation, options = {}) {
        queueInvocation = { file: uploadFile, destination, operationType: typeof operation, optionsType: typeof options };
        const value = await operation(() => {});
        if (options.onSuccess) await options.onSuccess(value);
        return { ok: true, value, id: 'queue-task-id' };
      }
    }
  },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  navigator: {},
  fetch: async (url, options = {}) => {
    const route = String(url);
    if (route.endsWith('/finalizar')) {
      finalized = true;
      return { ok: true, status: 200, async json() { return { state: 'submitted' }; } };
    }
    if (route.startsWith('/api/coletas/enviar/')) {
      return { ok: true, status: 200, async json() {
        return { ...collection, uploads: uploadRequest ? [{ id: 'uploaded-file-id', item_id: item.id, original_name: file.name, size: file.size, status: 'ready' }] : [] };
      } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  },
  XMLHttpRequest: MockXHR,
  FormData,
  File,
  setInterval(callback) { return callback; },
  clearInterval() {},
  setTimeout(callback) { return setTimeout(callback, 0); },
  clearTimeout,
  URL: { createObjectURL() { return 'blob:test-file'; }, revokeObjectURL() {} },
  console,
  Map,
  Set,
  Date,
  Math,
  Number,
  String,
  Boolean,
  JSON,
  Error,
  Promise,
  Array
};

function click(selector) {
  return listeners.get('click')({ target: { closest: candidate => candidate === selector ? {} : null } });
}

vm.runInNewContext(client, context, { filename: 'collection-upload.js' });
await new Promise(resolve => setImmediate(resolve));

const input = { dataset: { itemId: item.id }, files: [file] };
listeners.get('change')({ target: { closest: () => input } });
await click('[data-review]');
await click('[data-confirm]');

const checks = [
  [queueInvocation?.file === file, 'a fila recebe o arquivo selecionado'],
  [queueInvocation?.operationType === 'function', 'a fila recebe uma operação de upload executável'],
  [queueInvocation?.optionsType === 'object', 'a fila recebe opções no quarto argumento conforme seu contrato'],
  [publicPage.includes('/js/collection-upload.js?v=20261030b') && serviceWorker.includes("'/js/collection-upload.js?v=20261030b'"), 'a página e o Service Worker carregam o asset corrigido sem cache antigo'],
  [uploadRequest?.method === 'POST' && uploadRequest.url.endsWith('/upload'), 'a função de upload do arquivo é executada'],
  [uploadRequest?.fileName === 'comprovante.txt' && uploadRequest.itemId === item.id, 'o multipart contém arquivo e item corretos'],
  [finalized, 'a coleta só é concluída depois do upload']
];
let failures = 0;
for (const [passed, label] of checks) {
  console.log(`${passed ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!passed) failures++;
}

if (failures) {
  console.error(`\n${failures} regressão(ões) detectada(s) no envio de arquivos da coleta.`);
  process.exit(1);
}
console.log('\nExecução do upload pelo cliente de Coletas validada.');