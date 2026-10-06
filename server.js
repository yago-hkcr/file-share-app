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
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (LOCAL_MODE ? crypto.randomBytes(9).toString('base64url') : 'admin123');
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!LOCAL_MODE) return 'fileshare-local-development-secret';
  fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
  const secretPath = path.join(LOCAL_DATA_DIR, 'session-secret');
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
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
      theme TEXT DEFAULT 'dark',
      compact_mode INTEGER DEFAULT 0,
      reduced_motion INTEGER DEFAULT 0,
      refresh_seconds INTEGER DEFAULT 2,
      browser_notifications INTEGER DEFAULT 0
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
  await q('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS expires_at TEXT');
  for (const col of ['last_login', 'last_seen', 'last_ip', 'force_logout_at', 'avatar_image']) await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} TEXT`);
  await q('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT');
  await q('CREATE INDEX IF NOT EXISTS idx_dm_pair_created ON direct_messages (sender_id, recipient_id, created_at)');
  await q('CREATE INDEX IF NOT EXISTS idx_dm_recipient_created ON direct_messages (recipient_id, sender_id, created_at)');
  await q(`CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY, user_id TEXT, username TEXT, role TEXT, action TEXT NOT NULL, detail TEXT, ip TEXT, user_agent TEXT, created_at TEXT
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at)');
  await q('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
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
    const hash = bcrypt.hashSync(INITIAL_ADMIN_PASSWORD, 10);
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
app.set('trust proxy', 1);

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(express.json({ limit: '220kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon-48.png')));
app.use(cookieSession({
  name: 'fileshare_session',
  keys: [sessionSecret()],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: IS_VERCEL,
  sameSite: 'lax'
}));
app.use(wrap(async (req, res, next) => { await ensureDatabase(); next(); }));

// ===== Login persistente ("lembrar de mim") =====
// Além do cookie de sessão, guardamos um token longo (1 ano) no navegador; só o hash dele fica no banco.
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
  const user = await one('SELECT id, username, email, role, status, avatar_color, avatar_image, created_at FROM users WHERE id = $1', [req.user.id]);
  const unread = await one('SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND "read" = 0', [req.user.id]);
  res.json({ ...user, unread_notifications: num(unread && unread.count), max_upload_bytes: blobEnabled() ? MAX_BLOB_UPLOAD_BYTES : MAX_FILE_BYTES });
}));

app.get('/api/preferences', requireAuth, wrap(async (req, res) => {
  const row = await one('SELECT theme, compact_mode, reduced_motion, refresh_seconds, browser_notifications FROM user_preferences WHERE user_id = $1', [req.user.id]);
  res.json({ has_preferences: !!row, theme: row && row.theme === 'light' ? 'light' : 'dark', compact_mode: num(row && row.compact_mode) === 1, reduced_motion: num(row && row.reduced_motion) === 1, refresh_seconds: [2, 5, 10].includes(num(row && row.refresh_seconds)) ? num(row.refresh_seconds) : 2, browser_notifications: num(row && row.browser_notifications) === 1 });
}));

app.put('/api/preferences', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const theme = b.theme === 'light' ? 'light' : 'dark';
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
  const [rooms, files, members] = await Promise.all([
    q(`SELECT * FROM rooms WHERE ${cond} ORDER BY created_at DESC`, params),
    q(`SELECT f.id, f.room_id, f.uploaded_by, f.original_name, f.size, f.mime_type, f.uploaded_at, u.username AS uploader, u.role AS uploader_role
       FROM files f LEFT JOIN users u ON f.uploaded_by = u.id
       WHERE f.room_id IN (SELECT id FROM rooms WHERE ${cond}) ORDER BY f.uploaded_at DESC`, params),
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



// Upload multipart direto do navegador ao Blob para arquivos acima de 100 MB.
// O helper do Blob valida os callbacks e emite tokens limitados ao caminho do arquivo.
app.post('/api/rooms/:id/upload-token', wrap(async (req, res) => {
  if (!blobEnabled()) return res.status(501).json({ error: 'Upload direto indisponível neste ambiente' });
  const action = req.body && req.body.type;
  if (action === 'blob.generate-presigned-url') {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Não autorizado' });
    const user = await one('SELECT id, username, role, status, last_seen, force_logout_at FROM users WHERE id = $1', [req.session.userId]);
    if (!user || user.status === 'banned' || (user.force_logout_at && Number(req.session.at || 0) <= Number(user.force_logout_at))) {
      req.session = null;
      return res.status(401).json({ error: 'Não autorizado' });
    }
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
  const mime = file.mime_type || 'application/octet-stream';
  const ascii = String(file.original_name || 'arquivo').replace(/[^a-zA-Z0-9._ -]/g, '_');
  res.set('Content-Disposition', 'inline; filename="' + ascii + '"');
  res.set('Cache-Control', 'private, no-store');
  res.type(mime);
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
  const roomFiles = await q('SELECT stored_name FROM files WHERE room_id = $1', [id]);
  try { await deleteBlobs(roomFiles.map(f => f.stored_name)); } catch (e) { console.error('blobs:', e && e.message); }
  await q('DELETE FROM file_blobs WHERE file_id IN (SELECT id FROM files WHERE room_id = $1)', [id]);
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
  console.error('Erro em', req.method, req.originalUrl, '-', err && err.stack || err);
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
        console.log('🔐 Admin: admin / admin123 (ou ADMIN_PASSWORD)\n');
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
