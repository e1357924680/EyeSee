// EyeSee in-app browser: an extension page that hosts the site in an iframe.
// Frame-blocking headers are removed ONLY for sub-frames of this tab (session rule), so the site loads inside
// the viewer, and the EyeSee content script (all_frames) can OCR and draw overlays in it. No proxy, no server.
const CONFIG = self.ES_CONFIG;
const $ = (id) => document.getElementById(id);
const SRC = [['auto','تلقائي'],['en','English'],['ja','日本語'],['ja-manga','日本語 مانجا'],['ko','한국어'],['zh','中文 简'],['zh-Hant','中文 繁']];
const TGT = [['ar','العربية'],['he','עברית'],['en','English'],['zh','中文 简'],['zh-Hant','中文 繁'],['es','Español'],['fr','Français'],['de','Deutsch'],['ru','Русский'],['tr','Türkçe'],['hi','हिन्दी'],['pt','Português'],['it','Italiano'],['id','Indonesia'],['ko','한국어'],['ja','日本語']];
const fill = (el, list) => list.forEach(([v, l]) => el.append(new Option(l, v)));
fill($('src'), SRC); fill($('target'), TGT);

let tabId = null, childFrameId = null, scanOnLoad = false;

function resolve(q) {
  q = (q || '').trim();
  if (!q) return null;
  if (/^https?:\/\//i.test(q)) { try { return { url: new URL(q).href, scan: true }; } catch { return null; } }
  if (!/\s/.test(q) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q)) return { url: 'https://' + q, scan: true };
  return { url: 'https://www.google.com/search?q=' + encodeURIComponent(q), scan: false };
}

async function setup() {
  const tab = await chrome.tabs.getCurrent();
  tabId = tab.id;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId, priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'content-security-policy-report-only', operation: 'remove' }
      ] },
      condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] }
    }]
  });
  const s = await chrome.storage.local.get({ src: 'auto', target: 'ar', viewerAuto: true });
  $('src').value = s.src; $('target').value = s.target; $('autoLoad').checked = s.viewerAuto;
  const p = new URLSearchParams(location.search);
  if (p.get('u')) open(p.get('u'), p.get('scan') === '1');
  else $('addr').focus();
}

function open(q, scan) {
  const r = resolve(q);
  if (!r) { $('msg').textContent = 'اكتب رابطاً أو كلمات للبحث.'; return; }
  scanOnLoad = scan ?? r.scan;
  $('addr').value = r.url;
  $('empty').hidden = true; $('frame').hidden = false;
  $('msg').textContent = '…';
  $('frame').src = r.url;
}

$('frame').addEventListener('load', () => {
  $('msg').textContent = '';
  if ($('autoLoad').checked && scanOnLoad) setTimeout(scan, 900);
});
const scan = () => chrome.tabs.sendMessage(tabId, { type: 'ES_SCAN_PAGE' }).catch(() => {});
const toFrame = (m) => childFrameId != null && chrome.tabs.sendMessage(tabId, m, { frameId: childFrameId }).catch(() => {});

$('go').onclick = () => open($('addr').value);
$('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') open($('addr').value); });
$('back').onclick = () => toFrame({ type: 'ES_HISTORY', dir: -1 });
$('fwd').onclick = () => toFrame({ type: 'ES_HISTORY', dir: 1 });
$('reload').onclick = () => toFrame({ type: 'ES_HISTORY', dir: 0 });
$('scan').onclick = scan;
$('clear').onclick = () => chrome.tabs.sendMessage(tabId, { type: 'ES_CLEAR' }).catch(() => {});
$('src').onchange = () => chrome.storage.local.set({ src: $('src').value });
$('target').onchange = () => chrome.storage.local.set({ target: $('target').value });
$('autoLoad').onchange = () => chrome.storage.local.set({ viewerAuto: $('autoLoad').checked });

// The content script inside the iframe reports its URL so the address bar and back/forward stay in sync.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'ES_FRAME_URL' || sender.tab?.id !== tabId || sender.frameId === 0) return;
  childFrameId = sender.frameId;
  $('addr').value = msg.url;
  document.title = 'EyeSee: ' + (msg.title || msg.url);
  if ($('autoLoad').checked && msg.navigated) { scanOnLoad = true; }
});

setup();
