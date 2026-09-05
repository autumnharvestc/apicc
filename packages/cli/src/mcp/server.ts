import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CollectionRunner,
  createDefaultRegistry,
  createEventBus,
  renderDesignMarkdown,
  version,
  type ApiDefinition,
  type Collection,
  type PluginRegistry,
  type Project,
  type Workspace,
} from "@apicc/core";

/**
 * apicc stdio MCP 服务器（M6 规格 D5/D6，裁定①–⑥）：
 * - SDK = @modelcontextprotocol/sdk（裁定①：选当前稳定最新 1.30.0）；
 * - 工具集：list-apis / get-api-design 只读，run-case 仅 --allow-run 时注册（裁定⑥：
 *   关闭时不出现在 tools/list，而非调用时拒绝）；
 * - run-case = 单接口单用例（apiPath + caseId，裁定④），经 CollectionRunner 单接口语义执行
 *   （与桌面端 sendDebug 同源：合成单接口集合走完整 Runner——脚本/断言/变量/按协议 client
 *   分发全部同管线）；
 * - 日志走 stderr（裁定⑤：stdout 是协议通道）；
 * - 安全红线：工具只暴露 --workspace 指定的工作区；apiPath 仅为与既有 CLI 定位同口径的
 *   工作区相对定位符（run-stress/run 的分隔符边界后缀匹配），只与内存树匹配、不落任何
 *   文件系统访问——路径无法逃逸工作区根。
 */

/** createMcpServer 可注入依赖：registry（默认内置全量注册中心）与日志通道（默认 console.error）。 */
export interface McpServerOptions {
  /** 注册执行类工具 run-case（默认 false——只读模式，run-case 不注册）。 */
  allowRun?: boolean;
  /** 插件注册中心（默认 createDefaultRegistry()；测试可注入替身）。 */
  registry?: PluginRegistry;
  /** 人类日志通道（默认 console.error → stderr；stdout 是 MCP 协议通道，裁定⑤）。 */
  log?: (line: string) => void;
}

/** 路径分隔符归一为 "/"（与 main.ts 的定位口径一致，Windows 兼容）。 */
function toSlash(p: string): string {
  return p.split("\\").join("/");
}

