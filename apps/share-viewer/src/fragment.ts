export type Visit = { key: string; section: string };
export function readFragment(hash: string): Visit {
  const empty = { key: '', section: '' };
  try { decodeURIComponent(hash); } catch { return empty; }
  const fields = new URLSearchParams(hash.replace(/^#/, ''));
  if (fields.getAll('key').length > 1 || fields.getAll('section').length > 1 || [...fields.keys()].some(name => name !== 'key' && name !== 'section')) return empty;
  return { key: fields.get('key') ?? '', section: fields.get('section') ?? '' };
}
export function sectionFragment(visit: Visit, section: string): string { return '#' + new URLSearchParams({ key: visit.key, section }).toString(); }
