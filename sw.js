// ===== Service Worker: 全アセットをキャッシュしてオフライン動作を保証 =====
// 戦略: アプリ本体(js/css/html)はネットワーク優先(更新を確実に反映)、
//       vendor/(大容量・不変)はキャッシュ優先。どちらもオフライン時はキャッシュで動作。
const CACHE = 'pdf-editor-pro-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/main.js', './js/state.js', './js/utils.js', './js/viewer.js',
  './js/organize.js', './js/annotate.js', './js/edit.js', './js/convert.js',
  './js/ocr.js', './js/compare.js', './js/protect.js',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './vendor/pdf-lib.min.js', './vendor/fontkit.umd.min.js',
  './vendor/jszip.min.js', './vendor/pixelmatch.mjs',
  './vendor/tesseract.min.js', './vendor/tesseract.worker.min.js',
  './vendor/mammoth.browser.min.js', './vendor/xlsx.full.min.js',
  './vendor/docx.iife.js', './vendor/pptxgen.bundle.js',
  './vendor/fonts/NotoSansJP-Regular.ttf',
  './vendor/tessdata/eng.traineddata.gz', './vendor/tessdata/jpn.traineddata.gz',
  // Tesseractコア(SIMD対応版を優先的に使用)
  './vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract-core/tesseract-core-simd.wasm.js',
  './vendor/tesseract-core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract-core/tesseract-core.wasm.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
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

  const cachePut = res => {
    if (res && res.ok) {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
    }
    return res;
  };

  if (url.pathname.includes('/vendor/')) {
    // vendor: キャッシュ優先(不変・大容量)
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(cachePut))
    );
  } else {
    // アプリ本体: ネットワーク優先(修正の即時反映)、オフライン時はキャッシュ
    e.respondWith(
      fetch(e.request).then(cachePut).catch(() => caches.match(e.request))
    );
  }
});
