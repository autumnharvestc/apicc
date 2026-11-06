import { validateHeaderName, validateHeaderValue } from "node:http";
import type { SourceMaterialLease, SourceReadInput } from "./types.js";
import { SourceHostError } from "./limits.js";

const transportHeaders = new Set(["host", "connection", "proxy-authorization", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding", "if-none-match", "if-modified-since"]);
export function sourceHeaders(input: SourceReadInput, lease: SourceMaterialLease): Record<string, string> {
  if (input.source.kind === "url" && input.source.authRef && !lease.httpHeaders?.length) throw new SourceHostError("SYNC_MATERIAL_MISSING");
  const output: Record<string, string> = Object.create(null);
  if (Boolean(lease.tls?.certPem) !== Boolean(lease.tls?.keyPem)) throw new SourceHostError("SYNC_MATERIAL_INVALID");
  for (const { name, value } of lease.httpHeaders ?? []) {
    try { validateHeaderName(name); validateHeaderValue(name, value); } catch { throw new SourceHostError("SYNC_MATERIAL_INVALID"); }
    const lower = name.toLowerCase();
    if (transportHeaders.has(lower) || Object.hasOwn(output, lower)) throw new SourceHostError("SYNC_MATERIAL_INVALID");
    output[lower] = value;
  }
  return output;
}
