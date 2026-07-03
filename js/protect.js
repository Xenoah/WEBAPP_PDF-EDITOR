// ===== 保護(パスワード・権限)/ 圧縮 / 文書プロパティ =====
import { state, PDFDocument, getLibDoc, applyBytes, hasDoc } from './state.js';
import { $, showDialog, showProgress, hideProgress, setStatus, downloadBytes, formatBytes, baseName, alertDialog, canvasToBytes } from './utils.js';
import { renderPageToCanvas } from './convert.js';

// ---------- 保護 ----------
export async function protectDialog() {
  if (!hasDoc()) { alertDialog('保護', '先にPDFを開いてください。'); return; }
  const opts = await showDialog('パスワードによる保護', `
    <label>文書を開くパスワード(ユーザーパスワード / 空欄で設定しない)</label>
    <input type="password" id="pw-user" autocomplete="new-password">
    <label>権限パスワード(オーナーパスワード / 空欄で設定しない)</label>
    <input type="password" id="pw-owner" autocomplete="new-password">
    <label style="margin-top:14px">許可する操作(権限制限)</label>
    <div class="check"><input type="checkbox" id="perm-print" checked><label for="perm-print" style="margin:0">印刷を許可</label></div>
    <div class="check"><input type="checkbox" id="perm-modify"><label for="perm-modify" style="margin:0">内容の変更を許可</label></div>
    <div class="check"><input type="checkbox" id="perm-copy" checked><label for="perm-copy" style="margin:0">テキスト・画像のコピーを許可</label></div>
    <div class="check"><input type="checkbox" id="perm-annot" checked><label for="perm-annot" style="margin:0">注釈の追加を許可</label></div>
    <p class="note" style="font-size:11px;opacity:.65;margin-top:10px;line-height:1.6">
      AES暗号化により保護されたPDFをダウンロードします。<br>
      権限制限のみの場合もオーナーパスワードの設定を推奨します。
    </p>
  `, [
    { label: 'キャンセル', value: null },
    {
      label: '保護してダウンロード', accent: true, onClick: b => ({
        user: b.querySelector('#pw-user').value,
        owner: b.querySelector('#pw-owner').value,
        printing: b.querySelector('#perm-print').checked,
        modifying: b.querySelector('#perm-modify').checked,
        copying: b.querySelector('#perm-copy').checked,
        annotating: b.querySelector('#perm-annot').checked,
      })
    },
  ]);
  if (!opts) return;
  if (!opts.user && !opts.owner) { alertDialog('保護', 'パスワードが入力されていません。少なくとも1つのパスワードを設定してください。'); return; }
  showProgress('暗号化中...');
  try {
    const doc = await getLibDoc();
    doc.encrypt({
      userPassword: opts.user || undefined,
      ownerPassword: opts.owner || opts.user,
      permissions: {
        printing: opts.printing ? 'highResolution' : false,
        modifying: opts.modifying,
        copying: opts.copying,
        annotating: opts.annotating,
        fillingForms: opts.annotating,
        documentAssembly: opts.modifying,
        contentAccessibility: true,
      },
    });
    const bytes = await doc.save({ useObjectStreams: false });
    downloadBytes(bytes, `${baseName(state.fileName)}_保護済み.pdf`);
    setStatus('保護されたPDFをダウンロードしました');
  } catch (e) {
    alertDialog('保護エラー', e.message);
  } finally { hideProgress(); }
}

