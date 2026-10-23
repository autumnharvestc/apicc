import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validatePluginManifest, type PluginManifestV1 } from "@apicc/plugin-sdk";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const NAME_PREFIX = "apicc-plugin-";

export interface CreatePluginResult {
  dir: string;
  files: string[];
  warnings: string[];
}

/** Generate a local V1 author package; validate inputs before creating its directory. */
export function generatePluginPackage(name: string, targetDir: string): CreatePluginResult {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`插件名不合法: ${name}（须匹配 ${NAME_PATTERN}，如 apicc-plugin-demo）`);
  }
  const dir = join(targetDir, name);
  if (existsSync(dir)) throw new Error(`目标目录已存在: ${dir}`);
  const id = `local.${name.toLowerCase()}`;
  // One metadata object supplies the static admission manifest and the ESM definition.
  const manifest: PluginManifestV1 = {
    manifestVersion: 1, id, name, version: "0.1.0", apiVersion: 1,
    engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./dist/index.js",
    capabilities: ["assert", "reporter"],
    contributions: [
      { kind: "assert", id: `${id}/assert.has-field` },
      { kind: "reporter", id: `${id}/reporter.text` },
    ],
  };
  const checked = validatePluginManifest(manifest);
  if (!checked.ok) throw new Error(`插件名不能形成合法 V1 命名空间: ${name}（${checked.problems.map(p => p.reason).join("；")}）`);
  const warnings = name.startsWith(NAME_PREFIX) ? [] : [`插件名建议以 ${NAME_PREFIX} 为前缀（命名约定，非强制）`];
  const files: Array<[string, string]> = [
    ["package.json", renderPackageJson(name)],
    ["apicc-plugin.json", `${JSON.stringify(manifest, null, 2)}\n`],
    [join("src", "index.ts"), renderIndexTs(manifest)],
    [join("test", "contract.test.ts"), renderContractTest(name)],
    ["tsconfig.json", renderTsconfig()],
    ["README.md", renderReadme(name, id)],
  ];
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of files) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { dir, files: files.map(([rel]) => rel), warnings };
}

function renderPackageJson(name: string): string {
  return `${JSON.stringify({
    name, version: "0.1.0", description: "apicc SDK V1 断言与文本报告器示例", type: "module",
    keywords: ["apicc-plugin"], license: "MIT", main: "./dist/index.js", types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./apicc-plugin.json": "./apicc-plugin.json" },
    files: ["dist", "apicc-plugin.json"],
    scripts: { build: "tsc -p tsconfig.json", test: "vitest run" },
    peerDependencies: { "@apicc/plugin-sdk": "^0.1.0" },
    devDependencies: { "@apicc/plugin-sdk": "^0.1.0", "@types/node": "^26.4.0", typescript: "^5.9.2", vitest: "^4.1.11" },
    engines: { node: ">=22.19.0" },
  }, null, 2)}\n`;
}

function renderIndexTs(manifest: PluginManifestV1): string {
  return `import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { definePlugin, type AssertContributionV1, type PluginManifestV1, type ReporterContributionV1 } from "@apicc/plugin-sdk";

// Keep this metadata equal to apicc-plugin.json when changing declarations.
const manifest = ${JSON.stringify(manifest, null, 2)} satisfies PluginManifestV1;

const hasField: AssertContributionV1 = {
  kind: "assert", id: manifest.contributions[0].id,
  descriptor: { targets: ["bodyJson"], expectedFormat: "text", expectedRequired: true },
  evaluate(actual, expected) {
    const pass = actual !== null && typeof actual === "object" && !Array.isArray(actual)
      && expected !== undefined && Object.hasOwn(actual, expected);
    return { pass, message: pass ? "包含字段" : "缺少字段" };
  },
};

const textReporter: ReporterContributionV1 = {
  kind: "reporter", id: manifest.contributions[1].id,
  async render(report, outDir) {
    const file = resolve(outDir, "${manifest.name}-report.txt");
    const counts = (value: typeof report.rows) =>
      \`总计 \${value.total} · 通过 \${value.passed} · 失败 \${value.failed} · 跳过 \${value.skipped}\`;
    const lines = [report.title, \`执行行：\${counts(report.rows)}\`];
    if (report.logical) lines.push(\`逻辑结果：\${counts(report.logical)}\`);
    if (report.requestFacts) lines.push(\`请求事实：开始 \${report.requestFacts.started} · 完成 \${report.requestFacts.completed} · HTTP 交换 \${report.requestFacts.httpExchanges}\`);
    for (const diagnostic of report.diagnostics) lines.push(\`诊断：\${diagnostic}\`);
    const readText = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
    const categories = new Map([["transport", "传输失败"], ["http", "HTTP 失败"], ["script", "脚本失败"],
      ["assertion", "断言失败"], ["extraction", "提取失败"], ["config", "配置失败"], ["aborted", "已中止"]]);
    for (const row of report.cases) {
      if (row.passed !== false) continue;
      lines.push(\`失败用例：\${readText(row.caseName) ?? "名称未提供"}（用例 ID：\${readText(row.caseId) ?? "未提供"}）\`);
      const category = readText(row.failureKind);
      if (category) lines.push(\`  类别：\${categories.get(category) ?? category}\`);
      let hasReason = false;
      const error = readText(row.error);
      if (error) { lines.push(\`  原因：\${error}\`); hasReason = true; }
      for (const assertion of Array.isArray(row.assertions) ? row.assertions : []) {
        if (assertion === null || typeof assertion !== "object" || Array.isArray(assertion) || assertion.pass !== false) continue;
        const message = readText(assertion.message) ?? readText(assertion.error);
        if (message) { lines.push(\`  断言：\${message}\`); hasReason = true; }
        const differencePath = readText(assertion.differencePath);
        if (differencePath) lines.push(\`  差异路径：\${differencePath}\`);
        const schemaPath = readText(assertion.schemaPath);
        if (schemaPath) lines.push(\`  Schema 路径：\${schemaPath}\`);
      }
      if (!hasReason) lines.push("  本次投影未提供详细失败原因。");
    }
    writeFileSync(file, lines.join("\\n") + "\\n", "utf8");
    return file;
  },
};

export const plugin = definePlugin({
  manifest,
  setup(context) {
    context.register(hasField);
    context.register(textReporter);
  },
});
export default plugin;
`;
}

