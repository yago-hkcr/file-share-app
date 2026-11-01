// Regressões para expiração, limpeza atômica do chat e preservação de anexos.
// Uso: node test/regression-chat-messages.mjs
import assert from 'node:assert/strict';
import {
  attachmentIds,
  createChatMessageCleanup,
  directConversationKey,
  expirationTimestamp
} from '../lib/chat-messages.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(path.join(root, 'server.js'), 'utf8');
const dashboard = readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');
const personal = readFileSync(path.join(root, 'public', 'js', 'personal.js'), 'utf8');

assert.equal(expirationTimestamp(0, 0), null);
assert.equal(expirationTimestamp(86400, 0), '1970-01-02 00:00:00');
assert.equal(expirationTimestamp(604800, 0), '1970-01-08 00:00:00');
assert.equal(expirationTimestamp(7776000, 0), '1970-04-01 00:00:00');
assert.equal(expirationTimestamp(3600, 0), null, 'rejeita uma duração não configurável');
assert.equal(directConversationKey('z', 'a'), directConversationKey('a', 'z'));
assert.deepEqual(attachmentIds('anexo [[file:a|foto.png|image/png]] e [[file:b|doc.pdf|application/pdf]] [[file:a|duplicado|x]]'), ['a', 'b']);

function createHarness({ failBlob = false, failDrive = false } = {}) {
  const state = { messages: [], directs: [], files: [], blobs: [], typing: [], queue: [] };
  const statements = [];
  const query = async (sql, params = []) => {
    statements.push({ sql, params });
    if (sql.startsWith('SELECT id, room_id, content FROM messages')) return state.messages.filter(row => row.expires_at && row.expires_at <= params[0]).slice(0, params[1]);
    if (sql.startsWith('SELECT id, content FROM messages')) return state.messages.map(({ id, content }) => ({ id, content }));
    if (sql.startsWith('SELECT id FROM direct_messages')) return state.directs.filter(row => (row.sender_id === params[0] && row.recipient_id === params[1]) || (row.sender_id === params[1] && row.recipient_id === params[0])).map(({ id }) => ({ id }));
    if (sql.startsWith('SELECT id, \'dm:\' || LEAST')) return state.directs.filter(row => row.expires_at && row.expires_at <= params[0]).slice(0, params[1]).map(row => ({ ...row, room_id: directConversationKey(row.sender_id, row.recipient_id) }));
    if (sql.startsWith('SELECT content FROM messages WHERE room_id')) return state.messages.filter(row => row.room_id === params[0]).map(({ content }) => ({ content }));
    if (sql.startsWith('SELECT content FROM direct_messages')) return state.directs.filter(row => (row.sender_id === params[0] && row.recipient_id === params[1]) || (row.sender_id === params[1] && row.recipient_id === params[0])).map(({ content }) => ({ content }));
    if (sql.startsWith('SELECT id, stored_name FROM files WHERE room_id = $1 AND id = ANY')) {
      const [roomId, attachmentIdsArg] = params;
      return state.files.filter(file => file.room_id === roomId && attachmentIdsArg.includes(file.id))
        .map(({ id, stored_name }) => ({ id, stored_name }));
    }
    if (sql.startsWith('SELECT id, stored_name FROM files')) {
      const [roomId, attachmentIdsArg] = params;
      return state.files.filter(file => file.room_id === roomId && (attachmentIdsArg
        ? (file.chat_only === 1 || attachmentIdsArg.includes(file.id))
        : true))
        .map(({ id, stored_name }) => ({ id, stored_name }));
    }
    if (sql.startsWith('DELETE FROM file_blobs')) { state.blobs = state.blobs.filter(id => !params[0].includes(id)); return []; }
    if (sql.startsWith('DELETE FROM files')) { state.files = state.files.filter(file => !params[0].includes(file.id)); return []; }
    if (sql.startsWith('DELETE FROM messages WHERE id')) { const before = state.messages.length; state.messages = state.messages.filter(row => !params[0].includes(row.id)); return Array(before - state.messages.length).fill({ id: 'deleted' }); }
    if (sql.startsWith('DELETE FROM room_typing')) { state.typing = []; return []; }
    if (sql.startsWith('DELETE FROM messages WHERE id')) { const before = state.messages.length; state.messages = state.messages.filter(row => !params[0].includes(row.id)); return Array(before - state.messages.length).fill({ id: 'deleted' }); }
    if (sql.startsWith('DELETE FROM direct_messages WHERE id')) { const before = state.directs.length; state.directs = state.directs.filter(row => !params[0].includes(row.id)); return Array(before - state.directs.length).fill({ id: 'deleted' }); }
    if (sql.startsWith('DELETE FROM direct_messages')) { const [user, friend] = params; const before = state.directs.length; state.directs = state.directs.filter(row => !((row.sender_id === user && row.recipient_id === friend) || (row.sender_id === friend && row.recipient_id === user))); return Array(before - state.directs.length).fill({ id: 'deleted' }); }
    throw new Error('Consulta de teste não reconhecida: ' + sql);
  };
  const transaction = async work => {
    const snapshot = structuredClone(state);
    try { return await work(query); }
    catch (error) { Object.assign(state, snapshot); throw error; }
  };
  const deleteBlobs = async (names, options) => {
    const paths = names.filter(name => String(name).startsWith('rooms/') || String(name).startsWith('dm/'));
    if (failBlob && paths.length) throw new Error('Blob indisponível');
    if (failDrive && names.some(name => String(name).startsWith('gdrive:'))) return { pending: 1, failed: false };
    return { pending: 0, failed: false };
  };
  const cleanup = createChatMessageCleanup({ query, transaction, deleteBlobs, now: () => '2026-01-01 00:00:00' });
  return { state, statements, cleanup: {
    ...cleanup,
    clearRoomChat: (...args) => cleanup.clearRoomChat(...args)
  } };
}

