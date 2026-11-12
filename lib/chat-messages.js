'use strict';

const DISAPPEARING_MESSAGE_DURATIONS = Object.freeze([0, 86400, 604800, 7776000]);

function directConversationKey(userId, friendId) {
  return 'dm:' + [String(userId), String(friendId)].sort().join(':');
}

function expirationTimestamp(durationSeconds, now = Date.now()) {
  const seconds = Number(durationSeconds);
  if (!DISAPPEARING_MESSAGE_DURATIONS.includes(seconds) || seconds === 0) return null;
  return new Date(Number(now) + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function attachmentIds(content) {
  const ids = new Set();
  const pattern = /\[\[file:([^|\]\r\n]+)\|[^\]\r\n]*\]\]/g;
  for (const match of String(content || '').matchAll(pattern)) {
    const id = match[1].trim();
    if (id && id.length <= 200) ids.add(id);
  }
  return [...ids];
}

function createChatMessageCleanup({ query, queueDeletions, processQueuedDeletions, transaction, now = () => new Date().toISOString().slice(0, 19).replace('T', ' ') }) {
  if (typeof query !== 'function' || typeof queueDeletions !== 'function') {
    throw new TypeError('A consulta ao banco e o enfileiramento da exclusão de arquivos são obrigatórios.');
  }
  const runTransaction = typeof transaction === 'function' ? transaction : async work => work(query);

  // A exclusão remota (Blob/Drive) nunca roda dentro da transação: o pool do
  // Postgres tem uma única conexão e a transação já ocupa essa conexão. Aqui
  // apenas registramos a intenção de excluir usando a própria transação; o
  // processamento acontece depois do COMMIT (ou fica na fila para o cron).
  async function enqueueFiles(files, tx) {
    const unique = [...new Map((files || []).filter(file => file && file.id).map(file => [String(file.id), file])).values()];
    if (!unique.length) return { files: 0, drivePending: 0, blobPending: 0, ids: [], queuedBlobPaths: [], queuedDriveFiles: [] };
    let queued;
    try {
      queued = await queueDeletions(unique.map(file => file.stored_name), { queueQuery: tx });
    } catch (error) {
      const wrapped = new Error('Não foi possível registrar a exclusão dos anexos. As mensagens foram mantidas; tente novamente.');
      wrapped.cause = error;
      throw wrapped;
    }
    if (!queued || queued.failed) throw new Error('Não foi possível registrar a exclusão dos anexos. As mensagens foram mantidas; tente novamente.');
    return {
      files: unique.length,
      drivePending: Number(queued.drivePending) || 0,
      blobPending: Number(queued.blobPending) || 0,
      ids: unique.map(file => String(file.id)),
      queuedBlobPaths: queued.queuedBlobPaths || [],
      queuedDriveFiles: queued.queuedDriveFiles || []
    };
  }

  async function finishQueuedDeletions(result) {
    const blobPaths = result.queuedBlobPaths || [];
    const driveFiles = result.queuedDriveFiles || [];
    delete result.queuedBlobPaths;
    delete result.queuedDriveFiles;
    if (typeof processQueuedDeletions !== 'function' || (!blobPaths.length && !driveFiles.length)) return result;
    try {
      const processed = await processQueuedDeletions(blobPaths, driveFiles);
      result.blobPending = Number(processed && processed.blobPending) || 0;
      result.drivePending = Number(processed && processed.drivePending) || 0;
    } catch {
      // A fila persistida garante a nova tentativa automática; as mensagens já
      // foram removidas, então mantemos os contadores de pendências.
    }
    return result;
  }

  async function clearRoomChat(roomId) {
    const result = await runTransaction(async tx => {
      const messages = await tx('SELECT id, content FROM messages WHERE room_id = $1', [roomId]);
      const messageIds = messages.map(message => String(message.id));
      const referencedIds = [...new Set(messages.flatMap(message => attachmentIds(message.content)))];
      const files = await tx(`SELECT id, stored_name FROM files
        WHERE room_id = $1 AND (chat_only = 1 OR id = ANY($2::text[]))`, [roomId, referencedIds]);
      const deleted = await enqueueFiles(files, tx);
      if (deleted.ids.length) {
        await tx('DELETE FROM file_blobs WHERE file_id = ANY($1::text[])', [deleted.ids]);
        await tx('DELETE FROM files WHERE id = ANY($1::text[])', [deleted.ids]);
      }
      const deletedMessages = await tx('DELETE FROM messages WHERE id = ANY($1::text[]) RETURNING id', [messageIds]);
      await tx('DELETE FROM room_typing WHERE room_id = $1', [roomId]);
      const { ids: _ids, ...summary } = deleted;
      return { messages: deletedMessages.length, ...summary };
    });
    return finishQueuedDeletions(result);
  }

  async function clearDirectChat(userId, friendId) {
    const conversationId = directConversationKey(userId, friendId);
    const result = await runTransaction(async tx => {
      const messages = await tx(`SELECT id FROM direct_messages
        WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`, [String(userId), String(friendId)]);
      const messageIds = messages.map(message => String(message.id));
      const files = await tx('SELECT id, stored_name FROM files WHERE room_id = $1', [conversationId]);
      const deleted = await enqueueFiles(files, tx);
      if (deleted.ids.length) {
        await tx('DELETE FROM file_blobs WHERE file_id = ANY($1::text[])', [deleted.ids]);
        await tx('DELETE FROM files WHERE id = ANY($1::text[])', [deleted.ids]);
      }
      const deletedMessages = await tx('DELETE FROM direct_messages WHERE id = ANY($1::text[]) RETURNING id', [messageIds]);
      const { ids: _ids, ...summary } = deleted;
      return { messages: deletedMessages.length, ...summary };
    });
    return finishQueuedDeletions(result);
  }

  async function purgeExpiredRows(table, rows) {
    if (!rows.length) return { messages: 0, files: 0, drivePending: 0, blobPending: 0 };
    const result = await runTransaction(async tx => {
      const expiredIds = rows.map(row => String(row.id));
      const filesToDelete = [];
      for (const row of rows) {
        const ids = attachmentIds(row.content);
        if (ids.length) filesToDelete.push(...await tx('SELECT id, stored_name FROM files WHERE room_id = $1 AND id = ANY($2::text[])', [row.room_id, ids]));
      }
      const deletedRows = table === 'messages'
        ? await tx('DELETE FROM messages WHERE id = ANY($1::text[]) RETURNING id', [expiredIds])
        : await tx('DELETE FROM direct_messages WHERE id = ANY($1::text[]) RETURNING id', [expiredIds]);
      const conversations = new Set(rows.map(row => String(row.room_id)));
      const remainingReferences = new Set();
      for (const conversationId of conversations) {
        let remainingMessages;
        if (table === 'messages') remainingMessages = await tx('SELECT content FROM messages WHERE room_id = $1', [conversationId]);
        else {
          const pair = conversationId.startsWith('dm:') ? conversationId.slice(3).split(':') : [];
          if (pair.length !== 2) continue;
          remainingMessages = await tx(`SELECT content FROM direct_messages
            WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`, pair);
        }
        for (const message of remainingMessages) for (const id of attachmentIds(message.content)) remainingReferences.add(id);
      }
      const uniqueFiles = [...new Map(filesToDelete.map(file => [String(file.id), file])).values()];
      const deleted = await enqueueFiles(uniqueFiles.filter(file => !remainingReferences.has(String(file.id))), tx);
      if (deleted.ids.length) {
        await tx('DELETE FROM file_blobs WHERE file_id = ANY($1::text[])', [deleted.ids]);
        await tx('DELETE FROM files WHERE id = ANY($1::text[])', [deleted.ids]);
      }
      const { ids: _ids, ...summary } = deleted;
      return { messages: deletedRows.length, ...summary };
    });
    return finishQueuedDeletions(result);
  }

  async function purgeExpiredMessages(limit = 100) {
    const timestamp = now();
    const [roomMessages, directMessages] = await Promise.all([
      query(`SELECT id, room_id, content FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [timestamp, limit]),
      query(`SELECT id, 'dm:' || LEAST(sender_id, recipient_id) || ':' || GREATEST(sender_id, recipient_id) AS room_id, content FROM direct_messages WHERE expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [timestamp, limit])
    ]);
    const [rooms, directs] = await Promise.all([purgeExpiredRows('messages', roomMessages), purgeExpiredRows('direct_messages', directMessages)]);
    return {
      messages: rooms.messages + directs.messages,
      files: rooms.files + directs.files,
      drivePending: rooms.drivePending + directs.drivePending,
      blobPending: rooms.blobPending + directs.blobPending
    };
  }

  return { clearRoomChat, clearDirectChat, purgeExpiredMessages };
}

module.exports = { DISAPPEARING_MESSAGE_DURATIONS, attachmentIds, createChatMessageCleanup, directConversationKey, expirationTimestamp };
