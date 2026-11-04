import { vi } from 'vitest';

/** Keep the real Web Crypto result pending until the test releases it. */
export function holdRealReportDigest() {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest.bind(subtle);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending: ReturnType<typeof original>[] = [];
  const spy = vi.spyOn(subtle, 'digest').mockImplementation((algorithm, data) => {
    const work = original(algorithm, data).then(async result => { await held; return result; });
    pending.push(work);
    return work;
  });
  return {
    spy,
    async settle() { release(); await Promise.all(pending); },
    restore() { release(); spy.mockRestore(); },
  };
}
