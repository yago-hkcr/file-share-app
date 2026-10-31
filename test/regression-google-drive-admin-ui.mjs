// Regressão da renderização da aba administrativa de armazenamento sem browser externo.
// Uso: node test/regression-google-drive-admin-ui.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const start = html.indexOf('    // Tabs');
const end = html.indexOf('    // Stats', start);
assert.ok(start >= 0 && end > start, 'handlers do painel de armazenamento devem existir');
const setupStart = html.indexOf('    const DRIVE_STATUS_STORAGE_KEY');
const statusStart = html.indexOf('function formatDriveBytes(');
const setupSource = html.slice(setupStart, start);
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
    'googleDriveRefresh', 'googleDriveConnectNew', 'googleDriveAccountsList', 'googleDriveTotalQuota',
    'googleDriveTotalQuotaUsed', 'googleDriveTotalQuotaFree', 'googleDriveTotalQuotaLimit', 'googleDriveTotalQuotaPercent',
    'googleDriveTotalQuotaBar', 'googleDriveAccountCount', 'googleDriveVerificationError',
    'googleDriveMessage', 'googleDriveVerificationMessage', 'googleDriveAutoUpdate', 'tab-storage', 'notifPanel', 'notifBtn', 'notifBadge', 'notifList',
    'tab-users', 'tab-rooms', 'markNotifsRead'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, createElement()]));
  for (const id of ['googleDriveConnectNew', 'googleDriveNotConfigured', 'googleDriveTotalQuota', 'googleDriveVerificationError']) {
    elements[id].hidden = true;
  }
  const progressTrack = createElement();
  const storageTrack = createElement();
  const panelCloseButton = createElement();
  const document = {
    hidden: false,
    getElementById: id => elements[id],
    querySelector: selector => selector === '.storage-progress-track' ? progressTrack
      : selector === '#googleDriveTotalQuota .storage-progress-track' ? storageTrack : null,
    querySelectorAll: selector => selector === '#googleDriveTotalQuota .storage-progress-track' ? [storageTrack] : [],
    createElement: tagName => {
      const element = { ...createElement(), tagName };
      if (tagName === 'div') Object.defineProperty(element, 'innerHTML', {
        get() {
          return this._innerHTML ?? String(this.textContent).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        },
        set(value) { this._innerHTML = String(value); }
      });
      return element;
    },
    addEventListener() {}
  };
  const requests = [];
  const context = {
    document,
    location: { origin: 'https://arquive.online' },
    window: { location: { href: '' }, confirm: () => true },
    localStorage: { getItem: () => null, setItem() {} },
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
  vm.runInNewContext(`let driveStatusRequest = null, driveStatusSequence = 0, lastDriveStatus = null;\n${setupSource}\n${statusSource}\n${source}\nloadGoogleDriveStatus();`, context);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, progressTrack: storageTrack, context, requests, document, panelCloseButton };
}

const connected = await createHarness({
  configured: true, connected: true, verified: true,
  accounts: [{ id: 'account_123', accountName: '<Conta>', accountEmail: 'drive@example.com', lastVerifiedAt: '2026-10-31 12:00:00', quotaUsedBytes: 300, quotaLimitBytes: 1000, freeBytes: 700 }],
  total: { usedBytes: 300, limitBytes: 1000, freeBytes: 700, accountCount: 1 }
});
assert.equal(connected.elements.googleDriveStatus.textContent, '1 conta(s) conectada(s)');
assert.equal(connected.elements.googleDriveBadge.className, 'storage-status-badge is-connected');
assert.equal(connected.elements.googleDriveAccountsList.children.length, 1);
assert.match(connected.elements.googleDriveAccountsList.children[0].innerHTML, /&lt;Conta&gt;/, 'nome é escapado antes de ir ao HTML');
assert.equal(connected.elements.googleDriveTotalQuotaFree.textContent, '700 B');
assert.equal(connected.elements.googleDriveTotalQuotaPercent.textContent, '30% usado');
assert.equal(connected.progressTrack.attributes['aria-valuenow'], '30');
assert.equal(connected.elements.googleDriveConnectNew.hidden, false, 'permite conectar mais contas');

const noQuota = await createHarness({
  configured: true, connected: true, verified: true,
  accounts: [{ id: 'account_no_quota', accountName: 'Conta sem cota informada', quotaUsedBytes: null, quotaLimitBytes: null, freeBytes: null }],
  total: { usedBytes: null, limitBytes: null, freeBytes: null, accountCount: 1 }
});
assert.equal(noQuota.elements.googleDriveTotalQuotaFree.textContent, '—');
assert.equal(noQuota.elements.googleDriveTotalQuotaLimit.textContent, '—');
assert.equal(noQuota.elements.googleDriveTotalQuotaPercent.textContent, '—');

const unconfigured = await createHarness({ configured: false, connected: false, verified: false, accounts: [], total: null });
assert.equal(unconfigured.elements.googleDriveStatus.textContent, 'Integração indisponível');
assert.equal(unconfigured.elements.googleDriveNotConfigured.hidden, false);
assert.equal(unconfigured.elements.googleDriveConnectNew.hidden, true);
assert.equal(unconfigured.elements.googleDriveVerificationError.hidden, true);
assert.equal(unconfigured.elements.googleDriveAccountsList.children.length, 0);

const unverified = await createHarness({ configured: true, connected: true, verified: false, verification_failed: true,
  accounts: [{ id: 'account_failed', accountName: 'Conta', quotaUsedBytes: null, quotaLimitBytes: null, verificationFailed: true }], total: null });
assert.equal(unverified.elements.googleDriveStatus.textContent, '1 conta(s) conectada(s)');
assert.equal(unverified.elements.googleDriveVerificationError.hidden, false, 'falha de cota pode ser mostrada sem apagar a conexão');
assert.equal(unverified.elements.googleDriveNotConfigured.hidden, true);
assert.equal(unverified.elements.googleDriveConnectNew.hidden, false);

const unavailable = await createHarness({}, new Error('falha interna simulada'));
assert.equal(unavailable.elements.googleDriveBadge.className, 'storage-status-badge is-error');
assert.equal(unavailable.elements.googleDriveStatus.textContent, 'Erro ao consultar contas');
assert.equal(unavailable.elements.googleDriveMessage.textContent, 'O painel tentará verificar novamente automaticamente.');
assert.equal(unavailable.elements.googleDriveNotConfigured.hidden, true);
assert.equal(unavailable.elements.googleDriveConnectNew.hidden, true);
assert.equal(unavailable.elements.googleDriveRefresh.disabled, false);

const tokenUrl = new URL('https://www.googleapis.com/drive/v3/about?fields=user(displayName%2CemailAddress)');
assert.equal(tokenUrl.hostname, 'www.googleapis.com');

console.log('Estados conectado, cota desconhecida, não configurado, verificação pendente e erro transitório passaram.');