'use strict';

function createGoogleDriveDeletionQueue({ query, getStorage, now = () => new Date().toISOString().slice(0, 19).replace('T', ' '), logger = console }) {
  if (typeof query !== 'function' || typeof getStorage !== 'function') {
    throw new TypeError('A consulta ao banco e o armazenamento do Google Drive são obrigatórios.');
  }

  async function process(fileIds, { logFailures = true, attemptsById = new Map() } = {}) {
    const uniqueIds = [...new Set((fileIds || []).filter(id => typeof id === 'string' && id))];
    if (!uniqueIds.length) return { deleted: 0, pending: 0 };

    let storage;
    let storageError = null;
    try {
      storage = await getStorage();
    } catch (error) {
      storageError = error;
    }

    let deleted = 0;
    let pending = 0;
    for (const fileId of uniqueIds) {
      try {
        if (storageError) throw storageError;
        await storage.deleteFile(fileId);
        await query('DELETE FROM google_drive_deletion_queue WHERE file_id = $1', [fileId]);
        deleted++;
      } catch (error) {
        pending++;
        const message = String(error && error.message || 'Falha ao excluir arquivo do Google Drive.').slice(0, 500);
        const attemptAt = now();
        const attemptDate = new Date(`${String(attemptAt).replace(' ', 'T')}Z`);
        const attempts = Math.max(0, Number(attemptsById.get(fileId)) || 0);
        const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(attempts, 7)));
        const nextAttemptAt = new Date((Number.isFinite(attemptDate.getTime()) ? attemptDate.getTime() : Date.now()) + delaySeconds * 1000)
          .toISOString().slice(0, 19).replace('T', ' ');
        await query(`UPDATE google_drive_deletion_queue
          SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3
          WHERE file_id = $1`, [fileId, message, nextAttemptAt]).catch(updateError => {
          if (logFailures && logger && typeof logger.error === 'function') {
            logger.error('Falha ao atualizar a fila de exclusão do Google Drive:', updateError && updateError.message);
          }
        });
        if (logFailures && logger && typeof logger.error === 'function') {
          logger.error('Exclusão do Google Drive pendente; haverá nova tentativa automática:', message);
        }
      }
    }
    return { deleted, pending };
  }

  async function enqueueAndDelete(fileIds) {
    const uniqueIds = [...new Set((fileIds || []).filter(id => typeof id === 'string' && id))];
    if (!uniqueIds.length) return { deleted: 0, pending: 0 };
    const queuedAt = now();
    for (const fileId of uniqueIds) {
      await query(`INSERT INTO google_drive_deletion_queue (file_id, created_at, next_attempt_at)
        VALUES ($1, $2, $2) ON CONFLICT (file_id) DO NOTHING`, [fileId, queuedAt]);
    }
    return process(uniqueIds);
  }

  async function retryPending(limit = 10) {
    try {
      const rows = await query(`SELECT file_id, attempts FROM google_drive_deletion_queue
        WHERE next_attempt_at <= $1 ORDER BY next_attempt_at, created_at LIMIT $2`, [now(), limit]);
      return process(rows.map(row => row.file_id), { attemptsById: new Map(rows.map(row => [row.file_id, row.attempts])) });
    } catch (error) {
      if (logger && typeof logger.error === 'function') {
        logger.error('Falha ao processar a fila de exclusão do Google Drive:', error && error.message);
      }
      return { deleted: 0, pending: 0 };
    }
  }

  return { enqueueAndDelete, retryPending };
}

module.exports = { createGoogleDriveDeletionQueue };