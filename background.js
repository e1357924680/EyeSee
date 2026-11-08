// EyeSee background service worker: message router, offscreen OCR owner, server-verified licence gate.
importScripts('config.js');
const CONFIG = self.ES_CONFIG;
const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL, reasons: ['WORKERS'], justification: 'Run Tesseract.js (WASM) OCR on-device'
  });
}

// ---- Licence: the server decides (trial / paid). Local cache only avoids calling it on every image. ----
async function checkAccess(force = false) {
  const { extToken, licCache } = await chrome.storage.local.get(['extToken', 'licCache']);
  if (!extToken) return { ok: false, error: 'login_required' };
  const now = Date.now();
  if (!force && licCache) {
    const ttl = licCache.res.ok ? CONFIG.LICENSE_RECHECK_MS : 60 * 1000; // re-check denials quickly (user may have just paid)
    if (now - licCache.at < ttl) return licCache.res;
  }
  try {
    const r = await fetch(CONFIG.API_BASE + '/license', { headers: { Authorization: 'Bearer ' + extToken } });
    if (r.status === 401) { await chrome.storage.local.remove(['extToken', 'licCache']); return { ok: false, error: 'login_required' }; }
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (j.token) await chrome.storage.local.set({ extToken: j.token }); // server renews the token near expiry
    const res = { ok: !!j.ok, plan: j.plan, msLeft: j.msLeft, error: j.ok ? undefined : 'subscription_required' };
    await chrome.storage.local.set({ licCache: { at: now, res } });
    return res;
  } catch {
    if (licCache?.res.ok && now - licCache.at < CONFIG.OFFLINE_GRACE_MS) return licCache.res;
    return { ok: false, error: 'offline' };
  }
}

// EyeSee in-app browser (extension page hosting the site in an iframe)
function openViewer(url, scan) {
  const q = url ? '?u=' + encodeURIComponent(url) + '&scan=' + (scan ? 1 : 0) : '';
  return chrome.tabs.create({ url: chrome.runtime.getURL('browser.html') + q });
}
// Remove the per-tab header rule when a viewer tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
});

// Keyboard shortcut -> scan current tab
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-eyesee') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'ES_SCAN_PAGE' }).catch(() => {});
});

const fromSite = (sender) => { try { return CONFIG.SITE_ORIGINS.includes(new URL(sender.url).origin); } catch { return false; } };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return; // not for us

  // Website -> extension: store / clear the licence token issued by the EyeSee API
  if (msg?.type === 'ES_SET_TOKEN') {
    if (!fromSite(sender)) return;
    (msg.token && typeof msg.token === 'string'
      ? chrome.storage.local.set({ extToken: msg.token }).then(() => chrome.storage.local.remove('licCache'))
      : chrome.storage.local.remove(['extToken', 'licCache']));
    return;
  }

  // Website -> extension: open a URL in a new tab and auto-translate it (http/https only)
  if (msg?.type === 'ES_OPEN_URL') {
    try {
      if (!fromSite(sender)) return;
      if (!/^https?:$/.test(new URL(msg.url).protocol)) return;
    } catch { return; }
    openViewer(msg.url, !!msg.scan);
    return;
  }

  if (msg?.type === 'ES_OPEN_VIEWER') { openViewer(); return; }

  if (msg?.type === 'ES_GET_ACCESS') { checkAccess(true).then(sendResponse); return true; }

  if (msg?.type === 'ES_OCR_REQUEST') {
    (async () => {
      try {
        const access = await checkAccess();
        if (!access.ok) return sendResponse({ ok: false, error: access.error });
        await ensureOffscreen();
        sendResponse(await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'ES_OCR_RUN', src: msg.src, langs: msg.langs, psm: msg.psm
        }));
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
    })();
    return true;
  }
});
