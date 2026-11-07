import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
import { defaultAgentConfig, type TaskDeliveryV1 } from "@apicc/execution/contract";
import { ExecutionLedger, type ExecutionProcess, type ExecutionProcessIntent } from "../src/ledger.js";

const serverId = "https://control.test/api/v1", agentId = "7";
const config = { ...defaultAgentConfig, minFreeDiskBytes: 1 };
const scope = { workspaceId: "11", groupId: "22", projectId: "33" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "apicc-ledger-compaction-"));
  const opened: ExecutionLedger[] = [];
  const open = (options = { enabled: true, batchSize: 50 }) => {
    const ledger = new ExecutionLedger(directory, serverId, agentId, config, options); opened.push(ledger); return ledger;
  };
  const read = () => {
    const db = new DatabaseSync(join(directory, "execution-ledger.sqlite"), { readOnly: true });
    try { return JSON.parse((db.prepare("SELECT state FROM ledger WHERE id=1").get() as { state: string }).state); }
    finally { db.close(); }
  };
  const database = (action: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(join(directory, "execution-ledger.sqlite"));
    try { action(db); } finally { db.close(); }
  };
  const rewrite = (action: (state: ReturnType<typeof read>) => void) => {
    const state = read(); action(state); database(db => { db.prepare("UPDATE ledger SET state=? WHERE id=1").run(JSON.stringify(state)); });
  };
  onTestFinished(() => {
    for (const ledger of opened) ledger.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, open, read, database, rewrite };
}
function history(ledger: ExecutionLedger, executionId = "501", partial = false) {
  const jobId = String(Number(executionId) + 100), runId = randomUUID(), epoch = ledger.childLease!.epoch;
  const delivery = { messageId: `delivery-${executionId}`, task: { executionId, jobId } } as TaskDeliveryV1;
  ledger.accept(delivery); ledger.reserve(executionId, 4096); ledger.mark(executionId, "uncertain"); ledger.observeProcesses(executionId, 2);
  const intents: ExecutionProcessIntent[] = ["coordinator", "worker-1"].map(workerId => ({ id: `${runId}/${workerId}`, runId, workerId, role: workerId === "coordinator" ? "coordinator" : "worker", scope, epoch, scriptPath: join(tmpdir(), "taskChild.js") }));
  const processes: ExecutionProcess[] = intents.map((intent, index) => ({ id: intent.id, name: intent.workerId, role: intent.role, pid: 50001 + index, scope, epoch, birth: "123", exited: false }));
  for (const intent of intents) ledger.recordProcessIntent(executionId, intent);
  for (const process of processes) ledger.recordProcess(executionId, { ...process, ...(partial ? { observationUncertain: true } : {}) });
  for (const process of processes) ledger.recordProcess(executionId, { ...process, observationUncertain: false, exited: true, code: 0, signal: null });
  ledger.enqueue({ messageId: `accepted-${executionId}`, kind: "accepted", jobId, executionId });
  ledger.command({ messageId: `cancel-${executionId}`, kind: "cancel", jobId, executionId });
  ledger.settle(executionId, { executionId, verdict: "interrupted", reasonCode: "worker-exited" });
  const report = ledger.reports.find(item => item.executionId === executionId)!;
  return { delivery, receipt: { archived: true, reportHash: report.hash, reportBytes: report.bytes }, intents, processes };
}

