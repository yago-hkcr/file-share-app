'use strict';

function createBlobDeletionQueue({ query, deleteBlob, now = () => new Date().toISOString().slice(0, 19).replace('T', ' '), logger = console }) {
  if (typeof query !== 'function' || typeof deleteBlob !== 'function') {
    throw new TypeError('A consulta ao banco e a exclusão de arquivos Blob são obrigatórias.');
  }

  async function process(pathnames, { logFailures = true, attemptsByPath = new Map() } = {}) {
    const uniquePaths = [...new Set((pathnames || []).filter(path => typeof path === 'string' && path))];
    let deleted = 0;
    let pending = 0;
    for (const pathname of uniquePaths) {
      try {
        await deleteBlob(pathname);
        await query('DELETE FROM blob_deletion_queue WHERE pathname = $1', [pathname]);
        deleted++;
      } catch (error) {
        if (error && (error.name === 'BlobNotFoundError' || Number(error.status || error.statusCode) === 404 || /HTTP 404/.test(String(error.message || '')))) {
          await query('DELETE FROM blob_deletion_queue WHERE pathname = $1', [pathname]);
          deleted++;
          continue;
        }
        pending++;
        const message = String(error && error.message || 'Falha ao excluir arquivo Blob.').slice(0, 500);
        const attemptAt = now();
        const attemptDate = new Date(`${String(attemptAt).replace(' ', 'T')}Z`);
        const attempts = Math.max(0, Number(attemptsByPath.get(pathname)) || 0);
        const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(attempts, 7)));
        const nextAttemptAt = new Date((Number.isFinite(attemptDate.getTime()) ? attemptDate.getTime() : Date.now()) + delaySeconds * 1000)
          .toISOString().slice(0, 19).replace('T', ' ');
        await query(`UPDATE blob_deletion_queue
          SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3
          WHERE pathname = $1`, [pathname, message, nextAttemptAt]).catch(updateError => {
          if (logFailures && logger && typeof logger.error === 'function') {
            logger.error('Falha ao atualizar a fila de exclusão do Blob:', updateError && updateError.message);
          }
        });
        if (logFailures && logger && typeof logger.error === 'function') {
          logger.error('Exclusão do Blob pendente; haverá nova tentativa automática:', message);
        }
      }
    }
    return { deleted, pending };
  }

  async function enqueueOnly(pathnames, queueQuery = query) {
    const uniquePaths = [...new Set((pathnames || []).filter(path => typeof path === 'string' && path))];
    if (!uniquePaths.length) return { pending: 0, pathnames: [] };
    const queuedAt = now();
    for (const pathname of uniquePaths) {
      await queueQuery(`INSERT INTO blob_deletion_queue (pathname, created_at, next_attempt_at)
        VALUES ($1, $2, $2) ON CONFLICT (pathname) DO NOTHING`, [pathname, queuedAt]);
    }
    return { pending: uniquePaths.length, pathnames: uniquePaths };
  }

  async function enqueueAndDelete(pathnames) {
    const queued = await enqueueOnly(pathnames);
    return process(queued.pathnames);
  }

  async function retryPending(limit = 10) {
    try {
      const rows = await query(`SELECT pathname, attempts FROM blob_deletion_queue
        WHERE next_attempt_at <= $1 ORDER BY next_attempt_at, created_at LIMIT $2`, [now(), limit]);
      return process(rows.map(row => row.pathname), { attemptsByPath: new Map(rows.map(row => [row.pathname, row.attempts])) });
    } catch (error) {
      if (logger && typeof logger.error === 'function') {
        logger.error('Falha ao processar a fila de exclusão do Blob:', error && error.message);
      }
      return { deleted: 0, pending: 0 };
    }
  }

  return { enqueueOnly, enqueueAndDelete, processQueued: process, retryPending };
}

module.exports = { createBlobDeletionQueue };
