// Regressão da classificação de erros do Google Drive.
// Uso: node test/regression-google-drive-errors.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyGoogleDriveError,
  errorReason,
  errorStatus,
  isGoogleDriveAuthError,
  isGoogleDriveRateLimitError,
  isGoogleDriveSessionError
} = require('../lib/google-drive-errors.js');

const http = (status, reason) => new Error(`Google Drive API falhou (HTTP ${status}${reason ? '; ' + reason : ''}).`);

assert.equal(classifyGoogleDriveError(http(403, 'storageQuotaExceeded')).kind, 'quota');
assert.equal(classifyGoogleDriveError(http(403, 'teamDriveStorageLimitExceeded')).kind, 'quota');
assert.equal(classifyGoogleDriveError(http(507)).kind, 'quota');
assert.equal(classifyGoogleDriveError(http(403, 'rateLimitExceeded')).kind, 'rate_limit');
assert.equal(classifyGoogleDriveError(http(403, 'userRateLimitExceeded')).kind, 'rate_limit');
assert.equal(classifyGoogleDriveError(http(429)).kind, 'rate_limit');
assert.equal(classifyGoogleDriveError(http(403, 'dailyLimitExceeded')).kind, 'rate_limit', 'limite diário de pedidos não é falta de espaço');
assert.equal(classifyGoogleDriveError(http(403, 'sharingRateLimitExceeded')).kind, 'rate_limit');
assert.equal(classifyGoogleDriveError(http(401)).kind, 'auth');
assert.equal(classifyGoogleDriveError(http(400, 'invalid_grant')).kind, 'auth');
assert.equal(classifyGoogleDriveError(new Error('Google Drive API falhou (HTTP 400; invalid_grant).')).kind, 'auth');
assert.equal(classifyGoogleDriveError(http(403, 'insufficientPermissions')).kind, 'permission');
assert.equal(classifyGoogleDriveError(http(404)).kind, 'not_found');
assert.equal(classifyGoogleDriveError(http(410)).kind, 'session');
assert.equal(classifyGoogleDriveError(http(400)).kind, 'session', '4xx no envio de bloco exige outra sessão');
assert.equal(classifyGoogleDriveError(http(503)).kind, 'transient');
assert.equal(classifyGoogleDriveError(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })).kind, 'transient');

const quota = classifyGoogleDriveError(http(403, 'storageQuotaExceeded'));
assert.equal(quota.quota, true);
assert.equal(quota.needsReauth, false);
assert.equal(quota.sessionInvalid, false);

const rate = classifyGoogleDriveError(Object.assign(http(429), { retryAfterMs: 1500 }));
assert.equal(rate.retryable, true);
assert.equal(rate.retryAfterMs, 1500);

const auth = classifyGoogleDriveError(http(401));
assert.equal(auth.needsReauth, true);
assert.equal(auth.sessionInvalid, false);

assert.equal(isGoogleDriveSessionError(http(404)), true);
assert.equal(isGoogleDriveSessionError(http(410)), true);
assert.equal(isGoogleDriveSessionError(http(400)), true);
assert.equal(isGoogleDriveSessionError(http(403, 'storageQuotaExceeded')), false);
assert.equal(isGoogleDriveAuthError(http(401)), true);
assert.equal(isGoogleDriveRateLimitError(http(429)), true);
assert.equal(errorStatus({ response: { status: 503 } }), 503);
assert.equal(errorReason({ body: { error: { errors: [{ reason: 'quotaExceeded' }] } } }), 'quotaExceeded');
assert.equal(classifyGoogleDriveError(new Error('qualquer coisa')).kind, 'unknown');

console.log('Classificação de erros do Google Drive passou.');
