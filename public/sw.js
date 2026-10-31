// ============================================================================
// FileShare — Service Worker
//  • Cache offline de assets estáticos (estratégia cache-first)
//  • HTML/API: sempre pela rede (não armazenar conteúdo ou redirects autenticados)
//  • Background Sync: fila de uploads em IndexedDB processada quando volta online
//  • Push: esqueleto pronto para notificações push
// ============================================================================
'use strict';

const CACHE_NAME = 'fileshare-v5';
const ASSETS = [
  '/css/social.css?v=20261027c',
  '/css/upload-queue.css?v=20261027a',
  '/css/collections.css?v=20261030d',
  '/css/style.css?v=20261014o',
  '/css/mobile.css?v=20261014o',
  '/css/adaptive.css?v=20261014b',
  '/css/mobile-scroll-fix.css?v=20261027a',
  '/css/fx.css?v=20261014o',
  '/css/preview.css?v=20261014o',
  '/css/hacker-ui.css?v=20261014o',
  '/js/common.js?v=20261027b',
  '/js/adaptive.js?v=20261014a',
  '/js/mobile.js?v=20261014o',
  '/js/gfx.js?v=20261014p',
  '/js/fx.js?v=20261014o',
  '/js/upload-queue.js?v=20261027a',
  '/js/upload.js?v=20261030e',
  '/js/social.js?v=20261014o',
  '/js/personal.js?v=20261027d',
  '/js/message-export.js?v=20261027c',
  '/js/cursor.js?v=20261014o',
  '/js/preview.js?v=20261014o',
  '/js/collections.js?v=20261030c',
  '/js/collection-upload.js?v=20261030c',
  '/js/library.js?v=20261030e',
  '/js/dashboard-shell.js?v=20261014o',
  '/js/announce.js?v=20261014o',
  '/js/cyber.js?v=20261014o',
  '/manifest.json',
  '/favicon.png',
  '/favicon-48.png',
  '/apple-touch-icon.png'
];

const SYNC_TAG = 'fs-upload-sync';
const DB_NAME = 'FileShareUploads';
const DB_STORE = 'pending';
const DB_VERSION = 1;

// ---------------------------------------------------------------------------
// Instalação: coloca os assets estáticos em cache
// ---------------------------------------------------------------------------
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.all(ASSETS.map(asset =>
      cache.add(asset).catch(err => console.warn('[SW] Falha ao cachear asset:', asset, err))
    )))
  );
});

// ---------------------------------------------------------------------------
// Ativação: remove caches antigos
// ---------------------------------------------------------------------------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('fileshare-') && k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
// ---------------------------------------------------------------------------
// Requisições: cache-first somente para assets públicos estáticos.
// Navegações, APIs, uploads e conteúdo de arquivos não entram no Cache Storage.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const staticAsset = url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/') ||
    ['/manifest.json', '/favicon.png', '/favicon-48.png', '/apple-touch-icon.png'].includes(url.pathname);
  if (!staticAsset) return;

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok && response.type === 'basic') {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      } catch (err) {
        console.warn('[SW] Não foi possível guardar asset em cache:', url.pathname, err);
      }
    }
    return response;
  })());
});

// ---------------------------------------------------------------------------
// IndexedDB: fila de uploads pendentes
// ---------------------------------------------------------------------------
function openUploadsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getPendingUploads() {
  return openUploadsDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const all = [];
    store.openCursor().onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { all.push(cursor.value); cursor.continue(); }
      else resolve(all);
    };
    tx.onerror = () => reject(tx.error);
  }));
}

function removePendingUpload(id) {
  return openUploadsDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Falha ao remover upload da fila.'));
  }));
}

function updatePendingUpload(item) {
  return openUploadsDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Falha ao atualizar upload pendente.'));
  }));
}

