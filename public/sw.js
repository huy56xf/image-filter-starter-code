/*
 * Service worker: lưu sẵn toàn bộ ứng dụng để mở được khi không có mạng
 * (mọi xử lý ảnh đều chạy trên máy, không cần server).
 * Đổi VERSION mỗi khi phát hành bản mới để điện thoại tải lại.
 */
var VERSION = 'scanner-v4';
var FILES = [
  './', 'index.html', 'manifest.webmanifest',
  'css/app.css', 'js/scanner-core.js', 'js/pdf.js', 'js/app.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Mạng trước (để luôn có bản mới khi online), rớt mạng thì dùng bản đã lưu.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('index.html'); });
  }));
});
