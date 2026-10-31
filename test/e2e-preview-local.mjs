// Teste e2e local: preview e download de um arquivo enviado numa sala (modo LOCAL_MODE/PGlite).
// Uso: node test/e2e-preview-local.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || (48000 + Math.floor(Math.random() * 10000)));
const ADMIN_PASSWORD = 'senha-teste-123456';
const SESSION_SECRET = 'sessao-teste-segura-1234567890';
const dataDir = mkdtempSync(path.join(tmpdir(), 'preview-e2e-'));

function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, FILESHARE_LOCAL: '1', FILESHARE_DATA_DIR: dataDir, FILESHARE_NO_BROWSER: '1',
      PORT: String(PORT), ADMIN_PASSWORD, SESSION_SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Servidor não subiu.');
}
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASSOU' : 'FALHOU'} - ${label}`); if (!ok) failures++; };

const child = startServer();
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = { origin: BASE };
try {
  await waitHealthy();
  const versionedAsset = await fetch(`${BASE}/js/common.js?v=cache-regression`);
  const versionedCache = versionedAsset.headers.get('cache-control') || '';
  check(versionedAsset.ok && /max-age=31536000/.test(versionedCache) && /immutable/.test(versionedCache),
    'assets JS versionados recebem cache imutável de um ano');
  const unversionedAsset = await fetch(`${BASE}/js/common.js`);
  const unversionedCache = unversionedAsset.headers.get('cache-control') || '';
  check(unversionedAsset.ok && !/immutable/.test(unversionedCache),
    'assets sem versão não recebem cache imutável');
  const healthResponse = await fetch(`${BASE}/health`);
  check((healthResponse.headers.get('cache-control') || '').includes('no-store'),
    'respostas de saúde continuam sem cache');
  const manifestResponse = await fetch(`${BASE}/manifest.json?v=cache-regression`);
  check(manifestResponse.ok && !/immutable/.test(manifestResponse.headers.get('cache-control') || ''),
    'arquivos não CSS/JS não recebem cache imutável mesmo com parâmetro v');
  const missingAsset = await fetch(`${BASE}/js/missing-cache-regression.js?v=cache-regression`);
  check(missingAsset.status === 404 && !/immutable/.test(missingAsset.headers.get('cache-control') || ''),
    'assets inexistentes não recebem cache imutável');
  // Páginas protegidas não podem ser obtidas diretamente via express.static.
  for (const page of ['/admin.html', '/dashboard.html', '/change-password.html', '/%61dmin.html', '/admin%2ehtml', '/dashboard%2ehtml', '/%2561dmin%252ehtml']) {
    const direct = await fetch(BASE + page, { redirect: 'manual' });
    check(direct.status === 404, `acesso direto bloqueado para ${page} (status ${direct.status})`);
  }
  for (const page of ['/admin', '/dashboard']) {
    const protectedPage = await fetch(BASE + page, { redirect: 'manual' });
    check(protectedPage.status === 302 && protectedPage.headers.get('location') === '/', `rota protegida ${page} exige sessão`);
  }
  // 1) login como admin local
  let res = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
  });
  if (!res.ok) console.error('login resposta:', res.status, (await res.text()).slice(0, 300));
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map(c => c.split(';')[0]).join('; ');
  check(res.ok, 'login do admin local');
  const adminPage = await fetch(`${BASE}/admin`, { headers: { cookie: cookies, ...ORIGIN } });
  const adminHtml = await adminPage.text();
  check(adminPage.ok && adminHtml.includes('id="tab-storage"') && adminHtml.includes('loadGoogleDriveStatus()'),
    'painel administrativo oferece estado e conexão do Google Drive compartilhado');
  const driveStatusResponse = await fetch(`${BASE}/api/admin/google-drive/status`, { headers: { cookie: cookies, ...ORIGIN } });
  const driveStatus = await driveStatusResponse.json();
  check(driveStatusResponse.ok && driveStatus.configured === false && driveStatus.connected === false,
    'status do Drive informa com segurança quando OAuth não está configurado no modo local');
  const driveStatusAnonymous = await fetch(`${BASE}/api/admin/google-drive/status`, { headers: ORIGIN });
  check(driveStatusAnonymous.status === 401,
    'status da conexão do Drive continua restrito ao administrador autenticado');
  // 2) cria sala
  res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
    body: JSON.stringify({ name: 'Sala do Preview' })
  });
  if (!res.ok) { console.error('sala resposta:', res.status, (await res.text()).slice(0, 300)); }
  check(res.ok, 'criação de sala');
  const room = res.ok ? await res.json() : { id: '' };
  // Mensagens longas preservam a estrutura original e não são truncadas na API.
  const roomLongContent = '  início  \r\n\tlinha indentada\n\n' + 'á🙂'.repeat(7000) + '\n fim  ';
  res = await fetch(`${BASE}/api/rooms/${room.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
    body: JSON.stringify({ content: roomLongContent })
  });
  const roomLongMessage = res.ok ? await res.json() : null;
  check(res.ok && roomLongMessage?.content === roomLongContent,
    'API da sala aceita mais de 12.000 caracteres sem truncar ou normalizar espaços e quebras de linha');
  const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie: cookies, ...ORIGIN } })).json();
  const directLongContent = '  SELECT *\r\n\tFROM teste;\n\n' + 'conteúdo🙂'.repeat(4000) + '  ';
  res = await fetch(`${BASE}/api/dm/${me.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
    body: JSON.stringify({ content: directLongContent })
  });
  const directLongResult = res.ok ? await res.json() : null;
  const directHistoryResponse = await fetch(`${BASE}/api/dm/${me.id}/messages`, { headers: { cookie: cookies, ...ORIGIN } });
  const directHistory = directHistoryResponse.ok ? await directHistoryResponse.json() : [];
  const directLongMessage = directHistory.find(message => message.id === directLongResult?.id);
  check(res.ok && directLongMessage?.content === directLongContent,
    'API da conversa direta aceita mais de 12.000 caracteres sem truncar ou normalizar espaços e quebras de linha');
  // 3) envia um arquivo pequeno (texto) e uma imagem
  const sendFile = async (name, mime, buffer) => {
    const form = new FormData();
    form.append('files', new Blob([buffer], { type: mime }), name);
    const r = await fetch(`${BASE}/api/rooms/${room.id}/files`, { method: 'POST', body: form, headers: { cookie: cookies, ...ORIGIN } });
    const data = await r.json().catch(() => []);
    if (!r.ok) console.error('upload resposta:', r.status, JSON.stringify(data).slice(0, 200));
    return { status: r.status, file: Array.isArray(data) ? data[0] : null };
  };
  const texto = await sendFile('nota.txt', 'text/plain', 'conteúdo do preview');
  check(texto.status === 200 && texto.file, 'upload de arquivo de texto');
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGP8z8Dwn4GKgImahoYBA2cG9gGpc5kAAAAASUVORK5CYII=';
  const imagem = await sendFile('dot.png', 'image/png', Buffer.from(pngB64, 'base64'));
  check(imagem.status === 200 && imagem.file, 'upload de imagem');

  // A Biblioteca edita somente o nome da cópia particular, nunca o original da sala.
  res = await fetch(`${BASE}/api/library/spaces`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
    body: JSON.stringify({ name: 'Arquivos de teste' })
  });
  const space = res.ok ? await res.json() : null;
  check(res.status === 201 && space, 'criação de espaço da Biblioteca');
  res = await fetch(`${BASE}/api/library/spaces/${space?.id}/shelves`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
    body: JSON.stringify({ name: 'Documentos' })
  });
  const shelf = res.ok ? await res.json() : null;
  check(res.status === 201 && shelf, 'criação de prateleira da Biblioteca');
  res = await fetch(`${BASE}/api/library`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
    body: JSON.stringify({ file_id: texto.file.id, space_id: space?.id, bookcase_id: shelf?.id })
  });
  const libraryItem = res.ok ? await res.json() : null;
  check(res.ok && libraryItem, 'guardar cópia de arquivo da sala na Biblioteca');
  if (libraryItem) {
    res = await fetch(`${BASE}/api/library/${libraryItem.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
      body: JSON.stringify({ original_name: 'nota-renomeada.txt' })
    });
    const renamed = res.ok ? await res.json() : null;
    check(res.ok && renamed?.original_name === 'nota-renomeada.txt', 'renomear item da Biblioteca preserva demais dados');
    res = await fetch(`${BASE}/api/library`, { headers: { cookie: cookies, ...ORIGIN } });
    const library = res.ok ? await res.json() : null;
    check(library?.items?.some(item => item.id === libraryItem.id && item.original_name === 'nota-renomeada.txt'), 'nome novo aparece na lista da Biblioteca');
    res = await fetch(`${BASE}/api/rooms`, { headers: { cookie: cookies, ...ORIGIN } });
    const rooms = res.ok ? await res.json() : [];
    const roomFile = rooms.find(item => item.id === room.id)?.files?.find(item => item.id === texto.file.id);
    check(roomFile?.original_name === 'nota.txt', 'renomear a cópia não altera o nome do original na sala');
  }

  // 4) preview do texto
  res = await fetch(`http://127.0.0.1:${PORT}/preview/${texto.file.id}`, { headers: { cookie: cookies } });
  const textoCorpo = await res.text();
  check(res.status === 200 && textoCorpo.includes('conteúdo do preview'), `preview de texto (status ${res.status})`);
  check(String(res.headers.get('content-type') || '').startsWith('text/plain'), 'content-type de texto inline');
  // 5) preview da imagem
  res = await fetch(`http://127.0.0.1:${PORT}/preview/${imagem.file.id}`, { headers: { cookie: cookies } });
  const imgBuf = Buffer.from(await res.arrayBuffer());
  check(res.status === 200 && imgBuf.length > 60 && imgBuf[1] === 0x50, `preview de imagem (status ${res.status}, ${imgBuf.length} bytes)`);
  // 6) download
  res = await fetch(`http://127.0.0.1:${PORT}/download/${texto.file.id}`, { headers: { cookie: cookies } });
  const dl = await res.text();
  check(res.status === 200 && dl.includes('conteúdo do preview'), 'download do arquivo');
  check(String(res.headers.get('content-disposition') || '').includes('attachment'), 'content-disposition attachment no download');
} finally {
  child.kill();
  await new Promise(r => child.once('exit', r));
  rmSync(dataDir, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} falha(s).`); process.exit(1); }
console.log('\nTodas as asserções passaram.');