{
  const h = createHarness();
  h.state.messages = [
    { id: 'room-1', room_id: 'room', content: '[[file:attached|foto.png|image/png]]' },
    { id: 'room-2', room_id: 'room', content: 'texto' }
  ];
  h.state.files = [
    { id: 'attached', room_id: 'room', stored_name: 'rooms/photo', chat_only: 0 },
    { id: 'chat-only', room_id: 'room', stored_name: 'rooms/chat', chat_only: 1 },
    { id: 'shared', room_id: 'room', stored_name: 'rooms/shared', chat_only: 0 }
  ];
  h.state.blobs = ['attached', 'chat-only', 'shared'];
  h.state.typing = ['typing'];
  const result = await h.cleanup.clearRoomChat('room');
  assert.equal(result.messages, 2);
  assert.equal(result.files, 2);
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.state.files.map(file => file.id), ['shared'], 'preserva arquivos compartilhados que não são anexos do chat');
  assert.deepEqual(h.state.blobs, ['shared']);
  assert.deepEqual(h.state.typing, []);
}

{
  const h = createHarness();
  h.state.directs = [
    { id: 'dm-1', sender_id: 'a', recipient_id: 'b', content: 'texto' },
    { id: 'dm-2', sender_id: 'b', recipient_id: 'a', content: 'texto' },
    { id: 'dm-other', sender_id: 'a', recipient_id: 'c', content: 'texto' }
  ];
  h.state.files = [{ id: 'direct-file', room_id: directConversationKey('a', 'b'), stored_name: 'dm/file', chat_only: 1 }];
  h.state.blobs = ['direct-file'];
  const result = await h.cleanup.clearDirectChat('a', 'b');
  assert.equal(result.messages, 2, 'apaga a conversa nos dois sentidos, para ambos os participantes');
  assert.deepEqual(h.state.directs.map(row => row.id), ['dm-other']);
  assert.deepEqual(h.state.files, []);
  assert.deepEqual(h.state.blobs, []);
}

{
  const h = createHarness({ failBlob: true });
  h.state.messages = [{ id: 'keep', room_id: 'room', content: '[[file:broken|foto.png|image/png]]' }];
  h.state.files = [{ id: 'broken', room_id: 'room', stored_name: 'rooms/broken', chat_only: 1 }];
  await assert.rejects(h.cleanup.clearRoomChat('room'), /anexos do chat/);
  assert.equal(h.state.messages.length, 1, 'mantém mensagens após falha de Blob');
  assert.equal(h.state.files.length, 1, 'mantém metadados/referência para nova tentativa');
}

{
  const h = createHarness({ failDrive: true });
  h.state.messages = [{ id: 'drive-message', room_id: 'room', content: '[[file:drive-file|drive.pdf|application/pdf]]', expires_at: '2025-12-31 23:59:00' }];
  h.state.files = [{ id: 'drive-file', room_id: 'room', stored_name: 'gdrive:file', chat_only: 1 }];
  const result = await h.cleanup.purgeExpiredMessages(10);
  assert.equal(result.messages, 1);
  assert.equal(result.drivePending, 1, 'informa a exclusão pendente do Drive');
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.state.files, [], 'metadados locais são limpos após a referência ser entregue à fila do Drive');
}

