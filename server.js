// ===== Zero-dependency local static server for offline use =====
// Usage: node server.js [port] [host]
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +(process.argv[2] || process.env.PORT || 8080);
const HOST = process.argv[3] || process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const LOG_LIMIT = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.pdf': 'application/pdf',
};

const PUBLIC_EXTS = new Set(Object.keys(MIME));
const PUBLIC_DIRS = new Set(['css', 'js', 'vendor']);
const PUBLIC_FILES = new Set(['index.html', 'manifest.json', 'sw.js', 'test-smoke.html']);

function send(res, status, body = '') {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  res.end(body);
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAllowedFile(file) {
  const rel = path.relative(ROOT, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.some(p => p.startsWith('.'))) return false;
  if (parts.includes('node_modules')) return false;
  if (parts.length === 1) return PUBLIC_FILES.has(parts[0]);
  return PUBLIC_DIRS.has(parts[0]) && PUBLIC_EXTS.has(path.extname(file).toLowerCase());
}

function handleLog(req, res) {
  if (!isLocalRequest(req)) return send(res, 403, 'Forbidden');
  const lengthHeader = req.headers['content-length'];
  if (lengthHeader !== undefined && !/^\d+$/.test(lengthHeader)) return send(res, 400, 'Bad Request');
  const declared = Number(lengthHeader || 0);
  if (declared > LOG_LIMIT) return send(res, 413, 'Payload Too Large');

  let size = 0;
  const chunks = [];
  req.on('data', chunk => {
    size += chunk.length;
    if (size > LOG_LIMIT) {
      send(res, 413, 'Payload Too Large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    fs.appendFile(path.join(ROOT, 'smoke-result.log'), Buffer.concat(chunks).toString('utf8') + '\n', err => {
      if (err) return send(res, 500, 'Log write failed');
      res.writeHead(204, {
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
    });
  });
  req.on('error', () => send(res, 400, 'Bad Request'));
}

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }

  if (req.method === 'POST' && urlPath === '/__log') return handleLog(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.split('/').some(segment => segment === '..')) return send(res, 403, 'Forbidden');

  const normalized = path.normalize(urlPath).replace(/^([.][.][\\/])+/, '').replace(/^[\\/]+/, '');
  const file = path.resolve(ROOT, normalized);
  if (!isAllowedFile(file)) return send(res, 403, 'Forbidden');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
}).listen(PORT, HOST, () => {
  console.log(`PDF Editor Pro: http://${HOST}:${PORT} (Ctrl+C to stop)`);
});
