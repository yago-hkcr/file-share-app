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