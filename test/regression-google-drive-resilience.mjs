// Regressão da resiliência do Google Drive: retry com backoff, erros
// estruturados por reason, pasta de organização e ID pré-gerado.
// Uso: node test/regression-google-drive-resilience.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';

const require = createRequire(import.meta.url);
const { createGoogleDriveStorage, DRIVE_DIRECT_CHUNK_BYTES } = require('../lib/google-drive-storage.js');

function response(status, { body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

let now = 1_700_000_000_000;
let chunkAttempts = 0;
let sessionHeaders = null;
let sessionBody = null;
const calls = [];
const fetchImpl = async (url, options = {}) => {
  const target = String(url);
  calls.push({ url: target, options });
  if (target === 'https://oauth2.googleapis.com/token') {
    return response(200, { body: { access_token: 'access-1', expires_in: 3600 } });
  }
  if (target.includes('/upload/drive/v3/files?')) {
    sessionHeaders = options.headers;
    sessionBody = JSON.parse(String(options.body || '{}'));
    return response(200, { headers: { location: 'https://www.googleapis.com/upload/session-abc' } });
  }
  if (target.includes('/drive/v3/files/generateIds')) {
    return response(200, { body: { ids: ['generatedFileId123'] } });
  }
  if (target.includes('/drive/v3/files?') && target.includes('Arquive+Online')) {
    return response(200, { body: { files: [{ id: 'folderRoot123', name: 'Arquive Online' }] } });
  }
  if (target.includes('/drive/v3/files?') && target.includes('mimeType')) {
    return response(200, { body: { files: [] } });
  }
  if (target.includes('/drive/v3/files?') && options.method === 'POST') {
    return response(200, { body: { id: 'folderMonth123' } });
  }
  if (target === 'https://www.googleapis.com/upload/session-abc') {
    chunkAttempts++;
    if (chunkAttempts === 1) return response(429, { headers: { 'retry-after': '0' } });
    return response(200, { body: { id: 'driveFileFromChunk', size: '4', appProperties: { fileshareUploadId: 'u1' } } });
  }
  if (target.includes('/drive/v3/files/deniedFile123?fields=')) {
    return response(403, { body: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } });
  }
  if (target.includes('/drive/v3/files/deadFile123?fields=')) {
    return response(403, { body: { error: { errors: [{ reason: 'invalid_grant' }] } } });
  }
  throw new Error('Chamada inesperada: ' + target);
};

const storage = createGoogleDriveStorage({
  clientId: 'client', clientSecret: 'secret', getRefreshToken: async () => 'refresh',
  fetchImpl, now: () => now, sleep: async () => {}
});

// Pasta: encontra "Arquive Online" e cria o mês, e o upload usa parents.
const sessionUrl = await storage.startResumableUpload({
  name: 'grande.bin', mimeType: 'application/octet-stream', size: 4, uploadId: 'u1', fileId: 'generatedFileId123'
});
assert.equal(sessionUrl, 'https://www.googleapis.com/upload/session-abc');
assert.deepEqual(sessionBody.parents, ['folderMonth123'], 'o arquivo entra na pasta do mês');
assert.equal(sessionBody.id, 'generatedFileId123', 'o ID pré-gerado evita duplicata em retry');
assert.equal(sessionBody.appProperties.fileshareUploadId, 'u1');
assert.equal(sessionHeaders['X-Upload-Content-Length'], '4');

const noFolder = await storage.startResumableUpload({
  name: 'sem-pasta.bin', mimeType: 'application/octet-stream', size: 4, uploadId: 'u2', organize: false
});
assert.equal(noFolder, 'https://www.googleapis.com/upload/session-abc');
assert.equal(sessionBody.parents, undefined, 'organize:false volta para a raiz');

// Origin libera CORS para o envio direto do navegador.
await storage.startResumableUpload({
  name: 'direto.bin', mimeType: 'application/octet-stream', size: 4, uploadId: 'u3',
  origin: 'https://www.arquive.online', organize: false
});
assert.equal(sessionHeaders.Origin, 'https://www.arquive.online');

// 429 com Retry-After: o bloco é repetido e conclui.
const uploaded = await storage.uploadChunkFromServer(sessionUrl, 4, 0, Buffer.from('test'));
assert.equal(uploaded.complete, true);
assert.equal(chunkAttempts, 2, 'o 429 foi repetido uma vez');

// Erros carregam status/reason para a classificação do servidor.
await assert.rejects(() => storage.getFileMetadata('deniedFile123'), error => {
  assert.equal(error.status, 403);
  assert.equal(error.reason, 'storageQuotaExceeded');
  assert.equal(error.kind, 'quota');
  return true;
});
await assert.rejects(() => storage.getFileMetadata('deadFile123'), error => {
  assert.equal(error.kind, 'auth');
  return true;
});

const ids = await storage.generateIds(2);
assert.deepEqual(ids, ['generatedFileId123']);
assert.equal(DRIVE_DIRECT_CHUNK_BYTES, 16 * 1024 * 1024, 'blocos maiores no envio direto');

console.log('Retry, erros por reason, pasta, ID pré-gerado e CORS do Drive passaram.');
