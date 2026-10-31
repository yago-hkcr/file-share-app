'use strict';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILE_PREFIX = 'gdrive:';
const DRIVE_CHUNK_BYTES = 4 * 1024 * 1024;

const isDriveFileRef = value => typeof value === 'string' && value.startsWith(DRIVE_FILE_PREFIX);
const driveFileIdFromRef = value => isDriveFileRef(value) ? value.slice(DRIVE_FILE_PREFIX.length) : '';
const driveFileRef = id => DRIVE_FILE_PREFIX + String(id || '');

function safeGoogleError(response, payload) {
  const reason = payload && payload.error && typeof payload.error === 'object' && payload.error.errors && payload.error.errors[0]
    ? payload.error.errors[0].reason
    : payload && typeof payload.error === 'string' ? payload.error : '';
  const safeReason = typeof reason === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(reason) ? `; ${reason}` : '';
  return new Error(`Google Drive API falhou (HTTP ${response.status}${safeReason}).`);
}

function createGoogleDriveStorage({ clientId, clientSecret, getRefreshToken, fetchImpl = fetch, now = Date.now }) {
  let accessToken = '';
  let accessTokenExpiresAt = 0;

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

  async function authorizedFetch(url, options = {}) {
    let token = await getAccessToken();
    let response = await fetchImpl(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
    });
    if (response.status === 401) {
      token = await getAccessToken(true);
      response = await fetchImpl(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
      });
    }
    return response;
  }

  async function jsonResponse(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw safeGoogleError(response, payload);
    return payload;
  }

  async function startResumableUpload({ name, mimeType, size, uploadId }) {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Tamanho de arquivo inválido para o Google Drive.');
    const url = new URL(DRIVE_UPLOAD_API);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('fields', 'id,name,size,mimeType,appProperties');
    const metadata = {
      name: String(name || 'arquivo').slice(0, 255),
      mimeType: String(mimeType || 'application/octet-stream').slice(0, 100),
      appProperties: { fileshareUploadId: String(uploadId) }
    };
    const response = await authorizedFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': metadata.mimeType,
        'X-Upload-Content-Length': String(size)
      },
      body: JSON.stringify(metadata)
    });
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

  return { getAccessToken, getAbout, startResumableUpload, queryResumableUpload, uploadResumableChunk, uploadChunkFromServer, resumeUploadChunk, uploadBufferChunked, uploadBuffer, getFile, getFileMetadata, copyFile, deleteFile };
}

module.exports = {
  DRIVE_CHUNK_BYTES,
  DRIVE_FILE_PREFIX,
  createGoogleDriveStorage,
  driveFileIdFromRef,
  driveFileRef,
  isDriveFileRef
};