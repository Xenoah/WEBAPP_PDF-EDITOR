// ===== 注釈: ハイライト・ノート・フリーハンド描画・図形・テキスト注釈 =====
// 注釈はまずオーバーレイ(pendingAnnots)に保持し、「注釈を適用」でPDFへ書き込む
import { state, getLibDoc, applyBytes, rgb, PDFName, PDFString, BlendMode, LineCapStyle } from './state.js';
import { $, $$, setStatus, showDialog, showProgress, hideProgress, hexToRgb01, getJapaneseFont } from './utils.js';
import { addOverlayHook, getPageView } from './viewer.js';

const ANNOT_TOOLS = ['highlight', 'note', 'draw', 'rect', 'ellipse', 'line', 'freetext'];

export function isAnnotTool(tool) { return ANNOT_TOOLS.includes(tool); }

export function init() {
  addOverlayHook(mountLayer);
}

// 各ページに注釈レイヤーを取り付ける
function mountLayer(pageIndex, wrap, viewport) {
  let layer = wrap.querySelector('.annot-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'annot-layer';
    layer.innerHTML = '<svg></svg>';
    wrap.appendChild(layer);
    attachEvents(layer, pageIndex);
  }
  layer._viewport = viewport;
  redrawLayer(pageIndex);
  updateLayerMode();
}

export function updateLayerMode() {
  const active = isAnnotTool(state.tool);
  $$('.annot-layer').forEach(l => {
    l.classList.toggle('active', active);
    l.style.pointerEvents = active ? 'auto' : 'none';
  });
  $('#apply-annots').style.display = state.pendingAnnots.length ? '' : 'none';
}

