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
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk.toString(); });
child.stderr.on('data', chunk => { serverLog += chunk.toString(); });
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
  let cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map(c => c.split(';')[0]).join('; ');
  check(res.ok, 'login do admin local');
  check(cookies.includes('fs_device='), 'login cria uma credencial persistente vinculada ao dispositivo');
  const csrfCookies = Object.fromEntries(cookies.split('; ').map(part => { const index = part.indexOf('='); return [part.slice(0, index), part.slice(index + 1)]; }));
  const rememberToken = csrfCookies.fs_remember;
  const recoveredCookieLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN, cookie: `fs_remember=${rememberToken}`, 'user-agent': 'Chrome/120.0 (Windows NT 10.0)' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
  });
  const recoveredCookieLoginBody = await recoveredCookieLogin.json();
  const recoveredCookieValues = (recoveredCookieLogin.headers.getSetCookie ? recoveredCookieLogin.headers.getSetCookie() : [recoveredCookieLogin.headers.get('set-cookie')])
    .filter(Boolean).map(cookie => cookie.split(';')[0]);
  if (!recoveredCookieLogin.ok || recoveredCookieLoginBody.is_primary_device !== true || !recoveredCookieValues.some(cookie => cookie.startsWith('fs_device='))) {
    console.log('  [debug remember recovery]', recoveredCookieLogin.status, recoveredCookieLoginBody, recoveredCookieValues);
  }
  check(recoveredCookieLogin.ok && recoveredCookieLoginBody.is_primary_device === true
    && recoveredCookieValues.some(cookie => cookie.startsWith('fs_device=')),
  'cookie lembrar-me restaura o dispositivo principal aprovado quando o cookie de aparelho foi perdido');
  cookies = [...new Set([`fs_remember=${rememberToken}`, ...recoveredCookieValues])].join('; ');
  const adminPage = await fetch(`${BASE}/admin`, { headers: { cookie: cookies, ...ORIGIN } });
  const adminHtml = await adminPage.text();
  check(adminPage.ok && adminHtml.includes('id="tab-storage"') && adminHtml.includes('loadGoogleDriveStatus()'),
    'painel administrativo oferece estado e conexão do Google Drive compartilhado');
  check(adminHtml.includes('pendingDeviceNotice') && adminHtml.includes('loadPendingDeviceNotice()'),
    'painel ADM mostra aviso separado para pedidos e direciona à gestão de dispositivos');
  const loginHtml = await (await fetch(`${BASE}/`)).text();
  check(loginHtml.includes('pendingDeviceRecoveryEmailGroup') && loginHtml.includes('Recuperar acesso ao principal por e-mail')
    && loginHtml.includes('Isso não remove o aparelho principal') && loginHtml.includes('window.pendingDevicePoll'),
  'login explica que pedidos não removem o principal e permite solicitar recuperação por e-mail sem trocar o usuário');
  const driveStatusResponse = await fetch(`${BASE}/api/admin/google-drive/status`, { headers: { cookie: cookies, ...ORIGIN } });
  const driveStatus = await driveStatusResponse.json();
  if (!driveStatusResponse.ok || driveStatus.configured !== false) console.log('  [debug drive status]', driveStatusResponse.status, driveStatus);
  check(driveStatusResponse.ok && driveStatus.configured === false && driveStatus.connected === false && driveStatus.verified === false && driveStatus.storage_quota === null,
    'status do Drive informa com segurança quando OAuth não está configurado no modo local');
  check(!Object.hasOwn(driveStatus, 'scope') && !Object.hasOwn(driveStatus, 'redirect_uri') && !Object.hasOwn(driveStatus, 'verification_error'),
    'status do Drive não expõe escopo OAuth, URL de callback ou erro técnico');
  const driveStatusAnonymous = await fetch(`${BASE}/api/admin/google-drive/status`, { headers: ORIGIN });
  check(driveStatusAnonymous.status === 401,
    'status da conexão do Drive continua restrito ao administrador autenticado');
  const deviceManagementPage = await fetch(`${BASE}/admin/devices`, { headers: { cookie: cookies, ...ORIGIN } });
  const deviceManagementHtml = await deviceManagementPage.text();
  check(deviceManagementPage.ok && deviceManagementHtml.includes('Dispositivos vinculados'), 'painel ADM inclui página de gerenciamento de dispositivos');
  check(deviceManagementHtml.includes('setInterval(() => { if (!document.hidden) load(); }, 3000)'),
    'gestão de dispositivos atualiza automaticamente pedidos novos sem recarregar a página');
  const deviceListResponse = await fetch(`${BASE}/api/devices`, { headers: { cookie: cookies, ...ORIGIN } });
  const deviceList = await deviceListResponse.json();
  if (!deviceListResponse.ok) console.log('  [debug devices]', deviceListResponse.status, deviceList);
  check(deviceListResponse.ok && deviceList.is_primary && deviceList.devices.some(device => device.is_primary && device.is_current),
    'primeiro aparelho aprovado é principal e aparece na gestão de dispositivos');
  const secondDeviceLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN, cookie: `fs_device=${'0'.repeat(64)}`, 'user-agent': 'Chrome/120.0 (Windows NT 10.0)' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
  });
  const pendingDevice = await secondDeviceLogin.json();
  const secondCookies = (secondDeviceLogin.headers.getSetCookie ? secondDeviceLogin.headers.getSetCookie() : [secondDeviceLogin.headers.get('set-cookie')])
    .filter(Boolean).map(c => c.split(';')[0]).join('; ');
  const pendingCookieValues = Object.fromEntries(secondCookies.split('; ').map(part => { const index = part.indexOf('='); return [part.slice(0, index), part.slice(index + 1)]; }));
  check(secondDeviceLogin.status === 202 && pendingDevice.state === 'device_pending' && secondCookies.includes('fs_device='),
    'novo aparelho entra em espera até aprovação e recebe identidade própria');
  const principalStillUsable = await fetch(`${BASE}/api/devices`, { headers: { cookie: cookies, ...ORIGIN } });
  check(principalStillUsable.ok, 'solicitação em outro aparelho não remove o acesso do dispositivo principal já autorizado');
  const approvalNoticeResponse = await fetch(`${BASE}/api/notifications`, { headers: { cookie: cookies, ...ORIGIN } });
  const approvalNotices = approvalNoticeResponse.ok ? await approvalNoticeResponse.json() : [];
  check(approvalNoticeResponse.ok && !approvalNotices.some(item => item.type === 'device_pending'),
    'pedido de novo aparelho não é misturado às notificações genéricas da conta');
  const pendingApprovalsResponse = await fetch(`${BASE}/api/devices/pending`, { headers: { cookie: cookies, ...ORIGIN } });
  const pendingApprovalsData = pendingApprovalsResponse.ok ? await pendingApprovalsResponse.json() : {};
  check(pendingApprovalsResponse.ok && Array.isArray(pendingApprovalsData.devices) && pendingApprovalsData.devices.length > 0 && pendingApprovalsData.devices.every(device => device.id && device.name && device.created_at),
    'dispositivo principal consegue consultar os pedidos para aprovar');
  const dashboardResponse = await fetch(`${BASE}/dashboard`, { headers: { cookie: cookies, ...ORIGIN } });
  const dashboardHtml = await dashboardResponse.text();
  check(dashboardResponse.ok && dashboardHtml.includes('pendingDeviceApprovalBanner') && dashboardHtml.includes('20261102b'),
    'dashboard inclui alerta destacado para pedidos e carrega o cliente de notificações atualizado');
  const serviceWorkerResponse = await fetch(`${BASE}/sw.js`);
  const serviceWorkerSource = await serviceWorkerResponse.text();
  check(serviceWorkerResponse.ok && serviceWorkerSource.includes("new URL(client.url).pathname === '/dashboard'") && serviceWorkerSource.includes("admin.navigate('/dashboard')"),
    'clique na notificação direciona ao dashboard da conta, não ao painel ADM');
  const pendingList = await (await fetch(`${BASE}/api/devices`, { headers: { cookie: cookies, ...ORIGIN } })).json();
  if (!pendingList.devices) console.log('  [debug pending devices]', pendingList);
  if (!pendingList.devices) throw new Error('Falha ao carregar a lista de dispositivos. Log do servidor:\n' + serverLog.slice(-8000));
  const pending = pendingList.devices.find(device => device.status === 'pending');
  check(Boolean(pending), 'principal visualiza solicitação pendente');
  if (pending) {
    const noPasswordApproval = await fetch(`${BASE}/api/devices/${pending.id}/approve`, { method: 'POST', headers: { cookie: cookies, ...ORIGIN } });
    check(noPasswordApproval.status === 401, 'aprovação exige confirmação recente da senha');
    const approveResponse = await fetch(`${BASE}/api/devices/${pending.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN }, body: JSON.stringify({ confirmationPassword: ADMIN_PASSWORD }) });
    const afterApproval = await fetch(`${BASE}/api/devices/pending-status`, { headers: { cookie: 'fs_device=' + pendingCookieValues.fs_device, ...ORIGIN } });
    check(approveResponse.ok && (await afterApproval.json()).state === 'approved', 'aprovação libera o novo aparelho');
    const secondaryLogin = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN, cookie: 'fs_device=' + pendingCookieValues.fs_device }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }) });
    const secondaryLoginBody = await secondaryLogin.json();
    const secondarySessionCookies = ['fs_device=' + pendingCookieValues.fs_device, ...(secondaryLogin.headers.getSetCookie ? secondaryLogin.headers.getSetCookie() : [secondaryLogin.headers.get('set-cookie')]).filter(Boolean).map(c => c.split(';')[0])].join('; ');
    if (!secondaryLogin.ok) console.log('  [debug secondary login]', secondaryLogin.status, secondaryLoginBody, secondarySessionCookies);
    const secondaryListResponse = await fetch(`${BASE}/api/devices`, { headers: { cookie: secondarySessionCookies, ...ORIGIN } });
    if (secondaryListResponse.status !== 403) console.log('  [debug secondary devices]', secondaryListResponse.status, await secondaryListResponse.text());
    check(secondaryListResponse.status === 403, 'dispositivo aprovado não principal não pode gerenciar dispositivos');
    const secondaryPendingResponse = await fetch(`${BASE}/api/devices/pending`, { headers: { cookie: secondarySessionCookies, ...ORIGIN } });
    check(secondaryPendingResponse.status === 403, 'dispositivo aprovado não principal não pode consultar pedidos de acesso');
    const avatarResponse = await fetch(`${BASE}/api/profile/avatar`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: secondarySessionCookies, ...ORIGIN }, body: JSON.stringify({ image: null }) });
    if (avatarResponse.status !== 403) console.log('  [debug secondary avatar]', avatarResponse.status, await avatarResponse.text());
    check(avatarResponse.status === 403, 'dispositivo secundário não pode alterar dados pessoais do perfil');
    const revokeResponse = await fetch(`${BASE}/api/devices/${pending.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN }, body: JSON.stringify({ confirmationPassword: ADMIN_PASSWORD }) });
    const revokedLogin = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN, cookie: 'fs_device=' + pendingCookieValues.fs_device }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }) });
    check(revokeResponse.ok && revokedLogin.status === 202, 'revogação imediata impede renovar sessão no aparelho removido');
    const revokedApprovalNotice = await fetch(`${BASE}/api/devices/pending`, { headers: { cookie: cookies, ...ORIGIN } });
    const revokedApprovalData = revokedApprovalNotice.ok ? await revokedApprovalNotice.json() : {};
    check(revokedApprovalNotice.ok && !revokedApprovalData.devices.some(device => device.id === pending.id), 'pedido recusado deixa de aparecer no fluxo principal de aprovação');
    const revokedApiAccess = await fetch(`${BASE}/api/me`, { headers: { cookie: secondarySessionCookies, ...ORIGIN } });
    check(revokedApiAccess.status === 401, 'revogação imediata bloqueia a sessão ativa do aparelho removido');
  }
  const transferUserAgents = ['Edg/130.0 (Windows NT 10.0)', 'Firefox/130.0 (Macintosh)'];
  const transferLogins = await Promise.all(transferUserAgents.map(userAgent =>
    fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN, 'user-agent': userAgent },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
    })));
  const transferDevices = [];
  for (let index = 0; index < transferLogins.length; index++) {
    const response = transferLogins[index];
    const body = await response.json();
    const setCookies = (response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')]).filter(Boolean);
    const deviceCookie = setCookies.map(cookie => cookie.split(';')[0]).find(cookie => cookie.startsWith('fs_device='));
    transferDevices.push({ response, body, deviceCookie, userAgent: transferUserAgents[index], id: null, cookies: null });
  }
  check(transferDevices.every(device => device.response.status === 202 && device.body.state === 'device_pending' && device.deviceCookie),
    'aparelhos candidatos a principal iniciam como pedidos pendentes');
  for (const device of transferDevices) {
    const request = await fetch(`${BASE}/api/devices/pending-status`, { headers: { cookie: device.deviceCookie, ...ORIGIN } });
    check(request.ok && (await request.json()).state === 'pending', 'pedido candidato mantém identidade própria para aprovação');
    const pendingDevicesResponse = await fetch(`${BASE}/api/devices`, { headers: { cookie: cookies, ...ORIGIN } });
    const pendingDevices = await pendingDevicesResponse.json();
    const expectedDeviceName = device.userAgent.includes('Firefox') ? 'Firefox · Mac' : 'Microsoft Edge · Windows';
    const target = pendingDevices.devices?.find(item => item.status === 'pending' && item.name === expectedDeviceName && item.id);
    if (!target) throw new Error('Não foi possível encontrar o pedido candidato para aprovação.');
    device.id = target.id;
    const approved = await fetch(`${BASE}/api/devices/${device.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
      body: JSON.stringify({ confirmationPassword: ADMIN_PASSWORD })
    });
    check(approved.ok, 'principal aprova aparelho candidato à transferência');
    const login = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN, cookie: device.deviceCookie, 'user-agent': device.userAgent },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
    });
    const loginBody = await login.json();
    const loginCookies = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')]).filter(Boolean).map(cookie => cookie.split(';')[0]);
    device.cookies = [device.deviceCookie, ...loginCookies].join('; ');
    check(login.status === 200 && loginBody.success, 'aparelho candidato aprovado consegue iniciar sessão');
  }
  const transferResponses = await Promise.all(transferDevices.map(device => fetch(`${BASE}/api/devices/${device.id}/primary`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies, ...ORIGIN },
    body: JSON.stringify({ confirmationPassword: ADMIN_PASSWORD })
  })));
  const transferStatuses = transferResponses.map(response => response.status).sort((a, b) => a - b);
  check(transferStatuses.filter(status => status === 200).length === 1
    && transferStatuses.every(status => status === 200 || status === 403 || status === 409),
  'duas transferências simultâneas resultam em exatamente uma vencedora e a outra é bloqueada');
  const winnerIndex = transferResponses.findIndex(response => response.ok);
  if (winnerIndex >= 0) {
    cookies = transferDevices[winnerIndex].cookies;
    const afterTransferResponse = await fetch(`${BASE}/api/devices`, { headers: { cookie: cookies, ...ORIGIN } });
    const afterTransfer = await afterTransferResponse.json();
    const primaryDevices = (afterTransfer.devices || []).filter(device => device.is_primary);
    check(afterTransferResponse.ok && afterTransfer.is_primary && primaryDevices.length === 1
      && primaryDevices[0].id === transferDevices[winnerIndex].id,
    'após transferências concorrentes existe exatamente um aparelho principal e é o vencedor');
    const losingIndex = winnerIndex === 0 ? 1 : 0;
    const losingManagement = await fetch(`${BASE}/api/devices`, { headers: { cookie: transferDevices[losingIndex].cookies, ...ORIGIN } });
    check(losingManagement.status === 403, 'aparelho perdedor da disputa não recebe permissões de principal');
  }
  const recoveryDeviceLogin = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN, 'user-agent': 'Firefox/130.0 (Linux)' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }) });
  const recoveryDeviceLoginBody = await recoveryDeviceLogin.json();
  const recoveryDeviceCookies = (recoveryDeviceLogin.headers.getSetCookie ? recoveryDeviceLogin.headers.getSetCookie() : [recoveryDeviceLogin.headers.get('set-cookie')]).filter(Boolean).map(cookie => cookie.split(';')[0]).join('; ');
  const recoveryRequest = await fetch(`${BASE}/api/devices/recovery/request`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify({ email: 'admin@fileshare.com' }) });
  const recoveryRequestBody = await recoveryRequest.json();
  await new Promise(resolve => setTimeout(resolve, 100));
  const recoveryToken = (serverLog.match(/\/device-recovery\?token=([a-f0-9]{64})/) || [])[1];
  const recoveryClaim = await fetch(`${BASE}/api/devices/recovery/claim`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: recoveryDeviceCookies, ...ORIGIN }, body: JSON.stringify({ token: recoveryToken, password: ADMIN_PASSWORD }) });
  check(recoveryDeviceLogin.status === 202 && recoveryDeviceLoginBody.state === 'device_pending' && recoveryRequest.ok && recoveryRequestBody.success && Boolean(recoveryToken) && recoveryClaim.ok,
    'recuperação por e-mail, senha atual e token de uso único transferem o principal');
  const recoveryReplay = await fetch(`${BASE}/api/devices/recovery/claim`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'fs_device=' + (recoveryDeviceCookies.match(/fs_device=([^;]+)/) || [])[1], ...ORIGIN }, body: JSON.stringify({ token: recoveryToken, password: ADMIN_PASSWORD }) });
  check(recoveryReplay.status === 400, 'link de recuperação do principal só pode ser usado uma vez');
  const oldPrimaryRequest = await fetch(`${BASE}/api/devices`, { headers: { cookie: cookies, ...ORIGIN } });
  check(oldPrimaryRequest.status === 401, 'recuperação encerra imediatamente as sessões do principal anterior');
  const recoveryLogin = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN, cookie: 'fs_device=' + (recoveryDeviceCookies.match(/fs_device=([^;]+)/) || [])[1] }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }) });
  const recoveryCookies = ['fs_device=' + (recoveryDeviceCookies.match(/fs_device=([^;]+)/) || [])[1], ...(recoveryLogin.headers.getSetCookie ? recoveryLogin.headers.getSetCookie() : [recoveryLogin.headers.get('set-cookie')]).filter(Boolean).map(cookie => cookie.split(';')[0])].join('; ');
  const recoveryDevices = await fetch(`${BASE}/api/devices`, { headers: { cookie: recoveryCookies, ...ORIGIN } });
  check(recoveryLogin.ok && recoveryDevices.ok, 'o aparelho recuperado pode entrar como novo dispositivo principal');
  cookies = recoveryCookies;
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
