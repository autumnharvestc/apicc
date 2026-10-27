import { createHttpSession, type HttpSession } from "@apicc/core";
import { DebugSessionHandleSchema, type ExecutionInputs, type TaskEnvelopeV1 } from "@apicc/execution/contract";
import { equal, rejectPreparation } from "./invocationContext.js";
interface Entry { session: HttpSession; identity: unknown; refs: number; idleUntil: number }
/** Cookie values live only in this process and only the current authorized execution can use them. */
export class DebugSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly expired = new Set<string>();
  constructor(private readonly serverId: string, private readonly agentId: string, private readonly hostSessionId: string) {}
  async acquire(task: TaskEnvelopeV1, inputs: ExecutionInputs, config: { debugSessionIdleMs: number; maxDebugSessions: number }): Promise<{ session: HttpSession; release(): void } | undefined> {
    if (!task.debugSessionId) { if (inputs.debugSession) rejectPreparation("debug-session-scope-mismatch"); return undefined; }
    const handle = inputs.debugSession; if (!handle) rejectPreparation("debug-session-expired");
    if (!DebugSessionHandleSchema.safeParse(Object.fromEntries(Object.entries(handle).filter(([key]) => key !== "hostSessionId"))).success) rejectPreparation("fixed-input-mismatch");
    if (task.target.kind !== "debug" || handle.serverId !== this.serverId || handle.agentId !== this.agentId || handle.debugSessionId !== task.debugSessionId || handle.submittedByUserId !== task.submittedByUserId || !equal(handle.scope, task.scope)) rejectPreparation("debug-session-scope-mismatch");
    // The old host's in-memory Cookie session cannot be rebound by retrying its handle.
    if (handle.hostSessionId !== this.hostSessionId) rejectPreparation("debug-session-expired");
    const now = Date.now();
    for (const [id, entry] of this.entries) if (!entry.refs && entry.idleUntil <= now) { this.entries.delete(id); this.expired.add(id); await entry.session.close(); }
    const identity = { serverId: handle.serverId, scope: handle.scope, submittedByUserId: handle.submittedByUserId, agentId: handle.agentId };
    let entry = this.entries.get(handle.debugSessionId);
    if (entry && !equal(entry.identity, identity)) rejectPreparation("debug-session-scope-mismatch");
    if (!entry) {
      if (this.expired.has(handle.debugSessionId) || Date.parse(handle.expiresAt) <= now) rejectPreparation("debug-session-expired");
      if (this.entries.size >= config.maxDebugSessions) rejectPreparation("debug-session-capacity-exceeded");
      entry = { session: createHttpSession(), identity, refs: 0, idleUntil: now + config.debugSessionIdleMs }; this.entries.set(handle.debugSessionId, entry);
    }
    entry.refs++; let active = true; const owned = entry;
    return { session: owned.session, release: () => { if (!active) return; active = false; owned.refs--; if (!owned.refs) owned.idleUntil = Date.now() + config.debugSessionIdleMs; } };
  }
  async close(): Promise<void> { for (const entry of this.entries.values()) await entry.session.close(); this.entries.clear(); }
}
