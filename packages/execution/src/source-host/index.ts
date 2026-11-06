export * from "./types.js";
import { createSourceHost as createUrlSourceHost } from "./url.js";
import { readGitSource } from "./git.js";
import type { SourceHost, SourceHostOptions } from "./types.js";

/** Protocol dispatch only. Each reader owns validation and its one material lifecycle. */
export function createSourceHost(options: SourceHostOptions): SourceHost {
  const url = createUrlSourceHost(options);
  return { readSource(input, lease, signal) { return input?.source?.kind === "url" ? url.readSource(input, lease, signal) : readGitSource(input, lease, signal, options); } };
}
