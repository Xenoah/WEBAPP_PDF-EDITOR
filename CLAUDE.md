# CLAUDE.md — 開発メモ / 仕様

## プロジェクト概要

Acrobat Pro 互換のオフライン Web PDF エディター。ビルドステップなし(素のES Modules + UMDベンダーライブラリ)。`node server.js` で起動、http://localhost:8080。

## 設計原則

1. **信頼できる情報源は PDF バイト列** (`state.bytes: Uint8Array`)。すべての編集は pdf-lib でバイト列を再生成 → `applyBytes()` → pdf.js で再表示。表示とデータが乖離しない。
2. **undo/redo はバイト列スナップショット**(最大30、`state.undoStack`)。
3. **完全オフライン**: CDN禁止。全ライブラリ・フォント・OCR辞書は `vendor/` に同梱。Service Worker (`sw.js`) がキャッシュ。
4. **既存要素の編集は白塗り+再描画方式**。コンテンツストリームの直接書き換えはしない(正確なフォント/エンコーディング復元が非現実的なため)。
5. UI文言は日本語、Acrobat Pro のコマンド名・ショートカットに合わせる。

## モジュール構成と要点

| ファイル | 役割 | 注意点 |
|---|---|---|
| `js/state.js` | 状態・undo/redo・pdf.js/pdf-lib間の橋渡し | `getDocument({data: bytes.slice()})` — pdf.jsはバッファを転送(破壊)するため必ずコピーを渡す |
| `js/viewer.js` | 表示・サムネイル・検索・印刷 | IntersectionObserverで遅延レンダリング。テキストレイヤーは自前実装(spanをscaleXで幅合わせ) |
| `js/organize.js` | ページ整理・結合・分割 | 移動は copyPages→removePage→insertPage。整理ビューは `#organize-view`(動的生成) |
| `js/annotate.js` | 注釈 | 未適用注釈は `state.pendingAnnots`(PDF座標)。適用時: 図形は描画で焼き込み、ノートのみ本物の `/Text` 注釈オブジェクト |
| `js/edit.js` | テキスト/画像編集 | 画像位置は `getOperatorList()` のCTM追跡で検出(`OPS.transform`/`paintImageXObject`、単位正方形×CTM) |
| `js/convert.js` | 作成/書き出し | docx/xlsx→HTML→SVG foreignObject→canvas→JPEG→PDF。ページ分割はブロック要素のoffsetTopで決定 |
| `js/ocr.js` | OCR | Tesseract v7: `createWorker(lang, 1, {workerPath, corePath, langPath, gzip})`。結果は `data.blocks` 階層から単語収集。不可視化は `opacity: 0` |
| `js/compare.js` | 比較 | pixelmatch(ESM, `vendor/pixelmatch.mjs`)+行単位LCS |
| `js/protect.js` | 保護/圧縮/プロパティ | 暗号化は @cantoo/pdf-lib の `doc.encrypt({userPassword, ownerPassword, permissions})` → `save({useObjectStreams:false})` |

## 重要なライブラリ知識

- **@cantoo/pdf-lib**(pdf-lib fork): `PDFDocument.load(bytes, {ignoreEncryption:true, password})` で暗号化PDF読込可。`doc.encrypt(SecurityOptions)` で AES 暗号化。グローバルは `window.PDFLib`。
- **pdf.js 4.x**: ESM のみ(`vendor/pdf.min.mjs`)。workerSrc 必須。パスワード付きPDFは `PasswordException`(`e.name`で判定)。
- **日本語テキスト描画**: pdf-lib標準フォント不可。`vendor/fonts/NotoSansJP-Regular.ttf`(Noto Sans Mono CJK JP)+ fontkit で `embedFont(bytes, {subset:true})`。
- **Tesseract.js 7**: 言語辞書は `vendor/tessdata/{eng,jpn}.traineddata.gz`。コアは `vendor/tesseract-core/`(SIMD版を自動選択)。
- **foreignObject レンダリング**: XMLSerializer で XHTML 化必須。外部リソースは読めないので画像は data URI のみ(mammoth はデフォルトで data URI)。

## 座標系

