// ===== Service Worker: 全アセットをキャッシュしてオフライン動作を保証 =====
const CACHE = 'pdf-editor-pro-v1';
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

// キャッシュ優先 + ネットワークフォールバック(取得できたものは追記キャッシュ)
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