// ---------- 描画イベント ----------
function attachEvents(layer, pageIndex) {
  let start = null, tempEl = null, inkPts = null;

  const toLocal = e => {
    const r = layer.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  layer.addEventListener('mousedown', async e => {
    if (!isAnnotTool(state.tool) || e.button !== 0) return;
    e.preventDefault();
    const [x, y] = toLocal(e);
    if (state.tool === 'note') { await placeNote(layer, pageIndex, x, y); return; }
    if (state.tool === 'freetext') { placeFreeText(layer, pageIndex, x, y); return; }
    start = [x, y];
    inkPts = state.tool === 'draw' ? [[x, y]] : null;
    const svg = layer.querySelector('svg');
    tempEl = document.createElementNS('http://www.w3.org/2000/svg', state.tool === 'draw' ? 'polyline' : state.tool === 'line' ? 'line' : state.tool === 'ellipse' ? 'ellipse' : 'rect');
    styleShape(tempEl, state.tool, state.annotColor);
    svg.appendChild(tempEl);
  });

  layer.addEventListener('mousemove', e => {
    if (!start || !tempEl) return;
    const [x, y] = toLocal(e);
    if (state.tool === 'draw') {
      inkPts.push([x, y]);
      tempEl.setAttribute('points', inkPts.map(p => p.join(',')).join(' '));
    } else if (state.tool === 'line') {
      tempEl.setAttribute('x1', start[0]); tempEl.setAttribute('y1', start[1]);
      tempEl.setAttribute('x2', x); tempEl.setAttribute('y2', y);
    } else if (state.tool === 'ellipse') {
      tempEl.setAttribute('cx', (start[0] + x) / 2); tempEl.setAttribute('cy', (start[1] + y) / 2);
      tempEl.setAttribute('rx', Math.abs(x - start[0]) / 2); tempEl.setAttribute('ry', Math.abs(y - start[1]) / 2);
    } else {
      tempEl.setAttribute('x', Math.min(start[0], x)); tempEl.setAttribute('y', Math.min(start[1], y));
      tempEl.setAttribute('width', Math.abs(x - start[0])); tempEl.setAttribute('height', Math.abs(y - start[1]));
    }
  });

  const finish = e => {
    if (!start || !tempEl) return;
    const [x, y] = toLocal(e);
    const vp = layer._viewport;
    const toPdf = (vx, vy) => vp.convertToPdfPoint(vx, vy);
    const color = state.annotColor;
    if (state.tool === 'draw' && inkPts.length > 1) {
      state.pendingAnnots.push({ page: pageIndex, kind: 'ink', color, points: inkPts.map(p => toPdf(p[0], p[1])) });
    } else if (state.tool === 'line') {
      state.pendingAnnots.push({ page: pageIndex, kind: 'line', color, from: toPdf(start[0], start[1]), to: toPdf(x, y) });
    } else if (Math.abs(x - start[0]) > 4 && Math.abs(y - start[1]) > 4) {
      const [x1, y1] = toPdf(Math.min(start[0], x), Math.max(start[1], y)); // PDF左下
      const [x2, y2] = toPdf(Math.max(start[0], x), Math.min(start[1], y)); // PDF右上
      state.pendingAnnots.push({ page: pageIndex, kind: state.tool === 'ellipse' ? 'ellipse' : state.tool === 'highlight' ? 'highlight' : 'rect', color, rect: [x1, y1, x2, y2] });
    }
    tempEl.remove(); tempEl = null; start = null; inkPts = null;
    redrawLayer(pageIndex);
    updateLayerMode();
  };
  layer.addEventListener('mouseup', finish);
  layer.addEventListener('mouseleave', e => { if (start) finish(e); });
}

function styleShape(el, tool, color) {
  if (tool === 'highlight') {
    el.setAttribute('fill', color); el.setAttribute('fill-opacity', '0.4'); el.setAttribute('stroke', 'none');
  } else {
    el.setAttribute('fill', 'none'); el.setAttribute('stroke', color); el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
  }
}

// ---------- ノート注釈 ----------
async function placeNote(layer, pageIndex, x, y) {
  const text = await showDialog('ノート注釈を追加', `
    <label>コメント</label>
    <textarea id="note-text" rows="5" style="width:100%;background:#202124;color:#fff;border:1px solid #4a4e51;border-radius:4px;padding:8px"></textarea>
  `, [
    { label: 'キャンセル', value: null },
    { label: '追加', accent: true, onClick: b => b.querySelector('#note-text').value || null },
  ]);
  if (!text) return;
  const vp = layer._viewport;
  state.pendingAnnots.push({ page: pageIndex, kind: 'note', color: state.annotColor, at: vp.convertToPdfPoint(x, y), text });
  redrawLayer(pageIndex);
  updateLayerMode();
}

// ---------- フリーテキスト ----------
function placeFreeText(layer, pageIndex, x, y) {
  const div = document.createElement('div');
  div.className = 'annot-freetext';
  div.contentEditable = 'true';
  div.style.left = `${x}px`; div.style.top = `${y}px`;
  div.style.color = state.annotColor;
  div.style.fontSize = `${16 * layer._viewport.scale / 1.5}px`;
  layer.appendChild(div);
  div.focus();
  const commit = () => {
    const text = div.textContent.trim();
    if (text) {
      const vp = layer._viewport;
      const fontPx = parseFloat(div.style.fontSize);
      state.pendingAnnots.push({ page: pageIndex, kind: 'freetext', color: state.annotColor, at: vp.convertToPdfPoint(x, y + fontPx), text, size: fontPx / vp.scale });
    }
    div.remove();
    redrawLayer(pageIndex);
    updateLayerMode();
  };
  div.addEventListener('blur', commit);
  div.addEventListener('keydown', e => { if (e.key === 'Escape') { div.textContent = ''; div.blur(); } });
}

// ---------- 再描画(pendingAnnotsをオーバーレイ表示) ----------
export function redrawLayer(pageIndex) {
  const pv = getPageView(pageIndex);
  const layer = pv?.wrap.querySelector('.annot-layer');
  if (!layer) return;
  const vp = layer._viewport;
  const svg = layer.querySelector('svg');
  svg.innerHTML = '';
  layer.querySelectorAll('.annot-note').forEach(n => n.remove());
  state.pendingAnnots.forEach((a, ai) => {
    if (a.page !== pageIndex) return;
    const toV = pt => vp.convertToViewportPoint(pt[0], pt[1]);
    let el = null;
    if (a.kind === 'ink') {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      el.setAttribute('points', a.points.map(p => toV(p).join(',')).join(' '));
      styleShape(el, 'draw', a.color);
    } else if (a.kind === 'line') {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const f = toV(a.from), t = toV(a.to);
      el.setAttribute('x1', f[0]); el.setAttribute('y1', f[1]); el.setAttribute('x2', t[0]); el.setAttribute('y2', t[1]);
      styleShape(el, 'line', a.color);
    } else if (a.kind === 'rect' || a.kind === 'highlight' || a.kind === 'ellipse') {
      const p1 = toV([a.rect[0], a.rect[3]]), p2 = toV([a.rect[2], a.rect[1]]);
      const [x, y, w, h] = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.abs(p2[0] - p1[0]), Math.abs(p2[1] - p1[1])];
      if (a.kind === 'ellipse') {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        el.setAttribute('cx', x + w / 2); el.setAttribute('cy', y + h / 2);
        el.setAttribute('rx', w / 2); el.setAttribute('ry', h / 2);
      } else {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('width', w); el.setAttribute('height', h);
      }
      styleShape(el, a.kind === 'highlight' ? 'highlight' : a.kind, a.color);
    } else if (a.kind === 'freetext') {
      const [x, y] = toV(a.at);
      el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      el.textContent = a.text;
      el.setAttribute('x', x); el.setAttribute('y', y);
      el.setAttribute('fill', a.color);
      el.setAttribute('font-size', a.size * vp.scale);
      el.setAttribute('font-family', 'sans-serif');
    } else if (a.kind === 'note') {
      const [x, y] = toV(a.at);
      const div = document.createElement('div');
      div.className = 'annot-note';
      div.textContent = '💬';
      div.title = a.text;
      div.style.left = `${x - 11}px`; div.style.top = `${y - 11}px`;
      div.dataset.ai = ai;
      div.addEventListener('dblclick', () => removeAnnot(ai));
      layer.appendChild(div);
    }
    if (el) {
      el.dataset.ai = ai;
      el.style.pointerEvents = 'auto';
      el.addEventListener('dblclick', () => removeAnnot(ai));
      svg.appendChild(el);
    }
  });
}

