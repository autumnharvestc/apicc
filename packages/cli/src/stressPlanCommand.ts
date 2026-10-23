import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import {
  StressPlanSchema, SavedStressPlanSchema, PreparedTestDataSchema, createProjectSnapshot, compileStressPlan, bindPreparedStressExecution,
  createExecutionEvidenceCollector, createPreparedStressHost, createStressRequestGate, createStressAccumulator,
  runStressPlan, runLocalStressWorkers, serveLocalStressWorker, assertStressTargetAllowed,
  type StressClock, type StressPlan, type PluginRegistry, type PreparedTestData, type StressRequestGate, type StressWorkerChannel,
  StressWorkerSpecSchema, type StressWorkerRuntime,
  parseStressReport, compareStressReports, renderStressHtml,
  stressArrivalWindowNotices,
} from "@apicc/core";
import { prepareExecutionRunFromSnapshot, type CredentialHostOptions } from "./credentials.js";
import { assertWorkspaceUsable, loadWorkspace, locateProject } from "./workspace.js";
import { processStressWorkerChannel, spawnLocalStressWorker } from "./stressWorkerTransport.js";

export const localStressClock: StressClock = { now: () => performance.now(), wallNow: () => Date.now(), sleep(ms, signal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.min(2147000000, Math.max(1, ms)));
    signal?.addEventListener("abort", abort, { once: true });
  });
} };
const workerConfigSchema = z.object({ kind: z.literal("plan"), root: z.string(), projectPath: z.string(), plan: StressPlanSchema,
  definitionRevision: z.string(), credentialVersions: StressWorkerSpecSchema.shape.credentialVersions, networkIdentity: z.string(),
  preparedTestData: PreparedTestDataSchema, confirmedTargetOrigins: z.array(z.string()) }).strict();
const legacyWorkerConfigSchema = StressWorkerSpecSchema.omit({ protocolVersion: true, shardId: true }).extend({ kind: z.literal("legacy") }).strict();
export async function prepareCliStressPlan(registry: PluginRegistry, root: string, projectPath: string, plan: StressPlan, credentials: CredentialHostOptions,
  signal: AbortSignal, expected?: { definitionRevision: string; credentialVersions: Record<string, string>; networkIdentity: string; preparedTestData: PreparedTestData }) {
  const state = await loadWorkspace(registry, root); assertWorkspaceUsable(state);
  const { project, group } = locateProject(state.workspace, projectPath);
  const snapshot = createProjectSnapshot(project), compiled = compileStressPlan(snapshot, plan);
  const prepared = await prepareExecutionRunFromSnapshot(state.workspace, group.id, project, snapshot, compiled.targets.flatMap((target) => [...target.requests]), credentials,
    expected?.credentialVersions, expected?.definitionRevision, { workspaceRoot: root, environmentId: plan.environmentId, signal,
      ...(expected ? { expectedNetworkIdentity: expected.networkIdentity, preparedTestData: expected.preparedTestData } : {}) });
  const execution = bindPreparedStressExecution(compiled, prepared.run);
  const evidence = createExecutionEvidenceCollector({ projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, environmentId: plan.environmentId, dataDigest: prepared.run.preparedTestData?.digest }, prepared.secrets, { maxSamples: 20, privateMarkers: true });
  return { execution, prepared, evidence };
}

export function createPlanGate(execution: Awaited<ReturnType<typeof prepareCliStressPlan>>["execution"], confirmedTargetOrigins: string[], clock: StressClock): StressRequestGate {
  const { compiled, run } = execution;
  let gate: StressRequestGate;
  gate = createStressRequestGate({ clock, maxConcurrency: compiled.schedule.effective.maxRequestConcurrency, maxRps: compiled.schedule.effective.maxRps ?? undefined,
    authorizeRequest(request) {
      const policy = { ...run.snapshot.project.stressPolicy, trustedOrigins: [...(run.snapshot.project.stressPolicy.trustedOrigins ?? [])], deniedOrigins: [...(run.snapshot.project.stressPolicy.deniedOrigins ?? [])] };
      const decision = assertStressTargetAllowed({ url: request.url, policy, confirmedTargetOrigins, concurrency: compiled.schedule.effective.maxRequestConcurrency, maxRps: compiled.schedule.effective.maxRps ?? undefined });
      gate.recordTarget?.({ origin: decision.targetOrigin, confirmation: decision.confirmation, loopback: decision.loopback,
        policy: decision.confirmation === "project-policy" ? "trusted" : decision.appliedPolicy.maxConcurrency !== undefined || decision.appliedPolicy.maxRps !== undefined ? "explicit-limited" : "none", appliedPolicy: decision.appliedPolicy });
    } });
  return gate;
}

