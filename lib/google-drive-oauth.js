const crypto = require('crypto');

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function createAuthorizationUrl({ clientId, redirectUri, state, loginHint }) {
  if (!clientId || !redirectUri || !state) throw new Error('Configuração OAuth do Google incompleta.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_FILE_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

function encryptionKey(secret) {
  if (!secret || String(secret).length < 32) throw new Error('SESSION_SECRET precisa ter pelo menos 32 caracteres para proteger o token do Drive.');
  return crypto.scryptSync(String(secret), 'fileshare-google-drive-refresh-token-v1', 32);
}

function encryptRefreshToken(refreshToken, secret) {
  if (!refreshToken) throw new Error('O Google não retornou um refresh token.');
  return encryptSecret(refreshToken, secret);
}

function encryptSecret(value, secret) {
  if (!value) throw new Error('Não há valor para proteger.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptRefreshToken(value, secret) {
  return decryptSecret(value, secret);
}

function decryptSecret(value, secret) {
  const [version, ivText, tagText, encryptedText, extra] = String(value || '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText || extra !== undefined) throw new Error('Token OAuth do Google inválido ou em formato desconhecido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}

async function exchangeAuthorizationCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    code: String(code || ''),
    client_id: String(clientId || ''),
    client_secret: String(clientSecret || ''),
    redirect_uri: String(redirectUri || ''),
    grant_type: 'authorization_code'
  });
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Loggable diagnostic only: never include Google's error_description,
    // authorization code, tokens, client ID, or client secret in this error.
    const oauthError = typeof result.error === 'string' && /^[a-z_]{1,64}$/i.test(result.error)
      ? result.error
      : 'unknown';
    throw new Error(`A troca do código OAuth falhou (HTTP ${response.status}; ${oauthError}).`);
  }
  if (!result.access_token || !result.refresh_token) throw new Error('O Google não retornou os tokens necessários. Confira o acesso offline e tente conectar novamente.');
  return result;
}

module.exports = {
  DRIVE_FILE_SCOPE,
  createAuthorizationUrl,
  encryptRefreshToken,
  decryptRefreshToken,
  encryptSecret,
  decryptSecret,
  exchangeAuthorizationCode
};