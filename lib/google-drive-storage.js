'use strict';

const {
  classifyGoogleDriveError,
  errorReason,
  errorStatus
} = require('./google-drive-errors.js');

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILE_PREFIX = 'gdrive:';
const DRIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const DRIVE_DIRECT_CHUNK_BYTES = 16 * 1024 * 1024;
const DRIVE_MAX_RETRIES = 2;
const FOLDER_CACHE_MS = 6 * 60 * 60 * 1000;
const FOLDER_ROOT_NAME = 'Arquive Online';

const isDriveFileRef = value => typeof value === 'string' && value.startsWith(DRIVE_FILE_PREFIX);
function driveFileIdFromRef(value) {
  if (!isDriveFileRef(value)) return '';
  const reference = value.slice(DRIVE_FILE_PREFIX.length);
  const separator = reference.indexOf(':');
  return separator < 0 ? reference : reference.slice(separator + 1);
}
function driveAccountIdFromRef(value) {
  if (!isDriveFileRef(value)) return '';
  const reference = value.slice(DRIVE_FILE_PREFIX.length);
  const separator = reference.indexOf(':');
  return separator < 0 ? '' : reference.slice(0, separator);
}
const driveFileRef = (id, accountId = '') => DRIVE_FILE_PREFIX + (accountId ? `${String(accountId)}:` : '') + String(id || '');

function retryAfterMsFrom(response) {
  try {
    const raw = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('retry-after')
      : '';
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 8000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 8000));
  } catch (_) { /* headers ausentes não impedem o retry */ }
  return 0;
}

function safeGoogleError(response, payload, extra = {}) {
  const status = Number(response && response.status) || 0;
  const reason = errorReason(payload && payload.error ? { body: payload } : '') ||
    (payload && typeof payload.error === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(payload.error) ? payload.error : '');
  const safeReason = typeof reason === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(reason) ? `; ${reason}` : '';
  const error = new Error(`Google Drive API falhou (HTTP ${status}${safeReason}).`);
  error.status = status;
  if (reason) error.reason = reason;
  error.retryAfterMs = Number(extra.retryAfterMs) || retryAfterMsFrom(response);
  error.kind = classifyGoogleDriveError(error).kind;
  if (extra.alreadyExists) error.alreadyExists = true;
  return error;
}

// Escapa um valor para a query `q` do Drive (sintaxe de busca).
const escapeDriveQuery = value => String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").slice(0, 200);

