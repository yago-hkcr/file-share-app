// Diagnóstico read-only do download via Vercel Blob em produção.
// Uso: node scripts/diag-blob-download.mjs .env.prod-diag
import { readFileSync } from 'node:fs';

const envFile = process.argv[2] || '.env.prod-diag';
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
}

const token = process.env.BLOB_READ_WRITE_TOKEN;
const storeId = process.env.BLOB_STORE_ID;
console.log('BLOB_STORE_ID:', storeId ? String(storeId).slice(0, 20) + '…' : '(vazio)');
console.log('BLOB_READ_WRITE_TOKEN:', token ? 'presente (' + token.length + ' chars)' : '(vazio)');

// Decodifica o store ao qual o token pertence (JWT: payload tem { s: store_... } ou similar).
try {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  console.log('token.payload:', JSON.stringify(payload));
} catch (e) {
  console.log('token.payload: (não decodificável)', e.message);
}

const { list, get } = await import('@vercel/blob');

console.log('\n== list(prefix: rooms/) ==');
let first = null;
try {
  const res = await list({ prefix: 'rooms/', limit: 3 });
  console.log('list OK. blobs:', res.blobs.length, 'hasMore:', res.hasMore);
  res.blobs.forEach(b => console.log('  -', b.pathname, b.size + 'B', b.url ? '(url ok)' : '(SEM url)'));
  first = res.blobs[0] || null;
} catch (e) {
  console.log('list FALHOU:', e && (e.name || ''), e && e.message);
}

if (first) {
  console.log('\n== get(' + first.pathname + ', { access: private }) ==');
  try {
    const r = await get(first.pathname, { access: 'private' });
    console.log('get OK. url?', !!r.url, 'downloadUrl?', !!r.downloadUrl, 'stream?', !!r.stream, 'statusCode?', r.statusCode);
    if (r.stream) { try { await r.stream.cancel(); } catch {} }
  } catch (e) {
    console.log('get FALHOU:', e && (e.name || ''), e && e.message);
    if (e && e.cause) console.log('cause:', e.cause && (e.cause.message || e.cause));
  }

  // Testa geração de URL de download presigned (para arquivos grandes / redirect).
  console.log('\n== presignUrl(operation: get) em ' + first.pathname + ' ==');
  try {
    const { issueSignedToken, presignUrl } = await import('@vercel/blob');
    const validUntil = Date.now() + 10 * 60 * 1000;
    const token = await issueSignedToken({ pathname: first.pathname, operations: ['get'], validUntil });
    const signed = await presignUrl(token, { operation: 'get', pathname: first.pathname, access: 'private', validUntil });
    console.log('presign get OK?', typeof signed.presignedUrl === 'string' ? signed.presignedUrl.slice(0, 90) + '…' : JSON.stringify(signed).slice(0, 200));
  } catch (e) {
    console.log('presign get FALHOU:', e && (e.name || ''), e && e.message);
  }

} else {
  console.log('\n(sem blob em rooms/ para testar get; tentando prefix collections/ e library/)');
  for (const prefix of ['collections/', 'library/']) {
    try {
      const res = await list({ prefix, limit: 1 });
      console.log(prefix, '-> blobs:', res.blobs.length);
      if (res.blobs[0]) {
        const r = await get(res.blobs[0].pathname, { access: 'private' });
        console.log('  get OK url?', !!r.url, 'stream?', !!r.stream);
        if (r.stream) { try { await r.stream.cancel(); } catch {} }
      }
    } catch (e) { console.log(prefix, 'FALHOU:', e && e.message); }
  }
}