- PDF: 原点左下、単位pt(72dpi)。pdf.js viewport: 原点左上、CSS px。
- 変換: `viewport.convertToViewportPoint(px, py)` / `viewport.convertToPdfPoint(vx, vy)`。
- テキストアイテム: `transform[4],[5]` = ベースライン原点、フォントサイズ ≈ `hypot(transform[2], transform[3])`。

## やりかけ/今後の候補

- [ ] フォームフィールド(作成・入力)
- [ ] 電子署名
- [ ] 墨消し(現状は白塗りで代用可)
- [ ] PPTX→PDFのレイアウト忠実度向上(図形・画像の再現)
- [ ] しおり(アウトライン)パネル
- [ ] 注釈の再編集(適用後の焼き込みをFreeText/Ink注釈オブジェクトに変更する案)

## テスト

`test-smoke.html` がライブラリ統合のスモークテスト。実行方法:

```powershell
node server.js 8123   # 起動後、ブラウザで http://localhost:8123/test-smoke.html を開く
# ヘッドレス実行時は結果が POST /__log 経由で smoke-result.log に書き込まれる
```

検証項目: ①pdf-lib作成+日本語フォント埋め込み ②pdf.jsレンダリング+テキスト抽出 ③AES暗号化+パスワード再読込 ④Tesseract OCR。
注意: headlessの `--virtual-time-budget` ではpdf.jsワーカーが停止する。実時間実行+HTTP報告方式を使うこと。

## 落とし穴(修正済みバグの記録)

- **`hidden`属性 vs CSS `display`**: `#progress-overlay { display: flex }` などIDセレクタの明示displayはUAスタイルの `[hidden] { display: none }` に勝つため、**hidden属性が無効化され起動直後から「処理中...」が全画面表示**されていた(初回起動フリーズの正体)。対策: app.css先頭に `[hidden] { display: none !important; }`。overlay/dialog/findbarのようにJSで `hidden` を切り替える要素に明示displayを与える場合は必ずこの規則を維持すること。
- **検証はテキストではなく見た目で**: この不具合はヘッドレステストでstatus文言だけ確認していたため見逃した。UI変更時は `msedge --headless --screenshot` で起動画面のスクリーンショットを確認する。

- **進捗オーバーレイのデッドロック**: `#progress-overlay`(z-index 600)が `#dialog`(z-index 500)を覆うため、進捗表示中にダイアログを出すと操作不能=「処理中のまま固まる」。対策として `showDialog()` の先頭で必ず `hideProgress()` を呼ぶ(utils.js)。進捗中にダイアログを出すフロー(結合/圧縮/OCR完了)を追加する際もこの前提を守ること。
- **SWのキャッシュ戦略**: 当初の全ファイルキャッシュ優先だと修正が反映されない。v2でアプリ本体(js/css/html)=ネットワーク優先+キャッシュフォールバック、vendor/=キャッシュ優先に変更。**js/cssを変更したら `sw.js` の `CACHE` 名をバンプ不要**(ネットワーク優先のため)だが、vendor更新時はバンプが必要。
- OCRは日本語1ページ(300dpi)で数十秒かかる。Tesseractの `logger` で進捗%を表示しないと停止に見える。

## 進捗ログ

- 2026-07-04: 初期実装完了。全10要求機能(編集/作成/変換/整理/結合/注釈/OCR/比較/保護/圧縮)+ビューア・検索・印刷・undo/redo・オフライン対応(SW+ベンダリング)。
- 2026-07-04: スモークテスト4項目すべてPASS(日本語フォントPDF作成 55KB / テキスト抽出「日本語テストABC123」一致 / PasswordException→パスワード再読込OK / OCR "HELLO WORLD" 認識)。メインページはヘッドレスEdgeで全モジュールロード完了を確認。
- 2026-07-04: 「処理中のまま進まない」バグ修正。原因=進捗オーバーレイがダイアログを覆うデッドロック(結合/圧縮/OCRの完了時に発生)。併せて: OCR進捗%表示、書き出し/注釈適用/挿入/結合にエラーダイアログ追加、フォント取得のHTTPエラー検出、SWをネットワーク優先(アプリ本体)へ変更(v2)。
- 2026-07-04: 初回起動時から「処理中...」が全画面表示される致命バグ修正(`[hidden]`とCSS displayの優先度問題)。ヘッドレスEdgeのスクリーンショットで起動画面の正常表示を確認済み。
