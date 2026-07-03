// ===== 依存ゼロのローカル静的サーバー (オフライン起動用) =====
// 使い方: node server.js [port]  →  http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +(process.argv[2] || 8080);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.pdf': 'application/pdf',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // スモークテスト用ログ受信 (test-smoke.html が結果をPOSTする)
  if (req.method === 'POST' && urlPath === '/__log') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      fs.appendFileSync(path.join(ROOT, 'smoke-result.log'), body + '\n');
      res.writeHead(204); res.end();
    });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(ROOT, path.normalize(urlPath).replace(/^([.][.][\\/])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // SharedArrayBuffer等が必要になった場合に備えたCOOP/COEP
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`PDF Editor Pro: http://localhost:${PORT} で起動しました (Ctrl+Cで終了)`);
});
