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

function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) process.exitCode = 1;
}

const multipartHandlers = server.match(/handleUploadPresigned\(\{/g) || [];
check(multipartHandlers.length === 3, 'salas, coletas e Acervo mantêm seus três fluxos multipart');
check(!server.includes('onUploadCompleted:'), 'nenhum fluxo multipart registra callback Blob sem sessão do navegador');
check(
  /uploadPresigned\([\s\S]*?multipart:\s*true[\s\S]*?\)[\s\S]*?base\s*\+\s*'\/registrar'/.test(collectionClient),
  'a coleta registra o upload pela sessão original após o multipart terminar'
);

if (process.exitCode) console.error('\nA regressão de callback multipart foi detectada.');
else console.log('\nTodas as asserções passaram.');