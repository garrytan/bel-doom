#!/usr/bin/env node
// Zero-dependency static server for the repo root. Usage: node bin/serve.mjs [port] [--root DIR] [--host H] [-v]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let port = 8080;
let host = '0.0.0.0';
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let verbose = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') root = path.resolve(args[++i]);
  else if (a === '--host') host = args[++i];
  else if (a === '-v' || a === '--verbose') verbose = true;
  else if (/^\d+$/.test(a)) port = Number(a);
  else { console.error(`usage: node bin/serve.mjs [port] [--root DIR] [--host H] [-v]`); process.exit(2); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.bel': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wad': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const server = http.createServer((req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
    if (verbose) console.log(status, req.method, req.url);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed\n', { Allow: 'GET, HEAD' });
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { return send(400, 'bad request\n'); }
  if (pathname === '/') return send(302, 'see /web/\n', { Location: '/web/' });
  const file = path.join(root, pathname);
  if (file !== root && !file.startsWith(root + path.sep)) return send(403, 'forbidden\n');
  fs.stat(file, (err, st) => {
    if (err) return send(404, `not found: ${pathname}\n`);
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) return send(301, 'moved\n', { Location: pathname + '/' });
      const index = path.join(file, 'index.html');
      return fs.stat(index, (e2, st2) => (e2 ? send(404, `no index.html in ${pathname}\n`) : stream(index, st2)));
    }
    stream(file, st);
  });
  function stream(file, st) {
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (verbose) console.log(200, req.method, req.url, st.size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
});

server.listen(port, host, () => {
  console.log(`serving ${root} at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/web/`);
});
