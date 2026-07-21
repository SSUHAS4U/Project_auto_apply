// Tiny static file server for the built React dashboard. The app uses BrowserRouter, so
// it needs a real HTTP origin (not file://) and SPA fallback to index.html. We bind a
// fixed loopback port so the origin — and therefore localStorage (the login) — stays
// stable across launches.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Serve `rootDir` on 127.0.0.1:`port`; returns the server once listening. */
function startStaticServer(rootDir, port) {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = path.join(rootDir, urlPath);
      // Prevent path traversal outside the dist folder.
      if (!filePath.startsWith(rootDir)) { res.writeHead(403).end(); return; }

      const ext = path.extname(filePath);
      // SPA fallback: any path without a file extension → index.html (React Router owns it).
      if (!ext || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(rootDir, 'index.html');
      }
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startStaticServer };
