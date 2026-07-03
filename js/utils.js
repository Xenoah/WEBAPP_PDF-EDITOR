// ===== 共通ユーティリティ =====
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function setStatus(msg) { $('#status-msg').textContent = msg; }

let progressDepth = 0;
export function showProgress(label, ratio = null) {
  progressDepth = 1;
  const ov = $('#progress-overlay');
  ov.hidden = false;
  $('#progress-label').textContent = label;
  $('#progress-bar').style.width = ratio == null ? '100%' : `${Math.round(ratio * 100)}%`;
}
export function hideProgress() {
  progressDepth = 0;
  $('#progress-overlay').hidden = true;
}

// ---- ダイアログ ----
export function showDialog(title, bodyHTML, actions) {
  // 進捗オーバーレイ(z-index 600)がダイアログ(z-index 500)を覆って操作不能になるのを防ぐ:
  // ダイアログはユーザー操作を要求するため、表示時点で必ず進捗を閉じる
  hideProgress();
  return new Promise(resolve => {
    $('#dialog-title').textContent = title;
    $('#dialog-body').innerHTML = bodyHTML;
    const act = $('#dialog-actions');
    act.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.accent) b.className = 'accent';
      b.addEventListener('click', () => {
        const keep = a.onClick ? a.onClick($('#dialog-body')) : a.value;
        if (keep === '__KEEP_OPEN__') return;
        closeDialog();
        resolve(keep ?? a.value ?? null);
      });
      act.appendChild(b);
    }
    $('#dialog-backdrop').hidden = false;
    const first = $('#dialog-body input, #dialog-body select, #dialog-body button');
    if (first) first.focus();
  });
}
export function closeDialog() { $('#dialog-backdrop').hidden = true; }

export function alertDialog(title, msg) {
  return showDialog(title, `<p style="line-height:1.7">${msg}</p>`, [{ label: 'OK', accent: true }]);
}
export function confirmDialog(title, msg) {
  return showDialog(title, `<p style="line-height:1.7">${msg}</p>`,
    [{ label: 'キャンセル', value: false }, { label: 'OK', accent: true, value: true }]);
}

// ---- ファイル ----
export function pickFile(accept, multiple = false) {
  return new Promise(resolve => {
    const inp = $('#file-input');
    inp.value = '';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.onchange = () => resolve(multiple ? [...inp.files] : inp.files[0] || null);
    inp.click();
  });
}

export function downloadBytes(bytes, fileName, mime = 'application/pdf') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFileAsArrayBuffer(file) {
  return file.arrayBuffer();
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export function baseName(name) { return name.replace(/\.[^.]+$/, ''); }

export function hexToRgb01(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 0.88, 0];
}

// ページ範囲文字列 "1-3,5,8-10" → 0始まりindex配列
export function parsePageRange(str, pageCount) {
  const out = new Set();
  if (!str || !str.trim()) return [...Array(pageCount).keys()];
  for (const part of str.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Math.max(1, +m[1]), b = Math.min(pageCount, +(m[2] ?? m[1]));
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

// canvas → Uint8Array (PNG/JPEG)
export function canvasToBytes(canvas, type = 'image/png', quality) {
  return new Promise(resolve => {
    canvas.toBlob(async blob => resolve(new Uint8Array(await blob.arrayBuffer())), type, quality);
  });
}

let notoFontBytes = null;
export async function getJapaneseFont() {
  if (!notoFontBytes) {
    const res = await fetch('vendor/fonts/NotoSansJP-Regular.ttf');
    if (!res.ok) throw new Error(`日本語フォントの読込に失敗しました (HTTP ${res.status})`);
    notoFontBytes = await res.arrayBuffer();
  }
  return notoFontBytes;
}
