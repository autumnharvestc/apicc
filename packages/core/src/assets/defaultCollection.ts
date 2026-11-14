import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const defaultCollectionPattern = /^([0-9a-f]{4})[0-9a-f]{4}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-([0-9a-f]{12})$/i;
const utf8 = new TextEncoder();

function projectMarker(projectId: string): string {
  const digest = sha256(utf8.encode(`apicc-project-default-collection-v1\0${projectId.toLowerCase()}`));
  return bytesToHex(digest.subarray(0, 8));
}

export function isDefaultCollectionId(projectId: string, collectionId: string): boolean {
  const match = defaultCollectionPattern.exec(collectionId);
  if (!match) return false;
  const mark = projectMarker(projectId);
  return `${match[1]}${match[2]}`.toLowerCase() === mark;
}

/** A UUIDv8 with 64 project marker bits and 58 fresh nonce bits. The name is ordinary metadata. */
export function createDefaultCollectionId(projectId: string, nonce: string = globalThis.crypto.randomUUID()): string {
  const mark = projectMarker(projectId);
  const entropy = bytesToHex(sha256(utf8.encode(nonce.toLowerCase())).subarray(0, 8));
  const variant = (8 | (Number.parseInt(entropy[11]!, 16) & 3)).toString(16);
  return `${mark.slice(0, 4)}${entropy.slice(0, 4)}-${entropy.slice(4, 8)}-8${entropy.slice(8, 11)}-${variant}${entropy.slice(12, 15)}-${mark.slice(4)}`;
}
