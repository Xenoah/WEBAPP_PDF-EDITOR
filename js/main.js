// ===== PDF Editor Pro — エントリポイント / コマンド配線 =====
import { state, loadBytes, undo, redo, hasDoc } from './state.js';
import { $, $$, setStatus, pickFile, downloadBytes, showDialog, alertDialog, baseName, hideProgress, closeDialog } from './utils.js';
import * as viewer from './viewer.js';
import * as organize from './organize.js';
import * as annotate from './annotate.js';
import * as edit from './edit.js';
import * as convert from './convert.js';
import { runOcrDialog } from './ocr.js';
import { compareDialog } from './compare.js';
import { protectDialog, compressDialog, propertiesDialog } from './protect.js';

viewer.init();
annotate.init();
edit.init();

// ---------- ファイルを開く ----------
async function openFile(fileArg) {
  const file = fileArg || await pickFile('.pdf,.docx,.xlsx,.xls,.csv,.pptx,.png,.jpg,.jpeg,.bmp,.gif,.webp,.txt,.md');
  if (!file) return;
  if (/\.pdf$/i.test(file.name)) {
    await openPdfBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  } else {
    await convert.createPdfFromFiles([file]);
  }
}

async function openPdfBytes(bytes, name, password = null) {
  try {
    await loadBytes(bytes, { fileName: name, password, resetHistory: true });
    setStatus(`${name} を開きました`);
  } catch (e) {
    if (e?.name === 'PasswordException') {
      const pw = await showDialog('パスワードが必要です', `
        <p style="margin-bottom:8px">「${name}」は保護されています。${password !== null ? '<br><b style="color:#ff8a80">パスワードが正しくありません。</b>' : ''}</p>
        <label>パスワード</label><input type="password" id="open-pw">
      `, [
        { label: 'キャンセル', value: null },
        { label: '開く', accent: true, onClick: b => b.querySelector('#open-pw').value },
      ]);
      if (pw) await openPdfBytes(bytes, name, pw);
    } else {
      alertDialog('開けませんでした', e.message);
    }
  }
}

// ---------- 保存 ----------
function saveFile() {
  if (!hasDoc()) return;
  downloadBytes(state.bytes, state.fileName);
  setStatus(`${state.fileName} を保存しました`);
}
async function saveAs() {
  if (!hasDoc()) return;
  const name = await showDialog('名前を付けて保存', `
    <label>ファイル名</label>
    <input type="text" id="save-name" value="${baseName(state.fileName)}.pdf">
  `, [
    { label: 'キャンセル', value: null },
    { label: '保存', accent: true, onClick: b => b.querySelector('#save-name').value },
  ]);
  if (!name) return;
  state.fileName = name.endsWith('.pdf') ? name : name + '.pdf';
  saveFile();
  $('#doc-title').textContent = state.fileName;
}

