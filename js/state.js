// ===== アプリ状態(単一ドキュメントの信頼できる情報源はPDFバイト列) =====
import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { LIMITS } from './utils.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

export { pdfjsLib };
export const { PDFDocument, rgb, degrees, StandardFonts, PDFName, PDFString, PDFHexString, PDFArray, PDFNumber, BlendMode, LineCapStyle } = window.PDFLib;

const MAX_UNDO = 30;
const MAX_UNDO_BYTES = 256 * 1024 * 1024;

export const state = {
  bytes: null,          // Uint8Array — 現在のPDF(信頼できる情報源)
  pdf: null,            // pdf.js のドキュメント
  fileName: 'untitled.pdf',
  password: null,       // 開いた際のパスワード(再読込用)
  isEncrypted: false,
  currentPage: 1,
  zoom: 1,
  zoomMode: 'value',    // value | fit | width
  viewRotation: 0,
  tool: 'select',       // select | hand | highlight | note | draw | rect | ellipse | line | freetext | edit
  annotColor: '#ffe100',
  pendingAnnots: [],    // 未適用の注釈 {page, kind, ...} PDF座標系
  undoStack: [],
  redoStack: [],
  listeners: new Set(),
  docGeneration: 0,
};

export function onDocChange(fn) { state.listeners.add(fn); }
function emit() { for (const fn of state.listeners) fn(); }

export function documentToken() {
  return { generation: state.docGeneration, pdf: state.pdf, bytes: state.bytes };
}

export function assertCurrentDocument(token) {
  if (!token) return;
  if (token.generation !== state.docGeneration || token.pdf !== state.pdf || token.bytes !== state.bytes) {
    throw new Error('処理中に文書が変更されたため、結果を破棄しました。もう一度実行してください。');
  }
}

export function ensureCanRewritePdf(action = '編集') {
  if (!state.pdf || !state.bytes) throw new Error('PDFが開かれていません。');
  if (state.isEncrypted) {
    throw new Error(`保護されたPDFは${action}できません。暗号化を解除したPDFを開くか、保護機能で新しい保護PDFとして保存してください。`);
  }
}

function pruneUndoStack() {
  while (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  let total = state.undoStack.reduce((sum, bytes) => sum + (bytes?.byteLength || bytes?.length || 0), 0);
  while (state.undoStack.length > 1 && total > MAX_UNDO_BYTES) {
    const removed = state.undoStack.shift();
    total -= removed?.byteLength || removed?.length || 0;
  }
}

export function resetDocumentScope({ keepPassword = false } = {}) {
  state.currentPage = 1;
  state.zoom = 1;
  state.zoomMode = 'value';
  state.viewRotation = 0;
  state.tool = 'select';
  if (!keepPassword) state.password = null;
  if (!keepPassword) state.isEncrypted = false;
  state.pendingAnnots = [];
}

// PDFバイト列を読み込み、pdf.jsドキュメントを更新する
export async function loadBytes(bytes, { fileName, password, resetHistory = false, pendingAnnots } = {}) {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), password: password ?? state.password ?? undefined });
  const pdf = await task.promise;
  if (pdf.numPages > LIMITS.maxPdfPages) {
    await pdf.destroy();
    throw new Error(`ページ数が多すぎます (${pdf.numPages}ページ / 上限 ${LIMITS.maxPdfPages}ページ)`);
  }
  const metadata = await pdf.getMetadata().catch(() => ({ info: {} }));
  if (state.pdf) state.pdf.destroy();
  if (resetHistory) resetDocumentScope({ keepPassword: password !== undefined });
  state.bytes = bytes;
  state.pdf = pdf;
  if (fileName) state.fileName = fileName;
  if (password !== undefined) state.password = password;
  state.isEncrypted = !!metadata?.info?.IsEncrypted || (password !== null && password !== undefined);
  if (resetHistory) { state.undoStack = []; state.redoStack = []; state.pendingAnnots = []; }
  else if (pendingAnnots !== undefined) state.pendingAnnots = pendingAnnots;
  if (state.currentPage > pdf.numPages) state.currentPage = pdf.numPages;
  if (state.currentPage < 1) state.currentPage = 1;
  state.docGeneration++;
  emit();
  return pdf;
}

export function closeDocument() {
  if (state.pdf) state.pdf.destroy();
  state.pdf = null;
  state.bytes = null;
  state.fileName = 'untitled.pdf';
  state.isEncrypted = false;
  state.undoStack = [];
  state.redoStack = [];
  resetDocumentScope();
  state.docGeneration++;
  emit();
}

// 変更を適用(undo履歴に積む)
export async function applyBytes(newBytes, label = '', { token, allowPendingAnnots = false, pendingAnnots } = {}) {
  assertCurrentDocument(token);
  ensureCanRewritePdf(label || '編集');
  if (state.pendingAnnots.length && !allowPendingAnnots) {
    throw new Error('未適用の注釈があります。先に注釈を適用するか、文書を開き直して破棄してから実行してください。');
  }
  state.undoStack.push(state.bytes);
  pruneUndoStack();
  state.redoStack = [];
  await loadBytes(newBytes, { pendingAnnots: pendingAnnots ?? state.pendingAnnots });
  return label;
}

export async function undo() {
  if (!state.undoStack.length) return false;
  if (state.pendingAnnots.length) throw new Error('未適用の注釈があるためUndoできません。先に注釈を適用するか破棄してください。');
  state.redoStack.push(state.bytes);
  pruneUndoStack();
  await loadBytes(state.undoStack.pop());
  return true;
}
export async function redo() {
  if (!state.redoStack.length) return false;
  if (state.pendingAnnots.length) throw new Error('未適用の注釈があるためRedoできません。先に注釈を適用するか破棄してください。');
  state.undoStack.push(state.bytes);
  pruneUndoStack();
  await loadBytes(state.redoStack.pop());
  return true;
}

// 現在のバイト列から pdf-lib ドキュメントを得る
export async function getLibDoc({ token, allowEncrypted = false, action = '編集' } = {}) {
  assertCurrentDocument(token);
  if (!allowEncrypted) ensureCanRewritePdf(action);
  return PDFDocument.load(state.bytes.slice(), { password: state.password ?? undefined, updateMetadata: false });
}

export function hasDoc() { return !!state.pdf; }
