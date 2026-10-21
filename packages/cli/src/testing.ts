import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { createExecutionEvidenceCollector, createProjectSnapshot, prepareTestData, resolveSuitePlan, suiteCaseRequests, SuiteRunner, suiteToRunResult, validateSuiteData, validateSuiteExecution,
  type PluginRegistry, type SuiteRunOverrides } from "@apicc/core";
import { prepareExecutionRunFromSnapshot, type CredentialHostOptions } from "./credentials.js";
import { assertWorkspaceUsable, loadWorkspace, locateProject } from "./workspace.js";
import { createOutputSanitizer } from "./output.js";

interface TestOptions {
  project: string;
  env?: string;
  dataset?: string;
  failFast?: boolean;
  allowDraft?: boolean;
  reporters?: string;
  runsDir?: string;
  evidence?: string;
}
export function registerTestingCommands(program: Command, host: {
  registry: PluginRegistry;
  log: (line: string) => void;
  workspaceRoot: () => string | null;
  credentialOptions: CredentialHostOptions;
}): void {
  const group = program.command("test").description("当前项目测试套件");
  const load = async (opts: TestOptions) => {
    const root = host.workspaceRoot();
    if (!root) throw new Error("未找到 apicc.workspace.yaml");
    const state = await loadWorkspace(host.registry, root); assertWorkspaceUsable(state);
    return { root, workspace: state.workspace, ...locateProject(state.workspace, opts.project) };
  };
  group.command("list").requiredOption("--project <path>", "项目完整 UUID 路径").action(async (opts: TestOptions) => {
    const { project } = await load(opts);
    host.log(JSON.stringify((project.suites ?? []).map(({ id, name, tags }) => ({ id, name, tags }))));
  });
  for (const mode of ["preview", "run"] as const) {
    group.command(mode).argument("<suiteId>").requiredOption("--project <path>", "项目完整 UUID 路径")
      .option("--env <id>", "本次环境 ID 或唯一名称").option("--dataset <id>", "本次数据集 ID")
      .option("--fail-fast", "本次首错停止").option("--allow-draft", "本次允许 draft 工作流")
      .option("--reporters <list>", "本次报告格式 html,json,junit").option("--runs-dir <path>", "本次报告目录")
      .option("--evidence <mode>", "证据正文 none,failures,all", "failures")
      .action(async (suiteId: string, opts: TestOptions) => {
        const controller = new AbortController(); const abort = () => controller.abort();
        let sanitizer = createOutputSanitizer([]);
        if (mode === "run") { process.on("SIGINT", abort); process.on("SIGTERM", abort); }
        try {
          const { root, workspace, project, group } = await load(opts);
          if (!["none", "failures", "all"].includes(opts.evidence ?? "failures")) throw new Error("证据模式仅支持 none,failures,all");
          let environmentId: string | undefined;
          if (opts.env !== undefined) {
            const environments = project.environments.filter((env) => env.id === opts.env || env.name === opts.env);
            if (environments.length !== 1) throw new Error("环境不存在或名称有歧义");
            environmentId = environments[0]!.id;
          }
          const reporters = opts.reporters?.split(",").map((format) => format.trim());
          if (reporters?.some((format) => !["html", "json", "junit"].includes(format))) throw new Error("报告格式仅支持 html,json,junit");
          const overrides: SuiteRunOverrides = { ...(environmentId === undefined ? {} : { environmentId }), ...(opts.dataset === undefined ? {} : { datasetId: opts.dataset }),
            ...(opts.failFast === undefined ? {} : { failFast: opts.failFast }), ...(opts.allowDraft === undefined ? {} : { allowDraft: opts.allowDraft }),
            ...(reporters === undefined ? {} : { reporters: reporters as ("html" | "json" | "junit")[] }) };
          const snapshot = createProjectSnapshot(project); const plan = resolveSuitePlan(snapshot, suiteId, overrides);
          const data = await prepareTestData(snapshot, plan.selections, { workspaceRoot: root });
          const preview = validateSuiteData(plan, data);
          validateSuiteExecution(snapshot, plan, host.registry);
          if (mode === "preview") { host.log(JSON.stringify(preview)); return; }
          for (const format of plan.reporters) if (format !== "json" && !host.registry.getReporter(format)) throw new Error(`未注册报告格式: ${format}`);
          const prepared = await prepareExecutionRunFromSnapshot(workspace, group.id, project, snapshot, suiteCaseRequests(snapshot, plan), host.credentialOptions,
            undefined, undefined, { workspaceRoot: root, environmentId: plan.environmentId, preparedTestData: data, signal: controller.signal });
          const output = createOutputSanitizer(prepared.secrets);
          sanitizer = output;
          const evidence = createExecutionEvidenceCollector({ projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, environmentId: plan.environmentId, dataDigest: data.digest, datasetId: plan.datasetId }, prepared.secrets, { mode: opts.evidence as "none" | "failures" | "all" });
          const result = await new SuiteRunner({ registry: host.registry }).run(prepared.run, plan, { workspaceRoot: root, signal: controller.signal,
            observeCaseExecution: (execution, identity) => evidence.observe(execution, { ...identity, workflowId: plan.entries.find((entry) => entry.id === identity.entryId)?.workflowId }) });
          sanitizer = evidence.boundary();
          const safe = evidence.projectRun(suiteToRunResult(result));
          const outDir = opts.runsDir ?? join(root, ".apicc", "runs"); mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, `suite-run-${result.suiteRunId}.json`), JSON.stringify(safe, null, 2));
          // JSON is durable before optional presentation formats; C1 owns richer evidence projection.
          let reportFailure = false;
          for (const format of plan.reporters) if (format !== "json") try { await host.registry.getReporter(format)!.render(safe, outDir); }
          catch { reportFailure = true; host.log(`${format} 报告渲染失败；安全 JSON 已保留`); }
          host.log(output.redactText(`套件条目 ${result.total} · 通过 ${result.passed} · 失败 ${result.failed} · 跳过 ${result.skipped}；实际用例行 ${safe.total}`));
          process.exitCode = result.verdict === "passed" && !reportFailure ? 0 : 1;
        } catch (error) {
          process.exitCode = 1;
          host.log(sanitizer.redactText(error instanceof Error ? error.message : "套件执行失败"));
        } finally {
          if (mode === "run") { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
        }
      });
  }
}
