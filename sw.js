/* OLS service worker — exists to make the app installable.
   Performs NO caching: every request goes to the network so deployed updates
   load immediately (the app manages its own versioned assets). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* default network handling */ });
