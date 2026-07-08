// ===== ビューア: pdf.js による連続スクロール表示・サムネイル・ズーム・検索・印刷 =====
import { state, onDocChange } from './state.js';
import { $, $$, setStatus } from './utils.js';

const viewer = () => $('#viewer');
const container = () => $('#viewer-container');

let pageViews = [];        // {wrap, canvas, textLayerDiv, annotLayer, rendered, viewport}
let observer = null;
let textCache = [];        // ページごとの getTextContent キャッシュ
let searchState = { query: '', matches: [], index: -1 };
let renderGeneration = 0;
let zoomGeneration = 0;
let searchGeneration = 0;
let resizeTimer = null;
export let overlayHooks = [];  // 各ページ描画後に呼ばれる (pageIndex, wrap, viewport)

export function addOverlayHook(fn) { overlayHooks.push(fn); }

export function init() {
  onDocChange(refresh);
  container().addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    if (state.zoomMode !== 'fit' && state.zoomMode !== 'width') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => setZoom(state.zoomMode), 150);
  });
}

// ---------- レイアウト ----------
export async function refresh() {
  const generation = ++renderGeneration;
  const v = viewer();
  v.innerHTML = '';
  pageViews = [];
  textCache = [];
  if (observer) observer.disconnect();
  if (!state.pdf) {
    $('#welcome').style.display = '';
    $('#page-count').textContent = '/ 0';
    $('#page-input').value = 1;
    $('#page-input').max = 0;
    $('#zoom-select').value = '1';
    $('#thumbs').innerHTML = '';
    $('#doc-title').textContent = '文書が開かれていません';
    $('#status-file').textContent = '';
    return;
  }
  const pdf = state.pdf;
  $('#welcome').style.display = 'none';
  $('#doc-title').textContent = state.fileName;
  $('#status-file').textContent = `${state.fileName} — ${state.pdf.numPages}ページ`;
  $('#page-count').textContent = `/ ${state.pdf.numPages}`;
  $('#page-input').max = state.pdf.numPages;

  const scale = await effectiveScale(generation);
  if (!isCurrentGeneration(generation, pdf)) return;
  observer = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) renderPage(+e.target.dataset.page, generation);
  }, { root: container(), rootMargin: '600px 0px' });

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    if (!isCurrentGeneration(generation, pdf)) return;
    const viewport = page.getViewport({ scale, rotation: (page.rotate + state.viewRotation) % 360 });
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = i;
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    if (!isCurrentGeneration(generation, pdf)) return;
    v.appendChild(wrap);
    pageViews.push({ wrap, viewport, page, pdf, rendered: false });
    observer.observe(wrap);
  }
  renderThumbs(generation, pdf);
  updatePageUI();
  syncZoomSelect();
  if (searchState.query) runSearch(searchState.query, true);
}

async function effectiveScale(generation = renderGeneration) {
  const pdf = state.pdf;
  if (!pdf) return 1;
  const page = await pdf.getPage(1);
  if (!isCurrentGeneration(generation) || pdf !== state.pdf) return state.zoom;
  const vp = page.getViewport({ scale: 1, rotation: (page.rotate + state.viewRotation) % 360 });
  const cw = container().clientWidth - 48, ch = container().clientHeight - 48;
  if (state.zoomMode === 'fit') state.zoom = Math.min(cw / vp.width, ch / vp.height);
  else if (state.zoomMode === 'width') state.zoom = cw / vp.width;
  return state.zoom;
}

function isCurrentGeneration(generation, pdf = state.pdf) {
  return generation === renderGeneration && pdf === state.pdf;
}

