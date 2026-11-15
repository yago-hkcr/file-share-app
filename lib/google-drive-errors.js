'use strict';

// Classificação central dos erros do Google Drive.
//
// Cada operação reage de um jeito diferente ao mesmo status HTTP, então o resto
// do código pergunta "que tipo de erro é este?" em vez de repetir regex. A lista
// de reasons segue https://developers.google.com/drive/api/guides/handle-errors
// (docs oficiais) e o formato de erro do OAuth (invalid_grant etc.).
const QUOTA_REASONS = new Set([
  'storageQuotaExceeded',
  'teamDriveStorageLimitExceeded',
  'quotaExceeded'
]);
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'rateLimitExceededUnreg',
  'dailyLimitExceeded',
  'backendError'
]);
const AUTH_REASONS = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'invalid_token',
  'invalid_credentials',
  'access_denied',
  'unauthenticated',
  'disabled_client',
  'invalid_request'
]);
const TRANSIENT_REASONS = new Set(['backendError', 'internalError', 'serviceUnavailable', 'timeout', 'transientError']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET']);

function errorStatus(error) {
  if (!error) return 0;
  const direct = Number(error.status || error.statusCode || (error.response && error.response.status));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = String(error.message || '').match(/HTTP\s+(\d{3})\b/);
  return match ? Number(match[1]) : 0;
}

function errorReason(error) {
  if (!error) return '';
  if (typeof error.reason === 'string' && error.reason) return error.reason;
  if (error.body && error.body.error && Array.isArray(error.body.error.errors) && error.body.error.errors[0]) {
    const reason = error.body.error.errors[0].reason;
    if (typeof reason === 'string') return reason;
  }
  const match = String(error.message || '').match(/HTTP\s+\d{3}\s*;\s*([A-Za-z0-9_-]{1,64})/);
  return match ? match[1] : '';
}

function errorRetryAfterMs(error) {
  if (!error) return 0;
  const value = Number(error.retryAfterMs);
  if (Number.isFinite(value) && value > 0) return Math.min(value, 10000);
  return 0;
}

// kind:
//   quota        -> a conta está sem espaço; vale tentar outra conta
//   rate_limit   -> pedir de novo mais tarde; NÃO trocar de conta
//   auth         -> token/consentimento inválido; a conta sai da rotação
//   session      -> a sessão resumível morreu; abrir outra sessão
//   not_found    -> arquivo/sessão inexistente
//   permission   -> falta permissão (não adianta repetir)
//   transient    -> erro temporário (5xx, rede)
//   invalid      -> pedido inválido; repetir não resolve
//   unknown      -> sem classificação
function classifyGoogleDriveError(error) {
  const status = errorStatus(error);
  const reason = errorReason(error);
  const message = String(error && error.message || '');
  const retryAfterMs = errorRetryAfterMs(error);
  const result = (kind, extra = {}) => ({
    kind, status, reason, retryAfterMs,
    quota: kind === 'quota',
    needsReauth: kind === 'auth',
    sessionInvalid: kind === 'session' || kind === 'not_found',
    retryable: kind === 'transient' || kind === 'rate_limit',
    ...extra
  });

  if (!error) return result('unknown');
  if (status === 507) return result('quota');
  if (status === 401) return result('auth');
  if (status === 429) return result('rate_limit');
  if (status === 404) return result('not_found');
  if (status === 410) return result('session');
  if (status >= 500 && status <= 599) return result('transient');
  if (AUTH_REASONS.has(reason) || /invalid_grant|refresh token|token has been expired or revoked/i.test(message)) return result('auth');
  if (QUOTA_REASONS.has(reason)) return result('quota');
  if (RATE_LIMIT_REASONS.has(reason)) return result('rate_limit');
  if (TRANSIENT_REASONS.has(reason)) return result('transient');
  if (status === 403) return result('permission');
  if (status === 400) return result('session');
  if (!status && (NETWORK_CODES.has(String(error.code || '').toUpperCase()) || /fetch failed|network|socket hang up|terminated/i.test(message))) {
    return result('transient');
  }
  return result('unknown');
}

// O endpoint de upload pode devolver 400/404/410 quando a sessão resumível não
// existe mais; nesses casos a única saída é abrir outra sessão.
function isGoogleDriveSessionError(error) {
  const info = classifyGoogleDriveError(error);
  return info.sessionInvalid || info.kind === 'not_found';
}

// Erros que devem tirar a conta da rotação até uma nova autorização.
function isGoogleDriveAuthError(error) {
  return classifyGoogleDriveError(error).kind === 'auth';
}

function isGoogleDriveRateLimitError(error) {
  return classifyGoogleDriveError(error).kind === 'rate_limit';
}

module.exports = {
  AUTH_REASONS,
  QUOTA_REASONS,
  RATE_LIMIT_REASONS,
  classifyGoogleDriveError,
  errorReason,
  errorStatus,
  isGoogleDriveAuthError,
  isGoogleDriveRateLimitError,
  isGoogleDriveSessionError
};
