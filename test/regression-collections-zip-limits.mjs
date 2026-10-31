// Regressão dos limites dos ZIPs de Coletas: ZIPs pequenos continuam sendo
// servidos (cobertos no fluxo E2E) e arquivos acima do limite seguro são
// recusados antes de qualquer header/resposta de download.
//
// Uso: node test/regression-collections-zip-limits.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const collectionsClient = readFileSync(path.join(ROOT, 'public', 'js', 'collections.js'), 'utf8');
let failures = 0;

function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) failures++;
}

check(/const MAX_COLLECTION_ZIP_BYTES = MAX_FILE_BYTES/.test(server),
  'ZIP segue o limite central da Function (4 MiB na Vercel)');

const collectionZip = server.match(/app\.get\('\/api\/coletas\/:id\/zip',[\s\S]*?\n\}\)\);/)?.[0] || '';
const participantZip = server.match(/app\.get\('\/api\/coletas\/:id\/participantes\/:recipientId\/zip',[\s\S]*?\n\}\)\);/)?.[0] || '';
for (const [name, route] of [['ZIP da coleta', collectionZip], ['ZIP individual', participantZip]]) {
  check(Boolean(route) &&
    /rows\.some\(row => num\(row\.size\) > MAX_COLLECTION_ZIP_BYTES\)/.test(route) &&
    route.indexOf('return res.status(413)') >= 0 &&
    route.indexOf('return res.status(413)') < route.indexOf('res.status(200)'),
  `${name} recusa previamente arquivos grandes sem iniciar a resposta`);
}

check(server.includes("app.get('/api/coletas/:id/arquivos/:uploadId/download', asMember") &&
  collectionsClient.includes("'/arquivos/' + encodeURIComponent(file.id) + '/download'") &&
  /if \(isBlobPath\(blobPath\)\)[\s\S]*?presignBlobDownloadUrl\(blobPath, true\)/.test(server),
  'arquivos Blob oferecem download individual autenticado direto pela CDN; arquivos legados preservam fallback');

if (failures) process.exit(1);
console.log('\nLimites e rotas de ZIP das Coletas validados.');