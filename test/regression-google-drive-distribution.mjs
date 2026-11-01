// Regressão das políticas de distribuição e fallback por cota do Google Drive.
// Uso: node test/regression-google-drive-distribution.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  GOOGLE_DRIVE_DISTRIBUTION_MODES,
  isGoogleDriveQuotaError,
  selectGoogleDriveCandidate
} = require('../lib/google-drive-distribution.js');

const accounts = [
  { id: 'primary', connectedAt: '2026-01-01', quotaLimitBytes: 1000, quotaUsedBytes: 100 },
  { id: 'backup', connectedAt: '2026-01-02', quotaLimitBytes: 1000, quotaUsedBytes: 400 },
  { id: 'last', connectedAt: '2026-01-03', quotaLimitBytes: 1000, quotaUsedBytes: 800 }
];

assert.deepEqual(GOOGLE_DRIVE_DISTRIBUTION_MODES, ['most_free', 'round_robin', 'preferred']);
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100 }).id, 'primary', 'padrão escolhe maior espaço livre');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100, mode: 'round_robin', cursor: 0 }).id, 'primary');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100, mode: 'round_robin', cursor: 1 }).id, 'backup');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100, mode: 'round_robin', cursor: 2 }).id, 'last');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100, mode: 'preferred', preferredAccountId: 'backup' }).id, 'backup');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 700, mode: 'preferred', preferredAccountId: 'last' }).id, 'primary', 'prioridade usa uma reserva com espaço quando a principal está cheia');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100, reservations: new Map([['primary', 850]]) }).id, 'backup', 'reservas de sessões ativas são descontadas');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100, excludeAccountIds: ['primary'] }).id, 'backup', 'fallback exclui a conta que atingiu a cota');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 901 }), null, 'retorna vazio quando nenhuma conta tem espaço');
assert.equal(selectGoogleDriveCandidate([{ id: 'unknown', connectedAt: '2026-01-01', quotaLimitBytes: null, quotaUsedBytes: null }], { sizeBytes: 100 }).id, 'unknown', 'cota desconhecida segue utilizável');
assert.equal(isGoogleDriveQuotaError(new Error('Google Drive API falhou (HTTP 403; storageQuotaExceeded).')), true);
assert.equal(isGoogleDriveQuotaError(new Error('Google Drive API falhou (HTTP 403; insufficientPermissions).')), false);

console.log('Modos, reservas, fallback por cota e cotas desconhecidas passaram.');