// ---------- ツールパネル ----------
const PANES = {
  edit: `
    <h3>PDFを編集</h3>
    <div class="row">
      <button class="op" data-cmd="tool-editText">✏️ テキストと画像を編集</button>
      <button class="op" data-cmd="tool-addText">Ｔ テキストを追加</button>
      <button class="op" data-cmd="tool-addImage">🖼 画像を追加</button>
      <button class="op" data-cmd="tool-editOff">編集モードを終了</button>
    </div>
    <p class="note">「テキストと画像を編集」でページ上のテキストをクリックすると直接修正できます。画像はクリックして差し替え/削除。既存要素の編集は白塗り+再描画方式です。</p>`,
  organize: `
    <h3>ページを整理</h3>
    <div class="row">
      <button class="op" data-cmd="org-view">🗐 整理ビューを開く/閉じる</button>
    </div>
    <div class="row">
      <button class="op" data-cmd="org-rotate-l">⟲ 左回転</button>
      <button class="op" data-cmd="org-rotate-r">⟳ 右回転</button>
      <button class="op" data-cmd="org-delete">🗑 削除</button>
    </div>
    <div class="row">
      <button class="op" data-cmd="org-insert-blank">空白ページを挿入</button>
      <button class="op" data-cmd="org-insert-file">ファイルから挿入</button>
    </div>
    <div class="row">
      <button class="op" data-cmd="org-extract">選択ページを抽出</button>
      <button class="op" data-cmd="org-split">文書を分割</button>
      <button class="op" data-cmd="combine">ファイルを結合</button>
    </div>
    <p class="note">整理ビューではドラッグ&ドロップで並べ替え、Ctrl+クリックで複数選択、各ページの上部ボタンで回転・複製・削除ができます。</p>`,
  export: `
    <h3>書き出し</h3>
    <div class="row"><button class="op" data-cmd="exportWord">📝 Word (.docx)</button></div>
    <div class="row"><button class="op" data-cmd="exportExcel">📊 Excel (.xlsx)</button></div>
    <div class="row"><button class="op" data-cmd="exportPpt">📽 PowerPoint (.pptx)</button></div>
    <div class="row"><button class="op" data-cmd="exportPng">🖼 PNG画像</button><button class="op" data-cmd="exportJpg">🖼 JPEG画像</button></div>
    <div class="row"><button class="op" data-cmd="exportText">📄 テキスト (.txt)</button></div>
    <p class="note">Word/Excelはテキスト抽出ベース、PowerPointはページ画像ベースで変換します。スキャンPDFは先にOCRを実行してください。</p>`,
  comment: `
    <h3>注釈</h3>
    <div class="row">
      <button class="op" data-tool="highlight">🖍 ハイライト</button>
      <button class="op" data-tool="note">💬 ノート</button>
    </div>
    <div class="row">
      <button class="op" data-tool="draw">✏️ 描画</button>
      <button class="op" data-tool="rect">▭ 長方形</button>
      <button class="op" data-tool="ellipse">◯ 楕円</button>
      <button class="op" data-tool="line">╱ 線</button>
    </div>
    <div class="row"><button class="op" data-tool="freetext">Ｔ テキスト注釈</button></div>
    <div class="row"><button class="op accent" data-cmd="applyAnnots">✔ 注釈をPDFへ適用</button></div>
    <p class="note">ツールを選択してページ上をドラッグ。未適用の注釈はダブルクリックで削除できます。「適用」でPDFに書き込まれます。</p>`,
};

function showPane(name) {
  $('#tool-pane').innerHTML = PANES[name] || '';
}