async function renderPage(num, generation = renderGeneration) {
  const pv = pageViews[num - 1];
  if (!pv || pv.rendered || !isCurrentGeneration(generation)) return;
  pv.rendered = true;
  const { page, viewport, wrap, pdf } = pv;
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = viewport.width * ratio;
  canvas.height = viewport.height * ratio;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  wrap.appendChild(canvas);
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
  } catch (e) {
    if (isCurrentGeneration(generation)) setStatus(`ページ${num}の描画に失敗しました: ${e.message}`);
    return;
  }
  if (!isCurrentGeneration(generation)) return;

  // テキストレイヤー(選択・検索用)
  const tl = document.createElement('div');
  tl.className = 'text-layer';
  wrap.appendChild(tl);
  const tc = await getTextContent(num, { pdf });
  if (!isCurrentGeneration(generation)) return;
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const span = document.createElement('span');
    span.textContent = item.str;
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const h = Math.hypot(item.transform[2], item.transform[3]) * viewport.scale;
    span.style.left = `${x}px`;
    span.style.top = `${y - h}px`;
    span.style.fontSize = `${h}px`;
    span.style.fontFamily = 'sans-serif';
    span.dataset.idx = tc.items.indexOf(item);
    if (item.width) {
      span.style.display = 'inline-block';
      span.dataset.w = item.width * viewport.scale;
    }
    tl.appendChild(span);
    // 実測幅に合わせて水平スケール
    const targetW = item.width * viewport.scale;
    if (targetW > 0 && span.offsetWidth > 0) {
      span.style.transform = `scaleX(${targetW / span.offsetWidth})`;
    }
  }

  // 注釈・編集レイヤー用フック
  if (!isCurrentGeneration(generation)) return;
  for (const hook of overlayHooks) hook(num - 1, wrap, viewport);
  if (searchState.query) paintMatchesOnPage(num - 1);
}

export async function getTextContent(pageNum, { pdf = state.pdf } = {}) {
  if (!pdf) throw new Error('PDFが開かれていません。');
  if (pdf === state.pdf) {
    if (!textCache[pageNum - 1]) {
      const page = await pdf.getPage(pageNum);
      textCache[pageNum - 1] = await page.getTextContent();
    }
    return textCache[pageNum - 1];
  }
  const page = await pdf.getPage(pageNum);
  return page.getTextContent();
}

export function getPageView(pageIndex) { return pageViews[pageIndex]; }

// ---------- サムネイル ----------
async function renderThumbs(generation = renderGeneration, pdf = state.pdf) {
  const el = $('#thumbs');
  el.innerHTML = '';
  if (!pdf) return;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    if (!isCurrentGeneration(generation, pdf)) return;
    const vp = page.getViewport({ scale: 130 / page.getViewport({ scale: 1 }).width, rotation: (page.rotate + state.viewRotation) % 360 });
    const div = document.createElement('div');
    div.className = 'thumb' + (i === state.currentPage ? ' current' : '');
    div.dataset.page = i;
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    div.appendChild(c);
    const num = document.createElement('div');
    num.className = 'thumb-num'; num.textContent = i;
    div.appendChild(num);
    div.addEventListener('click', () => gotoPage(i));
    if (!isCurrentGeneration(generation, pdf)) return;
    el.appendChild(div);
    page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.catch(() => {});
  }
}

// ---------- ナビゲーション ----------
export function gotoPage(n) {
  if (!state.pdf) return;
  n = Number.parseInt(n, 10);
  if (!Number.isFinite(n)) {
    updatePageUI();
    return;
  }
  n = Math.max(1, Math.min(state.pdf.numPages, n));
  state.currentPage = n;
  pageViews[n - 1]?.wrap.scrollIntoView({ block: 'start' });
  updatePageUI();
}

function onScroll() {
  if (!pageViews.length) return;
  const mid = container().scrollTop + container().clientHeight / 2;
  let best = 1, bestDist = Infinity;
  for (const pv of pageViews) {
    const center = pv.wrap.offsetTop + pv.wrap.offsetHeight / 2;
    const d = Math.abs(center - mid);
    if (d < bestDist) { bestDist = d; best = +pv.wrap.dataset.page; }
  }
  if (best !== state.currentPage) { state.currentPage = best; updatePageUI(); }
}

function updatePageUI() {
  if (!Number.isFinite(state.currentPage)) state.currentPage = 1;
  $('#page-input').value = state.currentPage;
  $$('#thumbs .thumb').forEach(t => t.classList.toggle('current', +t.dataset.page === state.currentPage));
}

// ---------- ズーム ----------
export async function setZoom(modeOrValue) {
  const generation = ++zoomGeneration;
  if (modeOrValue === 'fit' || modeOrValue === 'width') state.zoomMode = modeOrValue;
  else {
    const zoom = Number.parseFloat(modeOrValue);
    if (!Number.isFinite(zoom)) return;
    state.zoomMode = 'value';
    state.zoom = zoom;
  }
  const keep = state.currentPage;
  await refresh();
  if (generation !== zoomGeneration) return;
  gotoPage(keep);
  syncZoomSelect();
}
export function zoomBy(f) {
  state.zoomMode = 'value';
  return setZoom(Math.max(0.25, Math.min(6, state.zoom * f)));
}
function syncZoomSelect() {
  const sel = $('#zoom-select');
  const v = state.zoomMode === 'value' ? String(state.zoom) : state.zoomMode;
  sel.value = [...sel.options].some(o => o.value === v) ? v : '';
}

