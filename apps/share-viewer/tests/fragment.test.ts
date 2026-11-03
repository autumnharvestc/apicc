import { describe, it, expect } from 'vitest';
import { readFragment, sectionFragment } from '../src/fragment.js';
describe('controlled fragment', () => {
  it('preserves the same key through section navigation and a full reload', () => {
    const url = new URL('https://public.test/s/public-id#key=synthetic-secret&section=api-2');
    const visit = readFragment(url.hash);
    expect(visit.key).toBe('synthetic-secret');
    expect(visit.section).toBe('api-2');
    url.hash = sectionFragment(visit, 'models');
    expect(url.pathname).toBe('/s/public-id'); expect(url.search).toBe('');
    expect(readFragment(url.hash)).toEqual({ key: 'synthetic-secret', section: 'models' });
  });
  it.each(['#key=a&key=b', '#key=%', '#key=a&section=x&section=y', '#key=a&other=b'])('rejects ambiguous or malformed fragment %s', hash => {
    expect(readFragment(hash)).toEqual({ key: '', section: '' });
  });
  it('encodes a section as data without adding an endpoint or new fragment field', () => {
    expect(readFragment(sectionFragment({ key: 'synthetic-secret', section: '' }, 'api-2&key=forged'))).toEqual({ key: 'synthetic-secret', section: 'api-2&key=forged' });
  });
});
