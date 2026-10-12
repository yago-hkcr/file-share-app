// Sonda temporária: valida o fluxo multipart presigned da coleta contra o Blob real.
// Uso: node scripts/probe-blob.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.unpooled'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const blobSdk = await import('@vercel/blob');
const blobClientSdk = await import('@vercel/blob/client');
const express = (await import('express')).default;

const COLLECTION_BLOB_PATH_RE = /^collections\/([0-9a-f-]{36})\/([0-9a-f-]{36})-[A-Za-z0-9._-]{1,80}$/;
const MAX_BLOB_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;

const app = express();
app.use(express.json({ limit: '10kb' }));
app.post('/upload-token', async (req, res) => {
  try {
    const rawPathname = (req.body && req.body.payload && req.body.payload.pathname) || (req.body && req.body.pathname) || '';
    const pathname = String(rawPathname);
    console.log('DIAG pathname recebido:', JSON.stringify(pathname), '| ct:', req.headers['content-type'], '| body:', JSON.stringify(req.body).slice(0, 300));
    const match = COLLECTION_BLOB_PATH_RE.exec(pathname);
    if (!match) return res.status(400).json({ error: 'Caminho de upload inválido.' });
    const staged = { id: match[2], size: Number(process.env.PROBE_SIZE) };
    const result = await blobClientSdk.handleUploadPresigned({
      request: req,
      body: req.body,
      getSignedToken: async requestedPath => {
        if (requestedPath !== pathname) throw new Error('Caminho de upload inválido');
        const validUntil = Date.now() + 24 * 60 * 60 * 1000;
        const maximumSizeInBytes = staged.size;
        const token = await blobSdk.issueSignedToken({ pathname, operations: ['put'], maximumSizeInBytes, validUntil });
        return { token, urlOptions: { maximumSizeInBytes, addRandomSuffix: false, allowOverwrite: false, validUntil } };
      }
    });
    res.json(result);
  } catch (error) {
    console.error('upload-token FALHOU:', error && (error.stack || error.message));
    res.status(500).json({ error: error.message });
  }
});
const PORT = 4799;
await new Promise(r => app.listen(PORT, '127.0.0.1', r));
console.log('handler local em http://127.0.0.1:' + PORT + '/upload-token');

const { uploadPresigned } = await import('@vercel/blob/client');
const pathname = `collections/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222-probe-${Date.now()}.bin`;
const parts = [Buffer.from('a'.repeat(5 * 1024 * 1024)), Buffer.from('b'.repeat(1024))];
const file = new Blob(parts, { type: 'application/octet-stream' });
Object.defineProperty(file, 'size', { value: parts.reduce((n, p) => n + p.length, 0) });
process.env.PROBE_SIZE = String(file.size);

try {
  // Diagnóstico: chama o handler direto e mostra o corpo da resposta.
  const probeEvent = { type: 'blob.generate-presigned-url', payload: { pathname, clientPayload: '{}', multipart: true } };
  const direct = await fetch('http://127.0.0.1:' + PORT + '/upload-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(probeEvent) });
  console.log('DIAG handler status:', direct.status, '| corpo:', (await direct.text()).slice(0, 400));
  console.log('webhook key presente:', Boolean(process.env.BLOB_WEBHOOK_PUBLIC_KEY), '| tamanho:', (process.env.BLOB_WEBHOOK_PUBLIC_KEY || '').length);
  const result = await uploadPresigned(pathname, file, {
    access: 'private',
    handleUploadUrl: 'http://127.0.0.1:' + PORT + '/upload-token',
    clientPayload: JSON.stringify({ uploadId: 'probe' }),
    multipart: true
  });
  console.log('MULTIPART OK:', { pathname: result.pathname, size: file.size, url: result.url ? 'sim' : 'não' });
  const head = await blobSdk.head(pathname);
  console.log('HEAD OK:', { size: head.size, uploadedAt: head.uploadedAt });
  await blobSdk.del(pathname);
  console.log('CLEANUP OK (blob de teste apagado)');
} catch (error) {
  console.error('PROBE FALHOU:', error && (error.stack || error.message));
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode || 0);
}
