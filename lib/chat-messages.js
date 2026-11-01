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

function createChatMessageCleanup({ query, deleteBlobs, transaction, now = () => new Date().toISOString().slice(0, 19).replace('T', ' ') }) {
  if (typeof query !== 'function' || typeof deleteBlobs !== 'function') {
    throw new TypeError('A consulta ao banco e a exclusão de arquivos são obrigatórias.');
  }
  const runTransaction = typeof transaction === 'function'
    ? transaction
    : async work => work(query);

  async function removeFiles(files) {
    const unique = [...new Map((files || []).filter(file => file && file.id).map(file => [String(file.id), file])).values()];
    if (!unique.length) return { files: 0, drivePending: 0, ids: [] };

    let deletion;
    try {
      deletion = await deleteBlobs(unique.map(file => file.stored_name));
    } catch (error) {
      const wrapped = new Error('Não foi possível apagar todos os anexos do chat. As mensagens foram mantidas; tente novamente.');
      wrapped.cause = error;
      throw wrapped;
    }
    if (!deletion) throw new Error('Não foi possível confirmar a exclusão dos anexos. As mensagens foram mantidas; tente novamente.');
    if (deletion && deletion.failed) throw new Error('Não foi possível apagar todos os anexos do chat. As mensagens foram mantidas; tente novamente.');
    return { files: unique.length, drivePending: Number(deletion && deletion.pending) || 0, ids: unique.map(file => String(file.id)) };
  }

  async function clearRoomChat(roomId) {
    return runTransaction(async tx => {
      const messages = await tx('SELECT id, content FROM messages WHERE room_id = $1', [roomId]);
      const messageIds = messages.map(message => String(message.id));
      const referencedIds = [...new Set(messages.flatMap(message => attachmentIds(message.content)))];
      const files = await tx(`SELECT id, stored_name FROM files
        WHERE room_id = $1 AND (chat_only = 1 OR id = ANY($2::text[]))`, [roomId, referencedIds]);
      const deleted = await removeFiles(files);
      if (deleted.ids.length) {
        await tx('DELETE FROM file_blobs WHERE file_id = ANY($1::text[])', [deleted.ids]);
        await tx('DELETE FROM files WHERE id = ANY($1::text[])', [deleted.ids]);
      }
      const deletedMessages = await tx('DELETE FROM messages WHERE id = ANY($1::text[]) RETURNING id', [messageIds]);
      await tx('DELETE FROM room_typing WHERE room_id = $1', [roomId]);
      const { ids: _ids, ...summary } = deleted;
      return { messages: deletedMessages.length, ...summary };
    });
  }

  async function clearDirectChat(userId, friendId) {
    const conversationId = directConversationKey(userId, friendId);
    return runTransaction(async tx => {
      const messages = await tx(`SELECT id FROM direct_messages
        WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`, [String(userId), String(friendId)]);
      const messageIds = messages.map(message => String(message.id));
      const files = await tx('SELECT id, stored_name FROM files WHERE room_id = $1', [conversationId]);
      const deleted = await removeFiles(files);
      if (deleted.ids.length) {
        await tx('DELETE FROM file_blobs WHERE file_id = ANY($1::text[])', [deleted.ids]);
        await tx('DELETE FROM files WHERE id = ANY($1::text[])', [deleted.ids]);
      }
      const deletedMessages = await tx('DELETE FROM direct_messages WHERE id = ANY($1::text[]) RETURNING id', [messageIds]);
      const { ids: _ids, ...summary } = deleted;
      return { messages: deletedMessages.length, ...summary };
    });
  }

  async function purgeExpiredRows(table, rows) {
    if (!rows.length) return { messages: 0, files: 0, drivePending: 0 };
    return runTransaction(async tx => {
      const expiredIds = rows.map(row => String(row.id));
      const filesToDelete = [];
      for (const row of rows) {
        const ids = attachmentIds(row.content);
        if (ids.length) filesToDelete.push(...await tx(
          'SELECT id, stored_name FROM files WHERE room_id = $1 AND id = ANY($2::text[])', [row.room_id, ids]));
      }

      const deletedRows = table === 'messages'
        ? await tx('DELETE FROM messages WHERE id = ANY($1::text[]) RETURNING id', [expiredIds])
        : await tx('DELETE FROM direct_messages WHERE id = ANY($1::text[]) RETURNING id', [expiredIds]);

      const conversations = new Map();
      for (const row of rows) {
        const key = String(row.room_id);
        if (!conversations.has(key)) conversations.set(key, []);
      }
      const remainingReferences = new Set();
      for (const conversationId of conversations.keys()) {
        let remainingMessages;
        if (table === 'messages') {
          remainingMessages = await tx('SELECT content FROM messages WHERE room_id = $1', [conversationId]);
        } else {
          const pair = conversationId.startsWith('dm:') ? conversationId.slice(3).split(':') : [];
          if (pair.length !== 2) continue;
          remainingMessages = await tx(`SELECT content FROM direct_messages
            WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`, pair);
        }
        for (const message of remainingMessages) {
          for (const id of attachmentIds(message.content)) remainingReferences.add(id);
        }
      }

      const uniqueFiles = [...new Map(filesToDelete.map(file => [String(file.id), file])).values()];
      const unreferencedFiles = uniqueFiles.filter(file => !remainingReferences.has(String(file.id)));
      const deleted = await removeFiles(unreferencedFiles);
      if (deleted.ids.length) {
        await tx('DELETE FROM file_blobs WHERE file_id = ANY($1::text[])', [deleted.ids]);
        await tx('DELETE FROM files WHERE id = ANY($1::text[])', [deleted.ids]);
      }
      const { ids: _ids, ...summary } = deleted;
      return { messages: deletedRows.length, ...summary };
    });
  }

  async function purgeExpiredMessages(limit = 100) {
    const timestamp = now();
    const [roomMessages, directMessages] = await Promise.all([
      query(`SELECT id, room_id, content FROM messages
        WHERE expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [timestamp, limit]),
      query(`SELECT id, 'dm:' || LEAST(sender_id, recipient_id) || ':' || GREATEST(sender_id, recipient_id) AS room_id, content
        FROM direct_messages WHERE expires_at IS NOT NULL AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [timestamp, limit])
    ]);
    const rooms = await purgeExpiredRows('messages', roomMessages);
    const directs = await purgeExpiredRows('direct_messages', directMessages);
    return {
      messages: rooms.messages + directs.messages,
      files: rooms.files + directs.files,
      drivePending: rooms.drivePending + directs.drivePending
    };
  }

  return { clearRoomChat, clearDirectChat, purgeExpiredMessages };
}

module.exports = {
  DISAPPEARING_MESSAGE_DURATIONS,
  attachmentIds,
  createChatMessageCleanup,
  directConversationKey,
  expirationTimestamp
};