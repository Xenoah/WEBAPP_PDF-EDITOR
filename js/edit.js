// ===== PDF編集: 既存テキストの修正・画像の差し替え/削除・テキスト/画像の追加 =====
// 既存要素の編集は「白塗り+再描画」方式(多くのPDF編集ソフトと同じアプローチ)
import { state, pdfjsLib, getLibDoc, applyBytes, rgb } from './state.js';
import { $, $$, setStatus, showProgress, hideProgress, pickFile, getJapaneseFont, alertDialog, hexToRgb01 } from './utils.js';
import { addOverlayHook, getPageView, getTextContent } from './viewer.js';

let subTool = null;        // null | 'addText' | 'addImage'
let pendingImageFile = null;

export function init() {
  addOverlayHook(mountEditLayer);
}

export function isEditMode() { return state.tool === 'edit'; }

export async function setEditMode(on) {
  state.tool = on ? 'edit' : 'select';
  subTool = null;
  $$('.edit-layer').forEach(l => l.remove());
  if (on) {
    for (let i = 0; i < state.pdf.numPages; i++) {
      const pv = getPageView(i);
      if (pv?.rendered) await mountEditLayer(i, pv.wrap, pv.viewport);
    }
    setStatus('編集モード: テキストをクリックして修正、画像をクリックして差し替え/削除');
  } else {
    setStatus('準備完了');
  }
}

export async function startAddText() {
  if (!isEditMode()) await setEditMode(true);
  subTool = 'addText';
  setStatus('テキストを追加: 挿入したい位置をクリックしてください');
}

export async function startAddImage() {
  const file = await pickFile('.png,.jpg,.jpeg,.bmp,.gif,.webp');
  if (!file) return;
  if (!isEditMode()) await setEditMode(true);
  pendingImageFile = file;
  subTool = 'addImage';
  setStatus('画像を追加: 配置したい位置をクリックしてください');
}

// ---------- 編集レイヤー ----------
async function mountEditLayer(pageIndex, wrap, viewport) {
  if (!isEditMode()) return;
  wrap.querySelector('.edit-layer')?.remove();
  const layer = document.createElement('div');
  layer.className = 'edit-layer';
  layer._viewport = viewport;
  wrap.appendChild(layer);

  // --- 既存テキスト要素 ---
  const tc = await getTextContent(pageIndex + 1);
  tc.items.forEach(item => {
    if (!item.str || !item.str.trim()) return;
    const h = Math.hypot(item.transform[2], item.transform[3]);
    const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const div = document.createElement('div');
    div.className = 'edit-text-item';
    div.textContent = item.str;
    div.style.left = `${vx}px`;
    div.style.top = `${vy - h * viewport.scale}px`;
    div.style.fontSize = `${h * viewport.scale}px`;
    div.style.minWidth = `${item.width * viewport.scale}px`;
    div.style.height = `${h * viewport.scale * 1.25}px`;
    div.style.fontFamily = 'sans-serif';
    div.style.whiteSpace = 'pre';
    div.addEventListener('click', e => {
      if (subTool) return;
      e.stopPropagation();
      beginTextEdit(div, pageIndex, item, h);
    });
    layer.appendChild(div);
  });

  // --- 既存画像要素(オペレーターリストから位置検出) ---
  try {
    const images = await detectImages(pageIndex);
    for (const rect of images) {
      const p1 = viewport.convertToViewportPoint(rect[0], rect[3]);
      const p2 = viewport.convertToViewportPoint(rect[2], rect[1]);
      const div = document.createElement('div');
      div.className = 'edit-img-item';
      div.title = '画像 — クリックで選択';
      div.style.left = `${Math.min(p1[0], p2[0])}px`;
      div.style.top = `${Math.min(p1[1], p2[1])}px`;
      div.style.width = `${Math.abs(p2[0] - p1[0])}px`;
      div.style.height = `${Math.abs(p2[1] - p1[1])}px`;
      div.addEventListener('click', e => {
        if (subTool) return;
        e.stopPropagation();
        selectImage(div, pageIndex, rect);
      });
      layer.appendChild(div);
    }
  } catch { /* 画像検出失敗は無視 */ }

  // --- クリックで追加(テキスト/画像) ---
  layer.addEventListener('click', async e => {
    if (e.target !== layer) return;
    const r = layer.getBoundingClientRect();
    const [x, y] = [e.clientX - r.left, e.clientY - r.top];
    if (subTool === 'addText') {
      subTool = null;
      beginNewText(layer, pageIndex, x, y);
    } else if (subTool === 'addImage' && pendingImageFile) {
      const file = pendingImageFile;
      pendingImageFile = null; subTool = null;
      await placeImage(pageIndex, layer._viewport.convertToPdfPoint(x, y), file);
    }
  });
}

