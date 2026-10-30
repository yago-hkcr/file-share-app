// Regressão real no Edge: cria uma coleta local, seleciona um arquivo no
// campo de arquivo, confirma a tela e verifica o arquivo recebido no ZIP.
// Não usa credenciais nem dados de produção.
//
// Uso: node test/regression-collections-browser-upload.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 51000 + Math.floor(Math.random() * 9000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'coleta-browser-test-123456';
const SESSION_SECRET = 'coleta-browser-session-secret-123456789';
const dataDir = mkdtempSync(path.join(tmpdir(), 'coletas-edge-upload-'));
const profile = mkdtempSync(path.join(tmpdir(), 'edge-coletas-browser-'));
const uploadPath = path.join(dataDir, 'edge-upload-check.txt');
const uploadContents = Buffer.from('Edge upload ok\n');
writeFileSync(uploadPath, uploadContents);

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const edgePath = edgeCandidates.find(candidate => {
  try { return existsSync(candidate); } catch { return false; }
});
if (!edgePath) {
  rmSync(profile, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  console.error('SKIP - Microsoft Edge não encontrado para o teste de navegador.');
  process.exit(2);
}

let server;
let browser;
let socket;
let serverOutput = '';
let failures = 0;
let sequence = 0;
const pendingCommands = new Map();
const cookies = new Map();
const apiResponses = [];
const javascriptErrors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function check(condition, label) {
  console.log(`${condition ? 'PASSOU' : 'FALHOU'} - ${label}`);
  if (!condition) failures++;
}

function rememberCookies(response) {
  const setCookies = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const cookie of setCookies) {
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function request(route, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
  headers.set('origin', BASE);
  if (typeof options.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${BASE}${route}`, { ...options, headers });
  rememberCookies(response);
  return response;
}

function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pendingCommands.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (!pendingCommands.has(id)) return;
      pendingCommands.delete(id);
      reject(new Error(`Timeout CDP: ${method}`));
    }, 15000);
  });
}

async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text || 'Erro de avaliação no Edge.');
  return response.result?.result?.value;
}

async function waitFor(expression, description, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await delay(150);
  }
  throw new Error(`Timeout aguardando ${description}.`);
}

try {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FILESHARE_LOCAL: '1',
      FILESHARE_DATA_DIR: dataDir,
      FILESHARE_NO_BROWSER: '1',
      PORT: String(PORT),
      ADMIN_PASSWORD: PASSWORD,
      SESSION_SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  server.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

  let healthy = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) { healthy = true; break; }
    } catch { /* servidor temporário ainda inicializando */ }
    await delay(250);
  }
  if (!healthy) throw new Error('Servidor temporário não iniciou.');

  let response = await request('/api/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD })
  });
  if (!response.ok) throw new Error(`Login temporário falhou (${response.status}).`);

  response = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Sala teste Edge upload' }) });
  const room = response.ok ? await response.json() : null;
  if (!room?.id) throw new Error(`Criação da sala falhou (${response.status}).`);

  response = await request('/api/coletas', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Coleta teste Edge upload', destination_type: 'room', room_id: room.id,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      items: [{ label: 'Comprovante de teste', quantity: 1, required: true }],
      participants: [], single_link: true
    })
  });
  const collection = response.ok ? await response.json() : null;
  const token = collection?.recipients?.[0]?.token;
  if (!token) throw new Error(`Criação da coleta falhou (${response.status}).`);
  console.log('PASSOU - servidor, sala e coleta locais preparados');

  const cdpPort = 27000 + Math.floor(Math.random() * 18000);
  browser = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--no-first-run',
    '--disable-background-networking', `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let target;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
      break;
    } catch { await delay(250); }
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('Edge CDP não iniciou.');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pendingCommands.has(message.id)) {
      pendingCommands.get(message.id).resolve(message);
      pendingCommands.delete(message.id);
    } else if (message.method === 'Runtime.exceptionThrown') {
      javascriptErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'Exceção JavaScript');
    } else if (message.method === 'Network.responseReceived' && String(message.params.response?.url || '').includes('/api/coletas/enviar/')) {
      apiResponses.push({ status: message.params.response.status, url: message.params.response.url });
    }
  });

  await command('Runtime.enable');
  await command('Page.enable');
  await command('Network.enable');
  await command('Page.navigate', { url: `${BASE}/enviar/${token}` });
  await waitFor(`!!document.querySelector('[data-sender-name-form]')`, 'formulário público da coleta');
  await evaluate(`(()=>{const form=document.querySelector('[data-sender-name-form]');form.querySelector('#collectionSenderName').value='Teste automatizado Edge';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
  await waitFor(`!!document.querySelector('input[type="file"][data-item-id]')`, 'campo de seleção de arquivo');
  await command('DOM.enable');
  const documentNode = await command('DOM.getDocument', { depth: -1, pierce: true });
  const fileInput = await command('DOM.querySelector', { nodeId: documentNode.result.root.nodeId, selector: 'input[type="file"][data-item-id]' });
  if (!fileInput.result.nodeId) throw new Error('O campo de arquivo não foi encontrado no DOM.');
  await command('DOM.setFileInputFiles', { nodeId: fileInput.result.nodeId, files: [uploadPath] });
  await evaluate(`document.querySelector('input[type="file"][data-item-id]').dispatchEvent(new Event('change',{bubbles:true}))`);

  await waitFor(`!!document.querySelector('[data-review]')`, 'botão de revisão após seleção');
  const selectedState = await evaluate(`JSON.stringify({name:document.getElementById('collectionPublicRoot').innerText, selected:document.querySelectorAll('.collection-preview-card').length})`);
  console.log('Estado após selecionar arquivo:', selectedState);
  check(JSON.parse(selectedState).name.includes('edge-upload-check.txt'), 'arquivo descartável selecionado no formulário Edge');

  await evaluate(`document.querySelector('[data-review]').click()`);
  await waitFor(`!!document.querySelector('[data-confirm]')`, 'revisão do envio');
  await evaluate(`document.querySelector('[data-confirm]').click()`);

  try {
    await waitFor(`document.getElementById('collectionPublicRoot')?.innerText.includes('Envio concluído')`, 'conclusão exibida no navegador', 30000);
  } catch {
    const diagnostic = await evaluate(`JSON.stringify({text:document.getElementById('collectionPublicRoot')?.innerText, queue:document.querySelector('#fsUploadQueuePanel')?.innerText, script:[...document.scripts].map(script=>script.src).filter(src=>src.includes('collection-upload'))})`);
    console.error('Diagnóstico da página após confirmar:', diagnostic);
    throw new Error('A página não confirmou o envio do arquivo.');
  }

  check(apiResponses.some(item => item.url.endsWith('/upload') && item.status === 201), 'upload multipart respondeu HTTP 201');
  check(apiResponses.some(item => item.url.endsWith('/finalizar') && item.status === 200), 'finalização respondeu HTTP 200');
  check(javascriptErrors.length === 0, javascriptErrors.length ? `sem exceções JavaScript: ${javascriptErrors.join(' | ')}` : 'nenhuma exceção JavaScript no Edge');

  response = await request('/api/coletas');
  const collections = response.ok ? await response.json() : [];
  const saved = collections.find(item => item.id === collection.id);
  check(saved?.submissions?.some(item => item.sender_name === 'Teste automatizado Edge' && Number(item.upload_count) === 1), 'servidor registrou um arquivo no envio');

  response = await request(`/api/coletas/${encodeURIComponent(collection.id)}/zip`);
  const zip = Buffer.from(await response.arrayBuffer());
  check(response.ok && zip.includes(uploadContents), 'arquivo recebido está presente no ZIP da coleta');
  console.log('Respostas API da coleta:', apiResponses.map(item => {
    const pathname = new URL(item.url).pathname;
    const endpoint = pathname.split('/').at(-1);
    return `${item.status} ${['upload', 'finalizar'].includes(endpoint) ? endpoint : 'estado'}`;
  }).join(' | '));
} catch (error) {
  console.error('Erro no teste de navegador da coleta:', error.message);
  if (serverOutput) console.error('Log do servidor local:', serverOutput.split(/\r?\n/).slice(-20).join('\n'));
  failures++;
} finally {
  try { socket?.close(); } catch {}
  if (browser && browser.exitCode === null) browser.kill();
  if (server && server.exitCode === null) server.kill();
  await delay(400);
  rmSync(profile, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} falha(s) no upload real pelo Edge.`);
  process.exit(1);
}
console.log('\nUpload real pelo Edge, API e ZIP validados com sucesso.');