function createGoogleDriveStorage({
  clientId, clientSecret, getRefreshToken, fetchImpl = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onRequest = null, retries = DRIVE_MAX_RETRIES
}) {
  let accessToken = '';
  let accessTokenExpiresAt = 0;
  let folderCache = null;

  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && accessToken && accessTokenExpiresAt > now() + 60000) return accessToken;
    const refreshToken = await getRefreshToken();
    if (!refreshToken || !clientId || !clientSecret) throw new Error('A conexão com Google Drive não está disponível.');
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw safeGoogleError(response, payload);
    accessToken = payload.access_token;
    accessTokenExpiresAt = now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000;
    return accessToken;
  }

  const recordRequest = (method, url, status, bytes) => {
    if (typeof onRequest !== 'function') return;
    try { onRequest({ method, url: String(url), status, bytes: Number(bytes) || 0 }); } catch (_) { /* medição nunca derruba o envio */ }
  };

  // Repete apenas o que é seguro repetir: GET/DELETE/PUT e a criação da sessão
  // resumível (que é nova a cada tentativa). Assim um 429/5xx não condena o
  // upload, mas um copy/upload concluído não é duplicado.
  async function authorizedFetch(url, options = {}, { retry } = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const target = String(url);
    const repeatable = retry === true || (retry !== false && (
      method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE' ||
      (method === 'POST' && target.includes('/upload/drive/v3/files'))
    ));
    const requestBytes = Buffer.isBuffer(options.body)
      ? options.body.length
      : typeof options.body === 'string' ? Buffer.byteLength(options.body) : 0;
    let token = await getAccessToken();
    let refreshed = false;
    let attempt = 0;
    while (true) {
      let response;
      try {
        response = await fetchImpl(target, {
          ...options,
          headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
        });
      } catch (error) {
        recordRequest(method, target, 0, requestBytes);
        if (repeatable && attempt < retries) {
          await sleep(Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150));
          attempt++;
          continue;
        }
        throw error;
      }
      recordRequest(method, target, response.status, requestBytes);
      if (response.status === 401 && !refreshed) {
        token = await getAccessToken(true);
        refreshed = true;
        continue;
      }
      if (repeatable && attempt < retries && (response.status === 429 || (response.status >= 500 && response.status <= 599))) {
        const wait = retryAfterMsFrom(response) || Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 150);
        await sleep(wait);
        attempt++;
        continue;
      }
      return response;
    }
  }

  async function jsonResponse(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw safeGoogleError(response, payload, {
      alreadyExists: response.status === 409 || errorReason({ body: payload }) === 'duplicate'
    });
    return payload;
  }

  async function findOrCreateFolder(name, parentId = '') {
    const query = [
      `name = '${escapeDriveQuery(name)}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      'trashed = false'
    ];
    if (parentId) query.push(`'${escapeDriveQuery(parentId)}' in parents`);
    const url = new URL(DRIVE_API);
    url.searchParams.set('q', query.join(' and '));
    url.searchParams.set('fields', 'files(id,name)');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', '1');
    const found = await jsonResponse(await authorizedFetch(url));
    const existing = found && Array.isArray(found.files) ? found.files[0] : null;
    if (existing && existing.id) return String(existing.id);
    const createUrl = new URL(DRIVE_API);
    createUrl.searchParams.set('fields', 'id');
    const metadata = { name: String(name), mimeType: 'application/vnd.google-apps.folder' };
    if (parentId) metadata.parents = [parentId];
    const created = await jsonResponse(await authorizedFetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    }));
    return String(created && created.id || '');
  }

  // Organiza os envios em "Arquive Online/AAAA-MM". Qualquer falha (permissão,
  // cota, API fora) volta para a raiz do Drive em vez de impedir o upload.
  async function ensureUploadFolder() {
    if (folderCache && now() - folderCache.at < FOLDER_CACHE_MS) return folderCache.id;
    try {
      const root = await findOrCreateFolder(FOLDER_ROOT_NAME);
      if (!root) return '';
      const month = new Date(now()).toISOString().slice(0, 7);
      const folder = await findOrCreateFolder(month, root);
      if (!folder) return '';
      folderCache = { id: folder, at: now() };
      return folder;
    } catch (_) {
      return '';
    }
  }

  async function generateIds(count = 1) {
    const url = new URL('https://www.googleapis.com/drive/v3/files/generateIds');
    url.searchParams.set('count', String(Math.max(1, Math.min(10, Number(count) || 1))));
    url.searchParams.set('space', 'drive');
    url.searchParams.set('type', 'files');
    const payload = await jsonResponse(await authorizedFetch(url));
    return Array.isArray(payload.ids) ? payload.ids.filter(id => typeof id === 'string') : [];
  }

  async function startResumableUpload({ name, mimeType, size, uploadId, fileId = '', origin = '', organize = true, parents = [] }) {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Tamanho de arquivo inválido para o Google Drive.');
    const url = new URL(DRIVE_UPLOAD_API);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('fields', 'id,name,size,mimeType,appProperties');
    const targetParents = Array.isArray(parents) && parents.length
      ? parents.map(String)
      : (organize ? [await ensureUploadFolder()].filter(Boolean) : []);
    const metadata = {
      name: String(name || 'arquivo').slice(0, 255),
      mimeType: String(mimeType || 'application/octet-stream').slice(0, 100),
      appProperties: { fileshareUploadId: String(uploadId) }
    };
    if (fileId && /^[A-Za-z0-9_-]{10,200}$/.test(String(fileId))) metadata.id = String(fileId);
    if (targetParents.length) metadata.parents = targetParents;
    const headers = {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': metadata.mimeType,
      'X-Upload-Content-Length': String(size)
    };
    // O header Origin libera o CORS da sessão para o envio direto do navegador.
    if (origin && /^https?:\/\/[^/\s]{1,200}$/i.test(String(origin))) headers.Origin = String(origin);
    const response = await authorizedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(metadata)
    }, { retry: true });
    if (!response.ok) throw safeGoogleError(response, await response.json().catch(() => ({})));
    const sessionUrl = response.headers.get('location');
    if (!sessionUrl) throw new Error('Google Drive não retornou uma sessão de upload válida.');
    const parsedSessionUrl = new URL(sessionUrl);
    if (parsedSessionUrl.protocol !== 'https:' || !(parsedSessionUrl.hostname === 'googleapis.com' || parsedSessionUrl.hostname.endsWith('.googleapis.com'))) {
      throw new Error('Google Drive retornou uma sessão de upload inválida.');
    }
    return sessionUrl;
  }

  async function queryResumableUpload(sessionUrl, size) {
    const response = await authorizedFetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' }
    });
    if (response.status === 308) {
      const range = response.headers.get('range');
      const match = range && range.match(/bytes=0-(\d+)/i);
      return { complete: false, nextOffset: match ? Number(match[1]) + 1 : 0 };
    }
    if (response.ok) return { complete: true, file: await response.json().catch(() => ({})) };
    throw safeGoogleError(response, await response.json().catch(() => ({})));
  }

  async function uploadResumableChunk(sessionUrl, size, start, bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!buffer.length || start < 0 || start + buffer.length > size) throw new Error('Bloco de upload inválido.');
    const end = start + buffer.length - 1;
    const response = await authorizedFetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(buffer.length),
        'Content-Range': `bytes ${start}-${end}/${size}`
      },
      body: buffer
    });
    if (response.status === 308) {
      const range = response.headers.get('range');
      const match = range && range.match(/bytes=0-(\d+)/i);
      return { complete: false, nextOffset: match ? Number(match[1]) + 1 : 0 };
    }
    if (response.ok) return { complete: true, file: await response.json().catch(() => ({})) };
    throw safeGoogleError(response, await response.json().catch(() => ({})));
  }

  async function uploadBuffer({ name, mimeType, buffer, uploadId }) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!bytes.length) throw new Error('Não é possível enviar um arquivo vazio ao Google Drive.');
    const sessionUrl = await startResumableUpload({ name, mimeType, size: bytes.length, uploadId });
    let offset = 0;
    let result;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(offset + DRIVE_CHUNK_BYTES, bytes.length));
      result = await uploadResumableChunk(sessionUrl, bytes.length, offset, chunk);
      offset = result.complete ? bytes.length : result.nextOffset;
      if (!result.complete && offset <= 0) throw new Error('O Google Drive não confirmou o bloco enviado.');
    }
    if (!result || !result.complete || !result.file.id) throw new Error('O Google Drive não confirmou a conclusão do upload.');
    return result.file;
  }

  async function uploadChunkFromServer(sessionUrl, size, start, bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!buffer.length || start < 0 || start + buffer.length > size) throw new Error('Bloco de upload inválido.');
    const safeSessionUrl = new URL(sessionUrl);
    if (safeSessionUrl.protocol !== 'https:' || !(safeSessionUrl.hostname === 'googleapis.com' || safeSessionUrl.hostname.endsWith('.googleapis.com'))) throw new Error('Sessão de upload do Google Drive inválida.');
    const response = await authorizedFetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(buffer.length),
        'Content-Range': `bytes ${start}-${start + buffer.length - 1}/${size}`
      },
      body: buffer
    });
    if (response.status === 308) {
      const range = response.headers.get('range');
      const match = range && range.match(/bytes=0-(\d+)/i);
      return { complete: false, nextOffset: match ? Number(match[1]) + 1 : 0 };
    }
    if (response.ok) return { complete: true, file: await response.json().catch(() => ({})) };
    throw safeGoogleError(response, await response.json().catch(() => ({})));
  }

  async function resumeUploadChunk(sessionUrl, size, start, bytes) {
    try {
      return await uploadChunkFromServer(sessionUrl, size, start, bytes);
    } catch (uploadError) {
      const info = classifyGoogleDriveError(uploadError);
      // Sessão morta: não adianta consultar; o chamador abre outra.
      if (info.sessionInvalid) throw uploadError;
      // A resposta pode ter se perdido depois que o Drive aceitou o bloco.
      // Consulte a sessão antes de decidir se é seguro reenviar.
      let state;
      try { state = await queryResumableUpload(sessionUrl, size); }
      catch (_) { throw uploadError; }
      if (state.complete) return state;
      const end = start + (Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes)) - 1;
      if (state.nextOffset >= end + 1 && state.nextOffset < size) return { complete: false, nextOffset: state.nextOffset };
      if (state.nextOffset >= size) throw uploadError;
      if (state.nextOffset !== start) {
        throw new Error('O Google Drive confirmou uma posição que exige recarregar o arquivo e iniciar o envio novamente.');
      }
      return uploadChunkFromServer(sessionUrl, size, start, bytes);
    }
  }

  async function uploadBufferChunked({ name, mimeType, buffer, uploadId, onProgress }) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!bytes.length) throw new Error('Não é possível enviar um arquivo vazio ao Google Drive.');
    const sessionUrl = await startResumableUpload({ name, mimeType, size: bytes.length, uploadId });
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(offset + DRIVE_CHUNK_BYTES, bytes.length));
      const result = await resumeUploadChunk(sessionUrl, bytes.length, offset, chunk);
      if (result.complete) return result.file;
      if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset > bytes.length) {
        throw new Error('O Google Drive retornou uma posição de envio inválida.');
      }
      offset = result.nextOffset;
      if (typeof onProgress === 'function') onProgress(offset, bytes.length);
    }
    throw new Error('O Google Drive não confirmou a conclusão do upload.');
  }

  async function getFile(fileId, { range } = {}) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(fileId || ''))) throw new Error('Identificador de arquivo do Drive inválido.');
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(fileId)}`);
    url.searchParams.set('alt', 'media');
    const headers = range ? { Range: range } : {};
    const response = await authorizedFetch(url, { method: 'GET', headers });
    if (!response.ok) throw safeGoogleError(response, await response.json().catch(() => ({})));
    return response;
  }

  async function getFileMetadata(fileId) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(fileId || ''))) throw new Error('Identificador de arquivo do Drive inválido.');
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields', 'id,name,size,mimeType,appProperties');
    return jsonResponse(await authorizedFetch(url));
  }

  async function getAbout() {
    const url = new URL('https://www.googleapis.com/drive/v3/about');
    url.searchParams.set('fields', 'user(displayName,emailAddress,photoLink),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)');
    return jsonResponse(await authorizedFetch(url));
  }

  // Lista os arquivos criados pelo app (appProperties.fileshareUploadId) para
  // reconciliar o banco com o Drive sem varrer a conta inteira.
  async function listAppFiles({ pageToken = '', pageSize = 100 } = {}) {
    const url = new URL(DRIVE_API);
    url.searchParams.set('q', "appProperties has { key='fileshareUploadId' } and trashed = false");
    url.searchParams.set('fields', 'nextPageToken,files(id,name,size,mimeType,appProperties,createdTime)');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', String(Math.max(1, Math.min(1000, Number(pageSize) || 100))));
    if (pageToken) url.searchParams.set('pageToken', String(pageToken));
    return jsonResponse(await authorizedFetch(url));
  }

  async function copyFile(fileId, { name, uploadId }) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(fileId || ''))) throw new Error('Identificador de arquivo do Drive inválido.');
    const url = new URL(`${DRIVE_API}/${encodeURIComponent(fileId)}/copy`);
    url.searchParams.set('fields', 'id,name,size,mimeType,appProperties');
    return jsonResponse(await authorizedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: String(name || 'arquivo').slice(0, 255), appProperties: { fileshareUploadId: String(uploadId) } })
    }));
  }

  async function deleteFile(fileId) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(fileId || ''))) throw new Error('Identificador de arquivo do Drive inválido.');
    const response = await authorizedFetch(`${DRIVE_API}/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (response.status === 404) return;
    if (!response.ok) throw safeGoogleError(response, await response.json().catch(() => ({})));
  }

  return {
    getAccessToken, getAbout, startResumableUpload, queryResumableUpload, uploadResumableChunk,
    uploadChunkFromServer, resumeUploadChunk, uploadBufferChunked, uploadBuffer, getFile, getFileMetadata,
    copyFile, deleteFile, generateIds, listAppFiles, ensureUploadFolder,
    resetFolderCache: () => { folderCache = null; }
  };
}

module.exports = {
  DRIVE_CHUNK_BYTES,
  DRIVE_DIRECT_CHUNK_BYTES,
  DRIVE_FILE_PREFIX,
  createGoogleDriveStorage,
  driveAccountIdFromRef,
  driveFileIdFromRef,
  driveFileRef,
  errorStatus,
  isDriveFileRef,
  safeGoogleError
};
