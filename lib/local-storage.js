'use strict';

// Armazenamento local em disco para a instalação fora da Vercel.
// A API imita as operações do @vercel/blob usadas pelo server.js, mas os bytes
// ficam em LOCAL_STORAGE_DIR. URLs de upload/download são assinadas com HMAC e
// curta validade, no mesmo modelo das URLs presigned do Blob.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

class BlobNotFoundError extends Error {
  constructor(pathname) {
    super('Arquivo não encontrado no armazenamento local: ' + pathname);
    this.name = 'BlobNotFoundError';
    this.code = 'BLOB_NOT_FOUND';
  }
}

const ROOT = path.resolve(process.env.LOCAL_STORAGE_DIR || path.join(__dirname, '..', 'storage'));
const SIGNING_SECRET = String(process.env.STORAGE_SIGNING_SECRET || process.env.SESSION_SECRET || '');
const META_SUFFIX = '.meta.json';
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.xml': 'application/xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

function safeRelative(pathname) {
  if (typeof pathname !== 'string' || !pathname || pathname.includes('\0')) {
    throw new Error('Caminho de armazenamento inválido.');
  }
  // No Windows, '\\' e 'C:' também são separadores/raízes. Tokens só usam
  // caminhos POSIX gerados pelo servidor; rejeitamos qualquer ambiguidade.
  if (pathname.includes('\\') || path.win32.isAbsolute(pathname) || /^[A-Za-z]:/.test(pathname)) {
    throw new Error('Caminho de armazenamento inválido.');
  }
  if (pathname.split('/').includes('..')) {
    throw new Error('Caminho de armazenamento inválido.');
  }
  const normalized = path.posix.normalize('/' + pathname).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/../') || path.isAbsolute(normalized)) {
    throw new Error('Caminho de armazenamento inválido.');
  }
  return normalized;
}

function absolutePath(pathname) { return path.join(ROOT, ...safeRelative(pathname).split('/')); }
function metaPath(pathname) { return absolutePath(pathname) + META_SUFFIX; }

function contentTypeFor(pathname) {
  return MIME_BY_EXT[path.extname(pathname).toLowerCase()] || 'application/octet-stream';
}

async function readMeta(pathname) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(pathname), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeMeta(pathname, metadata) {
  const target = metaPath(pathname);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, JSON.stringify(metadata), 'utf8');
}

async function assertExists(pathname) {
  try {
    return await fsp.stat(absolutePath(pathname));
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new BlobNotFoundError(pathname);
    throw error;
  }
}

function bodyToReadable(body) {
  if (body == null) throw new Error('Corpo do arquivo ausente.');
  if (Buffer.isBuffer(body) || typeof body === 'string' || body instanceof Uint8Array) {
    return Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  }
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (typeof body.pipe === 'function') return body;
  throw new Error('Tipo de corpo de arquivo não suportado.');
}