it.each(["ack-first", "archive-first"])("compacts confirmed history after %s across a real SQLite reopen without deleting identity or totals", order => {
  const { open, read } = fixture(); let ledger = open(); const item = history(ledger, "501", true);
  const before = read().intents[0];
  if (order === "ack-first") ledger.acknowledge(ledger.messages.map(message => message.messageId));
  else expect(ledger.archive("501", item.receipt)).toBe(true);
  expect(read().intents[0].processes).toHaveLength(2);
  ledger.close(); ledger = open();
  if (order === "ack-first") expect(ledger.archive("501", item.receipt)).toBe(true);
  else ledger.acknowledge(ledger.messages.map(message => message.messageId));
  const expected = { ...before, archived: true }; delete expected.report; delete expected.processes; delete expected.processIntents;
  expect(read().intents[0]).toEqual(expected);
  expect(ledger.intents[0]).toEqual(expected);
  expect(expected).toMatchObject({ fact: "uncertain", processBudget: 2, processObservationPartial: true, processObservation: { completeness: "partial", started: 2, exited: 2, peak: 0 } });
  expect(read().commands).toEqual([{ messageId: "cancel-501", kind: "cancel", executionId: "501", jobId: "601" }]);
  ledger.close(); ledger = open(); ledger.recover(); ledger.accept(item.delivery);
  expect(ledger.intents).toHaveLength(1); expect(ledger.reports).toEqual([]); expect(ledger.messages).toEqual([]);
});

it("retains details until every message for the execution or job is acknowledged and the exact report is archived", () => {
  const { open, read } = fixture(), ledger = open(), item = history(ledger);
  ledger.acknowledge(["completed-501"]);
  expect(ledger.archive("501", { ...item.receipt, reportHash: "0".repeat(64) })).toBe(false);
  expect(ledger.compact()).toBe(0); expect(ledger.reports).toHaveLength(1);
  ledger.enqueue({ messageId: "accepted-retry", kind: "accepted", executionId: "502", jobId: "601" });
  expect(ledger.archive("501", item.receipt)).toBe(true);
  ledger.acknowledge(["accepted-501"]); expect(read().intents[0].processes).toHaveLength(2);
  ledger.acknowledge(["accepted-retry"]); expect(read().intents[0].processes).toBeUndefined();
});

it("does not compact an active process lifecycle or use process updates as maintenance triggers", () => {
  const { open, read } = fixture(), ledger = open();
  ledger.accept({ messageId: "active", task: { executionId: "503", jobId: "603" } } as TaskDeliveryV1);
  const runId = randomUUID(), intent: ExecutionProcessIntent = { id: `${runId}/coordinator`, runId, workerId: "coordinator", role: "coordinator", scope, epoch: ledger.childLease!.epoch, scriptPath: join(tmpdir(), "taskChild.js") };
  ledger.recordProcessIntent("503", intent);
  ledger.recordProcess("503", { id: intent.id, name: "active coordinator", role: intent.role, scope, epoch: intent.epoch, pid: 50003, exited: false });
  const before = read(); expect(ledger.compact()).toBe(0); expect(read()).toEqual(before);
});

const unsafeHistory: Array<[string, (entry: any) => void]> = [
  ["empty processes with outstanding spawn intents", entry => { entry.processes = []; }],
  ["missing process registration", entry => { entry.processes.pop(); }],
  ["unknown process exit", entry => { entry.processes[0].observationUncertain = true; }],
  ["live process", entry => { entry.processes[0].exited = false; }],
  ["mismatched epoch", entry => { entry.processes[0].epoch = "different-epoch"; }],
  ["mismatched scope", entry => { entry.processes[0].scope.projectId = "34"; }],
  ["mismatched role", entry => { entry.processes[0].role = "worker"; }],
  ["duplicate process identity", entry => { entry.processes[1] = entry.processes[0]; }],
  ["duplicate spawn identity", entry => { entry.processIntents[1] = entry.processIntents[0]; }],
  ["missing spawn details", entry => { delete entry.processIntents; }],
  ["invalid process shape", entry => { entry.processes[0].pid = "50001"; }],
  ["unknown legacy process field", entry => { entry.processes[0].exitUnknown = true; }],
  ["invalid spawn shape", entry => { delete entry.processIntents[0].scriptPath; }],
  ["inconsistent aggregate observation", entry => { entry.processObservation.exited = 1; }],
  ["missing archive confirmation", entry => { delete entry.archived; }],
  ["inconsistent settlement flag", entry => { entry.settled = false; }],
];
it.each(unsafeHistory)("conservatively retains %s after reopening legacy SQLite data", (_name, mutate) => {
  const { open, read, rewrite } = fixture(); let ledger = open({ enabled: false, batchSize: 50 }); const item = history(ledger);
  ledger.acknowledge(ledger.messages.map(message => message.messageId)); ledger.archive("501", item.receipt); ledger.close();
  rewrite(state => mutate(state.intents[0])); ledger = open();
  const before = read(); expect(ledger.compact()).toBe(0); expect(read()).toEqual(before); expect(ledger.healthy).toBe(true);
});