function removeAnnot(ai) {
  const a = state.pendingAnnots[ai];
  if (!a) return;
  state.pendingAnnots.splice(ai, 1);
  redrawLayer(a.page);
  updateLayerMode();
  setStatus('注釈を削除しました(未適用の注釈はダブルクリックで削除できます)');
}

// ---------- PDFへ適用 ----------
export async function applyAnnotations() {
  if (!state.pendingAnnots.length) return;
  showProgress('注釈をPDFへ適用中...');
  try {
    const doc = await getLibDoc();
    let font = null;
    const needFont = state.pendingAnnots.some(a => a.kind === 'freetext');
    if (needFont) {
      doc.registerFontkit(window.fontkit);
      font = await doc.embedFont(await getJapaneseFont(), { subset: true });
    }
    for (const a of state.pendingAnnots) {
      const page = doc.getPage(a.page);
      const [r, g, b] = hexToRgb01(a.color);
      const color = rgb(r, g, b);
      if (a.kind === 'highlight') {
        page.drawRectangle({
          x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1],
          color, opacity: 0.45, blendMode: BlendMode.Multiply,
        });
      } else if (a.kind === 'rect') {
        page.drawRectangle({ x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1], borderColor: color, borderWidth: 2 });
      } else if (a.kind === 'ellipse') {
        page.drawEllipse({ x: (a.rect[0] + a.rect[2]) / 2, y: (a.rect[1] + a.rect[3]) / 2, xScale: (a.rect[2] - a.rect[0]) / 2, yScale: (a.rect[3] - a.rect[1]) / 2, borderColor: color, borderWidth: 2 });
      } else if (a.kind === 'line') {
        page.drawLine({ start: { x: a.from[0], y: a.from[1] }, end: { x: a.to[0], y: a.to[1] }, color, thickness: 2, lineCap: LineCapStyle.Round });
      } else if (a.kind === 'ink') {
        for (let i = 1; i < a.points.length; i++) {
          page.drawLine({ start: { x: a.points[i - 1][0], y: a.points[i - 1][1] }, end: { x: a.points[i][0], y: a.points[i][1] }, color, thickness: 2, lineCap: LineCapStyle.Round });
        }
      } else if (a.kind === 'freetext') {
        page.drawText(a.text, { x: a.at[0], y: a.at[1], size: a.size || 12, font, color });
      } else if (a.kind === 'note') {
        // 本物の /Text 注釈(ポップアップノート)として追加 — Acrobat互換
        const annot = doc.context.obj({
          Type: 'Annot', Subtype: 'Text',
          Rect: [a.at[0], a.at[1], a.at[0] + 20, a.at[1] + 20],
          Contents: PDFString.of(a.text),
          T: PDFString.of('PDF Editor Pro'),
          Name: 'Comment',
          C: [r, g, b], CA: 1, F: 4,
          M: PDFString.fromDate(new Date()),
        });
        const ref = doc.context.register(annot);
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (annots) annots.push(ref);
        else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
      }
    }
    const count = state.pendingAnnots.length;
    state.pendingAnnots = [];
    await applyBytes(await doc.save(), '注釈を適用');
    setStatus(`${count}個の注釈をPDFへ適用しました`);
  } finally { hideProgress(); }
}
