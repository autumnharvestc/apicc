/** Internal, run-local arrival decisions; no timers, VUs, metrics or persistent configuration. */
export interface ArrivalSegment {
  readonly id: string | null; readonly start: number; readonly end: number;
  readonly from: number; readonly to: number; readonly area: number;
}
export interface ArrivalPolicyInput {
  readonly parts: readonly ArrivalSegment[]; readonly elapsedMs: number; readonly durationMs: number;
  readonly cursor: number; readonly budget: number;
}
export interface ArrivalDecision {
  readonly cursor: number;
  readonly dropped: readonly { readonly stageId: string | null; readonly count: number }[];
  readonly current: { readonly ordinal: number; readonly dueMs: number; readonly stageId: string | null } | null;
  readonly nextWakeMs: number;
}
export type ArrivalPolicy = (input: ArrivalPolicyInput) => ArrivalDecision;

export function areaAt(parts: readonly ArrivalSegment[], at: number): number {
  let area = 0;
  for (const s of parts) {
    const t = Math.max(0, Math.min(at, s.end) - s.start), length = s.end - s.start;
    const slope = s.to === s.from ? 0 : (s.to - s.from) / length;
    // Use the same whole-segment integral as segment prefixes and inverse selection.
    area += t === length ? (s.from + s.to) / 2 * length / 1000 : (s.from * t + slope * t * t / 2) / 1000;
    if (at <= s.end) break;
  }
  return area;
}
export function slotAt(parts: readonly ArrivalSegment[], ordinal: number): number {
  const desired = ordinal + .5;
  for (const s of parts) {
    const area = (s.from + s.to) / 2 * (s.end - s.start) / 1000;
    if (desired > s.area + area || area === 0) continue;
    // An exact integral boundary has an exact known time. Do not let inverse-root
    // rounding move it into the old half-open stage or inside the final window.
    if (desired === s.area + area) return s.end;
    const local = (desired - s.area) * 1000, slope = (s.to - s.from) / (s.end - s.start);
    const t = slope === 0 ? local / s.from : 2 * local / (s.from + Math.sqrt(Math.max(0, s.from * s.from + 2 * slope * local)));
    return s.start + t;
  }
  return Infinity;
}
function arrived(parts: readonly ArrivalSegment[], at: number, strictlyBefore = false): number {
  let count = Math.max(0, Math.floor(areaAt(parts, at) + .5));
  // A half-step can be reached at the start of a zero-rate plateau. Its real due,
  // not integral equality alone, decides whether it precedes a stage/window end.
  if (count > 0) { const due = slotAt(parts, count - 1); if (strictlyBefore ? due >= at : due > at) count--; }
  return count;
}

/** A: one latest unconsumed slot, bounded by next due / owning stage / pressure window. */
export const arrivalPolicyA: ArrivalPolicy = ({ parts, elapsedMs, durationMs, cursor, budget }) => {
  const dueCount = Math.min(arrived(parts, durationMs, true), arrived(parts, Math.min(elapsedMs, durationMs)));
  const consumed = Math.min(budget, Math.max(0, dueCount - cursor)), nextCursor = cursor + consumed;
  let current: ArrivalDecision["current"] = null;
  if (consumed > 0 && nextCursor === dueCount && elapsedMs < durationMs) {
    const ordinal = dueCount - 1, dueMs = slotAt(parts, ordinal);
    // Half-open stage ownership: an exact boundary due belongs to the new stage.
    const owner = parts.find(part => part.start <= dueMs && dueMs < part.end);
    if (owner && dueMs <= elapsedMs && elapsedMs < Math.min(slotAt(parts, ordinal + 1), owner.end, durationMs)) current = { ordinal, dueMs, stageId: owner.id };
  }
  const dropEnd = nextCursor - (current ? 1 : 0), dropped: { stageId: string | null; count: number }[] = [];
  let from = cursor;
  // At most the finite stage count, never a loop/queue proportional to skipped slots.
  if (dropEnd > from) for (const part of parts) {
    const to = Math.min(dropEnd, arrived(parts, Math.min(part.end, durationMs), true));
    if (to > from) { dropped.push({ stageId: part.id, count: to - from }); from = to; }
    if (from >= dropEnd) break;
  }
  const boundary = parts.find(part => part.end > elapsedMs)?.end ?? durationMs;
  return { cursor: nextCursor, dropped, current, nextWakeMs: Math.min(durationMs, boundary, slotAt(parts, nextCursor)) };
};
