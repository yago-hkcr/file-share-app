// Regressão do "Baixar tudo" da sala (ZIP) e do botão no painel.
// Uso: node test/regression-room-zip.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const dashboard = readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');

// 1) Rotas: prévia e ZIP, ambas exigindo vínculo com a sala.
assert.match(server, /app\.get\('\/api\/rooms\/:id\/zip\/info', asMember/, 'existe a prévia do ZIP da sala');
assert.match(server, /app\.get\('\/api\/rooms\/:id\/zip', asMember/, 'existe o download do ZIP da sala');
const infoRoute = server.slice(server.indexOf("app.get('/api/rooms/:id/zip/info'"), server.indexOf("app.get('/api/rooms/:id/zip'"));
const zipRoute = server.slice(server.indexOf("app.get('/api/rooms/:id/zip',"), server.indexOf("app.get('/download/:fileId'"));
assert.match(infoRoute, /canUseRoom\(req\.user, room\.id\)/, 'a prévia respeita o acesso à sala');
assert.match(zipRoute, /canUseRoom\(req\.user, room\.id\)/, 'o ZIP respeita o acesso à sala');
assert.match(zipRoute, /ORDER BY uploaded_at, id/, 'a ordem do ZIP segue a ordem da lista');
assert.match(zipRoute, /application\/zip/, 'o download é servido como ZIP');
assert.match(zipRoute, /filename\*=UTF-8''/, 'o nome do arquivo aceita acentos');

// 2) Limites: a função serverless tem 30 s, então o ZIP tem teto explícito.
assert.match(server, /const MAX_ROOM_ZIP_BYTES = /, 'teto de tamanho definido');
assert.match(server, /const MAX_ROOM_ZIP_FILES = /, 'teto de quantidade definido');
assert.match(zipRoute, /res\.status\(413\)/, 'acima do teto responde 413 com orientação');

// 3) O ZIP reaproveita o mesmo escritor das Coletas e lê cada origem.
assert.match(server, /async function writeZipArchive\(res, entries\)/, 'escritor de ZIP único');
assert.match(server, /async function streamRoomZip\(res, files\)/, 'ZIP da sala dedicado');
assert.match(server, /await streamRoomZip\(res, files\)/, 'a rota usa o streamer da sala');
assert.match(server, /async function openRoomFileStream\(file\)/, 'abre arquivos de sala por origem');
assert.match(server, /isDriveFileRef\(file\.stored_name\)/, 'arquivos no Google Drive entram no ZIP');
assert.match(server, /isBlobPath\(file\.stored_name\)/, 'arquivos no Blob entram no ZIP');
assert.match(server, /FROM file_blobs WHERE file_id = \$1/, 'arquivos antigos no Postgres entram no ZIP');
assert.match(server, /const source = await entry\.open\(\);/, 'cada arquivo é aberto só na hora de escrever');

// 4) Nomes repetidos não se sobrescrevem dentro do ZIP.
assert.match(server, /function uniqueZipName\(original, used, key\)/, 'desempate de nomes repetidos');

// 5) Painel: botão na sala, contagem e fluxo de fallback.
assert.match(dashboard, /id="downloadRoomBtn"/, 'o painel tem o botão "Baixar tudo"');
assert.match(dashboard, /onclick="downloadRoomZip\(\)"/, 'o botão chama o download');
assert.match(dashboard, /function updateRoomDownloadButton\(count\)/, 'o botão reflete a quantidade de arquivos');
assert.match(dashboard, /function downloadRoomFilesOneByOne\(roomId\)/, 'salas grandes oferecem baixar um por um');
assert.match(dashboard, /formatSize\(info\.bytes\)/, 'o aviso mostra o tamanho da sala');
assert.equal(/const sig = JSON\.stringify\(room\.files\); if \(sig === lastFilesSig\) return;/.test(dashboard), true,
  'o botão atualiza mesmo quando a lista não mudou');
assert.ok(dashboard.indexOf('updateRoomDownloadButton(room.files.length)') < dashboard.indexOf('if (sig === lastFilesSig) return;'),
  'a contagem é atualizada antes do atalho de cache');

console.log('ZIP da sala, limites, origens dos arquivos e botão do painel passaram.');
