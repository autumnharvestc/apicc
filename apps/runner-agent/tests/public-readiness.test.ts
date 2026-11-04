import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { waitForPublicReadiness, type PublicReadObservation } from './helpers/publicReadiness.js';

async function withServer(handler: RequestListener, exercise: (url: string) => Promise<void>) {
  const server: Server = createServer(handler);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try { await exercise(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
}

it('waits through a real socket reset and startup reconciliation before checking the revoked response', async () => {
  let requests = 0;
  const observations: PublicReadObservation[] = [];
  await withServer((request, response) => {
    requests++;
    if (requests === 1) { request.socket.destroy(); return; }
    response.setHeader('content-type', 'application/json');
    response.writeHead(requests === 2 ? 503 : 410);
    response.end(JSON.stringify(requests === 2 ? { code: 'public_origin_unavailable' } : { code: 'share_inactive', reason: 'revoked' }));
  }, async url => {
    const result = await waitForPublicReadiness(() => fetch(url), value => observations.push(value), 3000);
    expect(result).toMatchObject({ status: 410, code: 'share_inactive' });
    expect(observations.map(({ status, code }) => ({ status, code }))).toEqual([
      { status: 0, code: 'transport-error' },
      { status: 503, code: 'public_origin_unavailable' },
      { status: 410, code: 'share_inactive' },
    ]);
    expect(requests).toBe(3);
  });
});

it.each([
  [200, 'unexpected-success'], [401, 'unauthorized'], [403, 'forbidden'],
  [404, 'share_unavailable'], [500, 'internal_error'], [503, 'collaboration_projection_unavailable'],
])('returns unexpected HTTP %i immediately so the business assertion can fail', async (status, code) => {
  let requests = 0;
  await withServer((_request, response) => {
    requests++; response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code }));
  }, async url => {
    expect(await waitForPublicReadiness(() => fetch(url), () => {}, 3000)).toMatchObject({ status, code });
    expect(requests).toBe(1);
  });
});

it('fails within the readiness budget when every real connection is reset', async () => {
  const observations: PublicReadObservation[] = [];
  await withServer(request => request.socket.destroy(), async url => {
    await expect(waitForPublicReadiness(() => fetch(url), value => observations.push(value), 350)).rejects.toThrow('Readiness not reached');
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every(value => value.status === 0 && value.code === 'transport-error')).toBe(true);
  });
});

it('keeps the existing deadline for a public listener that never finishes reconciliation', async () => {
  await withServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"code":"public_origin_unavailable"}');
  }, async url => {
    await expect(waitForPublicReadiness(() => fetch(url), () => {}, 350)).rejects.toThrow('Readiness not reached');
  });
});

it.each([200, 410, 503])('does not hide an invalid HTTP %i response as a reconnect failure', async status => {
  let requests = 0;
  await withServer((_request, response) => {
    requests++; response.writeHead(status, { 'content-type': 'application/json' }); response.end('not-json');
  }, async url => {
    expect(await waitForPublicReadiness(() => fetch(url), () => {}, 3000)).toMatchObject({ status, code: 'invalid-public-response' });
    expect(requests).toBe(1);
  });
});

it('reconnects when the socket closes after real response headers but before the body completes', async () => {
  let requests = 0;
  let incomplete: ServerResponse | undefined;
  const observations: PublicReadObservation[] = [];
  await withServer((_request, response) => {
    requests++;
    if (requests === 1) {
      incomplete = response;
      response.writeHead(410, { 'content-type': 'application/json', 'content-length': '1000' });
      response.flushHeaders(); response.write('{"code":');
    } else {
      response.writeHead(410, { 'content-type': 'application/json' }); response.end('{"code":"share_inactive"}');
    }
  }, async url => {
    const result = await waitForPublicReadiness(async () => {
      const response = await fetch(url);
      incomplete?.destroy(); incomplete = undefined;
      return response;
    }, value => observations.push(value), 3000);
    expect(result).toMatchObject({ status: 410, code: 'share_inactive' });
    expect(observations.map(value => value.status)).toEqual([0, 410]);
    expect(requests).toBe(2);
  });
});
