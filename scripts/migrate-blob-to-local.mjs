#!/usr/bin/env node
'use strict';

// Migra os objetos privados do Vercel Blob para o armazenamento local.
// Uso (no host novo, antes de desligar a Vercel):
//   DATABASE_URL=... [SUPABASE_CA_CERT=...] BLOB_READ_WRITE_TOKEN=... \
//   LOCAL_STORAGE_DIR=/app/storage node scripts/migrate-blob-to-local.mjs
//
// O script é idempotente: arquivos já presentes no destino são ignorados.
// Use --dry-run para apenas listar o que seria baixado.

import { createRequire } from 'node:module';

// O restante do projeto é CommonJS; este script é ESM para usar import() dinâmico.
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Pool } = require('pg');
const { isBlobPath } = require('../lib/blob-paths');
const localStorage = require('../lib/local-storage');

const dryRun = process.argv.includes('--dry-run');
const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
if (!databaseUrl) {
  console.error('Defina DATABASE_URL (ou POSTGRES_URL).');
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('Defina BLOB_READ_WRITE_TOKEN para baixar os arquivos antigos.');
  process.exit(1);
}
const useSsl = String(process.env.DATABASE_SSL || 'true').toLowerCase() !== 'false';
const ca = process.env.SUPABASE_CA_CERT_B64
  ? Buffer.from(process.env.SUPABASE_CA_CERT_B64, 'base64').toString('utf8')
  : String(process.env.SUPABASE_CA_CERT || '').replace(/\\n/g, '\n');
// Sem CA explícito, o TLS continua verificado pela raiz pública do sistema
// (funciona no Neon); no Supabase, informe o certificado raiz.
const cleanDatabaseUrl = (() => {
  try { const url = new URL(databaseUrl); url.searchParams.delete('sslmode'); return url.toString(); }
  catch (_) { return databaseUrl; }
})();

const pool = new Pool({
  connectionString: cleanDatabaseUrl,
  max: 2,
  ssl: useSsl ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false
});

async function collect() {
  const queries = [
    `SELECT DISTINCT stored_name AS name FROM files WHERE stored_name IS NOT NULL`,
    `SELECT DISTINCT stored_name AS name FROM personal_library_items WHERE stored_name IS NOT NULL`,
    `SELECT DISTINCT stored_name AS name FROM file_collection_uploads WHERE stored_name IS NOT NULL`
  ];
  const names = new Set();
  for (const query of queries) {
    const result = await pool.query(query);
    for (const row of result.rows) {
      if (isBlobPath(row.name)) names.add(row.name);
    }
  }
  return [...names].sort();
}

async function exists(pathname) {
  try { await localStorage.head(pathname); return true; }
  catch (error) { if (error && error.name === 'BlobNotFoundError') return false; throw error; }
}

(async () => {
  const names = await collect();
  console.log(`Encontrados ${names.length} objeto(s) no Vercel Blob.`);
  let migrated = 0, skipped = 0, failed = 0;
  const { get } = await import('@vercel/blob');
  for (const pathname of names) {
    if (await exists(pathname)) {
      skipped++;
      console.log(`= ${pathname} (já existe)`);
      continue;
    }
    if (dryRun) {
      console.log(`+ ${pathname}`);
      continue;
    }
    let temp = '';
    try {
      const result = await get(pathname, { access: 'private' });
      if (!result || !result.stream) throw new Error('Blob sem stream');
      const target = localStorage.absolutePath(pathname);
      temp = target + '.migrate-' + process.pid;
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await pipeline(Readable.fromWeb(result.stream), fs.createWriteStream(temp, { mode: 0o600 }));
      const actualSize = (await fs.promises.stat(temp)).size;
      const expectedSize = Number(result.blob && result.blob.size);
      if (Number.isFinite(expectedSize) && expectedSize > 0 && actualSize !== expectedSize) {
        throw new Error(`tamanho divergente: esperado ${expectedSize}, recebido ${actualSize}`);
      }
      await fs.promises.rename(temp, target);
      await fs.promises.writeFile(target + '.meta.json', JSON.stringify({
        size: actualSize,
        contentType: (result.blob && result.blob.contentType) || localStorage.contentTypeFor(pathname),
        pathname,
        updatedAt: new Date().toISOString()
      }), 'utf8');
      migrated++;
      console.log(`✓ ${pathname} (${(await fs.promises.stat(target)).size} bytes)`);
    } catch (error) {
      failed++;
      if (temp) await fs.promises.rm(temp, { force: true }).catch(() => {});
      console.error(`✗ ${pathname}: ${error && error.message ? error.message : error}`);
    }
  }
  await pool.end();
  console.log(`\nResumo: ${migrated} migrado(s), ${skipped} já existente(s), ${failed} falha(s).`);
  if (failed) process.exitCode = 1;
})().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
