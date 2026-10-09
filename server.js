const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { neon } = require('@neondatabase/serverless');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { once } = require('events');

const IS_VERCEL = Boolean(process.env.VERCEL);

// ---------------------------------------------------------------------------
// Variáveis de ambiente (localmente lê o .env.local; na Vercel já vêm prontas)
// ---------------------------------------------------------------------------
if (!IS_VERCEL) {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}

const LOCAL_MODE = !IS_VERCEL && process.env.FILESHARE_LOCAL === '1';
const LOCAL_DATA_DIR = path.resolve(process.env.FILESHARE_DATA_DIR || path.join(__dirname, 'data', 'local'));
const LOCAL_LAN_PORT = Number(process.env.FILESHARE_LAN_PORT || Number(process.env.PORT || 3000) + 1);
let localLanServer = null;
let localLanStartPromise = null;
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (LOCAL_MODE ? crypto.randomBytes(24).toString('base64url') : '');
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!LOCAL_MODE) throw new Error('Defina SESSION_SECRET antes de iniciar o FileShare fora do modo local.');
  fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
  const secretPath = path.join(LOCAL_DATA_DIR, 'session-secret');
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

const PASSWORD_HASH_PREFIX = 'bcrypt-sha256$';
const PASSWORD_HASH_COST = 12;
const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_PASSWORD_BYTES = 4096;
const normalizePassword = value => String(value == null ? '' : value).normalize('NFKC');
function passwordMeetsPolicy(value) {
  const password = normalizePassword(value);
  const length = Array.from(password).length;
  return length >= MIN_PASSWORD_LENGTH && length <= MAX_PASSWORD_LENGTH && Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES;
}
function bcryptPasswordInput(value) {
  return crypto.createHash('sha256').update(normalizePassword(value), 'utf8').digest('base64');
}
function hashPassword(value) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(bcryptPasswordInput(value), PASSWORD_HASH_COST, (error, hash) => {
      if (error) return reject(error);
      resolve(PASSWORD_HASH_PREFIX + hash);
    });
  });
}
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(32).toString('hex'));
async function verifyPassword(value, storedHash) {
  if (typeof storedHash !== 'string') return { matches: false, needsUpgrade: false };
  if (Buffer.byteLength(String(value == null ? '' : value), 'utf8') > MAX_PASSWORD_BYTES) return { matches: false, needsUpgrade: false };
  const versioned = storedHash.startsWith(PASSWORD_HASH_PREFIX);
  const hash = versioned ? storedHash.slice(PASSWORD_HASH_PREFIX.length) : storedHash;
  if (!/^\$2[aby]\$\d{2}\$/.test(hash)) return { matches: false, needsUpgrade: false };
  const input = versioned ? bcryptPasswordInput(value) : String(value == null ? '' : value);
  const matches = await new Promise((resolve, reject) => {
    bcrypt.compare(input, hash, (error, same) => error ? reject(error) : resolve(same));
  });
  const cost = Number(hash.split('$')[2]);
  return { matches, needsUpgrade: matches && (!versioned || cost < PASSWORD_HASH_COST) };
}

// ---------------------------------------------------------------------------
// Vercel Blob (armazenamento privado dos arquivos). Na Vercel a autenticação é por OIDC
// (BLOB_STORE_ID + VERCEL_OIDC_TOKEN, injetados automaticamente). Sem essas variáveis
// (ex.: rodando local sem `vercel env pull`), cai no Postgres como antes.
// ---------------------------------------------------------------------------
const blobSdk = () => import('@vercel/blob');
const blobClientSdk = () => import('@vercel/blob/client');
const blobEnabled = () => !LOCAL_MODE && Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
const isBlobPath = name => typeof name === 'string' && name.startsWith('rooms/');
async function deleteBlobs(pathnames) {
  const list = pathnames.filter(isBlobPath);
  if (!list.length) return;
  try {
    const { del } = await blobSdk();
    await del(list);
  } catch (e) {
    console.error('Falha ao apagar do Blob:', e && e.message);
  }
}

function cleanUrl(value) {
  if (!value) return '';
  let url = String(value).trim().replace(/^(["'])(.*)\1$/, '$2');
  try {
    const u = new URL(url);
    u.searchParams.delete('channel_binding'); // o driver HTTP não usa
    return u.toString();
  } catch (e) {
    return url;
  }
}

const DATABASE_URL = cleanUrl(process.env.DATABASE_URL || process.env.POSTGRES_URL);
if (!LOCAL_MODE && !DATABASE_URL) {
  console.error('❌ DATABASE_URL não definida. Configure a integração Neon na Vercel (ou o .env.local).');
}
const sql = !LOCAL_MODE && DATABASE_URL ? neon(DATABASE_URL) : null;
let localDatabasePromise = null;

async function localDatabase() {
  if (!localDatabasePromise) {
    const moduleUrl = pathToFileURL(path.join(__dirname, 'local-runtime', 'database.mjs')).href;
    localDatabasePromise = import(moduleUrl).then(({ openLocalDatabase }) => openLocalDatabase(path.join(LOCAL_DATA_DIR, 'database')));
  }
  return localDatabasePromise;
}

function localLanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(item => item && !item.internal && item.family === 'IPv4' && !item.address.startsWith('169.254.'))
    .map(item => ({ address: item.address, url: 'http://' + item.address + ':' + LOCAL_LAN_PORT }));
}

async function startLocalLanServer() {
  if (localLanServer && localLanServer.listening) return localLanServer;
  if (!localLanStartPromise) {
    localLanStartPromise = new Promise((resolve, reject) => {
      const listener = app.listen(LOCAL_LAN_PORT, '0.0.0.0', () => {
        localLanServer = listener;
        resolve(listener);
      });
      listener.once('error', reject);
    });
  }
  try {
    return await localLanStartPromise;
  } finally {
    localLanStartPromise = null;
  }
}

async function stopLocalLanServer() {
  if (localLanStartPromise) await localLanStartPromise.catch(() => {});
  if (!localLanServer) return;
  const listener = localLanServer;
  localLanServer = null;
  await new Promise(resolve => {
    listener.close(resolve);
    if (typeof listener.closeAllConnections === 'function') listener.closeAllConnections();
  });
}

// ---------------------------------------------------------------------------
// Helpers de banco. Na Vercel usam Neon; no modo de sala usam Postgres local persistente.
// ---------------------------------------------------------------------------
async function q(text, params = []) {
  if (LOCAL_MODE) {
    const db = await localDatabase();
    const result = await db.query(text, params);
    return result.rows;
  }
  if (!sql) throw new Error('Banco de dados não configurado (DATABASE_URL ausente)');
  return sql.query(text, params);
}
async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}
const num = v => Number(v) || 0;
const ts = () => new Date().toISOString().slice(0, 19).replace('T', ' '); // UTC "YYYY-MM-DD HH:MM:SS"
const isUnique = e => e && (e.code === '23505' || /unique|duplicate/i.test(String(e.message)));

function cleanPersonalLibraryName(value) {
  return String(value || '').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function ensurePersonalLibrarySpace(userId, name, createdAt = ts()) {
  const safeName = cleanPersonalLibraryName(name).slice(0, 50) || 'Guardados';
  let space = await one('SELECT id, user_id, name, created_at FROM personal_library_spaces WHERE user_id = $1 AND LOWER(name) = LOWER($2)', [userId, safeName]);
  if (space) return space;
  try {
    space = await one(`INSERT INTO personal_library_spaces (id, user_id, name, created_at)
      VALUES ($1, $2, $3, $4) RETURNING id, user_id, name, created_at`, [uuidv4(), userId, safeName, createdAt || ts()]);
  } catch (error) {
    if (!isUnique(error)) throw error;
  }
  return space || await one('SELECT id, user_id, name, created_at FROM personal_library_spaces WHERE user_id = $1 AND LOWER(name) = LOWER($2)', [userId, safeName]);
}

async function ensurePersonalLibraryBookcase(userId, spaceId, name = 'Geral', createdAt = ts()) {
  const safeName = cleanPersonalLibraryName(name).slice(0, 50) || 'Geral';
  let bookcase = await one(`SELECT id, user_id, space_id, name, created_at FROM personal_library_bookcases
    WHERE user_id = $1 AND space_id = $2 AND LOWER(name) = LOWER($3)`, [userId, spaceId, safeName]);
  if (bookcase) return bookcase;
  try {
    bookcase = await one(`INSERT INTO personal_library_bookcases (id, user_id, space_id, name, created_at)
      VALUES ($1, $2, $3, $4, $5) RETURNING id, user_id, space_id, name, created_at`, [uuidv4(), userId, spaceId, safeName, createdAt || ts()]);
  } catch (error) {
    if (!isUnique(error)) throw error;
  }
  return bookcase || await one(`SELECT id, user_id, space_id, name, created_at FROM personal_library_bookcases
    WHERE user_id = $1 AND space_id = $2 AND LOWER(name) = LOWER($3)`, [userId, spaceId, safeName]);
}

async function migratePersonalLibraryHierarchy() {
  const legacy = await q(`SELECT user_id, name, created_at FROM personal_library_shelves WHERE TRIM(name) <> ''
    UNION SELECT user_id, COALESCE(NULLIF(TRIM(shelf), ''), 'Guardados') AS name, created_at FROM personal_library_items`);
  for (const row of legacy) {
    const space = await ensurePersonalLibrarySpace(row.user_id, row.name, row.created_at);
    await ensurePersonalLibraryBookcase(row.user_id, space.id, 'Geral', row.created_at);
  }
  const oldItems = await q(`SELECT id, user_id, COALESCE(NULLIF(TRIM(shelf), ''), 'Guardados') AS legacy_space, created_at
    FROM personal_library_items WHERE space_id IS NULL OR bookcase_id IS NULL`);
  for (const item of oldItems) {
    const space = await ensurePersonalLibrarySpace(item.user_id, item.legacy_space, item.created_at);
    const bookcase = await ensurePersonalLibraryBookcase(item.user_id, space.id, 'Geral', item.created_at);
    await q(`UPDATE personal_library_items SET space_id = $1, bookcase_id = $2, shelf = 'Geral'
      WHERE id = $3 AND user_id = $4 AND (space_id IS NULL OR bookcase_id IS NULL)`, [space.id, bookcase.id, item.id, item.user_id]);
  }
}

async function resolvePersonalLibraryLocation(userId, body = {}) {
  const spaceId = String(body.space_id || '').trim();
  const bookcaseId = String(body.bookcase_id || '').trim();
  if (!spaceId && !bookcaseId) {
    const legacyName = cleanPersonalLibraryName(body.shelf).slice(0, 50) || 'Guardados';
    const space = await ensurePersonalLibrarySpace(userId, legacyName);
    const bookcase = await ensurePersonalLibraryBookcase(userId, space.id);
    return { space, bookcase };
  }
  if (spaceId && bookcaseId) {
    const bookcase = await one(`SELECT b.id, b.user_id, b.space_id, b.name, b.created_at
      FROM personal_library_bookcases b JOIN personal_library_spaces s ON s.id = b.space_id
      WHERE b.id = $1 AND b.space_id = $2 AND b.user_id = $3 AND s.user_id = $3`, [bookcaseId, spaceId, userId]);
    if (!bookcase) return null;
    const space = await one('SELECT id, user_id, name, created_at FROM personal_library_spaces WHERE id = $1 AND user_id = $2', [spaceId, userId]);
    return space ? { space, bookcase } : null;
  }
  if (spaceId) {
    const space = await one('SELECT id, user_id, name, created_at FROM personal_library_spaces WHERE id = $1 AND user_id = $2', [spaceId, userId]);
    if (!space) return null;
    return { space, bookcase: await ensurePersonalLibraryBookcase(userId, spaceId) };
  }
  const bookcase = await one(`SELECT b.id, b.user_id, b.space_id, b.name, b.created_at FROM personal_library_bookcases b
    JOIN personal_library_spaces s ON s.id = b.space_id WHERE b.id = $1 AND b.user_id = $2 AND s.user_id = $2`, [bookcaseId, userId]);
  if (!bookcase) return null;
  const space = await one('SELECT id, user_id, name, created_at FROM personal_library_spaces WHERE id = $1 AND user_id = $2', [bookcase.space_id, userId]);
  return space ? { space, bookcase } : null;
}

// ---------------------------------------------------------------------------
// Acervo: copias independentes (snapshot). Cada item guardado tem seus proprios
// bytes (Blob privado ou file_blobs), entao excluir a sala NAO apaga o Acervo.
// ---------------------------------------------------------------------------
const LIBRARY_BLOB_PREFIX = 'library/';
const isLibraryBlobPath = name => typeof name === 'string' && name.startsWith(LIBRARY_BLOB_PREFIX);

// Le os bytes de um arquivo de sala (Blob privado ou Postgres) para copiar ao Acervo.
async function readRoomFileBytes(file) {
  if (!file) return null;
  if (isBlobPath(file.stored_name)) {
    const { get } = await blobSdk();
    const stored = await get(file.stored_name, { access: 'private' });
    if (!stored || !stored.stream) return null;
    const chunks = [];
    for await (const part of Readable.fromWeb(stored.stream)) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    return Buffer.concat(chunks);
  }
  const row = await one("SELECT encode(data, 'base64') AS data FROM file_blobs WHERE file_id = $1", [file.id]);
  return row && row.data ? Buffer.from(row.data, 'base64') : null;
}

async function writeLibraryBlob(libraryItemId, buffer) {
  if (blobEnabled()) {
    const { put } = await blobSdk();
    const storedName = `${LIBRARY_BLOB_PREFIX}${libraryItemId}`;
    await put(storedName, buffer, { access: 'private', contentType: 'application/octet-stream', addRandomSuffix: false, allowOverwrite: true });
    return storedName;
  }
  await q("INSERT INTO personal_library_blobs (item_id, data) VALUES ($1, decode($2, 'hex')) ON CONFLICT (item_id) DO UPDATE SET data = decode($2, 'hex')", [libraryItemId, buffer.toString('hex')]);
  return libraryItemId;
}

async function readLibraryBlob(item) {
  if (!item) return null;
  if (isLibraryBlobPath(item.stored_name)) {
    const { get } = await blobSdk();
    const stored = await get(item.stored_name, { access: 'private' });
    if (!stored || !stored.stream) return null;
    const chunks = [];
    for await (const part of Readable.fromWeb(stored.stream)) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    return Buffer.concat(chunks);
  }
  const row = await one("SELECT encode(data, 'base64') AS data FROM personal_library_blobs WHERE item_id = $1", [item.id]);
  return row && row.data ? Buffer.from(row.data, 'base64') : null;
}

async function deleteLibraryBlobs(items) {
  const blobPaths = items.map(i => i.stored_name).filter(isLibraryBlobPath);
  if (blobPaths.length) await deleteBlobs(blobPaths);
  const ids = items.map(i => i.id).filter(Boolean);
  for (const id of ids) await q('DELETE FROM personal_library_blobs WHERE item_id = $1', [id]);
}

// Preenche o snapshot de itens antigos que ainda apontam para files (migracao).
async function backfillLibrarySnapshot(item) {
  if (!item || item.snapshot_ready) return item;
  const file = await one('SELECT id, original_name, size, mime_type, stored_name FROM files WHERE id = $1', [item.file_id]);
  if (!file) return item; // sala ja excluida e sem copia: mantem metadados, sem download
  const bytes = await readRoomFileBytes(file);
  if (!bytes) return item;
  const storedName = await writeLibraryBlob(item.id, bytes);
  await q(`UPDATE personal_library_items
    SET original_name = $1, size = $2, mime_type = $3, stored_name = $4, room_name = COALESCE(NULLIF(room_name, ''), $5),
      uploader_name = COALESCE(NULLIF(uploader_name, ''), $6), snapshot_ready = 1, updated_at = $7
    WHERE id = $8`, [file.original_name, file.size, file.mime_type, storedName, item.room_name || '', item.uploader_name || '', ts(), item.id]);
  return (await one('SELECT * FROM personal_library_items WHERE id = $1', [item.id])) || item;
}

let initPromise = null;
function ensureDatabase() {
  if (!initPromise) {
    initPromise = initDatabase().catch(err => {
      initPromise = null; // não guarda falha: a próxima requisição tenta de novo
      throw err;
    });
  }
  return initPromise;
}

async function createTables() {
  await Promise.all([
    q(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_change_required INTEGER DEFAULT 0,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'pending',
      avatar_color TEXT DEFAULT '#4f46e5',
      created_at TEXT
    )`),
    q(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      slug TEXT UNIQUE NOT NULL,
      is_public INTEGER DEFAULT 0,
      max_members INTEGER DEFAULT 50,
      created_by TEXT,
      created_at TEXT
    )`),
    q(`CREATE TABLE IF NOT EXISTS room_members (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at TEXT,
      UNIQUE(room_id, user_id)
    )`),
    q(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      uploaded_by TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      size BIGINT NOT NULL,
      mime_type TEXT DEFAULT 'application/octet-stream',
      uploaded_at TEXT
    )`),
    q(`CREATE TABLE IF NOT EXISTS file_blobs (
      file_id TEXT PRIMARY KEY,
      data BYTEA NOT NULL
    )`),
    q(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to_id TEXT,
      created_at TEXT
    )`),
    q(`CREATE TABLE IF NOT EXISTS direct_messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to_id TEXT,
      created_at TEXT NOT NULL
    )`),
    q(`CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      theme TEXT DEFAULT 'system',
      compact_mode INTEGER DEFAULT 0,
      reduced_motion INTEGER DEFAULT 0,
      refresh_seconds INTEGER DEFAULT 2,
      browser_notifications INTEGER DEFAULT 0
    )`),
    q(`CREATE TABLE IF NOT EXISTS personal_library_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      shelf TEXT NOT NULL DEFAULT 'Guardados',
      note TEXT NOT NULL DEFAULT '',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, file_id)
    )`),
    q(`CREATE TABLE IF NOT EXISTS personal_library_shelves (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, name)
    )`),
    q(`CREATE TABLE IF NOT EXISTS personal_library_spaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    q(`CREATE TABLE IF NOT EXISTS personal_library_bookcases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    q(`CREATE TABLE IF NOT EXISTS room_typing (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(room_id, user_id)
    )`),
    q(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      "read" INTEGER DEFAULT 0,
      created_at TEXT
    )`)
  ]);
  await q('CREATE INDEX IF NOT EXISTS idx_personal_library_user_updated ON personal_library_items (user_id, updated_at)');
  await q('CREATE INDEX IF NOT EXISTS idx_personal_library_file ON personal_library_items (file_id)');
  await q(`CREATE TABLE IF NOT EXISTS personal_library_blobs (
    item_id TEXT PRIMARY KEY,
    data BYTEA NOT NULL
  )`);
  // Snapshot: copia independente do arquivo no Acervo (sobrevive a exclusao da sala).
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS original_name TEXT');
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS size BIGINT');
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS mime_type TEXT');
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS stored_name TEXT');
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS room_name TEXT');
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS uploader_name TEXT');
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS snapshot_ready INTEGER DEFAULT 0');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_library_shelves_user_name ON personal_library_shelves (user_id, LOWER(name))');
  await q('CREATE INDEX IF NOT EXISTS idx_personal_library_shelves_user_created ON personal_library_shelves (user_id, created_at)');
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS space_id TEXT');
  await q('ALTER TABLE personal_library_items ADD COLUMN IF NOT EXISTS bookcase_id TEXT');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_library_spaces_user_name ON personal_library_spaces (user_id, LOWER(name))');
  await q('CREATE INDEX IF NOT EXISTS idx_personal_library_spaces_user_created ON personal_library_spaces (user_id, created_at)');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_library_bookcases_location_name ON personal_library_bookcases (user_id, space_id, LOWER(name))');
  await q('CREATE INDEX IF NOT EXISTS idx_personal_library_bookcases_space ON personal_library_bookcases (user_id, space_id, created_at)');
  await migratePersonalLibraryHierarchy();
  await q('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS expires_at TEXT');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_change_required INTEGER DEFAULT 0');
  await q(`CREATE TABLE IF NOT EXISTS file_collections (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, room_id TEXT NOT NULL, title TEXT NOT NULL,
    single_link INTEGER DEFAULT 0,
    exclusive_access INTEGER DEFAULT 0,
    instructions TEXT DEFAULT '', expires_at TEXT NOT NULL, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
  )`);
  await q('ALTER TABLE file_collections ADD COLUMN IF NOT EXISTS single_link INTEGER DEFAULT 0');
  await q('ALTER TABLE file_collections ADD COLUMN IF NOT EXISTS exclusive_access INTEGER DEFAULT 0');
  await q('ALTER TABLE file_collections ADD COLUMN IF NOT EXISTS multi_use_link INTEGER DEFAULT 0');
  await q('ALTER TABLE file_collections ADD COLUMN IF NOT EXISTS history_cleared_at TEXT');
  await q(`CREATE TABLE IF NOT EXISTS file_collection_items (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, label TEXT NOT NULL, required INTEGER DEFAULT 1, quantity INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0
  )`);
  await q('ALTER TABLE file_collection_items ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0');
  await q('ALTER TABLE file_collection_items ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1');
  await q(`CREATE TABLE IF NOT EXISTS file_collection_recipients (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, participant_name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending', created_at TEXT NOT NULL, submitted_at TEXT, revoked_at TEXT, submission_started_at TEXT,
    closed_at TEXT, closed_reason TEXT, access_session_hash TEXT, access_lease_until TEXT
  )`);
  await q('ALTER TABLE file_collection_recipients ADD COLUMN IF NOT EXISTS submission_started_at TEXT');
  await q('ALTER TABLE file_collection_recipients ADD COLUMN IF NOT EXISTS closed_at TEXT');
  await q('ALTER TABLE file_collection_recipients ADD COLUMN IF NOT EXISTS closed_reason TEXT');
  await q('ALTER TABLE file_collection_recipients ADD COLUMN IF NOT EXISTS access_session_hash TEXT');
  await q('ALTER TABLE file_collection_recipients ADD COLUMN IF NOT EXISTS access_lease_until TEXT');
  await q(`UPDATE file_collection_recipients SET closed_at = submitted_at, closed_reason = 'submitted'
    WHERE status = 'submitted' AND closed_at IS NULL`);
  await q(`UPDATE file_collection_recipients SET closed_at = revoked_at, closed_reason = 'suspended'
    WHERE status = 'revoked' AND closed_at IS NULL`);
  await q(`CREATE TABLE IF NOT EXISTS file_collection_closed_tokens (
    token_hash TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, closed_reason TEXT NOT NULL, closed_at TEXT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS file_collection_uploads (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, recipient_id TEXT NOT NULL, item_id TEXT NOT NULL,
    original_name TEXT NOT NULL, stored_name TEXT NOT NULL, size BIGINT NOT NULL,
    mime_type TEXT DEFAULT 'application/octet-stream', status TEXT DEFAULT 'uploading', uploaded_at TEXT, submission_id TEXT, upload_session_hash TEXT
  )`);
  await q('ALTER TABLE file_collection_uploads ADD COLUMN IF NOT EXISTS submission_id TEXT');
  await q('ALTER TABLE file_collection_uploads ADD COLUMN IF NOT EXISTS upload_session_hash TEXT');
  await q(`CREATE TABLE IF NOT EXISTS file_collection_submissions (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, recipient_id TEXT NOT NULL, sender_name TEXT NOT NULL, submitted_at TEXT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS file_collection_upload_blobs (
    upload_id TEXT PRIMARY KEY, data BYTEA NOT NULL
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_file_collections_owner_created ON file_collections (owner_id, created_at)');
  await q('CREATE INDEX IF NOT EXISTS idx_file_collection_items_collection ON file_collection_items (collection_id)');
  await q('CREATE INDEX IF NOT EXISTS idx_file_collection_recipients_collection ON file_collection_recipients (collection_id)');
  await q('CREATE INDEX IF NOT EXISTS idx_file_collection_uploads_recipient ON file_collection_uploads (recipient_id, status)');
  await q('CREATE INDEX IF NOT EXISTS idx_file_collection_uploads_submission ON file_collection_uploads (submission_id)');
  await q('CREATE INDEX IF NOT EXISTS idx_file_collection_submissions_collection ON file_collection_submissions (collection_id, submitted_at)');
  for (const col of ['last_login', 'last_seen', 'last_ip', 'force_logout_at', 'avatar_image']) await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} TEXT`);
  await q('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT');
  await q('CREATE INDEX IF NOT EXISTS idx_dm_pair_created ON direct_messages (sender_id, recipient_id, created_at)');
  await q('CREATE INDEX IF NOT EXISTS idx_dm_recipient_created ON direct_messages (recipient_id, sender_id, created_at)');
  await q(`CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY, user_id TEXT, username TEXT, role TEXT, action TEXT NOT NULL, detail TEXT, ip TEXT, user_agent TEXT, created_at TEXT
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at)');
  await q('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_seen INTEGER DEFAULT 0');
  const onboardingMigration = await one("SELECT value FROM settings WHERE key = 'onboarding_migration_v1'");
  if (!onboardingMigration) {
    await q("UPDATE users SET onboarding_seen = 1 WHERE onboarding_seen = 0 OR onboarding_seen IS NULL");
    await q("INSERT INTO settings (key, value) VALUES ('onboarding_migration_v1', '1') ON CONFLICT (key) DO UPDATE SET value = '1'");
  }
  await q(`CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, addressee_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, accepted_at TEXT
  )`);
  try { await q('CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_pair ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))'); } catch (e) { console.error('idx_friend_pair:', e && e.message); }
  await q(`CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT,
    expires_at TEXT NOT NULL,
    user_agent TEXT
  )`);
  await q(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket_hash TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL,
    window_started_at TEXT NOT NULL,
    blocked_until TEXT
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_window ON auth_rate_limits (window_started_at)');
}

async function initDatabase() {
  try {
    await createTables();
  } catch (e) {
    // Duas cold starts criando tabelas ao mesmo tempo podem colidir no catálogo do Postgres
    await new Promise(r => setTimeout(r, 300));
    await createTables();
  }
  const admin = await one("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (!admin) {
    if (!INITIAL_ADMIN_PASSWORD) throw new Error('Defina ADMIN_PASSWORD antes de criar a conta administrativa inicial.');
    if (!passwordMeetsPolicy(INITIAL_ADMIN_PASSWORD)) throw new Error(`A senha inicial do administrador precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    const hash = await hashPassword(INITIAL_ADMIN_PASSWORD);
    await q(`INSERT INTO users (id, username, email, password_hash, role, status, avatar_color, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [uuidv4(), 'admin', 'admin@fileshare.com', hash, 'admin', 'approved', '#ef4444', ts()]);
    console.log(LOCAL_MODE ? '✅ Administrador local criado.' : '✅ Admin criado');
    if (LOCAL_MODE) console.log('🔐 Acesso inicial: admin / ' + INITIAL_ADMIN_PASSWORD + ' — altere a senha após entrar.');
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', IS_VERCEL ? 1 : false);

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SESSION_COOKIE = IS_VERCEL ? '__Host-fileshare_session' : 'fileshare_session';
const REMEMBER_COOKIE = IS_VERCEL ? '__Host-fs_remember' : 'fs_remember';
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://cdn.jsdelivr.net https://esm.sh https://vercel.com https://*.blob.vercel-storage.com",
  "frame-src 'self' blob:",
  "worker-src 'self' blob: https://cdn.jsdelivr.net"
].join('; ') + (IS_VERCEL ? '; upgrade-insecure-requests' : '');
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || ['/admin', '/dashboard', '/change-password'].includes(req.path) || req.path.startsWith('/sala/') || req.path.startsWith('/enviar/')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (IS_VERCEL && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '220kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb', parameterLimit: 100 }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon-48.png')));
app.use(cookieSession({
  name: SESSION_COOKIE,
  keys: [sessionSecret()],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
  httpOnly: true,
  secure: IS_VERCEL,
  sameSite: 'lax'
}));
app.use(wrap(async (req, res, next) => { await ensureDatabase(); next(); }));

// ===== Login persistente ("lembrar de mim") =====
// Além do cookie de sessão, guardamos um token de 30 dias no navegador; só o hash dele fica no banco.
const REMEMBER_DAYS = 30;
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; } }
  }
  return '';
}
function remCookieOpts(maxAgeMs) {
  return { httpOnly: true, secure: IS_VERCEL, sameSite: 'lax', path: '/', maxAge: maxAgeMs };
}
async function issueRememberToken(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + REMEMBER_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await q('INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5)', [hashToken(token), userId, ts(), exp, String(req.headers['user-agent'] || '').slice(0, 200)]);
  res.cookie(REMEMBER_COOKIE, token, remCookieOpts(REMEMBER_DAYS * 86400000));
}
app.use(wrap(async (req, res, next) => {
  if (req.method === 'GET' && /\.(css|js|png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(req.path)) return next();
  if (req.session && req.session.userId) return next();
  const token = readCookie(req, REMEMBER_COOKIE);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    try {
      const row = await one('SELECT a.user_id, a.created_at, a.expires_at, u.username, u.role, u.status FROM auth_tokens a JOIN users u ON u.id = a.user_id WHERE a.token_hash = $1', [hashToken(token)]);
      const issuedAt = row && Date.parse(String(row.created_at || '').replace(' ', 'T') + 'Z');
      const rememberIsFresh = Number.isFinite(issuedAt) && Date.now() - issuedAt < REMEMBER_DAYS * 86400000;
      if (row && row.expires_at > ts() && rememberIsFresh && row.status !== 'rejected' && row.status !== 'banned') {
        req.session.at = Date.now();
        req.session.userId = row.user_id; req.session.username = row.username; req.session.role = row.role; req.session.status = row.status;
      } else {
        if (row) await q('DELETE FROM auth_tokens WHERE token_hash = $1', [hashToken(token)]);
        res.clearCookie(REMEMBER_COOKIE, { path: '/' });
      }
    } catch (e) { console.error('remember:', e && e.message); }
  }
  next();
}));

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site') return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  const origin = req.get('origin');
  if (origin) {
    try {
      const expected = new URL(`${req.protocol}://${req.get('host')}`).origin;
      if (new URL(origin).origin !== expected) return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
    } catch (error) {
      return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
    }
    return next();
  }
  if (fetchSite !== 'same-origin') return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  next();
});

// Salas temporárias: apaga a sala, arquivos e mensagens quando o tempo acaba
let lastPurge = 0;
async function purgeExpired() {
  if (Date.now() - lastPurge < 3000) return;
  lastPurge = Date.now();
  const old = await q('SELECT id FROM rooms WHERE expires_at IS NOT NULL AND expires_at <= $1', [ts()]);
  for (const r of old) {
    await removeRoomCollections(r.id);
    const roomFiles = await q('SELECT stored_name FROM files WHERE room_id = $1', [r.id]);
    try { await deleteBlobs(roomFiles.map(f => f.stored_name)); } catch (e) { console.error('purge blobs:', e && e.message); }
    await q('DELETE FROM file_blobs WHERE file_id IN (SELECT id FROM files WHERE room_id = $1)', [r.id]);
    // Acervo e independente (snapshot): sala expirada NAO apaga o Acervo.
    await q('DELETE FROM files WHERE room_id = $1', [r.id]);
    await q('DELETE FROM room_members WHERE room_id = $1', [r.id]);
    await q('DELETE FROM messages WHERE room_id = $1', [r.id]);
    await q('DELETE FROM rooms WHERE id = $1', [r.id]);
  }
}
app.use(wrap(async (req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/sala/')) { try { await purgeExpired(); } catch (e) { console.error('purge:', e && e.message); } } next(); }));

// Arquivos ficam no próprio Postgres. Na Vercel o corpo da requisição é limitado a ~4,5 MB.
const MAX_FILE_BYTES = IS_VERCEL ? 4 * 1024 * 1024 : 50 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
const collectionUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
const libraryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 5 } });

// ---------------------------------------------------------------------------
// Autenticação (sempre confere o usuário no banco — nada depende só do cookie)
// ---------------------------------------------------------------------------
const requireAuth = wrap(async (req, res, next) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Não autorizado' });
  const user = await one('SELECT id, username, role, status, last_seen, force_logout_at, password_change_required FROM users WHERE id = $1', [req.session.userId]);
  if (!user) { req.session = null; return res.status(401).json({ error: 'Não autorizado' }); }
  if (user.status === 'banned' || user.status === 'rejected' || (user.force_logout_at && Number(req.session.at || 0) <= Number(user.force_logout_at))) {
    req.session = null; res.clearCookie(REMEMBER_COOKIE, { path: '/' });
    return res.status(401).json({ error: user.status === 'banned' ? 'Conta suspensa' : user.status === 'rejected' ? 'Conta sem acesso' : 'Sessão encerrada pelo administrador' });
  }
  if (Number(user.password_change_required) && !['/api/change-password', '/api/logout'].includes(req.path)) {
    return res.status(428).json({ state: 'password_change_required', error: 'Atualize sua senha para continuar.' });
  }
  if (!user.last_seen || user.last_seen < agoTs(45000)) { q('UPDATE users SET last_seen = $1 WHERE id = $2', [ts(), user.id]).catch(() => {}); }
  req.user = user;
  next();
});
const isAdmin = u => u.role === 'admin';
const isApproved = u => u.status === 'approved' || u.role === 'admin';
function requireApproved(req, res, next) {
  if (isApproved(req.user)) return next();
  res.status(403).json({ error: 'Conta aguardando aprovação' });
}
function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  res.status(403).json({ error: 'Acesso restrito ao administrador' });
}
const asAdmin = [requireAuth, requireAdmin];
const asMember = [requireAuth, requireApproved];

