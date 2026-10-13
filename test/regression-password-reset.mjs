// Teste de regressão: "esqueci minha senha" (token de 1h, uso único, resposta genérica)
// + login permanente (cookies de sessão e "lembrar de mim" com ~1 ano de validade).
// Uso: node test/regression-password-reset.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 4789);
const ADMIN_PASSWORD = 'senha-teste-123456';
const SESSION_SECRET = 'sessao-teste-segura-1234567890';
const dataDir = mkdtempSync(path.join(tmpdir(), 'reset-e2e-'));

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
const cookieDays = (cookieStr, name) => {
  const c = (cookieStr || '').split(/,(?=[^;]+?=)/).find(x => x.includes(name + '='));
  const expires = (c && c.match(/Expires=([^;]+)/i) || [])[1] || '';
  return expires ? Math.round((Date.parse(expires) - Date.now()) / 86400000) : 0;
};

const child = startServer();
const BASE = `http://127.0.0.1:${PORT}`;
const JSON_HEADERS = { 'Content-Type': 'application/json', origin: BASE };
let serverLog = '';
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

try {
  await waitHealthy();

  // 1) cria um usuário comum
  const unique = Date.now();
  const email = `maria${unique}@teste.local`;
  const reg = await fetch(BASE + '/api/register', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'maria' + unique, email, password: 'senha-antiga-123' }) });
  const regText = await reg.text();
  if (!reg.ok) console.log('  [debug register]', reg.status, regText.slice(0, 200));
  check(reg.ok, 'cadastro do usuário de teste');

  // 2) pede redefinição — resposta deve ser genérica (200)
  const forgot = await fetch(BASE + '/api/forgot-password', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email }) });
  const forgotBody = await forgot.json();
  check(forgot.ok && forgotBody.success, 'pedido de redefinição responde com sucesso genérico');

  // 3) e-mail inexistente recebe a mesma resposta (anti-enumeracao)
  const ghost = await fetch(BASE + '/api/forgot-password', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'fantasma@teste.local' }) });
  const ghostBody = await ghost.json();
  check(ghost.ok && ghostBody.message === forgotBody.message, 'e-mail inexistente recebe a mesma resposta genérica');

  // 4) extrai o link do log do servidor (modo local, sem RESEND_API_KEY)
  await new Promise(r => setTimeout(r, 400));
  const m = serverLog.match(/\/reset-password\?token=([a-f0-9]{64})/);
  check(Boolean(m), 'link de redefinição emitido (log local)');
  const token = m ? m[1] : '';

  // 5) redefinição com senha nova
  const reset = await fetch(BASE + '/api/reset-password', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token, password: 'senha-nova-456' }) });
  const resetBody = await reset.json();
  check(reset.ok && resetBody.success, 'senha redefinida com o token');

  // 6) token é de uso único
  const replay = await fetch(BASE + '/api/reset-password', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token, password: 'outra-senha-789' }) });
  check(replay.status === 400, 'token não pode ser reutilizado');

  // 7) login com a senha nova funciona; a antiga falha
  const goodLogin = await fetch(BASE + '/api/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: email, password: 'senha-nova-456' }) });
  check(goodLogin.ok, 'login com a nova senha');
  const badLogin = await fetch(BASE + '/api/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: email, password: 'senha-antiga-123' }) });
  check(badLogin.status === 401, 'senha antiga rejeitada');

  // 8) login permanente: cookies de sessão e "lembrar de mim" com ~1 ano
  const setCookies = goodLogin.headers.getSetCookie().join('\n');
  const sessionDays = cookieDays(setCookies, 'fileshare_session');
  const rememberDays = cookieDays(setCookies, 'fs_remember');
  check(sessionDays > 300, `cookie de sessão persistente (~1 ano): ${sessionDays} dias`);
  check(rememberDays > 300, `cookie "lembrar de mim" persistente (~1 ano): ${rememberDays} dias`);

  // 9) páginas novas acessíveis
  const page1 = await fetch(BASE + '/forgot-password');
  check(page1.ok && (await page1.text()).includes('RECUPERAR'), 'página "esqueci minha senha" acessível');
  const page2 = await fetch(BASE + '/reset-password?token=' + token);
  check(page2.ok && (await page2.text()).includes('NOVA SENHA'), 'página de nova senha acessível');

  // 10) /health indica o estado do envio de e-mail
  const health = await (await fetch(BASE + '/health')).json();
  check(health.status === 'ok' && health.email_configured === false, '/health expõe email_configured (false sem RESEND_API_KEY)');
} finally {
  child.kill();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.exit(failures ? 1 : 0);
