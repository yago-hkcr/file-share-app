// Regressão estrutural da integração do Google Drive sem acessar credenciais ou produção.
// Uso: node test/regression-google-drive-integration.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const server = read('server.js');
const roomUpload = read('public', 'js', 'upload.js');
const driveTransport = read('public', 'js', 'google-drive-upload.mjs');
const dmUpload = roomUpload.slice(roomUpload.indexOf('async function uploadToDmDirect'), roomUpload.indexOf('async function uploadWithQueue'));
const libraryUpload = read('public', 'js', 'library.js');
const dashboard = read('public', 'dashboard.html');
const admin = read('public', 'admin.html');
const adminStorageCss = read('public', 'css', 'admin-storage.css');
const serviceWorker = read('public', 'sw.js');
const distribution = read('lib', 'google-drive-distribution.js');
const inlineScripts = [...admin.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).filter(script => script.trim());
assert.ok(inlineScripts.length > 0, 'o painel deve conter scripts inline');
inlineScripts.forEach((script, index) => new vm.Script(script, { filename: `admin-inline-${index + 1}.js` }));

assert.match(server, /CREATE TABLE IF NOT EXISTS google_drive_uploads/);
assert.match(server, /encryptSecret\(sessionUrl, sessionSecret\(\)\)/);
assert.match(server, /express\.raw\(\{ type: 'application\/octet-stream', limit: '4mb' \}\)/);
assert.match(server, /req\.body\.length > 4 \* 1024 \* 1024/);
assert.match(server, /app\.post\('\/api\/rooms\/:id\/drive-upload-session'/);
assert.match(server, /app\.post\('\/api\/rooms\/:id\/drive-files\/register'/);
assert.match(server, /app\.post\('\/api\/library\/drive-upload-session'/);
assert.match(server, /app\.post\('\/api\/google-drive\/uploads\/:uploadId\/status', asMember/);
assert.match(server, /app\.post\('\/api\/google-drive\/uploads\/:uploadId\/chunk', asMember/);
assert.match(server, /if \(\['room', 'dm'\]\.includes\(upload\.destination_type\) && !\(await canUseRoom\(req\.user, upload\.room_id\)\)\)/);
assert.match(server, /resolvePersonalLibraryLocation\(req\.user\.id, \{ space_id: upload\.space_id, bookcase_id: upload\.bookcase_id \}\)/);
assert.match(server, /app\.post\('\/api\/google-drive\/uploads\/:uploadId\/(?:status|chunk)'[\s\S]*?res\.set\('Cache-Control', 'no-store'\)/);
assert.match(server, /WHERE upload_id = \$4 AND user_id = \$5 AND status = 'uploading' AND drive_account_id = \$2/);
assert.match(server, /status = 'failed', session_url_enc = ''[\s\S]*?RETURNING upload_id/);
assert.match(server, /const expired = await q\([\s\S]*?status = 'failed', session_url_enc = ''[\s\S]*?AND drive_account_id = \$4 RETURNING upload_id/);
assert.match(server, /const refreshed = await q\([\s\S]*?status = 'uploading' AND drive_account_id = \$4 RETURNING upload_id/);
assert.match(server, /session_url_enc, status, created_at/);
assert.match(server, /SET status = 'complete',[\s\S]*?session_url_enc = ''[\s\S]*?WHERE upload_id = \$4 AND user_id = \$5/);
assert.match(server, /app\.post\('\/api\/dm\/:id\/drive-files\/register'/);
assert.match(server, /app\.post\('\/api\/library\/drive-files\/register'/);
assert.match(server, /app\.post\('\/api\/dm\/:id\/drive-upload-session'/);
assert.match(server, /\['room', 'dm'\]\.includes\(upload\.destination_type\)/);
assert.match(server, /metadata\.appProperties\?\.fileshareUploadId !== upload\.upload_id/);
assert.match(server, /if \(isDriveFileRef\(item\.stored_name\)\)/);
assert.match(server, /if \(isDriveFileRef\(file\.stored_name\)\)/);
assert.match(server, /drive_upload_enabled: driveEnabled, blob_upload_enabled: blobsEnabled/);
assert.match(server, /app\.get\('\/api\/admin\/google-drive\/status', asAdmin/);
assert.match(server, /verified: verifiedOk/);
assert.match(server, /getGoogleDriveAccounts\(\{ includeInactive: true \}\)/);
assert.match(server, /driveFileRef\(upload\.file_id, accountId\)/);
assert.match(server, /ALTER TABLE google_drive_uploads ADD COLUMN IF NOT EXISTS drive_account_id TEXT/);
assert.match(server, /const reservationRows = await q\([\s\S]*?FROM google_drive_uploads[\s\S]*?WHERE status = 'uploading'/);
assert.match(server, /SET status = 'failed',[\s\S]*?COALESCE\(updated_at, created_at\) <= \$1/);
assert.match(server, /app\.get\('\/api\/admin\/google-drive\/distribution'/);
assert.match(server, /app\.post\('\/api\/admin\/google-drive\/distribution'/);
assert.match(server, /status\(409\)\.json\(\{ state: 'account_changed'/);
assert.match(server, /const claimed = await q\([\s\S]*?AND drive_account_id = \$4 RETURNING upload_id/);
assert.match(server, /const advanced = await q\([\s\S]*?status = 'uploading' AND drive_account_id = \$4 RETURNING upload_id/);
assert.match(server, /FROM google_drive_uploads[\s\S]*?WHERE status = 'uploading'/);
assert.match(server, /selectGoogleDriveCandidate\(refreshed/);
assert.match(distribution, /most_free.*round_robin.*preferred/);
assert.match(distribution, /storageQuotaExceeded/);
assert.match(server, /storage_quota:/);
assert.match(server, /\.getAbout\(\)/);
assert.match(server, /verification_failed: true/);
assert.doesNotMatch(server.match(/app\.get\('\/api\/admin\/google-drive\/status',[\s\S]*?\n  \}\)\);/)?.[0] || '', /verification_error:|redirect_uri: GOOGLE_DRIVE_REDIRECT_URI|scope: DRIVE_FILE_SCOPE/);
assert.match(server, /app\.get\('\/api\/admin\/google-drive\/oauth\/start', asAdmin/);
assert.match(driveTransport, /\/api\/google-drive\/uploads\/' \+ encodeURIComponent\(current\.upload_id\) \+ '\/' \+ action/);
assert.match(driveTransport, /state === 'account_changed'[\s\S]*?onSessionChange\(current\)/);
assert.match(driveTransport, /const reconciled = await readStatus\(current\)/);
assert.match(driveTransport, /if \(data\.complete\) return \{ complete: true, offset: file\.size \}/);
assert.doesNotMatch(driveTransport, /https:\/\/www\.googleapis\.com/);
assert.match(roomUpload, /loadGoogleDriveTransport\(\)/);
assert.match(roomUpload, /driveSession\.upload_id/);
assert.match(libraryUpload, /\/api\/library\/drive-files\/register/);
assert.match(libraryUpload, /loadGoogleDriveTransport\(\)/);
assert.match(libraryUpload, /driveSession\.upload_id/);
assert.match(libraryUpload, /if \(driveUploadEnabled\) \{[\s\S]*?drive-upload-session[\s\S]*?if \(file\.size > 100 \* 1024 \* 1024 && blobUploadEnabled\)/);
assert.match(roomUpload, /if \(driveUploadEnabled\) \{[\s\S]*?drive-upload-session[\s\S]*?else if \(file\.size > 100 \* 1024 \* 1024 && blobUploadEnabled\)/);
assert.match(dmUpload, /if \(driveUploadEnabled\) \{[\s\S]*?\/api\/dm\/' \+ friendId \+ '\/drive-upload-session[\s\S]*?\/api\/dm\/' \+ friendId \+ '\/drive-files\/register/);
assert.match(admin, /id="tab-storage"/);
assert.match(admin, /\/api\/admin\/google-drive\/oauth\/start/);
assert.match(admin, /googleDriveAccountsList/);
assert.match(admin, /Conectar outra conta/);
assert.match(admin, /verificationFailed/);
assert.match(admin, /loadGoogleDriveStatus\(\)/);
assert.match(admin, /googleDriveTotalQuotaUsed/);
assert.match(admin, /googleDriveTotalQuotaFree/);
assert.match(admin, /googleDriveAccountsList/);
assert.match(admin, /Atualizar status/);
assert.match(admin, /Atualização automática ativada/);
assert.match(admin, /setInterval\(\(\) => \{[\s\S]*?loadGoogleDriveStatus\(\)/);
assert.match(admin, /driveStatusRequest/);
assert.match(admin, /get\('drive_connected'\) === '1'/);
assert.match(server, /res\.redirect\(302, `\$\{safeReturnOrigin\}\/admin\?drive_connected=1#storage`\)/);
assert.match(server, /app\.delete\('\/api\/admin\/google-drive\/connection', asAdmin/);
assert.match(admin, /admin-storage\.css/);
assert.match(admin, /admin-storage\.css\?v=20261107a/, 'mudanças de layout invalidam o CSS antigo em cache');
assert.match(admin, /hacker-ui\.css\?v=[^"']+"[^>]*>\s*<link rel="stylesheet" href="\/css\/admin-storage\.css\?v=20261107a"/,
  'o CSS do painel é carregado depois dos estilos globais');
assert.match(admin, /<span>Uso da cota<\/span>/, 'o cartão não repete o e-mail na linha de percentual');
assert.match(adminStorageCss, /\.storage-account-card\{[^}]*display:grid/,
  'o cartão da conta tem layout estruturado em grade');
assert.match(adminStorageCss, /\.storage-account-card-quota-row\{[^}]*display:flex/,
  'as métricas de cota aparecem em linhas alinhadas');
assert.match(adminStorageCss, /@media\(max-width:760px\)\{\.storage-account-card\{grid-template-columns:minmax\(0,1fr\)\}/,
  'os cartões viram uma coluna em telas estreitas');
assert.match(adminStorageCss, /\.storage-heading-actions\{[^}]*display:flex/,
  'os controles do painel ficam agrupados');
assert.match(adminStorageCss, /\.storage-heading-actions>\.btn\{[^}]*width:100%/,
  'os botões do painel ocupam igualmente a linha disponível');
assert.match(admin, /async function connectNewGoogleDrive\(event\)[\s\S]*?window\.location\.href = location\.origin \+ '\/api\/admin\/google-drive\/oauth\/start'/,
  'o painel inicia a conexão OAuth para adicionar outra conta');
assert.match(admin, /googleDriveDistributionMode/);
assert.match(admin, /Alternar entre contas/);
assert.match(admin, /Priorizar uma conta/);
assert.match(admin, /loadGoogleDriveDistribution\(accounts\)/);
assert.match(admin, /saveGoogleDriveDistribution\(\)/);
assert.match(admin, /O painel tentará verificar novamente automaticamente\./,
  'falhas temporárias mantêm a autorização e orientam uma nova verificação');
assert.match(dashboard, /upload\.js\?v=20261107b/);
assert.match(dashboard, /library\.js\?v=20261111a/);
assert.match(serviceWorker, /upload\.js\?v=20261107b/);
assert.match(serviceWorker, /google-drive-upload\.mjs\?v=20261031b/);
assert.match(serviceWorker, /library\.js\?v=20261111a/);

console.log('Todas as asserções da integração Google Drive passaram.');