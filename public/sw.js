// ============================================================================
// FileShare — Service Worker
//  • Cache offline de assets estáticos (estratégia cache-first)
//  • HTML/API: network-first com fallback em cache
//  • Background Sync: fila de uploads em IndexedDB processada quando volta online
//  • Push: esqueleto pronto para notificações push
// ============================================================================
'use strict';

const CACHE_NAME = 'fileshare-v1';
const ASSETS = [
  '/',
  '/dashboard',
  '/css/style.css?v=20261014o',
  '/css/mobile.css?v=20261014o',
  '/css/adaptive.css?v=20261014b',
  '/css/mobile-scroll-fix.css?v=20261014o',
  '/css/fx.css?v=20261014o',
  '/css/preview.css?v=20261014o',
  '/css/hacker-ui.css?v=20261014o',
  '/js/common.js?v=20261014o',
  '/js/adaptive.js?v=20261014a',
  '/js/mobile.js?v=20261014o',
  '/js/gfx.js?v=20261014p',
  '/js/fx.js?v=20261014o',
  '/js/upload.js?v=20261014o',
  '/js/social.js?v=20261014o',
  '/js/personal.js?v=20261014o',
  '/js/cursor.js?v=20261014o',
  '/js/preview.js?v=20261014o',
  '/js/collections.js?v=20261014o',
  '/js/library.js?v=20261014o',
  '/js/dashboard-shell.js?v=20261014o',
  '/js/announce.js?v=20261014o',
  '/js/cyber.js?v=20261014o',
  '/manifest.json',
  '/favicon.png',
  '/favicon-48.png',
  '/apple-touch-icon.png'
];

const API_PREFIX = '/api/';
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
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(err => {
      console.warn('[SW] Falha ao cachear alguns assets:', err);
    }))
  );
});

// ---------------------------------------------------------------------------
// Ativação: remove caches antigos
// ---------------------------------------------------------------------------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
// ---------------------------------------------------------------------------
// Requisições: cache-first para assets, network-first para API/HTML
// ---------------------------------------------------------------------------
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith('http')) return;
  if (ASSETS.includes(url.pathname) || url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached || fetch(event.request).then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return resp;
        }).catch(() => caches.match(event.request))
      )
    );
    return;
  }
  if (event.request.method === 'GET') {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }
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
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// ---------------------------------------------------------------------------
// Reenvia um upload pendente (presigned URL ou legacy multipart)
// ---------------------------------------------------------------------------
function replayUpload(item) {
  const { kind, roomId, file, pathname, name, size, mime } = item;
  if (kind === 'presigned' && pathname) {
    return fetch(pathname, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': mime || 'application/octet-stream' }
    }).then(resp => {
      if (!resp.ok) throw new Error('Falha no reenvio (PUT ' + resp.status + ')');
      return fetch('/api/rooms/' + encodeURIComponent(roomId) + '/files/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pathname, name, size, mime, chat_only: item.chatOnly ? 1 : 0 })
      });
    });
  }
  const form = new FormData();
  form.append('files', file);
  return fetch('/api/rooms/' + encodeURIComponent(roomId) + '/files', { method: 'POST', body: form });
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
  for (const item of items) {
    try {
      await replayUpload(item);
      await removePendingUpload(item.id);
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach(c => c.postMessage({ type: 'fs-upload-done', id: item.id, name: item.name }));
    } catch (err) {
      console.warn('[SW] Upload falhou, mantendo na fila:', item.id, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Mensagens do cliente: enfileirar upload para segundo plano
// ---------------------------------------------------------------------------
self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'fs-enqueue-upload') return;
  const { item, buffer } = event.data;
  const port = event.ports && event.ports[0];
  // Recria o Blob a partir do ArrayBuffer transferido
  item.file = new Blob([buffer], { type: (item.file && item.file.type) || 'application/octet-stream' });
  openUploadsDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const req = tx.objectStore(DB_STORE).add(item);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  })).then(newId => {
    item.id = newId;
    if (port) port.postMessage({ type: 'fs-enqueued', id: newId });
    self.registration.sync.register(SYNC_TAG).catch(() => {});
  }).catch(err => {
    console.warn('[SW] Não foi possível enfileirar upload:', err);
    if (port) port.postMessage({ type: 'fs-enqueue-error', error: String(err) });
  });
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