it("leaves a legacy archived flag with a still-pending valid report untouched", () => {
  const { open, read, rewrite } = fixture(); let ledger = open({ enabled: false, batchSize: 50 }); history(ledger);
  ledger.acknowledge(ledger.messages.map(message => message.messageId)); ledger.close(); rewrite(state => { state.intents[0].archived = true; });
  ledger = open(); const before = read(); expect(ledger.compact()).toBe(0); expect(read()).toEqual(before);
});

it("checks only a configured batch, advances past unsafe history and writes at most once per changed batch", () => {
  const { open, read, rewrite, database } = fixture(); let ledger = open({ enabled: false, batchSize: 2 });
  for (const id of ["510", "511", "512", "513", "514"]) { const item = history(ledger, id); ledger.archive(id, item.receipt); }
  ledger.acknowledge(ledger.messages.map(message => message.messageId)); ledger.close();
  rewrite(state => { for (const entry of state.intents.slice(0, 2)) entry.processes[0].observationUncertain = true; });
  database(db => db.exec("CREATE TABLE writes(n INTEGER); INSERT INTO writes VALUES(0); CREATE TRIGGER count_writes AFTER UPDATE ON ledger BEGIN UPDATE writes SET n=n+1; END"));
  ledger = open({ enabled: true, batchSize: 2 });
  expect(ledger.compact()).toBe(0); expect(read().intents.every((entry: any) => entry.processes)).toBe(true);
  expect(ledger.compact()).toBe(2); expect(ledger.compact()).toBe(1); expect(ledger.compact()).toBe(0);
  expect(read().intents.filter((entry: any) => entry.processes)).toHaveLength(2);
  database(db => expect(db.prepare("SELECT n FROM writes").get()).toEqual({ n: 2 }));
});

it("keeps eligible details when disabled across ACK, archive, explicit maintenance and reopen", () => {
  const { open, read } = fixture(); let ledger = open({ enabled: false, batchSize: 1 }); const item = history(ledger);
  ledger.acknowledge(ledger.messages.map(message => message.messageId)); ledger.archive("501", item.receipt);
  const before = read(); expect(ledger.compact()).toBe(0); ledger.close(); ledger = open({ enabled: false, batchSize: 1 });
  expect(ledger.compact()).toBe(0); expect(read()).toEqual(before);
});

it.each(["archive", "ack", "maintenance"])("rolls back the complete %s transaction and retains unhealthy state on a real SQLite compaction write failure", last => {
  const { open, read, database } = fixture(); let ledger = open({ enabled: false, batchSize: 50 }); const item = history(ledger);
  if (last !== "archive") ledger.archive("501", item.receipt);
  if (last !== "ack") ledger.acknowledge(ledger.messages.map(message => message.messageId));
  ledger.close(); ledger = open(); const before = read(), memoryBefore = structuredClone(ledger.intents);
  database(db => db.exec("CREATE TRIGGER deny_compaction BEFORE UPDATE ON ledger WHEN instr(NEW.state,'processIntents')=0 BEGIN SELECT RAISE(ABORT,'controlled compaction write rejection'); END"));
  const action = () => last === "archive" ? ledger.archive("501", item.receipt) : last === "ack" ? ledger.acknowledge(ledger.messages.map(message => message.messageId)) : ledger.compact();
  expect(action).toThrow("controlled compaction write rejection");
  expect(ledger.healthy).toBe(false); expect(read()).toEqual(before); expect(ledger.intents).toEqual(memoryBefore);
  ledger.close(); ledger = open({ enabled: false, batchSize: 50 }); expect(read()).toEqual(before); expect(ledger.intents).toEqual(memoryBefore);
});
