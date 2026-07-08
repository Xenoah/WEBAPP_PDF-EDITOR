// ===== PDF比較: 2つのPDFのピクセル差分 + テキスト差分 =====
import { state, pdfjsLib, hasDoc } from './state.js';
import { $, showDialog, showProgress, hideProgress, pickFile, alertDialog, escapeHTML, LIMITS, validateFiles, assertCanvasSize } from './utils.js';
import pixelmatch from '../vendor/pixelmatch.mjs';

export async function compareDialog() {
  const fileA = hasDoc() ? null : await pickFile('.pdf');
  if (!hasDoc() && !fileA) return;
  const fileB = await pickFileWithMessage();
  if (!fileB) return;
  validateFiles([fileA, fileB].filter(Boolean));

  showProgress('比較を準備中...');
  let pdfA = null, pdfB = null;
  let ownPdfA = false;
  try {
    if (hasDoc()) pdfA = state.pdf;
    else {
      pdfA = await (pdfjsLib.getDocument({ data: new Uint8Array(await fileA.arrayBuffer()) })).promise;
      ownPdfA = true;
    }
    pdfB = await (pdfjsLib.getDocument({ data: new Uint8Array(await fileB.arrayBuffer()) })).promise;

    const nameA = hasDoc() ? state.fileName : fileA.name;
    const results = [];
    const n = Math.max(pdfA.numPages, pdfB.numPages);
    if (n > LIMITS.maxBatchPages) {
      throw new Error(`比較できるのは${LIMITS.maxBatchPages}ページまでです (${n}ページ)。範囲を分けて比較してください。`);
    }
    for (let p = 1; p <= n; p++) {
      showProgress(`比較中... ページ ${p}/${n}`, p / n);
      results.push(await comparePage(pdfA, pdfB, p));
    }
    hideProgress();
    await showResults(nameA, fileB.name, results);
  } catch (e) {
    hideProgress();
    alertDialog('比較エラー', e.message);
  } finally {
    if (ownPdfA) await pdfA?.destroy?.().catch(() => {});
    await pdfB?.destroy?.().catch(() => {});
  }
}

async function pickFileWithMessage() {
  await new Promise(r => setTimeout(r, 50));
  return pickFile('.pdf');
}

async function renderAt(pdf, pageNum, width) {
  if (pageNum > pdf.numPages) return null;
  const page = await pdf.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  assertCanvasSize(vp.width, vp.height, `比較ページ${pageNum}`);
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}

async function pageText(pdf, pageNum) {
  if (pageNum > pdf.numPages) return [];
  const page = await pdf.getPage(pageNum);
  const tc = await page.getTextContent();
  const lines = new Map();
  for (const it of tc.items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 4) * 4;
    lines.set(y, (lines.get(y) || '') + it.str);
  }
  return [...lines.entries()].sort((a, b) => b[0] - a[0]).map(e => e[1]);
}

async function comparePage(pdfA, pdfB, p) {
  const W = 560;
  const ca = await renderAt(pdfA, p, W);
  const cb = await renderAt(pdfB, p, W);
  const w = Math.max(ca?.width ?? 0, cb?.width ?? 0);
  const h = Math.max(ca?.height ?? 0, cb?.height ?? 0);
  const norm = c => {
    const nc = document.createElement('canvas');
    nc.width = w; nc.height = h;
    const ctx = nc.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    if (c) ctx.drawImage(c, 0, 0);
    return nc;
  };
  const na = norm(ca), nb = norm(cb);
  const da = na.getContext('2d').getImageData(0, 0, w, h);
  const db = nb.getContext('2d').getImageData(0, 0, w, h);
  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = w; diffCanvas.height = h;
  const dctx = diffCanvas.getContext('2d');
  const diffData = dctx.createImageData(w, h);
  const diffPixels = pixelmatch(da.data, db.data, diffData.data, w, h, { threshold: 0.12, diffColor: [217, 48, 37], alpha: 0.25 });
  dctx.putImageData(diffData, 0, 0);

  // テキスト差分 (行単位LCS)
  const [ta, tb] = [await pageText(pdfA, p), await pageText(pdfB, p)];
  const textDiff = lineDiff(ta, tb);

  return { page: p, a: na, b: nb, diff: diffCanvas, diffPixels, total: w * h, textDiff, missing: !ca ? 'A' : !cb ? 'B' : null };
}

// 行単位のLCS差分
function lineDiff(a, b) {
  const m = a.length, n = b.length;
  if (m * n > 250000) {
    return [{ type: 'del', text: 'テキスト差分が大きすぎるため、行単位の詳細比較を省略しました。' }];
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

function showResults(nameA, nameB, results) {
  const changed = results.filter(r => r.diffPixels / r.total > 0.0005 || r.textDiff.length || r.missing);
  let cur = 0;
  const pages = changed.length ? changed : results;
  const safeNameA = escapeHTML(nameA);
  const safeNameB = escapeHTML(nameB);

  const render = () => {
    const r = pages[cur];
    const body = $('#dialog-body');
    const pct = ((r.diffPixels / r.total) * 100).toFixed(2);
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div>変更ページ: <b>${changed.length}</b> / ${results.length} — 表示中: ページ${r.page}(差分 ${pct}%${r.missing ? ` / ${r.missing === 'A' ? '旧' : '新'}版にページなし` : ''})</div>
        <div>
          <button id="cmp-prev" style="border:1px solid #4a4e51;padding:4px 12px">◀ 前</button>
          <span style="margin:0 8px">${cur + 1} / ${pages.length}</span>
          <button id="cmp-next" style="border:1px solid #4a4e51;padding:4px 12px">次 ▶</button>
        </div>
      </div>
      <div class="compare-grid">
        <div><canvas id="cmp-a"></canvas><div class="cap">旧: ${safeNameA}</div></div>
        <div><canvas id="cmp-b"></canvas><div class="cap">新: ${safeNameB}</div></div>
        <div><canvas id="cmp-d"></canvas><div class="cap">差分(赤 = 変更箇所)</div></div>
      </div>
      ${r.textDiff.length ? `<div class="diff-text-report">${r.textDiff.map(d =>
        `<div class="${d.type}">${d.type === 'add' ? '+ ' : '− '}${escapeHtml(d.text)}</div>`).join('')}</div>` : '<p style="opacity:.6;margin-top:10px">このページにテキストの差分はありません。</p>'}
    `;
    for (const [id, src] of [['#cmp-a', r.a], ['#cmp-b', r.b], ['#cmp-d', mergeDiff(r.b, r.diff)]]) {
      const dst = body.querySelector(id);
      dst.width = src.width; dst.height = src.height;
      dst.getContext('2d').drawImage(src, 0, 0);
    }
    body.querySelector('#cmp-prev').onclick = () => { cur = (cur - 1 + pages.length) % pages.length; render(); };
    body.querySelector('#cmp-next').onclick = () => { cur = (cur + 1) % pages.length; render(); };
  };

  const done = showDialog(`比較結果 — ${changed.length ? `${changed.length}ページに差分があります` : '差分は検出されませんでした'}`, '', [
    { label: '閉じる', accent: true },
  ]);
  render();
  return done;
}

function mergeDiff(base, diff) {
  const c = document.createElement('canvas');
  c.width = base.width; c.height = base.height;
  const ctx = c.getContext('2d');
  ctx.globalAlpha = 0.35;
  ctx.drawImage(base, 0, 0);
  ctx.globalAlpha = 1;
  ctx.drawImage(diff, 0, 0);
  return c;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
