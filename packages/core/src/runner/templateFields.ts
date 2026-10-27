/** Update untouched template fields in place, preserving explicit script edits and deletions. */
export function mergeTemplateFields(current: Record<string, unknown>, previous: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(current, key)) continue;
    const before = previous[key]; const value = current[key]; const after = next[key];
    if (value && before && after && typeof value === "object" && typeof before === "object" && typeof after === "object") {
      mergeTemplateFields(value as Record<string, unknown>, before as Record<string, unknown>, after as Record<string, unknown>);
    } else if (value === before) current[key] = after;
  }
}
