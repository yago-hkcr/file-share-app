// Regressão da reserva atômica de espaço do pool (SQL real em Postgres local).
// Uso: node test/regression-google-drive-reservation.mjs
import assert from 'node:assert/strict';
import { PGlite } from '../local-runtime/node_modules/@electric-sql/pglite/dist/index.js';

const db = await PGlite.create();
await db.query(`CREATE TABLE google_drive_accounts (
  id TEXT PRIMARY KEY,
  quota_limit_bytes BIGINT,
  quota_used_bytes BIGINT,
  reserved_bytes BIGINT NOT NULL DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  needs_reauth INTEGER NOT NULL DEFAULT 0
)`);

// Mesma condição do servidor: a soma reservada nunca pode passar do espaço livre.
const claim = (accountId, bytes) => db.query(`UPDATE google_drive_accounts SET reserved_bytes = reserved_bytes + $1
  WHERE id = $2 AND is_active = 1 AND needs_reauth = 0
    AND (quota_limit_bytes IS NULL OR quota_limit_bytes - COALESCE(quota_used_bytes, 0) - reserved_bytes >= $1)
  RETURNING id`, [bytes, accountId]);

await db.query(`INSERT INTO google_drive_accounts (id, quota_limit_bytes, quota_used_bytes) VALUES
  ('contida', 1000, 100), ('ilimitada', NULL, NULL), ('revogada', 5000, 0)`);
await db.query("UPDATE google_drive_accounts SET needs_reauth = 1 WHERE id = 'revogada'");

const results = await Promise.all([400, 400, 400, 400, 400].map(bytes => claim('contida', bytes)));
const accepted = results.filter(result => result.rows.length > 0).length;
assert.equal(accepted, 2, 'só duas reservas de 400 B cabem em 900 B livres');
const after = (await db.query("SELECT reserved_bytes FROM google_drive_accounts WHERE id = 'contida'")).rows[0];
assert.equal(Number(after.reserved_bytes), 800, 'nada é reservado além do espaço disponível');

assert.equal((await claim('ilimitada', 10 ** 12)).rows.length, 1, 'conta sem limite aceita qualquer reserva');
assert.equal((await claim('revogada', 100)).rows.length, 0, 'conta que precisa reconectar não recebe reserva');

// Devolver a reserva libera espaço para a próxima sessão.
await db.query('UPDATE google_drive_accounts SET reserved_bytes = GREATEST(0, reserved_bytes - $1) WHERE id = $2', [400, 'contida']);
assert.equal((await claim('contida', 400)).rows.length, 1, 'reserva liberada volta a ser utilizável');
assert.equal((await claim('contida', 200)).rows.length, 0, 'não reserva além do que sobrou');

// Recalcular as reservas a partir das sessões ativas corrige instâncias mortas.
await db.query(`CREATE TABLE google_drive_uploads (upload_id TEXT PRIMARY KEY, drive_account_id TEXT, size BIGINT, status TEXT)`);
await db.query(`INSERT INTO google_drive_uploads VALUES ('u1', 'contida', 250, 'uploading'), ('u2', 'contida', 50, 'complete')`);
await db.query(`UPDATE google_drive_accounts a SET reserved_bytes = COALESCE(r.total, 0)
  FROM (SELECT drive_account_id, SUM(size) AS total FROM google_drive_uploads
    WHERE status = 'uploading' AND drive_account_id IS NOT NULL GROUP BY drive_account_id) r
  WHERE a.id = r.drive_account_id`);
await db.query(`UPDATE google_drive_accounts SET reserved_bytes = 0
  WHERE reserved_bytes <> 0 AND id NOT IN (
    SELECT drive_account_id FROM google_drive_uploads WHERE status = 'uploading' AND drive_account_id IS NOT NULL)`);
const healed = (await db.query('SELECT id, reserved_bytes FROM google_drive_accounts ORDER BY id')).rows;
assert.equal(Number(healed.find(row => row.id === 'contida').reserved_bytes), 250, 'reserva volta ao total realmente em envio');
assert.equal(Number(healed.find(row => row.id === 'ilimitada').reserved_bytes), 0, 'conta sem sessão ativa zera a reserva');

await db.close();
console.log('Reserva atômica, conta ilimitada, conta revogada e autocorreção passaram.');
