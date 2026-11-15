'use strict';

// Medidor aproximado de uso da API do Google Drive.
//
// A cota do Drive é por projeto (1.000.000 de unidades/minuto) e não cresce ao
// conectar mais contas. Contar as chamadas por conta/hora é o que permite ver
// qual conta está consumindo a cota e comparar o egress com o teto de 1 TB/dia.
// A contagem é em memória (uma instância serverless não vê a outra) e é
// consolidada no banco por flush() — suficiente para diagnóstico e alerta.
const UNIT_COSTS = Object.freeze({
  'about.get': 1,
  'files.generateIds': 1,
  'files.create': 5,
  'files.list': 10,
  'files.get': 5,
  'files.delete': 10,
  'files.copy': 10,
  'upload.session': 3,
  'upload.chunk': 1,
  'upload.query': 1,
  'egress': 0
});

function describeDriveRequest(method, url) {
  const target = String(url || '');
  const verb = String(method || 'GET').toUpperCase();
  if (!target) return null;
  if (target.includes('oauth2.googleapis.com/token')) return null;
  if (target.includes('/drive/v3/about')) return { kind: 'about.get', units: UNIT_COSTS['about.get'] };
  if (target.includes('/drive/v3/files/generateIds')) return { kind: 'files.generateIds', units: UNIT_COSTS['files.generateIds'] };
  if (target.includes('/upload/drive/v3/files')) return { kind: 'upload.session', units: UNIT_COSTS['upload.session'] };
  if (target.includes('/upload/')) return { kind: 'upload.chunk', units: UNIT_COSTS['upload.chunk'] };
  if (target.includes('/copy')) return { kind: 'files.copy', units: UNIT_COSTS['files.copy'] };
  if (verb === 'DELETE') return { kind: 'files.delete', units: UNIT_COSTS['files.delete'] };
  if (target.includes('/drive/v3/files?') || target.endsWith('/drive/v3/files')) {
    return { kind: verb === 'POST' ? 'files.create' : 'files.list', units: verb === 'POST' ? UNIT_COSTS['files.create'] : UNIT_COSTS['files.list'] };
  }
  if (/\/drive\/v3\/files\/[^/]+/.test(target)) return { kind: 'files.get', units: UNIT_COSTS['files.get'] };
  return null;
}

function dayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createGoogleDriveMeter({ query = null, now = Date.now, flushIntervalMs = 60000 } = {}) {
  const buckets = new Map();
  let dirty = new Set();
  let lastFlush = 0;

  const keyOf = (day, accountId, kind) => `${day}|${accountId || ''}|${kind}`;

  function bucket(day, accountId, kind) {
    const key = keyOf(day, accountId, kind);
    let entry = buckets.get(key);
    if (!entry) {
      entry = { day, accountId: String(accountId || ''), kind, units: 0, bytes: 0, requests: 0 };
      buckets.set(key, entry);
    }
    return entry;
  }

  function add(accountId, kind, { units = 0, bytes = 0, requests = 1 } = {}) {
    if (!kind) return;
    const entry = bucket(dayKey(now()), accountId, kind);
    entry.units += Math.max(0, Number(units) || 0);
    entry.bytes += Math.max(0, Number(bytes) || 0);
    entry.requests += Math.max(0, Number(requests) || 0);
    dirty.add(entry);
  }

  // Chamado pelo storage em cada requisição HTTP ao Google.
  function record({ accountId = '', method = 'GET', url = '', status = 0, bytes = 0 } = {}) {
    const described = describeDriveRequest(method, url);
    if (!described) return;
    add(accountId, described.kind, { units: described.units });
    if (bytes > 0) add(accountId, 'egress', { bytes, units: 0 });
  }

  function addEgress(accountId, bytes) {
    if (!(Number(bytes) > 0)) return;
    add(accountId, 'egress', { bytes: Number(bytes), units: 0 });
  }

  function snapshot() {
    const day = dayKey(now());
    const accounts = new Map();
    let units = 0;
    let bytes = 0;
    for (const entry of buckets.values()) {
      if (entry.day !== day) continue;
      units += entry.units;
      bytes += entry.bytes;
      const current = accounts.get(entry.accountId) || { accountId: entry.accountId, units: 0, bytes: 0, requests: 0 };
      current.units += entry.units;
      current.bytes += entry.bytes;
      current.requests += entry.requests;
      accounts.set(entry.accountId, current);
    }
    return { day, units, bytes, accounts: [...accounts.values()] };
  }

  async function flush(force = false) {
    if (!query) return { flushed: 0 };
    if (!force && now() - lastFlush < flushIntervalMs) return { flushed: 0 };
    const pending = [...dirty].filter(entry => entry.units > 0 || entry.bytes > 0);
    if (!pending.length) { lastFlush = now(); return { flushed: 0 }; }
    dirty = new Set();
    lastFlush = now();
    let flushed = 0;
    for (const entry of pending) {
      try {
        await query(`INSERT INTO google_drive_api_usage (day, account_id, kind, units, bytes, requests, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (day, account_id, kind) DO UPDATE SET
              units = google_drive_api_usage.units + EXCLUDED.units,
              bytes = google_drive_api_usage.bytes + EXCLUDED.bytes,
              requests = google_drive_api_usage.requests + EXCLUDED.requests,
              updated_at = EXCLUDED.updated_at`,
        [entry.day, entry.accountId, entry.kind, entry.units, entry.bytes, entry.requests,
          new Date(now()).toISOString().slice(0, 19).replace('T', ' ')]);
        flushed++;
      } catch (error) {
        // Devolve o bucket para a próxima tentativa em vez de perder a medição.
        dirty.add(entry);
      }
    }
    return { flushed };
  }

  return { add, addEgress, flush, record, reset: () => { buckets.clear(); dirty = new Set(); }, snapshot };
}

async function loadDriveUsage(query, { day = dayKey(), days = 1 } = {}) {
  const start = new Date(`${day}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
  const rows = await query(`SELECT day, account_id, kind, units, bytes, requests
    FROM google_drive_api_usage WHERE day >= $1 ORDER BY day DESC`, [dayKey(start.getTime())]);
  return rows.map(row => ({
    day: row.day,
    accountId: row.account_id,
    kind: row.kind,
    units: Number(row.units) || 0,
    bytes: Number(row.bytes) || 0,
    requests: Number(row.requests) || 0
  }));
}

module.exports = { UNIT_COSTS, createGoogleDriveMeter, dayKey, describeDriveRequest, loadDriveUsage };
