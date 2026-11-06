import { expect, it } from 'vitest';
import { z } from 'zod';
import { createMemberExecutionRequest } from '../../src/client/memberHttp.js';
import { syncErrorCodeValues } from '../../src/contract/synchronization.js';

const binding = () => ({ serverId: 'https://control.test/api/v1', token: () => 'owned-member', assertCurrent() {} });
const reply = (code: string, status = 409): typeof fetch => async () => Response.json({ code, message: 'PRIVATE SERVER BODY' }, { status });
it('fix2 permits only the configured finite diagnostic vocabulary after the existing bounded read', async () => {
  const request = createMemberExecutionRequest(binding(), reply('SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED'), undefined, { errorCodes: syncErrorCodeValues });
  await expect(request('GET', 'fixed-detail', undefined, z.null())).rejects.toMatchObject({ status: 409, code: 'SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED' });
});
it('fix2 preserves default filtering and rejects undeclared uppercase codes even with the finite option', async () => {
  const original = createMemberExecutionRequest(binding(), reply('SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED'));
  const configured = createMemberExecutionRequest(binding(), reply('SYNC_UNDECLARED_PRIVATE_REASON'), undefined, { errorCodes: syncErrorCodeValues });
  for (const request of [original, configured]) await expect(request('GET', 'fixed-detail', undefined, z.null())).rejects.toMatchObject({ code: 'execution-request-failed', message: 'execution control request failed: HTTP 409' });
});
it('fix2 retains the 4096-byte error-body bound before finite-code parsing', async () => {
  const request = createMemberExecutionRequest(binding(), async () => new Response(JSON.stringify({ code: 'SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED', message: 'x'.repeat(5000) }), { status: 409 }), undefined, { errorCodes: syncErrorCodeValues });
  await expect(request('GET', 'fixed-detail', undefined, z.null())).rejects.toThrow('execution-response-too-large');
});
it.each([401, 403])('fix2 keeps denied-response binding semantics for HTTP %i', async status => {
  let invalidated = false; const captured = binding(); captured.assertCurrent = () => { if (invalidated) throw Error('binding invalidated'); };
  const request = createMemberExecutionRequest(captured, async () => { invalidated = true; return Response.json({ code: 'forbidden' }, { status }); }, undefined, { errorCodes: syncErrorCodeValues });
  await expect(request('GET', 'fixed-detail', undefined, z.null())).rejects.toMatchObject({ status, code: 'forbidden' });
});