async function isRoomMember(roomId, userId) {
  return !!(await one('SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]));
}
async function canUseRoom(user, roomId) {
  return isAdmin(user) || isRoomMember(roomId, user.id);
}

const COLLECTION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_COLLECTION_ITEMS = 30;
const MAX_COLLECTION_RECIPIENTS = 100;
const MAX_COLLECTION_UPLOADS = 200;
const MAX_COLLECTION_NAME_BYTES = 255;
const COLLECTION_ACCESS_COOKIE = 'fs_collection_access';
const COLLECTION_ACCESS_LEASE_MS = 2 * 60 * 1000;
const COLLECTION_SESSION_COOKIE_MS = 30 * 24 * 60 * 60 * 1000;
const COLLECTION_UPLOAD_STALE_MS = 90 * 1000;
const makeCollectionToken = () => crypto.randomBytes(32).toString('base64url');
const cleanCollectionFileName = value => String(value || 'arquivo').replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_COLLECTION_NAME_BYTES) || 'arquivo';
const collectionLeaseUntil = () => new Date(Date.now() + COLLECTION_ACCESS_LEASE_MS).toISOString().slice(0, 19).replace('T', ' ');
const collectionCookieOptions = token => ({ httpOnly: true, secure: IS_VERCEL, sameSite: 'lax', path: `/api/coletas/enviar/${encodeURIComponent(token)}`, maxAge: COLLECTION_ACCESS_LEASE_MS });
function clearCollectionAccessCookie(res, token) {
  res.clearCookie(COLLECTION_ACCESS_COOKIE, { ...collectionCookieOptions(token), maxAge: undefined });
}

async function reserveExclusiveCollectionAccess(recipient, req, res, token) {
  const now = ts();
  const browserSession = readCookie(req, COLLECTION_ACCESS_COOKIE);
  const browserSessionHash = browserSession ? hashToken(browserSession) : '';
  if (browserSessionHash && browserSessionHash === recipient.access_session_hash && recipient.access_lease_until > now) {
    if (recipient.access_lease_until <= new Date(Date.now() + COLLECTION_ACCESS_LEASE_MS / 2).toISOString().slice(0, 19).replace('T', ' ')) {
      const renewed = await q(`UPDATE file_collection_recipients SET access_lease_until = $1
        WHERE id = $2 AND access_session_hash = $3 AND access_lease_until > $4 RETURNING id`, [collectionLeaseUntil(), recipient.id, browserSessionHash, now]);
      if (!renewed.length) return false;
    }
    res.cookie(COLLECTION_ACCESS_COOKIE, browserSession, collectionCookieOptions(token));
    req.collectionAccessSessionHash = browserSessionHash;
    return true;
  }

  if (browserSessionHash && browserSessionHash === recipient.access_session_hash) {
    const renewed = await q(`UPDATE file_collection_recipients SET access_lease_until = $1
      WHERE id = $2 AND access_session_hash = $3 AND access_lease_until <= $4
        AND status IN ('pending','uploading','submitting') RETURNING id`, [collectionLeaseUntil(), recipient.id, browserSessionHash, now]);
    if (renewed.length) {
      res.cookie(COLLECTION_ACCESS_COOKIE, browserSession, collectionCookieOptions(token));
      req.collectionAccessSessionHash = browserSessionHash;
      return true;
    }
  }

  const previousSessionHash = recipient.access_session_hash;
  const newSession = crypto.randomBytes(32).toString('hex');
  const claimed = await q(`UPDATE file_collection_recipients SET access_session_hash = $1, access_lease_until = $2
    WHERE id = $3 AND (access_session_hash IS NULL OR access_lease_until IS NULL OR access_lease_until <= $4)
      AND status IN ('pending','uploading','submitting') RETURNING id`, [hashToken(newSession), collectionLeaseUntil(), recipient.id, now]);
  if (!claimed.length) return false;
  res.cookie(COLLECTION_ACCESS_COOKIE, newSession, collectionCookieOptions(token));
  req.collectionAccessSessionHash = hashToken(newSession);
  if (previousSessionHash && previousSessionHash !== req.collectionAccessSessionHash) {
    const abandoned = await q(`SELECT id, stored_name FROM file_collection_uploads
      WHERE recipient_id = $1 AND submission_id IS NULL AND upload_session_hash = $2`, [recipient.id, previousSessionHash]);
    for (const upload of abandoned) await removeCollectionUpload(upload).catch(error => console.error('Limpeza de envio abandonado:', error && error.message));
    await q(`UPDATE file_collection_recipients SET status = 'pending'
      WHERE id = $1 AND status = 'uploading' AND token_hash = $2
        AND NOT EXISTS (SELECT 1 FROM file_collection_uploads WHERE recipient_id = $1 AND status = 'uploading')`, [recipient.id, recipient.token_hash]);
  }
  return true;
}

function reserveCollectionSession(req, res, token) {
  const existing = readCookie(req, COLLECTION_ACCESS_COOKIE);
  const browserSession = /^[a-f0-9]{64}$/i.test(String(existing || '')) ? existing : crypto.randomBytes(32).toString('hex');
  res.cookie(COLLECTION_ACCESS_COOKIE, browserSession, {
    httpOnly: true, secure: IS_VERCEL, sameSite: 'lax',
    path: `/api/coletas/enviar/${encodeURIComponent(token)}`, maxAge: COLLECTION_SESSION_COOKIE_MS
  });
  req.collectionAccessSessionHash = hashToken(browserSession);
}

async function getCollectionRecipient(token) {
  if (!COLLECTION_TOKEN_RE.test(String(token || ''))) return null;
  return one(`SELECT cr.id, cr.collection_id, cr.participant_name, cr.token_hash, cr.status AS recipient_status, cr.submission_started_at,
      cr.access_session_hash, cr.access_lease_until,
      cr.closed_at, cr.closed_reason,
      fc.owner_id, fc.room_id, fc.title, fc.instructions, fc.single_link, fc.exclusive_access, fc.multi_use_link, fc.expires_at, fc.status AS collection_status, dest_room.expires_at AS room_expires_at
    FROM file_collection_recipients cr JOIN file_collections fc ON fc.id = cr.collection_id
    JOIN rooms dest_room ON dest_room.id = fc.room_id
    WHERE cr.token_hash = $1`, [hashToken(token)]);
}

function collectionAccessError(row, res) {
  if (!row) return res.status(404).json({ state: 'invalid', error: 'Este link de envio não é válido.' });
  if (row.recipient_status === 'submitted') return res.status(410).json({ state: 'submitted', error: 'Envio concluído: seus arquivos foram recebidos e este link foi encerrado.' });
  if (row.recipient_status === 'revoked') return res.status(410).json({ state: 'suspended', error: 'Envio suspenso pelo organizador. Este link foi encerrado e não aceita novos arquivos.' });
  if (row.recipient_status === 'expired' || row.expires_at <= ts() || (row.room_expires_at && row.room_expires_at <= ts())) return res.status(410).json({ state: 'expired', error: 'Prazo não cumprido: o prazo terminou antes da confirmação do envio.' });
  if (row.collection_status !== 'active') return res.status(410).json({ state: 'suspended', error: 'Coleta suspensa pelo organizador. Este link foi encerrado e não aceita novos arquivos.' });
  if (!['pending', 'uploading', 'submitting'].includes(row.recipient_status)) return res.status(410).json({ state: 'closed', error: 'Este link foi encerrado e não aceita novos arquivos.' });
  return null;
}

async function requireCollectionOwner(collectionId, userId) {
  return one('SELECT id, room_id, owner_id, title, status, expires_at, single_link, multi_use_link FROM file_collections WHERE id = $1 AND owner_id = $2', [collectionId, userId]);
}

async function removeCollectionUpload(upload) {
  if (!upload) return;
  if (isBlobPath(upload.stored_name)) await deleteBlobs([upload.stored_name]);
  await q('DELETE FROM file_collection_upload_blobs WHERE upload_id = $1', [upload.id]);
  await q('DELETE FROM file_collection_uploads WHERE id = $1', [upload.id]);
}

async function removeStaleCollectionUpload(upload, staleBefore) {
  if (!upload) return false;
  const removed = await q(`DELETE FROM file_collection_uploads
    WHERE id = $1 AND status = 'uploading' AND (uploaded_at IS NULL OR uploaded_at <= $2)
    RETURNING id, stored_name`, [upload.id, staleBefore]);
  if (!removed.length) return false;
  if (isBlobPath(removed[0].stored_name)) {
    await deleteBlobs([removed[0].stored_name]).catch(error => console.error('Limpeza de upload abandonado:', error && error.message));
  }
  await q('DELETE FROM file_collection_upload_blobs WHERE upload_id = $1', [removed[0].id]);
  return true;
}

async function recoverStaleCollectionUploadState(recipientId, tokenHash = null) {
  const staleBefore = agoTs(COLLECTION_UPLOAD_STALE_MS);
  const active = await q("SELECT id, stored_name, uploaded_at FROM file_collection_uploads WHERE recipient_id = $1 AND status = 'uploading'", [recipientId]);
  const stale = active.filter(upload => !upload.uploaded_at || upload.uploaded_at <= staleBefore);
  for (const upload of stale) await removeStaleCollectionUpload(upload, staleBefore);
  const stillUploading = await one("SELECT id FROM file_collection_uploads WHERE recipient_id = $1 AND status = 'uploading' LIMIT 1", [recipientId]);
  if (active.length > 0 && !stillUploading) {
    await q(`UPDATE file_collection_recipients SET status = 'pending'
      WHERE id = $1 AND status = 'uploading' AND ($2::TEXT IS NULL OR token_hash = $2)`, [recipientId, tokenHash]);
  }
}

async function removeRecipientCollectionUploads(recipientId) {
  const uploads = await q('SELECT id, stored_name FROM file_collection_uploads WHERE recipient_id = $1 AND submission_id IS NULL', [recipientId]);
  for (const upload of uploads) await removeCollectionUpload(upload);
}

async function expireCollectionRecipientIfNeeded(recipient, token) {
  if (!recipient || ['submitted', 'revoked', 'expired'].includes(recipient.recipient_status)) return recipient;
  const deadlines = [recipient.expires_at, recipient.room_expires_at].filter(Boolean).sort();
  const deadline = deadlines[0];
  if (!deadline || deadline > ts()) return recipient;
  const changed = await q(`UPDATE file_collection_recipients
    SET status = 'expired', closed_at = $1, closed_reason = 'deadline', submission_started_at = NULL,
      access_session_hash = NULL, access_lease_until = NULL
    WHERE id = $2 AND token_hash = $3 AND status IN ('pending','uploading','submitting','deleting')
    RETURNING id`, [deadline, recipient.id, hashToken(token)]);
  if (changed.length) await removeRecipientCollectionUploads(recipient.id);
  return getCollectionRecipient(token);
}

async function sendCollectionClosedError(token, res, fallback = 'Este link foi encerrado e não aceita novos envios.') {
  let recipient = await getCollectionRecipient(token);
  if (!recipient && COLLECTION_TOKEN_RE.test(String(token || ''))) {
    const closed = await one('SELECT closed_reason FROM file_collection_closed_tokens WHERE token_hash = $1', [hashToken(token)]);
    if (closed && closed.closed_reason === 'replaced') return res.status(410).json({ state: 'replaced', error: 'Link substituído pelo organizador. Peça o link mais recente para enviar.' });
  }
  recipient = await expireCollectionRecipientIfNeeded(recipient, token);
  const accessError = collectionAccessError(recipient, res);
  if (accessError) return accessError;
  return res.status(410).json({ state: 'closed', error: fallback });
}

async function removeRoomCollections(roomId) {
  const staged = await q(`SELECT u.id, u.stored_name FROM file_collection_uploads u
    JOIN file_collection_recipients cr ON cr.id = u.recipient_id
    JOIN file_collections fc ON fc.id = cr.collection_id
    WHERE fc.room_id = $1 AND cr.status <> 'submitted'`, [roomId]);
  for (const upload of staged) await removeCollectionUpload(upload);
  await q('DELETE FROM file_collection_upload_blobs WHERE upload_id IN (SELECT u.id FROM file_collection_uploads u JOIN file_collections fc ON fc.id = u.collection_id WHERE fc.room_id = $1)', [roomId]);
  await q('DELETE FROM file_collection_uploads WHERE collection_id IN (SELECT id FROM file_collections WHERE room_id = $1)', [roomId]);
  await q('DELETE FROM file_collection_submissions WHERE collection_id IN (SELECT id FROM file_collections WHERE room_id = $1)', [roomId]);
  await q('DELETE FROM file_collection_recipients WHERE collection_id IN (SELECT id FROM file_collections WHERE room_id = $1)', [roomId]);
  await q('DELETE FROM file_collection_items WHERE collection_id IN (SELECT id FROM file_collections WHERE room_id = $1)', [roomId]);
  await q('DELETE FROM file_collections WHERE room_id = $1', [roomId]);
}

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();
function updateZipCrc(crc, chunk) {
  for (const byte of chunk) crc = ZIP_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}
function zipDosDateTime(value) {
  const date = value ? new Date(String(value).replace(' ', 'T') + 'Z') : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    time: (valid.getUTCHours() << 11) | (valid.getUTCMinutes() << 5) | Math.floor(valid.getUTCSeconds() / 2),
    date: ((Math.max(1980, valid.getUTCFullYear()) - 1980) << 9) | ((valid.getUTCMonth() + 1) << 5) | valid.getUTCDate()
  };
}
function writeZipChunk(res, chunk) {
  if (res.destroyed) return Promise.reject(new Error('Download encerrado pelo cliente'));
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.removeListener('drain', onDrain); res.removeListener('close', onClose); res.removeListener('error', onError); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Download encerrado pelo cliente')); };
    const onError = error => { cleanup(); reject(error); };
    res.once('drain', onDrain); res.once('close', onClose); res.once('error', onError);
  });
}
async function streamCollectionZip(res, rows, title) {
  const usedNames = new Map(), usedParticipants = new Map(), participantFolders = new Map();
  const entries = rows.map(row => {
    const participantLabel = String(row.participant_name || 'Participante').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'Participante';
    const recipientId = String(row.recipient_id || participantLabel);
    let participant = participantFolders.get(recipientId);
    if (!participant) {
      const participantKey = participantLabel.toLowerCase();
      const participantCount = (usedParticipants.get(participantKey) || 0) + 1;
      usedParticipants.set(participantKey, participantCount);
      participant = participantCount === 1 ? participantLabel : `${participantLabel} (${participantCount})`;
      participantFolders.set(recipientId, participant);
    }
    const original = cleanCollectionFileName(row.original_name);
    const key = participant.toLowerCase() + '/' + original.toLowerCase();
    const count = (usedNames.get(key) || 0) + 1; usedNames.set(key, count);
    const dot = original.lastIndexOf('.');
    const fileName = count === 1 ? original : (dot > 0 ? original.slice(0, dot) + ' (' + count + ')' + original.slice(dot) : original + ' (' + count + ')');
    const name = Buffer.from(participant + '/' + fileName, 'utf8');
    return { ...row, size: num(row.size), name };
  });
  const totalSize = entries.reduce((sum, entry) => sum + entry.size + 92 + entry.name.length * 2, 22);
  const zip64TotalSize = totalSize + entries.length * 56 + 76;
  if (!Number.isSafeInteger(totalSize) || !Number.isSafeInteger(zip64TotalSize)) throw Object.assign(new Error('Esta coleta excede o limite de tamanho de um arquivo ZIP.'), { status: 413 });
  const zip64 = entries.length > 65535 || zip64TotalSize > 0xffffffff || entries.some(entry => entry.size > 0xffffffff);

  const centralEntries = [];
  let position = 0;
  for (const entry of entries) {
    const date = zipDosDateTime(entry.uploaded_at);
    const localOffset = position;
    const localExtraLength = zip64 ? 20 : 0;
    const local = Buffer.alloc(30 + entry.name.length + localExtraLength);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(zip64 ? 45 : 20, 4); local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(date.time, 10); local.writeUInt16LE(date.date, 12);
    local.writeUInt32LE(0, 14); local.writeUInt32LE(zip64 ? 0xffffffff : 0, 18); local.writeUInt32LE(zip64 ? 0xffffffff : 0, 22);
    local.writeUInt16LE(entry.name.length, 26); local.writeUInt16LE(localExtraLength, 28); entry.name.copy(local, 30);
    if (zip64) { local.writeUInt16LE(1, 30 + entry.name.length); local.writeUInt16LE(16, 32 + entry.name.length); local.writeBigUInt64LE(0n, 34 + entry.name.length); local.writeBigUInt64LE(0n, 42 + entry.name.length); }
    await writeZipChunk(res, local); position += local.length;

    let crc = 0xffffffff, size = 0;
    let source;
    if (isBlobPath(entry.stored_name)) {
      const { get } = await blobSdk();
      const stored = await get(entry.stored_name, { access: 'private' });
      if (!stored || !stored.stream) throw new Error('Um dos arquivos da coleta não está disponível.');
      source = Readable.fromWeb(stored.stream);
    } else {
      const stored = await one("SELECT encode(data, 'base64') AS data FROM file_blobs WHERE file_id = $1", [entry.id]);
      if (!stored) throw new Error('Um dos arquivos da coleta não está disponível.');
      source = Readable.from([Buffer.from(stored.data, 'base64')]);
    }
    for await (const part of source) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length; position += chunk.length; crc = updateZipCrc(crc, chunk);
      if (size > entry.size) throw new Error('Um arquivo da coleta excedeu o tamanho registrado.');
      await writeZipChunk(res, chunk);
    }
    if (size !== entry.size) throw new Error('Um arquivo da coleta chegou incompleto.');
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
    if (zip64) { descriptor.writeBigUInt64LE(BigInt(size), 8); descriptor.writeBigUInt64LE(BigInt(size), 16); }
    else { descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); }
    await writeZipChunk(res, descriptor); position += descriptor.length;

    const centralExtraLength = zip64 ? 28 : 0;
    const central = Buffer.alloc(46 + entry.name.length + centralExtraLength);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(zip64 ? 45 : 20, 4); central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(0x0808, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(date.time, 12); central.writeUInt16LE(date.date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(zip64 ? 0xffffffff : size, 20); central.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
    central.writeUInt16LE(entry.name.length, 28); central.writeUInt16LE(centralExtraLength, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(zip64 ? 0xffffffff : localOffset, 42);
    entry.name.copy(central, 46);
    if (zip64) {
      const extraOffset = 46 + entry.name.length;
      central.writeUInt16LE(1, extraOffset); central.writeUInt16LE(24, extraOffset + 2);
      central.writeBigUInt64LE(BigInt(size), extraOffset + 4); central.writeBigUInt64LE(BigInt(size), extraOffset + 12);
      central.writeBigUInt64LE(BigInt(localOffset), extraOffset + 20);
    }
    centralEntries.push(central);
  }

  const centralOffset = position;
  for (const central of centralEntries) { await writeZipChunk(res, central); position += central.length; }
  const centralSize = position - centralOffset;
  if (zip64) {
    const zip64Offset = position;
    const zip64End = Buffer.alloc(56);
    zip64End.writeUInt32LE(0x06064b50, 0); zip64End.writeBigUInt64LE(44n, 4);
    zip64End.writeUInt16LE(45, 12); zip64End.writeUInt16LE(45, 14); zip64End.writeUInt32LE(0, 16); zip64End.writeUInt32LE(0, 20);
    zip64End.writeBigUInt64LE(BigInt(centralEntries.length), 24); zip64End.writeBigUInt64LE(BigInt(centralEntries.length), 32);
    zip64End.writeBigUInt64LE(BigInt(centralSize), 40); zip64End.writeBigUInt64LE(BigInt(centralOffset), 48);
    await writeZipChunk(res, zip64End); position += zip64End.length;
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeUInt32LE(0, 4); locator.writeBigUInt64LE(BigInt(zip64Offset), 8); locator.writeUInt32LE(1, 16);
    await writeZipChunk(res, locator);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16); end.writeUInt16LE(0, 20);
    await writeZipChunk(res, end);
  } else {
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(centralEntries.length, 8); end.writeUInt16LE(centralEntries.length, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20);
    await writeZipChunk(res, end);
  }
  res.end();
  await once(res, 'finish');
}


