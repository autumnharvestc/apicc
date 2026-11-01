import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, lstat, realpath, opendir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ExecutionLocation } from "@apicc/execution/client";
import { ExecutionLocationSchema } from "@apicc/execution/client";

export interface McpIntentReceipt {
  formatVersion: 1;
  ticketId: string;
  intentId: string;
  sourceKind: "online";
  serverIdentity: string;
  memberId: string;
  profileGeneration: string;
  workspaceId: string;
  groupId: string;
  projectId: string;
  contractProjectId: string;
  location: ExecutionLocation;
  snapshotId: string;
  manifestHash: string;
  definitionRevision: string;
  assetVersion: string;
  targetKind: "debug" | "suite" | "workflow";
  environmentId: string | null;
  scriptPlanDigest: string;
  materialVersions: Readonly<Record<string, string>>;
  policyVersion: string;
  executionProfile: "no-script" | "trusted-core-script";
  budgets: Readonly<Record<string, number>>;
  state: "submitting" | "uncertain" | "accepted" | "ended" | "rejected";
  createdAt: string;
  updatedAt: string;
  knownRunId?: string;
  knownExecutionId?: string;
}

export interface McpJournalLimits { journalReceiptBytes?: number; journalMaxRecords?: number; journalTotalBytes?: number }
const text = z.string().min(1).max(512);
export function assertMcpIntentId(value: unknown): asserts value is string { text.parse(value); }
const receiptSchema = z.object({
  formatVersion: z.literal(1), ticketId: z.string().uuid(), intentId: text, sourceKind: z.literal("online"), serverIdentity: text,
  memberId: text, profileGeneration: z.string().uuid(), workspaceId: text, groupId: text, projectId: text, contractProjectId: text,
  location: ExecutionLocationSchema, snapshotId: text, manifestHash: text, definitionRevision: text, assetVersion: text,
  targetKind: z.enum(["debug", "suite", "workflow"]), environmentId: text.nullable(), scriptPlanDigest: text,
  materialVersions: z.record(z.string(), z.string()), policyVersion: text, executionProfile: z.enum(["no-script", "trusted-core-script"]),
  budgets: z.record(z.string(), z.number().finite().nonnegative()), state: z.enum(["submitting", "uncertain", "accepted", "ended", "rejected"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), knownRunId: text.optional(), knownExecutionId: text.optional(),
}).strict();
const sameIntent = (a: McpIntentReceipt, b: McpIntentReceipt) => a.serverIdentity === b.serverIdentity && a.memberId === b.memberId
  && a.workspaceId === b.workspaceId && a.groupId === b.groupId && a.projectId === b.projectId && a.intentId === b.intentId;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

/** Private fixed-root metadata only; the prepared continuation remains in its original owner. */
export function createMcpIntentJournal(privateRoot: string, options: McpJournalLimits = {}) {
  const receiptBytes = options.journalReceiptBytes ?? 16 * 1024;
  const count = options.journalMaxRecords ?? 1000;
  const totalBytes = options.journalTotalBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(receiptBytes) || receiptBytes < 4096 || receiptBytes > 1048576
    || !Number.isSafeInteger(count) || count < 1 || count > 10000
    || !Number.isSafeInteger(totalBytes) || totalBytes < 1048576 || totalBytes > 134217728 || receiptBytes > totalBytes) throw new Error("mcp-invalid-journal-limits");
  privateRoot = resolve(privateRoot);
  const directory = join(privateRoot, "intent-receipts-v1");
  const lock = join(directory, ".write.lock");
  async function ensureDirectory(create: boolean): Promise<boolean> {
    try {
      if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const path of [privateRoot, directory]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || pathKey(await realpath(path)) !== pathKey(path)) throw new Error();
      }
      return true;
    } catch (error) {
      if (!create && errorCode(error) === "ENOENT") return false;
      throw new Error("mcp-intent-journal-unavailable");
    }
  }
  async function read(ticketId: string): Promise<McpIntentReceipt | null> {
    if (!z.string().uuid().safeParse(ticketId).success) return null;
    if (!await ensureDirectory(false)) return null;
    const path = join(directory, `${ticketId}.json`);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > receiptBytes) throw new Error();
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(receiptBytes + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const part = await handle.read(buffer, bytes, buffer.length - bytes, null);
          if (!part.bytesRead) break;
          bytes += part.bytesRead;
        }
        if (bytes > receiptBytes) throw new Error();
        const receipt = receiptSchema.parse(JSON.parse(buffer.subarray(0, bytes).toString("utf8")));
        if (receipt.ticketId !== ticketId) throw new Error();
        return receipt;
      } finally { await handle.close(); }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("mcp-intent-receipt-unreadable");
    }
  }
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    await ensureDirectory(true);
    const deadline = Date.now() + 5000;
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (errorCode(error) !== "EEXIST" || Date.now() >= deadline) throw new Error("mcp-intent-journal-unavailable");
        await delay(20);
      }
    }
    try { await ensureDirectory(false); return await action(); }
    finally { await rmdir(lock).catch(() => {}); }
  }
  async function scan(): Promise<Array<{ receipt: McpIntentReceipt; bytes: number }>> {
    const entries = await opendir(directory);
    const result: Array<{ receipt: McpIntentReceipt; bytes: number }> = [];
    for await (const entry of entries) {
      if (entry.name === ".write.lock") continue;
      const ticketId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (!z.string().uuid().safeParse(ticketId).success || !entry.isFile()) throw new Error("mcp-intent-journal-unavailable");
      if (result.length >= count) throw new Error("mcp-intent-journal-capacity");
      const receipt = await read(ticketId);
      if (!receipt) throw new Error("mcp-intent-receipt-unreadable");
      result.push({ receipt, bytes: (await lstat(join(directory, entry.name))).size });
    }
    return result;
  }
  async function atomicWrite(receipt: McpIntentReceipt, rows: Awaited<ReturnType<typeof scan>>): Promise<void> {
    const serialized = JSON.stringify(receiptSchema.parse(receipt));
    const size = Buffer.byteLength(serialized);
    const old = rows.find(row => row.receipt.ticketId === receipt.ticketId);
    if (size > receiptBytes || (!old && rows.length >= count) || rows.reduce((sum, row) => sum + row.bytes, 0) - (old?.bytes ?? 0) + size > totalBytes) throw new Error("mcp-intent-journal-capacity");
    if (old && !sameIntent(old.receipt, receipt)) throw new Error("intent_conflict");
    const temporary = join(directory, `.receipt-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(serialized, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, join(directory, `${receipt.ticketId}.json`));
    } catch { throw new Error("mcp-intent-journal-unavailable"); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return {
    read,
    write: (receipt: McpIntentReceipt) => locked(async () => atomicWrite(receipt, await scan())),
    admit: (receipt: McpIntentReceipt) => locked(async () => {
      const rows = await scan();
      const prior = rows.find(row => sameIntent(row.receipt, receipt) && row.receipt.state !== "rejected");
      if (prior) return prior.receipt;
      await atomicWrite(receipt, rows);
      return null;
    }),
  };
}
