'use strict';

// Armazenamento S3 privado (Cloudflare R2, Backblaze B2, MinIO, AWS S3).
// O navegador envia e baixa direto do bucket por URLs assinadas; o servidor
// guarda apenas metadados no Postgres. Isso evita o limite de egress da Vercel.

const crypto = require('crypto');
const { Readable } = require('stream');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { contentTypeFor } = require('./local-storage');

class BlobNotFoundError extends Error {
  constructor(pathname) {
    super('Arquivo não encontrado no storage S3: ' + pathname);
    this.name = 'BlobNotFoundError';
    this.code = 'BLOB_NOT_FOUND';
  }
}

const BUCKET = String(process.env.S3_BUCKET || '').trim();
const REGION = String(process.env.S3_REGION || 'auto').trim();
const ENDPOINT = String(process.env.S3_ENDPOINT || '').trim() || undefined;
const ACCESS_KEY_ID = String(process.env.S3_ACCESS_KEY_ID || '').trim();
const SECRET_ACCESS_KEY = String(process.env.S3_SECRET_ACCESS_KEY || '').trim();
const SESSION_TOKEN = String(process.env.S3_SESSION_TOKEN || '').trim() || undefined;
const FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE || 'true').trim().toLowerCase() !== 'false';
const SIGNING_SECRET = String(process.env.STORAGE_SIGNING_SECRET || process.env.SESSION_SECRET || '');

if (!BUCKET) throw new Error('Defina S3_BUCKET para usar STORAGE_PROVIDER=s3.');
if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  throw new Error('Defina S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY para usar STORAGE_PROVIDER=s3.');
}

const client = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: FORCE_PATH_STYLE,
  credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY, ...(SESSION_TOKEN ? { sessionToken: SESSION_TOKEN } : {}) },
  // O R2/MinIO não precisam do checksum automático do SDK novo e ele quebra
  // alguns fluxos de URL assinada. Assinamos somente o necessário.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
});

function safeKey(pathname) {
  if (typeof pathname !== 'string' || !pathname || pathname.includes('\0')) {
    throw new Error('Caminho de armazenamento inválido.');
  }
  if (pathname.includes('\\') || pathname.startsWith('/') || pathname.split('/').includes('..')) {
    throw new Error('Caminho de armazenamento inválido.');
  }
  return pathname;
}

function isNotFound(error) {
  if (!error) return false;
  if (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.name === 'NoSuchBucket') return true;
  const status = Number(error.$metadata && error.$metadata.httpStatusCode);
  return status === 404;
}

function webStream(body) {
  if (!body) throw new Error('Resposta do storage sem corpo.');
  if (typeof body.transformToWebStream === 'function') return body.transformToWebStream();
  if (typeof body.getReader === 'function') return body;
  return Readable.toWeb(body);
}

function objectInfo(pathname, response) {
  return {
    pathname,
    size: Number(response.ContentLength) || 0,
    contentType: response.ContentType || contentTypeFor(pathname),
    uploadedAt: response.LastModified || new Date()
  };
}

async function put(pathname, body, options = {}) {
  const key = safeKey(pathname);
  if (body == null) throw new Error('Corpo do arquivo ausente.');
  const isBuffer = Buffer.isBuffer(body) || typeof body === 'string' || body instanceof Uint8Array;
  const knownLength = isBuffer
    ? (Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body))
    : Number(options.contentLength) || 0;
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: isBuffer && !Buffer.isBuffer(body) ? Buffer.from(body) : body,
    ContentType: options.contentType || contentTypeFor(key),
    ...(knownLength > 0 ? { ContentLength: knownLength } : {})
  });
  const result = await client.send(command);
  return { pathname: key, url: '', size: Number(result.ContentLength) || 0 };
}

async function get(pathname) {
  const key = safeKey(pathname);
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return { stream: webStream(response.Body), blob: objectInfo(key, response) };
  } catch (error) {
    if (isNotFound(error)) throw new BlobNotFoundError(key);
    throw error;
  }
}

async function head(pathname) {
  const key = safeKey(pathname);
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return objectInfo(key, response);
  } catch (error) {
    if (isNotFound(error)) throw new BlobNotFoundError(key);
    throw error;
  }
}

async function del(pathname) {
  const key = safeKey(pathname);
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function copy(fromPathname, toPathname, options = {}) {
  const from = safeKey(fromPathname);
  const to = safeKey(toPathname);
  const source = `${BUCKET}/${from}`.split('/').map(encodeURIComponent).join('/');
  const result = await client.send(new CopyObjectCommand({
    Bucket: BUCKET,
    Key: to,
    CopySource: source,
    MetadataDirective: 'REPLACE',
    ContentType: options.contentType || contentTypeFor(to)
  }));
  return { pathname: to, size: Number(result.CopyObjectResult && result.CopyObjectResult.ContentLength) || 0 };
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function sign(data) { return crypto.createHmac('sha256', SIGNING_SECRET).update(data).digest('base64url'); }

function requireSecret() {
  if (!SIGNING_SECRET) throw new Error('Defina SESSION_SECRET ou STORAGE_SIGNING_SECRET para assinar URLs de arquivos.');
}

function issueSignedToken(options = {}) {
  requireSecret();
  const payload = {
    p: safeKey(options.pathname),
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
  payload.p = safeKey(payload.p);
  return payload;
}

function expiresIn(validUntil) {
  const seconds = Math.ceil((Number(validUntil) - Date.now()) / 1000);
  return Math.max(1, Math.min(604800, Number.isFinite(seconds) ? seconds : 3600));
}

function disposition(download, displayName) {
  const raw = String(displayName || '').replace(/[\r\n"\\]/g, '_').slice(0, 255) || 'arquivo';
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_') || 'arquivo';
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

async function presignUrl(token, options = {}) {
  const payload = verifyToken(token);
  const operation = options.operation || 'get';
  if (!Array.isArray(payload.o) || !payload.o.includes(operation)) {
    throw new Error('Token de armazenamento não permite esta operação.');
  }
  if (options.pathname && safeKey(options.pathname) !== payload.p) {
    throw new Error('Caminho de armazenamento não corresponde ao token.');
  }
  const key = payload.p;
  if (operation === 'put') {
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key });
    return { presignedUrl: await getSignedUrl(client, command, { expiresIn: expiresIn(options.validUntil) }) };
  }
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentType: options.contentType || contentTypeFor(key),
    ResponseContentDisposition: disposition(options.download === true, options.displayName)
  });
  return { presignedUrl: await getSignedUrl(client, command, { expiresIn: expiresIn(options.validUntil) }) };
}

module.exports = {
  provider: 's3',
  bucket: BUCKET,
  BlobNotFoundError,
  put,
  get,
  head,
  del,
  copy,
  issueSignedToken,
  presignUrl,
  verifyToken,
  contentTypeFor,
  // O upload multipart do SDK da Vercel não é usado: o cliente faz PUT único
  // assinado direto no bucket (até 5 GiB por objeto no S3/R2).
  handleUploadPresigned: async () => { throw new Error('Upload multipart S3 não é suportado.'); }
};
