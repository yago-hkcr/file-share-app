// Regressão: o cliente de Coletas precisa iniciar e substituir o spinner
// mesmo quando a API informa que o link está inválido.
//
// Uso: node test/regression-collections-client-startup.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = readFileSync(path.join(ROOT, 'public', 'js', 'collection-upload.js'), 'utf8');
const listeners = new Map();
const root = {
  innerHTML: '<div class="loading">Abrindo seu link seguro...</div>',
  classList: { add() {}, remove() {} },
  addEventListener(name, handler) { listeners.set(name, handler); },
  querySelectorAll() { return []; },
  insertAdjacentHTML() {}
};
let apiRequested = false;
const intervals = new Set();
const context = {
  document: {
    hidden: false,
    getElementById(id) { return id === 'collectionPublicRoot' ? root : null; },
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
  window: { location: { pathname: '/enviar/' + 'A'.repeat(43), origin: 'https://example.test' } },
  sessionStorage: {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
  },
  navigator: {},
  fetch: async url => {
    apiRequested = String(url).startsWith('/api/coletas/enviar/');
    return {
      ok: false,
      status: 404,
      async json() { return { state: 'invalid', error: 'Este link de envio não é válido.' }; }
    };
  },
  setInterval(callback) { intervals.add(callback); return callback; },
  clearInterval(callback) { intervals.delete(callback); },
  setTimeout() { return 1; },
  clearTimeout() {},
  URL: { revokeObjectURL() {} },
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
  Promise
};

vm.runInNewContext(client, context, { filename: 'collection-upload.js' });
await new Promise(resolve => setImmediate(resolve));

const checks = [
  [apiRequested, 'a inicialização consulta a API do link'],
  [root.innerHTML.includes('Link indisponível'), 'link inválido substitui a tela de carregamento'],
  [!root.innerHTML.includes('Abrindo seu link seguro'), 'a página não permanece presa no spinner'],
  [listeners.has('input') && listeners.has('change'), 'os handlers do formulário foram registrados']
];
let failures = 0;
for (const [passed, label] of checks) {
  console.log(`${passed ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!passed) failures++;
}
for (const callback of intervals) clearInterval(callback);

if (failures) {
  console.error(`\n${failures} regressão(ões) detectada(s) na inicialização de Coletas.`);
  process.exit(1);
}
console.log('\nInicialização do cliente de Coletas validada.');