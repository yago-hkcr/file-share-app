// Regressão da renderização da aba administrativa de armazenamento sem browser externo.
// Uso: node test/regression-google-drive-admin-ui.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const start = html.indexOf('    async function loadGoogleDriveStatus()');
const end = html.indexOf('    // Stats', start);
assert.ok(start >= 0 && end > start, 'função de status do Drive deve estar no painel admin');
const source = html.slice(start, end);

function createElement() {
  return {
    hidden: false, disabled: false, textContent: '', innerHTML: '', className: '',
    href: '', src: '', attributes: {}, children: [], style: {},
    classList: { toggle(name, enabled) { this[name] = enabled; } },
    replaceChildren(...children) { this.children = children; },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

async function render(payload, fetchError = null) {
  const ids = [
    'googleDriveStatus', 'googleDriveConnect', 'googleDriveNotConfigured', 'googleDriveBadge',
    'googleDriveRefresh', 'googleDriveAccount', 'googleDriveQuota', 'googleDriveVerificationError',
    'googleDriveMessage', 'googleDriveAccountName', 'googleDriveAccountEmail', 'googleDriveAvatar',
    'googleDriveQuotaUsed', 'googleDriveQuotaFree', 'googleDriveQuotaLimit', 'googleDriveDriveUsed',
    'googleDriveTrashUsed', 'googleDriveQuotaPercent', 'googleDriveQuotaBar', 'googleDriveCheckedAt',
    'googleDriveVerificationMessage'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, createElement()]));
  const progressTrack = createElement();
  const document = {
    getElementById: id => elements[id],
    querySelector: selector => selector === '.storage-progress-track' ? progressTrack : null,
    createElement: () => createElement()
  };
  const context = {
    document,
    location: { origin: 'https://arquive.online' },
    URL,
    window: { location: { href: '' } },
    fetch: async () => {
      if (fetchError) throw fetchError;
      return { status: 200, ok: true, json: async () => payload };
    }
  };
  vm.runInNewContext(`${source}\nloadGoogleDriveStatus();`, context);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, progressTrack, context };
}

const connected = await render({
  configured: true, connected: true, verified: true,
  account: { name: '<Conta>', email: 'drive@example.com', photo_url: 'https://example.com/avatar.png' },
  storage_quota: { used_bytes: '300', limit_bytes: '1000', drive_used_bytes: '250', trash_used_bytes: '50' },
  checked_at: '2026-10-31T12:00:00.000Z'
});
assert.equal(connected.elements.googleDriveStatus.textContent, 'Conexão ativa');
assert.equal(connected.elements.googleDriveBadge.className, 'storage-status-badge is-connected');
assert.equal(connected.elements.googleDriveAccountName.textContent, '<Conta>', 'nome da conta é inserido como texto, não HTML');
assert.equal(connected.elements.googleDriveAccount.hidden, false);
assert.equal(connected.elements.googleDriveQuota.hidden, false);
assert.equal(connected.elements.googleDriveQuotaUsed.textContent, '300 B');
assert.equal(connected.elements.googleDriveQuotaFree.textContent, '700 B');
assert.equal(connected.elements.googleDriveQuotaPercent.textContent, '30% usado');
assert.equal(connected.progressTrack.attributes['aria-valuenow'], '30');
assert.equal(connected.elements.googleDriveAvatar.children[0].src, 'https://example.com/avatar.png');
assert.equal(connected.elements.googleDriveRefresh.disabled, false);

const noQuota = await render({
  configured: true, connected: true, verified: true,
  account: { name: 'Conta sem cota informada', photo_url: 'http://inseguro.example/avatar.png' },
  storage_quota: { used_bytes: '10', limit_bytes: null, drive_used_bytes: null, trash_used_bytes: null }
});
assert.equal(noQuota.elements.googleDriveQuotaFree.textContent, 'Sem limite informado');
assert.equal(noQuota.elements.googleDriveQuotaLimit.textContent, 'Sem limite informado');
assert.equal(noQuota.elements.googleDriveQuotaPercent.textContent, '—');
assert.equal(noQuota.elements.googleDriveAvatar.children.length, 1);
assert.equal(noQuota.elements.googleDriveAvatar.children[0].className, 'fas fa-user', 'foto fora de HTTPS não é carregada');

const unconfigured = await render({ configured: false, connected: false, verified: false, storage_quota: null });
assert.equal(unconfigured.elements.googleDriveStatus.textContent, 'Não configurado');
assert.equal(unconfigured.elements.googleDriveNotConfigured.hidden, false);
assert.equal(unconfigured.elements.googleDriveConnect.hidden, true);
assert.equal(unconfigured.elements.googleDriveQuota.hidden, true);

const unverified = await render({ configured: true, connected: true, verified: false, verification_failed: true });
assert.equal(unverified.elements.googleDriveStatus.textContent, 'Verificação necessária');
assert.equal(unverified.elements.googleDriveConnect.hidden, false);
assert.equal(unverified.elements.googleDriveVerificationError.hidden, false);
assert.doesNotMatch(unverified.elements.googleDriveVerificationMessage.textContent, /OAuth|token|secret|Google API/i);

const unavailable = await render({}, new Error('falha interna simulada'));
assert.equal(unavailable.elements.googleDriveBadge.className, 'storage-status-badge is-error');
assert.equal(unavailable.elements.googleDriveStatus.textContent, 'falha interna simulada');
assert.equal(unavailable.elements.googleDriveMessage.textContent, 'Não foi possível consultar o estado do armazenamento. Tente novamente.');
assert.equal(unavailable.elements.googleDriveRefresh.disabled, false);

console.log('Estados conectado, cota desconhecida, não configurado, não verificado e erro do painel passaram.');