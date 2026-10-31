// Regressão da renderização da aba administrativa de armazenamento sem browser externo.
// Uso: node test/regression-google-drive-admin-ui.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const start = html.indexOf('    // Tabs');
const end = html.indexOf('    // Stats', start);
assert.ok(start >= 0 && end > start, 'handlers do painel de armazenamento devem existir');
const statusStart = html.indexOf('    function formatDriveBytes(');
const statusSource = html.slice(statusStart, end);
const source = html.slice(start, end);

function createElement() {
  return {
    hidden: false, disabled: false, textContent: '', innerHTML: '', className: '',
    href: '', src: '', attributes: {}, children: [], style: {},
    classList: { active: false, contains(name) { return name === 'active' && this.active; }, toggle(name, enabled) { this[name] = enabled; } },
    replaceChildren(...children) { this.children = children; },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { return selector === 'button' ? this.children.find(child => child.tagName === 'BUTTON') || null : null; },
    focus() { this.focused = true; },
    append(...children) { this.children.push(...children); }
  };
}

async function createHarness(payload, fetchError = null) {
  const ids = [
    'googleDriveStatus', 'googleDriveConnect', 'googleDriveDisconnect', 'googleDriveNotConfigured', 'googleDriveBadge',
    'googleDriveRefresh', 'googleDriveAccount', 'googleDriveQuota', 'googleDriveVerificationError',
    'googleDriveMessage', 'googleDriveAccountName', 'googleDriveAccountEmail', 'googleDriveAvatar',
    'googleDriveQuotaUsed', 'googleDriveQuotaFree', 'googleDriveQuotaLimit', 'googleDriveDriveUsed',
    'googleDriveTrashUsed', 'googleDriveQuotaPercent', 'googleDriveQuotaBar', 'googleDriveCheckedAt',
    'googleDriveVerificationMessage', 'googleDriveAccountCheck', 'googleDriveAutoUpdate', 'tab-storage', 'notifPanel', 'notifBtn', 'notifBadge', 'notifList',
    'tab-users', 'tab-rooms', 'markNotifsRead'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, createElement()]));
  const progressTrack = createElement();
  const panelCloseButton = createElement();
  const document = {
    hidden: false,
    getElementById: id => elements[id],
    querySelector: selector => selector === '.storage-progress-track' ? progressTrack : null,
    createElement: tagName => ({ ...createElement(), tagName }),
    addEventListener() {}
  };
  const requests = [];
  const context = {
    document,
    location: { origin: 'https://arquive.online' },
    window: { location: { href: '' }, confirm: () => true },
    URL,
    setInterval: () => 1,
    setTimeout: () => 1,
    showToast: () => {},
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (fetchError) throw fetchError;
      return { status: 200, ok: true, json: async () => payload };
    }
  };
  vm.runInNewContext(`let driveStatusRequest = null, driveStatusSequence = 0, lastDriveStatus = null;\n${statusSource}\n${source}\nloadGoogleDriveStatus();`, context);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, progressTrack, context, requests, document, panelCloseButton };
}

const connected = await createHarness({
  configured: true, connected: true, verified: true,
  account: { name: '<Conta>', email: 'drive@example.com', photo_url: 'https://example.com/avatar.png' },
  storage_quota: { used_bytes: '300', limit_bytes: '1000', drive_used_bytes: '250', trash_used_bytes: '50' },
  checked_at: '2026-10-31T12:00:00.000Z'
});
assert.equal(connected.elements.googleDriveStatus.textContent, 'Conectado');
assert.equal(connected.elements.googleDriveBadge.className, 'storage-status-badge is-connected');
assert.equal(connected.elements.googleDriveAccountName.textContent, '<Conta>', 'nome é texto, não HTML');
assert.equal(connected.elements.googleDriveAccount.hidden, false);
assert.equal(connected.elements.googleDriveQuota.hidden, false);
assert.equal(connected.elements.googleDriveQuotaFree.textContent, '700 B');
assert.equal(connected.elements.googleDriveQuotaPercent.textContent, '30% usado');
assert.equal(connected.progressTrack.attributes['aria-valuenow'], '30');
assert.equal(connected.elements.googleDriveConnect.hidden, true, 'conectado não oferece autorização duplicada');
assert.equal(connected.elements.googleDriveDisconnect.hidden, false);

const noQuota = await createHarness({
  configured: true, connected: true, verified: true,
  account: { name: 'Conta sem cota informada', photo_url: 'http://inseguro.example/avatar.png' },
  storage_quota: { used_bytes: '10', limit_bytes: null, drive_used_bytes: null, trash_used_bytes: null }
});
assert.equal(noQuota.elements.googleDriveQuotaFree.textContent, 'Sem limite informado');
assert.equal(noQuota.elements.googleDriveQuotaLimit.textContent, 'Sem limite informado');
assert.equal(noQuota.elements.googleDriveQuotaPercent.textContent, '—');
assert.equal(noQuota.elements.googleDriveAvatar.children[0].className, 'fas fa-user');

const unconfigured = await createHarness({ configured: false, connected: false, verified: false, storage_quota: null });
assert.equal(unconfigured.elements.googleDriveStatus.textContent, 'Integração indisponível');
assert.equal(unconfigured.elements.googleDriveNotConfigured.hidden, false);
assert.equal(unconfigured.elements.googleDriveConnect.hidden, true);
assert.equal(unconfigured.elements.googleDriveQuota.hidden, true);
assert.equal(unconfigured.elements.googleDriveAccount.hidden, true);
assert.equal(unconfigured.elements.googleDriveVerificationError.hidden, true);
assert.equal(unconfigured.elements.googleDriveDisconnect.hidden, true);

const unverified = await createHarness({ configured: true, connected: true, verified: false, verification_failed: true });
assert.equal(unverified.elements.googleDriveStatus.textContent, 'Conexão salva');
assert.equal(unverified.elements.googleDriveVerificationError.hidden, false, 'falha de cota pode ser mostrada sem apagar a conexão');
assert.equal(unverified.elements.googleDriveNotConfigured.hidden, true);
assert.equal(unverified.elements.googleDriveConnect.hidden, true);
assert.equal(unverified.elements.googleDriveDisconnect.hidden, false, 'falha de verificação não esquece a autorização');

const unavailable = await createHarness({}, new Error('falha interna simulada'));
assert.equal(unavailable.elements.googleDriveBadge.className, 'storage-status-badge is-error');
assert.equal(unavailable.elements.googleDriveStatus.textContent, 'Não foi possível confirmar a conexão');
assert.equal(unavailable.elements.googleDriveMessage.textContent, 'O painel tentará verificar novamente automaticamente.');
assert.equal(unavailable.elements.googleDriveNotConfigured.hidden, true);
assert.equal(unavailable.elements.googleDriveConnect.hidden, false, 'conta sem status salvo permite a conexão inicial');
assert.equal(unavailable.elements.googleDriveRefresh.disabled, false);

const tokenUrl = new URL('https://www.googleapis.com/drive/v3/about?fields=user(displayName%2CemailAddress)');
assert.equal(tokenUrl.hostname, 'www.googleapis.com');

console.log('Estados conectado, cota desconhecida, não configurado, verificação pendente e erro transitório passaram.');