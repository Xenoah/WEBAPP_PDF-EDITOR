// ===== アプリ状態(単一ドキュメントの信頼できる情報源はPDFバイト列) =====
import * as pdfjsLib from '../vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

export { pdfjsLib };
export const { PDFDocument, rgb, degrees, StandardFonts, PDFName, PDFString, PDFHexString, PDFArray, PDFNumber, BlendMode, LineCapStyle } = window.PDFLib;

const MAX_UNDO = 30;

export const state = {
  bytes: null,          // Uint8Array — 現在のPDF(信頼できる情報源)
  pdf: null,            // pdf.js のドキュメント
  fileName: 'untitled.pdf',
  password: null,       // 開いた際のパスワード(再読込用)
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

export function resetDocumentScope({ keepPassword = false } = {}) {
  state.currentPage = 1;
  state.zoom = 1;
  state.zoomMode = 'value';
  state.viewRotation = 0;
  state.tool = 'select';
  if (!keepPassword) state.password = null;
  state.pendingAnnots = [];
}

// PDFバイト列を読み込み、pdf.jsドキュメントを更新する
export async function loadBytes(bytes, { fileName, password, resetHistory = false } = {}) {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), password: password ?? state.password ?? undefined });
  const pdf = await task.promise;
  if (state.pdf) state.pdf.destroy();
  if (resetHistory) resetDocumentScope({ keepPassword: password !== undefined });
  state.bytes = bytes;
  state.pdf = pdf;
  if (fileName) state.fileName = fileName;
  if (password !== undefined) state.password = password;
  if (resetHistory) { state.undoStack = []; state.redoStack = []; state.pendingAnnots = []; }
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
  state.undoStack = [];
  state.redoStack = [];
  resetDocumentScope();
  state.docGeneration++;
  emit();
}

// 変更を適用(undo履歴に積む)
export async function applyBytes(newBytes, label = '') {
  state.undoStack.push(state.bytes);
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack = [];
  await loadBytes(newBytes);
  return label;
}

export async function undo() {
  if (!state.undoStack.length) return false;
  state.redoStack.push(state.bytes);
  await loadBytes(state.undoStack.pop());
  return true;
}
export async function redo() {
  if (!state.redoStack.length) return false;
  state.undoStack.push(state.bytes);
  await loadBytes(state.redoStack.pop());
  return true;
}

// 現在のバイト列から pdf-lib ドキュメントを得る
export async function getLibDoc() {
  return PDFDocument.load(state.bytes.slice(), { ignoreEncryption: true, password: state.password ?? undefined, updateMetadata: false });
}

export function hasDoc() { return !!state.pdf; }
