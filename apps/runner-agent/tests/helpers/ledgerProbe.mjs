import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

// Test observer only: do not change the agent's fail-closed writer or its journal/lock policy.
export async function readLedgerIntent(file, executionId, { budgetMs = 1000 } = {}) {
  const deadline = performance.now() + budgetMs;
  let busy;
  for (;;) {
    if (busy && performance.now() >= deadline) throw new Error(`Ledger probe remained busy for ${budgetMs} ms: ${file}`, { cause: busy });
    let database, row, contended = false;
    try {
      database = new DatabaseSync(file, { readOnly: true });
      row = database.prepare("SELECT state FROM ledger WHERE id=1").get();
    } catch (error) {
      // Only SQLITE_BUSY is transient here. Never hide missing files, corrupt DBs or bad SQL/data.
      if (error.code !== "ERR_SQLITE_ERROR" || error.errcode !== 5) throw error;
      busy = error;
      contended = true;
    } finally { database?.close(); }
    if (row) {
      // Release the SQLite handle before parsing a potentially large state or returning to the caller.
      const state = JSON.parse(row.state);
      return state.intents.find(value => value.executionId === executionId) ?? null;
    }
    if (!contended) throw new Error(`Ledger state row missing: ${file}`);
    await delay(Math.max(0, Math.min(10, deadline - performance.now())));
  }
}
