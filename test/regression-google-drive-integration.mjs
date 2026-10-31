// Regressão estrutural da integração do Google Drive sem acessar credenciais ou produção.
// Uso: node test/regression-google-drive-integration.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const server = read('server.js');
const roomUpload = read('public', 'js', 'upload.js');
const libraryUpload = read('public', 'js', 'library.js');
const dashboard = read('public', 'dashboard.html');
const serviceWorker = read('public', 'sw.js');

assert.match(server, /CREATE TABLE IF NOT EXISTS google_drive_uploads/);
assert.match(server, /encryptSecret\(sessionUrl, sessionSecret\(\)\)/);
assert.match(server, /express\.raw\(\{ type: 'application\/octet-stream', limit: '4mb' \}\)/);
assert.match(server, /req\.body\.length > 4 \* 1024 \* 1024/);
assert.match(server, /app\.post\('\/api\/rooms\/:id\/drive-upload-session'/);
assert.match(server, /app\.post\('\/api\/rooms\/:id\/drive-files\/register'/);
assert.match(server, /app\.post\('\/api\/library\/drive-upload-session'/);
assert.match(server, /app\.post\('\/api\/library\/drive-files\/register'/);
assert.match(server, /metadata\.appProperties\?\.fileshareUploadId !== upload\.upload_id/);
assert.match(server, /if \(isDriveFileRef\(item\.stored_name\)\)/);
assert.match(server, /if \(isDriveFileRef\(file\.stored_name\)\)/);
assert.match(server, /drive_upload_enabled: driveEnabled, blob_upload_enabled: blobsEnabled/);
assert.match(roomUpload, /\/api\/google-drive\/uploads\/' \+ encodeURIComponent\(session\.upload_id\) \+ '\/chunk/);
assert.match(libraryUpload, /\/api\/library\/drive-files\/register/);
assert.match(libraryUpload, /if \(driveUploadEnabled\) \{[\s\S]*?drive-upload-session[\s\S]*?if \(file\.size > 100 \* 1024 \* 1024 && blobUploadEnabled\)/);
assert.match(roomUpload, /if \(driveUploadEnabled\) \{[\s\S]*?drive-upload-session[\s\S]*?else if \(file\.size > 100 \* 1024 \* 1024 && blobUploadEnabled\)/);
assert.match(dashboard, /upload\.js\?v=20261030e/);
assert.match(dashboard, /library\.js\?v=20261030e/);
assert.match(serviceWorker, /upload\.js\?v=20261030e/);
assert.match(serviceWorker, /library\.js\?v=20261030e/);

console.log('Todas as asserções da integração Google Drive passaram.');