const $ = (id) => document.getElementById(id);

chrome.storage.local.get({ src: 'auto', auto: false, target: 'ar' }).then(s => {
  $('target').value = s.target;
  $('src').value = s.src;
  $('auto').checked = s.auto;
});
$('target').addEventListener('change', () => chrome.storage.local.set({ target: $('target').value }));
$('src').addEventListener('change', () => chrome.storage.local.set({ src: $('src').value }));
$('auto').addEventListener('change', () => chrome.storage.local.set({ auto: $('auto').checked }));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
$('scan').addEventListener('click', async () => {
  const t = await activeTab();
  chrome.tabs.sendMessage(t.id, { type: 'ES_SCAN_PAGE' }).catch(() => ($('status').textContent = 'أعد تحميل الصفحة ثم حاول مجدداً.'));
});
$('openViewer').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'ES_OPEN_VIEWER' }));
$('clear').addEventListener('click', async () => {
  const t = await activeTab();
  chrome.tabs.sendMessage(t.id, { type: 'ES_CLEAR' }).catch(() => {});
});

// Language-pack download needs a user gesture, so it lives here (button click).
$('prep').addEventListener('click', async () => {
  const st = $('status');
  if (!('Translator' in self)) { st.textContent = 'متصفحك لا يدعم Translator API (يتطلب Chrome 138+).'; return; }
  const t0 = $('target').value;
  // direct pairs into the chosen target + ja->en as the pivot fallback; skip pairs where source == target
  const pairs = [['ja', t0], ['en', t0], ['ja', 'en']]
    .filter(([s, t], i, a) => s !== t && a.findIndex(([s2, t2]) => s2 === s && t2 === t) === i);
  st.textContent = '';
  for (const [s, t] of pairs) {
    try {
      const av = await Translator.availability({ sourceLanguage: s, targetLanguage: t });
      if (av === 'unavailable') { st.textContent += `${s}→${t}: غير متاح\n`; continue; }
      await Translator.create({
        sourceLanguage: s, targetLanguage: t,
        monitor(m) { m.addEventListener('downloadprogress', e => { st.textContent = `تنزيل ${s}→${t}: ${Math.round(e.loaded * 100)}%`; }); }
      });
      st.textContent += `${s}→${t}: جاهز ✓\n`;
    } catch (e) { st.textContent += `${s}→${t}: فشل (${e.name})\n`; }
  }
});

chrome.runtime.sendMessage({ type: 'ES_GET_ACCESS' }).then(a => {
  if (!a) return;
  const plan = $('plan');
  if (a.error === 'login_required') {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = 'سجّل الدخول لبدء التجربة المجانية';
    b.onclick = () => chrome.tabs.create({ url: ES_CONFIG.SITE_URL });
    plan.replaceChildren(b);
    return;
  }
  plan.textContent = a.plan === 'paid' ? 'الخطة: مدفوعة'
    : a.ok ? `التجربة المجانية: متبقي ${Math.ceil(a.msLeft / 3600000)} ساعة`
    : a.error === 'offline' ? 'تعذّر التحقق من الاشتراك (لا اتصال)'
    : 'انتهت التجربة. اشترك من الموقع للمتابعة.';
});
