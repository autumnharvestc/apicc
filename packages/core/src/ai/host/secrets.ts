export type AiSecretMode = "persistent" | "session-only";
export type AiSecretState = "missing" | "available" | "unavailable" | "session-only";
export interface AiSecretBackend {
  readonly availability: "available" | "unavailable";
  get(ref: string, audience: string): Promise<string | undefined>;
  /** Allocate a fresh opaque ref; never overwrite an existing ref before config CAS commits. */
  put(value: string, audience: string, mode: AiSecretMode): Promise<string>;
  remove(ref: string, audience: string): Promise<void>;
}
export function isAiSecretValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}
