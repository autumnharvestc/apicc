// Optional preview host. Only serves the three public sample assets on loopback.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/preview.css', ['preview.css', 'text/css; charset=utf-8']],
  ['/preview.js', ['preview.js', 'text/javascript; charset=utf-8']],
]);
const server = http.createServer(async (req, res) => {
  const entry = assets.get(req.url);
  if (!entry || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
  try {
    const data = await readFile(new URL(entry[0], import.meta.url));
    res.writeHead(200, {'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(500); res.end('Preview asset unavailable'); }
});
server.listen(0, '127.0.0.1', () => console.log(`F8 design preview: http://127.0.0.1:${server.address().port}/`));
