/* Стенограф — service worker: офлайн-оболочка */
'use strict';

const CACHE = 'stenograf-v1';
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './db.js',
  './annot.js',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // network-first (с ревалидацией HTTP-кеша): свежая версия при наличии сети, кеш — офлайн
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(resp => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return resp;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || caches.match('./index.html'))
    )
  );
});
