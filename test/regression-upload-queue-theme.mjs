// Regressão: fila individual de envios com retry e tema escuro somente como padrão.
// Uso: node test/regression-upload-queue-theme.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const queue = read('public', 'js', 'upload-queue.js');
const upload = read('public', 'js', 'upload.js');
const collectionUpload = read('public', 'js', 'collection-upload.js');
const library = read('public', 'js', 'library.js');
const dashboard = read('public', 'dashboard.html');
const common = read('public', 'js', 'common.js');
const personal = read('public', 'js', 'personal.js');
const server = read('server.js');
const sw = read('public', 'sw.js');

let failures = 0;
function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) failures++;
}

check(queue.includes("task.state = 'failed'") && queue.includes('task.retry = () => execute(task)') && queue.includes('Tentar novamente'),
  'a fila exibe a falha individual e permite repetir a tentativa');
check(queue.includes('progress.max = 100') && queue.includes('task.progress = Math.max'),
  'a fila apresenta progresso individual por arquivo');
check(upload.includes('postFormWithProgress') && upload.includes('uploadWithQueue') && upload.includes('onProgress: progress'),
  'salas e mensagens diretas registram progresso por arquivo');
check(collectionUpload.includes('FileShareUploadQueue.run') && collectionUpload.includes('data-retry-collection'),
  'Coletas integram a fila e oferecem retry do item que falhou');
check(library.includes('FileShareUploadQueue.run') && library.includes('putWithProgress'),
  'envios diretos à Biblioteca exibem progresso individual');
check(dashboard.includes('/js/upload-queue.js?v=20261027a') && dashboard.includes('/css/upload-queue.css?v=20261027a'),
  'dashboard carrega os assets da fila');
check(sw.includes("'/js/upload-queue.js?v=20261027a'") && sw.includes("'/css/upload-queue.css?v=20261027a'") &&
  sw.includes("'/js/collection-upload.js?v=20261030a'"),
  'Service Worker inclui os assets atualizados da fila e das Coletas');
check(common.includes("const normalizeTheme = theme => ['system', 'light', 'dark'].includes(theme) ? theme : 'dark'"),
  'tema escuro é o padrão inicial e escolhas locais salvas continuam válidas');
check(personal.includes("const defaults = { theme: 'dark'") && personal.includes("!prefs.has_preferences") &&
  personal.includes("getAttribute('data-theme-preference') || defaults.theme"),
  'preferência explícita local é preservada antes de salvar preferências da conta');
check(server.includes("? row.theme : 'dark'") && server.includes("? b.theme : 'dark'"),
  'API usa tema escuro como padrão sem substituir tema válido salvo na conta');

if (failures) {
  console.error(`\n${failures} falha(s).`);
  process.exitCode = 1;
} else {
  console.log('\nTodas as asserções passaram.');
}