// pdf.js オペレーターリストから画像の矩形(PDF座標)を検出する
async function detectImages(pageIndex) {
  const page = await state.pdf.getPage(pageIndex + 1);
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const U = pdfjsLib.Util;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i], args = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = U.transform(ctm, args);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) {
      // 画像は単位正方形をCTMで変換した領域に描画される
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(p => U.applyTransform(p, ctm));
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (rect[2] - rect[0] > 8 && rect[3] - rect[1] > 8) rects.push(rect);
    }
  }
  return rects;
}

// ---------- テキスト編集 ----------
function beginTextEdit(div, pageIndex, item, fontSizePt) {
  if (div.classList.contains('editing')) return;
  closeFloatingBar();
  div.classList.add('editing');
  div.contentEditable = 'true';
  const original = item.str;
  div.focus();
  document.getSelection()?.selectAllChildren(div);

  const commit = async () => {
    div.contentEditable = 'false';
    div.classList.remove('editing');
    const newText = div.textContent;
    if (newText === original) return;
    await replaceTextItem(pageIndex, item, fontSizePt, newText);
  };
  div.addEventListener('blur', commit, { once: true });
  div.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); div.blur(); }
    if (e.key === 'Escape') { div.textContent = original; div.blur(); }
  });
}

// 白塗り+新テキスト描画で既存テキストを置き換える
async function replaceTextItem(pageIndex, item, fontSizePt, newText) {
  showProgress('テキストを更新中...');
  try {
    const doc = await getLibDoc();
    doc.registerFontkit(window.fontkit);
    const font = await doc.embedFont(await getJapaneseFont(), { subset: true });
    const page = doc.getPage(pageIndex);
    const x = item.transform[4], y = item.transform[5];
    const newW = newText ? font.widthOfTextAtSize(newText, fontSizePt) : 0;
    const w = Math.max(item.width, newW) + 2;
    page.drawRectangle({
      x: x - 1, y: y - fontSizePt * 0.28,
      width: w, height: fontSizePt * 1.45,
      color: rgb(1, 1, 1),
    });
    if (newText) {
      page.drawText(newText, { x, y, size: fontSizePt, font, color: rgb(0, 0, 0) });
    }
    await applyBytes(await doc.save(), 'テキストを編集');
    setStatus('テキストを更新しました');
  } catch (e) {
    alertDialog('編集エラー', e.message);
  } finally { hideProgress(); }
}

// ---------- 新規テキスト ----------
function beginNewText(layer, pageIndex, x, y) {
  const vp = layer._viewport;
  const div = document.createElement('div');
  div.className = 'edit-text-item editing';
  div.contentEditable = 'true';
  div.style.left = `${x}px`; div.style.top = `${y}px`;
  div.style.fontSize = `${14 * vp.scale}px`;
  div.style.minWidth = '60px';
  layer.appendChild(div);
  div.focus();
  const commit = async () => {
    const text = div.textContent.trim();
    div.remove();
    if (!text) return;
    const [px, py] = vp.convertToPdfPoint(x, y + 14 * vp.scale);
    showProgress('テキストを追加中...');
    try {
      const doc = await getLibDoc();
      doc.registerFontkit(window.fontkit);
      const font = await doc.embedFont(await getJapaneseFont(), { subset: true });
      doc.getPage(pageIndex).drawText(text, { x: px, y: py, size: 14, font, color: rgb(0, 0, 0) });
      await applyBytes(await doc.save(), 'テキストを追加');
      setStatus('テキストを追加しました');
    } finally { hideProgress(); }
  };
  div.addEventListener('blur', commit, { once: true });
  div.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); div.blur(); }
    if (e.key === 'Escape') { div.textContent = ''; div.blur(); }
  });
}

