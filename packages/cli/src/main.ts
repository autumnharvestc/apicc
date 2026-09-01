import { existsSync, readFileSync } from "node:fs";
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
      const result = await runner.run(collection, env, project, workspace, { runsDir: opts.runsDir });
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        const outDir = join(collectionDir!, "runs");
        const file = await reporter.render(result, outDir);
        log(`报告已生成: ${file}`);
      }
      log(`总计 ${result.total} · 通过 ${result.passed} · 失败 ${result.failed}`);
      process.exitCode = result.failed > 0 ? 1 : 0;
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

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (!(e as { handled?: boolean }).handled) throw e;
  }
  return process.exitCode ?? 0;
}
