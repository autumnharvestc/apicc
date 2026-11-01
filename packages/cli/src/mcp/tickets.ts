interface Ticket {
  summary: { expiresAt: string };
  attempted?: boolean;
  discard(): Promise<void>;
}
export function createMcpTickets<T extends Ticket>(options: { ticketTtlMs?: number; maxTickets?: number } = {}) {
  const ttlMs = options.ticketTtlMs ?? 300000, maximum = options.maxTickets ?? 32;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30000 || ttlMs > 900000 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) throw new Error("mcp-invalid-ticket-limits");
  const records = new Map<string, T>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const expired = new Map<string, string>();
  const disposing = new Map<string, Promise<void>>();
  let reservations = 0;
  async function discard(id: string, reason = "mcp-ticket-expired"): Promise<void> {
    const record = records.get(id);
    if (!record || record.attempted) return;
    const pending = disposing.get(id);
    if (pending) return pending;
    clearTimeout(timers.get(id)); timers.delete(id);
    expired.set(id, reason);
    if (expired.size > 32) expired.delete(expired.keys().next().value!);
    const completion = record.discard().then(() => { records.delete(id); });
    disposing.set(id, completion);
    try { await completion; } finally { disposing.delete(id); }
  }
  return {
    records, ttlMs,
    reserve() {
      if ([...records.values()].filter(record => !record.attempted).length + reservations >= maximum) throw new Error("mcp-ticket-capacity");
      reservations++;
      let released = false;
      return () => { if (!released) { released = true; reservations--; } };
    },
    add(id: string, record: T) {
      records.set(id, record);
      const timer = setTimeout(() => { void discard(id).catch(() => {}); }, Math.max(0, Date.parse(record.summary.expiresAt) - Date.now()));
      timer.unref(); timers.set(id, timer);
    },
    get: (id: string) => records.get(id),
    expire: discard,
    async assertUnusedFresh(id: string) {
      const record = records.get(id);
      if (expired.has(id) || record && !record.attempted && Date.parse(record.summary.expiresAt) <= Date.now()) {
        await discard(id); throw new Error(expired.get(id) ?? "mcp-ticket-expired");
      }
    },
    consume(id: string) {
      const record = records.get(id);
      if (record) record.attempted = true;
      clearTimeout(timers.get(id)); timers.delete(id);
    },
    forget(id: string) { clearTimeout(timers.get(id)); timers.delete(id); records.delete(id); },
    async discardUnused() { await Promise.all([...records.keys()].map(id => discard(id))); },
    clearReferences() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); records.clear(); expired.clear();
    },
  };
}
