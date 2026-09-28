// Only the app shell is cached. No songs, audio, credentials or API responses.
const CACHE = 'screwshop-shell-v11';
const SHELL = ['/sampler.js', '/sampler.css', '/studio-workspace.js', '/notepad.js', '/recording-studio.js', '/assets/purple-angel.png', '/studio.css', '/assets/trill.png', '/barwork', '/local-client.js', '/support.js', '/vendor/react.production.min.js', '/vendor/react-dom.production.min.js', '/vendor/tone.js', '/rhyme-engine.js', '/slang-overlay.json', '/manifest.webmanifest', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/screwshop.png', '/_ds/modernist-f96d09d9-5145-4426-9bcd-92e8738bf153/styles.css', '/_ds/modernist-f96d09d9-5145-4426-9bcd-92e8738bf153/_ds_bundle.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('screwshop-shell-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request)));
});
