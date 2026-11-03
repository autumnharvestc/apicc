import { PublicArtifactDtoSchema, type PublicArtifactDto } from '@apicc/core/collaboration/shared';
export type ReadResult = { ok: true; artifact: PublicArtifactDto; downloadAllowed: boolean; version: string } | { ok: false; code: string; reason?: string };
export async function readPublic(origin: string, publicId: string, key: string, download = false, fetcher: typeof fetch = fetch): Promise<ReadResult> {
  if (!key || !/^[A-Za-z0-9_-]{22}$/.test(publicId)) return { ok: false, code: 'share_unavailable' };
  try {
    const response = await fetcher(new Request(new URL('/share-api/' + publicId + (download ? '/download' : ''), origin), {
      method: 'GET', headers: { 'X-Apicc-Share-Key': key }, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    }));
    if (response.status === 404) return { ok: false, code: 'share_unavailable' };
    if (response.status === 410) {
      const body = await response.json();
      const reason = ['expired', 'revoked', 'responsibility_changed', 'policy_changed', 'publication_disabled'].includes(body.reason) ? body.reason as string : undefined;
      return { ok: false, code: 'share_inactive', ...(reason ? { reason } : {}) };
    }
    if (response.status === 429) return { ok: false, code: 'capacity' };
    if (response.status !== 200) return { ok: false, code: 'service_unavailable' };
    const artifact = PublicArtifactDtoSchema.parse(await response.json());
    return { ok: true, artifact, downloadAllowed: response.headers.get('X-Apicc-Download-Allowed') === 'true', version: response.headers.get('X-Apicc-Publication-Version') ?? '' };
  } catch { return { ok: false, code: 'service_unavailable' }; }
}