function renderContractTest(name: string): string {
  return `import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPluginContract } from "@apicc/plugin-sdk/testing";
import { plugin } from "../src/index.js";

describe("${name} 契约", () => {
  it("清单一致且断言贡献可执行", () => {
    expect(plugin.manifest).toEqual(JSON.parse(readFileSync(new URL("../apicc-plugin.json", import.meta.url), "utf8")));
    const checked = checkPluginContract(plugin, { config: {} });
    expect(checked.problems).toEqual([]);
    const assertion = checked.contributions.find(item => item.kind === "assert");
    if (assertion?.kind !== "assert") throw new Error("示例断言未注册");
    expect(assertion.evaluate({ id: 1 }, "id", { found: true, getModel: () => undefined }).pass).toBe(true);
    expect(assertion.evaluate({}, "id", { found: true, getModel: () => undefined }).pass).toBe(false);
  });
});
`;
}

function renderTsconfig(): string {
  return `${JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    esModuleInterop: true, skipLibCheck: true, declaration: true, outDir: "dist", rootDir: "src", types: ["node"],
  }, include: ["src"] }, null, 2)}\n`;
}

function renderReadme(name: string, id: string): string {
  return `# ${name}

SDK V1 本地作者包：断言 \`${id}/assert.has-field\` 与文本报告器 \`${id}/reporter.text\`。
API 主版本为 1；SDK 包为 0.1.0；宿主产品当前为 0.1.0，兼容范围由清单 engines.apicc 声明。

## 构建与测试

先在 apicc 仓库构建 SDK 并本地 pack（不发布）：

\`\`\`powershell
pnpm -C packages/plugin-sdk build
pnpm -C packages/plugin-sdk pack --pack-destination ../../local/f7a-author-sdk-20261023
\`\`\`

在本作者目录安装该实际 tarball 的绝对路径；SDK 尚未发布时不要依赖 npm 下载：

\`\`\`powershell
pnpm add -D "C:/path/to/apicc/local/f7a-author-sdk-20261023/apicc-plugin-sdk-0.1.0.tgz"
pnpm install
pnpm build
pnpm test
\`\`\`

源码只导入公开 SDK，无需 Core。build 保持入口 dist/index.js；静态清单与源码 manifest 必须一致，作者测试会比较二者并实际调用断言。

## 本地登记与执行

由用户主动在用户级 \`~/.apicc/plugins.json\` 登记包根目录（包含 apicc-plugin.json）：

\`\`\`json
{ "plugins": [{ "source": "C:/path/to/${name}", "config": {} }] }
\`\`\`

source 也可为已安装包名或 apicc-plugin.json 文件；相对路径以用户清单所在目录为基准。
本例未声明 configSchema，只接受空 config；自定义配置仅用于已声明的非敏感参数，凭据沿宿主的既有凭据入口。
修改清单/配置/构建产物后重启 CLI 或桌面生效。不会自动安装或从工作区加载插件。

\`\`\`bash
apicc plugins list
apicc run groups/<groupId>/projects/<projectId>/collections/<collectionId> --env dev --reporters ${id}/reporter.text
\`\`\`

reporter 的自由格式 ID 目前仅支持 CLI collection/workflow（run/run-workflow）；suite 与桌面选择器仍固定 html/json/junit，F6 压测报告链不扩展。
文本分别展示执行行、可选逻辑结果及请求事实；逻辑恢复通过不会抹掉执行行失败。输入是宿主按本次运行策略投影的 ReportView，不是私密凭据访问入口。
协议/认证贡献仅在用户 bindings.protocols / bindings.auths 显式绑定现有 kind 后启用，默认保持内置。

登记表示信任插件以本机用户权限执行；它不是沙箱。SDK V1 只开放 protocol/auth/assert/importer/reporter，不包含既有 scriptEngine/storage 试验入口。
加载器在执行前检查静态清单、API/宿主范围和冲突；不兼容或缺清单会在 plugins list 给出诊断。setup 必须同步，失败会撤销本次贡献，避免半注册；无法回滚插件任意外部副作用。
旧无清单试验插件须迁移到 V1 静态清单、definePlugin 和 context.register；不再直接注册 Core registry。可用 --no-plugins 关闭本机插件。
本流程只本地构建、pack 和主动登记，不执行 npm 发布或自动安装。更多见 apicc 仓库 docs/plugins.md。
`;
}
