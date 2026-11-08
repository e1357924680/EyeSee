// EyeSee shared config: loaded by the service worker (importScripts), content script and popup.
// FILL THESE IN before packaging (see SETUP.md).
self.ES_CONFIG = {
  SITE_URL: 'https://eyesee.example',                          // your website (no trailing slash)
  SITE_ORIGINS: ['https://eyesee.example', 'http://localhost:8080'],  // origins allowed to talk to the extension
  API_BASE: 'https://eyesee-api.YOUR-SUBDOMAIN.workers.dev',   // the Cloudflare Worker URL
  LICENSE_RECHECK_MS: 6 * 3600 * 1000,                         // re-verify a valid licence every 6h
  OFFLINE_GRACE_MS: 72 * 3600 * 1000                           // keep working this long if the API is unreachable
};
