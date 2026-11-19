// Static server for local viewing and the tests. Supports HTTP Range requests, which the
// PMTiles basemap archive needs. Usage: npm run serve  (PORT=8766 by default, loopback only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pbf': 'application/x-protobuf',
  '.pmtiles': 'application/octet-stream',
};

function send(res, status, headers = {}, body = '') {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

// A synchronous interceptor may handle a request and return true. Report fixture errors separately
// from their HTTP response, so a broken fixture cannot pass as an expected network failure.
export function startServer(root, port = 0, host = '127.0.0.1', intercept = null, {
  onInterceptError = error => console.error('Request interceptor failed:', error),
} = {}) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    try {
      if (intercept && intercept(req, res)) return;
    } catch (error) {
      onInterceptError(error);
      if (!res.writableEnded && !res.destroyed) {
        if (res.headersSent) res.destroy();
        else send(res, 500, {}, 'Request interceptor failed');
      }
      return;
    }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return send(res, 400, {}, 'Bad request'); }
    // Never serve dotfiles or dot-directories such as .git.
    if (rel.split('/').some(seg => seg.startsWith('.'))) return send(res, 404, {}, 'Not found');
    let file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, {}, 'Forbidden');
    let st;
    try {
      st = fs.statSync(file);
      if (st.isDirectory()) { file = path.join(file, 'index.html'); st = fs.statSync(file); }
    } catch { return send(res, 404, {}, 'Not found'); }
    if (!st.isFile()) return send(res, 404, {}, 'Not found');

    const headers = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    let start = 0, end = st.size - 1, status = 200;
    if (range) {
      if (range[1] === '') { start = Math.max(0, st.size - Number(range[2] || 0)); }
      else { start = Number(range[1]); if (range[2] !== '') end = Math.min(Number(range[2]), st.size - 1); }
      if (range[1] === '' && range[2] === '' || start > end || start >= st.size) {
        return send(res, 416, { 'Content-Range': `bytes */${st.size}` });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !st.size) return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = await startServer(root, Number(process.env.PORT || 8766));
  console.log(`Oaxaca Rental Map: http://127.0.0.1:${server.address().port}/`);
}