// ---------- コマンド ----------
const commands = {
  open: () => openFile(),
  create: async () => {
    const files = await pickFile('.docx,.xlsx,.xls,.csv,.pptx,.png,.jpg,.jpeg,.bmp,.gif,.webp,.txt,.md,.pdf', true);
    if (files?.length) await convert.createPdfFromFiles(files);
  },
  save: saveFile,
  saveAs,
  close: async () => {
    if (!hasDoc()) return;
    state.pdf.destroy();
    state.pdf = null; state.bytes = null;
    state.undoStack = []; state.redoStack = []; state.pendingAnnots = [];
    await viewer.refresh();
    setStatus('文書を閉じました');
  },
  print: () => viewer.printDocument(),
  props: propertiesDialog,

  undo: async () => { await undo() ? setStatus('元に戻しました') : setStatus('元に戻す操作はありません'); },
  redo: async () => { await redo() ? setStatus('やり直しました') : setStatus('やり直す操作はありません'); },
  find: () => { const fb = $('#findbar'); fb.hidden = false; fb.style.display = 'flex'; $('#find-input').focus(); $('#find-input').select(); },

  zoomIn: () => viewer.zoomBy(1.25),
  zoomOut: () => viewer.zoomBy(0.8),
  zoomFit: () => viewer.setZoom('fit'),
  zoom100: () => viewer.setZoom(1),
  zoomWidth: () => viewer.setZoom('width'),
  rotateViewCW: () => viewer.rotateView(90),
  rotateViewCCW: () => viewer.rotateView(-90),
  firstPage: () => viewer.gotoPage(1),
  lastPage: () => viewer.gotoPage(state.pdf?.numPages || 1),
  prevPage: () => viewer.gotoPage(state.currentPage - 1),
  nextPage: () => viewer.gotoPage(state.currentPage + 1),

  'panel-edit': () => showPane('edit'),
  'panel-organize': () => { showPane('organize'); if (hasDoc()) organize.toggleOrganizeView(true); },
  'panel-export': () => showPane('export'),
  'panel-comment': () => showPane('comment'),

  'tool-editText': () => hasDoc() && edit.setEditMode(true),
  'tool-editOff': () => edit.setEditMode(false),
  'tool-addText': () => hasDoc() && edit.startAddText(),
  'tool-addImage': () => hasDoc() && edit.startAddImage(),

  'org-view': () => hasDoc() && organize.toggleOrganizeView(),
  'org-rotate-l': async () => { if (hasDoc()) { await organize.rotatePages(organize.getSelectedPages(), -90); organize.renderOrganizeGrid(); } },
  'org-rotate-r': async () => { if (hasDoc()) { await organize.rotatePages(organize.getSelectedPages(), 90); organize.renderOrganizeGrid(); } },
  'org-delete': async () => { if (hasDoc()) { await organize.deletePages(organize.getSelectedPages()); organize.renderOrganizeGrid(); } },
  'org-insert-blank': async () => { if (hasDoc()) { await organize.insertBlankPage(state.currentPage); organize.renderOrganizeGrid(); } },
  'org-insert-file': async () => { if (hasDoc()) { await organize.insertFromFile(state.currentPage); organize.renderOrganizeGrid(); } },
  'org-extract': async () => {
    if (!hasDoc()) return;
    const pages = organize.getSelectedPages();
    const del = await showDialog('ページを抽出', `${pages.map(p => p + 1).join(', ')}ページ目を新しいPDFとして抽出します。`, [
      { label: 'キャンセル', value: null },
      { label: '抽出後に削除', value: 'remove' },
      { label: '抽出', accent: true, value: 'keep' },
    ]);
    if (del) { await organize.extractPages(pages, del === 'remove'); organize.renderOrganizeGrid(); }
  },
  'org-split': () => hasDoc() && organize.splitDocument(),
  combine: () => organize.combineFiles(),

  applyAnnots: () => annotate.applyAnnotations(),

  exportWord: () => convert.exportToWord(),
  exportExcel: () => convert.exportToExcel(),
  exportPpt: () => convert.exportToPpt(),
  exportPng: () => convert.exportToImages('png'),
  exportJpg: () => convert.exportToImages('jpeg'),
  exportText: () => convert.exportToText(),

  ocr: runOcrDialog,
  compare: compareDialog,
  protect: protectDialog,
  compress: compressDialog,

  shortcuts: () => showDialog('キーボードショートカット', `
    <table class="prop-table">
      <tr><td>Ctrl+O</td><td>ファイルを開く</td></tr>
      <tr><td>Ctrl+S / Ctrl+Shift+S</td><td>保存 / 名前を付けて保存</td></tr>
      <tr><td>Ctrl+P</td><td>印刷</td></tr>
      <tr><td>Ctrl+Z / Ctrl+Shift+Z</td><td>元に戻す / やり直し</td></tr>
      <tr><td>Ctrl+F</td><td>検索</td></tr>
      <tr><td>Ctrl+D</td><td>文書のプロパティ</td></tr>
      <tr><td>Ctrl++ / Ctrl+− / Ctrl+0 / Ctrl+1 / Ctrl+2</td><td>ズーム / 全体表示 / 100% / 幅に合わせる</td></tr>
      <tr><td>← → / Home / End</td><td>ページ移動</td></tr>
      <tr><td>H / V</td><td>手のひら / 選択ツール</td></tr>
      <tr><td>U / D</td><td>ハイライト / 描画ツール</td></tr>
      <tr><td>Esc</td><td>検索バー・ツールを閉じる</td></tr>
    </table>
  `, [{ label: '閉じる', accent: true }]),
  about: () => alertDialog('PDF Editor Pro', 'Acrobat Pro互換のオフラインWebPDFエディター<br>pdf.js / pdf-lib / Tesseract.js を使用。すべての処理はブラウザ内で完結し、ファイルが外部へ送信されることはありません。'),
};

// ---------- イベント配線 ----------
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-cmd]');
  if (btn) {
    closeMenus();
    commands[btn.dataset.cmd]?.();
    return;
  }
  const toolBtn = e.target.closest('[data-tool]');
  if (toolBtn) {
    setTool(toolBtn.dataset.tool);
    return;
  }
  if (!e.target.closest('.menu')) closeMenus();
});

function setTool(tool) {
  state.tool = tool;
  $$('#toolbar .tool-toggle').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  annotate.updateLayerMode();
  const names = { hand: '手のひら', select: '選択', highlight: 'ハイライト', note: 'ノート注釈', draw: '描画', rect: '長方形', ellipse: '楕円', line: '線', freetext: 'テキスト注釈' };
  setStatus(`ツール: ${names[tool] || tool}`);
}

$('#apply-annots').addEventListener('click', () => annotate.applyAnnotations());
$('#annot-color').addEventListener('input', e => { state.annotColor = e.target.value; });

