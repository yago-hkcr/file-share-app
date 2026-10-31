// Regressão: exclusões do Google Drive são aguardadas e falhas ficam numa fila persistente.
// Uso: node test/regression-google-drive-deletion.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createGoogleDriveDeletionQueue } = require('../lib/google-drive-deletion.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(path.join(root, 'server.js'), 'utf8');

const queueRows = new Map();
const operations = [];
const deleted = [];
let failedDeletesRemaining = 2;
let currentTime = '2026-10-31 12:00:00';
const query = async (sql, params = []) => {
  if (sql.includes('INSERT INTO google_drive_deletion_queue')) {
    operations.push(['enqueue', params[0]]);
    if (!queueRows.has(params[0])) queueRows.set(params[0], { file_id: params[0], attempts: 0, next_attempt_at: params[2] });
    return [];
  }
  if (sql.includes('DELETE FROM google_drive_deletion_queue')) {
    operations.push(['remove-queue', params[0]]);
    queueRows.delete(params[0]);
    return [];
  }
  if (sql.includes('UPDATE google_drive_deletion_queue')) {
    operations.push(['retry-later', params[0]]);
    const row = queueRows.get(params[0]);
    if (row) Object.assign(row, { attempts: row.attempts + 1, last_error: params[1], next_attempt_at: params[2] });
    return [];
  }
  if (sql.includes('SELECT file_id, attempts FROM google_drive_deletion_queue')) {
    return [...queueRows.values()].filter(row => row.next_attempt_at <= params[0]).slice(0, params[1]);
  }
  throw new Error(`Consulta inesperada: ${sql}`);
};
const storage = {
  async deleteFile(fileId) {
    operations.push(['drive-delete', fileId]);
    if (failedDeletesRemaining > 0) {
      failedDeletesRemaining--;
      throw new Error('Google Drive temporariamente indisponível');
    }
    deleted.push(fileId);
  }
};
const queue = createGoogleDriveDeletionQueue({
  query,
  getStorage: async () => storage,
  now: () => currentTime,
  logger: { error() {} }
});

const first = await queue.enqueueAndDelete(['drive_file_123456', 'drive_file_123456']);
assert.deepEqual(first, { deleted: 0, pending: 1 });
assert.equal(queueRows.size, 1, 'a referência remota permanece na fila quando o Drive falha');
assert.equal(queueRows.get('drive_file_123456').attempts, 1);
assert.ok(queueRows.get('drive_file_123456').last_error.includes('temporariamente'));
assert.deepEqual(operations.slice(0, 3), [
  ['enqueue', 'drive_file_123456'],
  ['drive-delete', 'drive_file_123456'],
  ['retry-later', 'drive_file_123456']
], 'o item da fila é gravado antes da tentativa remota');

assert.deepEqual(await queue.retryPending(), { deleted: 0, pending: 0 }, 'não tenta novamente antes do intervalo');
currentTime = '2026-10-31 12:00:31';
assert.deepEqual(await queue.retryPending(), { deleted: 0, pending: 1 });
assert.equal(queueRows.get('drive_file_123456').attempts, 2);
assert.equal(queueRows.get('drive_file_123456').next_attempt_at, '2026-10-31 12:01:31', 'a espera aumenta com falhas consecutivas');
currentTime = '2026-10-31 12:01:30';
assert.deepEqual(await queue.retryPending(), { deleted: 0, pending: 0 }, 'respeita o intervalo exponencial entre tentativas');
currentTime = '2026-10-31 12:01:32';
assert.deepEqual(await queue.retryPending(), { deleted: 1, pending: 0 });
assert.deepEqual(deleted, ['drive_file_123456']);
assert.equal(queueRows.size, 0, 'remove da fila apenas após confirmação do Drive');

