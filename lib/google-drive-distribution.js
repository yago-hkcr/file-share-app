'use strict';

const GOOGLE_DRIVE_DISTRIBUTION_MODES = Object.freeze(['most_free', 'round_robin', 'preferred']);

function isGoogleDriveQuotaError(error) {
  const message = String(error && error.message || '');
  return Number(error && error.status) === 507 ||
    /HTTP\s+(?:403|507)\b[^\n]*(?:storageQuotaExceeded|teamDriveStorageLimitExceeded|quotaExceeded)/i.test(message);
}

function selectGoogleDriveCandidate(accounts, {
  reservations = new Map(), mode = 'most_free', preferredAccountId = '', cursor = 0,
  sizeBytes = 0, excludeAccountIds = []
} = {}) {
  const requestedBytes = Math.max(0, Number(sizeBytes) || 0);
  const excluded = new Set(excludeAccountIds.map(String));
  const eligible = accounts.map(account => ({
    account,
    freeBytes: account.quotaLimitBytes == null || account.quotaUsedBytes == null
      ? null
      : Math.max(0, account.quotaLimitBytes - account.quotaUsedBytes - Number(reservations.get(account.id) || 0))
  })).filter(({ account, freeBytes }) =>
    !excluded.has(String(account.id)) && (freeBytes === null || freeBytes >= requestedBytes));

  if (!eligible.length) return null;
  const byFreeSpace = [...eligible].sort((a, b) => {
    if (a.freeBytes == null && b.freeBytes == null) return String(a.account.connectedAt || '').localeCompare(String(b.account.connectedAt || ''));
    if (a.freeBytes == null) return 1;
    if (b.freeBytes == null) return -1;
    return b.freeBytes - a.freeBytes;
  });
  if (mode === 'preferred') {
    const preferred = eligible.find(({ account }) => String(account.id) === String(preferredAccountId));
    if (preferred) return preferred.account;
  }
  if (mode === 'round_robin') return eligible[Math.max(0, Number(cursor) || 0) % eligible.length].account;
  return byFreeSpace[0].account;
}

module.exports = { GOOGLE_DRIVE_DISTRIBUTION_MODES, isGoogleDriveQuotaError, selectGoogleDriveCandidate };