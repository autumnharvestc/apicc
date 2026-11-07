import { z } from "zod";

export const ONLINE_EXECUTION_CACHE_SETTINGS_KEY = "apicc.onlineExecutionCache";
export const OnlineExecutionCachePreferencesSchema = z.object({
  maxInactiveContexts: z.number().int().min(0).max(200),
  inactiveTtlMinutes: z.number().int().min(1).max(1440),
  maxInactivePayloadMiB: z.number().int().min(1).max(512),
}).strict();
export type OnlineExecutionCachePreferences = z.infer<typeof OnlineExecutionCachePreferencesSchema>;
export const DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES: Readonly<OnlineExecutionCachePreferences> = Object.freeze({
  maxInactiveContexts: 20, inactiveTtlMinutes: 30, maxInactivePayloadMiB: 64,
});
export type ExecutionCacheStorage = Pick<Storage, "getItem" | "setItem">;
export function defaultExecutionCacheStorage(): ExecutionCacheStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
export function readExecutionCachePreferences(storage: ExecutionCacheStorage | null) {
  const fallback = () => ({ ...DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES });
  if (!storage) return { preferences: fallback(), diagnostic: "online-cache-settings-unavailable" };
  let raw: string | null;
  try { raw = storage.getItem(ONLINE_EXECUTION_CACHE_SETTINGS_KEY); }
  catch { return { preferences: fallback(), diagnostic: "online-cache-settings-unavailable" }; }
  if (raw === null) return { preferences: fallback(), diagnostic: null };
  try { return { preferences: OnlineExecutionCachePreferencesSchema.parse(JSON.parse(raw)), diagnostic: null }; }
  catch { return { preferences: fallback(), diagnostic: "online-cache-settings-corrupt" }; }
}
