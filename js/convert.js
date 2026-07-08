// ===== 変換: Office/画像→PDF 作成、PDF→Office/画像 書き出し =====
import { state, PDFDocument, rgb, hasDoc, documentToken, assertCurrentDocument } from './state.js';
import { showProgress, hideProgress, setStatus, downloadBytes, canvasToBytes, baseName, getJapaneseFont, alertDialog, sanitizeHTML, LIMITS, validateFiles, assertCanvasSize, assertImageSize } from './utils.js';

function ensureBatchPageLimit(pageCount, action) {
  if (pageCount > LIMITS.maxBatchPages) {
    throw new Error(`${action}は${LIMITS.maxBatchPages}ページまで対応しています (${pageCount}ページ)。範囲を分けて実行してください。`);
  }
}

function ensureNoFormFields(doc, action) {
  try {
    if (doc.getForm().getFields().length) {
      throw new Error(`フォーム付きPDFは${action}できません。フォーム構造を壊さないため、この操作は中止しました。`);
    }
  } catch (e) {
    if (/フォーム付きPDF/.test(e.message)) throw e;
  }
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function columnRef(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ---------- 共通: ページ→canvas ----------
export async function renderPageToCanvas(pageNum, scale = 2, { token = documentToken(), pdf = state.pdf } = {}) {
  assertCurrentDocument(token);
  const page = await pdf.getPage(pageNum);
  const vp = page.getViewport({ scale });
  assertCanvasSize(vp.width, vp.height, `ページ${pageNum}`);
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  assertCurrentDocument(token);
  return c;
}

// ---------- 作成: 任意ファイル → PDFバイト列 ----------
export async function fileToPdfBytes(file) {
  validateFiles(file);
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'pdf') return new Uint8Array(buf);
  if (['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(ext)) return imagesToPdf([file]);
  if (ext === 'docx') return docxToPdf(buf);
  if (ext === 'csv') return textToPdf(new TextDecoder().decode(buf));
  if (ext === 'xlsx' || ext === 'xls') throw new Error('Excelファイルの取り込みは、安全な変換ライブラリへ更新するまで無効化しています。CSVまたはPDFへ変換してから読み込んでください。');
  if (ext === 'pptx') return pptxToPdf(buf);
  if (ext === 'txt' || ext === 'md') return textToPdf(new TextDecoder().decode(buf));
  throw new Error(`未対応のファイル形式です: .${ext}`);
}

// 画像 → PDF
export async function imagesToPdf(files) {
  if (files.length > LIMITS.maxBatchPages) {
    throw new Error(`画像からPDFを作成できるのは${LIMITS.maxBatchPages}枚までです。`);
  }
  const doc = await PDFDocument.create();
  for (const file of files) {
    const buf = await file.arrayBuffer();
    let img;
    if (/\.(jpe?g)$/i.test(file.name)) img = await doc.embedJpg(buf);
    else if (/\.png$/i.test(file.name)) img = await doc.embedPng(buf);
    else {
      // その他形式はcanvas経由でPNG化
      const bmp = await createImageBitmap(new Blob([buf]));
      assertImageSize(bmp.width, bmp.height, file.name);
      assertCanvasSize(bmp.width, bmp.height, file.name);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      img = await doc.embedPng(await canvasToBytes(c));
    }
    assertImageSize(img.width, img.height, file.name);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return doc.save();
}

// ---------- HTML → PDF (foreignObject レンダリング) ----------
// mammoth(docx) の出力HTMLをA4ページ画像へ変換する
const PAGE_W = 794, PAGE_H = 1123, MARGIN = 57; // A4 @96dpi
async function htmlToPdfBytes(html, { landscape = false } = {}) {
  const pw = landscape ? PAGE_H : PAGE_W, ph = landscape ? PAGE_W : PAGE_H;
  const contentW = pw - MARGIN * 2, contentH = ph - MARGIN * 2;

  // 一時コンテナで実レイアウトを計測
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-99999px;top:0;width:${contentW}px;background:#fff;color:#000;font-family:"Yu Gothic","Hiragino Sans",Meiryo,sans-serif;font-size:14px;line-height:1.6;`;
  host.innerHTML = `<style>table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:3px 6px;font-size:12px}img{max-width:100%}h1,h2,h3,p,ul,ol,table{margin:0 0 10px}</style><div id="__content"></div>`;
  host.querySelector('#__content').innerHTML = sanitizeHTML(html);
  document.body.appendChild(host);
  const content = host.querySelector('#__content');
  await new Promise(r => setTimeout(r, 30));
  // 画像の読込完了を待つ
  await Promise.all([...content.querySelectorAll('img')].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
  const totalH = Math.max(content.scrollHeight, 1);
  assertCanvasSize(contentW * 2, totalH * 2, 'HTML変換');

  // ブロック要素境界でページ分割位置を決める
  const blocks = [...content.children].filter(el => el.offsetHeight > 0);
  const cuts = [0];
  let pageTop = 0;
  for (const b of blocks) {
    const top = b.offsetTop, bottom = top + b.offsetHeight;
    if (bottom - pageTop > contentH && top > pageTop) { cuts.push(top); pageTop = top; }
    // 1ブロックがページより大きい場合は強制分割
    while (bottom - pageTop > contentH) { pageTop += contentH; cuts.push(pageTop); }
  }

  // 全体を1枚の縦長canvasへ描画(SVG foreignObject)
  const SCALE = 2;
  const xhtml = new XMLSerializer().serializeToString(host);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${contentW}" height="${totalH}"><foreignObject width="100%" height="100%">${xhtml.replace('position:fixed;left:-99999px', 'position:static;left:0')}</foreignObject></svg>`;
  document.body.removeChild(host);
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res; img.onerror = () => rej(new Error('HTMLレンダリングに失敗しました'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const tall = document.createElement('canvas');
  assertCanvasSize(contentW * SCALE, totalH * SCALE, 'HTML変換');
  tall.width = contentW * SCALE; tall.height = totalH * SCALE;
  const tctx = tall.getContext('2d');
  tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, tall.width, tall.height);
  tctx.drawImage(img, 0, 0, tall.width, tall.height);

  // ページごとに切り出してPDF化
  const doc = await PDFDocument.create();
  for (let i = 0; i < cuts.length; i++) {
    const y0 = cuts[i], y1 = Math.min(i + 1 < cuts.length ? cuts[i + 1] : totalH, y0 + contentH);
    const sliceH = y1 - y0;
    if (sliceH <= 2) continue;
    const pc = document.createElement('canvas');
    pc.width = contentW * SCALE; pc.height = sliceH * SCALE;
    const pctx = pc.getContext('2d');
    pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, pc.width, pc.height);
    pctx.drawImage(tall, 0, y0 * SCALE, pc.width, sliceH * SCALE, 0, 0, pc.width, sliceH * SCALE);
    const jpg = await doc.embedJpg(await canvasToBytes(pc, 'image/jpeg', 0.92));
    // 96dpi px → 72dpi pt
    const page = doc.addPage([pw * 0.75, ph * 0.75]);
    page.drawImage(jpg, { x: MARGIN * 0.75, y: page.getHeight() - MARGIN * 0.75 - sliceH * 0.75, width: contentW * 0.75, height: sliceH * 0.75 });
  }
  if (!doc.getPageCount()) doc.addPage([pw * 0.75, ph * 0.75]);
  return doc.save();
}

// Word → PDF
async function docxToPdf(buf) {
  const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  return htmlToPdfBytes(result.value);
}

// PowerPoint → PDF (スライドのテキストを抽出して16:9ページに描画)
async function pptxToPdf(buf) {
  const zip = await window.JSZip.loadAsync(buf);
  const entries = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  if (entries.length > LIMITS.maxZipEntries) {
    throw new Error(`PowerPointファイル内の項目数が多すぎます (${entries.length} / 上限 ${LIMITS.maxZipEntries})`);
  }
  const slideFiles = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/(\d+)/)[1] - +b.match(/(\d+)/)[1]);
  ensureBatchPageLimit(slideFiles.length || 1, 'PowerPoint変換');
  const doc = await PDFDocument.create();
  doc.registerFontkit(window.fontkit);
  const font = await doc.embedFont(await getJapaneseFont(), { subset: true });
  const parser = new DOMParser();
  for (const name of slideFiles) {
    const xmlText = await zip.files[name].async('string');
    if (xmlText.length > LIMITS.maxXmlBytes) {
      throw new Error(`${name} が大きすぎるためPowerPoint変換を中止しました。`);
    }
    const xml = parser.parseFromString(xmlText, 'application/xml');
    const page = doc.addPage([960, 540]); // 16:9
    let y = 480;
    const shapes = [...xml.getElementsByTagName('p:sp')];
    let first = true;
    for (const sp of shapes) {
      for (const para of sp.getElementsByTagName('a:p')) {
        const text = [...para.getElementsByTagName('a:t')].map(t => t.textContent).join('');
        if (!text.trim()) continue;
        const size = first ? 28 : 16;
        page.drawText(text, { x: 60, y: y - size, size, font, color: rgb(0.1, 0.1, 0.1), maxWidth: 840 });
        y -= size * 1.8;
        first = false;
        if (y < 40) break;
      }
      y -= 10;
      if (y < 40) break;
    }
  }
  if (!doc.getPageCount()) doc.addPage([960, 540]);
  return doc.save();
}

// テキスト → PDF
async function textToPdf(text) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(window.fontkit);
  const font = await doc.embedFont(await getJapaneseFont(), { subset: true });
  const size = 11, lineH = size * 1.6, margin = 57;
  const pageW = 595.28, pageH = 841.89;
  const maxChars = Math.floor((pageW - margin * 2) / (size * 1.05));
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) { lines.push(''); continue; }
    for (let i = 0; i < raw.length; i += maxChars) lines.push(raw.slice(i, i + maxChars));
  }
  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;
  for (const line of lines) {
    if (y < margin) { page = doc.addPage([pageW, pageH]); y = pageH - margin; }
    if (line) page.drawText(line, { x: margin, y: y - size, size, font, color: rgb(0, 0, 0) });
    y -= lineH;
  }
  return doc.save();
}