export interface StressPlanCommandDeps {
  registry: PluginRegistry; root(): string | undefined; credentials: CredentialHostOptions; log(line: string): void;
  workerArgs(identity: { runId: string; workerId: string }): string[];
  spawnWorker?: (identity: { runId: string; workerId: string }, timeoutMs: number, prepare: (configuration: unknown, signal?: AbortSignal) => Promise<StressWorkerRuntime>) => Promise<StressWorkerChannel>;
  prepareLegacy(configuration: z.infer<typeof legacyWorkerConfigSchema>, signal?: AbortSignal): Promise<StressWorkerRuntime>;
}
export function registerStressPlanCommands(program: Command, deps: StressPlanCommandDeps): (configuration: unknown, signal?: AbortSignal) => Promise<StressWorkerRuntime> {
  const prepareWorker = async (value: unknown, signal = new AbortController().signal): Promise<StressWorkerRuntime> => {
    const legacy = legacyWorkerConfigSchema.safeParse(value); if (legacy.success) return deps.prepareLegacy(legacy.data, signal);
    const config = workerConfigSchema.parse(value);
    const { execution, evidence } = await prepareCliStressPlan(deps.registry, config.root, config.projectPath, config.plan, deps.credentials, signal, config);
    return { clock: localStressClock, metricPlan: execution.compiled.metricPlan, lifecycle: config.plan.lifecycle, evidence,
      host: createPreparedStressHost(execution, { registry: deps.registry, evidence, workspaceRoot: config.root }, { confirmedTargetOrigins: config.confirmedTargetOrigins }) };
  };
  program.command("run-stress-plan").argument("<projectPath>").requiredOption("--plan <file>")
    .option("--shards <n>", "本机 worker 数", Number, 1).option("--shard-timeout <s>", "worker 超时秒数", Number, 300)
    .option("--allow-target <origin>", "本次确认 origin", (value: string, all: string[]) => [...all, value], []).option("--runs-dir <dir>")
    .option("--html <file>", "自包含离线 HTML 报告").option("--baseline <reportFile>", "显式基线报告文件")
    .action(async (projectPath: string, opts: { plan: string; shards: number; shardTimeout: number; allowTarget: string[]; runsDir?: string; html?: string; baseline?: string }) => {
      const root = deps.root(); if (!root) throw new Error("未找到 apicc.workspace.yaml");
      const raw: unknown = JSON.parse(readFileSync(opts.plan, "utf8"));
      const saved = SavedStressPlanSchema.safeParse(raw), plan = saved.success ? saved.data.plan : StressPlanSchema.parse(raw);
      const baseline = opts.baseline ? parseStressReport(JSON.parse(readFileSync(opts.baseline, "utf8"))) : undefined;
      if (!Number.isSafeInteger(opts.shards) || opts.shards < 1 || opts.shards > plan.maxVus) throw new Error("shards exceeds VU capacity");
      const timeout = opts.shardTimeout * 1000; if (!Number.isFinite(timeout) || timeout <= 0 || timeout > Number.MAX_SAFE_INTEGER) throw new Error("Invalid shard-timeout");
      const confirmedTargetOrigins = opts.allowTarget.map((value) => { const parsed = new URL(value); if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== value) throw new Error("Invalid target origin"); return parsed.origin; });
      const controller = new AbortController(), cancel = () => controller.abort(); process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
      try {
        const { execution, evidence, prepared } = await prepareCliStressPlan(deps.registry, root, projectPath, plan, deps.credentials, controller.signal);
        if (baseline?.projectId && baseline.projectId !== execution.compiled.projectId) throw new Error("Cannot compare different projects");
        const host = createPreparedStressHost(execution, { registry: deps.registry, evidence, workspaceRoot: root }, { confirmedTargetOrigins });
        const runId = randomUUID(), common = { ...host, runId, clock: localStressClock, gate: createPlanGate(execution, confirmedTargetOrigins, localStressClock),
          metrics: createStressAccumulator(execution.compiled.metricPlan, runId), evidence, signal: controller.signal };
        const report = opts.shards === 1 ? await runStressPlan(execution, common) : await runLocalStressWorkers(execution, { ...common, shards: opts.shards,
          configuration: { kind: "plan", root, projectPath, plan, definitionRevision: prepared.snapshot.definitionRevision, credentialVersions: prepared.run.credentialBindings.versions,
            networkIdentity: prepared.network!.identity, preparedTestData: prepared.run.preparedTestData, confirmedTargetOrigins },
          spawnWorker: (identity) => deps.spawnWorker ? deps.spawnWorker(identity, timeout, prepareWorker) : Promise.resolve(spawnLocalStressWorker(deps.workerArgs(identity), timeout)) });
        const dir = opts.runsDir ?? join(root, ".apicc", "runs"); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `stress-plan-${runId}.json`), JSON.stringify(report, null, 2));
        const comparison = baseline ? compareStressReports(baseline, report) : undefined;
        if (opts.html) writeFileSync(opts.html, renderStressHtml(report, comparison));
        if (comparison) deps.log(`基线比较：${JSON.stringify(comparison)}`);
        deps.log(`压测完成：迭代 ${report.iterations.completed}/${report.iterations.planned} · 请求 ${report.requests.eligibleCompleted} · verdict: ${report.verdict.status}`);
        for (const notice of stressArrivalWindowNotices(report)) deps.log(notice.message);
        process.exitCode = report.verdict.passed ? 0 : 1;
      } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
    });
  program.command("stress-plan-worker").requiredOption("--run-id <id>").requiredOption("--worker-id <id>")
    .action((opts: { runId: string; workerId: string }) => {
      const peer = serveLocalStressWorker(processStressWorkerChannel(), opts, prepareWorker);
      process.once("disconnect", () => { void peer.close(); });
    });
  return prepareWorker;
}