// ---------------------------------------------------------------------------
// Reenvia um upload pendente (presigned URL ou legacy multipart)
// ---------------------------------------------------------------------------
function replayUpload(item) {
  const { kind, roomId, file, pathname, uploadUrl, name, size, mime } = item;
  if (!item.ownerId) return Promise.reject(new Error('Upload pendente sem usuário proprietário; abra novamente a conta que iniciou o envio.'));
  const verifyOwner = fetch('/api/me', { cache: 'no-store' }).then(async resp => {
    if (!resp.ok) throw new Error('Sessão encerrada; entre novamente para retomar o upload.');
    const user = await resp.json();
    if (String(user.id) !== String(item.ownerId)) throw new Error('Este upload pertence a outra conta; entre na conta original para retomá-lo.');
  });
  if (!pathname || (kind === 'presigned' && item.stage === 'upload' && !uploadUrl)) {
    return Promise.reject(new Error('Upload pendente sem dados suficientes para retomada.'));
  }
  const postToChat = async () => {
    const content = '[[file:' + item.fileId + '|' + (name || 'arquivo') + '|' + (mime || '') + ']]';
    const messagesResponse = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/messages', { cache: 'no-store' });
    if (!messagesResponse.ok) throw new Error('Não foi possível confirmar se o arquivo já foi publicado no chat (' + messagesResponse.status + ')');
    const messages = await messagesResponse.json();
    if (messages.some(message => String(message.user_id) === String(item.ownerId) && message.content === content)) {
      item.stage = 'complete';
      await updatePendingUpload(item);
      return;
    }
    const response = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, reply_to_id: item.replyToId || null })
    });
    if (!response.ok) throw new Error('Arquivo enviado, mas não foi possível publicá-lo no chat (' + response.status + ')');
    item.stage = 'complete';
    await updatePendingUpload(item);
  };

  const register = () => fetch('/api/rooms/' + encodeURIComponent(roomId) + '/files/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pathname, name, size, mime, chat_only: item.chatOnly ? 1 : 0 })
  }).then(async resp => {
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const error = new Error(result.error || 'Falha ao registrar upload pendente (' + resp.status + ')');
      error.state = result.state;
      throw error;
    }
    if (item.chatOnly) {
      item.fileId = result.id;
      item.stage = 'message';
      await updatePendingUpload(item);
      return postToChat();
    }
  });

  if (item.stage === 'complete') return Promise.resolve();
  if (item.stage === 'message') return verifyOwner.then(postToChat);
  if (item.stage === 'register') return verifyOwner.then(register);
  if (kind === 'multipart' && item.stage === 'upload') {
    // O multipart já foi concluído no Blob: falta apenas confirmar o arquivo.
    return verifyOwner.then(register);
  }
  if (kind !== 'presigned' || !file || !uploadUrl) {
    return Promise.reject(new Error('Este tipo de upload não pode ser retomado em segundo plano.'));
  }
  return verifyOwner.then(async () => {
    // O PUT pode ter concluído mesmo que sua resposta tenha se perdido.
    try {
      await register();
      return;
    } catch (error) {
      if (error.state !== 'upload_incomplete') throw error;
    }
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': mime || 'application/octet-stream' }
    });
    if (!response.ok) throw new Error('Falha no reenvio (PUT ' + response.status + ')');
    item.stage = 'register';
    await updatePendingUpload(item);
    await register();
  });
}

// ---------------------------------------------------------------------------
// Background Sync: processa a fila quando o navegador volta online
// ---------------------------------------------------------------------------
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) event.waitUntil(processUploadQueue());
});

async function processUploadQueue() {
  let items;
  try { items = await getPendingUploads(); } catch (e) { return; }
  let firstFailure = null;
  for (const item of items) {
    try {
      await replayUpload(item);
      await removePendingUpload(item.id);
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      // Não divulgar nome, sala ou dono da fila a outras sessões abertas na mesma origem.
      clients.forEach(c => c.postMessage({ type: 'fs-upload-done', id: item.id }));
    } catch (err) {
      console.warn('[SW] Upload falhou, mantendo na fila:', item.id, err.message);
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach(c => c.postMessage({ type: 'fs-upload-failed', id: item.id }));
      firstFailure = firstFailure || err;
    }
  }
  // Rejeitar o evento de Sync solicita nova tentativa, mas só após tentar os
  // demais itens para que uma entrada antiga/com problema não bloqueie a fila.
  if (firstFailure) throw firstFailure;
}

// ---------------------------------------------------------------------------
// Mensagens do cliente: enfileirar upload para segundo plano
// ---------------------------------------------------------------------------
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'fs-process-uploads') {
    event.waitUntil(processUploadQueue());
    return;
  }
  if (!event.data || event.data.type !== 'fs-enqueue-upload') return;
  const { item, buffer } = event.data;
  const port = event.ports && event.ports[0];
  // Recria o Blob a partir do ArrayBuffer transferido
  if (buffer) item.file = new Blob([buffer], { type: (item.file && item.file.type) || 'application/octet-stream' });
  if (!item.ownerId || !item.pathname || !['presigned', 'multipart'].includes(item.kind) ||
      (item.stage === 'upload' && item.kind === 'presigned' && (!buffer || !item.uploadUrl)) ||
      !['upload', 'register', 'message', 'complete'].includes(item.stage)) {
    if (port) port.postMessage({ type: 'fs-enqueue-error', error: 'Dados insuficientes para salvar o upload pendente.' });
    return;
  }
  const enqueuePromise = openUploadsDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const req = tx.objectStore(DB_STORE).add(item);
    let newId;
    req.onsuccess = () => { newId = req.result; };
    tx.oncomplete = () => resolve(newId);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Falha ao salvar upload na fila.'));
  })).then(newId => {
    item.id = newId;
    if (port) port.postMessage({ type: 'fs-enqueued', id: newId });
    self.registration.sync.register(SYNC_TAG).catch(err => {
      console.warn('[SW] Background Sync indisponível; tentando processar a fila:', err);
      processUploadQueue().catch(error => console.warn('[SW] Fila mantida para nova tentativa:', error));
    });
  }).catch(err => {
    console.warn('[SW] Não foi possível enfileirar upload:', err);
    if (port) port.postMessage({ type: 'fs-enqueue-error', error: String(err) });
  });
  event.waitUntil(enqueuePromise);
});

// ---------------------------------------------------------------------------
// Push: esqueleto (ativa com VAPID no servidor futuramente)
// ---------------------------------------------------------------------------
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'FileShare';
  const options = {
    body: data.body || 'Você tem uma nova notificação.',
    icon: '/favicon-48.png',
    badge: '/favicon-48.png',
    dir: 'auto',
    lang: 'pt-BR',
    data: data.url || '/'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url === self.location.origin + url) { return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

console.log('[SW] Service Worker ativo (v' + CACHE_NAME + ')');

