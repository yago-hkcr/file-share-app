// Regressão do transporte autenticado, reconciliação e troca de conta.
// Uso: node test/regression-google-drive-transport.mjs
import assert from 'node:assert/strict';
import { uploadDriveFile } from '../public/js/google-drive-upload.mjs';

const file = new Blob(['abcdefgh']);
const session = { upload_id: 'upload-a', chunk_bytes: 4 };
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

// Fluxo normal: confirma que o último bloco realmente concluiu no Drive.
{
  const calls = [];
  const progress = [];
  let chunks = 0;
  await uploadDriveFile(session, file, {
    onProgress: value => progress.push(value),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'same-origin');
      if (url.endsWith('/status')) return response(200, chunks === 0
        ? { complete: false, next_offset: 0 }
        : { complete: true, next_offset: file.size });
      if (++chunks === 1) return response(200, { complete: false, next_offset: 4 });
      return response(200, { complete: false, next_offset: file.size });
    }
  });
  assert.equal(calls.filter(call => call.url.endsWith('/chunk')).length, 2);
  const chunksSent = calls.filter(call => call.url.endsWith('/chunk'));
  assert.equal(chunksSent[0].options.headers['Content-Range'], 'bytes 0-3/8');
  assert.equal(chunksSent[1].options.headers['Content-Range'], 'bytes 4-7/8');
  assert.equal(calls.every(call => !call.url.startsWith('https://')), true, 'sessão privada não sai do servidor');
  assert.equal(calls.some(call => call.url.endsWith('/status')), true);
  assert.equal(progress.at(-1), 100);
}

// A resposta de um bloco pode se perder depois da aceitação; reconcilia o
// offset remoto e envia apenas os bytes restantes.
{
  const ranges = [];
  const calls = [];
  let statusCount = 0;
  let chunkCount = 0;
  await uploadDriveFile(session, file, {
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url.endsWith('/status')) {
        statusCount++;
        return response(200, statusCount === 1 ? { complete: false, next_offset: 0 }
          : statusCount === 2 ? { complete: false, next_offset: 4 }
            : { complete: true, next_offset: file.size });
      }
      ranges.push(options.headers['Content-Range']);
      chunkCount++;
      if (chunkCount === 1) throw new TypeError('Failed to fetch');
      return response(200, { complete: false, next_offset: file.size });
    }
  });
  assert.deepEqual(ranges, ['bytes 0-3/8', 'bytes 4-7/8']);
  assert.equal(calls.filter(url => url.endsWith('/status')).length, 3);
}

// Se o estado remoto ainda não avançou após falha ambígua, pode-se tentar o
// mesmo bloco novamente; não há retry sem consulta ao endpoint de estado.
{
  const calls = [];
  let failedOnce = false;
  let statusCount = 0;
  await uploadDriveFile({ upload_id: 'upload-b', chunk_bytes: 4 }, new Blob(['abcd']), {
    fetchImpl: async (url, options) => {
      calls.push({ url, range: options.headers['Content-Range'] });
      if (url.endsWith('/status')) {
        statusCount++;
        return response(200, statusCount < 3
          ? { complete: false, next_offset: 0 }
          : { complete: true, next_offset: 4 });
      }
      if (!failedOnce) { failedOnce = true; throw new TypeError('Failed to fetch'); }
      return response(200, { complete: false, next_offset: 4 });
    }
  });
  assert.deepEqual(calls.map(call => call.url.endsWith('/status') ? 'status' : call.range), [
    'status', 'bytes 0-3/4', 'status', 'bytes 0-3/4', 'status'
  ]);
}

// A cota pode forçar nova sessão; nunca mistura offsets entre contas.
{
  const ids = [];
  let firstSessionChunks = 0;
  let statusCalls = 0;
  await uploadDriveFile(session, file, {
    onSessionChange: current => ids.push(current.upload_id),
    fetchImpl: async (url, options) => {
      if (url.endsWith('/status')) {
        statusCalls++;
        return response(200, statusCalls < 3
          ? { complete: false, next_offset: 0 }
          : { complete: true, next_offset: file.size });
      }
      if (url.includes('/upload-a/')) {
        firstSessionChunks++;
        if (firstSessionChunks === 1) return response(409, {
          state: 'account_changed', session: { upload_id: 'upload-b', chunk_bytes: 4 }
        });
      }
      return response(200, { complete: false, next_offset: file.size });
    }
  });
  assert.deepEqual(ids, ['upload-a', 'upload-b']);
  assert.equal(statusCalls, 3);
}

console.log('Transporte autenticado, confirmação final, reconciliação ambígua e troca de conta passaram.');