// 「PDFを作成」コマンド
export async function createPdfFromFiles(files) {
  validateFiles(files);
  showProgress('PDFを作成中...', 0);
  try {
    const { loadBytes } = await import('./state.js');
    if (files.length === 1) {
      const bytes = await fileToPdfBytes(files[0]);
      await loadBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { fileName: baseName(files[0].name) + '.pdf', password: null, resetHistory: true });
    } else {
      const out = await PDFDocument.create();
      let totalPages = 0;
      for (let i = 0; i < files.length; i++) {
        showProgress(`変換中: ${files[i].name}`, i / files.length);
        const b = await fileToPdfBytes(files[i]);
        const src = await PDFDocument.load(b);
        ensureNoFormFields(src, '複数ファイルからのPDF作成');
        totalPages += src.getPageCount();
        if (totalPages > LIMITS.maxPdfPages) {
          throw new Error(`作成後のページ数が多すぎます (${totalPages}ページ / 上限 ${LIMITS.maxPdfPages}ページ)`);
        }
        (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
      }
      await loadBytes(await out.save(), { fileName: '新規作成.pdf', password: null, resetHistory: true });
    }
    setStatus('PDFを作成しました');
  } catch (e) {
    alertDialog('作成エラー', e.message);
  } finally { hideProgress(); }
}

