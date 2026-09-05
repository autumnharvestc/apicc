import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 插件包名约定（D6/D7）：`apicc-plugin-` 前缀；名字本身须是合法 npm 名形态（防路径逃逸与模板注入）。 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const NAME_PREFIX = "apicc-plugin-";

export interface CreatePluginResult {
  /** 生成的插件包目录（绝对路径）。 */
  dir: string;
  /** 写入的文件（相对包目录）。 */
  files: string[];
  /** 非阻断警告（如名称无约定前缀）。 */
  warnings: string[];
}

/**
 * create-plugin 脚手架（规格 D6）。模板为内联字符串（裁定①）：生成物零运行时依赖、自包含可开发
 * ——package.json / src/index.ts（示例断言操作符 + 报告器 + setup）/ vitest 契约测试 / tsconfig /
 * README，开箱即可 `pnpm install → pnpm build → pnpm test`。取舍：模板升级随 apicc 版本走
 * （已生成项目不受影响），代价是模板改动需同步回归本命令测试。
 */
export function generatePluginPackage(name: string, targetDir: string): CreatePluginResult {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`插件名不合法: ${name}（须匹配 ${NAME_PATTERN}，如 apicc-plugin-demo）`);
  }
  const warnings: string[] = [];
  if (!name.startsWith(NAME_PREFIX)) {
    warnings.push(`插件名建议以 ${NAME_PREFIX} 为前缀（市场索引约定，非强制）`);
  }
  const dir = join(targetDir, name);
  if (existsSync(dir)) throw new Error(`目标目录已存在: ${dir}`);

  const files: Array<[string, string]> = [
    ["package.json", renderPackageJson(name)],
    [join("src", "index.ts"), renderIndexTs(name)],
    [join("test", "contract.test.ts"), renderContractTest(name)],
    ["tsconfig.json", renderTsconfig()],
    ["README.md", renderReadme(name)],
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
  return `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      description: "apicc 插件：自定义断言操作符与报告器",
      type: "module",
      keywords: ["apicc-plugin"],
      license: "MIT",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      files: ["dist"],
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run",
      },
      peerDependencies: {
        "@apicc/core": "*",
      },
      devDependencies: {
        "@types/node": "^26.4.0",
        typescript: "^5.9.2",
        vitest: "^4.1.11",
      },
      engines: { node: ">=22.19.0" },
    },
    null,
    2,
  )}\n`;
}

function renderIndexTs(name: string): string {
  // 名称已过 NAME_PATTERN 白名单，插值安全；报告格式派生自包名（apicc-plugin-demo-txt）。
  return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssertOperator, PluginDefinition, Reporter, RunResult } from "@apicc/core";

// 示例 1：自定义断言操作符——判断对象包含指定字段（可按需改造或增删注册项）。
const hasField: AssertOperator = {
  op: "hasField",
  evaluate: (actual, expected) => {
    const field = expected ?? "";
    const pass = typeof actual === "object" && actual !== null && field in (actual as Record<string, unknown>);
    return { pass, message: pass ? \`包含字段 \${field}\` : \`缺少字段 \${field}\` };
  },
};

// 示例 2：自定义报告器——输出纯文本摘要（render 须写文件并返回绝对路径）。
const textReporter: Reporter = {
  format: "${name}-txt",
  render: async (result: RunResult, outDir: string) => {
    const file = join(outDir, "${name}-report.txt");
    const lines = [
      "${name} 报告",
      \`总计 \${result.total} · 通过 \${result.passed} · 失败 \${result.failed}\`,
    ];
    writeFileSync(file, lines.join("\\n"), "utf8");
    return file;
  },
};

export const plugin: PluginDefinition = {
  name: "${name}",
  version: "0.1.0",
  setup(ctx) {
    ctx.registry.registerAssert(hasField);
    ctx.registry.registerReporter(textReporter);
  },
};

export default plugin;
`;
}

function renderContractTest(name: string): string {
  return `import { describe, expect, it } from "vitest";
import { plugin } from "../src/index.js";

// 最小契约自检（M1 规格 §5.3 口径）：发布前必须通过，保证加载器形状校验（name/version/setup）必绿。
describe("${name} 契约", () => {
  it("满足 PluginDefinition 形状", () => {
    expect(typeof plugin.name).toBe("string");
    expect(plugin.name.length).toBeGreaterThan(0);
    expect(typeof plugin.version).toBe("string");
    expect(typeof plugin.setup).toBe("function");
  });
});
`;
}

function renderTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: true,
        outDir: "dist",
        rootDir: "src",
        types: ["node"],
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`;
}

function renderReadme(name: string): string {
  return `# ${name}

apicc 插件包：内置一个自定义断言操作符（\`hasField\`）与一个纯文本报告器（\`${name}-txt\`）示例，可直接改造。

## 快速开始

\`\`\`bash
pnpm install     # 拉取 @apicc/core（peer）与构建/测试工具
pnpm build       # tsc 编译 src → dist
pnpm test        # vitest 契约自检（发布前必须通过）
\`\`\`

## 本地试用（无需发布）

在**用户级**清单（\`~/.apicc/plugins.json\`）登记本包构建产物，然后启动 apicc 即自动加载：

\`\`\`json
{ "plugins": ["<本目录绝对路径>/dist"] }
\`\`\`

\`\`\`bash
apicc plugins list        # 应显示本插件已加载与贡献计数
apicc run ... --reporters ${name}-txt
\`\`\`

> 注意：插件清单仅支持用户级（\`~/.apicc/plugins.json\`），不支持工作区级——信任模型见 apicc 仓库 \`docs/plugins.md\`。

## 发布到 npm

1. \`pnpm test\` 契约自检通过；
2. \`pnpm build\` 确认 \`dist\` 产物最新；
3. \`npm publish\`（包名遵循 \`apicc-plugin-\` 前缀约定，package.json keywords 含 \`apicc-plugin\`）；
4. 使用方在用户级清单登记包名即可。

更多见 apicc 仓库 \`docs/plugins.md\`（市场索引与发布指南）。
`;
}
