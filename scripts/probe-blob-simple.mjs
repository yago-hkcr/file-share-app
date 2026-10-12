// Sonda simples: testa o token do Blob com put/head/get diretos.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.unpooled'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const blob = await import('@vercel/blob');
const pathname = `probe-direct/probe-${Date.now()}.txt`;
try {
  const putResult = await blob.put(pathname, 'olá blob', { access: 'private', addRandomSuffix: false });
  console.log('PUT OK:', putResult.pathname, putResult.size);
  const head = await blob.head(pathname);
  console.log('HEAD OK:', head.size);
  const got = await blob.get(pathname, { access: 'private' });
  console.log('GET OK: url?', Boolean(got.url), '| stream?', Boolean(got.stream), '| downloadUrl?', Boolean(got.downloadUrl), '| contentType:', got.contentType);
  const presign = await blob.presignUrl(await blob.issueSignedToken({ pathname: 'probe-direct/outro.txt', operations: ['put'], maximumSizeInBytes: 1024, validUntil: Date.now() + 60000 }), { operation: 'put', pathname: 'probe-direct/outro.txt', access: 'private', maximumSizeInBytes: 1024, addRandomSuffix: false, allowOverwrite: false, validUntil: Date.now() + 60000 });
  console.log('PRESIGN OK:', typeof presign.presignedUrl === 'string' ? presign.presignedUrl.slice(0, 90) + '…' : JSON.stringify(presign).slice(0, 200));
  await blob.del(pathname);
  console.log('DEL OK');
} catch (error) {
  console.error('FALHOU:', error && (error.stack || error.message));
  process.exitCode = 1;
}
process.exit(process.exitCode || 0);
