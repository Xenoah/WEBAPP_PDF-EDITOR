// ===== ページ整理: 追加・削除・回転・並べ替え・抽出・分割・結合 =====
import { state, PDFDocument, degrees, applyBytes, getLibDoc, hasDoc } from './state.js';
import { $, $$, showProgress, hideProgress, setStatus, pickFile, downloadBytes, parsePageRange, showDialog, alertDialog, confirmDialog, baseName } from './utils.js';
import { fileToPdfBytes } from './convert.js';

let selected = new Set();
let orgActive = false;

export function isOrganizeMode() { return orgActive; }

// ---------- 基本操作(pdf-lib) ----------
export async function rotatePages(indices, deg) {
  const doc = await getLibDoc();
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees(((p.getRotation().angle + deg) % 360 + 360) % 360));
  }
  await applyBytes(await doc.save(), 'ページを回転');
  setStatus(`${indices.length}ページを回転しました`);
}

export async function deletePages(indices) {
  const doc = await getLibDoc();
  if (indices.length >= doc.getPageCount()) { alertDialog('削除できません', 'すべてのページを削除することはできません。'); return; }
  for (const i of [...indices].sort((a, b) => b - a)) doc.removePage(i);
  await applyBytes(await doc.save(), 'ページを削除');
  setStatus(`${indices.length}ページを削除しました`);
}

export async function duplicatePages(indices) {
  const doc = await getLibDoc();
  const copies = await doc.copyPages(doc, indices);
  indices.forEach((idx, n) => doc.insertPage(idx + 1 + n, copies[n]));
  await applyBytes(await doc.save(), 'ページを複製');
}

export async function movePage(from, to) {
  if (from === to) return;
  const doc = await getLibDoc();
  const [copied] = await doc.copyPages(doc, [from]);
  doc.removePage(from);
  doc.insertPage(to > from ? to - 1 : to, copied);
  await applyBytes(await doc.save(), 'ページを移動');
}

export async function insertBlankPage(at) {
  const doc = await getLibDoc();
  const ref = doc.getPageCount() ? doc.getPage(Math.min(at, doc.getPageCount() - 1)).getSize() : { width: 595.28, height: 841.89 };
  doc.insertPage(at, [ref.width, ref.height]);
  await applyBytes(await doc.save(), '空白ページを挿入');
}

// ファイル(PDF/Office/画像)からページを挿入
export async function insertFromFile(at) {
  const file = await pickFile('.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.bmp,.gif,.webp,.txt');
  if (!file) return;
  showProgress('ページを挿入中...');
  try {
    const srcBytes = await fileToPdfBytes(file);
    const doc = await getLibDoc();
    const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    const pages = await doc.copyPages(src, src.getPageIndices());
    pages.forEach((p, n) => doc.insertPage(at + n, p));
    await applyBytes(await doc.save(), 'ページを挿入');
    setStatus(`${pages.length}ページを挿入しました`);
  } catch (e) { alertDialog('挿入エラー', e.message);
  } finally { hideProgress(); }
}

// ページ抽出 → 新しいPDFをダウンロード(オプションで元から削除)
export async function extractPages(indices, removeAfter = false) {
  const doc = await getLibDoc();
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, indices);
  pages.forEach(p => out.addPage(p));
  downloadBytes(await out.save(), `${baseName(state.fileName)}_抽出.pdf`);
  if (removeAfter) await deletePages(indices);
  setStatus(`${indices.length}ページを抽出しました`);
}

// 分割
export async function splitDocument() {
  if (!hasDoc()) return;
  const n = state.pdf.numPages;
  const mode = await showDialog('文書を分割', `
    <label>分割方法</label>
    <select id="split-mode">
      <option value="every">ページ数で分割</option>
      <option value="ranges">ページ範囲を指定</option>
    </select>
    <label id="split-lab1">分割単位(ページ数)</label>
    <input type="number" id="split-n" value="1" min="1" max="${n}">
    <label>ページ範囲(例: 1-3,4-6 ※範囲指定時)</label>
    <input type="text" id="split-ranges" placeholder="1-${Math.ceil(n / 2)},${Math.ceil(n / 2) + 1}-${n}">
  `, [
    { label: 'キャンセル', value: null },
    { label: '分割', accent: true, onClick: b => ({ mode: b.querySelector('#split-mode').value, n: +b.querySelector('#split-n').value, ranges: b.querySelector('#split-ranges').value }) },
  ]);
  if (!mode) return;
  showProgress('分割中...');
  try {
    const doc = await getLibDoc();
    let groups = [];
    if (mode.mode === 'every') {
      for (let i = 0; i < n; i += mode.n) groups.push([...Array(Math.min(mode.n, n - i)).keys()].map(k => i + k));
    } else {
      groups = mode.ranges.split(',').map(r => parsePageRange(r, n)).filter(g => g.length);
    }
    let idx = 1;
    for (const g of groups) {
      const out = await PDFDocument.create();
      (await out.copyPages(doc, g)).forEach(p => out.addPage(p));
      downloadBytes(await out.save(), `${baseName(state.fileName)}_分割${idx++}.pdf`);
    }
    setStatus(`${groups.length}個のファイルに分割しました`);
  } finally { hideProgress(); }
}

