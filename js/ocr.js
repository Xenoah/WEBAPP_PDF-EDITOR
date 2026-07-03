// ===== OCR: スキャンPDFを検索可能・編集可能なPDFへ変換 (Tesseract.js / 完全オフライン) =====
import { state, getLibDoc, applyBytes, hasDoc } from './state.js';
import { showDialog, showProgress, hideProgress, setStatus, parsePageRange, getJapaneseFont, alertDialog } from './utils.js';
import { renderPageToCanvas } from './convert.js';

export async function runOcrDialog() {
  if (!hasDoc()) { alertDialog('OCR', '先にPDFを開いてください。'); return; }
  const opts = await showDialog('OCR — テキスト認識', `
    <label>認識言語</label>
    <select id="ocr-lang">
      <option value="jpn+eng" selected>日本語 + 英語</option>
      <option value="jpn">日本語</option>
      <option value="eng">英語</option>
    </select>
    <label>対象ページ(例: 1-3,5 / 空欄で全ページ)</label>
    <input type="text" id="ocr-pages" placeholder="全ページ">
    <p class="note" style="font-size:11px;opacity:.65;margin-top:10px;line-height:1.6">
      認識したテキストは「見えないテキストレイヤー」としてページへ埋め込まれ、<br>
      検索・コピー・書き出しが可能になります。処理はすべてオフラインで実行されます。
    </p>
  `, [
    { label: 'キャンセル', value: null },
    { label: 'OCRを実行', accent: true, onClick: b => ({ lang: b.querySelector('#ocr-lang').value, pages: b.querySelector('#ocr-pages').value }) },
  ]);
  if (!opts) return;
  await runOcr(opts.lang, parsePageRange(opts.pages, state.pdf.numPages));
}

async function runOcr(lang, pageIndices) {
  showProgress('OCRエンジンを初期化中...', 0);
  let worker = null;
  try {
    worker = await window.Tesseract.createWorker(lang, 1, {
      workerPath: 'vendor/tesseract.worker.min.js',
      corePath: 'vendor/tesseract-core',
      langPath: 'vendor/tessdata',
      gzip: true,
    });
    const doc = await getLibDoc();
    doc.registerFontkit(window.fontkit);
    const font = await doc.embedFont(await getJapaneseFont(), { subset: true });
    const SCALE = 300 / 72; // 300dpi相当で認識
    let totalWords = 0;

    for (let n = 0; n < pageIndices.length; n++) {
      const pi = pageIndices[n];
      showProgress(`OCR実行中... ページ ${pi + 1} (${n + 1}/${pageIndices.length})`, n / pageIndices.length);
      const canvas = await renderPageToCanvas(pi + 1, SCALE);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      const page = doc.getPage(pi);
      const pageH = page.getHeight();
      const words = collectWords(data);
      for (const w of words) {
        if (!w.text.trim()) continue;
        const x = w.bbox.x0 / SCALE;
        const y = pageH - w.bbox.y1 / SCALE;
        const h = Math.max(4, (w.bbox.y1 - w.bbox.y0) / SCALE);
        try {
          // 不可視テキスト(opacity 0)として埋め込み → 検索・選択可能
          page.drawText(w.text, { x, y, size: h, font, opacity: 0 });
          totalWords++;
        } catch { /* グリフ欠落は無視 */ }
      }
    }
    await applyBytes(await doc.save(), 'OCR');
    setStatus(`OCR完了: ${totalWords}語のテキストを${pageIndices.length}ページへ埋め込みました`);
    alertDialog('OCR完了', `${pageIndices.length}ページを処理し、${totalWords}語を検索可能テキストとして埋め込みました。<br>Ctrl+F で検索できることを確認してください。`);
  } catch (e) {
    alertDialog('OCRエラー', e.message);
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    hideProgress();
  }
}

// Tesseract v6/v7 の blocks 階層 (または旧APIのwords) から単語を収集
function collectWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) out.push(word);
      }
    }
  }
  return out;
}
