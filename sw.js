// Service Worker for offline app assets.
// App shell is network-first; explicit vendor assets are cache-first.
const CACHE = 'pdf-editor-pro-v5';
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
  './vendor/fonts/ipaexg.ttf',
  './vendor/tessdata/eng.traineddata.gz', './vendor/tessdata/jpn.traineddata.gz',
  './vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract-core/tesseract-core-simd-lstm.wasm',
  './vendor/tesseract-core/tesseract-core-simd.wasm.js',
  './vendor/tesseract-core/tesseract-core-simd.wasm',
  './vendor/tesseract-core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract-core/tesseract-core-lstm.wasm',
  './vendor/tesseract-core/tesseract-core.wasm.js',
  './vendor/tesseract-core/tesseract-core.wasm',
  './vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  './vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm',
  './vendor/tesseract-core/tesseract-core-relaxedsimd.wasm.js',
  './vendor/tesseract-core/tesseract-core-relaxedsimd.wasm',
];

const normalizedAssetPaths = new Set(
  ASSETS.map(asset => new URL(asset, self.location.href).pathname)
);
const vendorCachePaths = new Set(
  [...normalizedAssetPaths].filter(path => path.startsWith('/vendor/'))
);

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

  const isAppAsset = normalizedAssetPaths.has(url.pathname);
  const isVendorAsset = vendorCachePaths.has(url.pathname);
  if (!isAppAsset && !isVendorAsset) return;

  const cachePut = res => {
    if (res && res.ok) {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
    }
    return res;
  };

  if (isVendorAsset) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(cachePut))
    );
    return;
  }

  e.respondWith(
    fetch(e.request).then(cachePut).catch(() => caches.match(e.request))
  );
});