async function generateSlug(name) {
  let slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'sala';
  if (await one('SELECT id FROM rooms WHERE slug = $1', [slug])) slug += '-' + Date.now().toString(36);
  return slug;
}

function notify(userId, title, message, type) {
  return q('INSERT INTO notifications (id, user_id, title, message, type, "read", created_at) VALUES ($1,$2,$3,$4,$5,0,$6)',
    [uuidv4(), userId, title, message, type, ts()]);
}


// =================== ADMIN+: log de atividade, configurações, segurança ===================
const agoTs = ms => new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
const clientIp = req => String(req.ip || req.socket && req.socket.remoteAddress || 'unknown').slice(0, 64);
async function logAct(req, action, detail, who) {
  try {
    const u = who || req.user || {};
    await q('INSERT INTO activity_log (id, user_id, username, role, action, detail, ip, user_agent, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [uuidv4(), u.id || null, u.username || null, u.role || null, action, String(detail || '').slice(0, 300), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 160), ts()]);
    if (Math.random() < 0.02) await q('DELETE FROM activity_log WHERE created_at < $1', [agoTs(30 * 86400000)]);
  } catch (e) { console.error('log:', e && e.message); }
}
const settingsCache = { at: 0, map: {} };
async function getSetting(key, def) {
  if (Date.now() - settingsCache.at > 8000) {
    try { const rows = await q('SELECT key, value FROM settings'); settingsCache.map = Object.fromEntries(rows.map(r => [r.key, r.value])); settingsCache.at = Date.now(); } catch (e) {}
  }
  return settingsCache.map[key] !== undefined ? settingsCache.map[key] : def;
}
async function setSetting(key, value) {
  await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(value)]);
  settingsCache.at = 0;
}
// Limitação compartilhada no banco para funcionar entre instâncias serverless.
async function consumeRateLimit(key, maxAttempts, windowMs, cooldownMs = windowMs) {
  const now = ts();
  const resetBefore = new Date(Date.now() - windowMs).toISOString().slice(0, 19).replace('T', ' ');
  const blockedUntil = new Date(Date.now() + cooldownMs).toISOString().slice(0, 19).replace('T', ' ');
  const bucketHash = hashToken('rate-limit:' + key);
  const row = await one(`INSERT INTO auth_rate_limits (bucket_hash, attempt_count, window_started_at, blocked_until)
      VALUES ($1, 1, $2, NULL)
      ON CONFLICT (bucket_hash) DO UPDATE SET
        attempt_count = CASE
          WHEN auth_rate_limits.blocked_until > $2 THEN auth_rate_limits.attempt_count
          WHEN auth_rate_limits.window_started_at <= $3 THEN 1
          ELSE auth_rate_limits.attempt_count + 1 END,
        window_started_at = CASE
          WHEN auth_rate_limits.blocked_until > $2 THEN auth_rate_limits.window_started_at
          WHEN auth_rate_limits.window_started_at <= $3 THEN $2
          ELSE auth_rate_limits.window_started_at END,
        blocked_until = CASE
          WHEN auth_rate_limits.blocked_until > $2 THEN auth_rate_limits.blocked_until
          WHEN auth_rate_limits.window_started_at <= $3 THEN NULL
          WHEN auth_rate_limits.attempt_count + 1 >= $4 THEN $5
          ELSE NULL END
      RETURNING attempt_count, blocked_until`, [bucketHash, now, resetBefore, maxAttempts, blockedUntil]);
  if (Math.random() < 0.02) {
    q('DELETE FROM auth_rate_limits WHERE window_started_at <= $1 AND (blocked_until IS NULL OR blocked_until <= $2)', [agoTs(48 * 60 * 60 * 1000), now]).catch(() => {});
  }
  return !!(row && row.blocked_until && row.blocked_until > now);
}
function rateLimitHash(key) { return hashToken('rate-limit:' + key); }
async function clearLoginRateLimits(ipKey, accountKey) {
  await q('DELETE FROM auth_rate_limits WHERE bucket_hash = $1 OR bucket_hash = $2', [rateLimitHash(ipKey), rateLimitHash(accountKey)]);
}
// Registra ações de usuários (uploads, salas, arquivos) antes de responder — seguro em serverless
function classifyAct(req) {
  const p = req.path, m = req.method;
  let r;
  if (m === 'POST' && p === '/api/rooms') return [(req.body && req.body.type === 'private') ? 'sala_privada_criada' : 'sala_criada', req.body && req.body.name];
  if (m === 'POST' && /^\/api\/rooms\/[^/]+\/files$/.test(p)) return ['upload', (req.files || []).map(f => f.originalname).join(', ') || 'arquivo'];
  if (m === 'POST' && /^\/api\/rooms\/[^/]+\/files\/register$/.test(p)) return ['upload', (req.body && (req.body.name || req.body.original_name)) || 'arquivo'];
  if (m === 'DELETE' && /^\/api\/files\/[^/]+$/.test(p)) return ['arquivo_excluido', req.logDetail || p.split('/').pop().slice(0, 8)];
  if (m === 'PATCH' && /^\/api\/files\/[^/]+$/.test(p)) return ['arquivo_renomeado', (req.body && req.body.name) || ''];
  if (m === 'POST' && /^\/api\/rooms\/[^/]+\/join$/.test(p)) return ['entrou_sala', req.params && req.params.id];
  if (m === 'POST' && /^\/api\/rooms\/[^/]+\/leave$/.test(p)) return ['saiu_sala', ''];
  if (m === 'POST' && p === '/api/change-password') return ['senha_alterada', ''];
  return null;
}
app.use((req, res, next) => {
  if (req.method === 'GET' || !req.path.startsWith('/api/') || req.path.startsWith('/api/admin/')) return next();
  const orig = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode < 400 && req.user) {
      const a = classifyAct(req);
      if (a) { logAct(req, a[0], a[1]).finally(() => orig(body)); return res; }
    }
    return orig(body);
  };
  next();
});

// =================== PÁGINAS ===================
const page = name => path.join(__dirname, 'public', name);

// Endpoint simples para monitoramento: só responde depois que o banco foi inicializado.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.get('/', wrap(async (req, res) => {
  if (req.session && req.session.userId) {
    const user = await one('SELECT role FROM users WHERE id = $1', [req.session.userId]);
    if (user) return res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
    req.session = null;
  }
  res.sendFile(page('index.html'));
}));
app.get('/register', (req, res) => res.sendFile(page('register.html')));
app.get('/admin', wrap(async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  const user = await one('SELECT role, status, password_change_required, force_logout_at FROM users WHERE id = $1', [req.session.userId]);
  if (!user || user.status === 'banned' || user.status === 'rejected' || (user.force_logout_at && Number(req.session.at || 0) <= Number(user.force_logout_at))) { req.session = null; return res.redirect('/'); }
  if (Number(user.password_change_required)) return res.redirect('/change-password');
  if (!user || user.role !== 'admin') return res.redirect('/');
  res.sendFile(page('admin.html'));
}));
app.get('/dashboard', wrap(async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  const user = await one('SELECT role, status, password_change_required, force_logout_at FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.redirect('/');
  if (user.status === 'banned' || user.status === 'rejected' || (user.force_logout_at && Number(req.session.at || 0) <= Number(user.force_logout_at))) { req.session = null; return res.redirect('/'); }
  if (Number(user.password_change_required)) return res.redirect('/change-password');
  if (!isApproved(user)) return res.sendFile(page('pending.html'));
  res.sendFile(page('dashboard.html'));
}));
app.get('/change-password', wrap(async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  const user = await one('SELECT role, status, password_change_required, force_logout_at FROM users WHERE id = $1', [req.session.userId]);
  if (!user || user.status === 'banned' || user.status === 'rejected' || (user.force_logout_at && Number(req.session.at || 0) <= Number(user.force_logout_at))) { req.session = null; res.clearCookie(REMEMBER_COOKIE, { path: '/' }); return res.redirect('/'); }
  if (!Number(user.password_change_required)) return res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
  res.set('Cache-Control', 'no-store');
  res.sendFile(page('change-password.html'));
}));
app.get('/enviar/:token', (req, res) => {
  if (!COLLECTION_TOKEN_RE.test(String(req.params.token || ''))) return res.status(404).send('Link de envio inválido');
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  res.sendFile(page('coleta.html'));
});
app.get('/sala/:slug', wrap(async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  const user = await one('SELECT id, role, status, password_change_required FROM users WHERE id = $1', [req.session.userId]);
  if (!user || !isApproved(user)) return res.redirect('/dashboard');
  if (Number(user.password_change_required)) return res.redirect('/change-password');
  const room = await one('SELECT id FROM rooms WHERE slug = $1', [req.params.slug]);
  if (!room) return res.status(404).send('Sala não encontrada');
  if (!(await canUseRoom(user, room.id))) return res.status(403).send('Entre na sala para acessar seus arquivos');
  res.sendFile(page('sala.html'));
}));