// ---------- テキスト解析: 行・列へグループ化 ----------
async function pageToLines(pageNum, { token = documentToken(), pdf = state.pdf } = {}) {
  assertCurrentDocument(token);
  const page = await pdf.getPage(pageNum);
  const tc = await page.getTextContent();
  assertCurrentDocument(token);
  const lines = new Map();
  for (const item of tc.items) {
    if (!item.str.trim()) continue;
    const y = Math.round(item.transform[5] / 4) * 4; // 4pt単位で行グループ化
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push({ x: item.transform[4], str: item.str, w: item.width, h: Math.hypot(item.transform[2], item.transform[3]) });
  }
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, items]) => ({ y, items: items.sort((a, b) => a.x - b.x) }));
}

async function workbookBlobFromSheets(sheets) {
  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </sheets>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n  ')}
</Relationships>`);
  sheets.forEach((sheet, i) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((value, c) => {
        const ref = `${columnRef(c)}${r + 1}`;
        return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: 'blob' });
}

// ---------- 書き出し ----------
export async function exportToWord() {
  if (!hasDoc()) return;
  showProgress('Wordへ書き出し中...', 0);
  try {
    const token = documentToken();
    const pdf = state.pdf;
    const pageCount = pdf.numPages;
    ensureBatchPageLimit(pageCount, 'Word書き出し');
    const { Document, Packer, Paragraph, TextRun, PageBreak } = window.docx;
    const children = [];
    for (let p = 1; p <= pageCount; p++) {
      showProgress(`Wordへ書き出し中... (${p}/${pageCount})`, p / pageCount);
      const lines = await pageToLines(p, { token, pdf });
      for (const line of lines) {
        const text = line.items.map(i => i.str).join(' ');
        const size = Math.round(line.items[0].h * 2) || 22; // half-points
        children.push(new Paragraph({ children: [new TextRun({ text, size, font: 'Yu Gothic' })] }));
      }
      if (p < pageCount) children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    assertCurrentDocument(token);
    const doc = new Document({ sections: [{ children }] });
    downloadBytes(await Packer.toBlob(doc), `${baseName(state.fileName)}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    setStatus('Word文書へ書き出しました');
  } catch (e) { alertDialog('書き出しエラー', e.message);
  } finally { hideProgress(); }
}

