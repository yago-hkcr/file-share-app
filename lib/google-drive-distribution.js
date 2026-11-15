'use strict';

const { classifyGoogleDriveError } = require('./google-drive-errors.js');

const GOOGLE_DRIVE_DISTRIBUTION_MODES = Object.freeze(['most_free', 'best_fit', 'round_robin', 'preferred']);

function isGoogleDriveQuotaError(error) {
  if (Number(error && error.status) === 507) return true;
  return classifyGoogleDriveError(error).kind === 'quota';
}

// Conta sem "limit" no about.get: Workspace/ilimitada (o Google não informa
// cota). Só vale como ilimitada depois de verificada; antes disso a cota é
// apenas desconhecida.
function isUnlimitedDriveAccount(account) {
  if (!account || !account.lastVerifiedAt) return false;
  if (account.quotaLimitBytes == null) return true;
  // Algumas contas Workspace informam limit "0" (pool sem teto por usuário).
  return Number(account.quotaLimitBytes) <= 0;
}

function distinctValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function driveAccountReservedBytes(account, reservations) {
  if (!account) return 0;
  const column = distinctValue(account.reservedBytes);
  if (column != null && column > 0) return column;
  if (!reservations || typeof reservations.get !== 'function') return 0;
  return Math.max(0, Number(reservations.get(account.id) || 0) || 0);
}

// Infinity = ilimitada; null = desconhecida (pode aceitar, o Drive decide).
function driveAccountFreeBytes(account, reservedBytes = 0) {
  if (isUnlimitedDriveAccount(account)) return Infinity;
  if (!account || account.quotaLimitBytes == null || account.quotaUsedBytes == null) return null;
  return Math.max(0, Number(account.quotaLimitBytes) - Number(account.quotaUsedBytes) - Number(reservedBytes || 0));
}

function compareConnectedAt(a, b) {
  return String(a.connectedAt || '').localeCompare(String(b.connectedAt || ''));
}

function mostFreeOrder(entries) {
  return [...entries].sort((a, b) => {
    if (a.freeBytes === Infinity && b.freeBytes !== Infinity) return -1;
    if (b.freeBytes === Infinity && a.freeBytes !== Infinity) return 1;
    if (a.freeBytes == null && b.freeBytes == null) return compareConnectedAt(a.account, b.account);
    if (a.freeBytes == null) return 1;
    if (b.freeBytes == null) return -1;
    return b.freeBytes - a.freeBytes;
  });
}

// O menor espaço que ainda cabe: preserva as contas grandes para os arquivos
// grandes e evita "queimar" a conta ilimitada com arquivos pequenos.
function bestFitOrder(entries) {
  return [...entries].sort((a, b) => {
    if (a.freeBytes === Infinity && b.freeBytes === Infinity) return compareConnectedAt(a.account, b.account);
    if (a.freeBytes === Infinity) return 1;
    if (b.freeBytes === Infinity) return -1;
    if (a.freeBytes == null && b.freeBytes == null) return compareConnectedAt(a.account, b.account);
    if (a.freeBytes == null) return 1;
    if (b.freeBytes == null) return -1;
    return a.freeBytes - b.freeBytes;
  });
}

// Lista ordenada de contas que podem receber o arquivo. O servidor percorre a
// lista reservando espaço de forma atômica até uma aceitar.
function selectGoogleDriveCandidates(accounts, {
  reservations = new Map(), mode = 'most_free', preferredAccountId = '', cursor = 0,
  sizeBytes = 0, excludeAccountIds = []
} = {}) {
  const requestedBytes = Math.max(0, Number(sizeBytes) || 0);
  const excluded = new Set(excludeAccountIds.map(String));
  const eligible = (accounts || []).map(account => ({
    account,
    freeBytes: driveAccountFreeBytes(account, driveAccountReservedBytes(account, reservations))
  })).filter(({ account, freeBytes }) =>
    !excluded.has(String(account.id)) &&
    (account.needsReauth ? false : true) &&
    (freeBytes === null || freeBytes === Infinity || freeBytes >= requestedBytes));

  if (!eligible.length) return [];
  let ordered;
  if (mode === 'round_robin') {
    const start = Math.max(0, Number(cursor) || 0) % eligible.length;
    ordered = [...eligible.slice(start), ...eligible.slice(0, start)];
  } else if (mode === 'best_fit') {
    ordered = bestFitOrder(eligible);
  } else {
    ordered = mostFreeOrder(eligible);
  }
  if (mode === 'preferred') {
    const index = ordered.findIndex(({ account }) => String(account.id) === String(preferredAccountId));
    if (index > 0) ordered = [ordered[index], ...ordered.slice(0, index), ...ordered.slice(index + 1)];
  }
  return ordered.map(entry => entry.account);
}

function selectGoogleDriveCandidate(accounts, options = {}) {
  const candidates = selectGoogleDriveCandidates(accounts, options);
  return candidates[0] || null;
}

// Capacidade real do pool: quanto ainda cabe, qual o maior arquivo possível e
// se as contas parecem compartilhar a mesma cota (Workspace com pool único).
function poolCapacity(accounts = [], { reservations = new Map() } = {}) {
  let unlimitedCount = 0;
  let totalKnownFreeBytes = 0;
  let maxFileBytes = null;
  const groups = new Map();
  for (const account of accounts) {
    if (account && account.needsReauth) continue;
    const freeBytes = driveAccountFreeBytes(account, driveAccountReservedBytes(account, reservations));
    if (freeBytes === Infinity) {
      unlimitedCount++;
      maxFileBytes = null;
      continue;
    }
    if (freeBytes == null) continue;
    totalKnownFreeBytes += freeBytes;
    if (maxFileBytes == null || freeBytes > maxFileBytes) maxFileBytes = freeBytes;
    const limit = distinctValue(account.quotaLimitBytes);
    const used = distinctValue(account.quotaUsedBytes);
    if (limit != null && used != null && limit > 0) {
      const key = `${limit}:${used}`;
      if (!groups.has(key)) groups.set(key, { limitBytes: limit, usedBytes: used, accountIds: [] });
      groups.get(key).accountIds.push(account.id);
    }
  }
  const pooledQuotaGroups = [...groups.values()].filter(group => group.accountIds.length > 1);
  return {
    accountCount: accounts.filter(account => account && !account.needsReauth).length,
    unlimitedCount,
    totalKnownFreeBytes: unlimitedCount ? null : totalKnownFreeBytes,
    // null com unlimitedCount > 0 = sem teto de tamanho.
    maxFileBytes,
    pooledQuotaGroups,
    pooledQuotaWarning: pooledQuotaGroups.length > 0
  };
}

module.exports = {
  GOOGLE_DRIVE_DISTRIBUTION_MODES,
  driveAccountFreeBytes,
  driveAccountReservedBytes,
  isGoogleDriveQuotaError,
  isUnlimitedDriveAccount,
  poolCapacity,
  selectGoogleDriveCandidate,
  selectGoogleDriveCandidates
};
