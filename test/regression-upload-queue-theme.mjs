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
check(dashboard.includes('/js/upload-queue.js?v=20261031b') && dashboard.includes('/css/upload-queue.css?v=20261031b') &&
  dashboard.includes('/js/upload.js?v=20261031b') && dashboard.includes('/js/library.js?v=20261030e') && dashboard.includes('/css/collections.css?v=20261030d'),
  'dashboard carrega os assets atualizados de upload, fila e Coletas');
check(sw.includes("'/js/upload-queue.js?v=20261031b'") && sw.includes("'/css/upload-queue.css?v=20261031b'") &&
  sw.includes("'/js/upload.js?v=20261031b'") && sw.includes("'/js/library.js?v=20261030e'") && sw.includes("'/css/collections.css?v=20261030d'") &&
  sw.includes("'/js/collection-upload.js?v=20261030c'") && sw.includes("'/js/collections.js?v=20261031a'"),
  'Service Worker inclui os assets atualizados de upload, fila e Coletas');
check(queue.includes('IDLE_MINIMIZE_MS = 5000') && queue.includes('setTimeout(() => setOpen(false, true), IDLE_MINIMIZE_MS)') &&
  queue.includes('enableDragging(launcher, false)') && queue.includes('enableDragging(panel.querySelector(\'.fs-upload-panel-head\'), true)') &&
  queue.includes('is-side-rail') && queue.includes('positionPanelByLauncher()'),
  'fila flutuante pode ser movida e recolhe para a lateral após cinco segundos sem atividade');
check(server.includes('isBlobStoreSuspended') && server.includes('blobStoreSuspendedMessage') &&
  server.includes("return res.status(503).json({ error: blobStoreSuspendedMessage })"),
  'falha por Blob store suspensa informa a causa e orienta reativar o armazenamento');
check(upload.includes("'/api/dm/' + friendId + '/drive-upload-session'") &&
  upload.includes("'/api/dm/' + friendId + '/drive-files/register'") &&
  upload.includes('if (driveUploadEnabled) {') &&
  upload.includes('await uploadDriveInChunks(prep.data, file, reportProgress, options.signal);'),
  'conversas diretas reutilizam o envio resumível pelo Google Drive quando conectado');
check(queue.includes("task.cancelable = task.cancelAllowed && phase === 'uploading' && task.canCancel") &&
  queue.includes("['failed', 'cancelled'].includes(task.state)"),
  'cancelamento só fica disponível durante transporte cancelável e limpar fila preserva envios concluídos');
check(upload.includes('onPhase, onCancelable') && upload.includes("onPhase('finalizing')") &&
  upload.includes('cancelable: destination === \'Sala\' || (destination === \'Conversa direta\' && options.cancelableDm === true)'),
  'fase de finalização e cancelabilidade explícita são propagadas ao transporte');
const dmUpload = upload.slice(upload.indexOf('async function uploadToDmDirect'), upload.indexOf('async function uploadWithQueue'));
check(dmUpload.includes('onCancelable(false);') && dmUpload.includes('onCancelable(true);') &&
  dmUpload.includes('await putWithProgress(prep.data.presignedUrl, file, reportProgress, options.signal);') &&
  dmUpload.includes('await uploadDriveInChunks(prep.data, file, reportProgress, options.signal);') &&
  dmUpload.indexOf('onCancelable(false);', dmUpload.indexOf('await putWithProgress')) < dmUpload.indexOf("onPhase('finalizing')", dmUpload.indexOf('await putWithProgress')) &&
  dmUpload.indexOf('onCancelable(false);', dmUpload.indexOf('await uploadDriveInChunks')) < dmUpload.indexOf("onPhase('finalizing')", dmUpload.indexOf('await uploadDriveInChunks')),
  'mensagem direta só permite cancelar o PUT direto e bloqueia cancelamento durante registro');
check(personal.includes("directThread?.addEventListener('drop'") && personal.includes('sendDirectFiles(files)') &&
  personal.includes('event.shiftKey') && personal.includes('result.cancelled'),
  'drag-and-drop envia anexos, Shift+Enter mantém quebras de linha e cancelamento não envia mensagem de texto');
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