// =================== AUTH API ===================
app.post('/api/register', wrap(async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (await consumeRateLimit('register-ip:' + clientIp(req), 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'Muitas tentativas de cadastro. Tente novamente mais tarde.' });
  if (!username || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (username.length < 3 || username.length > 60 || email.length > 254) return res.status(400).json({ error: 'Confira o tamanho do nome e do email.' });
  const regMode = await getSetting('registration_mode', 'approval');
  if (regMode === 'closed') return res.status(403).json({ error: 'Os cadastros estão fechados no momento.' });
  if (!passwordMeetsPolicy(password)) return res.status(400).json({ error: `Use uma senha com pelo menos ${MIN_PASSWORD_LENGTH} caracteres (até ${MAX_PASSWORD_LENGTH}).` });
  if (await one('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email])) return res.status(400).json({ error: 'Não foi possível criar a conta com esses dados.' });

  const colors = ['#4f46e5', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
  try {
    await q('INSERT INTO users (id, username, email, password_hash, avatar_color, created_at, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [uuidv4(), username, email, await hashPassword(password), colors[Math.floor(Math.random() * colors.length)], ts(), regMode === 'auto' ? 'approved' : 'pending']);
    await logAct(req, 'cadastro', username, { username });
  } catch (e) {
    if (isUnique(e)) return res.status(400).json({ error: 'Não foi possível criar a conta com esses dados.' });
    throw e;
  }
  const admins = await q("SELECT id FROM users WHERE role = 'admin'");
  await Promise.all(admins.map(a => notify(a.id, 'Novo cadastro', `${username} solicitou acesso ao sistema.`, 'warning')));
  res.json({ success: true, message: regMode === 'auto' ? 'Conta criada! Você já pode entrar.' : 'Conta criada! Aguarde aprovação do administrador.' });
}));

app.post('/api/login', wrap(async (req, res) => {
  const body = req.body || {};
  const identifier = String(body.username || '').trim().slice(0, 254);
  const password = String(body.password || '');
  const ipKey = 'login-ip:' + clientIp(req);
  const accountKey = 'login-account:' + identifier.toLocaleLowerCase();
  if (await consumeRateLimit(ipKey, 60, 15 * 60 * 1000)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde e tente novamente.' });
  if (await consumeRateLimit(accountKey, 8, 15 * 60 * 1000)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde e tente novamente.' });
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return res.status(401).json({ error: 'Credenciais inválidas' });
  const user = await one('SELECT id, username, email, password_hash, role, status, password_change_required FROM users WHERE username = $1 OR email = $2', [identifier, identifier.toLowerCase()]);
  const verification = await verifyPassword(password, user ? user.password_hash : await DUMMY_PASSWORD_HASH);
  if (!verification.matches) {
    await logAct(req, 'login_falhou', identifier.slice(0, 60), { username: user ? user.username : null, id: user ? user.id : null, role: user ? user.role : null });
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  if (user.status === 'rejected') return res.status(403).json({ error: 'Sua conta foi rejeitada pelo administrador' });
  if (user.status === 'banned') { await logAct(req, 'login_bloqueado', 'conta suspensa', user); return res.status(403).json({ error: 'Sua conta está suspensa. Fale com o administrador.' }); }
  if (verification.needsUpgrade) {
    const upgradedHash = await hashPassword(password);
    await q('UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3', [upgradedHash, user.id, user.password_hash]);
  }
  const passwordChangeRequired = Number(user.password_change_required) === 1;
  await clearLoginRateLimits(ipKey, accountKey);
  await q('UPDATE users SET last_login = $1, last_seen = $1, last_ip = $2 WHERE id = $3', [ts(), clientIp(req), user.id]);
  await logAct(req, 'login', '', user);
  req.session.at = Date.now();
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.status = user.status;
  req.session.passwordChangeRequired = passwordChangeRequired;
  try { await issueRememberToken(req, res, user.id); } catch (e) { console.error('issue token:', e && e.message); }
  res.json({ success: true, role: user.role, status: user.status, password_change_required: passwordChangeRequired });
}));

app.post('/api/logout', wrap(async (req, res) => {
  if (req.session && req.session.userId) { const lu = await one('SELECT id, username, role FROM users WHERE id = $1', [req.session.userId]); if (lu) await logAct(req, 'logout', '', lu); }
  const token = readCookie(req, REMEMBER_COOKIE);
  if (token) { try { await q('DELETE FROM auth_tokens WHERE token_hash = $1', [hashToken(token)]); } catch (e) {} }
  res.clearCookie(REMEMBER_COOKIE, { path: '/' });
  req.session = null;
  res.json({ success: true });
}));

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const user = await one('SELECT id, username, email, role, status, avatar_color, avatar_image, created_at, onboarding_seen FROM users WHERE id = $1', [req.user.id]);
  const unread = await one('SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND "read" = 0', [req.user.id]);
  res.json({ ...user, unread_notifications: num(unread && unread.count), max_upload_bytes: blobEnabled() ? MAX_BLOB_UPLOAD_BYTES : MAX_FILE_BYTES });
}));
app.post('/api/onboarding/complete', requireAuth, wrap(async (req, res) => {
  await q('UPDATE users SET onboarding_seen = 1 WHERE id = $1', [req.user.id]);
  res.json({ success: true });
}));

app.get('/api/preferences', requireAuth, wrap(async (req, res) => {
  const row = await one('SELECT theme, compact_mode, reduced_motion, refresh_seconds, browser_notifications FROM user_preferences WHERE user_id = $1', [req.user.id]);
  res.json({ has_preferences: !!row, theme: row && ['system', 'light', 'dark'].includes(row.theme) ? row.theme : 'system', compact_mode: num(row && row.compact_mode) === 1, reduced_motion: num(row && row.reduced_motion) === 1, refresh_seconds: [2, 5, 10].includes(num(row && row.refresh_seconds)) ? num(row.refresh_seconds) : 2, browser_notifications: num(row && row.browser_notifications) === 1 });
}));

app.put('/api/preferences', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const theme = ['system', 'light', 'dark'].includes(b.theme) ? b.theme : 'system';
  const compact = b.compact_mode ? 1 : 0, reduced = b.reduced_motion ? 1 : 0;
  const refresh = [2, 5, 10].includes(Number(b.refresh_seconds)) ? Number(b.refresh_seconds) : 2;
  const notifications = b.browser_notifications ? 1 : 0;
  await q(`INSERT INTO user_preferences (user_id, theme, compact_mode, reduced_motion, refresh_seconds, browser_notifications)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme, compact_mode = EXCLUDED.compact_mode,
    reduced_motion = EXCLUDED.reduced_motion, refresh_seconds = EXCLUDED.refresh_seconds, browser_notifications = EXCLUDED.browser_notifications`,
    [req.user.id, theme, compact, reduced, refresh, notifications]);
  res.json({ success: true, theme, compact_mode: !!compact, reduced_motion: !!reduced, refresh_seconds: refresh, browser_notifications: !!notifications });
}));

app.put('/api/profile/avatar', requireAuth, wrap(async (req, res) => {
  const image = req.body && req.body.image;
  if (image !== null && image !== '' && (typeof image !== 'string' || image.length > 140000 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/i.test(image))) {
    return res.status(400).json({ error: 'Use uma imagem JPG, PNG ou WebP de até 100 KB.' });
  }
  if (typeof image === 'string' && image && Buffer.byteLength(image.slice(image.indexOf(',') + 1), 'base64') > 100 * 1024) {
    return res.status(400).json({ error: 'A foto precisa ter até 100 KB depois da redução.' });
  }
  await q('UPDATE users SET avatar_image = $1 WHERE id = $2', [image || null, req.user.id]);
  res.json({ success: true, avatar_image: image || null });
}));

// =================== ADMIN: USUÁRIOS ===================
app.get('/api/admin/users', asAdmin, wrap(async (req, res) => {
  res.json(await q(`SELECT id, username, email, role, status, avatar_color, avatar_image, created_at FROM users
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC`));
}));

app.post('/api/admin/users/:id/approve', asAdmin, wrap(async (req, res) => {
  const user = await one('SELECT id, username FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  await q("UPDATE users SET status = 'approved' WHERE id = $1", [user.id]);
  await logAct(req, 'usuario_aprovado', user.username);
  await notify(user.id, 'Conta aprovada!', 'Sua conta foi aprovada pelo administrador. Bem-vindo ao FileShare!', 'success');
  res.json({ success: true });
}));

app.post('/api/admin/users/:id/reject', asAdmin, wrap(async (req, res) => {
  const user = await one('SELECT id, username FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  await q("UPDATE users SET status = 'rejected' WHERE id = $1", [user.id]);
  await logAct(req, 'usuario_rejeitado', user.username);
  await notify(user.id, 'Conta rejeitada', 'Sua solicitação de acesso foi negada.', 'error');
  res.json({ success: true });
}));

app.delete('/api/admin/users/:id', asAdmin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  const victim = await one('SELECT username FROM users WHERE id = $1', [req.params.id]);
  await logAct(req, 'usuario_excluido', victim ? victim.username : req.params.id);
  await q('DELETE FROM auth_tokens WHERE user_id = $1', [req.params.id]);
  await q('DELETE FROM friendships WHERE requester_id = $1 OR addressee_id = $1', [req.params.id]);
  await q('DELETE FROM room_members WHERE user_id = $1', [req.params.id]);
  await q('DELETE FROM notifications WHERE user_id = $1', [req.params.id]);
  const userItems = await q('SELECT id, stored_name FROM personal_library_items WHERE user_id = $1', [req.params.id]);
  await deleteLibraryBlobs(userItems);
  await q('DELETE FROM personal_library_items WHERE user_id = $1', [req.params.id]);
  await q('DELETE FROM messages WHERE user_id = $1', [req.params.id]);
  await q('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

// =================== SALAS ===================
app.post('/api/rooms', asMember, wrap(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const admin = isAdmin(req.user);
  let description = String((req.body && req.body.description) || '').slice(0, 300);
  let isPublic = req.body.is_public === true || req.body.is_public === 'true' || req.body.is_public === 1 || req.body.is_public === 'on' ? 1 : 0;
  let expiresAt = null;
  const minutes = Number(req.body.duration_minutes) || 0;
  const wantsPrivate = !admin && req.body && req.body.type === 'private';
  if (wantsPrivate) {
    // Usuário comum: sala privada (sem prazo), até 5 por usuário
    const mine = num((await one('SELECT COUNT(*) AS c FROM rooms WHERE created_by = $1 AND is_public = 0', [req.user.id])).c);
    if (mine >= MAX_PRIVATE_ROOMS) return res.status(429).json({ error: `Você já tem ${MAX_PRIVATE_ROOMS} salas privadas. Exclua uma para criar outra.` });
    isPublic = 0;
  } else if (!admin) {
    // Usuário comum: sala pública e temporária (5, 10 ou 30 min)
    if (![5, 10, 30].includes(minutes)) return res.status(400).json({ error: 'Escolha 5, 10 ou 30 minutos' });
    const active = num((await one('SELECT COUNT(*) AS c FROM rooms WHERE created_by = $1 AND expires_at IS NOT NULL AND expires_at > $2', [req.user.id, ts()])).c);
    if (active >= 3) return res.status(429).json({ error: 'Você já tem 3 salas temporárias ativas' });
    isPublic = 1;
  }
  if (!wantsPrivate && minutes && [5, 10, 30].includes(minutes)) expiresAt = new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const id = uuidv4();
  let slug = await generateSlug(name);
  for (let attempt = 0; ; attempt++) {
    try {
      await q('INSERT INTO rooms (id, name, description, slug, is_public, max_members, created_by, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,50,$6,$7,$8)',
        [id, name, description, slug, isPublic, req.user.id, ts(), expiresAt]);
      break;
    } catch (e) {
      if (isUnique(e) && attempt < 3) { slug = slug.replace(/-[a-z0-9]+$/, '') + '-' + Math.random().toString(36).slice(2, 7); continue; }
      throw e;
    }
  }
  if (!admin) await q('INSERT INTO room_members (id, room_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [uuidv4(), id, req.user.id, wantsPrivate ? 'owner' : 'member', ts()]);
  res.json(await one('SELECT * FROM rooms WHERE id = $1', [id]));
}));

// Lista salas visíveis para o usuário com arquivos e membros, em 3 consultas no total
async function loadRooms(user) {
  const cond = isAdmin(user) ? '1=1' : '(is_public = 1 OR id IN (SELECT room_id FROM room_members WHERE user_id = $1))';
  const params = isAdmin(user) ? [] : [user.id];
  const fileParams = [...params, user.id];
  const libraryUserParam = '$' + fileParams.length;
  const [rooms, files, members] = await Promise.all([
    q(`SELECT * FROM rooms WHERE ${cond} ORDER BY created_at DESC`, params),
    q(`SELECT f.id, f.room_id, f.uploaded_by, f.original_name, f.size, f.mime_type, f.uploaded_at, u.username AS uploader, u.role AS uploader_role,
          COALESCE(cs.sender_name, CASE WHEN cr.status = 'submitted' THEN cr.participant_name ELSE NULL END) AS collection_sender,
          CASE WHEN cu.submission_id IS NOT NULL OR cr.status = 'submitted' THEN cr.id ELSE NULL END AS collection_recipient_id,
          CASE WHEN cu.submission_id IS NOT NULL OR cr.status = 'submitted' THEN fc.id ELSE NULL END AS collection_id,
          CASE WHEN EXISTS (SELECT 1 FROM personal_library_items pli WHERE pli.user_id = ${libraryUserParam} AND pli.file_id = f.id) THEN 1 ELSE 0 END AS in_library
       FROM files f LEFT JOIN users u ON f.uploaded_by = u.id
       LEFT JOIN file_collection_uploads cu ON cu.id = f.id AND cu.status = 'ready'
       LEFT JOIN file_collection_recipients cr ON cr.id = cu.recipient_id
       LEFT JOIN file_collection_submissions cs ON cs.id = cu.submission_id
       LEFT JOIN file_collections fc ON fc.id = cu.collection_id
       WHERE f.room_id IN (SELECT id FROM rooms WHERE ${cond}) ORDER BY f.uploaded_at DESC`, fileParams),
    q(`SELECT rm.room_id, u.id, u.username, u.avatar_color, u.avatar_image, rm.role, rm.joined_at
       FROM room_members rm JOIN users u ON rm.user_id = u.id
       WHERE rm.room_id IN (SELECT id FROM rooms WHERE ${cond})`, params)
  ]);
  const ownerIds = [...new Set(rooms.map(r => r.created_by).filter(Boolean))];
  const owners = ownerIds.length ? await q(`SELECT id, username FROM users WHERE id IN (${ownerIds.map((_, i) => '$' + (i + 1)).join(',')})`, ownerIds) : [];
  return rooms.map(room => {
    const roomFiles = files.filter(f => f.room_id === room.id).map(f => ({ ...f, size: num(f.size), can_edit: isAdmin(user) || f.uploaded_by === user.id, can_delete: isAdmin(user) || f.uploaded_by === user.id || room.created_by === user.id }));
    const roomMembers = members.filter(m => m.room_id === room.id).map(({ room_id, ...m }) => m);
    return {
      ...room,
      files: roomFiles,
      members: roomMembers,
      fileCount: roomFiles.length,
      memberCount: roomMembers.length,
      owner_name: (owners.find(o => o.id === room.created_by) || {}).username || null,
      is_owner: room.created_by === user.id,
      can_manage: isAdmin(user) || (room.created_by === user.id && !room.is_public),
      isMember: isAdmin(user) || roomMembers.some(m => m.id === user.id)
    };
  });
}

app.get('/api/rooms', asMember, wrap(async (req, res) => {
  res.json(await loadRooms(req.user));
}));

// Acervo pessoal: guarda COPIAS independentes (snapshot). Excluir a sala NAO apaga o Acervo;
// so o dono remove seus itens. Tambem aceita upload direto, sem passar por sala.
app.get('/api/library', asMember, wrap(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const [items, savedSpaces, bookcases] = await Promise.all([q(`SELECT li.id, li.file_id, li.space_id, s.name AS space_name, li.bookcase_id,
      b.name AS bookcase_name, b.name AS shelf, li.note, li.is_favorite, li.created_at AS saved_at, li.updated_at,
      li.original_name, li.size, li.mime_type, li.stored_name, li.room_name, li.uploader_name, li.snapshot_ready
    FROM personal_library_items li
    JOIN personal_library_spaces s ON s.id = li.space_id AND s.user_id = li.user_id
    JOIN personal_library_bookcases b ON b.id = li.bookcase_id AND b.space_id = s.id AND b.user_id = li.user_id
    WHERE li.user_id = $1
    ORDER BY li.updated_at DESC, li.created_at DESC`, [req.user.id]), q(`SELECT id, name, created_at
    FROM personal_library_spaces WHERE user_id = $1 ORDER BY LOWER(name), created_at`, [req.user.id]), q(`SELECT id, space_id, name, created_at
    FROM personal_library_bookcases WHERE user_id = $1 ORDER BY LOWER(name), created_at`, [req.user.id])]);
  for (const item of items) {
    if (!item.snapshot_ready) {
      try { await backfillLibrarySnapshot(item); }
      catch (e) { console.error('snapshot do Acervo:', e && e.message); }
    }
  }
  const rows = await q(`SELECT li.id, li.file_id, li.space_id, s.name AS space_name, li.bookcase_id,
      b.name AS bookcase_name, b.name AS shelf, li.note, li.is_favorite, li.created_at AS saved_at, li.updated_at,
      li.original_name, li.size, li.mime_type, li.stored_name, li.room_name, li.uploader_name, li.snapshot_ready
    FROM personal_library_items li
    JOIN personal_library_spaces s ON s.id = li.space_id AND s.user_id = li.user_id
    JOIN personal_library_bookcases b ON b.id = li.bookcase_id AND b.space_id = s.id AND b.user_id = li.user_id
    WHERE li.user_id = $1
    ORDER BY li.updated_at DESC, li.created_at DESC`, [req.user.id]);
  const shelvesBySpace = new Map();
  bookcases.forEach(bookcase => {
    if (!shelvesBySpace.has(bookcase.space_id)) shelvesBySpace.set(bookcase.space_id, []);
    shelvesBySpace.get(bookcase.space_id).push(bookcase);
  });
  res.json({
    items: rows.map(item => ({ ...item, size: num(item.size), is_favorite: Boolean(item.is_favorite), snapshot_ready: Boolean(item.snapshot_ready) })),
    spaces: savedSpaces.map(space => ({ ...space, shelves: shelvesBySpace.get(space.id) || [] })),
    shelves: bookcases
  });
}));

app.post('/api/library/spaces', asMember, wrap(async (req, res) => {
  const name = cleanPersonalLibraryName(req.body && req.body.name);
  if (!name || name.length > 50) return res.status(400).json({ error: 'Dê um nome de até 50 caracteres para o espaço.' });
  const existing = await one('SELECT id, name FROM personal_library_spaces WHERE user_id = $1 AND LOWER(name) = LOWER($2)', [req.user.id, name]);
  if (existing) return res.status(409).json({ error: 'Você já tem um espaço com esse nome.' });
  let space;
  try {
    space = await one(`INSERT INTO personal_library_spaces (id, user_id, name, created_at)
      VALUES ($1, $2, $3, $4) RETURNING id, name, created_at`, [uuidv4(), req.user.id, name, ts()]);
  } catch (error) {
    if (isUnique(error)) return res.status(409).json({ error: 'Você já tem um espaço com esse nome.' });
    throw error;
  }
  const bookcase = await ensurePersonalLibraryBookcase(req.user.id, space.id, 'Geral');
  res.status(201).json({ ...space, shelves: [bookcase] });
}));

app.patch('/api/library/spaces/:id', asMember, wrap(async (req, res) => {
  const name = cleanPersonalLibraryName(req.body && req.body.name);
  if (!name || name.length > 50) return res.status(400).json({ error: 'Dê um nome de até 50 caracteres para o espaço.' });
  try {
    const updated = await one(`UPDATE personal_library_spaces SET name = $1
      WHERE id = $2 AND user_id = $3 RETURNING id, name, created_at`, [name, req.params.id, req.user.id]);
    if (!updated) return res.status(404).json({ error: 'Espaço não encontrado no seu Acervo.' });
    return res.json(updated);
  } catch (error) {
    if (isUnique(error)) return res.status(409).json({ error: 'Você já tem um espaço com esse nome.' });
    throw error;
  }
}));

app.post('/api/library/spaces/:id/shelves', asMember, wrap(async (req, res) => {
  const name = cleanPersonalLibraryName(req.body && req.body.name);
  if (!name || name.length > 50) return res.status(400).json({ error: 'Dê um nome de até 50 caracteres para a prateleira.' });
  const space = await one('SELECT id FROM personal_library_spaces WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!space) return res.status(404).json({ error: 'Espaço não encontrado no seu Acervo.' });
  const existing = await one(`SELECT id FROM personal_library_bookcases
    WHERE user_id = $1 AND space_id = $2 AND LOWER(name) = LOWER($3)`, [req.user.id, space.id, name]);
  if (existing) return res.status(409).json({ error: 'Já existe uma prateleira com esse nome neste espaço.' });
  try {
    const bookcase = await one(`INSERT INTO personal_library_bookcases (id, user_id, space_id, name, created_at)
      VALUES ($1, $2, $3, $4, $5) RETURNING id, space_id, name, created_at`, [uuidv4(), req.user.id, space.id, name, ts()]);
    return res.status(201).json(bookcase);
  } catch (error) {
    if (isUnique(error)) return res.status(409).json({ error: 'Já existe uma prateleira com esse nome neste espaço.' });
    throw error;
  }
}));

app.patch('/api/library/spaces/:id/shelves/:shelfId', asMember, wrap(async (req, res) => {
  const name = cleanPersonalLibraryName(req.body && req.body.name);
  if (!name || name.length > 50) return res.status(400).json({ error: 'Dê um nome de até 50 caracteres para a prateleira.' });
  try {
    const updated = await one(`UPDATE personal_library_bookcases SET name = $1
      WHERE id = $2 AND space_id = $3 AND user_id = $4 RETURNING id, space_id, name, created_at`,
    [name, req.params.shelfId, req.params.id, req.user.id]);
    if (!updated) return res.status(404).json({ error: 'Prateleira não encontrada neste espaço.' });
    return res.json(updated);
  } catch (error) {
    if (isUnique(error)) return res.status(409).json({ error: 'Já existe uma prateleira com esse nome neste espaço.' });
    throw error;
  }
}));

app.delete('/api/library/spaces/:id/shelves/:shelfId', asMember, wrap(async (req, res) => {
  const shelf = await one(`SELECT id, name FROM personal_library_bookcases
    WHERE id = $1 AND space_id = $2 AND user_id = $3`, [req.params.shelfId, req.params.id, req.user.id]);
  if (!shelf) return res.status(404).json({ error: 'Prateleira não encontrada neste espaço.' });
  const siblings = await q(`SELECT id, name FROM personal_library_bookcases
    WHERE user_id = $1 AND space_id = $2 AND id <> $3 ORDER BY created_at, id`, [req.user.id, req.params.id, shelf.id]);
  if (!siblings.length) return res.status(409).json({ error: 'Todo espaço precisa ter ao menos uma prateleira. Crie outra antes de excluir esta.' });
  const destination = siblings[0];
  const moved = await q(`UPDATE personal_library_items SET bookcase_id = $1, shelf = $2, updated_at = $3
    WHERE user_id = $4 AND space_id = $5 AND bookcase_id = $6 RETURNING id`,
  [destination.id, destination.name, ts(), req.user.id, req.params.id, shelf.id]);
  await q('DELETE FROM personal_library_bookcases WHERE id = $1 AND space_id = $2 AND user_id = $3', [shelf.id, req.params.id, req.user.id]);
  res.json({ success: true, moved_count: moved.length, destination: destination.name });
}));

app.post('/api/library', asMember, wrap(async (req, res) => {
  const fileId = String((req.body && req.body.file_id) || '').trim();
  if (!fileId || fileId.length > 100) return res.status(400).json({ error: 'Arquivo inválido.' });
  const file = await one(`SELECT f.id, f.room_id, f.original_name, f.size, f.mime_type, f.stored_name, r.name AS room_name,
      u.username AS uploader_name FROM files f JOIN rooms r ON r.id = f.room_id LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.id = $1`, [fileId]);
  if (!file || !(await canUseRoom(req.user, file.room_id))) return res.status(404).json({ error: 'Arquivo não encontrado nas suas salas.' });
  const location = await resolvePersonalLibraryLocation(req.user.id, req.body || {});
  if (!location) return res.status(400).json({ error: 'Escolha uma prateleira de um espaço seu.' });
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
  const favorite = req.body && (req.body.is_favorite === true || req.body.is_favorite === 1 || req.body.is_favorite === '1') ? 1 : 0;
  const now = ts();
  const existing = await one('SELECT id FROM personal_library_items WHERE user_id = $1 AND file_id = $2', [req.user.id, file.id]);
  const itemId = existing ? existing.id : uuidv4();
  if (!existing) {
    await q(`INSERT INTO personal_library_items (id, user_id, file_id, shelf, space_id, bookcase_id, note, is_favorite,
        original_name, size, mime_type, stored_name, room_name, uploader_name, snapshot_ready, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,$15,$15)`,
      [itemId, req.user.id, file.id, location.bookcase.name, location.space.id, location.bookcase.id, note, favorite,
        file.original_name, file.size, file.mime_type, '', file.room_name || '', file.uploader_name || '', now]);
  }
  // Copia os bytes agora: vira snapshot independente da sala.
  const bytes = await readRoomFileBytes(file);
  if (!bytes) return res.status(404).json({ error: 'O arquivo original não está mais disponível.' });
  const storedName = await writeLibraryBlob(itemId, bytes);
  const saved = await one(`UPDATE personal_library_items SET shelf = $1, space_id = $2, bookcase_id = $3, note = $4,
      is_favorite = $5, original_name = $6, size = $7, mime_type = $8, stored_name = $9,
      room_name = COALESCE(NULLIF(room_name, ''), $10), uploader_name = COALESCE(NULLIF(uploader_name, ''), $11),
      snapshot_ready = 1, updated_at = $12 WHERE id = $13 AND user_id = $14
    RETURNING id, file_id, shelf, space_id, bookcase_id, note, is_favorite, created_at AS saved_at, updated_at`,
    [location.bookcase.name, location.space.id, location.bookcase.id, note, favorite,
      file.original_name, file.size, file.mime_type, storedName, file.room_name || '', file.uploader_name || '', ts(), itemId, req.user.id]);
  res.json({ ...saved, is_favorite: Boolean(saved.is_favorite) });
}));

// Upload direto ao Acervo (sem passar por sala): cria a copia independente na hora.
app.post('/api/library/upload', asMember, (req, res, next) => {
  libraryUpload.array('files', 5)(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Arquivo grande demais (máximo ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB por arquivo)` });
    }
    return res.status(400).json({ error: 'Falha no envio: ' + err.message });
  });
}, wrap(async (req, res) => {
  const location = await resolvePersonalLibraryLocation(req.user.id, req.body || {});
  if (!location) return res.status(400).json({ error: 'Escolha uma prateleira de um espaço seu.' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
  const favorite = req.body && (req.body.is_favorite === true || req.body.is_favorite === 1 || req.body.is_favorite === '1') ? 1 : 0;
  const inserted = [];
  for (const file of req.files) {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const itemId = uuidv4();
    const storedName = await writeLibraryBlob(itemId, file.buffer);
    const saved = await one(`INSERT INTO personal_library_items (id, user_id, file_id, shelf, space_id, bookcase_id, note, is_favorite,
        original_name, size, mime_type, stored_name, room_name, uploader_name, snapshot_ready, created_at, updated_at)
      VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Envio direto','',1,$12,$12)
      RETURNING id, file_id, shelf, space_id, bookcase_id, note, is_favorite, created_at AS saved_at, updated_at`,
      [itemId, req.user.id, location.bookcase.name, location.space.id, location.bookcase.id, note, favorite,
        name, file.size, file.mimetype || 'application/octet-stream', storedName, ts()]);
    inserted.push({ ...saved, is_favorite: Boolean(saved.is_favorite) });
  }
  res.status(201).json(inserted);
}));

app.patch('/api/library/:id', asMember, wrap(async (req, res) => {
  const current = await one('SELECT id, file_id, shelf, space_id, bookcase_id, note, is_favorite FROM personal_library_items WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!current) return res.status(404).json({ error: 'Item não encontrado no seu Acervo.' });
  const body = req.body || {};
  const location = Object.prototype.hasOwnProperty.call(body, 'space_id') || Object.prototype.hasOwnProperty.call(body, 'bookcase_id') || typeof body.shelf === 'string'
    ? await resolvePersonalLibraryLocation(req.user.id, body)
    : { space: { id: current.space_id }, bookcase: { id: current.bookcase_id, name: current.shelf } };
  if (!location) return res.status(400).json({ error: 'Escolha uma prateleira de um espaço seu.' });
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : current.note;
  const favorite = Object.prototype.hasOwnProperty.call(body, 'is_favorite')
    ? (body.is_favorite === true || body.is_favorite === 1 || body.is_favorite === '1' ? 1 : 0)
    : Number(current.is_favorite) || 0;
  const updated = await one(`UPDATE personal_library_items SET shelf = $1, space_id = $2, bookcase_id = $3, note = $4, is_favorite = $5, updated_at = $6
    WHERE id = $7 AND user_id = $8 RETURNING id, file_id, shelf, space_id, bookcase_id, note, is_favorite, created_at AS saved_at, updated_at`,
    [location.bookcase.name, location.space.id, location.bookcase.id, note, favorite, ts(), current.id, req.user.id]);
  res.json({ ...updated, is_favorite: Boolean(updated.is_favorite) });
}));

app.delete('/api/library/:id', asMember, wrap(async (req, res) => {
  const deleted = await q('DELETE FROM personal_library_items WHERE id = $1 AND user_id = $2 RETURNING id, stored_name', [req.params.id, req.user.id]);
  if (!deleted.length) return res.status(404).json({ error: 'Item não encontrado no seu Acervo.' });
  await deleteLibraryBlobs(deleted);
  res.json({ success: true });
}));

// Excluir espaco do Acervo apaga as copias dos itens (so o dono; salas nao sao tocadas).
app.delete('/api/library/spaces/:id', asMember, wrap(async (req, res) => {
  const space = await one('SELECT id FROM personal_library_spaces WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!space) return res.status(404).json({ error: 'Espaço não encontrado no seu Acervo.' });
  const removed = await q('DELETE FROM personal_library_items WHERE user_id = $1 AND space_id = $2 RETURNING id, stored_name', [req.user.id, space.id]);
  await deleteLibraryBlobs(removed);
  await q('DELETE FROM personal_library_bookcases WHERE user_id = $1 AND space_id = $2', [req.user.id, space.id]);
  await q('DELETE FROM personal_library_spaces WHERE id = $1 AND user_id = $2', [space.id, req.user.id]);
  res.json({ success: true, removed_count: removed.length });
}));

// Download de um item do Acervo: usa a copia independente (funciona mesmo sem a sala).
app.get('/download/library/:itemId', requireAuth, wrap(async (req, res) => {
  let item = await one('SELECT * FROM personal_library_items WHERE id = $1 AND user_id = $2', [req.params.itemId, req.user.id]);
  if (!item) return res.status(404).send('Arquivo não encontrado no seu Acervo');
  try { item = await backfillLibrarySnapshot(item); } catch (e) { console.error('snapshot do Acervo:', e && e.message); }
  if (!item.snapshot_ready) return res.status(404).send('A cópia deste arquivo não está mais disponível');
  const bytes = await readLibraryBlob(item);
  if (!bytes) return res.status(404).send('A cópia deste arquivo não está mais disponível');
  const ascii = String(item.original_name || 'arquivo').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.original_name || 'arquivo')}`);
  res.type(item.mime_type || 'application/octet-stream');
  res.send(bytes);
}));

// Visualizacao inline de um item do Acervo (mesma copia independente do download).
app.get('/preview/library/:itemId', requireAuth, wrap(async (req, res) => {
  let item = await one('SELECT * FROM personal_library_items WHERE id = $1 AND user_id = $2', [req.params.itemId, req.user.id]);
  if (!item) return res.status(404).send('Arquivo não encontrado no seu Acervo');
  try { item = await backfillLibrarySnapshot(item); } catch (e) { console.error('snapshot do Acervo:', e && e.message); }
  if (!item.snapshot_ready) return res.status(404).send('A cópia deste arquivo não está mais disponível');
  const bytes = await readLibraryBlob(item);
  if (!bytes) return res.status(404).send('A cópia deste arquivo não está mais disponível');
  const declaredMime = String(item.mime_type || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const safeMediaMime = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac))$/.test(declaredMime);
  const textMime = declaredMime.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(declaredMime);
  const mime = safeMediaMime ? declaredMime : textMime ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  const ascii = String(item.original_name || 'arquivo').replace(/[^a-zA-Z0-9._ -]/g, '_');
  res.set('Content-Disposition', (safeMediaMime || textMime ? 'inline' : 'attachment') + '; filename="' + ascii + '"');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', mime);
  res.send(bytes);
}));

app.get('/api/rooms/browse', asMember, wrap(async (req, res) => {
  const rooms = await loadRooms(req.user);
  res.json(rooms.map(r => ({ ...r, isMember: r.members.some(m => m.id === req.user.id) })));
}));

app.post('/api/rooms/:id/join', asMember, wrap(async (req, res) => {
  const room = await one('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  if (!room.is_public && !isAdmin(req.user)) return res.status(403).json({ error: 'Esta sala é privada' });
  if (await isRoomMember(room.id, req.user.id)) return res.status(400).json({ error: 'Já é membro desta sala' });
  const count = num((await one('SELECT COUNT(*) AS c FROM room_members WHERE room_id = $1', [room.id])).c);
  if (count >= num(room.max_members)) return res.status(409).json({ error: 'Esta sala atingiu o limite de membros' });
  await q('INSERT INTO room_members (id, room_id, user_id, joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [uuidv4(), room.id, req.user.id, ts()]);
  res.json({ success: true });
}));

app.post('/api/rooms/:id/leave', requireAuth, wrap(async (req, res) => {
  const lr = await one('SELECT id, name, created_by, is_public FROM rooms WHERE id = $1', [req.params.id]);
  if (lr && !lr.is_public && lr.created_by === req.user.id && !isAdmin(req.user)) {
    await destroyRoom(lr.id);
    await logAct(req, 'sala_privada_excluida', lr.name + ' (dono saiu)');
    return res.json({ success: true, deleted: true });
  }
  await q('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

// =================== MEMBROS (admin) ===================
app.post('/api/rooms/:id/members', asAdmin, wrap(async (req, res) => {
  const userId = req.body && req.body.userId;
  if (!userId) return res.status(400).json({ error: 'Usuário obrigatório' });
  if (!(await one('SELECT id FROM rooms WHERE id = $1', [req.params.id]))) return res.status(404).json({ error: 'Sala não encontrada' });
  if (!(await one('SELECT id FROM users WHERE id = $1', [userId]))) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (await isRoomMember(req.params.id, userId)) return res.status(400).json({ error: 'Já é membro' });
  await q('INSERT INTO room_members (id, room_id, user_id, joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [uuidv4(), req.params.id, userId, ts()]);
  const mr = await one('SELECT name FROM rooms WHERE id = $1', [req.params.id]), mu = await one('SELECT username FROM users WHERE id = $1', [userId]);
  await notify(userId, 'Você foi adicionado a uma sala', `Um administrador adicionou você à sala "${mr.name}".`, 'info');
  await logAct(req, 'adm_membro_adicionado', `${mu.username} → ${mr.name}`);
  res.json({ success: true });
}));

app.delete('/api/rooms/:roomId/members/:userId', asAdmin, wrap(async (req, res) => {
  const mr = await one('SELECT name, created_by FROM rooms WHERE id = $1', [req.params.roomId]), mu = await one('SELECT username FROM users WHERE id = $1', [req.params.userId]);
  await q('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.roomId, req.params.userId]);
  if (mr && mu) {
    await notify(req.params.userId, 'Removido de uma sala', `Um administrador removeu você da sala "${mr.name}".`, 'warning');
    if (mr.created_by && mr.created_by !== req.params.userId && mr.created_by !== req.user.id) await notify(mr.created_by, 'Um ADM alterou sua sala', `${mu.username} foi removido da sala "${mr.name}" por um administrador.`, 'warning');
    await logAct(req, 'adm_membro_removido', `${mu.username} ← ${mr.name}`);
  }
  res.json({ success: true });
}));

// =================== ARQUIVOS ===================
app.post('/api/rooms/:id/files', asMember, (req, res, next) => {
  upload.array('files', 1)(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Arquivo grande demais (máximo ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB por arquivo)` });
    }
    return res.status(400).json({ error: 'Falha no envio: ' + err.message });
  });
}, wrap(async (req, res) => {
  const room = await one('SELECT id FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  if (!(await canUseRoom(req.user, room.id))) return res.status(403).json({ error: 'Entre na sala antes de enviar arquivos' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const inserted = [];
  for (const file of req.files) {
    const id = uuidv4();
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8'); // corrige acentos vindos do multipart
    let storedName = id; // legado: arquivo guardado no Postgres
    if (blobEnabled()) {
      const { put } = await blobSdk();
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      storedName = `rooms/${room.id}/${id}-${safe}`;
      await put(storedName, file.buffer, {
        access: 'private',
        contentType: file.mimetype || 'application/octet-stream',
        addRandomSuffix: false
      });
    } else {
      await q("INSERT INTO file_blobs (file_id, data) VALUES ($1, decode($2, 'hex'))", [id, file.buffer.toString('hex')]);
    }
    await q('INSERT INTO files (id, room_id, uploaded_by, original_name, stored_name, size, mime_type, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, room.id, req.user.id, name, storedName, file.size, file.mimetype || 'application/octet-stream', ts()]);
    inserted.push({ id, original_name: name, size: file.size, mime_type: file.mimetype });
  }
  res.json(inserted);
}));

// ---------------------------------------------------------------------------
// Upload direto do navegador para o Vercel Blob (contorna o limite de ~4,5 MB da Vercel).
// 1) /upload-url: o servidor confere login/sala e devolve uma URL assinada de curta duração
// 2) o navegador envia o arquivo direto ao Blob (PUT)
// 3) /files/register: o servidor confere o envio e grava o arquivo no banco
// ---------------------------------------------------------------------------
const MAX_DIRECT_BYTES = 100 * 1024 * 1024;
const MAX_BLOB_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;
const BLOB_PATH_RE = /^rooms\/([0-9a-f-]{36})\/([0-9a-f-]{36})-[A-Za-z0-9._-]{1,80}$/;

app.post('/api/rooms/:id/upload-url', asMember, wrap(async (req, res) => {
  if (!blobEnabled()) return res.status(501).json({ error: 'Upload direto indisponível neste ambiente' });
  const room = await one('SELECT id FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  if (!(await canUseRoom(req.user, room.id))) return res.status(403).json({ error: 'Entre na sala antes de enviar arquivos' });

  const name = String((req.body && req.body.name) || '').trim();
  const size = Number(req.body && req.body.size) || 0;
  if (!name) return res.status(400).json({ error: 'Nome do arquivo obrigatório' });
  if (size <= 0) return res.status(400).json({ error: 'Arquivo vazio' });
  if (size > MAX_DIRECT_BYTES) return res.status(413).json({ error: `Arquivo grande demais (máximo ${Math.round(MAX_DIRECT_BYTES / 1024 / 1024)} MB)` });

  const fileId = uuidv4();
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const pathname = `rooms/${room.id}/${fileId}-${safe}`;
  // URL pre-assinada (mesmo fluxo estavel das Coletas): o servidor emite um link PUT de curta
  // duracao e o navegador envia o arquivo direto ao Blob, sem o callback de token do SDK `upload()`.
  const { issueSignedToken, presignUrl } = await blobSdk();
  const validUntil = Date.now() + 60 * 60 * 1000;
  const token = await issueSignedToken({ pathname, operations: ['put'], maximumSizeInBytes: MAX_DIRECT_BYTES, validUntil });
  const signed = await presignUrl(token, { operation: 'put', pathname, access: 'private', maximumSizeInBytes: MAX_DIRECT_BYTES, addRandomSuffix: false, allowOverwrite: false, validUntil });
  res.json({ pathname, presignedUrl: signed.presignedUrl, validUntil, maxBytes: MAX_DIRECT_BYTES });
}));



// Upload multipart direto do navegador ao Blob para arquivos acima de 100 MB.
// O helper do Blob valida os callbacks e emite tokens limitados ao caminho do arquivo.
app.post('/api/rooms/:id/upload-token', wrap(async (req, res) => {
  if (!blobEnabled()) return res.status(501).json({ error: 'Upload direto indisponível neste ambiente' });
  const action = req.body && req.body.type;
  if (action === 'blob.generate-presigned-url') {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Não autorizado' });
    const user = await one('SELECT id, username, role, status, last_seen, force_logout_at, password_change_required FROM users WHERE id = $1', [req.session.userId]);
    if (!user || user.status === 'banned' || user.status === 'rejected' || (user.force_logout_at && Number(req.session.at || 0) <= Number(user.force_logout_at))) {
      req.session = null;
      return res.status(401).json({ error: 'Não autorizado' });
    }
    if (Number(user.password_change_required)) return res.status(428).json({ state: 'password_change_required', error: 'Atualize sua senha para continuar.' });
    if (!isApproved(user)) return res.status(403).json({ error: 'Conta aguardando aprovação' });
    const room = await one('SELECT id FROM rooms WHERE id = $1', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
    if (!(await canUseRoom(user, room.id))) return res.status(403).json({ error: 'Entre na sala antes de enviar arquivos' });
  } else if (action !== 'blob.upload-completed') {
    return res.status(400).json({ error: 'Ação de upload inválida' });
  }

  try {
    const { handleUploadPresigned } = await blobClientSdk();
    const { issueSignedToken } = await blobSdk();
    const result = await handleUploadPresigned({
      request: req,
      body: req.body,
      getSignedToken: async pathname => {
        const m = BLOB_PATH_RE.exec(pathname);
        if (!m || m[1] !== req.params.id) throw new Error('Caminho de arquivo inválido');
        const validUntil = Date.now() + 24 * 60 * 60 * 1000;
        const token = await issueSignedToken({
          pathname,
          operations: ['put'],
          maximumSizeInBytes: MAX_BLOB_UPLOAD_BYTES,
          validUntil
        });
        return {
          token,
          urlOptions: {
            maximumSizeInBytes: MAX_BLOB_UPLOAD_BYTES,
            addRandomSuffix: false,
            allowOverwrite: false,
            validUntil
          }
        };
      },
      onUploadCompleted: async () => {}
    });
    res.json(result);
  } catch (error) {
    console.error('Blob multipart:', error && error.message);
    res.status(400).json({ error: 'Não foi possível preparar ou concluir o upload multipart' });
  }
}));

app.post('/api/rooms/:id/files/register', asMember, wrap(async (req, res) => {
  const pathname = String((req.body && req.body.pathname) || '');
  const m = BLOB_PATH_RE.exec(pathname);
  if (!m || m[1] !== req.params.id) return res.status(400).json({ error: 'Caminho de arquivo inválido' });
  const room = await one('SELECT id FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  if (!(await canUseRoom(req.user, room.id))) return res.status(403).json({ error: 'Entre na sala antes de enviar arquivos' });
  if (await one('SELECT id FROM files WHERE stored_name = $1', [pathname])) return res.status(400).json({ error: 'Arquivo já registrado' });

  let size = Number(req.body.size) || 0;
  try {
    const { head } = await blobSdk();
    const info = await head(pathname);
    if (info && Number(info.size)) size = Number(info.size);
    else return res.status(400).json({ error: 'Não foi possível validar o tamanho do arquivo' });
  } catch (e) {
    if (e && e.name === 'BlobNotFoundError') return res.status(400).json({ error: 'O envio do arquivo não foi concluído' });
    console.error('head do Blob falhou:', e && e.message);
    return res.status(502).json({ error: 'Não foi possível validar o arquivo no armazenamento' });
  }
  if (size > MAX_BLOB_UPLOAD_BYTES) {
    await deleteBlobs([pathname]);
    return res.status(413).json({ error: 'Arquivo grande demais' });
  }

  const name = String(req.body.name || '').trim().slice(0, 255) || 'arquivo';
  const mime = String(req.body.mime || '').slice(0, 100) || 'application/octet-stream';
  await q('INSERT INTO files (id, room_id, uploaded_by, original_name, stored_name, size, mime_type, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [m[2], room.id, req.user.id, name, pathname, size, mime, ts()]);
  res.json({ id: m[2], original_name: name, size });
}));

// =================== COLETAS DE ARQUIVOS ===================
async function expireCollectionRecipientsForOwner(ownerId) {
  const changed = await q(`UPDATE file_collection_recipients cr
    SET status = 'expired',
        closed_at = LEAST(fc.expires_at, COALESCE(dest_room.expires_at, fc.expires_at)),
        closed_reason = 'deadline', submission_started_at = NULL, access_session_hash = NULL, access_lease_until = NULL
    FROM file_collections fc JOIN rooms dest_room ON dest_room.id = fc.room_id
    WHERE cr.collection_id = fc.id AND fc.owner_id = $1
      AND cr.status IN ('pending','uploading','submitting','deleting')
      AND LEAST(fc.expires_at, COALESCE(dest_room.expires_at, fc.expires_at)) <= $2
    RETURNING cr.id`, [ownerId, ts()]);
  for (const recipient of changed) await removeRecipientCollectionUploads(recipient.id);
  const interrupted = await q(`SELECT cr.id, cr.token_hash FROM file_collection_recipients cr
    JOIN file_collections fc ON fc.id = cr.collection_id
    WHERE fc.owner_id = $1 AND cr.status = 'uploading'`, [ownerId]);
  for (const recipient of interrupted) await recoverStaleCollectionUploadState(recipient.id, recipient.token_hash);
}

app.get('/api/coletas', asMember, wrap(async (req, res) => {
  await expireCollectionRecipientsForOwner(req.user.id);
  const collections = await q(`SELECT c.id, c.title, c.instructions, c.single_link, c.exclusive_access, c.multi_use_link, c.room_id, c.expires_at, c.status, c.created_at, r.name AS room_name
    FROM file_collections c JOIN rooms r ON r.id = c.room_id
    WHERE c.owner_id = $1 AND c.history_cleared_at IS NULL ORDER BY c.created_at DESC`, [req.user.id]);
  for (const collection of collections) {
    collection.items = await q('SELECT id, label, required, quantity FROM file_collection_items WHERE collection_id = $1 ORDER BY sort_order, id', [collection.id]);
    collection.recipients = await q(`SELECT cr.id, cr.participant_name, cr.status, cr.created_at, cr.submitted_at, cr.revoked_at, cr.closed_at, cr.closed_reason,
        (SELECT COUNT(*) FROM file_collection_uploads u WHERE u.recipient_id = cr.id AND u.status = 'ready'
          AND (u.submission_id IS NULL OR cr.status = 'submitted')) AS upload_count,
        (SELECT COUNT(*) FROM file_collection_uploads u WHERE u.recipient_id = cr.id AND u.status = 'uploading') AS active_upload_count
      FROM file_collection_recipients cr WHERE cr.collection_id = $1 ORDER BY cr.created_at, cr.id`, [collection.id]);
    collection.recipients = collection.recipients.map(recipient => ({
      ...recipient,
      upload_count: num(recipient.upload_count),
      status: ['uploading','submitting'].includes(recipient.status) || num(recipient.active_upload_count) ? 'sending' :
        recipient.status === 'pending' && num(recipient.upload_count) ? 'in_progress' : recipient.status
    }));
    collection.submissions = await q(`SELECT s.id, s.sender_name, s.submitted_at,
        (SELECT COUNT(*) FROM file_collection_uploads u WHERE u.submission_id = s.id AND u.status = 'ready') AS upload_count
      FROM file_collection_submissions s WHERE s.collection_id = $1 ORDER BY s.submitted_at, s.id`, [collection.id]);
    collection.submissions = collection.submissions.map(submission => ({ ...submission, upload_count: num(submission.upload_count) }));
  }
  res.json(collections);
}));

app.delete('/api/coletas/historico', asMember, wrap(async (req, res) => {
  await expireCollectionRecipientsForOwner(req.user.id);
  const removed = await q(`UPDATE file_collections fc SET history_cleared_at = $1
    WHERE fc.owner_id = $2 AND fc.history_cleared_at IS NULL
      AND EXISTS (SELECT 1 FROM file_collection_recipients cr WHERE cr.collection_id = fc.id)
      AND NOT EXISTS (SELECT 1 FROM file_collection_recipients cr WHERE cr.collection_id = fc.id AND cr.status NOT IN ('submitted','revoked','expired'))
      AND (SELECT MAX(COALESCE(cr.closed_at, cr.submitted_at, cr.revoked_at, fc.expires_at))
        FROM file_collection_recipients cr WHERE cr.collection_id = fc.id) <= $3
    RETURNING fc.id`, [ts(), req.user.id, agoTs(5 * 60 * 1000)]);
  res.json({ success: true, cleared_count: removed.length, files_remain_in_rooms: true });
}));

app.post('/api/coletas', asMember, wrap(async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || '').trim().slice(0, 100);
  const instructions = String(body.instructions || '').trim().slice(0, 2000);
  const roomId = String(body.room_id || '');
  const multiUseLink = body.multi_use_link === true;
  const singleLink = body.single_link === true && !multiUseLink;
  const exclusiveAccess = multiUseLink || body.exclusive_access === true;
  const room = await one('SELECT id, expires_at FROM rooms WHERE id = $1', [roomId]);
  if (!title) return res.status(400).json({ error: 'Dê um título para a coleta.' });
  if (!room) return res.status(404).json({ error: 'Sala de destino não encontrada.' });
  if (!(await canUseRoom(req.user, room.id))) return res.status(403).json({ error: 'Você precisa ter acesso à sala de destino.' });

  const expiresDate = new Date(body.expires_at || '');
  if (!Number.isFinite(expiresDate.getTime()) || expiresDate.getTime() <= Date.now()) return res.status(400).json({ error: 'Defina um prazo futuro para a coleta.' });
  const expiresAt = expiresDate.toISOString().slice(0, 19).replace('T', ' ');
  if (room.expires_at && room.expires_at <= expiresAt) return res.status(400).json({ error: 'O prazo da coleta precisa terminar antes da expiração da sala.' });

  const items = Array.isArray(body.items) ? body.items.map(item => ({
    label: String(item && item.label || '').trim().slice(0, 120),
    required: item && item.required === false ? 0 : 1,
    quantity: Math.max(1, Math.min(MAX_COLLECTION_UPLOADS, Math.floor(Number(item && item.quantity) || 1)))
  })).filter(item => item.label) : [];
  if (!items.length || items.length > MAX_COLLECTION_ITEMS) return res.status(400).json({ error: `Adicione de 1 a ${MAX_COLLECTION_ITEMS} itens à lista solicitada.` });
  if (items.reduce((total, item) => total + item.quantity, 0) > MAX_COLLECTION_UPLOADS) return res.status(400).json({ error: `A soma dos arquivos solicitados não pode passar de ${MAX_COLLECTION_UPLOADS} por participante.` });

  const rawParticipants = Array.isArray(body.participants) ? body.participants : [];
  const participants = singleLink || multiUseLink ? [multiUseLink ? 'Link multiuso' : ''] : rawParticipants.map(item => String(item && (item.name || item) || '').trim().slice(0, 80)).filter(Boolean);
  if (!participants.length || participants.length > MAX_COLLECTION_RECIPIENTS) return res.status(400).json({ error: `Adicione de 1 a ${MAX_COLLECTION_RECIPIENTS} participantes.` });

  const collectionId = uuidv4(), createdAt = ts();
  const savedItems = items.map((item, sort_order) => ({ id: uuidv4(), ...item, sort_order }));
  const recipients = participants.map(participant_name => ({ id: uuidv4(), participant_name, token: makeCollectionToken() }));
  const created = await q(`WITH created AS (
      INSERT INTO file_collections (id, owner_id, room_id, title, instructions, expires_at, status, created_at, single_link, exclusive_access, multi_use_link)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
    ), inserted_items AS (
      INSERT INTO file_collection_items (id, collection_id, label, required, quantity, sort_order)
      SELECT item.id, created.id, item.label, item.required, item.quantity, item.sort_order
      FROM created CROSS JOIN jsonb_to_recordset($12::jsonb) AS item(id TEXT, label TEXT, required INTEGER, quantity INTEGER, sort_order INTEGER)
      RETURNING id
    ), inserted_recipients AS (
      INSERT INTO file_collection_recipients (id, collection_id, participant_name, token_hash, status, created_at)
      SELECT recipient.id, created.id, recipient.participant_name, recipient.token_hash, 'pending', $8
      FROM created CROSS JOIN jsonb_to_recordset($13::jsonb) AS recipient(id TEXT, participant_name TEXT, token_hash TEXT)
      RETURNING id
    )
    SELECT id FROM created`, [collectionId, req.user.id, room.id, title, instructions, expiresAt, 'active', createdAt,
    singleLink ? 1 : 0, exclusiveAccess ? 1 : 0, multiUseLink ? 1 : 0, JSON.stringify(savedItems), JSON.stringify(recipients.map(({ id, participant_name, token }) => ({ id, participant_name, token_hash: hashToken(token) })))]);
  if (!created.length) return res.status(500).json({ error: 'Não foi possível criar a coleta.' });
  await logAct(req, 'coleta_criada', title);
  res.status(201).json({ id: collectionId, title, single_link: singleLink, multi_use_link: multiUseLink, exclusive_access: exclusiveAccess, expires_at: expiresAt,
    recipients: recipients.map(recipient => ({ ...recipient, participant_name: recipient.participant_name || (multiUseLink ? 'Link multiuso' : 'Link único') })) });
}));

app.post('/api/coletas/:id/participantes/:recipientId/revogar', asMember, wrap(async (req, res) => {
  const collection = await requireCollectionOwner(req.params.id, req.user.id);
  if (!collection) return res.status(404).json({ error: 'Coleta não encontrada.' });
  const closedAt = ts();
  const changed = await q(`UPDATE file_collection_recipients SET status = 'revoked', revoked_at = $1, closed_at = $1, closed_reason = 'suspended', access_session_hash = NULL, access_lease_until = NULL
    WHERE id = $2 AND collection_id = $3 AND status IN ('pending','uploading') RETURNING id`, [closedAt, req.params.recipientId, collection.id]);
  if (!changed.length) return res.status(409).json({ error: 'Este link já foi concluído, revogado ou não existe.' });
  await removeRecipientCollectionUploads(req.params.recipientId);
  await logAct(req, 'link_coleta_revogado', collection.title);
  res.json({ success: true });
}));

app.post('/api/coletas/:id/participantes/:recipientId/reemitir', asMember, wrap(async (req, res) => {
  const collection = await requireCollectionOwner(req.params.id, req.user.id);
  if (!collection) return res.status(404).json({ error: 'Coleta não encontrada.' });
  if (collection.status !== 'active' || collection.expires_at <= ts()) return res.status(410).json({ error: 'O prazo desta coleta terminou.' });
  const recipient = await one('SELECT id, participant_name, status, token_hash FROM file_collection_recipients WHERE id = $1 AND collection_id = $2', [req.params.recipientId, collection.id]);
  if (!recipient) return res.status(404).json({ error: 'Participante não encontrado.' });
  if (recipient.status === 'submitted') return res.status(409).json({ error: 'O envio deste participante já foi concluído.' });
  const token = makeCollectionToken();
  const reissuedAt = ts();
  const updated = await q(`WITH saved_old_link AS (
      INSERT INTO file_collection_closed_tokens (token_hash, recipient_id, closed_reason, closed_at)
      SELECT cr.token_hash, cr.id, 'replaced', $5 FROM file_collection_recipients cr
      WHERE cr.id = $2 AND cr.collection_id = $3 AND cr.token_hash = $4 AND cr.status IN ('pending','uploading','revoked')
      RETURNING recipient_id
    ), changed AS (
      UPDATE file_collection_recipients cr SET token_hash = $1, status = 'pending', revoked_at = NULL, closed_at = NULL, closed_reason = NULL,
        access_session_hash = NULL, access_lease_until = NULL
      FROM saved_old_link old WHERE cr.id = old.recipient_id
      RETURNING cr.id
    ) SELECT id FROM changed`, [hashToken(token), recipient.id, collection.id, recipient.token_hash, reissuedAt]);
  if (!updated.length) return res.status(409).json({ error: 'O envio está sendo finalizado. Aguarde e atualize a lista.' });
  const stagedUploads = await q('SELECT id, stored_name FROM file_collection_uploads WHERE recipient_id = $1 AND submission_id IS NULL', [recipient.id]);
  for (const staged of stagedUploads) await removeCollectionUpload(staged);
  res.json({ success: true, participant_name: Number(collection.multi_use_link) ? 'Link multiuso' : recipient.participant_name, token });
}));

const publicCollectionAccess = wrap(async (req, res, next) => {
  let recipient = await getCollectionRecipient(req.params.token);
  if (!recipient && await consumeRateLimit('collection-invalid:' + clientIp(req), 120, 60 * 1000)) {
    return res.status(429).json({ error: 'Muitas tentativas para acessar links de envio. Aguarde e tente novamente.' });
  }
  if (!recipient && COLLECTION_TOKEN_RE.test(String(req.params.token || ''))) {
    const replaced = await one('SELECT closed_reason FROM file_collection_closed_tokens WHERE token_hash = $1', [hashToken(req.params.token)]);
    if (replaced && replaced.closed_reason === 'replaced') {
      clearCollectionAccessCookie(res, req.params.token);
      return res.status(410).json({ state: 'replaced', error: 'Link substituído pelo organizador. Peça o link mais recente para enviar.' });
    }
  }
  recipient = await expireCollectionRecipientIfNeeded(recipient, req.params.token);
  const error = collectionAccessError(recipient, res);
  if (error) {
    clearCollectionAccessCookie(res, req.params.token);
    return error;
  }
  if (Number(recipient.exclusive_access)) {
    const reserved = await reserveExclusiveCollectionAccess(recipient, req, res, req.params.token);
    if (!reserved) return res.status(423).json({ state: 'in_use', error: 'Este link está aberto em outro dispositivo. Tente novamente quando o acesso estiver disponível.' });
  } else reserveCollectionSession(req, res, req.params.token);
  const isUploadActivity = ['/upload', '/upload-token', '/upload-heartbeat', '/registrar', '/heartbeat']
    .some(path => req.path.endsWith(path));
  if (!isUploadActivity) {
    await recoverStaleCollectionUploadState(recipient.id, hashToken(req.params.token));
    recipient = await getCollectionRecipient(req.params.token);
    const currentError = collectionAccessError(recipient, res);
    if (currentError) {
      clearCollectionAccessCookie(res, req.params.token);
      return currentError;
    }
  }
  req.collectionRecipient = recipient;
  return next();
});

app.post('/api/coletas/enviar/:token/heartbeat', publicCollectionAccess, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true });
});

app.post('/api/coletas/enviar/:token/upload-heartbeat', publicCollectionAccess, wrap(async (req, res) => {
  const uploadId = String(req.body && req.body.id || '');
  const touched = await q(`UPDATE file_collection_uploads u SET uploaded_at = $1
    WHERE u.id = $2 AND u.recipient_id = $3 AND u.status = 'uploading' AND u.upload_session_hash = $4
      AND EXISTS (SELECT 1 FROM file_collection_recipients cr WHERE cr.id = $3 AND cr.status = 'uploading' AND cr.token_hash = $5)
    RETURNING u.id`, [ts(), uploadId, req.collectionRecipient.id, req.collectionAccessSessionHash, hashToken(req.params.token)]);
  if (!touched.length) return res.status(410).json({ error: 'Este envio não está mais ativo.' });
  res.set('Cache-Control', 'no-store');
  res.json({ success: true });
}));

app.get('/api/coletas/enviar/:token', publicCollectionAccess, wrap(async (req, res) => {
  let recipient = req.collectionRecipient;
  if (recipient.recipient_status === 'submitting' && recipient.submission_started_at && recipient.submission_started_at <= agoTs(10 * 60 * 1000)) {
    await q(`UPDATE file_collection_recipients SET status = 'pending', submission_started_at = NULL
      WHERE id = $1 AND status = 'submitting' AND submission_started_at <= $2`, [recipient.id, agoTs(10 * 60 * 1000)]);
    recipient = await getCollectionRecipient(req.params.token);
  }
  if (recipient.recipient_status === 'submitting') {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.json({ state: 'submitting', message: 'O envio está sendo confirmado. Aguarde um instante.' });
  }
  const [items, uploads] = await Promise.all([
    q('SELECT id, label, required, quantity FROM file_collection_items WHERE collection_id = $1 ORDER BY sort_order, id', [recipient.collection_id]),
    q(`SELECT id, item_id, original_name, size, mime_type, status, uploaded_at
      FROM file_collection_uploads WHERE recipient_id = $1 AND submission_id IS NULL
        AND upload_session_hash = $2 ORDER BY uploaded_at, id`, [recipient.id, req.collectionAccessSessionHash])
  ]);
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.json({ title: recipient.title, instructions: recipient.instructions, participant_name: recipient.participant_name,
    single_link: !!Number(recipient.single_link),
    multi_use_link: !!Number(recipient.multi_use_link),
    exclusive_access: !!Number(recipient.exclusive_access),
    expires_at: recipient.expires_at, items, uploads: uploads.map(file => ({ ...file, size: num(file.size) })),
    blob_enabled: blobEnabled(), max_upload_bytes: blobEnabled() ? MAX_BLOB_UPLOAD_BYTES : MAX_FILE_BYTES });
}));

app.post('/api/coletas/enviar/:token/reservar', publicCollectionAccess, wrap(async (req, res) => {
  if (!blobEnabled()) return res.status(501).json({ error: 'O envio direto não está disponível neste ambiente.' });
  const recipient = req.collectionRecipient, body = req.body || {};
  const itemId = String(body.item_id || ''), originalName = cleanCollectionFileName(body.name);
  const size = Number(body.size) || 0, mime = String(body.mime || '').slice(0, 100) || 'application/octet-stream';
  const item = await one('SELECT id, quantity FROM file_collection_items WHERE id = $1 AND collection_id = $2', [itemId, recipient.collection_id]);
  if (!item) return res.status(400).json({ error: 'Item da coleta inválido.' });
  if (size <= 0) return res.status(400).json({ error: 'O arquivo está vazio.' });
  if (size > MAX_BLOB_UPLOAD_BYTES) return res.status(413).json({ error: 'Arquivo maior que o limite permitido.' });
  const id = uuidv4();
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'arquivo';
  const pathname = `rooms/${recipient.room_id}/${id}-${safeName}`;
  const locked = await q(`UPDATE file_collection_recipients SET status = 'uploading'
    WHERE id = $1 AND status = 'pending' AND token_hash = $2 RETURNING id`, [recipient.id, hashToken(req.params.token)]);
  if (!locked.length) {
    const latest = await expireCollectionRecipientIfNeeded(await getCollectionRecipient(req.params.token), req.params.token);
    const accessError = collectionAccessError(latest, res);
    if (accessError) return accessError;
    return res.status(409).json({ error: 'Outro arquivo está sendo enviado. Aguarde o término.' });
  }
  const itemCount = num((await one("SELECT COUNT(*) AS count FROM file_collection_uploads WHERE recipient_id = $1 AND item_id = $2 AND submission_id IS NULL AND status IN ('ready','uploading') AND upload_session_hash = $3", [recipient.id, item.id, req.collectionAccessSessionHash])).count);
  if (itemCount >= num(item.quantity)) {
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, hashToken(req.params.token)]);
    return res.status(409).json({ error: 'A quantidade solicitada para este item já foi atingida.' });
  }
  const count = num((await one('SELECT COUNT(*) AS count FROM file_collection_uploads WHERE recipient_id = $1 AND submission_id IS NULL AND upload_session_hash = $2', [recipient.id, req.collectionAccessSessionHash])).count);
  if (count >= MAX_COLLECTION_UPLOADS) {
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, hashToken(req.params.token)]);
    return res.status(413).json({ error: `O limite é de ${MAX_COLLECTION_UPLOADS} arquivos por participante.` });
  }
  const reservation = await q(`INSERT INTO file_collection_uploads (id, collection_id, recipient_id, item_id, original_name, stored_name, size, mime_type, status, uploaded_at, upload_session_hash)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,'uploading',$10,$11 WHERE EXISTS (
      SELECT 1 FROM file_collection_recipients cr JOIN file_collections fc ON fc.id = cr.collection_id
      JOIN rooms dest_room ON dest_room.id = fc.room_id
      WHERE cr.id = $3 AND cr.status = 'uploading' AND cr.token_hash = $9 AND fc.status = 'active' AND fc.expires_at > $10
        AND (dest_room.expires_at IS NULL OR dest_room.expires_at > $10)
    ) RETURNING id`, [id, recipient.collection_id, recipient.id, itemId, originalName, pathname, size, mime, hashToken(req.params.token), ts(), req.collectionAccessSessionHash]);
  if (!reservation.length) {
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, hashToken(req.params.token)]);
    return sendCollectionClosedError(req.params.token, res);
  }

  const result = { id, pathname, multipart: size > MAX_DIRECT_BYTES };
  if (!result.multipart) {
    try {
      const { issueSignedToken, presignUrl } = await blobSdk();
      const validUntil = Date.now() + 15 * 60 * 1000;
      const token = await issueSignedToken({ pathname, operations: ['put'], maximumSizeInBytes: size, validUntil });
      const signed = await presignUrl(token, { operation: 'put', pathname, access: 'private', maximumSizeInBytes: size, addRandomSuffix: false, allowOverwrite: false, validUntil });
      result.presignedUrl = signed.presignedUrl;
    } catch (error) {
      await q('DELETE FROM file_collection_uploads WHERE id = $1', [id]);
      await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, hashToken(req.params.token)]);
      throw error;
    }
  }
  res.status(201).json(result);
}));

app.post('/api/coletas/enviar/:token/upload-token', publicCollectionAccess, wrap(async (req, res) => {
  if (!blobEnabled()) return res.status(501).json({ error: 'Upload multipart indisponível neste ambiente.' });
  const recipient = req.collectionRecipient;
  try {
    const action = req.body && req.body.type;
    const pathname = String(req.body && req.body.pathname || '');
    const match = BLOB_PATH_RE.exec(pathname);
    if (!match || match[1] !== recipient.room_id) return res.status(400).json({ error: 'Caminho de upload inválido.' });
    const staged = await one(`SELECT id, size FROM file_collection_uploads WHERE id = $1 AND recipient_id = $2 AND stored_name = $3 AND status = 'uploading'
      AND upload_session_hash = $4`, [match[2], recipient.id, pathname, req.collectionAccessSessionHash]);
    if (!staged) return res.status(410).json({ error: 'Este envio não está mais disponível.' });
    const { handleUploadPresigned } = await blobClientSdk();
    const { issueSignedToken } = await blobSdk();
    const result = await handleUploadPresigned({
      request: req,
      body: req.body,
      getSignedToken: async requestedPath => {
        if (requestedPath !== pathname) throw new Error('Caminho de upload inválido');
        const validUntil = Date.now() + 24 * 60 * 60 * 1000;
        const maximumSizeInBytes = num(staged.size);
        const token = await issueSignedToken({ pathname, operations: ['put'], maximumSizeInBytes, validUntil });
        return { token, urlOptions: { maximumSizeInBytes, addRandomSuffix: false, allowOverwrite: false, validUntil } };
      },
      onUploadCompleted: async () => {}
    });
    res.json(result);
  } catch (error) {
    console.error('Upload multipart de coleta:', error && error.message);
    res.status(400).json({ error: 'Não foi possível preparar ou concluir o upload multipart.' });
  }
}));

app.post('/api/coletas/enviar/:token/registrar', publicCollectionAccess, wrap(async (req, res) => {
  if (!blobEnabled()) return res.status(501).json({ error: 'Registro de upload direto indisponível neste ambiente.' });
  const recipient = req.collectionRecipient, id = String(req.body && req.body.id || '');
  const staged = await one(`SELECT id, stored_name, size FROM file_collection_uploads
    WHERE id = $1 AND recipient_id = $2 AND status = 'uploading' AND upload_session_hash = $3`, [id, recipient.id, req.collectionAccessSessionHash]);
  if (!staged) return res.status(410).json({ error: 'Este envio não está mais disponível.' });
  try {
    const { head } = await blobSdk();
    const info = await head(staged.stored_name);
    const actualSize = Number(info && info.size) || 0;
    if (!actualSize || actualSize !== num(staged.size) || actualSize > MAX_BLOB_UPLOAD_BYTES) {
      await removeCollectionUpload(staged);
      await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, hashToken(req.params.token)]);
      return res.status(400).json({ error: 'Não foi possível validar o arquivo enviado.' });
    }
    const updated = await q(`UPDATE file_collection_uploads SET status = 'ready', uploaded_at = $1
      WHERE id = $2 AND recipient_id = $3 AND status = 'uploading'
        AND upload_session_hash = $5
        AND EXISTS (SELECT 1 FROM file_collection_recipients WHERE id = $3 AND status = 'uploading' AND token_hash = $4)
      RETURNING id`, [ts(), id, recipient.id, hashToken(req.params.token), req.collectionAccessSessionHash]);
    if (!updated.length) {
      const current = await one(`SELECT u.status AS upload_status, cr.status AS recipient_status, cr.token_hash
        FROM file_collection_uploads u JOIN file_collection_recipients cr ON cr.id = u.recipient_id
        WHERE u.id = $1 AND u.recipient_id = $2`, [id, recipient.id]);
      if (current && current.upload_status === 'ready' && ['uploading','pending'].includes(current.recipient_status) && current.token_hash === hashToken(req.params.token)) {
        return res.json({ success: true, id });
      }
      await deleteBlobs([staged.stored_name]);
      return sendCollectionClosedError(req.params.token, res, 'Este link foi encerrado antes do registro do arquivo.');
    }
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, hashToken(req.params.token)]);
  } catch (error) {
    await removeCollectionUpload(staged).catch(() => {});
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, hashToken(req.params.token)]).catch(() => {});
    if (error && error.name === 'BlobNotFoundError') return res.status(400).json({ error: 'O envio do arquivo não foi concluído.' });
    console.error('Validação de upload da coleta:', error && error.message);
    return res.status(502).json({ error: 'Não foi possível validar o arquivo no armazenamento.' });
  }
  res.json({ success: true, id });
}));

app.post('/api/coletas/enviar/:token/upload', publicCollectionAccess, (req, res, next) => {
  collectionUpload.single('file')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Arquivo grande demais (máximo ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).` });
    return res.status(400).json({ error: 'Falha no envio: ' + error.message });
  });
}, wrap(async (req, res) => {
  const recipient = req.collectionRecipient, file = req.file;
  if (!file) return res.status(400).json({ error: 'Selecione um arquivo.' });
  const itemId = String(req.body.item_id || ''), item = await one('SELECT id, quantity FROM file_collection_items WHERE id = $1 AND collection_id = $2', [itemId, recipient.collection_id]);
  if (!item) return res.status(400).json({ error: 'Item da coleta inválido.' });
  const tokenHash = hashToken(req.params.token);
  const locked = await q(`UPDATE file_collection_recipients SET status = 'uploading'
    WHERE id = $1 AND status = 'pending' AND token_hash = $2 RETURNING id`, [recipient.id, tokenHash]);
  if (!locked.length) {
    const latest = await expireCollectionRecipientIfNeeded(await getCollectionRecipient(req.params.token), req.params.token);
    const accessError = collectionAccessError(latest, res);
    if (accessError) return accessError;
    return res.status(409).json({ error: 'Outro arquivo está sendo enviado. Aguarde o término.' });
  }
  const itemCount = num((await one("SELECT COUNT(*) AS count FROM file_collection_uploads WHERE recipient_id = $1 AND item_id = $2 AND submission_id IS NULL AND status IN ('ready','uploading') AND upload_session_hash = $3", [recipient.id, item.id, req.collectionAccessSessionHash])).count);
  if (itemCount >= num(item.quantity)) {
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, tokenHash]);
    return res.status(409).json({ error: 'A quantidade solicitada para este item já foi atingida.' });
  }
  const count = num((await one('SELECT COUNT(*) AS count FROM file_collection_uploads WHERE recipient_id = $1 AND submission_id IS NULL AND upload_session_hash = $2', [recipient.id, req.collectionAccessSessionHash])).count);
  if (count >= MAX_COLLECTION_UPLOADS) {
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, tokenHash]);
    return res.status(413).json({ error: `O limite é de ${MAX_COLLECTION_UPLOADS} arquivos por participante.` });
  }
  const id = uuidv4(), originalName = cleanCollectionFileName(Buffer.from(file.originalname, 'latin1').toString('utf8'));
  try {
    const inserted = await q(`WITH staged AS (
        INSERT INTO file_collection_uploads (id, collection_id, recipient_id, item_id, original_name, stored_name, size, mime_type, status, uploaded_at, upload_session_hash)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,'ready',$9,$12 WHERE EXISTS (
          SELECT 1 FROM file_collection_recipients cr JOIN file_collections fc ON fc.id = cr.collection_id
          JOIN rooms dest_room ON dest_room.id = fc.room_id
          WHERE cr.id = $3 AND cr.status = 'uploading' AND cr.token_hash = $10 AND fc.status = 'active' AND fc.expires_at > $9
            AND (dest_room.expires_at IS NULL OR dest_room.expires_at > $9)
        ) RETURNING id
      ), stored AS (
        INSERT INTO file_collection_upload_blobs (upload_id, data)
        SELECT id, decode($11, 'hex') FROM staged RETURNING upload_id
      ) SELECT upload_id FROM stored`, [id, recipient.collection_id, recipient.id, itemId, originalName, id, file.size, file.mimetype || 'application/octet-stream', ts(), tokenHash, file.buffer.toString('hex'), req.collectionAccessSessionHash]);
    if (!inserted.length) {
      await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, tokenHash]);
      return sendCollectionClosedError(req.params.token, res);
    }
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, tokenHash]);
  } catch (error) {
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'uploading' AND token_hash = $2", [recipient.id, tokenHash]);
    throw error;
  }
  res.status(201).json({ id, item_id: itemId, original_name: originalName, size: file.size });
}));

app.post('/api/coletas/enviar/:token/uploads/:uploadId/cancel', publicCollectionAccess, wrap(async (req, res) => {
  const recipient = req.collectionRecipient, tokenHash = hashToken(req.params.token);
  const staged = await one(`SELECT id, stored_name, status FROM file_collection_uploads
    WHERE id = $1 AND recipient_id = $2 AND upload_session_hash = $3 AND submission_id IS NULL`,
  [req.params.uploadId, recipient.id, req.collectionAccessSessionHash]);
  if (!staged) return res.json({ success: true, removed: true });
  if (staged.status === 'ready') return res.json({ success: true, ready: true });
  if (staged.status !== 'uploading') return res.status(409).json({ error: 'Este arquivo não pode mais ser cancelado.' });
  const locked = await q(`UPDATE file_collection_recipients SET status = 'deleting'
    WHERE id = $1 AND status IN ('pending','uploading') AND token_hash = $2
      AND EXISTS (SELECT 1 FROM file_collection_uploads u WHERE u.id = $3 AND u.recipient_id = $1
        AND u.status = 'uploading' AND u.submission_id IS NULL AND u.upload_session_hash = $4)
    RETURNING id`, [recipient.id, tokenHash, req.params.uploadId, req.collectionAccessSessionHash]);
  if (!locked.length) {
    const current = await one(`SELECT u.status AS upload_status FROM file_collection_uploads u
      WHERE u.id = $1 AND u.recipient_id = $2 AND u.upload_session_hash = $3 AND u.submission_id IS NULL`,
    [req.params.uploadId, recipient.id, req.collectionAccessSessionHash]);
    if (!current) return res.json({ success: true, removed: true });
    if (current.upload_status === 'ready') return res.json({ success: true, ready: true });
    return res.status(409).json({ error: 'O arquivo ainda está sendo enviado. Aguarde o término.' });
  }
  try {
    const removed = await removeStaleCollectionUpload(staged, ts());
    if (!removed) {
      const current = await one(`SELECT status FROM file_collection_uploads WHERE id = $1 AND recipient_id = $2
        AND upload_session_hash = $3 AND submission_id IS NULL`, [staged.id, recipient.id, req.collectionAccessSessionHash]);
      if (current && current.status !== 'ready') return res.status(409).json({ error: 'O arquivo ainda está sendo enviado. Aguarde o término.' });
      if (current && current.status === 'ready') return res.json({ success: true, ready: true });
    }
  } finally {
    await q(`UPDATE file_collection_recipients SET status = 'pending'
      WHERE id = $1 AND status = 'deleting' AND token_hash = $2`, [recipient.id, tokenHash]);
  }
  res.json({ success: true, cancelled: true });
}));

app.delete('/api/coletas/enviar/:token/uploads/:uploadId', publicCollectionAccess, wrap(async (req, res) => {
  const recipient = req.collectionRecipient;
  const tokenHash = hashToken(req.params.token);
  const upload = await one(`SELECT id, stored_name, status, uploaded_at FROM file_collection_uploads
    WHERE id = $1 AND recipient_id = $2 AND upload_session_hash = $3 AND submission_id IS NULL`,
  [req.params.uploadId, recipient.id, req.collectionAccessSessionHash]);
  if (!upload) return res.json({ success: true, removed: true });
  if (upload.status === 'uploading') {
    const staleBefore = agoTs(COLLECTION_UPLOAD_STALE_MS);
    if (upload.uploaded_at && upload.uploaded_at > staleBefore) {
      return res.status(409).json({ error: 'Este arquivo ainda está sendo enviado em outra aba. Aguarde o término.' });
    }
    const removed = await removeStaleCollectionUpload(upload, staleBefore);
    if (!removed) return res.status(409).json({ error: 'O envio acabou de ser retomado. Aguarde o término.' });
    await recoverStaleCollectionUploadState(recipient.id, tokenHash);
    return res.json({ success: true, removed: true });
  }
  if (upload.status !== 'ready') return res.status(404).json({ error: 'Arquivo não encontrado ou envio já encerrado.' });
  const locked = await q(`UPDATE file_collection_recipients SET status = 'deleting'
    WHERE id = $1 AND status = 'pending' AND token_hash = $2 RETURNING id`, [recipient.id, tokenHash]);
  if (!locked.length) return res.status(409).json({ error: 'Aguarde o envio em andamento terminar antes de remover arquivos.' });
  try {
    const found = await q(`DELETE FROM file_collection_uploads u WHERE u.id = $1 AND u.recipient_id = $2 AND u.submission_id IS NULL
      AND u.upload_session_hash = $4
      AND EXISTS (SELECT 1 FROM file_collection_recipients cr WHERE cr.id = $2 AND cr.status = 'deleting' AND cr.token_hash = $3)
      RETURNING u.id, u.stored_name`, [req.params.uploadId, recipient.id, tokenHash, req.collectionAccessSessionHash]);
    if (!found.length) return res.status(404).json({ error: 'Arquivo não encontrado ou envio já encerrado.' });
    if (isBlobPath(found[0].stored_name)) await deleteBlobs([found[0].stored_name]);
    await q('DELETE FROM file_collection_upload_blobs WHERE upload_id = $1', [found[0].id]);
  } finally {
    await q("UPDATE file_collection_recipients SET status = 'pending' WHERE id = $1 AND status = 'deleting' AND token_hash = $2", [recipient.id, tokenHash]);
  }
  res.json({ success: true });
}));

app.post('/api/coletas/enviar/:token/finalizar', publicCollectionAccess, wrap(async (req, res) => {
  const recipient = req.collectionRecipient, submittedAt = ts(), tokenHash = hashToken(req.params.token), submissionId = uuidv4(), accessSessionHash = req.collectionAccessSessionHash;
  const senderName = recipient.single_link || recipient.multi_use_link
    ? String(req.body && req.body.participant_name || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    : recipient.participant_name;
  if ((recipient.single_link || recipient.multi_use_link) && !senderName) return res.status(400).json({ error: 'Informe seu nome para concluir o envio.' });
  const locked = await q(`UPDATE file_collection_recipients SET status = 'submitting', submission_started_at = $1
    WHERE id = $2 AND status = 'pending' AND token_hash = $3
      AND EXISTS (SELECT 1 FROM file_collections fc JOIN rooms dest_room ON dest_room.id = fc.room_id
        WHERE fc.id = file_collection_recipients.collection_id AND fc.status = 'active' AND fc.expires_at > $1
          AND (dest_room.expires_at IS NULL OR dest_room.expires_at > $1))
    RETURNING id`, [submittedAt, recipient.id, tokenHash]);
  if (!locked.length) {
    const latest = await getCollectionRecipient(req.params.token);
    const accessError = collectionAccessError(latest, res);
    if (accessError) return accessError;
    if (latest.recipient_status === 'submitting') return res.status(409).json({ state: 'submitting', error: 'O envio está sendo confirmado. Aguarde um instante.' });
    return res.status(409).json({ error: 'Ainda há um arquivo sendo enviado. Aguarde o fim e tente novamente.' });
  }

  let missing, uploading;
  try {
    missing = await q(`SELECT i.label, i.quantity FROM file_collection_items i WHERE i.collection_id = $1 AND i.required = 1
      AND (SELECT COUNT(*) FROM file_collection_uploads u WHERE u.recipient_id = $2 AND u.item_id = i.id AND u.submission_id IS NULL AND u.status = 'ready'
        AND u.upload_session_hash = $3) < i.quantity`, [recipient.collection_id, recipient.id, accessSessionHash]);
    uploading = await one("SELECT id FROM file_collection_uploads WHERE recipient_id = $1 AND submission_id IS NULL AND status = 'uploading' AND upload_session_hash = $2 LIMIT 1", [recipient.id, accessSessionHash]);
  } catch (error) {
    await q("UPDATE file_collection_recipients SET status = 'pending', submission_started_at = NULL WHERE id = $1 AND status = 'submitting' AND token_hash = $2", [recipient.id, tokenHash]).catch(() => {});
    throw error;
  }
  if (missing.length || uploading) {
    await q("UPDATE file_collection_recipients SET status = 'pending', submission_started_at = NULL WHERE id = $1 AND status = 'submitting' AND token_hash = $2", [recipient.id, tokenHash]);
    if (missing.length) return res.status(400).json({ error: 'Faltam arquivos obrigatórios: ' + missing.map(item => `${item.label} (${item.quantity})`).join(', ') });
    return res.status(409).json({ error: 'Ainda há arquivos sendo enviados. Aguarde o fim e tente novamente.' });
  }

  let completed;
  try {
    completed = await q(`WITH claimed AS (
      UPDATE file_collection_recipients cr SET status = CASE WHEN fc.multi_use_link = 1 THEN 'pending' ELSE 'submitted' END,
        submitted_at = CASE WHEN fc.multi_use_link = 1 THEN cr.submitted_at ELSE $2 END,
        closed_at = CASE WHEN fc.multi_use_link = 1 THEN cr.closed_at ELSE $2 END,
        closed_reason = CASE WHEN fc.multi_use_link = 1 THEN cr.closed_reason ELSE 'submitted' END,
        submission_started_at = NULL,
        access_session_hash = NULL, access_lease_until = NULL,
        participant_name = CASE WHEN fc.single_link = 1 OR fc.multi_use_link = 1 THEN $4 ELSE cr.participant_name END
      FROM file_collections fc JOIN rooms dest_room ON dest_room.id = fc.room_id
      WHERE cr.id = $3 AND cr.collection_id = fc.id AND cr.token_hash = $1 AND cr.status = 'submitting'
        AND fc.status = 'active' AND fc.expires_at > $2 AND (dest_room.expires_at IS NULL OR dest_room.expires_at > $2)
        AND NOT EXISTS (SELECT 1 FROM file_collection_uploads u WHERE u.recipient_id = cr.id AND u.submission_id IS NULL AND u.status = 'uploading'
          AND u.upload_session_hash = $6)
        AND NOT EXISTS (
          SELECT 1 FROM file_collection_items i WHERE i.collection_id = cr.collection_id AND i.required = 1
            AND (SELECT COUNT(*) FROM file_collection_uploads u WHERE u.recipient_id = cr.id AND u.item_id = i.id AND u.submission_id IS NULL AND u.status = 'ready'
              AND u.upload_session_hash = $6) < i.quantity
        )
      RETURNING cr.id, cr.collection_id
    ), submission AS (
      INSERT INTO file_collection_submissions (id, collection_id, recipient_id, sender_name, submitted_at)
      SELECT $5, cl.collection_id, cl.id, $4, $2 FROM claimed cl
      RETURNING id, collection_id, recipient_id
    ), staged_uploads AS (
      UPDATE file_collection_uploads u SET submission_id = s.id
      FROM submission s
      WHERE u.recipient_id = s.recipient_id AND u.collection_id = s.collection_id
        AND u.status = 'ready' AND u.submission_id IS NULL AND u.upload_session_hash = $6
      RETURNING u.id, u.collection_id
    ), created_files AS (
      INSERT INTO files (id, room_id, uploaded_by, original_name, stored_name, size, mime_type, uploaded_at)
      SELECT u.id, fc.room_id, fc.owner_id, u.original_name, u.stored_name, u.size, u.mime_type, $2
      FROM file_collection_uploads u JOIN staged_uploads staged ON staged.id = u.id
      JOIN file_collections fc ON fc.id = staged.collection_id
      RETURNING id
    ), copied_blobs AS (
      INSERT INTO file_blobs (file_id, data)
      SELECT b.upload_id, b.data FROM file_collection_upload_blobs b JOIN created_files f ON f.id = b.upload_id
      RETURNING file_id
    )
    SELECT id FROM claimed`, [tokenHash, submittedAt, recipient.id, senderName, submissionId, accessSessionHash]);
  } catch (error) {
    await q("UPDATE file_collection_recipients SET status = 'pending', submission_started_at = NULL WHERE id = $1 AND status = 'submitting' AND token_hash = $2", [recipient.id, tokenHash]).catch(() => {});
    throw error;
  }
  if (!completed.length) {
    await q("UPDATE file_collection_recipients SET status = 'pending', submission_started_at = NULL WHERE id = $1 AND status = 'submitting' AND token_hash = $2", [recipient.id, tokenHash]);
    const latest = await getCollectionRecipient(req.params.token);
    const accessError = collectionAccessError(latest, res);
    if (accessError) return accessError;
    const missing = await q(`SELECT i.label, i.quantity FROM file_collection_items i WHERE i.collection_id = $1 AND i.required = 1
      AND (SELECT COUNT(*) FROM file_collection_uploads u WHERE u.recipient_id = $2 AND u.item_id = i.id AND u.submission_id IS NULL AND u.status = 'ready'
        AND u.upload_session_hash = $3) < i.quantity`, [recipient.collection_id, recipient.id, accessSessionHash]);
    if (missing.length) return res.status(400).json({ error: 'Faltam arquivos obrigatórios: ' + missing.map(item => `${item.label} (${item.quantity})`).join(', ') });
    return res.status(409).json({ error: 'Ainda há arquivos sendo enviados. Aguarde o fim e tente novamente.' });
  }
  await q('DELETE FROM file_collection_upload_blobs WHERE upload_id IN (SELECT id FROM file_collection_uploads WHERE submission_id = $1)', [submissionId]).catch(error => console.error('Limpeza dos arquivos da coleta:', error && error.message));
  await notify(recipient.owner_id, 'Coleta concluída', `${senderName} enviou os arquivos de “${recipient.title}”.`, 'success').catch(() => {});
  clearCollectionAccessCookie(res, req.params.token);
  res.json({ success: true, state: recipient.multi_use_link ? 'multi_use_submitted' : 'submitted', multi_use_link: !!Number(recipient.multi_use_link) });
}));

app.get('/api/coletas/:id/zip', asMember, wrap(async (req, res) => {
  const collection = await requireCollectionOwner(req.params.id, req.user.id);
  if (!collection) return res.status(404).json({ error: 'Coleta não encontrada.' });
  const rows = await q(`SELECT u.id, u.stored_name, u.original_name, u.size, u.uploaded_at,
      CASE WHEN fc.multi_use_link = 1 THEN LOWER(TRIM(COALESCE(s.sender_name, r.participant_name))) ELSE COALESCE(s.id, r.id) END AS recipient_id,
      COALESCE(s.sender_name, r.participant_name) AS participant_name
    FROM file_collection_uploads u JOIN file_collection_recipients r ON r.id = u.recipient_id
    JOIN file_collections fc ON fc.id = u.collection_id
    LEFT JOIN file_collection_submissions s ON s.id = u.submission_id
    WHERE u.collection_id = $1 AND u.status = 'ready' AND (u.submission_id IS NOT NULL OR r.status = 'submitted')
    ORDER BY COALESCE(s.sender_name, r.participant_name), u.uploaded_at, u.id`, [collection.id]);
  const safeTitle = cleanCollectionFileName(collection.title).replace(/\.[^.]+$/, '').slice(0, 80) || 'coleta';
  const ascii = safeTitle.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') + '.zip';
  res.status(200);
  res.set({ 'Content-Type': 'application/zip', 'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safeTitle + '.zip')}` });
  try { await streamCollectionZip(res, rows, collection.title); }
  catch (error) {
    if (res.headersSent) return res.destroy(error);
    res.status(error.status || 500).json({ error: error.message || 'Não foi possível montar o ZIP.' });
  }
}));

app.get('/api/coletas/:id/participantes/:recipientId/zip', asMember, wrap(async (req, res) => {
  const collection = await requireCollectionOwner(req.params.id, req.user.id);
  if (!collection) return res.status(404).json({ error: 'Coleta não encontrada.' });
  const recipient = await one(`SELECT id, participant_name FROM file_collection_recipients
    WHERE id = $1 AND collection_id = $2 AND (status = 'submitted' OR EXISTS (
      SELECT 1 FROM file_collection_submissions s WHERE s.recipient_id = file_collection_recipients.id
    ))`, [req.params.recipientId, collection.id]);
  if (!recipient) return res.status(404).json({ error: 'Envio concluído não encontrado.' });
  const rows = await q(`SELECT u.id, u.stored_name, u.original_name, u.size, u.uploaded_at,
      COALESCE(s.id, r.id) AS recipient_id, COALESCE(s.sender_name, r.participant_name) AS participant_name
    FROM file_collection_uploads u JOIN file_collection_recipients r ON r.id = u.recipient_id
    LEFT JOIN file_collection_submissions s ON s.id = u.submission_id
    WHERE u.collection_id = $1 AND r.id = $2 AND u.status = 'ready' AND (u.submission_id IS NOT NULL OR r.status = 'submitted')
    ORDER BY u.uploaded_at, u.id`, [collection.id, recipient.id]);
  const safeName = cleanCollectionFileName(recipient.participant_name).replace(/\.[^.]+$/, '').slice(0, 80) || 'participante';
  const safeTitle = cleanCollectionFileName(collection.title).replace(/\.[^.]+$/, '').slice(0, 60) || 'coleta';
  const fileName = `${safeTitle} - ${safeName}`;
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') + '.zip';
  res.status(200);
  res.set({ 'Content-Type': 'application/zip', 'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName + '.zip')}` });
  try { await streamCollectionZip(res, rows, fileName); }
  catch (error) {
    if (res.headersSent) return res.destroy(error);
    res.status(error.status || 500).json({ error: error.message || 'Não foi possível montar o ZIP.' });
  }
}));

app.delete('/api/files/:id', requireAuth, wrap(async (req, res) => {
  const file = await one('SELECT f.id, f.uploaded_by, f.stored_name, r.created_by AS room_owner FROM files f LEFT JOIN rooms r ON r.id = f.room_id WHERE f.id = $1', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado' });
  if (!isAdmin(req.user) && file.uploaded_by !== req.user.id && file.room_owner !== req.user.id) return res.status(403).json({ error: 'Sem permissão' });
  await deleteBlobs([file.stored_name]);
  await q('DELETE FROM file_blobs WHERE file_id = $1', [file.id]);
  // Acervo e copia independente: apagar o arquivo da sala NAO apaga o Acervo.
  await q('DELETE FROM files WHERE id = $1', [file.id]);
  res.json({ success: true });
}));

// Renomear arquivo (só o nome exibido/baixado; o arquivo guardado não muda). Admin ou quem enviou.
app.patch('/api/files/:id', requireAuth, wrap(async (req, res) => {
  const file = await one('SELECT id, uploaded_by, original_name FROM files WHERE id = $1', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado' });
  if (!isAdmin(req.user) && file.uploaded_by !== req.user.id) return res.status(403).json({ error: 'Você só pode renomear arquivos enviados por você' });
  const name = String((req.body && req.body.name) || '').replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!name) return res.status(400).json({ error: 'Digite um nome para o arquivo' });
  await q('UPDATE files SET original_name = $1 WHERE id = $2', [name, file.id]);
  res.json({ success: true, id: file.id, original_name: name });
}));

app.get('/download/:fileId', asMember, wrap(async (req, res) => {
  const file = await one('SELECT id, room_id, original_name, mime_type, stored_name FROM files WHERE id = $1', [req.params.fileId]);
  if (!file) return res.status(404).send('Arquivo não encontrado');
  if (!(await canUseRoom(req.user, file.room_id))) return res.status(403).send('Sem permissão para baixar este arquivo');
  const ascii = file.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers = () => {
    res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.type(file.mime_type || 'application/octet-stream');
  };

  if (isBlobPath(file.stored_name)) {
    const { get } = await blobSdk();
    const result = await get(file.stored_name, { access: 'private' });
    if (!result || !result.stream) return res.status(404).send('Arquivo não encontrado');
    headers();
    const stream = Readable.fromWeb(result.stream);
    stream.on('error', err => { console.error('Erro no download:', err && err.message); res.destroy(err); });
    return stream.pipe(res);
  }

  // Arquivos antigos, guardados no Postgres
  const blob = await one("SELECT encode(data, 'base64') AS data FROM file_blobs WHERE file_id = $1", [file.id]);
  if (!blob) return res.status(404).send('Arquivo não encontrado');
  headers();
  res.send(Buffer.from(blob.data, 'base64'));
}));

// Visualização inline de arquivo (mesmas permissões do download).
app.get('/preview/:fileId', asMember, wrap(async (req, res) => {
  const file = await one('SELECT id, room_id, original_name, mime_type, stored_name FROM files WHERE id = $1', [req.params.fileId]);
  if (!file) return res.status(404).send('Arquivo não encontrado');
  if (!(await canUseRoom(req.user, file.room_id))) return res.status(403).send('Sem permissão para visualizar este arquivo');
  const declaredMime = String(file.mime_type || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const safeMediaMime = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac))$/.test(declaredMime);
  const textMime = declaredMime.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(declaredMime);
  const mime = safeMediaMime ? declaredMime : textMime ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  const ascii = String(file.original_name || 'arquivo').replace(/[^a-zA-Z0-9._ -]/g, '_');
  res.set('Content-Disposition', (safeMediaMime || textMime ? 'inline' : 'attachment') + '; filename="' + ascii + '"');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', mime);
  if (isBlobPath(file.stored_name)) {
    const { get } = await blobSdk();
    const result = await get(file.stored_name, { access: 'private' });
    if (!result || !result.stream) return res.status(404).send('Arquivo não encontrado');
    const stream = Readable.fromWeb(result.stream);
    stream.on('error', err => { console.error('Erro na visualização:', err && err.message); if (!res.headersSent) res.status(500).end(); else res.destroy(err); });
    return stream.pipe(res);
  }
  const blob = await one(`SELECT encode(data, 'base64') AS data FROM file_blobs WHERE file_id = $1`, [file.id]);
  if (!blob) return res.status(404).send('Arquivo não encontrado');
  res.send(Buffer.from(blob.data, 'base64'));
}));
// =================== PRESENÇA DE DIGITAÇÃO ===================
app.get('/api/rooms/:id/typing', requireAuth, wrap(async (req, res) => {
  if (!(await canUseRoom(req.user, req.params.id))) return res.status(403).json({ error:'Sem permissão' });
  await q('DELETE FROM room_typing WHERE room_id = $1 AND updated_at < $2', [req.params.id, agoTs(20000)]);
  const people = await q(`SELECT t.user_id, u.username FROM room_typing t
    JOIN users u ON u.id = t.user_id
    WHERE t.room_id = $1 AND t.user_id <> $2 AND t.updated_at >= $3
    ORDER BY t.updated_at ASC`, [req.params.id, req.user.id, agoTs(7000)]);
  res.json(people);
}));

app.post('/api/rooms/:id/typing', asMember, wrap(async (req, res) => {
  if (!(await canUseRoom(req.user, req.params.id))) return res.status(403).json({ error:'Entre na sala para usar o chat' });
  if (req.body && req.body.typing) {
    await q(`INSERT INTO room_typing (room_id, user_id, updated_at) VALUES ($1,$2,$3)
      ON CONFLICT (room_id, user_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`, [req.params.id, req.user.id, ts()]);
  } else {
    await q('DELETE FROM room_typing WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  }
  res.json({ ok:true });
}));
// =================== MENSAGENS ===================
app.get('/api/rooms/:id/messages', requireAuth, wrap(async (req, res) => {
  if (!(await canUseRoom(req.user, req.params.id))) return res.status(403).json({ error: 'Sem permissão' });
  const msgs = await q(`SELECT m.*, u.username, u.avatar_color, u.avatar_image, u.role, parent.content AS reply_content, parent_user.username AS reply_username
    FROM messages m JOIN users u ON m.user_id = u.id LEFT JOIN messages parent ON parent.id = m.reply_to_id
    LEFT JOIN users parent_user ON parent_user.id = parent.user_id WHERE m.room_id = $1 ORDER BY m.created_at DESC LIMIT 200`, [req.params.id]);
  res.json(msgs.reverse());
}));

app.post('/api/rooms/:id/messages', asMember, wrap(async (req, res) => {
  if (!(await canUseRoom(req.user, req.params.id))) return res.status(403).json({ error: 'Entre na sala para enviar mensagens' });
  const content = String((req.body && req.body.content) || '').trim().slice(0, 1000);
  if (!content) return res.status(400).json({ error: 'Mensagem vazia' });
  const replyTo = String((req.body && req.body.reply_to_id) || '').trim() || null;
  if (replyTo && !(await one('SELECT id FROM messages WHERE id = $1 AND room_id = $2', [replyTo, req.params.id]))) return res.status(400).json({ error: 'A mensagem escolhida para responder não está mais disponível.' });
  const id = uuidv4();
  await q('INSERT INTO messages (id, room_id, user_id, content, reply_to_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, req.params.id, req.user.id, content, replyTo, ts()]);
  res.json(await one(`SELECT m.*, u.username, u.avatar_color, u.role, parent.content AS reply_content, parent_user.username AS reply_username
    FROM messages m JOIN users u ON m.user_id = u.id LEFT JOIN messages parent ON parent.id = m.reply_to_id
    LEFT JOIN users parent_user ON parent_user.id = parent.user_id WHERE m.id = $1`, [id]));
}));

// =================== NOTIFICAÇÕES ===================
app.get('/api/notifications', requireAuth, wrap(async (req, res) => {
  res.json(await q('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]));
}));

app.post('/api/notifications/read', requireAuth, wrap(async (req, res) => {
  await q('UPDATE notifications SET "read" = 1 WHERE user_id = $1', [req.user.id]);
  res.json({ success: true });
}));

// =================== SALA (por slug) ===================
app.get('/api/sala/:slug', asMember, wrap(async (req, res) => {
  const room = await one('SELECT * FROM rooms WHERE slug = $1', [req.params.slug]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  if (!(await canUseRoom(req.user, room.id))) return res.status(403).json({ error: 'Entre na sala para acessar seus arquivos' });
  const files = await q(`SELECT f.id, f.original_name, f.size, f.mime_type, f.uploaded_at, f.uploaded_by, u.username AS uploader, u.role AS uploader_role
    FROM files f LEFT JOIN users u ON f.uploaded_by = u.id WHERE f.room_id = $1 ORDER BY f.uploaded_at DESC`, [room.id]);
  const count = await one('SELECT COUNT(*) AS c FROM room_members WHERE room_id = $1', [room.id]);
  res.json({ ...room, files: files.map(f => ({ ...f, size: num(f.size), can_edit: isAdmin(req.user) || f.uploaded_by === req.user.id, can_delete: isAdmin(req.user) || f.uploaded_by === req.user.id || room.created_by === req.user.id })), memberCount: num(count.c) });
}));

// =================== ESTATÍSTICAS / SENHA ===================

// =================== ADMIN+: painel avançado ===================
const adminTarget = wrap(async (req, res, next) => {
  const t = await one('SELECT id, username, role, status FROM users WHERE id = $1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Usuário não encontrado' });
  req.target = t; next();
});
const forceLogout = async uid => {
  await q('UPDATE users SET force_logout_at = $1 WHERE id = $2', [String(Date.now()), uid]);
  await q('DELETE FROM auth_tokens WHERE user_id = $1', [uid]);
};

app.get('/api/admin/overview', asAdmin, wrap(async (req, res) => {
  const d1 = agoTs(86400000), d7 = agoTs(7 * 86400000), online = agoTs(2 * 60000);
  const c = await one(`SELECT
    (SELECT COUNT(*) FROM users WHERE last_seen >= $1) AS online,
    (SELECT COUNT(*) FROM users WHERE status = 'banned') AS banned,
    (SELECT COUNT(*) FROM users WHERE created_at >= $2) AS new_users,
    (SELECT COUNT(*) FROM messages) AS messages,
    (SELECT COUNT(*) FROM files WHERE uploaded_at >= $3) AS uploads24,
    (SELECT COUNT(*) FROM rooms WHERE expires_at IS NOT NULL AND expires_at > $4) AS temp_rooms,
    (SELECT COUNT(*) FROM activity_log WHERE action = 'login_falhou' AND created_at >= $3) AS fails24`, [online, d7, d1, ts()]);
  const days = await q('SELECT SUBSTR(uploaded_at, 1, 10) AS d, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files WHERE uploaded_at >= $1 GROUP BY 1 ORDER BY 1', [agoTs(7 * 86400000)]);
  const top = await q(`SELECT u.username, u.role, COUNT(f.id) AS n, COALESCE(SUM(f.size),0) AS bytes FROM files f JOIN users u ON u.id = f.uploaded_by GROUP BY u.username, u.role ORDER BY bytes DESC LIMIT 5`);
  const big = await q(`SELECT f.id, f.original_name, f.size, r.name AS room, u.username FROM files f LEFT JOIN rooms r ON r.id = f.room_id LEFT JOIN users u ON u.id = f.uploaded_by ORDER BY f.size DESC LIMIT 5`);
  const onl = await q('SELECT username, role, avatar_color, last_seen FROM users WHERE last_seen >= $1 ORDER BY last_seen DESC LIMIT 20', [online]);
  const recent = await q('SELECT username, role, action, detail, created_at FROM activity_log ORDER BY created_at DESC LIMIT 8');
  res.json({
    online: num(c.online), banned: num(c.banned), newUsers: num(c.new_users), messages: num(c.messages), uploads24: num(c.uploads24), tempRooms: num(c.temp_rooms), fails24: num(c.fails24),
    days: days.map(x => ({ d: x.d, n: num(x.n), bytes: num(x.bytes) })),
    top: top.map(x => ({ ...x, n: num(x.n), bytes: num(x.bytes) })), big: big.map(x => ({ ...x, size: num(x.size) })), onlineUsers: onl, recent
  });
}));

app.get('/api/admin/users-plus', asAdmin, wrap(async (req, res) => {
  const online = agoTs(2 * 60000);
  const rows = await q(`SELECT u.id, u.username, u.email, u.role, u.status, u.avatar_color, u.created_at, u.last_login, u.last_seen, u.last_ip,
    (SELECT COUNT(*) FROM files f WHERE f.uploaded_by = u.id) AS files,
    (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.uploaded_by = u.id) AS bytes,
    (SELECT COUNT(*) FROM room_members m WHERE m.user_id = u.id) AS rooms,
    (SELECT COUNT(*) FROM messages g WHERE g.user_id = u.id) AS msgs
    FROM users u ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, u.created_at DESC`);
  res.json(rows.map(r => ({ ...r, files: num(r.files), bytes: num(r.bytes), rooms: num(r.rooms), msgs: num(r.msgs), online: !!(r.last_seen && r.last_seen >= online) })));
}));

app.get('/api/admin/users/:id/detail', asAdmin, adminTarget, wrap(async (req, res) => {
  const id = req.target.id;
  const user = await one('SELECT id, username, email, role, status, avatar_color, created_at, last_login, last_seen, last_ip FROM users WHERE id = $1', [id]);
  const files = await q('SELECT f.id, f.original_name, f.size, f.uploaded_at, r.name AS room FROM files f LEFT JOIN rooms r ON r.id = f.room_id WHERE f.uploaded_by = $1 ORDER BY f.uploaded_at DESC LIMIT 15', [id]);
  const rooms = await q('SELECT r.id, r.name FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.user_id = $1', [id]);
  const sessions = await q('SELECT created_at, user_agent FROM auth_tokens WHERE user_id = $1 AND expires_at > $2 ORDER BY created_at DESC', [id, ts()]);
  const activity = await q('SELECT action, detail, ip, created_at FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15', [id]);
  const fr = await q(`SELECT f.id, f.status, f.requester_id, f.created_at, u.username FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END WHERE f.requester_id = $1 OR f.addressee_id = $1 ORDER BY f.created_at DESC`, [id]);
  const friends = fr.filter(x => x.status === 'accepted').map(x => ({ id: x.id, username: x.username }));
  const pendingFriends = fr.filter(x => x.status !== 'accepted').map(x => ({ id: x.id, username: x.username, direction: x.requester_id === id ? 'enviado' : 'recebido' }));
  const privateRooms = await q('SELECT r.id, r.name, (r.created_by = $1) AS owner FROM rooms r WHERE r.is_public = 0 AND (r.created_by = $1 OR r.id IN (SELECT room_id FROM room_members WHERE user_id = $1)) ORDER BY r.created_at DESC', [id]);
  res.json({ user, files: files.map(f => ({ ...f, size: num(f.size) })), rooms, sessions, activity, friends, pendingFriends, privateRooms });
}));

app.post('/api/admin/users/:id/role', asAdmin, adminTarget, wrap(async (req, res) => {
  const role = req.body && req.body.role === 'admin' ? 'admin' : 'user';
  if (req.target.id === req.user.id) return res.status(400).json({ error: 'Você não pode mudar o próprio cargo' });
  await q("UPDATE users SET role = $1, status = CASE WHEN $1 = 'admin' THEN 'approved' ELSE status END WHERE id = $2", [role, req.target.id]);
  await notify(req.target.id, role === 'admin' ? 'Você agora é ADM' : 'Cargo alterado', role === 'admin' ? 'Um administrador promoveu sua conta a ADM.' : 'Seu cargo foi alterado para usuário.', 'info');
  await logAct(req, role === 'admin' ? 'promovido_adm' : 'rebaixado_usuario', req.target.username);
  res.json({ success: true });
}));
app.post('/api/admin/users/:id/ban', asAdmin, adminTarget, wrap(async (req, res) => {
  if (req.target.id === req.user.id || req.target.role === 'admin') return res.status(400).json({ error: 'Não é possível suspender um ADM' });
  await q("UPDATE users SET status = 'banned' WHERE id = $1", [req.target.id]);
  await forceLogout(req.target.id);
  await logAct(req, 'usuario_suspenso', req.target.username);
  res.json({ success: true });
}));
app.post('/api/admin/users/:id/unban', asAdmin, adminTarget, wrap(async (req, res) => {
  await q("UPDATE users SET status = 'approved' WHERE id = $1", [req.target.id]);
  await notify(req.target.id, 'Conta reativada', 'Sua conta foi reativada pelo administrador.', 'success');
  await logAct(req, 'usuario_reativado', req.target.username);
  res.json({ success: true });
}));
app.post('/api/admin/users/:id/logout', asAdmin, adminTarget, wrap(async (req, res) => {
  await forceLogout(req.target.id);
  await logAct(req, 'logout_forcado', req.target.username);
  res.json({ success: true });
}));
app.post('/api/admin/users/:id/reset-password', asAdmin, adminTarget, wrap(async (req, res) => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const temp = Array.from(crypto.randomBytes(24), b => chars[b % chars.length]).join('');
  await q('UPDATE users SET password_hash = $1, password_change_required = 1 WHERE id = $2', [await hashPassword(temp), req.target.id]);
  await forceLogout(req.target.id);
  await logAct(req, 'senha_redefinida', req.target.username);
  res.json({ success: true, password: temp });
}));

// Comunicados e configurações
app.post('/api/admin/broadcast', asAdmin, wrap(async (req, res) => {
  const title = String((req.body && req.body.title) || '').trim().slice(0, 80);
  const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
  const type = ['info', 'success', 'warning', 'error'].includes(req.body && req.body.type) ? req.body.type : 'info';
  if (!title || !message) return res.status(400).json({ error: 'Título e mensagem obrigatórios' });
  const users = await q("SELECT id FROM users WHERE status = 'approved' OR role = 'admin'");
  for (const u of users) await notify(u.id, title, message, type);
  await logAct(req, 'comunicado_enviado', title + ' (' + users.length + ' usuários)');
  res.json({ success: true, sent: users.length });
}));
app.get('/api/admin/settings', asAdmin, wrap(async (req, res) => {
  res.json({ registration_mode: await getSetting('registration_mode', 'approval'), announcement: await getSetting('announcement', ''), announcement_type: await getSetting('announcement_type', 'info') });
}));
app.post('/api/admin/settings', asAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (['approval', 'auto', 'closed'].includes(b.registration_mode)) await setSetting('registration_mode', b.registration_mode);
  if (typeof b.announcement === 'string') await setSetting('announcement', b.announcement.trim().slice(0, 300));
  if (['info', 'success', 'warning', 'error'].includes(b.announcement_type)) await setSetting('announcement_type', b.announcement_type);
  await logAct(req, 'configuracoes_alteradas', (b.registration_mode ? 'cadastro: ' + b.registration_mode + ' ' : '') + (typeof b.announcement === 'string' ? '| aviso atualizado' : ''));
  res.json({ success: true });
}));

// =================== AMIZADES + SALAS PRIVADAS ===================
const MAX_PRIVATE_ROOMS = 5;
const PAIR_SQL = '((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))';
async function friendshipBetween(a, b) { return one(`SELECT * FROM friendships WHERE ${PAIR_SQL}`, [a, b]); }
async function areFriends(a, b) { const f = await friendshipBetween(a, b); return !!(f && f.status === 'accepted'); }
// Quem remove um amigo o tira das salas privadas que ele (dono) criou
async function dropFromPrivateRooms(ownerId, friendId) {
  await q('DELETE FROM room_members WHERE user_id = $2 AND room_id IN (SELECT id FROM rooms WHERE created_by = $1 AND is_public = 0)', [ownerId, friendId]);
}
async function destroyRoom(id) {
  await removeRoomCollections(id);
  const roomFiles = await q('SELECT stored_name FROM files WHERE room_id = $1', [id]);
  try { await deleteBlobs(roomFiles.map(f => f.stored_name)); } catch (e) { console.error('blobs:', e && e.message); }
  await q('DELETE FROM file_blobs WHERE file_id IN (SELECT id FROM files WHERE room_id = $1)', [id]);
  // O Acervo pessoal guarda COPIAS independentes (snapshot). Excluir a sala NAO apaga o Acervo.
  await q('DELETE FROM files WHERE room_id = $1', [id]);
  await q('DELETE FROM room_members WHERE room_id = $1', [id]);
  await q('DELETE FROM messages WHERE room_id = $1', [id]);
  await q('DELETE FROM rooms WHERE id = $1', [id]);
}
const usableUser = u => u && (u.status === 'approved' || u.role === 'admin');

app.get('/api/friends', asMember, wrap(async (req, res) => {
  const me = req.user.id, online = agoTs(2 * 60000);
  const avatarColumn = req.query.avatars === '1' ? ', u.avatar_image' : '';
  const rows = await q(`SELECT f.id, f.requester_id, f.addressee_id, f.status, f.created_at, u.id AS uid, u.username, u.avatar_color${avatarColumn}, u.role, u.status AS ustatus, u.last_seen
    FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
    WHERE f.requester_id = $1 OR f.addressee_id = $1 ORDER BY f.created_at DESC`, [me]);
  const out = { friends: [], incoming: [], outgoing: [] };
  for (const r of rows) {
    if (!usableUser({ status: r.ustatus, role: r.role })) continue;
    const item = { id: r.id, user_id: r.uid, username: r.username, avatar_color: r.avatar_color, avatar_image: r.avatar_image || null, role: r.role, online: !!(r.last_seen && r.last_seen >= online), created_at: r.created_at };
    if (r.status === 'accepted') out.friends.push(item);
    else if (r.addressee_id === me) out.incoming.push(item);
    else out.outgoing.push(item);
  }
  out.friends.sort((a, b) => (b.online - a.online) || a.username.localeCompare(b.username));
  res.json(out);
}));

async function directFriend(req, res) {
  const target = await one('SELECT id, username, role, status, avatar_color, avatar_image FROM users WHERE id = $1', [req.params.id]);
  if (!target || !usableUser(target)) { res.status(404).json({ error: 'Amigo não encontrado.' }); return null; }
  if (!(await areFriends(req.user.id, target.id))) { res.status(403).json({ error: 'A conversa direta só está disponível entre amigos.' }); return null; }
  return target;
}

app.get('/api/dm/conversations', asMember, wrap(async (req, res) => {
  const me = req.user.id;
  const friends = await q(`SELECT u.id, u.username, u.role, u.avatar_color, u.avatar_image FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted' ORDER BY u.username`, [me]);
  const latestRows = await q(`SELECT id, sender_id, recipient_id, content, created_at FROM (
    SELECT dm.*, ROW_NUMBER() OVER (PARTITION BY CASE WHEN dm.sender_id = $1 THEN dm.recipient_id ELSE dm.sender_id END ORDER BY dm.created_at DESC, dm.id DESC) AS rn
    FROM direct_messages dm WHERE dm.sender_id = $1 OR dm.recipient_id = $1
  ) latest WHERE rn = 1`, [me]);
  const latestByFriend = new Map(latestRows.map(row => [row.sender_id === me ? row.recipient_id : row.sender_id, row]));
  const conversations = [];
  for (const friend of friends) {
    if (!usableUser(friend)) continue;
    const latest = latestByFriend.get(friend.id);
    conversations.push({ ...friend, latest_content: latest && latest.content, latest_at: latest && latest.created_at, latest_from_me: !!(latest && latest.sender_id === me) });
  }
  conversations.sort((a, b) => String(b.latest_at || '').localeCompare(String(a.latest_at || '')) || a.username.localeCompare(b.username));
  res.json(conversations);
}));

app.get('/api/dm/:id/messages', asMember, wrap(async (req, res) => {
  const friend = await directFriend(req, res); if (!friend) return;
  const me = req.user.id;
  const msgs = await q(`SELECT m.id, m.sender_id AS user_id, m.recipient_id, m.content, m.reply_to_id, m.created_at,
    u.username, u.avatar_color, u.avatar_image, u.role, parent.content AS reply_content, parent_user.username AS reply_username
    FROM direct_messages m JOIN users u ON u.id = m.sender_id LEFT JOIN direct_messages parent ON parent.id = m.reply_to_id
    LEFT JOIN users parent_user ON parent_user.id = parent.sender_id
    WHERE (m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1)
    ORDER BY m.created_at DESC LIMIT 150`, [me, friend.id]);
  res.json(msgs.reverse());
}));

app.post('/api/dm/:id/messages', asMember, wrap(async (req, res) => {
  const friend = await directFriend(req, res); if (!friend) return;
  const content = String((req.body && req.body.content) || '').trim().slice(0, 1000);
  if (!content) return res.status(400).json({ error: 'Mensagem vazia.' });
  const me = req.user.id;
  const replyTo = String((req.body && req.body.reply_to_id) || '').trim() || null;
  if (replyTo && !(await one(`SELECT id FROM direct_messages WHERE id = $1 AND
    ((sender_id = $2 AND recipient_id = $3) OR (sender_id = $3 AND recipient_id = $2))`, [replyTo, me, friend.id]))) {
    return res.status(400).json({ error: 'A mensagem escolhida para responder não está mais disponível.' });
  }
  const id = uuidv4(), createdAt = ts();
  await q('INSERT INTO direct_messages (id, sender_id, recipient_id, content, reply_to_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, me, friend.id, content, replyTo, createdAt]);
  await notify(friend.id, 'Nova mensagem de ' + req.user.username, content.slice(0, 140), 'info');
  res.json({ success: true, id, created_at: createdAt });
}));

app.post('/api/friends/request', asMember, wrap(async (req, res) => {
  const name = String((req.body && req.body.username) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Digite o nome da conta' });
  const target = await one('SELECT id, username, role, status FROM users WHERE LOWER(username) = LOWER($1) ORDER BY (username = $1) DESC LIMIT 1', [name]);
  if (!target || !usableUser(target)) return res.status(404).json({ error: 'Usuário não encontrado ou indisponível' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });
  const ex = await friendshipBetween(req.user.id, target.id);
  if (ex) {
    if (ex.status === 'accepted') return res.status(400).json({ error: 'Vocês já são amigos' });
    if (ex.requester_id === req.user.id) return res.status(400).json({ error: 'Você já enviou um pedido para essa conta' });
    await q("UPDATE friendships SET status = 'accepted', accepted_at = $1 WHERE id = $2", [ts(), ex.id]);
    await notify(target.id, 'Pedido de amizade aceito', `${req.user.username} agora é seu amigo.`, 'success');
    await logAct(req, 'amizade_aceita', target.username);
    return res.json({ success: true, accepted: true, username: target.username });
  }
  try {
    await q("INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES ($1,$2,$3,'pending',$4)", [uuidv4(), req.user.id, target.id, ts()]);
  } catch (e) { if (isUnique(e)) return res.status(400).json({ error: 'Já existe um pedido entre vocês' }); throw e; }
  await notify(target.id, 'Novo pedido de amizade', `${req.user.username} quer ser seu amigo.`, 'info');
  await logAct(req, 'pedido_amizade', target.username);
  res.json({ success: true, username: target.username });
}));

app.post('/api/friends/:id/accept', asMember, wrap(async (req, res) => {
  const f = await one("SELECT * FROM friendships WHERE id = $1 AND addressee_id = $2 AND status = 'pending'", [req.params.id, req.user.id]);
  if (!f) return res.status(404).json({ error: 'Pedido não encontrado' });
  const other = await one('SELECT id, username, role, status FROM users WHERE id = $1', [f.requester_id]);
  if (!usableUser(other)) return res.status(404).json({ error: 'Usuário indisponível' });
  await q("UPDATE friendships SET status = 'accepted', accepted_at = $1 WHERE id = $2", [ts(), f.id]);
  await notify(other.id, 'Pedido de amizade aceito', `${req.user.username} aceitou seu pedido.`, 'success');
  await logAct(req, 'amizade_aceita', other.username);
  res.json({ success: true });
}));

// Recusar, cancelar pedido enviado ou desfazer amizade
app.delete('/api/friends/:id', asMember, wrap(async (req, res) => {
  const f = await one('SELECT * FROM friendships WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2)', [req.params.id, req.user.id]);
  if (!f) return res.status(404).json({ error: 'Não encontrado' });
  const otherId = f.requester_id === req.user.id ? f.addressee_id : f.requester_id;
  const other = await one('SELECT username FROM users WHERE id = $1', [otherId]);
  await q('DELETE FROM friendships WHERE id = $1', [f.id]);
  if (f.status === 'accepted') { await dropFromPrivateRooms(req.user.id, otherId); await logAct(req, 'amizade_removida', other ? other.username : ''); }
  res.json({ success: true });
}));

// Membros de sala privada (dono ou ADM)
async function privateRoomGuard(req, res) {
  const room = await one('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) { res.status(404).json({ error: 'Sala não encontrada' }); return null; }
  if (!isAdmin(req.user) && (room.created_by !== req.user.id || room.is_public)) { res.status(403).json({ error: 'Só o dono da sala privada pode gerenciar membros' }); return null; }
  return room;
}
app.post('/api/rooms/:id/private-members', asMember, wrap(async (req, res) => {
  const room = await privateRoomGuard(req, res); if (!room) return;
  const admin = isAdmin(req.user);
  const userId = String((req.body && req.body.userId) || '');
  const target = await one('SELECT id, username, role, status FROM users WHERE id = $1', [userId]);
  if (!usableUser(target)) return res.status(404).json({ error: 'Usuário não encontrado ou indisponível' });
  if (!admin && !(await areFriends(req.user.id, target.id))) return res.status(403).json({ error: 'Só é possível adicionar amigos' });
  if (await isRoomMember(room.id, target.id)) return res.status(400).json({ error: 'Já é membro da sala' });
  if (!admin) {
    const count = num((await one('SELECT COUNT(*) AS c FROM room_members WHERE room_id = $1', [room.id])).c);
    if (count >= num(room.max_members)) return res.status(409).json({ error: 'A sala atingiu o limite de membros' });
  }
  await q("INSERT INTO room_members (id, room_id, user_id, role, joined_at) VALUES ($1,$2,$3,'member',$4) ON CONFLICT DO NOTHING", [uuidv4(), room.id, target.id, ts()]);
  await notify(target.id, 'Você foi adicionado a uma sala', `${req.user.username} adicionou você à sala "${room.name}".`, 'info');
  await logAct(req, admin ? 'adm_membro_adicionado' : 'membro_sala_privada_adicionado', `${target.username} → ${room.name}`);
  res.json({ success: true });
}));
app.delete('/api/rooms/:id/private-members/:userId', asMember, wrap(async (req, res) => {
  const room = await privateRoomGuard(req, res); if (!room) return;
  const admin = isAdmin(req.user);
  if (req.params.userId === room.created_by) return res.status(400).json({ error: 'O dono não pode ser removido (troque o dono antes)' });
  const target = await one('SELECT id, username FROM users WHERE id = $1', [req.params.userId]);
  await q('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [room.id, req.params.userId]);
  if (target) {
    await notify(target.id, 'Removido de uma sala', `Você foi removido da sala "${room.name}".`, 'warning');
    if (admin && room.created_by !== req.user.id) await notify(room.created_by, 'Um ADM alterou sua sala', `${target.username} foi removido da sala "${room.name}" por um administrador.`, 'warning');
  }
  await logAct(req, admin ? 'adm_membro_removido' : 'membro_sala_privada_removido', `${target ? target.username : req.params.userId} ← ${room.name}`);
  res.json({ success: true });
}));

// Renomear sala (dono da privada ou ADM)
app.patch('/api/rooms/:id', asMember, wrap(async (req, res) => {
  const room = await privateRoomGuard(req, res); if (!room) return;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const description = typeof (req.body && req.body.description) === 'string' ? req.body.description.slice(0, 300) : room.description;
  await q('UPDATE rooms SET name = $1, description = $2 WHERE id = $3', [name, description, room.id]);
  const admin = isAdmin(req.user);
  if (admin && room.created_by !== req.user.id) await notify(room.created_by, 'Um ADM alterou sua sala', `A sala "${room.name}" agora se chama "${name}".`, 'info');
  await logAct(req, admin ? 'adm_sala_privada_editada' : 'sala_renomeada', `${room.name} → ${name}`);
  res.json({ success: true });
}));

// Excluir sala (dono da privada ou ADM)
app.delete('/api/rooms/:id', asMember, wrap(async (req, res) => {
  const room = await privateRoomGuard(req, res); if (!room) return;
  const admin = isAdmin(req.user);
  await destroyRoom(room.id);
  if (admin && room.created_by !== req.user.id) await notify(room.created_by, 'Sala excluída por um ADM', `A sala "${room.name}" foi excluída por um administrador.`, 'warning');
  await logAct(req, admin ? 'adm_sala_privada_excluida' : 'sala_privada_excluida', room.name);
  res.json({ success: true });
}));

// ---- ADM: salas privadas e amizades ----
app.get('/api/admin/private-rooms', asAdmin, wrap(async (req, res) => {
  const rooms = await q(`SELECT r.id, r.name, r.slug, r.description, r.created_by, r.created_at, r.is_public, r.expires_at, ou.username AS owner_name,
    (SELECT COUNT(*) FROM files f WHERE f.room_id = r.id) AS files, (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS msgs
    FROM rooms r LEFT JOIN users ou ON ou.id = r.created_by WHERE r.is_public = 0 ORDER BY r.created_at DESC`);
  const members = await q('SELECT rm.room_id, u.id, u.username, u.avatar_color, u.avatar_image, u.role FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id IN (SELECT id FROM rooms WHERE is_public = 0)');
  res.json(rooms.map(r => ({ ...r, files: num(r.files), msgs: num(r.msgs), members: members.filter(m => m.room_id === r.id).map(({ room_id, ...m }) => m) })));
}));
app.post('/api/admin/rooms/:id/owner', asAdmin, wrap(async (req, res) => {
  const room = await one('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  const target = await one('SELECT id, username, role, status FROM users WHERE id = $1', [String((req.body && req.body.userId) || '')]);
  if (!usableUser(target)) return res.status(404).json({ error: 'Usuário não encontrado ou indisponível' });
  await q('UPDATE rooms SET created_by = $1 WHERE id = $2', [target.id, room.id]);
  await q("UPDATE room_members SET role = 'member' WHERE room_id = $1 AND role = 'owner'", [room.id]);
  await q("INSERT INTO room_members (id, room_id, user_id, role, joined_at) VALUES ($1,$2,$3,'owner',$4) ON CONFLICT (room_id, user_id) DO UPDATE SET role = 'owner'", [uuidv4(), room.id, target.id, ts()]);
  await notify(target.id, 'Você agora é dono de uma sala', `Um administrador tornou você dono da sala "${room.name}".`, 'info');
  if (room.created_by && room.created_by !== target.id) await notify(room.created_by, 'Dono da sala alterado', `A sala "${room.name}" agora pertence a ${target.username}.`, 'warning');
  await logAct(req, 'adm_sala_privada_editada', `${room.name}: novo dono ${target.username}`);
  res.json({ success: true });
}));
// ADM: muda a visibilidade (privada / pública / temporária)
app.post('/api/admin/rooms/:id/visibility', asAdmin, wrap(async (req, res) => {
  const room = await one('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  const visibilityBody = req.body || {};
  // Compatibilidade com os atalhos do painel ADM, que enviam is_public.
  const mode = String(visibilityBody.mode || (typeof visibilityBody.is_public === 'boolean' ? (visibilityBody.is_public ? 'public' : 'private') : '')).toLowerCase().trim();
  if (mode === 'private') await q('UPDATE rooms SET is_public = 0, expires_at = NULL WHERE id = $1', [room.id]);
  else if (mode === 'public') await q('UPDATE rooms SET is_public = 1, expires_at = NULL WHERE id = $1', [room.id]);
  else if (mode === 'temporary') {
    const mins = [5, 10, 30, 60].includes(Number(req.body.minutes)) ? Number(req.body.minutes) : 30;
    await q('UPDATE rooms SET is_public = 1, expires_at = $1 WHERE id = $2', [new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' '), room.id]);
  } else return res.status(400).json({ error: 'Modo inválido' });
  if (room.created_by && room.created_by !== req.user.id) await notify(room.created_by, 'Um ADM alterou sua sala', `A sala "${room.name}" agora é ${mode === 'private' ? 'privada' : mode === 'public' ? 'pública' : 'temporária'}.`, 'info');
  await logAct(req, 'adm_sala_privada_editada', `${room.name}: ${mode}`);
  res.json({ success: true });
}));
// ADM: apagar mensagem de qualquer sala
app.delete('/api/admin/messages/:id', asAdmin, wrap(async (req, res) => {
  const m = await one('SELECT m.id, m.room_id, r.name FROM messages m LEFT JOIN rooms r ON r.id = m.room_id WHERE m.id = $1', [req.params.id]);
  if (!m) return res.status(404).json({ error: 'Mensagem não encontrada' });
  await q('DELETE FROM messages WHERE id = $1', [m.id]);
  await logAct(req, 'adm_mensagem_excluida', m.name || '');
  res.json({ success: true });
}));
app.get('/api/admin/friendships', asAdmin, wrap(async (req, res) => {
  const search = '%' + String(req.query.q || '').trim().toLowerCase().replace(/[%_]/g, '') + '%';
  res.json(await q(`SELECT f.id, f.status, f.created_at, f.accepted_at, f.requester_id, f.addressee_id, a.username AS requester, b.username AS addressee
    FROM friendships f JOIN users a ON a.id = f.requester_id JOIN users b ON b.id = f.addressee_id
    WHERE LOWER(a.username) LIKE $1 OR LOWER(b.username) LIKE $1 ORDER BY f.created_at DESC LIMIT 300`, [search]));
}));
app.post('/api/admin/friendships', asAdmin, wrap(async (req, res) => {
  const find = n => one('SELECT id, username, role, status FROM users WHERE LOWER(username) = LOWER($1) ORDER BY (username = $1) DESC LIMIT 1', [String(n || '').trim().slice(0, 60)]);
  const a = await find(req.body && req.body.a), b = await find(req.body && req.body.b);
  if (!usableUser(a) || !usableUser(b)) return res.status(404).json({ error: 'Usuário não encontrado ou indisponível' });
  if (a.id === b.id) return res.status(400).json({ error: 'Escolha duas contas diferentes' });
  const ex = await friendshipBetween(a.id, b.id);
  if (ex && ex.status === 'accepted') return res.status(400).json({ error: 'Já são amigos' });
  if (ex) await q("UPDATE friendships SET status = 'accepted', accepted_at = $1 WHERE id = $2", [ts(), ex.id]);
  else await q("INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, accepted_at) VALUES ($1,$2,$3,'accepted',$4,$4)", [uuidv4(), a.id, b.id, ts()]);
  await notify(a.id, 'Nova amizade', `Um administrador conectou você a ${b.username}.`, 'info');
  await notify(b.id, 'Nova amizade', `Um administrador conectou você a ${a.username}.`, 'info');
  await logAct(req, 'adm_amizade_criada', `${a.username} ↔ ${b.username}`);
  res.json({ success: true });
}));
app.post('/api/admin/friendships/:id/accept', asAdmin, wrap(async (req, res) => {
  const f = await one("SELECT f.*, a.username AS ra, b.username AS rb FROM friendships f JOIN users a ON a.id = f.requester_id JOIN users b ON b.id = f.addressee_id WHERE f.id = $1", [req.params.id]);
  if (!f) return res.status(404).json({ error: 'Não encontrado' });
  await q("UPDATE friendships SET status = 'accepted', accepted_at = $1 WHERE id = $2", [ts(), f.id]);
  await notify(f.requester_id, 'Pedido de amizade aceito', `Um administrador aceitou seu pedido para ${f.rb}.`, 'success');
  await notify(f.addressee_id, 'Nova amizade', `Um administrador aceitou o pedido de ${f.ra}.`, 'info');
  await logAct(req, 'adm_amizade_criada', `${f.ra} ↔ ${f.rb} (forçada)`);
  res.json({ success: true });
}));
app.delete('/api/admin/friendships/:id', asAdmin, wrap(async (req, res) => {
  const f = await one("SELECT f.*, a.username AS ra, b.username AS rb FROM friendships f JOIN users a ON a.id = f.requester_id JOIN users b ON b.id = f.addressee_id WHERE f.id = $1", [req.params.id]);
  if (!f) return res.status(404).json({ error: 'Não encontrado' });
  await q('DELETE FROM friendships WHERE id = $1', [f.id]);
  if (f.status === 'accepted') { await dropFromPrivateRooms(f.requester_id, f.addressee_id); await dropFromPrivateRooms(f.addressee_id, f.requester_id); }
  await notify(f.requester_id, 'Amizade removida', `Um administrador removeu a ligação com ${f.rb}.`, 'warning');
  await notify(f.addressee_id, 'Amizade removida', `Um administrador removeu a ligação com ${f.ra}.`, 'warning');
  await logAct(req, 'adm_amizade_removida', `${f.ra} ↔ ${f.rb}`);
  res.json({ success: true });
}));

// Pulso do site (a cada 2s): versão publicada, sessão, aviso global e novas notificações
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || '';
app.get('/api/live', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const out = { v: BUILD_ID, auth: false };
  if (req.session && req.session.userId) {
    const u = await one('SELECT id, username, role, status, force_logout_at FROM users WHERE id = $1', [req.session.userId]);
    if (u && u.status !== 'banned' && u.status !== 'rejected' && !(u.force_logout_at && Number(req.session.at || 0) <= Number(u.force_logout_at))) {
      out.auth = true; out.role = u.role; out.status = u.status;
      out.ann = { text: await getSetting('announcement', ''), type: await getSetting('announcement_type', 'info') };
      out.unread = num((await one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND "read" = 0', [u.id])).c);
      out.latest = await q('SELECT id, title, message, type FROM notifications WHERE user_id = $1 AND "read" = 0 ORDER BY created_at DESC LIMIT 3', [u.id]);
    }
  }
  res.json(out);
}));
app.get('/api/announcement', requireAuth, wrap(async (req, res) => {
  res.json({ text: await getSetting('announcement', ''), type: await getSetting('announcement_type', 'info') });
}));
app.get('/api/public/registration', wrap(async (req, res) => { res.json({ mode: await getSetting('registration_mode', 'approval') }); }));

// Central de arquivos
app.get('/api/admin/files', asAdmin, wrap(async (req, res) => {
  const search = '%' + String(req.query.q || '').trim().toLowerCase().replace(/[%_]/g, '') + '%';
  const rows = await q(`SELECT f.id, f.original_name, f.mime_type, f.size, f.uploaded_at, f.room_id, r.name AS room, u.username AS uploader, u.role AS uploader_role
    FROM files f LEFT JOIN rooms r ON r.id = f.room_id LEFT JOIN users u ON u.id = f.uploaded_by
    WHERE LOWER(f.original_name) LIKE $1 OR LOWER(COALESCE(u.username,'')) LIKE $1 OR LOWER(COALESCE(r.name,'')) LIKE $1
    ORDER BY f.uploaded_at DESC LIMIT 300`, [search]);
  res.json(rows.map(f => ({ ...f, size: num(f.size) })));
}));
app.post('/api/admin/files/bulk-delete', asAdmin, wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(x => typeof x === 'string').slice(0, 200) : [];
  let n = 0;
  for (const id of ids) {
    const f = await one('SELECT id, stored_name FROM files WHERE id = $1', [id]);
    if (!f) continue;
    try { await deleteBlobs([f.stored_name]); } catch (e) {}
    await q('DELETE FROM file_blobs WHERE file_id = $1', [f.id]);
    // Acervo e copia independente: exclusao em massa na sala NAO apaga o Acervo.
    await q('DELETE FROM files WHERE id = $1', [f.id]);
    n++;
  }
  await logAct(req, 'arquivos_excluidos_em_massa', n + ' arquivo(s)');
  res.json({ success: true, deleted: n });
}));

// Salas: tempo, visibilidade, limpar chat, moderar mensagens
app.post('/api/admin/rooms/:id/extend', asAdmin, wrap(async (req, res) => {
  const room = await one('SELECT id, name, expires_at FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  const minutes = Number(req.body && req.body.minutes);
  if (minutes === 0) { await q('UPDATE rooms SET expires_at = NULL WHERE id = $1', [room.id]); await logAct(req, 'sala_permanente', room.name); return res.json({ success: true }); }
  if (!(minutes > 0 && minutes <= 10080)) return res.status(400).json({ error: 'Tempo inválido' });
  const base = room.expires_at && room.expires_at > ts() ? new Date(room.expires_at.replace(' ', 'T') + 'Z').getTime() : Date.now();
  await q('UPDATE rooms SET expires_at = $1 WHERE id = $2', [new Date(base + minutes * 60000).toISOString().slice(0, 19).replace('T', ' '), room.id]);
  await logAct(req, 'sala_tempo_alterado', room.name + ' +' + minutes + ' min');
  res.json({ success: true });
}));
app.post('/api/admin/rooms/:id/visibility', asAdmin, wrap(async (req, res) => {
  const room = await one('SELECT id, name FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  const pub = req.body && req.body.is_public ? 1 : 0;
  await q('UPDATE rooms SET is_public = $1 WHERE id = $2', [pub, room.id]);
  await logAct(req, 'sala_visibilidade', room.name + ' → ' + (pub ? 'pública' : 'privada'));
  res.json({ success: true });
}));
app.post('/api/admin/rooms/:id/clear-chat', asAdmin, wrap(async (req, res) => {
  const room = await one('SELECT id, name FROM rooms WHERE id = $1', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  await q('DELETE FROM messages WHERE room_id = $1', [room.id]);
  await logAct(req, 'chat_limpo', room.name);
  res.json({ success: true });
}));
app.delete('/api/admin/messages/:id', asAdmin, wrap(async (req, res) => {
  await q('DELETE FROM messages WHERE id = $1', [req.params.id]);
  await logAct(req, 'mensagem_removida', req.params.id.slice(0, 8));
  res.json({ success: true });
}));
app.get('/api/admin/rooms-lite', asAdmin, wrap(async (req, res) => {
  res.json(await q('SELECT r.id, r.name, r.expires_at, (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS msgs FROM rooms r ORDER BY r.created_at DESC'));
}));

// Atividade
app.get('/api/admin/log', asAdmin, wrap(async (req, res) => {
  const action = String(req.query.action || '');
  const search = '%' + String(req.query.q || '').trim().toLowerCase().replace(/[%_]/g, '') + '%';
  const rows = await q(`SELECT username, role, action, detail, ip, user_agent, created_at FROM activity_log
    WHERE ($1 = '' OR action = $1) AND (LOWER(COALESCE(username,'')) LIKE $2 OR LOWER(COALESCE(detail,'')) LIKE $2 OR COALESCE(ip,'') LIKE $2)
    ORDER BY created_at DESC LIMIT 300`, [action, search]);
  res.json(rows);
}));
app.get('/api/admin/export', asAdmin, wrap(async (req, res) => {
  const data = {
    exported_at: ts(),
    users: await q('SELECT id, username, email, role, status, created_at, last_login, last_seen FROM users'),
    rooms: await q('SELECT id, name, slug, is_public, created_by, created_at, expires_at FROM rooms'),
    files: await q('SELECT id, original_name, mime_type, size, room_id, uploaded_by, uploaded_at FROM files'),
    activity: await q('SELECT username, action, detail, ip, created_at FROM activity_log ORDER BY created_at DESC LIMIT 2000')
  };
  await logAct(req, 'backup_exportado', '');
  res.setHeader('Content-Disposition', 'attachment; filename="fileshare-backup-' + ts().slice(0, 10) + '.json"');
  res.json(data);
}));

app.get('/api/admin/stats', asAdmin, wrap(async (req, res) => {
  const s = await one(`SELECT
    (SELECT COUNT(*) FROM users) AS total_users,
    (SELECT COUNT(*) FROM users WHERE status = 'pending') AS pending_users,
    (SELECT COUNT(*) FROM rooms) AS total_rooms,
    (SELECT COUNT(*) FROM files) AS total_files,
    (SELECT COALESCE(SUM(size), 0) FROM files) AS total_size`);
  res.json({
    totalUsers: num(s.total_users), pendingUsers: num(s.pending_users),
    totalRooms: num(s.total_rooms), totalFiles: num(s.total_files), totalSize: num(s.total_size)
  });
}));

app.post('/api/change-password', requireAuth, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (await consumeRateLimit('change-password:' + req.user.id, 8, 15 * 60 * 1000)) return res.status(429).json({ error: 'Muitas tentativas para alterar a senha. Aguarde e tente novamente.' });
  const user = await one('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id]);
  const currentVerification = await verifyPassword(String(currentPassword || ''), user.password_hash);
  if (!currentVerification.matches) return res.status(400).json({ error: 'Senha atual incorreta' });
  if (!passwordMeetsPolicy(newPassword)) return res.status(400).json({ error: `Use uma senha com pelo menos ${MIN_PASSWORD_LENGTH} caracteres (até ${MAX_PASSWORD_LENGTH}).` });
  await q('UPDATE users SET password_hash = $1, password_change_required = 0 WHERE id = $2', [await hashPassword(newPassword), user.id]);
  // Encerra sessões e tokens antigos; mantém somente a sessão que acabou de trocar a senha.
  const loggedOutAt = Date.now();
  await q('UPDATE users SET force_logout_at = $1 WHERE id = $2', [String(loggedOutAt), user.id]);
  await q('DELETE FROM auth_tokens WHERE user_id = $1', [user.id]);
  req.session.at = loggedOutAt + 1;
  try { await issueRememberToken(req, res, user.id); } catch (e) { console.error('revoke tokens:', e && e.message); }
  res.json({ success: true, role: req.user.role });
}));

// ===== Servidor da sala (somente modo local e somente ADM) =====
app.get('/api/admin/local-server/status', asAdmin, wrap(async (req, res) => {
  res.json({
    available: LOCAL_MODE,
    active: Boolean(LOCAL_MODE && localLanServer && localLanServer.listening),
    port: LOCAL_LAN_PORT,
    addresses: LOCAL_MODE && localLanServer && localLanServer.listening ? localLanAddresses() : []
  });
}));
app.post('/api/admin/local-server/start', asAdmin, wrap(async (req, res) => {
  if (!LOCAL_MODE) return res.status(404).json({ error: 'Servidor local indisponível nesta instalação' });
  try {
    await startLocalLanServer();
    const addresses = localLanAddresses();
    console.log('\n📡 Servidor da sala ativado pelo ADM:');
    if (addresses.length) addresses.forEach(item => console.log('   ' + item.url));
    else console.log('   Nenhum endereço de rede encontrado; conecte este computador ao Wi-Fi/roteador da sala.');
    res.json({ success: true, active: true, port: LOCAL_LAN_PORT, addresses });
  } catch (error) {
    console.error('Falha ao abrir servidor da sala:', error && error.message);
    const message = error && error.code === 'EADDRINUSE'
      ? 'A porta ' + LOCAL_LAN_PORT + ' já está em uso. Feche o outro servidor ou escolha outra porta.'
      : 'Não foi possível abrir o servidor da sala. Verifique a rede e tente novamente.';
    res.status(409).json({ error: message });
  }
}));
app.post('/api/admin/local-server/stop', asAdmin, wrap(async (req, res) => {
  if (!LOCAL_MODE) return res.status(404).json({ error: 'Servidor local indisponível nesta instalação' });
  await stopLocalLanServer();
  res.json({ success: true, active: false });
}));

// =================== ERROS ===================
app.use((err, req, res, next) => {
  const safePath = String(req.path || '').replace(/(\/enviar\/)[^/]+/g, '$1[redacted]');
  console.error('Erro em', req.method, safePath, '-', err && err.stack || err);
  if (res.headersSent) return next(err);
  const message = 'Erro interno do servidor. Tente novamente.';
  if (req.originalUrl.startsWith('/api/')) return res.status(500).json({ error: message });
  res.status(500).send(message);
});

if (require.main === module || process.env.FILESHARE_LOCAL_BOOTSTRAP === '1') {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = LOCAL_MODE ? '127.0.0.1' : process.env.HOST;
  ensureDatabase().then(() => {
    const server = app.listen(PORT, ...(HOST ? [HOST] : []), () => {
      console.log(`\n🚀 FileShare ${LOCAL_MODE ? 'na rede local' : 'rodando'} em http://localhost:${PORT}`);
      if (LOCAL_MODE) {
        console.log('\n🔒 O servidor está acessível apenas neste computador até um ADM liberá-lo para a sala.');
        console.log('   Entre como admin e use o botão “Servidor da sala” no painel ADM.');
        console.log('\n⏹ Para encerrar o servidor, pressione Ctrl+C nesta janela.');
        if (process.env.FILESHARE_NO_BROWSER !== '1') {
          const url = `http://127.0.0.1:${PORT}`;
          const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
          try { spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) {}
        }
      } else {
        console.log('🔐 A senha administrativa inicial é definida pela variável ADMIN_PASSWORD.\n');
      }
    });
    if (LOCAL_MODE) {
      const shutdown = () => {
        console.log('\n⏹ Encerrando servidor e salvando dados...');
        if (localLanServer) {
          const lanListener = localLanServer;
          localLanServer = null;
          try { lanListener.close(); if (typeof lanListener.closeAllConnections === 'function') lanListener.closeAllConnections(); } catch (e) {}
        }
        server.close(async () => {
          try { if (localDatabasePromise) await (await localDatabasePromise).close(); } catch (e) {}
          process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    }
  }).catch(err => { console.error('Erro ao iniciar:', err); process.exit(1); });
} else {
  module.exports = app;
}