// 複数ファイルの結合(PDF/Office/画像 → 1つのPDF)
export async function combineFiles() {
  const files = await pickFile('.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.bmp,.gif,.webp,.txt', true);
  if (!files || !files.length) return;
  const list = files.map(f => f.name).join('<br>');
  const ok = await confirmDialog('ファイルを結合', `以下の${files.length}個のファイルを1つのPDFに結合します:<br><br>${list}`);
  if (!ok) return;
  showProgress('ファイルを結合中...', 0);
  try {
    const out = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      showProgress(`結合中: ${files[i].name}`, i / files.length);
      const bytes = await fileToPdfBytes(files[i]);
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    }
    const merged = await out.save();
    const { loadBytes } = await import('./state.js');
    if (hasDoc()) {
      const action = await showDialog('結合完了', `${files.length}個のファイルを結合しました(${out.getPageCount()}ページ)。どうしますか?`, [
        { label: 'ダウンロードのみ', value: 'dl' },
        { label: '現在の文書として開く', accent: true, value: 'open' },
      ]);
      if (action === 'open') await loadBytes(merged, { fileName: '結合結果.pdf', password: null, resetHistory: true });
      else downloadBytes(merged, '結合結果.pdf');
    } else {
      await loadBytes(merged, { fileName: '結合結果.pdf', password: null, resetHistory: true });
    }
    setStatus('結合が完了しました');
  } catch (e) { alertDialog('結合エラー', e.message);
  } finally { hideProgress(); }
}

// ---------- 整理ビュー(グリッド) ----------
export async function toggleOrganizeView(force) {
  orgActive = force ?? !orgActive;
  let ov = $('#organize-view');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'organize-view';
    $('#viewer-container').appendChild(ov);
  }
  $('#viewer-container').classList.toggle('organize-mode', orgActive);
  ov.classList.toggle('active', orgActive);
  if (orgActive) await renderOrganizeGrid();
  else { ov.innerHTML = ''; selected.clear(); }
}

export async function renderOrganizeGrid() {
  if (!orgActive || !state.pdf) return;
  const ov = $('#organize-view');
  ov.innerHTML = '<div class="org-grid"></div>';
  const grid = ov.firstChild;
  selected.clear();
  for (let i = 1; i <= state.pdf.numPages; i++) {
    const page = await state.pdf.getPage(i);
    const vp = page.getViewport({ scale: 160 / page.getViewport({ scale: 1 }).width });
    const div = document.createElement('div');
    div.className = 'org-page';
    div.draggable = true;
    div.dataset.idx = i - 1;
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    div.appendChild(c);
    const ops = document.createElement('div');
    ops.className = 'org-ops';
    ops.innerHTML = `
      <button title="左に回転" data-op="ccw">⟲</button>
      <button title="右に回転" data-op="cw">⟳</button>
      <button title="複製" data-op="dup">⧉</button>
      <button title="削除" data-op="del">🗑</button>`;
    div.appendChild(ops);
    const num = document.createElement('div');
    num.className = 'org-num'; num.textContent = i;
    div.appendChild(num);
    grid.appendChild(div);

    div.addEventListener('click', e => {
      if (e.target.closest('.org-ops')) return;
      const idx = i - 1;
      if (e.ctrlKey || e.metaKey) { selected.has(idx) ? selected.delete(idx) : selected.add(idx); }
      else if (e.shiftKey && selected.size) {
        const last = Math.max(...selected);
        const [a, b] = [Math.min(last, idx), Math.max(last, idx)];
        for (let k = a; k <= b; k++) selected.add(k);
      } else { selected.clear(); selected.add(idx); }
      $$('.org-page', grid).forEach(el => el.classList.toggle('selected', selected.has(+el.dataset.idx)));
    });
    ops.addEventListener('click', async e => {
      const op = e.target.dataset.op;
      const idx = i - 1;
      if (op === 'cw') await rotatePages([idx], 90);
      if (op === 'ccw') await rotatePages([idx], -90);
      if (op === 'dup') await duplicatePages([idx]);
      if (op === 'del') await deletePages([idx]);
      await renderOrganizeGrid();
    });
    // ドラッグ&ドロップ並べ替え
    div.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', String(i - 1)));
    div.addEventListener('dragover', e => {
      e.preventDefault();
      const before = e.offsetX < div.offsetWidth / 2;
      div.classList.toggle('dragover-before', before);
      div.classList.toggle('dragover-after', !before);
    });
    div.addEventListener('dragleave', () => div.classList.remove('dragover-before', 'dragover-after'));
    div.addEventListener('drop', async e => {
      e.preventDefault();
      const from = +e.dataTransfer.getData('text/plain');
      const before = div.classList.contains('dragover-before');
      div.classList.remove('dragover-before', 'dragover-after');
      let to = (i - 1) + (before ? 0 : 1);
      if (from < to) to--;
      await movePage(from, to);
      await renderOrganizeGrid();
    });
  }
}

export function getSelectedPages() {
  return selected.size ? [...selected].sort((a, b) => a - b) : [state.currentPage - 1];
}