const enqueuesBeforeEmpty = operations.filter(([type]) => type === 'enqueue').length;
assert.deepEqual(await queue.enqueueAndDelete([]), { deleted: 0, pending: 0 });
assert.equal(operations.filter(([type]) => type === 'enqueue').length, enqueuesBeforeEmpty);

const deleteHelper = server.slice(server.indexOf('async function deleteBlobs'), server.indexOf('let cachedGoogleDriveStorage'));
assert.match(deleteHelper, /filter\(isDriveFileRef\).*driveFileIdFromRef/);
assert.match(deleteHelper, /await googleDriveDeletionQueue\(\)\.enqueueAndDelete\(driveFiles\)/);
const libraryCleanup = server.slice(server.indexOf('async function deleteLibraryBlobs'), server.indexOf('// Preenche o snapshot'));
assert.match(libraryCleanup, /items\.map\(i => i\.stored_name\)\.filter\(isDriveFileRef\)/);
assert.match(libraryCleanup, /await deleteBlobs\(driveFiles\)/, 'a exclusão de item e de espaço da Biblioteca aguarda a limpeza do Drive');
assert.match(server, /CREATE TABLE IF NOT EXISTS google_drive_deletion_queue/);
const libraryDeleteStart = server.indexOf("app.delete('/api/library/:id'");
const libraryDeleteEnd = server.indexOf("app.delete('/api/library/spaces/:id'", libraryDeleteStart);
const libraryDelete = server.slice(libraryDeleteStart, libraryDeleteEnd);
assert.ok(libraryDelete.indexOf('await deleteLibraryBlobs([item])') < libraryDelete.indexOf('DELETE FROM personal_library_items'),
  'o item só é removido do banco depois de persistir a exclusão remota');
const librarySpaceDelete = server.slice(libraryDeleteEnd, server.indexOf('// Download de um item do Acervo', libraryDeleteEnd));
assert.ok(librarySpaceDelete.indexOf('await deleteLibraryBlobs(removed)') < librarySpaceDelete.indexOf('DELETE FROM personal_library_items'),
  'os itens do espaço só são removidos após persistir as exclusões remotas');
const purgeStart = server.indexOf('async function purgeExpired');
const purgeEnd = server.indexOf('// Arquivos ficam no próprio Postgres', purgeStart);
const purge = server.slice(purgeStart, purgeEnd);
assert.match(purge, /await deleteBlobs\(roomFiles\.map\(f => f\.stored_name\)\)/);
assert.ok(purge.indexOf('await deleteBlobs(roomFiles.map(f => f.stored_name))') < purge.indexOf("DELETE FROM files WHERE room_id = $1"),
  'a sala só apaga os metadados depois de guardar a referência para exclusão do Drive');
assert.match(server, /req\.path\.startsWith\('\/api\/'\)[\s\S]{0,200}retryPendingGoogleDriveDeletions\(\)/,
  'as tentativas pendentes são processadas automaticamente em requisições da aplicação');
const roomDeleteStart = server.indexOf("app.delete('/api/files/:id'");
const roomDeleteEnd = server.indexOf("app.patch('/api/files/:id'", roomDeleteStart);
assert.match(server.slice(roomDeleteStart, roomDeleteEnd), /await deleteBlobs\(\[file\.stored_name\]\)/);

const destroyStart = server.indexOf('async function destroyRoom');
const destroyEnd = server.indexOf('\n}', destroyStart) + 2;
const destroyRoom = server.slice(destroyStart, destroyEnd);
assert.ok(destroyRoom.indexOf('await deleteBlobs(roomFiles.map(f => f.stored_name))') < destroyRoom.indexOf("DELETE FROM files WHERE room_id = $1"),
  'a exclusão de sala também registra a limpeza remota antes de remover os metadados');
assert.doesNotMatch(destroyRoom, /deleteLibraryBlobs|DELETE FROM personal_library_items/,
  'excluir uma sala nunca apaga as cópias independentes da Biblioteca');

console.log('Todas as asserções de exclusão e repetição do Google Drive passaram.');