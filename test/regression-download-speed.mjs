// Regressão: downloads de arquivos no Blob devem seguir direto à CDN privada, sem proxy da Function.
// Arquivos do Google Drive continuam protegidos e são transmitidos pelo servidor autenticado.
// Uso: node test/regression-download-speed.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(path.join(root, 'server.js'), 'utf8');

const route = (start, end) => server.slice(server.indexOf(start), server.indexOf(end, server.indexOf(start)));
const roomDownload = route("app.get('/download/:fileId'", "// Visualização inline de arquivo");
const libraryDownload = route("app.get('/download/library/:itemId'", "// Visualizacao inline de um item do Acervo");
const collectionDownload = route("app.get('/api/coletas/:id/arquivos/:uploadId/download'", "app.get('/api/coletas/:id/arquivos/:uploadId/status'");

assert.ok(roomDownload.includes("if (isBlobPath(file.stored_name))") &&
  roomDownload.includes('presignBlobDownloadUrl(file.stored_name, true)') &&
  !/isBlobPath\(file\.stored_name\)[\s\S]{0,500}BLOB_REDIRECT_MIN_BYTES/.test(roomDownload),
'download de Blob da sala usa CDN privada independentemente do tamanho');
assert.ok(libraryDownload.includes('if (isLibraryBlobPath(item.stored_name))') &&
  libraryDownload.includes('presignBlobDownloadUrl(item.stored_name, true)'),
'download do Acervo usa CDN privada independentemente do tamanho');
assert.ok(collectionDownload.includes('if (isBlobPath(blobPath))') &&
  collectionDownload.includes('presignBlobDownloadUrl(blobPath, true)'),
'download individual de Coleta usa CDN privada');
assert.ok(roomDownload.includes('if (isDriveFileRef(file.stored_name))') &&
  roomDownload.includes('pipeDriveFileToResponse(res, file.stored_name, num(file.size), req.get(\'Range\'))'),
'downloads do Drive continuam transmitidos com autenticação e suporte a Range');
assert.ok(server.includes("operations: ['get']") && server.includes('validUntil = Date.now() + 60 * 60 * 1000'),
'redirects do Blob continuam privados e temporários');

console.log('Todas as asserções de velocidade e segurança de download passaram.');