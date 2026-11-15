// Regressão das políticas de distribuição e fallback por cota do Google Drive.
// Uso: node test/regression-google-drive-distribution.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  GOOGLE_DRIVE_DISTRIBUTION_MODES,
  driveAccountFreeBytes,
  isGoogleDriveQuotaError,
  isUnlimitedDriveAccount,
  poolCapacity,
  selectGoogleDriveCandidate,
  selectGoogleDriveCandidates
} = require('../lib/google-drive-distribution.js');

const accounts = [
  { id: 'primary', connectedAt: '2026-01-01', quotaLimitBytes: 1000, quotaUsedBytes: 100 },
  { id: 'backup', connectedAt: '2026-01-02', quotaLimitBytes: 1000, quotaUsedBytes: 400 },
  { id: 'last', connectedAt: '2026-01-03', quotaLimitBytes: 1000, quotaUsedBytes: 800 }
];

assert.deepEqual(GOOGLE_DRIVE_DISTRIBUTION_MODES, ['most_free', 'best_fit', 'round_robin', 'preferred']);
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100 }).id, 'primary', 'padrão escolhe maior espaço livre');
assert.equal(selectGoogleDriveCandidate(accounts, { sizeBytes: 100, mode: 'best_fit' }).id, 'last', 'melhor encaixe usa a menor conta que ainda cabe');
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
assert.equal(isGoogleDriveQuotaError(new Error('Google Drive API falhou (HTTP 403; rateLimitExceeded).')), false, 'limite de requisições não é cota de espaço');

// Conta sem limite depois de verificada = ilimitada; prioridade máxima.
const unlimited = { id: 'workspace', connectedAt: '2026-01-04', quotaLimitBytes: null, quotaUsedBytes: null, lastVerifiedAt: '2026-02-01 10:00:00' };
assert.equal(isUnlimitedDriveAccount(unlimited), true);
assert.equal(isUnlimitedDriveAccount({ id: 'never', quotaLimitBytes: null, quotaUsedBytes: null }), false);
assert.equal(isUnlimitedDriveAccount({ id: 'zero', quotaLimitBytes: 0, lastVerifiedAt: '2026-02-01 10:00:00' }), true, 'limit 0 informado pelo Workspace equivale a sem limite');
assert.equal(driveAccountFreeBytes({ id: 'zero', quotaLimitBytes: 0, quotaUsedBytes: 123, lastVerifiedAt: '2026-02-01 10:00:00' }), Infinity);
assert.equal(driveAccountFreeBytes(unlimited), Infinity);
assert.equal(selectGoogleDriveCandidate([...accounts, unlimited], { sizeBytes: 100 }).id, 'workspace', 'ilimitada recebe prioridade na distribuição automática');
assert.equal(selectGoogleDriveCandidate([...accounts, unlimited], { sizeBytes: 100, mode: 'best_fit' }).id, 'last', 'melhor encaixe preserva a conta ilimitada');

// Conta marcada para reconectar sai da rotação.
assert.equal(selectGoogleDriveCandidate([{ ...accounts[0], needsReauth: true }, accounts[1]], { sizeBytes: 100 }).id, 'backup');

// Reserva gravada na conta (coluna) vale mais que o mapa legado.
assert.equal(selectGoogleDriveCandidate([{ ...accounts[0], reservedBytes: 850 }, accounts[1]], { sizeBytes: 100 }).id, 'backup');

const candidates = selectGoogleDriveCandidates(accounts, { sizeBytes: 300 });
assert.deepEqual(candidates.map(a => a.id), ['primary', 'backup'], 'lista ordenada respeita o espaço livre');

const capacity = poolCapacity([...accounts, unlimited]);
assert.equal(capacity.unlimitedCount, 1);
assert.equal(capacity.totalKnownFreeBytes, null, 'pool com conta ilimitada não tem teto somado');
assert.equal(capacity.maxFileBytes, null, 'arquivo máximo é ilimitado quando há conta ilimitada');
assert.equal(capacity.pooledQuotaWarning, false);

const pooled = poolCapacity([
  { id: 'a', quotaLimitBytes: 2000, quotaUsedBytes: 1500 },
  { id: 'b', quotaLimitBytes: 2000, quotaUsedBytes: 1500 }
]);
assert.equal(pooled.pooledQuotaWarning, true, 'duas contas com a mesma cota/uso parecem dividir o mesmo pool');
assert.equal(pooled.pooledQuotaGroups[0].accountIds.length, 2);

const known = poolCapacity(accounts);
assert.equal(known.maxFileBytes, 900);
assert.equal(known.totalKnownFreeBytes, 900 + 600 + 200);

console.log('Modos, reservas, fallback por cota, ilimitadas e capacidade do pool passaram.');
