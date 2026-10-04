const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { neon } = require('@neondatabase/serverless');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
app.set('trust proxy', 1);

const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');
const dataDir = process.env.VERCEL ? path.join('/tmp', 'data') : path.join(__dirname, 'data');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.VERCEL ? path.join('/tmp', 'database.sqlite') : path.join(dataDir, 'database.sqlite');
const postgresEnabled = Boolean(process.env.VERCEL && process.env.POSTGRES_URL);
const sql = postgresEnabled ? neon(process.env.POSTGRES_URL) : null;
let db;
let dbInitPromise;
let postgresInitPromise;
let persistencePromise = Promise.resolve();

async function initDatabase() {
  if (db) return;
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  let persistentData;
  if (postgresEnabled) {
    await ensurePostgres();
    const rows = await sql`SELECT encode(data, 'hex') AS data_hex FROM fileshare_state WHERE id = 1`;
    if (rows[0]?.data_hex) persistentData = Buffer.from(rows[0].data_hex, 'hex');
  }
  if (persistentData) {
    db = new SQL.Database(persistentData);
  } else if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'pending',
    avatar_color TEXT DEFAULT '#4f46e5',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    slug TEXT UNIQUE NOT NULL,
    is_public INTEGER DEFAULT 0,
    max_members INTEGER DEFAULT 50,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS room_members (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now')),
    UNIQUE(room_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    uploaded_by TEXT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT DEFAULT 'application/octet-stream',
    uploaded_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info',
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  migrateDatabase();

  // Seed admin
  const admin = queryOne("SELECT id FROM users WHERE role = 'admin'");
  if (!admin) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(adminPassword, 10);
    const adminId = uuidv4();
    runSql('INSERT INTO users (id, username, email, password_hash, role, status, avatar_color) VALUES (?,?,?,?,?,?,?)',
      [adminId, 'admin', 'admin@fileshare.com', hash, 'admin', 'approved', '#ef4444']);
    console.log('✅ Admin criado');
  }
  saveDb();
}

function ensureDatabase() {
  if (!dbInitPromise) dbInitPromise = initDatabase();
  return dbInitPromise;
}

function saveDb() {
  const data = Buffer.from(db.export());
  fs.writeFileSync(dbPath, data);
  if (postgresEnabled) {
    persistencePromise = persistencePromise.then(() => sql`
      INSERT INTO fileshare_state (id, data, updated_at) VALUES (1, decode(${data.toString('hex')}, 'hex'), NOW())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `);
  }
  return persistencePromise;
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function runSql(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function ensurePostgres() {
  if (!postgresEnabled) return Promise.resolve();
  if (!postgresInitPromise) {
    postgresInitPromise = Promise.all([
      sql`CREATE TABLE IF NOT EXISTS fileshare_state (id INTEGER PRIMARY KEY, data BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      sql`CREATE TABLE IF NOT EXISTS fileshare_files (stored_name TEXT PRIMARY KEY, data BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    ]);
  }
  return postgresInitPromise;
}

function saveFileToPostgres(storedName, data) {
  if (!postgresEnabled) return Promise.resolve();
  return ensurePostgres().then(() => sql`
    INSERT INTO fileshare_files (stored_name, data, updated_at) VALUES (${storedName}, decode(${Buffer.from(data).toString('hex')}, 'hex'), NOW())
    ON CONFLICT (stored_name) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `);
}

async function restoreFileFromPostgres(file) {
  if (!postgresEnabled) return null;
  await ensurePostgres();
  const rows = await sql`SELECT encode(data, 'hex') AS data_hex FROM fileshare_files WHERE stored_name = ${file.stored_name}`;
  if (!rows[0]?.data_hex) return null;
  const localPath = path.join(uploadsDir, file.stored_name);
  fs.writeFileSync(localPath, Buffer.from(rows[0].data_hex, 'hex'));
  return localPath;
}

function ensureColumn(table, column, definition) {
  const columns = queryAll(`PRAGMA table_info(${table})`);
  if (!columns.some(item => item.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateDatabase() {
  ensureColumn('rooms', 'is_public', 'INTEGER DEFAULT 1');
  ensureColumn('rooms', 'max_members', 'INTEGER DEFAULT 50');
  ensureColumn('rooms', 'created_by', 'TEXT');
  ensureColumn('files', 'uploaded_by', 'TEXT');
  saveDb();
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(cookieSession({
  name: 'fileshare_session',
  keys: [process.env.SESSION_SECRET || 'fileshare-local-development-secret'],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: Boolean(process.env.VERCEL),
  sameSite: 'lax'
}));
app.use((req, res, next) => {
  ensureDatabase().then(() => persistencePromise).then(next).catch(next);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// Auth helpers
function requireAuth(req, res, next) {
  if (req.session && req.session.userId && queryOne('SELECT id FROM users WHERE id = ?', [req.session.userId])) return next();
  res.status(401).json({ error: 'Não autorizado' });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Acesso restrito ao administrador' });
}
function requireApproved(req, res, next) {
  const user = req.session && req.session.userId ? queryOne('SELECT role, status FROM users WHERE id = ?', [req.session.userId]) : null;
  if (user) {
    req.session.role = user.role;
    req.session.status = user.status;
  }
  if (user && (user.status === 'approved' || user.role === 'admin')) return next();
  res.status(403).json({ error: 'Conta aguardando aprovação' });
}

function generateSlug(name) {
  let slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'sala-' + Date.now().toString(36);
  if (queryOne('SELECT id FROM rooms WHERE slug = ?', [slug])) slug += '-' + Date.now().toString(36);
  return slug;
}

function roomForRequest(roomId, userId) {
  const room = queryOne('SELECT * FROM rooms WHERE id = ?', [roomId]);
  if (!room) return null;
  if (room.is_public || queryOne('SELECT id FROM room_members WHERE room_id = ? AND user_id = ?', [roomId, userId])) return room;
  return null;
}

// =================== PAGE ROUTES ===================
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect(req.session.role === 'admin' ? '/admin' : '/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/admin', (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/dashboard', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  const user = queryOne('SELECT role, status FROM users WHERE id = ?', [req.session.userId]);
  if (!user) return res.redirect('/');
  req.session.role = user.role;
  req.session.status = user.status;
  if (user.status !== 'approved' && user.role !== 'admin') {
    return res.sendFile(path.join(__dirname, 'public', 'pending.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/sala/:slug', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  const room = queryOne('SELECT * FROM rooms WHERE slug = ?', [req.params.slug]);
  if (!room) return res.status(404).send('Sala não encontrada');
  const user = queryOne('SELECT role, status FROM users WHERE id = ?', [req.session.userId]);
  if (!user || (user.status !== 'approved' && user.role !== 'admin')) return res.redirect('/dashboard');
  const isMember = req.session && (req.session.role === 'admin' || queryOne('SELECT id FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, req.session.userId]));
  if (user.role !== 'admin' && !isMember) return res.status(403).send('Entre na sala para acessar seus arquivos');
  res.sendFile(path.join(__dirname, 'public', 'sala.html'));
});

// =================== AUTH API ===================
app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha mínima: 4 caracteres' });
  if (queryOne('SELECT id FROM users WHERE username = ?', [username]))
    return res.status(400).json({ error: 'Usuário já existe' });
  if (queryOne('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(400).json({ error: 'Email já cadastrado' });

  const colors = ['#4f46e5','#ef4444','#22c55e','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#f97316'];
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const color = colors[Math.floor(Math.random() * colors.length)];
  runSql('INSERT INTO users (id, username, email, password_hash, avatar_color) VALUES (?,?,?,?,?)',
    [id, username, email, hash, color]);

  // Notify admin
  const admins = queryAll("SELECT id FROM users WHERE role = 'admin'");
  admins.forEach(a => {
    runSql('INSERT INTO notifications (id, user_id, title, message, type) VALUES (?,?,?,?,?)',
      [uuidv4(), a.id, 'Novo cadastro', `${username} solicitou acesso ao sistema.`, 'warning']);
  });

  res.json({ success: true, message: 'Conta criada! Aguarde aprovação do administrador.' });
});

app.post('/api/login', (req, res) => {
  const identifier = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = queryOne('SELECT * FROM users WHERE username = ? OR email = ?', [identifier, identifier.toLowerCase()]);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Credenciais inválidas' });
  if (user.status === 'rejected')
    return res.status(403).json({ error: 'Sua conta foi rejeitada pelo administrador' });

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.status = user.status;
  res.json({ success: true, role: user.role, status: user.status });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ success: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  const user = queryOne('SELECT id, username, email, role, status, avatar_color, created_at FROM users WHERE id = ?', [req.session.userId]);
  const unreadNotifs = queryAll('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0', [req.session.userId]);
  res.json({ ...user, unread_notifications: unreadNotifs[0]?.count || 0 });
});

// =================== ADMIN: USER MANAGEMENT ===================
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = queryAll("SELECT id, username, email, role, status, avatar_color, created_at FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC");
  res.json(users);
});

app.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  const user = queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  runSql("UPDATE users SET status = 'approved' WHERE id = ?", [user.id]);
  runSql('INSERT INTO notifications (id, user_id, title, message, type) VALUES (?,?,?,?,?)',
    [uuidv4(), user.id, 'Conta aprovada!', 'Sua conta foi aprovada pelo administrador. Bem-vindo ao FileShare!', 'success']);
  res.json({ success: true });
});

app.post('/api/admin/users/:id/reject', requireAdmin, (req, res) => {
  const user = queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  runSql("UPDATE users SET status = 'rejected' WHERE id = ?", [user.id]);
  runSql('INSERT INTO notifications (id, user_id, title, message, type) VALUES (?,?,?,?,?)',
    [uuidv4(), user.id, 'Conta rejeitada', 'Sua solicitação de acesso foi negada.', 'error']);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Não pode excluir a si mesmo' });
  runSql('DELETE FROM room_members WHERE user_id = ?', [req.params.id]);
  runSql('DELETE FROM notifications WHERE user_id = ?', [req.params.id]);
  runSql('DELETE FROM messages WHERE user_id = ?', [req.params.id]);
  runSql('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// =================== ROOMS ===================
app.post('/api/rooms', requireAdmin, (req, res) => {
  const { name, description, is_public } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  const id = uuidv4();
  const slug = generateSlug(name.trim());
  runSql('INSERT INTO rooms (id, name, description, slug, is_public, created_by) VALUES (?,?,?,?,?,?)',
    [id, name.trim(), description || '', slug, is_public ? 1 : 0, req.session.userId]);
  res.json(queryOne('SELECT * FROM rooms WHERE id = ?', [id]));
});

app.get('/api/rooms', requireAuth, requireApproved, (req, res) => {
  let rooms;
  if (req.session.role === 'admin') {
    rooms = queryAll('SELECT * FROM rooms ORDER BY created_at DESC');
  } else {
    rooms = queryAll(`SELECT r.* FROM rooms r
      LEFT JOIN room_members rm ON r.id = rm.room_id AND rm.user_id = ?
      WHERE r.is_public = 1 OR rm.user_id IS NOT NULL
      ORDER BY r.created_at DESC`, [req.session.userId]);
  }
  const result = rooms.map(room => {
    const files = queryAll('SELECT f.*, u.username as uploader FROM files f LEFT JOIN users u ON f.uploaded_by = u.id WHERE f.room_id = ? ORDER BY f.uploaded_at DESC', [room.id]);
    const members = queryAll(`SELECT u.id, u.username, u.avatar_color, rm.role, rm.joined_at
      FROM room_members rm JOIN users u ON rm.user_id = u.id WHERE rm.room_id = ?`, [room.id]);
    const memberCount = members.length;
    const isMember = req.session.role === 'admin' || members.some(m => m.id === req.session.userId);
    return { ...room, files, members, fileCount: files.length, memberCount, isMember };
  });
  res.json(result);
});

app.get('/api/rooms/browse', requireAuth, requireApproved, (req, res) => {
  const allRooms = queryAll(`SELECT DISTINCT r.* FROM rooms r
    LEFT JOIN room_members rm ON r.id = rm.room_id AND rm.user_id = ?
    WHERE r.is_public = 1 OR rm.user_id IS NOT NULL ORDER BY r.created_at DESC`, [req.session.userId]);
  const result = allRooms.map(room => {
    const memberCount = queryAll('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?', [room.id])[0]?.c || 0;
    const isMember = !!queryOne('SELECT id FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, req.session.userId]);
    const fileCount = queryAll('SELECT COUNT(*) as c FROM files WHERE room_id = ?', [room.id])[0]?.c || 0;
    return { ...room, memberCount, isMember, fileCount };
  });
  res.json(result);
});

app.post('/api/rooms/:id/join', requireAuth, requireApproved, (req, res) => {
  const room = queryOne('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  const existing = queryOne('SELECT id FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, req.session.userId]);
  if (existing) return res.status(400).json({ error: 'Já é membro desta sala' });
  const memberCount = queryOne('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?', [room.id]).count;
  if (memberCount >= room.max_members) return res.status(409).json({ error: 'Esta sala atingiu o limite de membros' });
  runSql('INSERT INTO room_members (id, room_id, user_id) VALUES (?,?,?)', [uuidv4(), room.id, req.session.userId]);
  res.json({ success: true });
});

app.post('/api/rooms/:id/leave', requireAuth, (req, res) => {
  runSql('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  res.json({ success: true });
});

app.delete('/api/rooms/:id', requireAdmin, async (req, res) => {
  const files = queryAll('SELECT * FROM files WHERE room_id = ?', [req.params.id]);
  for (const file of files) {
    try { fs.unlinkSync(path.join(uploadsDir, file.stored_name)); } catch(e){}
    if (postgresEnabled) await ensurePostgres().then(() => sql`DELETE FROM fileshare_files WHERE stored_name = ${file.stored_name}`);
  }
  runSql('DELETE FROM files WHERE room_id = ?', [req.params.id]);
  runSql('DELETE FROM room_members WHERE room_id = ?', [req.params.id]);
  runSql('DELETE FROM messages WHERE room_id = ?', [req.params.id]);
  runSql('DELETE FROM rooms WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// =================== ROOM MEMBERS (admin) ===================
app.post('/api/rooms/:id/members', requireAdmin, (req, res) => {
  const { userId } = req.body;
  const existing = queryOne('SELECT id FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, userId]);
  if (existing) return res.status(400).json({ error: 'Já é membro' });
  runSql('INSERT INTO room_members (id, room_id, user_id) VALUES (?,?,?)', [uuidv4(), req.params.id, userId]);
  res.json({ success: true });
});

app.delete('/api/rooms/:roomId/members/:userId', requireAdmin, (req, res) => {
  runSql('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.roomId, req.params.userId]);
  res.json({ success: true });
});

// =================== FILES ===================
app.post('/api/rooms/:id/files', requireAuth, requireApproved, upload.array('files', 20), async (req, res) => {
  const room = queryOne('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  const isAdmin = req.session.role === 'admin';
  const isMember = !!queryOne('SELECT id FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, req.session.userId]);
  if (!isAdmin && !isMember) return res.status(403).json({ error: 'Entre na sala antes de enviar arquivos' });

  const inserted = [];
  for (const file of req.files) {
    if (postgresEnabled) await saveFileToPostgres(file.filename, fs.readFileSync(file.path));
    const fid = uuidv4();
    runSql('INSERT INTO files (id, room_id, uploaded_by, original_name, stored_name, size, mime_type) VALUES (?,?,?,?,?,?,?)',
      [fid, room.id, req.session.userId, file.originalname, file.filename, file.size, file.mimetype]);
    inserted.push({ id: fid, original_name: file.originalname, size: file.size, mime_type: file.mimetype });
  }
  res.json(inserted);
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const file = queryOne('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado' });
  if (req.session.role !== 'admin' && file.uploaded_by !== req.session.userId)
    return res.status(403).json({ error: 'Sem permissão' });
  try { fs.unlinkSync(path.join(uploadsDir, file.stored_name)); } catch(e){}
  if (postgresEnabled) await ensurePostgres().then(() => sql`DELETE FROM fileshare_files WHERE stored_name = ${file.stored_name}`);
  runSql('DELETE FROM files WHERE id = ?', [file.id]);
  res.json({ success: true });
});

app.get('/download/:fileId', requireAuth, requireApproved, async (req, res) => {
  const file = queryOne('SELECT * FROM files WHERE id = ?', [req.params.fileId]);
  if (!file) return res.status(404).send('Arquivo não encontrado');
  const room = queryOne('SELECT * FROM rooms WHERE id = ?', [file.room_id]);
  const isMember = req.session.role === 'admin' || !!queryOne('SELECT id FROM room_members WHERE room_id = ? AND user_id = ?', [file.room_id, req.session.userId]);
  if (!room || !isMember) return res.status(403).send('Sem permissão para baixar este arquivo');
  const fp = path.join(uploadsDir, file.stored_name);
  if (!fs.existsSync(fp)) await restoreFileFromPostgres(file);
  if (!fs.existsSync(fp)) return res.status(404).send('Arquivo não encontrado');
  res.download(fp, file.original_name);
});

// =================== MESSAGES (chat in room) ===================
app.get('/api/rooms/:id/messages', requireAuth, (req, res) => {
  if (!roomForRequest(req.params.id, req.session.userId) && req.session.role !== 'admin') return res.status(403).json({ error: 'Sem permissão' });
  const msgs = queryAll(`SELECT m.*, u.username, u.avatar_color FROM messages m
    JOIN users u ON m.user_id = u.id WHERE m.room_id = ? ORDER BY m.created_at ASC LIMIT 200`, [req.params.id]);
  res.json(msgs);
});

app.post('/api/rooms/:id/messages', requireAuth, requireApproved, (req, res) => {
  if (!roomForRequest(req.params.id, req.session.userId) && req.session.role !== 'admin') return res.status(403).json({ error: 'Entre na sala para enviar mensagens' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Mensagem vazia' });
  const id = uuidv4();
  runSql('INSERT INTO messages (id, room_id, user_id, content) VALUES (?,?,?,?)',
    [id, req.params.id, req.session.userId, content.trim()]);
  const msg = queryOne(`SELECT m.*, u.username, u.avatar_color FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?`, [id]);
  res.json(msg);
});

// =================== NOTIFICATIONS ===================
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifs = queryAll('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.session.userId]);
  res.json(notifs);
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  runSql('UPDATE notifications SET read = 1 WHERE user_id = ?', [req.session.userId]);
  res.json({ success: true });
});

// =================== PUBLIC ROOM ===================
app.get('/api/sala/:slug', requireAuth, requireApproved, (req, res) => {
  const room = queryOne('SELECT * FROM rooms WHERE slug = ?', [req.params.slug]);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  if (req.session.role !== 'admin' && !queryOne('SELECT id FROM room_members WHERE room_id = ? AND user_id = ?', [room.id, req.session.userId])) return res.status(403).json({ error: 'Entre na sala para acessar seus arquivos' });
  const files = queryAll('SELECT id, original_name, size, mime_type, uploaded_at FROM files WHERE room_id = ? ORDER BY uploaded_at DESC', [room.id]);
  const memberCount = queryAll('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?', [room.id])[0]?.c || 0;
  res.json({ ...room, files, memberCount });
});

// =================== ADMIN STATS ===================
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalUsers = queryAll('SELECT COUNT(*) as c FROM users')[0]?.c || 0;
  const pendingUsers = queryAll("SELECT COUNT(*) as c FROM users WHERE status = 'pending'")[0]?.c || 0;
  const totalRooms = queryAll('SELECT COUNT(*) as c FROM rooms')[0]?.c || 0;
  const totalFiles = queryAll('SELECT COUNT(*) as c FROM files')[0]?.c || 0;
  const totalSize = queryAll('SELECT COALESCE(SUM(size),0) as s FROM files')[0]?.s || 0;
  res.json({ totalUsers, pendingUsers, totalRooms, totalFiles, totalSize });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = queryOne('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!bcrypt.compareSync(currentPassword, user.password_hash))
    return res.status(400).json({ error: 'Senha atual incorreta' });
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: 'Mínimo 4 caracteres' });
  runSql('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), user.id]);
  res.json({ success: true });
});

app.use((error, req, res, next) => {
  console.error('Request failed:', error?.stack || JSON.stringify(error));
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

if (require.main === module) {
  ensureDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 FileShare rodando em http://localhost:${PORT}`);
      console.log(`🔐 Admin: admin / admin123\n`);
    });
  }).catch(err => { console.error('Erro:', err); process.exit(1); });
} else {
  module.exports = app;
}
