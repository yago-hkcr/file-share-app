#!/usr/bin/env node
'use strict';

// Migra os objetos privados do Vercel Blob para o armazenamento configurado
// (STORAGE_PROVIDER=local ou s3).
// Uso (no host novo, antes de desligar a Vercel):
//   DATABASE_URL=... [SUPABASE_CA_CERT=...] BLOB_READ_WRITE_TOKEN=... \
//   STORAGE_PROVIDER=local LOCAL_STORAGE_DIR=/app/storage node scripts/migrate-blob-to-local.mjs
//   STORAGE_PROVIDER=s3 S3_BUCKET=... node scripts/migrate-blob-to-local.mjs
//
// O script é idempotente: arquivos já presentes no destino são ignorados.
// Use --dry-run para apenas listar o que seria baixado.

import { createRequire } from 'node:module';

// O restante do projeto é CommonJS; este script é ESM para usar import() dinâmico.
const require = createRequire(import.meta.url);
const { Readable } = require('stream');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Permite rodar localmente com um .env preenchido, sem exportar variáveis.
for (const file of ['.env.local', '.env']) {
  const full = path.join(process.cwd(), file);
  if (!fs.existsSync(full)) continue;
  const newline = String.fromCharCode(10);
  for (const line of fs.readFileSync(full, 'utf8').split(newline)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1).replace(/^["']/, '').replace(/["']$/, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const { isBlobPath } = require('../lib/blob-paths');

const storage = require('../lib/storage');

const targetStorage = storage.sdk;
if (!targetStorage) {
  console.error('Defina STORAGE_PROVIDER=local ou STORAGE_PROVIDER=s3 antes de migrar.');
  process.exit(1);
}
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
  try { await targetStorage.head(pathname); return true; }
  catch (error) { if (error && error.name === 'BlobNotFoundError') return false; throw error; }
}

(async () => {
  const names = await collect();
  console.log(`Encontrados ${names.length} objeto(s) no Vercel Blob. Destino: ${storage.provider}.`);
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
    try {
      const result = await get(pathname, { access: 'private' });
      if (!result || !result.stream) throw new Error('Blob sem stream');
      const expectedSize = Number(result.blob && result.blob.size);
      await targetStorage.put(pathname, Readable.fromWeb(result.stream), {
        access: 'private',
        contentType: (result.blob && result.blob.contentType) || targetStorage.contentTypeFor(pathname),
        contentLength: Number.isFinite(expectedSize) && expectedSize > 0 ? expectedSize : undefined,
        addRandomSuffix: false,
        allowOverwrite: true
      });
      const written = await targetStorage.head(pathname);
      if (Number.isFinite(expectedSize) && expectedSize > 0 && written.size !== expectedSize) {
        throw new Error(`tamanho divergente: esperado ${expectedSize}, gravado ${written.size}`);
      }
      migrated++;
      console.log(`✓ ${pathname} (${written.size} bytes)`);
    } catch (error) {
      failed++;
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
