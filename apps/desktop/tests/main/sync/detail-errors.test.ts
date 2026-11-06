import { expect, it } from 'vitest';
import { onlineDetailFailure } from './detail-error-fixture.js';

it('fix2 keeps a declared bounded detail reason in the real adapter Error.message for IPC', async () => {
  const f = await onlineDetailFailure('SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED');
  await expect(f.handle()).rejects.toThrow('SYNC_DETAIL:SYNC_COMPARE_OUTPUT_BYTES_EXCEEDED');
  expect(f.requests).toEqual([f.path]);
});
it('fix2 does not expose an undeclared uppercase server code or body through the adapter', async () => {
  const f = await onlineDetailFailure('SYNC_UNDECLARED_PRIVATE_REASON');
  const error = await f.handle().catch(error => error);
  expect(error).toMatchObject({ code: 'execution-request-failed', message: 'execution control request failed: HTTP 409' });
  expect(String(error)).not.toContain('PRIVATE'); expect(f.requests).toEqual([f.path]);
});
it.each([401, 403])('fix2 keeps existing lowercase forbidden identity semantics at HTTP %i', async status => {
  const f = await onlineDetailFailure('forbidden', status);
  await expect(f.handle()).rejects.toMatchObject({ status, code: 'forbidden', message: `execution control request failed: HTTP ${status}` });
  expect(f.requests).toEqual([f.path]);
});
