// Regressão dos helpers de armazenamento do Google Drive com API simulada.
// Uso: node test/regression-google-drive-storage.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGoogleDriveStorage, driveFileIdFromRef, driveFileRef, isDriveFileRef } = require('../lib/google-drive-storage.js');

let now = 1000;
let uploadCalls = 0;
let lastUpload;
let tokenRequests = 0;
const fetchCalls = [];
const fetchImpl = async (url, options = {}) => {
  const target = String(url);
  fetchCalls.push({ url: target, options });
  if (target === 'https://oauth2.googleapis.com/token') {
    tokenRequests++;
    return { ok: true, status: 200, json: async () => ({ access_token: 'access-1', expires_in: 3600 }) };
  }
  if (target.startsWith('https://www.googleapis.com/drive/v3/about?')) {
    return { ok: true, status: 200, json: async () => ({
      user: { displayName: 'Conta de teste', emailAddress: 'drive@example.com', photoLink: 'https://example.com/avatar.png' },
      storageQuota: { limit: '1000000000', usage: '300000000', usageInDrive: '250000000', usageInDriveTrash: '50000000' }
    }) };
  }
  if (target.startsWith('https://www.googleapis.com/upload/drive/v3/files?')) {
    return { ok: true, status: 200, headers: new Headers({ location: 'https://www.googleapis.com/upload/session-123' }) };
  }
  if (target === 'https://www.googleapis.com/upload/session-123') {
    uploadCalls++;
    lastUpload = options;
    if (uploadCalls === 1) return { ok: false, status: 308, headers: new Headers({ range: 'bytes=0-3' }) };
    return { ok: true, status: 200, json: async () => ({ id: 'drive_file_123456', size: '8', appProperties: { fileshareUploadId: 'upload-1' } }) };
  }
  if (target.startsWith('https://www.googleapis.com/drive/v3/files/drive_file_123456?alt=media')) {
    const ranged = Boolean(options.headers && options.headers.Range);
    return new Response(ranged ? 'test' : 'test1234', { status: ranged ? 206 : 200, headers: ranged
      ? { 'content-range': 'bytes 0-3/8', 'accept-ranges': 'bytes', 'content-length': '4' }
      : { 'content-length': '8' } });
  }
  if (target.startsWith('https://www.googleapis.com/drive/v3/files/drive_file_123456?fields=')) {
    return { ok: true, status: 200, json: async () => ({ id: 'drive_file_123456', name: 'teste.txt', size: '8', mimeType: 'text/plain', appProperties: { fileshareUploadId: 'upload-1' } }) };
  }
  if (target.startsWith('https://www.googleapis.com/drive/v3/files/drive_file_123456/copy?fields=')) {
    return { ok: true, status: 200, json: async () => ({ id: 'drive_file_copy_123456', name: 'copia.txt' }) };
  }
  if (target === 'https://www.googleapis.com/drive/v3/files/drive_file_123456' && options.method === 'DELETE') {
    return { ok: true, status: 204, json: async () => ({}) };
  }
  throw new Error(`Chamada inesperada: ${target}`);
};

const storage = createGoogleDriveStorage({
  clientId: 'client-id', clientSecret: 'client-secret', getRefreshToken: async () => 'refresh-token',
  fetchImpl, now: () => now
});
const session = await storage.startResumableUpload({ name: 'teste.txt', mimeType: 'text/plain', size: 8, uploadId: 'upload-1' });
assert.equal(session, 'https://www.googleapis.com/upload/session-123');
const first = await storage.uploadChunkFromServer(session, 8, 0, Buffer.from('test'));
assert.deepEqual(first, { complete: false, nextOffset: 4 });
const second = await storage.uploadChunkFromServer(session, 8, 4, Buffer.from('1234'));
assert.equal(second.complete, true);
assert.equal(second.file.id, 'drive_file_123456');
assert.equal(new Headers(lastUpload.headers).get('Content-Range'), 'bytes 4-7/8');
assert.equal(new Headers(lastUpload.headers).get('Authorization'), 'Bearer access-1');
assert.equal(tokenRequests, 1, 'o token OAuth é reutilizado');

const metadata = await storage.getFileMetadata('drive_file_123456');
assert.equal(metadata.size, '8');
const about = await storage.getAbout();
assert.equal(about.user.emailAddress, 'drive@example.com');
assert.equal(about.storageQuota.limit, '1000000000');
const aboutUrl = new URL(fetchCalls.find(call => call.url.startsWith('https://www.googleapis.com/drive/v3/about?')).url);
assert.equal(aboutUrl.searchParams.get('fields'), 'user(displayName,emailAddress,photoLink),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)');
const media = await storage.getFile('drive_file_123456', { range: 'bytes=0-3' });
assert.equal(media.status, 206);
assert.equal(await media.text(), 'test');
const copied = await storage.copyFile('drive_file_123456', { name: 'copia.txt', uploadId: 'library-1' });
assert.equal(copied.id, 'drive_file_copy_123456');
await storage.deleteFile('drive_file_123456');

const unauthorizedUrl = 'https://evil.example/session';
await assert.rejects(() => storage.uploadChunkFromServer(unauthorizedUrl, 8, 0, Buffer.from('x')), /sessão de upload.*inválida/i);
assert.equal(driveFileRef('drive_file_123456'), 'gdrive:drive_file_123456');
assert.equal(driveFileIdFromRef('gdrive:drive_file_123456'), 'drive_file_123456');
assert.equal(isDriveFileRef('gdrive:drive_file_123456'), true);
assert.equal(isDriveFileRef('rooms/legacy'), false);

now += 4_000_000;
assert.equal(await storage.getAccessToken(), 'access-1');
assert.equal(tokenRequests, 2, 'o access token expirado é renovado');

console.log('Todas as asserções do armazenamento Google Drive passaram.');