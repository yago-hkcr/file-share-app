// Regressão para carregamento: cache de assets versionados e OCR carregado sob demanda.
// Uso: node test/regression-performance.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const server = read('server.js');
const dashboard = read('public', 'dashboard.html');

assert.match(server, /public, max-age=31536000, immutable/);
assert.match(server, /req\.query && req\.query\.v/);
assert.match(server, /res\.locals\.cacheImmutableAsset/);
assert.ok(server.includes('setHeaders(res, filePath)') && server.includes("if (res.locals.cacheImmutableAsset && /\\.(?:css|js)$/i.test(filePath))"),
  'o cache imutável é aplicado somente a CSS/JS estáticos existentes');
assert.doesNotMatch(dashboard, /<script[^>]+tesseract\.js[^>]*>/i);
assert.match(dashboard, /function loadTesseract\(\)/);
assert.match(dashboard, /await loadTesseract\(\)/);
assert.match(dashboard, /message-export\.js/);
assert.match(dashboard, /adaptive\.js/);
assert.match(dashboard, /fonts\.gstatic\.com[^>]+crossorigin/);
assert.match(dashboard, /preconnect[^>]+cdn\.jsdelivr\.net/);

console.log('Todas as asserções de carregamento/performance passaram.');