export async function rotateView(deg) {
  state.viewRotation = ((state.viewRotation + deg) % 360 + 360) % 360;
  const keep = state.currentPage;
  await refresh();
  gotoPage(keep);
}

// ---------- 検索 ----------
export async function runSearch(query, keepIndex = false) {
  const generation = ++searchGeneration;
  const pdf = state.pdf;
  searchState.query = query;
  searchState.matches = [];
  if (!keepIndex) searchState.index = -1;
  $$('.hl-match').forEach(e => e.remove());
  if (!query || !pdf) { $('#find-status').textContent = ''; return; }
  const q = query.toLowerCase();
  const matches = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    if (generation !== searchGeneration || pdf !== state.pdf) return;
    const tc = await getTextContent(p, { pdf });
    if (generation !== searchGeneration || pdf !== state.pdf) return;
    tc.items.forEach((item, idx) => {
      let pos = 0, s = item.str.toLowerCase();
      while ((pos = s.indexOf(q, pos)) !== -1) {
        matches.push({ page: p - 1, itemIdx: idx, start: pos });
        pos += q.length;
      }
    });
  }
  if (generation !== searchGeneration || pdf !== state.pdf) return;
  searchState.matches = matches;
  for (let i = 0; i < pageViews.length; i++) if (pageViews[i].rendered) paintMatchesOnPage(i);
  $('#find-status').textContent = searchState.matches.length ? `${searchState.matches.length}件` : '見つかりません';
  if (searchState.matches.length && !keepIndex) findNext(1);
}

function paintMatchesOnPage(pageIndex) {
  const pv = pageViews[pageIndex];
  if (!pv?.rendered) return;
  const tl = pv.wrap.querySelector('.text-layer');
  if (!tl) return;
  tl.querySelectorAll('.hl-match').forEach(e => e.remove());
  searchState.matches.forEach((m, mi) => {
    if (m.page !== pageIndex) return;
    const span = tl.querySelector(`span[data-idx="${m.itemIdx}"]`);
    if (!span) return;
    const div = document.createElement('div');
    div.className = 'hl-match' + (mi === searchState.index ? ' current' : '');
    const frac = m.start / Math.max(1, span.textContent.length);
    const fracW = searchState.query.length / Math.max(1, span.textContent.length);
    const w = parseFloat(span.dataset.w || span.offsetWidth);
    div.style.left = `${span.offsetLeft + w * frac}px`;
    div.style.top = `${span.offsetTop}px`;
    div.style.width = `${Math.max(6, w * fracW)}px`;
    div.style.height = span.style.fontSize;
    div.dataset.mi = mi;
    tl.appendChild(div);
  });
}

export function findNext(dir) {
  const n = searchState.matches.length;
  if (!n) return;
  searchState.index = ((searchState.index + dir) % n + n) % n;
  const m = searchState.matches[searchState.index];
  gotoPage(m.page + 1);
  for (let i = 0; i < pageViews.length; i++) if (pageViews[i].rendered) paintMatchesOnPage(i);
  $('#find-status').textContent = `${searchState.index + 1} / ${n}件`;
  setTimeout(() => {
    const cur = document.querySelector('.hl-match.current');
    cur?.scrollIntoView({ block: 'center' });
  }, 60);
}

export function clearSearch() {
  searchGeneration++;
  searchState = { query: '', matches: [], index: -1 };
  $$('.hl-match').forEach(e => e.remove());
}

// ---------- 印刷 ----------
export async function printDocument() {
  if (!state.pdf) return;
  setStatus('印刷を準備中...');
  const host = $('#print-host');
  host.innerHTML = '';
  for (let i = 1; i <= state.pdf.numPages; i++) {
    const page = await state.pdf.getPage(i);
    const vp = page.getViewport({ scale: 150 / 72 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const img = document.createElement('img');
    img.src = c.toDataURL('image/jpeg', 0.92);
    host.appendChild(img);
  }
  host.hidden = false;
  setStatus('準備完了');
  window.print();
  setTimeout(() => { host.hidden = true; host.innerHTML = ''; }, 1000);
}
