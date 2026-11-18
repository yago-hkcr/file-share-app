// Notificações push (PWA) e gestão de dispositivos/sessões da conta.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const api = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
    return data;
  };
  const post = (url, body, method = 'POST') => api(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const formatDate = value => {
    if (!value) return '—';
    const iso = String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z');
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  // ==================== PUSH ====================
  let pushConfig = null;
  let pushBusy = false;

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
    return output;
  }

  function pushSupported() {
    return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  }

  function setPushStatus(text, tone) {
    const status = $('pushStatus');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone || '';
  }

  async function currentSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }

  async function refreshPushState() {
    const testButton = $('testPushBtn');
    if (!pushSupported()) {
      setPushStatus('Este navegador não oferece notificações push.', 'warn');
      const button = $('enablePushBtn');
      if (button) button.disabled = true;
      if (testButton) testButton.disabled = true;
      return;
    }
    try {
      pushConfig = await api('/api/push/config');
    } catch (error) {
      pushConfig = { configured: false, public_key: null, subscriptions: 0 };
    }
    const button = $('enablePushBtn');
    if (button) button.disabled = !pushConfig.configured;
    if (!pushConfig.configured) {
      setPushStatus('O servidor ainda não tem as chaves VAPID configuradas. Peça ao administrador para definir VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY.', 'warn');
      if (testButton) testButton.disabled = true;
      return;
    }
    if (Notification.permission === 'denied') {
      setPushStatus('As notificações estão bloqueadas para este site. Libere a permissão nas configurações do navegador.', 'error');
      if (button) button.innerHTML = '<i class="fas fa-bell" aria-hidden="true"></i> Permissão bloqueada';
      if (testButton) testButton.disabled = true;
      return;
    }
    const subscription = await currentSubscription();
    if (subscription) {
      setPushStatus('Notificações push ativas neste dispositivo. Você receberá avisos mesmo com o site fechado.', 'ok');
      if (button) button.innerHTML = '<i class="fas fa-bell-slash" aria-hidden="true"></i> Desativar neste dispositivo';
      if (testButton) testButton.disabled = false;
    } else {
      if (testButton) testButton.disabled = true;
      setPushStatus(Notification.permission === 'granted'
        ? 'Permissão concedida, mas este dispositivo ainda não está inscrito. Toque em ativar.'
        : 'Ative para receber avisos de mensagens, arquivos, coletas e segurança.', '');
      if (button) button.innerHTML = '<i class="fas fa-bell" aria-hidden="true"></i> Ativar notificações push';
    }
  }

  async function enablePush() {
    if (pushBusy) return;
    pushBusy = true;
    const button = $('enablePushBtn');
    const original = button ? button.innerHTML : '';
    if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Ativando...'; }
    try {
      if (!pushSupported()) throw new Error('Este navegador não oferece notificações push.');
      if (!pushConfig || !pushConfig.configured) throw new Error('As notificações push não estão configuradas no servidor.');
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Permissão de notificações não concedida.');
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(pushConfig.public_key)
        });
      }
      const keys = subscription.toJSON().keys || {};
      await post('/api/push/subscribe', {
        endpoint: subscription.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth }
      });
      setPushStatus('Notificações push ativas neste dispositivo.', 'ok');
      if (window.toast) window.toast('Notificações push ativadas');
      await refreshPushState();
    } catch (error) {
      setPushStatus(error.message || 'Não foi possível ativar as notificações.', 'error');
      if (window.toast) window.toast(error.message || 'Não foi possível ativar as notificações.', 'error');
      if (button) button.innerHTML = original;
    } finally {
      pushBusy = false;
      if (button) button.disabled = false;
    }
  }

  async function disablePush() {
    if (pushBusy) return;
    pushBusy = true;
    const button = $('enablePushBtn');
    if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Desativando...'; }
    try {
      const subscription = await currentSubscription();
      if (subscription) {
        await post('/api/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
        await subscription.unsubscribe();
      }
      setPushStatus('Notificações push desativadas neste dispositivo.', '');
      if (window.toast) window.toast('Notificações push desativadas');
      await refreshPushState();
    } catch (error) {
      setPushStatus(error.message || 'Não foi possível desativar as notificações.', 'error');
      if (button) button.disabled = false;
    } finally {
      pushBusy = false;
    }
  }

  async function testPush() {
    if (pushBusy) return;
    pushBusy = true;
    const button = $('testPushBtn');
    const original = button ? button.innerHTML : '';
    if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Enviando...'; }
    try {
      const result = await post('/api/push/test');
      setPushStatus('Notificação de teste enviada para ' + (result.sent || 1) + ' dispositivo(s).', 'ok');
      if (window.toast) window.toast('Notificação de teste enviada');
    } catch (error) {
      setPushStatus(error.message || 'Não foi possível enviar o teste.', 'error');
    } finally {
      pushBusy = false;
      if (button) { button.disabled = false; button.innerHTML = original; }
    }
  }

  async function togglePush() {
    const subscription = await currentSubscription().catch(() => null);
    if (subscription) await disablePush();
    else await enablePush();
  }

  // ==================== DISPOSITIVOS ====================
  let devicesSheet = null;

  function deviceInfo(userAgent) {
    const ua = String(userAgent || '');
    const os = /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
      : /Windows/i.test(ua) ? 'Windows'
      : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
      : /CrOS/i.test(ua) ? 'ChromeOS'
      : /Linux/i.test(ua) ? 'Linux'
      : 'Dispositivo';
    const browser = /Edg\//i.test(ua) ? 'Edge'
      : /OPR\/|Opera/i.test(ua) ? 'Opera'
      : /SamsungBrowser/i.test(ua) ? 'Samsung Internet'
      : /Firefox\//i.test(ua) ? 'Firefox'
      : /CriOS|Chrome\//i.test(ua) ? 'Chrome'
      : /Safari\//i.test(ua) ? 'Safari'
      : 'Navegador';
    const icon = /Android|iPhone|iPad|iPod/i.test(ua) ? 'fa-mobile-screen-button'
      : /Windows/i.test(ua) ? 'fa-desktop'
      : /Macintosh|Mac OS X/i.test(ua) ? 'fa-laptop'
      : /Linux|CrOS/i.test(ua) ? 'fa-terminal'
      : 'fa-circle-question';
    return { os, browser, icon, label: browser + ' no ' + os };
  }

  function ensureDevicesSheet() {
    if (devicesSheet) return devicesSheet;
    devicesSheet = document.createElement('section');
    devicesSheet.id = 'devicesSheet';
    devicesSheet.className = 'modal devices-modal';
    devicesSheet.style.display = 'none';
    devicesSheet.setAttribute('role', 'dialog');
    devicesSheet.setAttribute('aria-modal', 'true');
    devicesSheet.setAttribute('aria-labelledby', 'devicesTitle');
    devicesSheet.innerHTML = `
      <div class="modal-overlay" data-dv-close></div>
      <div class="modal-content devices-card">
        <header class="devices-head">
          <div class="devices-head-copy">
            <span class="devices-eyebrow"><i class="fas fa-shield-halved" aria-hidden="true"></i> Segurança da conta</span>
            <h3 id="devicesTitle">Dispositivos e sessões</h3>
            <p>Estes são os aparelhos conectados à sua conta. Encerre qualquer acesso que não reconheça.</p>
          </div>
          <button class="modal-close" type="button" data-dv-close aria-label="Fechar">&times;</button>
        </header>
        <div class="devices-body">
          <div id="devicesList" class="devices-list"><p class="devices-empty"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Carregando dispositivos...</p></div>
          <div class="devices-actions">
            <button id="devicesRevokeOthers" class="btn btn-outline btn-danger" type="button"><i class="fas fa-right-from-bracket" aria-hidden="true"></i> Encerrar outras sessões</button>
            <button id="devicesRefresh" class="btn btn-outline" type="button"><i class="fas fa-rotate" aria-hidden="true"></i> Atualizar</button>
          </div>
          <p class="devices-hint"><i class="fas fa-circle-info" aria-hidden="true"></i> Ao encerrar um dispositivo, ele precisa entrar novamente com a senha.</p>
        </div>
      </div>`;
    document.body.appendChild(devicesSheet);
    devicesSheet.addEventListener('click', event => {
      if (event.target.closest('[data-dv-close]')) closeDevices();
      const revoke = event.target.closest('[data-dv-revoke]');
      if (revoke) revokeDevice(revoke.dataset.dvRevoke, revoke.dataset.dvCurrent === '1', revoke);
    });
    $('devicesRefresh').addEventListener('click', loadDevices);
    $('devicesRevokeOthers').addEventListener('click', revokeOthers);
    return devicesSheet;
  }

  function openDevices() {
    ensureDevicesSheet();
    devicesSheet.style.display = 'flex';
    document.body.classList.add('fs-modal-open');
    loadDevices();
  }

  function closeDevices() {
    if (!devicesSheet) return;
    devicesSheet.style.display = 'none';
    document.body.classList.remove('fs-modal-open');
  }

  async function loadDevices() {
    const list = $('devicesList');
    if (!list) return;
    list.innerHTML = '<p class="devices-empty"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Carregando dispositivos...</p>';
    try {
      const result = await api('/api/devices');
      const devices = Array.isArray(result.devices) ? result.devices : [];
      if (!devices.length) {
        list.innerHTML = '<p class="devices-empty"><i class="fas fa-circle-question" aria-hidden="true"></i> Nenhum dispositivo encontrado.</p>';
        return;
      }
      list.innerHTML = devices.map(device => {
        const info = deviceInfo(device.user_agent);
        return '<article class="device-row ' + (device.is_current ? 'is-current' : '') + '">' +
          '<span class="device-icon"><i class="fas ' + info.icon + '" aria-hidden="true"></i></span>' +
          '<div class="device-copy"><div class="device-title"><b>' + esc(info.label) + '</b>' +
          (device.is_current ? '<span class="device-current"><i class="fas fa-circle" aria-hidden="true"></i> Este dispositivo</span>' : '') + '</div>' +
          '<div class="device-meta"><span><i class="fas fa-clock" aria-hidden="true"></i> ' + esc(formatDate(device.last_seen_at)) + '</span>' +
          '<span><i class="fas fa-location-dot" aria-hidden="true"></i> IP ' + esc(device.last_ip || 'desconhecido') + '</span></div>' +
          '<div class="device-agent">' + esc(String(device.user_agent || 'Dispositivo sem identificação').slice(0, 110)) + '</div></div>' +
          '<button class="btn btn-sm btn-outline ' + (device.is_current ? '' : 'is-danger') + '" type="button" data-dv-revoke="' + esc(device.id) + '" data-dv-current="' + (device.is_current ? '1' : '0') + '">' +
          (device.is_current ? '<i class="fas fa-arrow-right-from-bracket" aria-hidden="true"></i> Sair' : '<i class="fas fa-ban" aria-hidden="true"></i> Encerrar') + '</button></article>';
      }).join('');
      const others = devices.filter(device => !device.is_current).length;
      $('devicesRevokeOthers').disabled = others === 0;
      $('devicesRevokeOthers').innerHTML = '<i class="fas fa-right-from-bracket" aria-hidden="true"></i> Encerrar outras sessões' + (others ? ' (' + others + ')' : '');
    } catch (error) {
      list.innerHTML = '<p class="devices-empty is-error"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> ' + esc(error.message) + '</p>';
    }
  }

  async function revokeDevice(id, isCurrent, button) {
    const question = isCurrent
      ? 'Sair deste dispositivo agora? Você precisará entrar novamente.'
      : 'Encerrar a sessão deste dispositivo? Ele precisará entrar novamente com a senha.';
    if (!window.confirm(question)) return;
    button.disabled = true;
    try {
      const result = await api('/api/devices/' + encodeURIComponent(id), { method: 'DELETE' });
      if (result.signed_out) {
        if (window.toast) window.toast('Sessão encerrada');
        window.location.assign('/');
        return;
      }
      if (window.toast) window.toast('Dispositivo encerrado');
      await loadDevices();
    } catch (error) {
      if (window.toast) window.toast(error.message, 'error');
      button.disabled = false;
    }
  }

  async function revokeOthers() {
    if (!window.confirm('Encerrar todas as outras sessões? Os outros dispositivos precisarão entrar novamente com a senha.')) return;
    const button = $('devicesRevokeOthers');
    button.disabled = true;
    try {
      const result = await post('/api/devices/revoke-others');
      if (window.toast) window.toast(result.revoked ? result.revoked + ' sessão(ões) encerrada(s)' : 'Nenhuma outra sessão ativa');
      await loadDevices();
    } catch (error) {
      if (window.toast) window.toast(error.message, 'error');
      button.disabled = false;
    }
  }

  // ==================== INTEGRAÇÃO COM AS CONFIGURAÇÕES ====================
  window.ArquivePush = {
    mount() {
      const button = $('enablePushBtn');
      if (button && button.dataset.bound !== '1') {
        button.dataset.bound = '1';
        button.addEventListener('click', togglePush);
      }
      const test = $('testPushBtn');
      if (test && test.dataset.bound !== '1') {
        test.dataset.bound = '1';
        test.addEventListener('click', testPush);
      }
      refreshPushState();
    },
    applyPreferences(prefs) {
      const values = prefs || {};
      const map = { prefPushMessages: 'push_messages', prefPushFiles: 'push_files', prefPushCollections: 'push_collections', prefPushSecurity: 'push_security' };
      Object.entries(map).forEach(([id, key]) => {
        const input = $(id);
        if (input) input.checked = values[key] !== false;
      });
    }
  };

  window.ArquiveDevices = { open: openDevices, close: closeDevices };

  const security = new URLSearchParams(window.location.search).get('security');
  if (security === '1' && window.location.pathname === '/dashboard') {
    window.setTimeout(() => {
      openDevices();
      try { history.replaceState({}, '', '/dashboard'); } catch (error) {}
    }, 900);
  }
})();
