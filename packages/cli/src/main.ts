import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginRegistry } from "@apicc/core";

/** 路径分隔符归一为 "/"，使集合目录匹配与用户输入的正/反斜杠形态无关（Windows 兼容）。 */
function toSlash(p: string): string {
  return p.split("\\").join("/");
}

/** 从起始目录向上查找 apicc.workspace.yaml。 */
export function findWorkspaceRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "apicc.workspace.yaml"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function runCli(argv: string[], registry: PluginRegistry, log: (line: string) => void = console.log): Promise<number> {
  // 进入时重置进程退出码：同进程多次调用 runCli（编程/测试场景）互不串扰，
  // 各命令只反映本次调用的结果（bin.ts 执行完毕后会把返回值写回 process.exitCode）。
  process.exitCode = 0;
  const { Command } = await import("commander");
  const program = new Command();
  program.name("apicc").description("apicc 命令行——接口定义与测试驱动开发").version("0.1.0");

  program
    .command("validate")
    .argument("<root>", "工作区根目录")
    .action(async (root: string) => {
      const storage = registry.getStorage();
      if (!storage) throw new Error("未注册存储适配器");
      const { problems } = await storage.load(root);
      if (problems.length === 0) {
        log("工作区校验通过，未发现问题文件");
      } else {
        for (const p of problems) log(`[问题] ${p.file}: ${p.message}`);
        process.exitCode = 1;
        throw Object.assign(new Error(`发现 ${problems.length} 个问题文件`), { handled: true });
      }
    });

  program
    .command("run")
    .argument("<collectionPath>", "集合目录（相对工作区根）")
    .requiredOption("--env <name>", "环境名称")
    .option("--reporters <list>", "报告格式，逗号分隔", "html")
    .option("--runs-dir <dir>", "运行历史输出目录")
    .option("--fail-fast", "首个失败后停止", false)
    .action(async (collectionPath: string, opts: { env: string; reporters: string; runsDir?: string; failFast: boolean }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const storage = registry.getStorage();
      if (!storage) throw new Error("未注册存储适配器");
      const { workspace } = await storage.load(root);
      let collectionDir: string | undefined;
      let collection: import("@apicc/core").Collection | undefined;
      let project: import("@apicc/core").Project | undefined;
      const target = toSlash(collectionPath);
      search:
      for (const g of workspace.groups) {
        for (const p of g.projects) {
          for (const c of p.collections) {
            const dir = join(root, "groups", g.name, "projects", p.name, "collections", c.name);
            const normalized = toSlash(dir);
            // 全等或按分隔符边界后缀匹配：避免 "api" 误命中 "xapi"；首个命中即止，重名集合取确定性首个。
            if (normalized === target || normalized.endsWith(`/${target}`)) {
              collection = c; project = p; collectionDir = dir;
              break search;
            }
          }
        }
      }
      if (!collection || !project) throw new Error(`未找到集合: ${collectionPath}`);
      const env = project.environments.find((e) => e.name === opts.env);
      if (!env) throw new Error(`未找到环境: ${opts.env}`);

      const { CollectionRunner } = await import("@apicc/core");
      const runner = new CollectionRunner({
        registry, bus: (await import("@apicc/core")).createEventBus(),
        timeouts: { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 },
        failFast: opts.failFast,
      });
      // 生成物隔离（规格 §6）：运行历史与报告默认写工作区根 .apicc/runs，不污染 Git 友好的数据树；
      // --runs-dir 仍可覆盖。原始结果 JSON 与报告同目录，run 后 validate 不会报假问题。
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      const result = await runner.run(collection, env, project, workspace, { runsDir: runsOutDir });
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        const file = await reporter.render(result, runsOutDir);
        log(`报告已生成: ${file}`);
      }
      log(`总计 ${result.total} · 通过 ${result.passed} · 失败 ${result.failed}`);
      process.exitCode = result.failed > 0 ? 1 : 0;
    });

  // 工作流运行（任务 8）：复用 run 命令的加载/定位/报告模式；结构校验（含环拒绝）由 WorkflowRunner
  // 内部执行，CLI 只负责目录定位、env 解析与草稿状态门。
  program
    .command("run-workflow")
    .argument("<workflowPath>", "工作流目录（相对工作区根，如 groups/g/projects/p/workflows/名）")
    .option("--env <name>", "环境名称")
    .option("--force-draft", "允许运行草稿（跳过生命周期与启用校验，仅结构校验）", false)
    .option("--reporters <list>", "报告格式，逗号分隔", "html")
    .option("--runs-dir <dir>", "运行历史输出目录")
    .action(async (workflowPath: string, opts: { env?: string; forceDraft: boolean; reporters: string; runsDir?: string }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const storage = registry.getStorage();
      if (!storage) throw new Error("未注册存储适配器");
      const { workspace } = await storage.load(root);
      let workflow: import("@apicc/core").Workflow | undefined;
      let project: import("@apicc/core").Project | undefined;
      const target = toSlash(workflowPath);
      search:
      for (const g of workspace.groups) {
        for (const p of g.projects) {
          for (const w of p.workflows) {
            const dir = join(root, "groups", g.name, "projects", p.name, "workflows", w.name);
            const normalized = toSlash(dir);
            // 与 run 同款匹配：全等或按分隔符边界后缀（避免误命中同名前缀）；首个命中即止。
            if (normalized === target || normalized.endsWith(`/${target}`)) {
              workflow = w; project = p;
              break search;
            }
          }
        }
      }
      if (!workflow || !project) throw new Error(`未找到工作流: ${workflowPath}`);
      // env 解析：未指定则不启用环境（执行器侧为空快照）；指定但未命中显式报错。
      const env = opts.env ? project.environments.find((e) => e.name === opts.env) : undefined;
      if (opts.env && !env) throw new Error(`未找到环境: ${opts.env}`);
      // 状态门：草稿默认拒绝，--force-draft 放行（生命周期与启用校验跳过，仅剩结构校验）。
      if (workflow.status === "draft" && !opts.forceDraft) {
        throw new Error("工作流为草稿，请先发布启用或加 --force-draft");
      }
      const { WorkflowRunner, workflowToRunResult } = await import("@apicc/core");
      // resolve：workspace 全树查找接口定义（含文件夹内接口）。
      const findApi = (apiId: string) => {
        for (const g of workspace.groups) for (const p of g.projects) for (const c of p.collections) {
          const api = c.apis.find((a) => a.id === apiId);
          if (api) return api;
          for (const f of c.folders) { const fa = f.apis.find((a) => a.id === apiId); if (fa) return fa; }
        }
        return undefined;
      };
      const runner = new WorkflowRunner({ registry, resolve: findApi, envName: env?.name, failFast: false });
      const wfr = await runner.run(workflow, { project, workspace });
      // 生成物隔离（规格 §6）：原始结果 JSON 与报告同目录（对齐 run 命令产物口径），默认 .apicc/runs。
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      mkdirSync(runsOutDir, { recursive: true });
      writeFileSync(join(runsOutDir, `workflow-${wfr.workflowId}-${Date.now()}.json`), JSON.stringify(wfr, null, 2));
      const result = workflowToRunResult(wfr);
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        const file = await reporter.render(result, runsOutDir);
        log(`报告已生成: ${file}`);
      }
      for (const w of wfr.warnings) log(`[警告] ${w}`);
      log(`总计 ${wfr.total} · 通过 ${wfr.passed} · 失败 ${wfr.failed} · 跳过 ${wfr.skipped}`);
      process.exitCode = wfr.failed > 0 ? 1 : 0;
    });

  program
    .command("export-design")
    .argument("<apiPath>", "接口目录（相对工作区根）")
    .action(async (apiPath: string) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml");
      const dir = join(root, apiPath);
      const { parse: parseYaml } = await import("yaml");
      const { ApiDefinitionSchema, renderDesignMarkdown } = await import("@apicc/core");
      const api = ApiDefinitionSchema.parse(parseYaml(readFileSync(join(dir, "api.yaml"), "utf8")));
      // 注：详细设计存于 design.md（api.yaml 不含 design 字段，规格 §6/§8），
      // 与 fileStorage.loadApiDir 的读取口径一致；简报测试要求导出内容包含设计正文。
      const designFile = join(dir, "design.md");
      if (existsSync(designFile)) api.design = readFileSync(designFile, "utf8");
      log(renderDesignMarkdown(api));
    });

  // 非交互导入（任务 7）：默认只预览，--yes 确认写入；分组不存在则创建，同名项目拒绝。
  program
    .command("import")
    .argument("<file>", "导入文件路径")
    .requiredOption("--group <name>", "目标分组名")
    .option("--yes", "跳过预览直接写入", false)
    .action(async (file: string, opts: { group: string; yes: boolean }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml");
      const content = readFileSync(file, "utf8");
      const importer = registry.listImporters().find((i) => i.detect(file, content));
      if (!importer) throw new Error("无法识别的导入格式");
      const { project, warnings } = importer.parse(content);
      if (!opts.yes) {
        log(`预览：将导入项目「${project.name}」（集合 ${project.collections.length} 个）`);
        for (const w of warnings) log(`[警告] ${w}`);
        log("非交互模式请加 --yes 确认写入");
        return;
      }
      const storage = registry.getStorage()!;
      const { workspace } = await storage.load(root);
      let group = workspace.groups.find((x) => x.name === opts.group);
      if (!group) { group = { id: crypto.randomUUID(), name: opts.group, projects: [] }; workspace.groups.push(group); }
      if (group.projects.some((x) => x.name === project.name)) throw new Error(`项目已存在: ${project.name}`);
      group.projects.push(project);
      await storage.save(root, workspace);
      for (const w of warnings) log(`[警告] ${w}`);
      log(`已导入项目「${project.name}」到分组「${opts.group}」`);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (!(e as { handled?: boolean }).handled) throw e;
  }
  return process.exitCode ?? 0;
}
