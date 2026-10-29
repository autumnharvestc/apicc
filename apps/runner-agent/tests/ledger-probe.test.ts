import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { readLedgerIntent } from "./helpers/ledgerProbe.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "apicc-ledger-probe-"));
  const file = join(directory, "execution-ledger.sqlite");
  const writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; CREATE TABLE ledger(id INTEGER PRIMARY KEY,state TEXT NOT NULL)");
  writer.prepare("INSERT INTO ledger VALUES(1,?)").run(JSON.stringify({ intents: [{ executionId: "52", fact: "started" }] }));
  onTestFinished(() => { writer.close(); rmSync(directory, { recursive: true }); });
  return { file, writer, directory };
}

// Break caught: a live read aborts the E2E on a normal writer's transient EXCLUSIVE lock.
it("releases a busy read before retrying and observes the writer's committed intent", async () => {
  const { file, writer } = fixture();
  writer.exec("BEGIN EXCLUSIVE");
  writer.prepare("UPDATE ledger SET state=? WHERE id=1").run(JSON.stringify({ intents: [{ executionId: "52", fact: "started", settled: true }] }));
  // The first synchronous SQLite read happens while the lock is held, not after an arbitrary delay.
  const read = readLedgerIntent(file, "52");
  writer.exec("COMMIT");
  await expect(read).resolves.toEqual({ executionId: "52", fact: "started", settled: true });
  // The observer must leave neither a transaction nor a read handle holding up the next writer.
  writer.exec("BEGIN EXCLUSIVE; COMMIT");
});

// Break caught: retrying forever conceals a stuck writer and consumes the entire E2E budget.
it("fails with the original busy cause when contention outlives the bounded probe budget", async () => {
  const { file, writer } = fixture();
  writer.exec("BEGIN EXCLUSIVE");
  try {
    await expect(readLedgerIntent(file, "52", { budgetMs: 30 })).rejects.toMatchObject({
      message: expect.stringContaining("Ledger probe remained busy"), cause: { code: "ERR_SQLITE_ERROR", errcode: 5 },
    });
  } finally { writer.exec("ROLLBACK"); }
  await expect(readLedgerIntent(file, "52")).resolves.toEqual({ executionId: "52", fact: "started" });
});

// Break caught: converting malformed/missing data into an empty intent hides real fixture failures.
it("keeps a missing intent distinct from malformed ledger data", async () => {
  const { file, writer } = fixture();
  await expect(readLedgerIntent(file, "absent")).resolves.toBeNull();
  writer.prepare("UPDATE ledger SET state=? WHERE id=1").run("not JSON");
  await expect(readLedgerIntent(file, "52")).rejects.toBeInstanceOf(SyntaxError);
  writer.exec("BEGIN EXCLUSIVE; COMMIT");
});

it("does not retry a missing or non-SQLite file as a transient lock", async () => {
  const { directory } = fixture();
  const missing = join(directory, "missing.sqlite"), corrupt = join(directory, "corrupt.sqlite");
  writeFileSync(corrupt, "not a SQLite database");
  await expect(readLedgerIntent(missing, "52")).rejects.toMatchObject({ errcode: 14 });
  await expect(readLedgerIntent(corrupt, "52")).rejects.toMatchObject({ errcode: 26 });
});

it("reports a missing state row immediately after transient contention clears", async () => {
  const { file, writer } = fixture();
  writer.exec("BEGIN EXCLUSIVE; DELETE FROM ledger");
  const read = readLedgerIntent(file, "52");
  writer.exec("COMMIT");
  await expect(read).rejects.toThrow("Ledger state row missing");
});
