import { createHash } from "node:crypto";
import type { ContractImportIdentity } from "../import/contractOpenapi.js";
import type { SyncDiagnostic, SyncEntityKind, SyncIdentityMap } from "./types.js";

export function allocateSyncId(sourceId: string, entityKind: SyncEntityKind, externalKey: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["apicc-sync-id-v1", sourceId, entityKind, externalKey]), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

type Entry = SyncIdentityMap["entries"][number];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function createSyncIdentity(sourceId: string, moduleId: string, mapping: SyncIdentityMap, diagnostics: SyncDiagnostic[]) {
  if (mapping.sourceId !== sourceId) throw new TypeError("Identity mapping belongs to another source.");
  const projectId = allocateSyncId(sourceId, "folder", "/project");
  const reservedProjectId = projectId.toLowerCase();
  const reservedModuleId = moduleId.toLowerCase();
  if (reservedModuleId === reservedProjectId) throw new TypeError("Source module occupies the reserved project identity.");
  const entries = structuredClone(mapping.entries);
  const byKey = new Map<string, Entry>();
  const byId = new Map<string, Entry>();
  const active = new Map<string, Entry>();
  const operationIds = new Set<string>();
  const keyOf = (kind: string, key: string) => JSON.stringify([kind, key]);
  function index(entry: Entry) {
    const id = entry.entityId.toLowerCase();
    const targetModule = entry.entityKind === "module" && entry.externalKey === "/module";
    if (id === reservedProjectId || (id === reservedModuleId && !targetModule)) throw new TypeError("Identity mapping occupies a reserved ID.");
    // Keep the fixed target module's spelling while comparing UUIDs by value.
    if (targetModule && id === reservedModuleId) entry.entityId = moduleId;
    if (byId.has(entry.entityId.toLowerCase()) && byId.get(entry.entityId.toLowerCase()) !== entry) throw new TypeError("Duplicate identity mapping ID.");
    byId.set(entry.entityId.toLowerCase(), entry);
    for (const key of [entry.externalKey, ...entry.aliases.filter(alias => !alias.startsWith("operationId:"))]) {
      const indexKey = keyOf(entry.entityKind, key);
      if (byKey.has(indexKey) && byKey.get(indexKey) !== entry) throw new TypeError("Ambiguous identity mapping alias.");
      byKey.set(indexKey, entry);
    }
  }
  entries.forEach(index);
  const identity: ContractImportIdentity = {
    projectId,
    allocate(kind, key, ownerId, hints = []) {
      const parent = ownerId ? byId.get(ownerId.toLowerCase()) : undefined;
      const externalKey = parent && kind !== "api" ? `${parent.externalKey}${key}` : key;
      let entry = byKey.get(keyOf(kind, externalKey));
      if (kind === "api") {
        for (const hint of hints) {
          if (operationIds.has(hint)) diagnostics.push({ code: "SYNC_OPERATION_ID_DUPLICATE", severity: "error", ownerId: moduleId, path: key, message: `Duplicate ${hint}; operationId is not a correspondence.` });
          operationIds.add(hint);
        }
        if (!entry && mapping.entries.some(e => e.entityKind === "api")) {
          const suggestions = mapping.entries.filter(e => e.entityKind === "api" && hints.some(h => e.aliases.includes(h)));
          diagnostics.push({ code: suggestions.length ? "SYNC_IDENTITY_MATCH_SUGGESTION" : "SYNC_IDENTITY_UNMATCHED", severity: "warning", ownerId: moduleId, path: key,
            message: suggestions.length ? `Confirm correspondence with ${suggestions.map(e=>e.entityId).join(", ")}; ownership was not transferred.` : "No confirmed correspondence; route and operationId do not authorize taking over an existing entity." });
        }
      }
      if (!entry) {
        const entityId = kind === "module" ? moduleId : allocateSyncId(sourceId, kind, externalKey);
        if (byId.has(entityId.toLowerCase())) throw new TypeError("Allocated identity ID is occupied by another mapping.");
        entry = { entityKind: kind, externalKey, entityId, ownerExternalKey: parent?.externalKey ?? "/module", aliases: [], ownership: kind === "module" ? "local" : "source", correspondence: kind === "module" ? "manual" : "confirmed" };
        entries.push(entry); index(entry);
      }
      if (kind === "module" && entry.entityId.toLowerCase() !== reservedModuleId) throw new TypeError("Identity mapping targets a different source module.");
      for (const hint of hints) if (!entry.aliases.includes(hint)) entry.aliases.push(hint);
      active.set(keyOf(kind, entry.externalKey), entry);
      return entry.entityId;
    },
  };
  return { identity, result() {
    const order = (a: Entry, b: Entry) => compare(a.externalKey,b.externalKey) || compare(a.entityKind,b.entityKind);
    return { mapping: { ...mapping, entries: entries.map(e=>({ ...e, aliases: [...e.aliases].sort(compare) })).sort(order) }, entityIds: [...active.values()].sort(order).map(({ entityKind, externalKey, entityId })=>({ entityKind, externalKey, entityId })) };
  } };
}
