// Regressão do medidor de uso da API do Google Drive.
// Uso: node test/regression-google-drive-meter.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGoogleDriveMeter, describeDriveRequest, loadDriveUsage } = require('../lib/google-drive-meter.js');

assert.deepEqual(describeDriveRequest('GET', 'https://www.googleapis.com/drive/v3/about?fields=x'), { kind: 'about.get', units: 1 });
assert.deepEqual(describeDriveRequest('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'), { kind: 'upload.session', units: 3 });
assert.deepEqual(describeDriveRequest('PUT', 'https://www.googleapis.com/upload/session-1'), { kind: 'upload.chunk', units: 1 });
assert.deepEqual(describeDriveRequest('GET', 'https://www.googleapis.com/drive/v3/files?q=abc'), { kind: 'files.list', units: 10 });
assert.deepEqual(describeDriveRequest('DELETE', 'https://www.googleapis.com/drive/v3/files/abc'), { kind: 'files.delete', units: 10 });
assert.deepEqual(describeDriveRequest('GET', 'https://www.googleapis.com/drive/v3/files/abc?fields=id'), { kind: 'files.get', units: 5 });
assert.equal(describeDriveRequest('POST', 'https://oauth2.googleapis.com/token'), null, 'renovar token não consome cota');

const writes = [];
let clock = Date.UTC(2026, 4, 10, 12, 0, 0);
const meter = createGoogleDriveMeter({
  now: () => clock,
  query: async (text, params) => { writes.push(params); return []; }
});

meter.record({ accountId: 'a', method: 'PUT', url: 'https://www.googleapis.com/upload/session-1', bytes: 2048 });
meter.record({ accountId: 'a', method: 'GET', url: 'https://www.googleapis.com/drive/v3/about?x=1' });
meter.addEgress('a', 1024);
meter.record({ accountId: 'b', method: 'GET', url: 'https://www.googleapis.com/drive/v3/files?q=x' });

const snapshot = meter.snapshot();
assert.equal(snapshot.day, '2026-05-10');
assert.equal(snapshot.units, 1 + 1 + 10, '1 por bloco + 1 do about + 10 da listagem');
assert.equal(snapshot.bytes, 3072, 'bytes enviados/recebidos entram como egress');
assert.equal(snapshot.accounts.length, 2);

const flushed = await meter.flush(true);
assert.equal(flushed.flushed, 4, 'bloco, about, egress (soma do bloco + download) e listagem');
const kinds = writes.map(params => params[2]).sort();
assert.deepEqual(kinds, ['about.get', 'egress', 'files.list', 'upload.chunk']);

// Sem novas chamadas não há escrita repetida.
const again = await meter.flush(true);
assert.equal(again.flushed, 0);

// Falha de banco não perde a medição.
let failures = 1;
const failing = createGoogleDriveMeter({ now: () => clock, query: async () => { if (failures-- > 0) throw new Error('offline'); return []; } });
failing.add('a', 'files.get', { units: 5 });
assert.equal((await failing.flush(true)).flushed, 0, 'falha do banco não conta como gravado');
assert.equal((await failing.flush(true)).flushed, 1, 'o bucket volta para a fila e é gravado depois');

// Leitura do histórico.
const rows = await loadDriveUsage(async () => [
  { day: '2026-05-10', account_id: 'a', kind: 'files.list', units: '20', bytes: '0', requests: '2' }
], { day: '2026-05-12', days: 3 });
assert.deepEqual(rows, [{ day: '2026-05-10', accountId: 'a', kind: 'files.list', units: 20, bytes: 0, requests: 2 }]);

console.log('Medidor de API/egress do Google Drive passou.');
