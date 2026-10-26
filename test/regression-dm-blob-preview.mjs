// Regressão: anexos das conversas diretas usam o prefixo dm/ no Blob privado.
// Eles precisam ser reconhecidos pelas rotas compartilhadas de preview/download
// para que a imagem apareça igual para quem envia e para quem recebe.
// Uso: node test/regression-dm-blob-preview.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { isBlobPath } = require(path.join(ROOT, 'lib', 'blob-paths.js'));
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const roomChat = readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
const directChat = readFileSync(path.join(ROOT, 'public', 'js', 'personal.js'), 'utf8');

let failures = 0;
function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) failures++;
}

check(isBlobPath('dm/12345678/87654321-captura.png'), 'reconhece o caminho Blob de anexo em conversa direta');
check(isBlobPath('rooms/12345678/87654321-foto.png'), 'preserva arquivos Blob das salas');
check(isBlobPath('collections/12345678/87654321-foto.png'), 'preserva arquivos Blob das coletas');
check(isBlobPath('library/12345678-foto.png'), 'preserva arquivos Blob da Biblioteca');
check(!isBlobPath('12345678'), 'não classifica IDs de arquivos legados como Blob');
check(server.includes("require('./lib/blob-paths')") && /function deleteBlobs\(pathnames\)[\s\S]*?pathnames\.filter\(isBlobPath\)/.test(server),
  'servidor usa a mesma identificação Blob para preview, download e exclusão');

const previewRoute = server.slice(server.indexOf("app.get('/preview/:fileId'"), server.indexOf('// =================== PRESENÇA DE DIGITAÇÃO'));
check(previewRoute.includes('canUseRoom(req.user, file.room_id)'), 'preview mantém autorização da sala/conversa do arquivo');
check(/if \(parts\.length !== 2 \|\| !parts\.includes\(String\(user\.id\)\)\) return false;[\s\S]*?return await areFriends\(parts\[0\], parts\[1\]\);/.test(server),
  'conversa direta só permite preview aos dois amigos participantes');
check(roomChat.includes("const previewUrl = '/preview/' + encodeURIComponent(id)") && roomChat.includes('class="chat-attachment-preview"'),
  'chat da sala continua exibindo a prévia inline ao remetente e aos membros');
check(directChat.includes("const previewUrl = '/preview/' + encodeURIComponent(id)") && directChat.includes('class="chat-attachment-preview"'),
  'conversa direta exibe a mesma prévia inline ao remetente e ao destinatário');

if (failures) {
  console.error(`\n${failures} falha(s).`);
  process.exit(1);
}
console.log('\nTodas as asserções passaram.');