// メニュー開閉
function closeMenus() { $$('.menu.open').forEach(m => m.classList.remove('open')); }
$$('.menu-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const menu = btn.parentElement;
    const wasOpen = menu.classList.contains('open');
    closeMenus();
    if (!wasOpen) menu.classList.add('open');
  });
  btn.addEventListener('mouseenter', () => {
    if ($('.menu.open') && !btn.parentElement.classList.contains('open')) {
      closeMenus();
      btn.parentElement.classList.add('open');
    }
  });
});

// ページ番号・ズーム
$('#page-input').addEventListener('change', e => viewer.gotoPage(+e.target.value));
$('#zoom-select').addEventListener('change', e => viewer.setZoom(e.target.value));

// 検索バー
$('#find-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.shiftKey ? viewer.findNext(-1) : viewer.findNext(1); }
  if (e.key === 'Escape') closeFindbar();
});
let findTimer = null;
$('#find-input').addEventListener('input', e => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => viewer.runSearch(e.target.value), 300);
});
$('#find-next').addEventListener('click', () => viewer.findNext(1));
$('#find-prev').addEventListener('click', () => viewer.findNext(-1));
$('#find-close').addEventListener('click', closeFindbar);
function closeFindbar() { const fb = $('#findbar'); fb.hidden = true; fb.style.display = 'none'; viewer.clearSearch(); }

// ---------- キーボードショートカット ----------
document.addEventListener('keydown', e => {
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'o') { e.preventDefault(); commands.open(); }
  else if (ctrl && k === 's') { e.preventDefault(); e.shiftKey ? saveAs() : saveFile(); }
  else if (ctrl && k === 'p') { e.preventDefault(); commands.print(); }
  else if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? commands.redo() : commands.undo(); }
  else if (ctrl && k === 'y') { e.preventDefault(); commands.redo(); }
  else if (ctrl && k === 'f') { e.preventDefault(); commands.find(); }
  else if (ctrl && k === 'd') { e.preventDefault(); commands.props(); }
  else if (ctrl && k === 'w') { e.preventDefault(); commands.close(); }
  else if (ctrl && (k === '+' || k === '=' || k === ';')) { e.preventDefault(); commands.zoomIn(); }
  else if (ctrl && k === '-') { e.preventDefault(); commands.zoomOut(); }
  else if (ctrl && k === '0') { e.preventDefault(); commands.zoomFit(); }
  else if (ctrl && k === '1') { e.preventDefault(); commands.zoom100(); }
  else if (ctrl && k === '2') { e.preventDefault(); commands.zoomWidth(); }
  else if (!inInput && !ctrl) {
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') commands.prevPage();
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') commands.nextPage();
    else if (e.key === 'Home') commands.firstPage();
    else if (e.key === 'End') commands.lastPage();
    else if (k === 'h') setTool('hand');
    else if (k === 'v') setTool('select');
    else if (k === 'u') setTool('highlight');
    else if (k === 'd') setTool('draw');
    else if (e.key === 'Escape') { closeFindbar(); setTool('select'); }
  }
});

// ---------- ドラッグ&ドロップ ----------
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (files.length === 1) await openFile(files[0]);
  else await convert.createPdfFromFiles(files);
});

// 手のひらツール(ドラッグスクロール)
let panning = null;
$('#viewer-container').addEventListener('mousedown', e => {
  if (state.tool !== 'hand') return;
  panning = { x: e.clientX, y: e.clientY, sl: $('#viewer-container').scrollLeft, st: $('#viewer-container').scrollTop };
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!panning) return;
  const c = $('#viewer-container');
  c.scrollLeft = panning.sl - (e.clientX - panning.x);
  c.scrollTop = panning.st - (e.clientY - panning.y);
});
document.addEventListener('mouseup', () => { panning = null; });

// Ctrl+ホイールでズーム
$('#viewer-container').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  viewer.zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
}, { passive: false });

// ---------- 起動時の自己修復 ----------
// 古いキャッシュ由来のCSSでオーバーレイが出っぱなしになる事故に備え、起動時に強制的に閉じる
hideProgress();
closeDialog();

// ---------- Service Worker(オフライン対応) ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.update(); // 旧バージョンのSWが残っていても即座に更新チェック
    console.log('Service Worker registered — オフラインで利用可能');
  }).catch(err => console.warn('SW registration failed:', err));
}

setStatus('準備完了 — PDFを開くかファイルをドロップしてください');