// ---------- 画像 ----------
let floatingBar = null;
function closeFloatingBar() { floatingBar?.remove(); floatingBar = null; $$('.edit-img-item.selected').forEach(d => d.classList.remove('selected')); }

function selectImage(div, pageIndex, rect) {
  closeFloatingBar();
  div.classList.add('selected');
  floatingBar = document.createElement('div');
  floatingBar.className = 'edit-toolbar';
  floatingBar.style.left = div.style.left;
  floatingBar.style.top = `${parseFloat(div.style.top) - 34}px`;
  floatingBar.innerHTML = `<button data-op="replace">🖼 差し替え</button><button data-op="delete">🗑 削除</button><button data-op="cancel">✕</button>`;
  div.parentElement.appendChild(floatingBar);
  floatingBar.addEventListener('click', async e => {
    const op = e.target.dataset.op;
    if (op === 'replace') {
      const file = await pickFile('.png,.jpg,.jpeg,.bmp,.gif,.webp');
      closeFloatingBar();
      if (file) await replaceImage(pageIndex, rect, file);
    } else if (op === 'delete') {
      closeFloatingBar();
      await whiteOutRect(pageIndex, rect, '画像を削除');
    } else closeFloatingBar();
  });
}

async function embedImageFile(doc, file) {
  const buf = await file.arrayBuffer();
  if (/\.jpe?g$/i.test(file.name)) return doc.embedJpg(buf);
  if (/\.png$/i.test(file.name)) return doc.embedPng(buf);
  const bmp = await createImageBitmap(new Blob([buf]));
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return doc.embedPng(await blob.arrayBuffer());
}

async function replaceImage(pageIndex, rect, file) {
  showProgress('画像を差し替え中...');
  try {
    const doc = await getLibDoc();
    const img = await embedImageFile(doc, file);
    const page = doc.getPage(pageIndex);
    const [x1, y1, x2, y2] = rect;
    const rw = x2 - x1, rh = y2 - y1;
    page.drawRectangle({ x: x1, y: y1, width: rw, height: rh, color: rgb(1, 1, 1) });
    // アスペクト比を保って領域内に収める
    const s = Math.min(rw / img.width, rh / img.height);
    const w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: x1 + (rw - w) / 2, y: y1 + (rh - h) / 2, width: w, height: h });
    await applyBytes(await doc.save(), '画像を差し替え');
    setStatus('画像を差し替えました');
  } catch (e) {
    alertDialog('差し替えエラー', e.message);
  } finally { hideProgress(); }
}

async function whiteOutRect(pageIndex, rect, label) {
  showProgress('処理中...');
  try {
    const doc = await getLibDoc();
    doc.getPage(pageIndex).drawRectangle({ x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1], color: rgb(1, 1, 1) });
    await applyBytes(await doc.save(), label);
    setStatus(label + 'しました(白塗り)');
  } finally { hideProgress(); }
}

async function placeImage(pageIndex, at, file) {
  showProgress('画像を配置中...');
  try {
    const doc = await getLibDoc();
    const img = await embedImageFile(doc, file);
    const page = doc.getPage(pageIndex);
    const maxW = page.getWidth() * 0.5;
    const s = Math.min(1, maxW / img.width);
    const w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: at[0] - w / 2, y: at[1] - h / 2, width: w, height: h });
    await applyBytes(await doc.save(), '画像を追加');
    setStatus('画像を追加しました');
  } finally { hideProgress(); }
}