/** 工作区内接口定位结果：workspace 一并返回供 run-case 的变量层组装。 */
interface ApiLocation {
  api: ApiDefinition;
  project: Project;
  collection: Collection;
  workspace: Workspace;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * 创建 MCP 服务器（未连接传输——连接归宿主：main.ts mcp 命令接 StdioServerTransport，
 * 测试接 InMemoryTransport 对测，裁定②）。
 */
export function createMcpServer(root: string, options: McpServerOptions = {}): McpServer {
  const registry = options.registry ?? createDefaultRegistry();
  const log = options.log ?? ((line: string) => { console.error(line); });
  const allowRun = options.allowRun === true;
  const storage = registry.getStorage();
  if (!storage) throw new Error("未注册存储适配器");
  log(`[apicc mcp] 工作区: ${root}${allowRun ? "（run-case 已启用）" : "（只读模式）"}`);

  /**
   * 工作区加载 + 全树定位接口（含 folders 内接口）。匹配口径与 run-stress/run-stress-worker
   * 共享的 resolveStressTarget 同款：全等或分隔符边界后缀（避免 "ok" 误命中 "xok"），首个命中即止。
   * apiPath 只与内存树内构造的相对目录比较，绝不 join 出新的文件系统路径（安全红线）。
   */
  const locateApi = async (apiPath: string): Promise<ApiLocation | undefined> => {
    const { workspace } = await storage.load(root);
    const target = toSlash(apiPath);
    for (const g of workspace.groups) {
      for (const p of g.projects) {
        for (const c of p.collections) {
          const cDir = join(root, "groups", g.name, "projects", p.name, "collections", c.name);
          const candidates = [
            ...c.apis.map((a) => ({ api: a, dir: join(cDir, "apis", a.name) })),
            ...c.folders.flatMap((f) => f.apis.map((a) => ({ api: a, dir: join(cDir, "folders", f.name, "apis", a.name) }))),
          ];
          for (const cand of candidates) {
            const normalized = toSlash(cand.dir);
            if (normalized === target || normalized.endsWith(`/${target}`)) {
              return { api: cand.api, project: p, collection: c, workspace };
            }
          }
        }
      }
    }
    return undefined;
  };

  const API_PATH_DESC = "接口目录（工作区相对路径，由 list-apis 返回的 apiPath 给出）";

  const server = new McpServer({ name: "apicc", version });

  server.registerTool(
    "list-apis",
    {
      title: "列出工作区接口",
      description: "列出工作区内全部接口的摘要（id/name/protocol/url/apiPath）。apiPath 可用于 get-api-design 与 run-case 定位接口。",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { workspace } = await storage.load(root);
      const rows: Array<{ id: string; name: string; protocol: string; url: string; apiPath: string }> = [];
      for (const g of workspace.groups) {
        for (const p of g.projects) {
          for (const c of p.collections) {
            const cDir = join("groups", g.name, "projects", p.name, "collections", c.name);
            for (const a of c.apis) rows.push(summarize(a, join(cDir, "apis", a.name)));
            for (const f of c.folders) {
              for (const a of f.apis) rows.push(summarize(a, join(cDir, "folders", f.name, "apis", a.name)));
            }
          }
        }
      }
      return textResult(JSON.stringify(rows, null, 2));
    },
  );

  server.registerTool(
    "get-api-design",
    {
      title: "读取接口详细设计",
      description: "读取接口的详细设计（renderDesignMarkdown 渲染的 Markdown：定义/请求体/设计正文/测试用例表）。",
      inputSchema: { apiPath: z.string().min(1).describe(API_PATH_DESC) },
      annotations: { readOnlyHint: true },
    },
    async ({ apiPath }) => {
      const loc = await locateApi(apiPath);
      if (!loc) return errorResult(`未找到接口: ${apiPath}`);
      return textResult(renderDesignMarkdown(loc.api));
    },
  );

  // 裁定⑥：--allow-run 关闭时 run-case 完全不注册（tools/list 不可见），而非注册后调用时拒绝。
  if (allowRun) {
    server.registerTool(
      "run-case",
      {
        title: "执行单个接口用例",
        description: "执行单个接口的单个用例并返回 CaseOutcome 摘要（passed/assertions/error）。执行类工具，仅在服务器以 --allow-run 启动时可用。",
        inputSchema: {
          apiPath: z.string().min(1).describe(API_PATH_DESC),
          caseId: z.string().min(1).describe("用例 ID（见 get-api-design 产出的用例表）"),
        },
      },
      async ({ apiPath, caseId }) => {
        const loc = await locateApi(apiPath);
        if (!loc) return errorResult(`未找到接口: ${apiPath}`);
        const tc = loc.api.cases.find((c) => c.id === caseId);
        if (!tc) return errorResult(`用例不存在: ${caseId}`);
        // run-case 未选环境（裁定④参数面仅 apiPath+caseId）→ env 链为空，非 base scope 用例
        // 会被 Runner 过滤成空跑；显式报错不让其静默假成功（与 sendDebug 的 scope 防护同口径）。
        if (tc.scope !== "base") {
          return errorResult(`用例「${tc.name}」的 scope（${tc.scope}）不适用于 run-case（未选环境，仅 base 适用）`);
        }
        // 单接口单用例合成集合（sendDebug 同款形状）：完整复用 CollectionRunner 语义——
        // 前置/后置脚本、断言、变量解析、认证与按协议 client 分发（registry.getProtocol）同管线。
        const collection: Collection = {
          id: loc.collection.id, name: loc.collection.name,
          variables: loc.collection.variables, scripts: loc.collection.scripts,
          folders: [], apis: [{ ...loc.api, cases: [tc] }],
        };
        // 无 runsDir：零落盘（工作区只读红线）；每次调用独立 bus，无跨调用状态。
        const runner = new CollectionRunner({
          registry, bus: createEventBus(),
          timeouts: { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 },
          failFast: true,
        });
        const result = await runner.run(collection, undefined, loc.project, loc.workspace, {});
        const outcome = result.cases[0];
        if (!outcome) return errorResult(`用例「${tc.name}」未能产生执行结果`);
        return textResult(JSON.stringify(outcome, null, 2));
      },
    );
  }

  return server;
}

/** list-apis 行摘要：protocol 缺省 http（schema 默认值，M5 兼容口径）。 */
function summarize(a: ApiDefinition, relDir: string): { id: string; name: string; protocol: string; url: string; apiPath: string } {
  return {
    id: a.id,
    name: a.name,
    protocol: a.protocol ?? "http",
    url: a.url,
    apiPath: relDir.split("\\").join("/"),
  };
}
