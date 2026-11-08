// EyeSee content script: find images -> OCR -> merge lines into bubbles -> translate -> overlay in the user's target language.
(() => {
  if (window.__eyesee_loaded) return;
  // Sub-frames: run only inside the EyeSee in-app browser (its extension page is the top frame).
  const ao = location.ancestorOrigins;
  const inViewer = !!ao && ao.length > 0 && ao[ao.length - 1] === 'chrome-extension://' + chrome.runtime.id;
  if (window !== window.top && !inViewer) return;
  window.__eyesee_loaded = true;
  if (inViewer && ao.length === 1) {            // direct child of the viewer: keep its address bar in sync
    let last = '';
    const report = () => {
      if (location.href === last) return;
      const navigated = !!last; last = location.href;
      chrome.runtime.sendMessage({ type: 'ES_FRAME_URL', url: location.href, title: document.title, navigated }).catch(() => {});
    };
    report(); setInterval(report, 1000);
  }

  const MIN_SIZE = 120;
  const SITE_ORIGINS = self.ES_CONFIG.SITE_ORIGINS;   // from config.js
  const RTL = new Set(['ar', 'he', 'fa', 'ur']);   // right-to-left target languages
  let target = 'ar';                               // user-selected target (BCP-47), set from popup

  // Source profiles. psm 11 = sparse text (best general choice for speech bubbles).
  const PROFILES = {
    auto:       { langs: ['eng', 'jpn'],        psm: '11', force: null },
    en:         { langs: ['eng'],               psm: '11', force: 'en' },
    ja:         { langs: ['jpn'],               psm: '11', force: 'ja' },
    'ja-manga': { langs: ['jpn_vert', 'jpn'],   psm: '11', force: 'ja' },
    ko:         { langs: ['kor'],               psm: '11', force: 'ko' },
    zh:         { langs: ['chi_sim'],           psm: '11', force: 'zh' },
    'zh-Hant':  { langs: ['chi_tra'],           psm: '11', force: 'zh-Hant' }
  };

  let settings = { src: 'auto', auto: false, target: 'ar' };
  const done = new WeakSet();
  const items = [];             // {el, img, box}
  const queue = [];
  let pumping = false;

  chrome.storage.local.get({ src: 'auto', auto: false, target: 'ar' }).then(s => { settings = s; target = s.target; applyAuto(); });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.src) settings.src = ch.src.newValue;
    if (ch.auto) { settings.auto = ch.auto.newValue; applyAuto(); }
    if (ch.target) { target = settings.target = ch.target.newValue; warnedPack = false; retranslateAll(); }
  });

  // ---------- helpers ----------
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/;
  const hasContent = (t) => /[\p{L}\p{N}]/u.test(t);
  const isEligible = (img) => {
    const r = img.getBoundingClientRect();
    return img.complete && img.naturalWidth > 0 && r.width >= MIN_SIZE && r.height >= MIN_SIZE && !done.has(img);
  };

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'eyesee-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // ---------- merge OCR lines into bubbles ----------
  function mergeLines(lines) {
    const n = lines.length;
    const parent = [...Array(n).keys()];
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const dim = (b) => Math.min(b.x1 - b.x0, b.y1 - b.y0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = lines[i].bbox, b = lines[j].bbox;
        const gap = 0.8 * Math.min(dim(a), dim(b)) + 6;
        const overlap = a.x0 - gap < b.x1 && a.x1 + gap > b.x0 && a.y0 - gap < b.y1 && a.y1 + gap > b.y0;
        if (overlap) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    lines.forEach((l, i) => {
      const k = find(i);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    });
    return [...groups.values()].map(g => {
      const box = {
        x0: Math.min(...g.map(l => l.bbox.x0)), y0: Math.min(...g.map(l => l.bbox.y0)),
        x1: Math.max(...g.map(l => l.bbox.x1)), y1: Math.max(...g.map(l => l.bbox.y1))
      };
      const vertical = g.filter(l => (l.bbox.y1 - l.bbox.y0) > 1.5 * (l.bbox.x1 - l.bbox.x0)).length > g.length / 2;
      // Reading order: vertical manga = right-to-left columns; otherwise top-to-bottom.
      g.sort((a, b) => vertical ? b.bbox.x0 - a.bbox.x0 : a.bbox.y0 - b.bbox.y0);
      let text = g.map(l => l.text).join('\n');
      text = CJK.test(text) ? text.replace(/\s+/g, '') : text.replace(/\s+/g, ' ').trim();
      return { box, text };
    }).filter(b => b.text.length >= 2 && hasContent(b.text));
  }

  // ---------- translation (Chrome on-device Translator API) ----------
  const translators = new Map();
  const textCache = new Map();
  let warnedPack = false;

  async function getTranslator(s, t) {
    const key = s + '>' + t;
    if (translators.has(key)) return translators.get(key);
    let tr = null;
    try {
      if (!('Translator' in self)) throw new Error('no Translator API');
      const av = await Translator.availability({ sourceLanguage: s, targetLanguage: t });
      if (av !== 'unavailable') tr = await Translator.create({ sourceLanguage: s, targetLanguage: t });
    } catch (e) {
      if (!warnedPack) { warnedPack = true; toast('EyeSee: open the extension popup and click "Prepare language packs" first / افتح الإضافة واضغط «تجهيز حزم اللغة»'); }
    }
    translators.set(key, tr);
    return tr;
  }

  async function translateText(text, from) {
    const ck = from + '>' + target + '|' + text;
    if (textCache.has(ck)) return textCache.get(ck);
    let out = null;
    const direct = await getTranslator(from, target);
    if (direct) out = await direct.translate(text);
    else if (from !== 'en' && target !== 'en') {    // pivot: from -> en -> target
      const a = await getTranslator(from, 'en');
      const b = a && await getTranslator('en', target);
      if (a && b) out = await b.translate(await a.translate(text));
    }
    textCache.set(ck, out);
    return out;
  }

  // ---------- overlay ----------
  function fit(el, h) {
    let fs = Math.max(9, Math.min(26, h * 0.6));
    el.style.fontSize = fs + 'px';
    for (let i = 0; i < 18 && fs > 8 && el.scrollHeight > el.clientHeight + 1; i++) {
      fs -= 1; el.style.fontSize = fs + 'px';
    }
  }

  function place(it) {
    if (it.hidden) { it.el.style.display = 'none'; return; }
    const r = it.img.getBoundingClientRect();
    if (!r.width || !r.height) { it.el.style.display = 'none'; return; }
    const sx = r.width / it.img.naturalWidth, sy = r.height / it.img.naturalHeight;
    const pad = 3, b = it.box;
    const h = (b.y1 - b.y0) * sy + pad * 2;
    Object.assign(it.el.style, {
      display: 'block',
      left: (r.left + scrollX + b.x0 * sx - pad) + 'px',
      top: (r.top + scrollY + b.y0 * sy - pad) + 'px',
      width: ((b.x1 - b.x0) * sx + pad * 2) + 'px',
      height: h + 'px'
    });
    fit(it.el, h);
  }

  function addOverlay(img, box, text, translated, from) {
    const el = document.createElement('div');
    el.className = 'eyesee-overlay' + (translated ? '' : ' eyesee-untranslated');
    el.dir = translated ? (RTL.has(target) ? 'rtl' : 'ltr') : 'auto';
    el.textContent = translated || text;
    el.title = text; // original text on hover
    document.body.appendChild(el);
    const it = { el, img, box, text, from, hidden: false };
    items.push(it);
    place(it);
  }

  // Live target switch: re-translate existing overlays from their stored source text (no new OCR).
  async function retranslateAll() {
    for (const it of [...items]) {
      if (!it.el.isConnected) continue;
      it.hidden = it.from === target;           // text already in the new target language
      if (!it.hidden) {
        let t = null;
        try { t = await translateText(it.text, it.from); } catch (e) { /* keep original */ }
        it.el.textContent = t || it.text;
        it.el.className = 'eyesee-overlay' + (t ? '' : ' eyesee-untranslated');
        it.el.dir = t ? (RTL.has(target) ? 'rtl' : 'ltr') : 'auto';
      }
      place(it);
    }
  }

  function clearAll() {
    items.forEach(i => i.el.remove());
    items.length = 0;
  }

  let raf = 0;
  const replaceAll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => items.forEach(place)); };
  window.addEventListener('resize', replaceAll);
  new ResizeObserver(replaceAll).observe(document.documentElement);

  // ---------- pipeline ----------
  async function processImage(img) {
    done.add(img);
    const p = PROFILES[settings.src] || PROFILES.auto;
    const res = await chrome.runtime.sendMessage({
      type: 'ES_OCR_REQUEST', src: img.currentSrc || img.src, langs: p.langs, psm: p.psm
    });
    if (!res?.ok) {
      const msgs = {
        login_required: 'EyeSee: سجّل الدخول من الموقع لبدء التجربة المجانية',
        subscription_required: 'EyeSee: انتهت التجربة المجانية. اشترك من الموقع للمتابعة',
        offline: 'EyeSee: تعذّر التحقق من الاشتراك. تحقق من الاتصال'
      };
      if (msgs[res?.error]) toast(msgs[res.error]);
      else console.warn('[EyeSee] OCR failed:', res?.error);
      done.delete(img);
      return;
    }
    for (const b of mergeLines(res.lines)) {
      const from = p.force || (CJK.test(b.text) ? 'ja' : 'en');
      if (from === target) continue;               // already in the user's language
      let translated = null;
      try { translated = await translateText(b.text, from); } catch (e) { console.warn('[EyeSee] translate failed', e); }
      addOverlay(img, b.box, b.text, translated, from);
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const img = queue.shift();
      if (isEligible(img)) await processImage(img);
    }
    pumping = false;
  }

  function enqueue(img) {
    if (done.has(img) || queue.includes(img)) return;
    if (img.complete) { queue.push(img); pump(); }
    else img.addEventListener('load', () => enqueue(img), { once: true });
  }

  function scanPage() {
    const imgs = [...document.images].filter(isEligible);
    toast(imgs.length ? `EyeSee: جارٍ فحص ${imgs.length} صورة…` : 'EyeSee: لا توجد صور مناسبة');
    imgs.forEach(enqueue);
  }

  // ---------- auto mode: lazy-loaded images ----------
  let io = null, mo = null;
  function applyAuto() {
    if (settings.auto && !io) {
      io = new IntersectionObserver((es) => es.forEach(e => {
        if (e.isIntersecting) { io.unobserve(e.target); enqueue(e.target); }
      }), { rootMargin: '200px' });
      const watch = (img) => { if (img.tagName === 'IMG' && !done.has(img)) io.observe(img); };
      document.images && [...document.images].forEach(watch);
      mo = new MutationObserver((muts) => muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'IMG') watch(n);
        else n.querySelectorAll?.('img').forEach(watch);
      })));
      mo.observe(document.body, { childList: true, subtree: true });
    } else if (!settings.auto && io) {
      io.disconnect(); mo.disconnect(); io = mo = null;
    }
  }


  // Website <-> extension bridge: only active on the EyeSee site itself.
  if (SITE_ORIGINS.includes(location.origin)) {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (e.source !== window || d?.source !== 'eyesee-site') return;
      if (d.type === 'ES_OPEN_URL') {
        chrome.runtime.sendMessage({ type: 'ES_OPEN_URL', url: d.url, scan: !!d.scan });
        window.postMessage({ source: 'eyesee-ext', type: 'ES_ACK' }, '*');
      } else if (d.type === 'ES_SET_TOKEN') {
        chrome.runtime.sendMessage({ type: 'ES_SET_TOKEN', token: d.token });
      }
    });
    window.postMessage({ source: 'eyesee-ext', type: 'ES_READY' }, '*'); // lets the site re-send its token
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ES_SCAN_PAGE') scanPage();
    if (msg?.type === 'ES_CLEAR') { clearAll(); queue.length = 0; }
    if (msg?.type === 'ES_HISTORY' && window !== window.top) { msg.dir === 0 ? location.reload() : history.go(msg.dir); }
  });
})();