async function put(pathname, body, options = {}) {
  const relative = safeRelative(pathname);
  const target = absolutePath(relative);
  const overwrite = options.allowOverwrite !== false;
  if (!overwrite) {
    try { await fsp.access(target); throw new Error('O arquivo já existe.'); }
    catch (error) { if (error && error.code !== 'ENOENT') throw error; }
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.tmp-' + crypto.randomBytes(8).toString('hex');
  let size = 0;
  try {
    const source = bodyToReadable(body);
    await pipeline(source, fs.createWriteStream(temp, { mode: 0o600 }));
    size = (await fsp.stat(temp)).size;
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  await writeMeta(relative, {
    size,
    contentType: options.contentType || contentTypeFor(relative),
    pathname: relative,
    updatedAt: new Date().toISOString()
  });
  return { pathname: relative, url: '', size };
}

async function get(pathname) {
  const relative = safeRelative(pathname);
  const stat = await assertExists(relative);
  const meta = await readMeta(relative);
  return {
    stream: Readable.toWeb(fs.createReadStream(absolutePath(relative))),
    blob: {
      pathname: relative,
      size: stat.size,
      contentType: meta.contentType || contentTypeFor(relative),
      uploadedAt: stat.mtime
    }
  };
}

async function head(pathname) {
  const relative = safeRelative(pathname);
  const stat = await assertExists(relative);
  const meta = await readMeta(relative);
  return {
    pathname: relative,
    size: stat.size,
    contentType: meta.contentType || contentTypeFor(relative),
    uploadedAt: stat.mtime
  };
}

async function del(pathname) {
  const relative = safeRelative(pathname);
  await Promise.all([
    fsp.rm(absolutePath(relative), { force: true }),
    fsp.rm(metaPath(relative), { force: true })
  ]);
}

async function copy(fromPathname, toPathname, options = {}) {
  const from = safeRelative(fromPathname);
  const to = safeRelative(toPathname);
  await fsp.mkdir(path.dirname(absolutePath(to)), { recursive: true });
  await fsp.copyFile(absolutePath(from), absolutePath(to));
  const sourceMeta = await readMeta(from);
  const stat = await fsp.stat(absolutePath(to));
  await writeMeta(to, {
    size: stat.size,
    contentType: options.contentType || sourceMeta.contentType || contentTypeFor(to),
    pathname: to,
    updatedAt: new Date().toISOString()
  });
  return { pathname: to, size: stat.size };
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function sign(data) { return crypto.createHmac('sha256', SIGNING_SECRET).update(data).digest('base64url'); }

function requireSecret() {
  if (!SIGNING_SECRET) throw new Error('Defina SESSION_SECRET ou STORAGE_SIGNING_SECRET para assinar URLs de arquivos.');
}

function issueSignedToken(options = {}) {
  requireSecret();
  const payload = {
    p: safeRelative(options.pathname),
    o: Array.isArray(options.operations) ? options.operations : ['put'],
    m: Number(options.maximumSizeInBytes) || 0,
    e: Number(options.validUntil) || Date.now() + 60 * 60 * 1000
  };
  const data = base64url(JSON.stringify(payload));
  return data + '.' + sign(data);
}

function verifyToken(token) {
  requireSecret();
  const value = String(token || '');
  const dot = value.lastIndexOf('.');
  if (dot <= 0) throw new Error('Token de armazenamento inválido.');
  const data = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = sign(data);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Token de armazenamento inválido.');
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); }
  catch (_) { throw new Error('Token de armazenamento inválido.'); }
  if (!payload || typeof payload.p !== 'string') throw new Error('Token de armazenamento inválido.');
  if (!Number.isFinite(payload.e) || Date.now() > payload.e) throw new Error('Token de armazenamento expirado.');
  payload.p = safeRelative(payload.p);
  return payload;
}

function storageBaseUrl() {
  const configured = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return 'http://localhost:' + String(process.env.PORT || 3000);
}

function presignUrl(token, options = {}) {
  const payload = verifyToken(token);
  const operation = options.operation || 'get';
  if (!Array.isArray(payload.o) || !payload.o.includes(operation)) {
    throw new Error('Token de armazenamento não permite esta operação.');
  }
  if (options.pathname && safeRelative(options.pathname) !== payload.p) {
    throw new Error('Caminho de armazenamento não corresponde ao token.');
  }
  if (operation === 'put') {
    if (Number(options.maximumSizeInBytes) > payload.m && payload.m > 0) {
      throw new Error('Tamanho máximo maior que o autorizado.');
    }
    return { presignedUrl: storageBaseUrl() + '/api/storage/upload?token=' + encodeURIComponent(token) };
  }
  const url = new URL(storageBaseUrl() + '/api/storage/object?token=' + encodeURIComponent(token));
  if (options.download === true) url.searchParams.set('download', '1');
  if (options.displayName) url.searchParams.set('name', String(options.displayName).slice(0, 255));
  return { presignedUrl: url.toString() };
}

module.exports = {
  provider: 'local',
  root: ROOT,
  BlobNotFoundError,
  put,
  get,
  head,
  del,
  copy,
  issueSignedToken,
  presignUrl,
  verifyToken,
  absolutePath,
  contentTypeFor,
  // O multipart do SDK da Vercel não é usado no armazenamento local: o cliente
  // envia um PUT único, que o Node streama direto para o disco.
  handleUploadPresigned: async () => { throw new Error('Upload multipart local não é suportado.'); }
};