// ---------- 圧縮 ----------
export async function compressDialog() {
  if (!hasDoc()) { alertDialog('圧縮', '先にPDFを開いてください。'); return; }
  const orig = state.bytes.length;
  const opts = await showDialog('PDFを圧縮', `
    <p style="margin-bottom:8px">現在のファイルサイズ: <b>${formatBytes(orig)}</b></p>
    <label>圧縮レベル</label>
    <select id="cmp-level">
      <option value="lossless">軽量化のみ(内容を変更しない・オブジェクト最適化)</option>
      <option value="high" selected>高画質(150dpi・画質80%)</option>
      <option value="mid">標準(110dpi・画質70%)</option>
      <option value="low">最小サイズ(72dpi・画質55%)</option>
    </select>
    <p class="note" style="font-size:11px;opacity:.65;margin-top:10px;line-height:1.6">
      「高画質/標準/最小」はページを画像として再構成します(テキスト情報は失われます)。<br>
      テキストを保持したい場合は「軽量化のみ」を選択してください。
    </p>
  `, [
    { label: 'キャンセル', value: null },
    { label: '圧縮', accent: true, onClick: b => b.querySelector('#cmp-level').value },
  ]);
  if (!opts) return;
  showProgress('圧縮中...', 0);
  try {
    let bytes;
    if (opts === 'lossless') {
      const doc = await getLibDoc();
      bytes = await doc.save({ useObjectStreams: true });
    } else {
      const cfg = { high: [150 / 72, 0.8], mid: [110 / 72, 0.7], low: [1, 0.55] }[opts];
      const out = await PDFDocument.create();
      const srcDoc = await getLibDoc();
      for (let p = 1; p <= state.pdf.numPages; p++) {
        showProgress(`圧縮中... ページ ${p}/${state.pdf.numPages}`, p / state.pdf.numPages);
        const c = await renderPageToCanvas(p, cfg[0]);
        const jpg = await out.embedJpg(await canvasToBytes(c, 'image/jpeg', cfg[1]));
        const { width, height } = srcDoc.getPage(p - 1).getSize();
        const page = out.addPage([width, height]);
        page.drawImage(jpg, { x: 0, y: 0, width, height });
      }
      bytes = await out.save({ useObjectStreams: true });
    }
    const saved = orig - bytes.length;
    const act = await showDialog('圧縮結果', `
      <table class="prop-table">
        <tr><td>元のサイズ</td><td>${formatBytes(orig)}</td></tr>
        <tr><td>圧縮後のサイズ</td><td><b>${formatBytes(bytes.length)}</b></td></tr>
        <tr><td>削減量</td><td>${saved > 0 ? `${formatBytes(saved)} (−${Math.round(saved / orig * 100)}%)` : '削減できませんでした'}</td></tr>
      </table>`, [
      { label: 'キャンセル', value: null },
      { label: 'ダウンロード', value: 'dl' },
      { label: 'この文書に適用', accent: true, value: 'apply' },
    ]);
    if (act === 'apply') {
      await applyBytes(bytes, '圧縮');
      setStatus(`圧縮しました: ${formatBytes(orig)} → ${formatBytes(bytes.length)}`);
    } else if (act === 'dl') {
      downloadBytes(bytes, `${baseName(state.fileName)}_圧縮済み.pdf`);
    }
  } catch (e) {
    alertDialog('圧縮エラー', e.message);
  } finally { hideProgress(); }
}

// ---------- 文書プロパティ ----------
export async function propertiesDialog() {
  if (!hasDoc()) return;
  const meta = await state.pdf.getMetadata().catch(() => ({ info: {} }));
  const info = meta.info || {};
  const page = await state.pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const fmt = d => { try { return d ? new Date(d).toLocaleString('ja-JP') : '—'; } catch { return '—'; } };
  await showDialog('文書のプロパティ', `
    <table class="prop-table">
      <tr><td>ファイル名</td><td>${state.fileName}</td></tr>
      <tr><td>タイトル</td><td>${info.Title || '—'}</td></tr>
      <tr><td>作成者</td><td>${info.Author || '—'}</td></tr>
      <tr><td>アプリケーション</td><td>${info.Creator || info.Producer || '—'}</td></tr>
      <tr><td>作成日</td><td>${fmt(info.CreationDate ? pdfDateToJs(info.CreationDate) : null)}</td></tr>
      <tr><td>更新日</td><td>${fmt(info.ModDate ? pdfDateToJs(info.ModDate) : null)}</td></tr>
      <tr><td>ページ数</td><td>${state.pdf.numPages}</td></tr>
      <tr><td>ページサイズ</td><td>${(vp.width / 72 * 25.4).toFixed(0)} × ${(vp.height / 72 * 25.4).toFixed(0)} mm (${vp.width.toFixed(0)} × ${vp.height.toFixed(0)} pt)</td></tr>
      <tr><td>ファイルサイズ</td><td>${formatBytes(state.bytes.length)}</td></tr>
      <tr><td>PDFバージョン</td><td>${info.PDFFormatVersion || '—'}</td></tr>
      <tr><td>暗号化</td><td>${info.IsEncrypted ? 'あり' : 'なし'}</td></tr>
    </table>
  `, [{ label: '閉じる', accent: true }]);
}

function pdfDateToJs(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
  if (!m) return s;
  return new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
}
