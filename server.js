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
  for (const col of ['last_login', 'last_seen', 'last_ip', 'force_logout_at']) await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} TEXT`);
  await q(`CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY, user_id TEXT, username TEXT, role TEXT, action TEXT NOT NULL, detail TEXT, ip TEXT, user_agent TEXT, created_at TEXT
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at)');
  await q('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  await q(`CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT,
    expires_at TEXT NOT NULL,
    user_agent TEXT
  )`);
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
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: IS_VERCEL,
  sameSite: 'lax'
}));
app.use(wrap(async (req, res, next) => { await ensureDatabase(); next(); }));

// ===== Login persistente ("lembrar de mim") =====
// Além do cookie de sessão, guardamos um token longo (1 ano) no navegador; só o hash dele fica no banco.
const crypto = require('crypto');
const REMEMBER_COOKIE = 'fs_remember';
const REMEMBER_DAYS = 365;
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
  if (req.session && req.session.userId) {
    req.session.nowInMinutes = Math.floor(Date.now() / 60000); // renova o cookie de sessão a cada visita
    return next();
  }
  const token = readCookie(req, REMEMBER_COOKIE);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    try {
      const row = await one('SELECT a.user_id, a.expires_at, u.username, u.role, u.status FROM auth_tokens a JOIN users u ON u.id = a.user_id WHERE a.token_hash = $1', [hashToken(token)]);
      if (row && row.expires_at > ts() && row.status !== 'rejected' && row.status !== 'banned') {
        req.session.at = Date.now();
        req.session.userId = row.user_id; req.session.username = row.username; req.session.role = row.role; req.session.status = row.status;
      } else if (!row || row.expires_at <= ts()) {
        res.clearCookie(REMEMBER_COOKIE, { path: '/' });
      }
    } catch (e) { console.error('remember:', e && e.message); }
  }
  next();
}));

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
  const user = await one('SELECT id, username, role, status, last_seen, force_logout_at FROM users WHERE id = $1', [req.session.userId]);
  if (!user) { req.session = null; return res.status(401).json({ error: 'Não autorizado' }); }
  if (user.status === 'banned' || (user.force_logout_at && Number(req.session.at || 0) <= Number(user.force_logout_at))) {
    req.session = null; res.clearCookie(REMEMBER_COOKIE, { path: '/' });
    return res.status(401).json({ error: user.status === 'banned' ? 'Conta suspensa' : 'Sessão encerrada pelo administrador' });
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
const clientIp = req => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
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
// Anti força-bruta (memória do servidor; melhor esforço)
const loginFails = new Map();
function failKey(req, id) { return clientIp(req) + '|' + String(id).toLowerCase().slice(0, 60); }
function tooManyFails(req, id) {
  const r = loginFails.get(failKey(req, id));
  return !!(r && r.n >= 8 && Date.now() - r.t < 10 * 60000);
}
function addFail(req, id) {
  const k = failKey(req, id); const r = loginFails.get(k);
  if (!r || Date.now() - r.t > 10 * 60000) loginFails.set(k, { n: 1, t: Date.now() }); else { r.n++; r.t = Date.now(); }
}
// Registra ações de usuários (uploads, salas, arquivos) antes de responder — seguro em serverless
function classifyAct(req) {
  const p = req.path, m = req.method;
  let r;
  if (m === 'POST' && p === '/api/rooms') return ['sala_criada', req.body && req.body.name];
  if (m === 'DELETE' && (r = /^\/api\/rooms\/([^/]+)$/.exec(p))) return ['sala_excluida', r[1].slice(0, 8)];
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
  const regMode = await getSetting('registration_mode', 'approval');
  if (regMode === 'closed') return res.status(403).json({ error: 'Os cadastros estão fechados no momento.' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha mínima: 4 caracteres' });
  if (await one('SELECT id FROM users WHERE username = $1', [username])) return res.status(400).json({ error: 'Usuário já existe' });
  if (await one('SELECT id FROM users WHERE email = $1', [email])) return res.status(400).json({ error: 'Email já cadastrado' });

  const colors = ['#4f46e5', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
  try {
    await q('INSERT INTO users (id, username, email, password_hash, avatar_color, created_at, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [uuidv4(), username, email, bcrypt.hashSync(password, 10), colors[Math.floor(Math.random() * colors.length)], ts(), regMode === 'auto' ? 'approved' : 'pending']);
    await logAct(req, 'cadastro', username, { username });
  } catch (e) {
    if (isUnique(e)) return res.status(400).json({ error: 'Usuário ou email já cadastrado' });
    throw e;
  }
  const admins = await q("SELECT id FROM users WHERE role = 'admin'");
  await Promise.all(admins.map(a => notify(a.id, 'Novo cadastro', `${username} solicitou acesso ao sistema.`, 'warning')));
  res.json({ success: true, message: regMode === 'auto' ? 'Conta criada! Você já pode entrar.' : 'Conta criada! Aguarde aprovação do administrador.' });
}));

app.post('/api/login', wrap(async (req, res) => {
  const identifier = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = await one('SELECT * FROM users WHERE username = $1 OR email = $2', [identifier, identifier.toLowerCase()]);
  if (tooManyFails(req, identifier)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 10 minutos.' });
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    addFail(req, identifier);
    await logAct(req, 'login_falhou', identifier.slice(0, 60), { username: user ? user.username : null, id: user ? user.id : null, role: user ? user.role : null });
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  if (user.status === 'rejected') return res.status(403).json({ error: 'Sua conta foi rejeitada pelo administrador' });
  if (user.status === 'banned') { await logAct(req, 'login_bloqueado', 'conta suspensa', user); return res.status(403).json({ error: 'Sua conta está suspensa. Fale com o administrador.' }); }
  loginFails.delete(failKey(req, identifier));
  await q('UPDATE users SET last_login = $1, last_seen = $1, last_ip = $2 WHERE id = $3', [ts(), clientIp(req), user.id]);
  await logAct(req, 'login', '', user);
  req.session.at = Date.now();
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.status = user.status;
  try { await issueRememberToken(req, res, user.id); } catch (e) { console.error('issue token:', e && e.message); }
  res.json({ success: true, role: user.role, status: user.status });
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
  res.json({ user, files: files.map(f => ({ ...f, size: num(f.size) })), rooms, sessions, activity });
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
  const temp = Array.from(crypto.randomBytes(10), b => chars[b % chars.length]).join('');
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(temp, 10), req.target.id]);
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
// Pulso do site (a cada 2s): versão publicada, sessão, aviso global e novas notificações
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || '';
app.get('/api/live', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const out = { v: BUILD_ID, auth: false };
  if (req.session && req.session.userId) {
    const u = await one('SELECT id, username, role, status, force_logout_at FROM users WHERE id = $1', [req.session.userId]);
    if (u && u.status !== 'banned' && !(u.force_logout_at && Number(req.session.at || 0) <= Number(u.force_logout_at))) {
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
  const user = await one('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) return res.status(400).json({ error: 'Senha atual incorreta' });
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'Mínimo 4 caracteres' });
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(newPassword), 10), user.id]);
  // Trocar a senha encerra o login persistente em todos os aparelhos; este aparelho recebe um token novo
  try { await q('DELETE FROM auth_tokens WHERE user_id = $1', [user.id]); await issueRememberToken(req, res, user.id); } catch (e) { console.error('revoke tokens:', e && e.message); }
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
