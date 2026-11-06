import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFromDeployment } from '../../../../apps/collaboration-runtime/dist/limits.js';

const directory = process.argv[2], privateRoot = join(directory, 'private');
await mkdir(privateRoot, { recursive: true });
const rawText = 'openapi: 3.0.3\ninfo:\n  title: T8 source\n  version: 1.0.0\npaths: {}\n';
const source = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/yaml' });
  if (req.url === '/blocked') {
    res.write('owned-blocked-content'); writeFileSync(join(directory, 'source-received'), 'received');
    req.socket.once('close', () => writeFileSync(join(directory, 'source-collected'), 'closed'));
  } else if (req.url === '/slow') {
    res.write(rawText.slice(0, 10));
    const timer = setTimeout(() => res.end(rawText.slice(10)), 11000);
    req.socket.once('close', () => clearTimeout(timer));
  } else res.end(rawText);
});
await new Promise(done => source.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${source.address().port}`;
const secretFile = join(directory, 'rpc-key'), sourceConfigFile = join(directory, 'source.json');
await writeFile(secretFile, 'synthetic-secret-0123456789abcdef');
await writeFile(sourceConfigFile, JSON.stringify({ privateRoot, allowedOrigins: [origin], allowedCidrs: ['127.0.0.1/32'], maxRedirects: 0 }));
const runtime = await runtimeFromDeployment({ enabled: true, secretFile, sourceConfigFile, port: 0 });
if (!runtime.enabled) throw Error('Owned runtime must start');
console.log(JSON.stringify({ url: runtime.url, origin, secretFile, rawText }));
let stopping;
const stop = () => stopping ??= (async () => { await runtime.close(); source.closeAllConnections(); await new Promise(done => source.close(done)); process.stdin.destroy(); })();
process.stdin.once('data', () => { void stop(); }); process.stdin.once('end', () => { void stop(); });
