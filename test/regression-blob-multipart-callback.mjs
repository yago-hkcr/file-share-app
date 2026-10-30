// Regressão: uploads multipart do Vercel Blob não podem registrar um callback
// de conclusão sem autenticação. O callback do Blob é uma chamada servidor-a-
// servidor e não tem os cookies da pessoa que iniciou o envio; a confirmação
// autenticada ocorre no endpoint /registrar depois que o navegador conclui o MPU.
//
// Uso: node test/regression-blob-multipart-callback.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const collectionClient = readFileSync(path.join(ROOT, 'public', 'js', 'collection-upload.js'), 'utf8');
const uploadClient = readFileSync(path.join(ROOT, 'public', 'js', 'upload.js'), 'utf8');

function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) process.exitCode = 1;
}

const multipartHandlers = server.match(/handleUploadPresigned\(\{/g) || [];
check(multipartHandlers.length === 4, 'salas, coletas, Acervo e mensagens diretas mantêm seus quatro fluxos multipart');
check(!server.includes('onUploadCompleted:'), 'nenhum fluxo multipart registra callback Blob sem sessão do navegador');
check(
  /uploadPresigned\([\s\S]*?multipart:\s*true[\s\S]*?\)[\s\S]*?base\s*\+\s*'\/registrar'/.test(collectionClient),
  'a coleta registra o upload pela sessão original após o multipart terminar'
);
check(/const MAX_BLOB_UPLOAD_BYTES = 10 \* 1024 \*\* 3/.test(server), 'o limite central do Blob é exatamente 10 GiB');
check(server.includes("app.post('/api/dm/:id/upload-token', asMember") && server.includes('Blob multipart (mensagem direta)'),
  'mensagens diretas autorizam o multipart após autenticar o usuário e validar a amizade');
check(uploadClient.includes("handleUploadUrl: '/api/dm/' + friendId + '/upload-token'") &&
  /file\.size > 100 \* 1024 \* 1024[\s\S]*?multipart:\s*true/.test(uploadClient),
  'mensagens diretas acima de 100 MiB usam multipart ao Blob');
check(server.includes('collection.large_uploads = collection.has_large_uploads ? await q') &&
  server.includes("app.get('/api/coletas/:id/arquivos/:uploadId/download', asMember") &&
  /collection\.large_uploads[\s\S]*?encodeURIComponent\(file\.id\)[\s\S]*?\/download/.test(readFileSync(path.join(ROOT, 'public', 'js', 'collections.js'), 'utf8')),
  'a UI oferece downloads individuais autenticados dos arquivos grandes concluídos');

if (process.exitCode) console.error('\nA regressão de callback multipart foi detectada.');
else console.log('\nTodas as asserções passaram.');