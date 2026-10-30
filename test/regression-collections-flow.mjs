// Regressão end-to-end: criação de coleta, link público, upload e consulta pelo organizador.
// O teste usa o servidor real com PGlite temporário e não acessa produção.
//
// Uso: node test/regression-collections-flow.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || (48000 + Math.floor(Math.random() * 10000)));
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'senha-teste-123456';
const SESSION_SECRET = 'sessao-teste-segura-1234567890';
const dataDir = mkdtempSync(path.join(tmpdir(), 'coletas-regressao-'));
const cookies = new Map();
let failures = 0;

function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) failures++;
}

function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FILESHARE_LOCAL: '1',
      FILESHARE_DATA_DIR: dataDir,
      FILESHARE_NO_BROWSER: '1',
      PORT: String(PORT),
      ADMIN_PASSWORD,
      SESSION_SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitHealthy() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* servidor ainda iniciando */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Servidor local não respondeu em /health.');
}

function rememberCookies(response) {
  const values = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const pair = value.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function request(route, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookies.size) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
  if (options.body && typeof options.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('origin', BASE);
  const response = await fetch(`${BASE}${route}`, { ...options, headers });
  rememberCookies(response);
  return response;
}

let child;
try {
  child = startServer();
  await waitHealthy();

  let response = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
  });
  check(response.ok, 'login do administrador local');
  if (!response.ok) throw new Error('Não foi possível autenticar no servidor temporário.');

  response = await request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sala da coleta de teste' })
  });
  const room = response.ok ? await response.json() : null;
  check(response.ok && Boolean(room?.id), 'criação de sala de destino');
  if (!room?.id) throw new Error('Não foi possível criar a sala temporária.');

  const deadline = new Date(Date.now() + 60 * 60 * 1000);
  response = await request('/api/coletas', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Documentos de teste',
      destination_type: 'room',
      room_id: room.id,
      expires_at: deadline.toISOString(),
      items: [{ label: 'Comprovante', quantity: 1, required: true }],
      participants: [],
      single_link: true
    })
  });
  const collection = response.ok ? await response.json() : null;
  check(response.status === 201 && Boolean(collection?.id && collection?.recipients?.[0]?.token),
    'criação da coleta e geração do link individual');
  if (!collection?.recipients?.[0]?.token) throw new Error('A coleta não retornou um link de envio.');

  const token = collection.recipients[0].token;
  const publicBase = `/api/coletas/enviar/${encodeURIComponent(token)}`;
  response = await request(publicBase);
  const publicState = response.ok ? await response.json() : null;
  check(response.ok && publicState?.items?.some(item => item.label === 'Comprovante'),
    'consulta do formulário público lista o item solicitado');
  if (!publicState?.items?.[0]?.id) throw new Error('O link público não carregou os itens da coleta.');

  const form = new FormData();
  form.set('item_id', publicState.items[0].id);
  form.set('file', new Blob(['arquivo recebido pela coleta\n'], { type: 'text/plain' }), 'comprovante.txt');
  response = await request(`${publicBase}/upload`, { method: 'POST', body: form });
  const upload = response.ok ? await response.json() : null;
  check(response.status === 201 && Boolean(upload?.id), 'upload multipart é recebido e armazenado');
  if (!upload?.id) throw new Error('Não foi possível concluir o upload temporário.');

  response = await request(`${publicBase}/finalizar`, {
    method: 'POST',
    body: JSON.stringify({ participant_name: 'Participante de teste' })
  });
  const submission = response.ok ? await response.json() : null;
  check(response.ok && submission?.state === 'submitted', 'finalização do envio fecha o link individual');

  response = await request('/api/coletas');
  const collections = response.ok ? await response.json() : [];
  const saved = collections.find(item => item.id === collection.id);
  check(response.ok && saved?.recipients?.[0]?.status === 'submitted',
    'painel do organizador mostra o participante como enviado');
  check(saved?.submissions?.some(item => item.sender_name === 'Participante de teste' && Number(item.upload_count) === 1),
    'painel do organizador registra o envio e a contagem do arquivo');

  response = await request(`/api/coletas/${encodeURIComponent(collection.id)}/zip`);
  const zip = Buffer.from(await response.arrayBuffer());
  check(response.ok && zip[0] === 0x50 && zip[1] === 0x4b,
    'download do arquivo recebido como ZIP válido');

  response = await request('/api/library/spaces', {
    method: 'POST', body: JSON.stringify({ name: 'Acervo da coleta de teste' })
  });
  const space = response.ok ? await response.json() : null;
  check(response.status === 201 && Boolean(space?.id), 'criação do espaço de Acervo para validar armazenamento Postgres');
  response = await request(`/api/library/spaces/${encodeURIComponent(space?.id || '')}/shelves`, {
    method: 'POST', body: JSON.stringify({ name: 'Arquivos recebidos' })
  });
  const bookcase = response.ok ? await response.json() : null;
  check(response.status === 201 && Boolean(bookcase?.id), 'criação da prateleira de teste');

  response = await request('/api/coletas', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Arquivos ao Acervo via Postgres', destination_type: 'library',
      library_space_id: space.id, library_bookcase_id: bookcase.id,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      items: [{ label: 'Arquivo do Acervo', quantity: 1, required: true }],
      participants: [], single_link: true
    })
  });
  const libraryCollection = response.ok ? await response.json() : null;
  const libraryToken = libraryCollection?.recipients?.[0]?.token;
  check(response.status === 201 && Boolean(libraryToken), 'criação de coleta com destino direto ao Acervo');
  if (!libraryToken) throw new Error('Não foi possível criar coleta de teste para o Acervo.');
  const libraryPublicBase = `/api/coletas/enviar/${encodeURIComponent(libraryToken)}`;
  response = await request(libraryPublicBase);
  const libraryPublicState = response.ok ? await response.json() : null;
  const libraryForm = new FormData();
  libraryForm.set('item_id', libraryPublicState.items[0].id);
  libraryForm.set('file', new Blob(['arquivo persistido em Postgres\n'], { type: 'text/plain' }), 'arquivo-acervo.txt');
  response = await request(`${libraryPublicBase}/upload`, { method: 'POST', body: libraryForm });
  const libraryUpload = response.ok ? await response.json() : null;
  check(response.status === 201 && Boolean(libraryUpload?.id), 'upload de arquivo para coleta com destino ao Acervo');
  response = await request(`${libraryPublicBase}/finalizar`, {
    method: 'POST', body: JSON.stringify({ participant_name: 'Participante do Acervo' })
  });
  check(response.ok, 'finalização e promoção do upload Postgres para o Acervo');
  response = await request('/api/library');
  const library = response.ok ? await response.json() : null;
  const libraryFile = library?.items?.find(file => file.original_name === 'arquivo-acervo.txt');
  check(Boolean(libraryFile), 'arquivo da coleta aparece no Acervo após finalização');
  if (libraryFile) {
    response = await request(`/download/library/${encodeURIComponent(libraryFile.id)}`);
    const downloaded = Buffer.from(await response.arrayBuffer());
    check(response.ok && downloaded.includes(Buffer.from('arquivo persistido em Postgres')),
      'download do arquivo promovido ao Acervo contém os bytes originais');
  }
} catch (error) {
  console.error('Erro no teste end-to-end de Coletas:', error && error.message || error);
  failures++;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} falha(s) no fluxo end-to-end de Coletas.`);
  process.exit(1);
}
console.log('\nFluxo end-to-end de Coletas validado com sucesso.');