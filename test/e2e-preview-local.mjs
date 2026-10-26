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
  // 2) cria sala
  res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
    body: JSON.stringify({ name: 'Sala do Preview' })
  });
  if (!res.ok) { console.error('sala resposta:', res.status, (await res.text()).slice(0, 300)); }
  check(res.ok, 'criação de sala');
  const room = res.ok ? await res.json() : { id: '' };
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
