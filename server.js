const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { neon } = require('@neondatabase/serverless');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

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

// ---------------------------------------------------------------------------
// Vercel Blob (armazenamento privado dos arquivos). Na Vercel a autenticação é por OIDC
// (BLOB_STORE_ID + VERCEL_OIDC_TOKEN, injetados automaticamente). Sem essas variáveis
// (ex.: rodando local sem `vercel env pull`), cai no Postgres como antes.
// ---------------------------------------------------------------------------
const blobSdk = () => import('@vercel/blob');
const blobEnabled = () => Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
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
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL não definida. Configure a integração Neon na Vercel (ou o .env.local).');
}
const sql = DATABASE_URL ? neon(DATABASE_URL) : null;

// ---------------------------------------------------------------------------
// Helpers de banco (Postgres/Neon). Cada consulta é uma chamada HTTP sem estado,
// então todas as instâncias serverless enxergam exatamente os mesmos dados.
// ---------------------------------------------------------------------------
async function q(text, params = []) {
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
      created_at TEXT
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
  await q('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS expires_at TEXT');
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
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    await q(`INSERT INTO users (id, username, email, password_hash, role, status, avatar_color, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [uuidv4(), 'admin', 'admin@fileshare.com', hash, 'admin', 'approved', '#ef4444', ts()]);
    console.log('✅ Admin criado');
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon-48.png')));
app.use(cookieSession({
  name: 'fileshare_session',
  keys: [process.env.SESSION_SECRET || 'fileshare-local-development-secret'],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: IS_VERCEL,
  sameSite: 'lax'
}));
app.use(wrap(async (req, res, next) => { await ensureDatabase(); next(); }));

// Salas temporárias: apaga a sala, arquivos e mensagens quando o tempo acaba
let lastPurge = 0;
async function purgeExpired() {
  if (Date.now() - lastPurge < 3000) return;
  lastPurge = Date.now();
  const old = await q('SELECT id FROM rooms WHERE expires_at IS NOT NULL AND expires_at <= $1', [ts()]);
  for (const r of old) {
    const roomFiles = await q('SELECT stored_name FROM files WHERE room_id = $1', [r.id]);
    try { await deleteBlobs(roomFiles.map(f => f.stored_name)); } catch (e) { console.error('purge blobs:', e && e.message); }
    await q('DELETE FROM file_blobs WHERE file_id IN (SELECT id FROM files WHERE room_id = $1)', [r.id]);
    await q('DELETE FROM files WHERE room_id = $1', [r.id]);
    await q('DELETE FROM room_members WHERE room_id = $1', [r.id]);
    await q('DELETE FROM messages WHERE room_id = $1', [r.id]);
    await q('DELETE FROM rooms WHERE id = $1', [r.id]);
  }
}
app.use(wrap(async (req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/sala/')) { try { await purgeExpired(); } catch (e) { console.error('purge:', e && e.message); } } next(); }));

// Arquivos ficam no próprio Postgres. Na Vercel o corpo da requisição é limitado a ~4,5 MB.
const MAX_FILE_BYTES = IS_VERCEL ? 4 * 1024 * 1024 : 50 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 20 } });

// ---------------------------------------------------------------------------
// Autenticação (sempre confere o usuário no banco — nada depende só do cookie)
// ---------------------------------------------------------------------------
const requireAuth = wrap(async (req, res, next) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Não autorizado' });
  const user = await one('SELECT id, username, role, status FROM users WHERE id = $1', [req.session.userId]);
  if (!user) { req.session = null; return res.status(401).json({ error: 'Não autorizado' }); }
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

// =================== PÁGINAS ===================
const page = name => path.join(__dirname, 'public', name);

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
  const user = await one('SELECT role FROM users WHERE id = $1', [req.session.userId]);
  if (!user || user.role !== 'admin') return res.redirect('/');
  res.sendFile(page('admin.html'));
}));
app.get('/dashboard', wrap(async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  const user = await one('SELECT role, status FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.redirect('/');
  if (!isApproved(user)) return res.sendFile(page('pending.html'));
  res.sendFile(page('dashboard.html'));
}));
app.get('/sala/:slug', wrap(async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  const user = await one('SELECT id, role, status FROM users WHERE id = $1', [req.session.userId]);
  if (!user || !isApproved(user)) return res.redirect('/dashboard');
  const room = await one('SELECT id FROM rooms WHERE slug = $1', [req.params.slug]);
  if (!room) return res.status(404).send('Sala não encontrada');
  if (!(await canUseRoom(user, room.id))) return res.status(403).send('Entre na sala para acessar seus arquivos');
  res.sendFile(page('sala.html'));
}));

// =================== AUTH API ===================
app.post('/api/register', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha mínima: 4 caracteres' });
  if (await one('SELECT id FROM users WHERE username = $1', [username])) return res.status(400).json({ error: 'Usuário já existe' });
  if (await one('SELECT id FROM users WHERE email = $1', [email])) return res.status(400).json({ error: 'Email já cadastrado' });

  const colors = ['#4f46e5', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
  try {
    await q('INSERT INTO users (id, username, email, password_hash, avatar_color, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), username, email, bcrypt.hashSync(password, 10), colors[Math.floor(Math.random() * colors.length)], ts()]);
  } catch (e) {
    if (isUnique(e)) return res.status(400).json({ error: 'Usuário ou email já cadastrado' });
    throw e;
  }
  const admins = await q("SELECT id FROM users WHERE role = 'admin'");
  await Promise.all(admins.map(a => notify(a.id, 'Novo cadastro', `${username} solicitou acesso ao sistema.`, 'warning')));
  res.json({ success: true, message: 'Conta criada! Aguarde aprovação do administrador.' });
}));

app.post('/api/login', wrap(async (req, res) => {
  const identifier = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = await one('SELECT * FROM users WHERE username = $1 OR email = $2', [identifier, identifier.toLowerCase()]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Credenciais inválidas' });
  if (user.status === 'rejected') return res.status(403).json({ error: 'Sua conta foi rejeitada pelo administrador' });
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.status = user.status;
  res.json({ success: true, role: user.role, status: user.status });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ success: true }); });

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const user = await one('SELECT id, username, email, role, status, avatar_color, created_at FROM users WHERE id = $1', [req.user.id]);
  const unread = await one('SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND "read" = 0', [req.user.id]);
  res.json({ ...user, unread_notifications: num(unread && unread.count), max_upload_bytes: blobEnabled() ? MAX_DIRECT_BYTES : MAX_FILE_BYTES });
}));

// =================== ADMIN: USUÁRIOS ===================
app.get('/api/admin/users', asAdmin, wrap(async (req, res) => {
  res.json(await q(`SELECT id, username, email, role, status, avatar_color, created_at FROM users
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC`));
}));

app.post('/api/admin/users/:id/approve', asAdmin, wrap(async (req, res) => {
  const user = await one('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  await q("UPDATE users SET status = 'approved' WHERE id = $1", [user.id]);
  await notify(user.id, 'Conta aprovada!', 'Sua conta foi aprovada pelo administrador. Bem-vindo ao FileShare!', 'success');
  res.json({ success: true });
}));

app.post('/api/admin/users/:id/reject', asAdmin, wrap(async (req, res) => {
  const user = await one('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  await q("UPDATE users SET status = 'rejected' WHERE id = $1", [user.id]);
  await notify(user.id, 'Conta rejeitada', 'Sua solicitação de acesso foi negada.', 'error');
  res.json({ success: true });
}));

app.delete('/api/admin/users/:id', asAdmin, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  await q('DELETE FROM room_members WHERE user_id = $1', [req.params.id]);
  await q('DELETE FROM notifications WHERE user_id = $1', [req.params.id]);
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
  if (!admin) {
    // Usuário comum: só sala pública e temporária (5, 10 ou 30 min)
    if (![5, 10, 30].includes(minutes)) return res.status(400).json({ error: 'Escolha 5, 10 ou 30 minutos' });
    const active = num((await one('SELECT COUNT(*) AS c FROM rooms WHERE created_by = $1 AND expires_at IS NOT NULL AND expires_at > $2', [req.user.id, ts()])).c);
    if (active >= 3) return res.status(429).json({ error: 'Você já tem 3 salas temporárias ativas' });
    isPublic = 1;
  }
  if (minutes && [5, 10, 30].includes(minutes)) expiresAt = new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
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
  if (!admin) await q('INSERT INTO room_members (id, room_id, user_id, joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [uuidv4(), id, req.user.id, ts()]);
  res.json(await one('SELECT * FROM rooms WHERE id = $1', [id]));
}));

// Lista salas visíveis para o usuário com arquivos e membros, em 3 consultas no total
async function loadRooms(user) {
  const cond = isAdmin(user) ? '1=1' : '(is_public = 1 OR id IN (SELECT room_id FROM room_members WHERE user_id = $1))';
  const params = isAdmin(user) ? [] : [user.id];
  const [rooms, files, members] = await Promise.all([
    q(`SELECT * FROM rooms WHERE ${cond} ORDER BY created_at DESC`, params),
    q(`SELECT f.id, f.room_id, f.uploaded_by, f.original_name, f.size, f.mime_type, f.uploaded_at, u.username AS uploader, u.role AS uploader_role
       FROM files f LEFT JOIN users u ON f.uploaded_by = u.id
       WHERE f.room_id IN (SELECT id FROM rooms WHERE ${cond}) ORDER BY f.uploaded_at DESC`, params),
    q(`SELECT rm.room_id, u.id, u.username, u.avatar_color, rm.role, rm.joined_at
       FROM room_members rm JOIN users u ON rm.user_id = u.id
       WHERE rm.room_id IN (SELECT id FROM rooms WHERE ${cond})`, params)
  ]);
  return rooms.map(room => {
    const roomFiles = files.filter(f => f.room_id === room.id).map(f => ({ ...f, size: num(f.size), can_edit: isAdmin(user), can_delete: isAdmin(user) || f.uploaded_by === user.id || room.created_by === user.id }));
    const roomMembers = members.filter(m => m.room_id === room.id).map(({ room_id, ...m }) => m);
    return {
      ...room,
      files: roomFiles,
      members: roomMembers,
      fileCount: roomFiles.length,
      memberCount: roomMembers.length,
      isMember: isAdmin(user) || roomMembers.some(m => m.id === user.id)
    };
  });
}

app.get('/api/rooms', asMember, wrap(async (req, res) => {
  res.json(await loadRooms(req.user));
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
  await q('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

app.delete('/api/rooms/:id', asAdmin, wrap(async (req, res) => {
  const id = req.params.id;
  const roomFiles = await q('SELECT stored_name FROM files WHERE room_id = $1', [id]);
  await deleteBlobs(roomFiles.map(f => f.stored_name));
  await q('DELETE FROM file_blobs WHERE file_id IN (SELECT id FROM files WHERE room_id = $1)', [id]);
  await q('DELETE FROM files WHERE room_id = $1', [id]);
  await q('DELETE FROM room_members WHERE room_id = $1', [id]);
  await q('DELETE FROM messages WHERE room_id = $1', [id]);
  await q('DELETE FROM rooms WHERE id = $1', [id]);
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
  res.json({ success: true });
}));

app.delete('/api/rooms/:roomId/members/:userId', asAdmin, wrap(async (req, res) => {
  await q('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [req.params.roomId, req.params.userId]);
  res.json({ success: true });
}));

// =================== ARQUIVOS ===================
app.post('/api/rooms/:id/files', asMember, (req, res, next) => {
  upload.array('files', 20)(req, res, err => {
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
  const { issueSignedToken, presignUrl } = await blobSdk();
  const validUntil = Date.now() + 15 * 60 * 1000;
  const token = await issueSignedToken({ pathname, operations: ['put'], maximumSizeInBytes: MAX_DIRECT_BYTES, validUntil });
  const { presignedUrl } = await presignUrl(token, {
    operation: 'put',
    pathname,
    access: 'private',
    maximumSizeInBytes: MAX_DIRECT_BYTES,
    addRandomSuffix: false,
    allowOverwrite: false,
    validUntil
  });
  res.json({ pathname, presignedUrl });
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
  } catch (e) {
    if (e && e.name === 'BlobNotFoundError') return res.status(400).json({ error: 'O envio do arquivo não foi concluído' });
    console.error('head do Blob falhou (usando o tamanho informado):', e && e.message);
  }
  if (size > MAX_DIRECT_BYTES) {
    await deleteBlobs([pathname]);
    return res.status(413).json({ error: 'Arquivo grande demais' });
  }

  const name = String(req.body.name || '').trim().slice(0, 255) || 'arquivo';
  const mime = String(req.body.mime || '').slice(0, 100) || 'application/octet-stream';
  await q('INSERT INTO files (id, room_id, uploaded_by, original_name, stored_name, size, mime_type, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [m[2], room.id, req.user.id, name, pathname, size, mime, ts()]);
  res.json({ id: m[2], original_name: name, size });
}));

app.delete('/api/files/:id', requireAuth, wrap(async (req, res) => {
  const file = await one('SELECT f.id, f.uploaded_by, f.stored_name, r.created_by AS room_owner FROM files f LEFT JOIN rooms r ON r.id = f.room_id WHERE f.id = $1', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado' });
  if (!isAdmin(req.user) && file.uploaded_by !== req.user.id && file.room_owner !== req.user.id) return res.status(403).json({ error: 'Sem permissão' });
  await deleteBlobs([file.stored_name]);
  await q('DELETE FROM file_blobs WHERE file_id = $1', [file.id]);
  await q('DELETE FROM files WHERE id = $1', [file.id]);
  res.json({ success: true });
}));

// Renomear arquivo (só o nome exibido/baixado; o arquivo guardado não muda). Admin ou quem enviou.
app.patch('/api/files/:id', requireAuth, wrap(async (req, res) => {
  const file = await one('SELECT id, uploaded_by, original_name FROM files WHERE id = $1', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Sem permissão' });
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

// =================== MENSAGENS ===================
app.get('/api/rooms/:id/messages', requireAuth, wrap(async (req, res) => {
  if (!(await canUseRoom(req.user, req.params.id))) return res.status(403).json({ error: 'Sem permissão' });
  const msgs = await q(`SELECT m.*, u.username, u.avatar_color, u.role FROM messages m
    JOIN users u ON m.user_id = u.id WHERE m.room_id = $1 ORDER BY m.created_at DESC LIMIT 200`, [req.params.id]);
  res.json(msgs.reverse());
}));

app.post('/api/rooms/:id/messages', asMember, wrap(async (req, res) => {
  if (!(await canUseRoom(req.user, req.params.id))) return res.status(403).json({ error: 'Entre na sala para enviar mensagens' });
  const content = String((req.body && req.body.content) || '').trim().slice(0, 1000);
  if (!content) return res.status(400).json({ error: 'Mensagem vazia' });
  const id = uuidv4();
  await q('INSERT INTO messages (id, room_id, user_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
    [id, req.params.id, req.user.id, content, ts()]);
  res.json(await one('SELECT m.*, u.username, u.avatar_color, u.role FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = $1', [id]));
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
  res.json({ ...room, files: files.map(f => ({ ...f, size: num(f.size), can_edit: isAdmin(req.user), can_delete: isAdmin(req.user) || f.uploaded_by === req.user.id || room.created_by === req.user.id })), memberCount: num(count.c) });
}));

// =================== ESTATÍSTICAS / SENHA ===================
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
  const user = await one('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) return res.status(400).json({ error: 'Senha atual incorreta' });
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'Mínimo 4 caracteres' });
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(newPassword), 10), user.id]);
  res.json({ success: true });
}));

// =================== ERROS ===================
app.use((err, req, res, next) => {
  console.error('Erro em', req.method, req.originalUrl, '-', err && err.stack || err);
  if (res.headersSent) return next(err);
  const message = 'Erro interno do servidor. Tente novamente.';
  if (req.originalUrl.startsWith('/api/')) return res.status(500).json({ error: message });
  res.status(500).send(message);
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  ensureDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 FileShare rodando em http://localhost:${PORT}`);
      console.log('🔐 Admin: admin / admin123 (ou ADMIN_PASSWORD)\n');
    });
  }).catch(err => { console.error('Erro ao iniciar:', err); process.exit(1); });
} else {
  module.exports = app;
}