{
  const h = createHarness();
  h.state.messages = [
    { id: 'expired-room', room_id: 'room', content: '[[file:shared-room-file|shared.png|image/png]]', expires_at: '2025-12-31 23:59:00' },
    { id: 'live-room', room_id: 'room', content: '[[file:shared-room-file|shared.png|image/png]]' }
  ];
  h.state.files = [{ id: 'shared-room-file', room_id: 'room', stored_name: 'rooms/shared', chat_only: 1 }];
  h.state.blobs = ['shared-room-file'];
  h.state.directs = [{ id: 'live-direct', sender_id: 'a', recipient_id: 'b', content: 'não expirada' }];
  const result = await h.cleanup.purgeExpiredMessages(10);
  assert.equal(result.messages, 1);
  assert.deepEqual(h.state.messages.map(row => row.id), ['live-room'], 'remove somente a mensagem de sala expirada');
  assert.deepEqual(h.state.files.map(file => file.id), ['shared-room-file'], 'preserva anexo referenciado por mensagem válida');
  assert.deepEqual(h.state.blobs, ['shared-room-file']);
  assert.deepEqual(h.state.directs.map(row => row.id), ['live-direct'], 'expirar mensagem de sala não apaga mensagens diretas válidas');
}

{
  const h = createHarness();
  h.state.directs = [
    { id: 'expired-direct', sender_id: 'a', recipient_id: 'b', content: '[[file:dm-expired-file|anexo.png|image/png]]', expires_at: '2025-12-31 23:59:00' },
    { id: 'live-direct', sender_id: 'b', recipient_id: 'a', content: '[[file:dm-expired-file|anexo.png|image/png]]' },
    { id: 'other-direct', sender_id: 'a', recipient_id: 'c', content: 'outra conversa' }
  ];
  h.state.files = [{ id: 'dm-expired-file', room_id: directConversationKey('a', 'b'), stored_name: 'dm/expired', chat_only: 1 }];
  h.state.blobs = ['dm-expired-file'];
  const result = await h.cleanup.purgeExpiredMessages(10);
  assert.equal(result.messages, 1);
  assert.deepEqual(h.state.directs.map(row => row.id), ['live-direct', 'other-direct'], 'remove somente a DM expirada');
  assert.deepEqual(h.state.files.map(file => file.id), ['dm-expired-file'], 'preserva anexo referenciado pela DM válida');
  assert.deepEqual(h.state.blobs, ['dm-expired-file']);
}

{
  const h = createHarness();
  h.state.directs = [
    { id: 'expired-direct', sender_id: 'a', recipient_id: 'b', content: '[[file:dm-only-expired-file|anexo.png|image/png]]', expires_at: '2025-12-31 23:59:00' },
    { id: 'live-direct', sender_id: 'b', recipient_id: 'a', content: 'mensagem sem anexo' }
  ];
  h.state.files = [{ id: 'dm-only-expired-file', room_id: directConversationKey('a', 'b'), stored_name: 'dm/only-expired', chat_only: 1 }];
  h.state.blobs = ['dm-only-expired-file'];
  const result = await h.cleanup.purgeExpiredMessages(10);
  assert.equal(result.messages, 1);
  assert.equal(result.files, 1);
  assert.deepEqual(h.state.directs.map(row => row.id), ['live-direct']);
  assert.deepEqual(h.state.files, [], 'remove metadados do anexo sem referências remanescentes');
  assert.deepEqual(h.state.blobs, []);
}

assert.match(server, /app\.delete\('\/api\/rooms\/:id\/messages', asMember/);
assert.match(server, /app\.delete\('\/api\/dm\/:id\/messages', asMember/);
assert.match(server, /if \(!\(await canUseRoom\(req\.user, room\.id\)\)\) return res\.status\(403\)/,
  'limpeza de sala valida acesso do usuário');
assert.match(server, /const friend = await directFriend\(req, res\); if \(!friend\) return;[\s\S]{0,160}clearDirectChat/,
  'limpeza de DM reutiliza verificação de amizade/autorização existente');
assert.match(dashboard, /roomExpirationSetting/);
assert.match(dashboard, /clearRoomChatBtn/);
assert.match(personal, /directExpirationSetting/);
assert.match(personal, /clearDirectChatBtn/);
assert.match(personal, /if \(dmClearingChats\.has\(id\)\) return;/,
  'polling pausa a leitura de uma conversa enquanto a limpeza está em andamento');
assert.match(personal, /dmClearingChats\.add\(friendId\)/,
  'a limpeza da DM pausa o polling da conversa');
assert.match(personal, /dmClearingChats\.delete\(friendId\)/,
  'a limpeza da DM retoma o polling depois da operação');

console.log('Todas as regressões de expiração, limpeza, anexos e autorização passaram.');