// Regressão do início OAuth do Google Drive e proteção do refresh token.
// Uso: node test/regression-google-drive-oauth.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
  DRIVE_FILE_SCOPE,
  createAuthorizationUrl,
  encryptRefreshToken,
  decryptRefreshToken,
  exchangeAuthorizationCode
} = require('../lib/google-drive-oauth.js');
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const authUrl = new URL(createAuthorizationUrl({
  clientId: 'client-id.apps.googleusercontent.com',
  redirectUri: 'https://arquive.online/api/google-drive/oauth/callback',
  state: 'state-value',
  loginHint: 'drive@example.com'
}));
assert.equal(authUrl.origin, 'https://accounts.google.com');
assert.equal(authUrl.searchParams.get('scope'), DRIVE_FILE_SCOPE);
assert.equal(authUrl.searchParams.get('access_type'), 'offline');
assert.equal(authUrl.searchParams.get('prompt'), 'consent');
assert.equal(authUrl.searchParams.get('state'), 'state-value');
assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://arquive.online/api/google-drive/oauth/callback');

const secret = 'sessao-de-teste-com-segredo-forte-123456';
const encrypted = encryptRefreshToken('refresh-token-de-teste', secret);
assert.notEqual(encrypted, 'refresh-token-de-teste');
assert.equal(decryptRefreshToken(encrypted, secret), 'refresh-token-de-teste');
assert.throws(() => decryptRefreshToken(encrypted, 'outra-sessao-tambem-com-32-caracteres'), /Unsupported state|authenticate|decryption|bad decrypt/i);

let tokenRequest;
const tokens = await exchangeAuthorizationCode({
  code: 'authorization-code',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://arquive.online/api/google-drive/oauth/callback',
  fetchImpl: async (url, options) => {
    tokenRequest = { url, options, body: new URLSearchParams(options.body) };
    return { ok: true, status: 200, json: async () => ({ access_token: 'access', refresh_token: 'refresh', scope: DRIVE_FILE_SCOPE }) };
  }
});
assert.equal(tokenRequest.url, 'https://oauth2.googleapis.com/token');
assert.equal(tokenRequest.body.get('grant_type'), 'authorization_code');
assert.equal(tokenRequest.body.get('client_secret'), 'client-secret');
assert.equal(tokens.refresh_token, 'refresh');
await assert.rejects(() => exchangeAuthorizationCode({
  code: 'authorization-code',
  clientId: 'client-id',
  clientSecret: 'client-secret-must-not-appear',
  redirectUri: 'https://arquive.online/api/google-drive/oauth/callback',
  fetchImpl: async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      error: 'invalid_client',
      error_description: 'sensitive diagnostic text that must not be logged'
    })
  })
}), error => {
  assert.match(error.message, /HTTP 401; invalid_client/);
  assert.doesNotMatch(error.message, /client-secret-must-not-appear|sensitive diagnostic text/);
  return true;
});
assert.ok(server.includes("app.get('/api/admin/google-drive/oauth/start', asAdmin"));
assert.ok(server.includes("app.get('/api/google-drive/oauth/callback', wrap(async (req, res) => {"));
assert.ok(server.includes("app.get('/api/admin/google-drive/oauth/start', asAdmin"),
  'somente administradores podem iniciar o OAuth');
assert.ok(server.includes("...(IS_VERCEL ? { domain: '.arquive.online' } : {})"),
  'cookie temporário de state atravessa www e domínio raiz sem compartilhar o cookie de sessão');
assert.ok(server.includes("GOOGLE_DRIVE_REDIRECT_URI = process.env.GOOGLE_DRIVE_REDIRECT_URI || 'https://arquive.online/api/google-drive/oauth/callback'"),
  'callback OAuth usa o domínio canônico configurado para produção');
assert.ok(server.includes('crypto.timingSafeEqual(expectedBytes, receivedBytes)'));
assert.ok(server.includes("setSetting('google_drive_refresh_token_enc', encryptedToken)"));
assert.ok(server.includes('res.cookie(GOOGLE_DRIVE_RETURN_COOKIE, returnOrigin'),
  'a origem que iniciou o OAuth é preservada junto ao state sem compartilhar o cookie de sessão');
assert.ok(server.includes('returnOriginCookie') && server.includes('/admin?drive_connected=1#storage'),
  'o callback retorna ao painel na mesma origem autenticada');
assert.ok(server.includes("app.delete('/api/admin/google-drive/connection', asAdmin"),
  'somente o administrador consegue desconectar a conta');
assert.ok(readme.includes('https://arquive.online/api/google-drive/oauth/callback'));

console.log('Todas as asserções OAuth do Google Drive passaram.');