import { it, expect, vi } from 'vitest';
import { readPublic } from '../src/client.js';
const id = 'a'.repeat(22);
const artifact = { formatVersion: 1, kind: 'document', title: '安全文档', source: { trust: 'saved-contract', revision: 'r1', digest: 'd1' }, summary: [], limitations: [], document: { apis: [], models: [], components: [] } };
it.each([false, true])('sends only dedicated share credential and a fixed same-origin path (download=%s)', async download => {
  let request!: Request;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => { request = input as Request; return new Response(JSON.stringify(artifact), { headers: { 'X-Apicc-Download-Allowed': 'true', 'X-Apicc-Publication-Version': '3' } }); });
  const result = await readPublic('https://public.test', id, 'synthetic-secret', download, fetcher);
  const outgoing = new URL(request.url);
  expect(outgoing.hash).toBe(''); expect(outgoing.href).not.toContain('synthetic-secret');
  expect.soft(request.headers.get('X-Apicc-Share-Key')).toBe('synthetic-secret');
  expect(outgoing.pathname).toBe('/share-api/' + id + (download ? '/download' : ''));
  expect.soft(request.credentials).toBe('omit'); expect.soft(request.redirect).toBe('error'); expect.soft(request.cache).toBe('no-store');
  expect.soft(result).toEqual({ ok: true, artifact, downloadAllowed: true, version: '3' });
});
it.each([['', id], ['synthetic-secret', '../api/v1'], ['synthetic-secret', 'https://evil.invalid']])('never fetches without valid access input', async (key, publicId) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(artifact)));
  const result = await readPublic('https://public.test', publicId, key, false, fetcher);
  expect(result).toEqual({ ok: false, code: 'share_unavailable' }); expect(fetcher).not.toHaveBeenCalled();
});
it.each([404, 410, 429, 503, 500])('maps physical status %s without candidate body', async status => {
  const response = new Response(JSON.stringify({ code: 'unsafe-internal-detail', reason: 'revoked', artifact }), { status });
  const result = await readPublic('https://public.test', id, 'synthetic-secret', false, async () => response);
  expect(result).toEqual({ ok: false, code: ({404:'share_unavailable',410:'share_inactive',429:'capacity',503:'service_unavailable'} as Record<number,string>)[status] ?? 'service_unavailable', ...(status === 410 ? { reason: 'revoked' } : {}) });
});
it('refuses unrecognized inactive reason without echoing it', async () => {
  expect(await readPublic('https://public.test', id, 'synthetic-secret', false, async () => new Response('{"reason":"private"}', {status:410}))).toEqual({ok:false, code:'share_inactive'});
});
it.each(['{"kind":"document","private":"source"}', 'not-json'])('refuses malformed successful content', async body => {
  expect(await readPublic('https://public.test', id, 'synthetic-secret', false, async () => new Response(body))).toEqual({ ok:false, code:'service_unavailable' });
});
it('maps network or redirect refusal to safe service failure', async () => {
  expect(await readPublic('https://public.test', id, 'synthetic-secret', false, async () => { throw new Error('private transport details'); })).toEqual({ok:false,code:'service_unavailable'});
});