export async function exportToExcel() {
  if (!hasDoc()) return;
  showProgress('Excelへ書き出し中...', 0);
  try {
    const token = documentToken();
    const pdf = state.pdf;
    const pageCount = pdf.numPages;
    ensureBatchPageLimit(pageCount, 'Excel書き出し');
    const sheets = [];
    for (let p = 1; p <= pageCount; p++) {
      showProgress(`Excelへ書き出し中... (${p}/${pageCount})`, p / pageCount);
      const lines = await pageToLines(p, { token, pdf });
      const aoa = lines.map(line => {
        // 文字間ギャップで列分割
        const cells = [];
        let cur = '';
        let lastEnd = null;
        for (const it of line.items) {
          if (lastEnd !== null && it.x - lastEnd > Math.max(12, it.h * 1.2)) { cells.push(cur); cur = ''; }
          cur += (cur && it.x - lastEnd < 2 ? '' : '') + it.str;
          lastEnd = it.x + it.w;
        }
        if (cur) cells.push(cur);
        return cells;
      });
      sheets.push({ name: `Page${p}`, rows: aoa.length ? aoa : [['']] });
    }
    assertCurrentDocument(token);
    downloadBytes(await workbookBlobFromSheets(sheets), `${baseName(state.fileName)}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    setStatus('Excelブックへ書き出しました');
  } catch (e) { alertDialog('書き出しエラー', e.message);
  } finally { hideProgress(); }
}

export async function exportToPpt() {
  if (!hasDoc()) return;
  showProgress('PowerPointへ書き出し中...', 0);
  try {
    const token = documentToken();
    const pdf = state.pdf;
    const pageCount = pdf.numPages;
    ensureBatchPageLimit(pageCount, 'PowerPoint書き出し');
    const pptx = new window.PptxGenJS();
    pptx.defineLayout({ name: 'PDF', width: 10, height: 10 * (await pageAspect({ token, pdf })) });
    pptx.layout = 'PDF';
    for (let p = 1; p <= pageCount; p++) {
      showProgress(`PowerPointへ書き出し中... (${p}/${pageCount})`, p / pageCount);
      const c = await renderPageToCanvas(p, 2, { token, pdf });
      const slide = pptx.addSlide();
      slide.addImage({ data: c.toDataURL('image/jpeg', 0.9), x: 0, y: 0, w: '100%', h: '100%' });
    }
    assertCurrentDocument(token);
    const blob = await pptx.write('blob');
    downloadBytes(blob, `${baseName(state.fileName)}.pptx`, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    setStatus('PowerPointへ書き出しました');
  } catch (e) { alertDialog('書き出しエラー', e.message);
  } finally { hideProgress(); }
}
async function pageAspect({ token = documentToken(), pdf = state.pdf } = {}) {
  assertCurrentDocument(token);
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  assertCurrentDocument(token);
  return vp.height / vp.width;
}

export async function exportToImages(format = 'png') {
  if (!hasDoc()) return;
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  showProgress('画像へ書き出し中...', 0);
  try {
    const token = documentToken();
    const pdf = state.pdf;
    const pageCount = pdf.numPages;
    ensureBatchPageLimit(pageCount, '画像書き出し');
    if (pageCount === 1) {
      const c = await renderPageToCanvas(1, 2, { token, pdf });
      downloadBytes(await canvasToBytes(c, mime, 0.92), `${baseName(state.fileName)}.${format}`, mime);
    } else {
      const zip = new window.JSZip();
      for (let p = 1; p <= pageCount; p++) {
        showProgress(`画像へ書き出し中... (${p}/${pageCount})`, p / pageCount);
        const c = await renderPageToCanvas(p, 2, { token, pdf });
        zip.file(`${baseName(state.fileName)}_${String(p).padStart(3, '0')}.${format}`, await canvasToBytes(c, mime, 0.92));
      }
      assertCurrentDocument(token);
      downloadBytes(await zip.generateAsync({ type: 'blob' }), `${baseName(state.fileName)}_images.zip`, 'application/zip');
    }
    setStatus('画像へ書き出しました');
  } catch (e) { alertDialog('書き出しエラー', e.message);
  } finally { hideProgress(); }
}

export async function exportToText() {
  if (!hasDoc()) return;
  showProgress('テキストへ書き出し中...');
  try {
    const token = documentToken();
    const pdf = state.pdf;
    const pageCount = pdf.numPages;
    ensureBatchPageLimit(pageCount, 'テキスト書き出し');
    let out = '';
    for (let p = 1; p <= pageCount; p++) {
      const lines = await pageToLines(p, { token, pdf });
      out += lines.map(l => l.items.map(i => i.str).join('')).join('\n') + '\n\n';
    }
    assertCurrentDocument(token);
    downloadBytes(new TextEncoder().encode(out), `${baseName(state.fileName)}.txt`, 'text/plain');
    setStatus('テキストへ書き出しました');
  } catch (e) { alertDialog('書き出しエラー', e.message);
  } finally { hideProgress(); }
}
