// Runs Tesseract.js (v5) fully locally in WASM: no CDN, no server, $0 cost.
let worker = null;
let workerKey = null;

async function getWorker(langs) {
  const key = langs.join('+');
  if (worker && workerKey === key) return worker;
  if (worker) { await worker.terminate(); worker = null; }
  worker = await Tesseract.createWorker(langs, 1, {
    workerPath: chrome.runtime.getURL('vendor/worker.min.js'),
    corePath: chrome.runtime.getURL('vendor/'),
    langPath: chrome.runtime.getURL('vendor/lang'),
    workerBlobURL: false,
    gzip: true
  });
  workerKey = key;
  return worker;
}

// Upscale small images + grayscale/contrast: cheap preprocessing that helps small manga text.
async function prepare(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = bmp.width < 1400 ? Math.min(3, 1400 / bmp.width) : 1;
  const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const g = c.getContext('2d');
  g.filter = 'grayscale(1) contrast(1.25)';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const out = await c.convertToBlob({ type: 'image/png' });
  bmp.close();
  return { blob: out, scale };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'ES_OCR_RUN') return;
  (async () => {
    try {
      const r = await fetch(msg.src); // cross-origin OK via host_permissions
      if (!r.ok) throw new Error('fetch failed ' + r.status);
      const { blob, scale } = await prepare(await r.blob());
      const w = await getWorker(msg.langs?.length ? msg.langs : ['eng']);
      await w.setParameters({ tessedit_pageseg_mode: String(msg.psm || '11') });
      const { data } = await w.recognize(blob);
      const lines = (data.lines || [])
        .filter(l => l.text.trim() && l.confidence > 35)
        .map(l => ({
          text: l.text.trim(),
          conf: l.confidence,
          // back to the ORIGINAL image's natural pixel space
          bbox: { x0: l.bbox.x0 / scale, y0: l.bbox.y0 / scale, x1: l.bbox.x1 / scale, y1: l.bbox.y1 / scale }
        }));
      sendResponse({ ok: true, lines });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
