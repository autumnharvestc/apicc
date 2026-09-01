# apicc M1 计划 1：@apicc/core 与 CLI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现平台无关的 TypeScript 核心包 `@apicc/core`（域模型、文件存储、变量、事件总线、插件底座、执行引擎、报告、导入、设计导出）与 `@apicc/cli`（validate / run / import / export-design 四命令），全部 headless 可测。

**架构：** 依据规格 `docs/superpowers/specs/2026-09-01-apicc-m1-local-core-design.md`。pnpm monorepo；core 不依赖宿主；一切功能以插件形态挂在 7 个扩展点上；工作区 = Git 友好的 YAML/JSON 文本目录，SQLite 仅作可重建索引。

**技术栈：** TypeScript 5（ESM）、Node ≥ 22（LTS）、pnpm ≥ 9、vitest 2、zod 3、yaml 2、ulid、undici 6、better-sqlite3 13、jsonpath-plus、csv-parse、commander 12。

**计划范围说明：** 本计划交付 core + CLI；Electron/Vue 桌面宿主、调试 UI、i18n 属于后续「计划 2」。品牌名不得出现在任何入库文件（见规格 §1 差异化约束与项目记忆）。

---

## 文件结构

```
packages/core/
  package.json               @apicc/core；ESM；导出公共 API
  vitest.config.ts           测试配置 + 覆盖率门槛（lines 85%）
  src/
    index.ts                 公共出口：类型、createDefaultRegistry、内置插件注册
    domain/model.ts          zod schema + 推导类型（全部域对象）
    domain/envChain.ts       环境继承链（extends 展开为名称数组）
    variables/resolver.ts    变量解析器：层级优先级、动态变量、循环检测
    events/bus.ts            类型化事件总线（6 个执行生命周期事件）
    plugin/types.ts          7 个扩展点接口 + PluginDefinition
    plugin/registry.ts       插件注册中心
    storage/fileStorage.ts   StorageAdapter 文件实现：§6 目录布局读写 + 坏文件隔离
    storage/sqliteIndex.ts   SQLite 索引：rebuild / byId / byType
    sandbox/jsEngine.ts      ScriptEngine 插件：node:vm 沙箱 + pm.* 上下文
    assert/operators.ts      AssertOperator 插件：eq/neq/contains/lt/gt/lte/gte
    http/client.ts           ProtocolClient 插件：undici + 超时 + 错误分类
    http/auth.ts             AuthProvider 插件：bearer / basic / apikey
    runner/runner.ts         集合运行器：顺序、数据驱动、脚本钩子、fail-fast、runs 落盘
    report/html.ts           Reporter 插件：HTML 报告
    report/junit.ts          Reporter 插件：JUnit XML
    import/collection21.ts   Importer 插件：Collection v2.1 JSON
    import/openapi.ts        Importer 插件：OpenAPI 2.0 与 3.0
    design/export.ts         接口详细设计 → agent 友好 Markdown
  tests/                     与 src 一一对应 + contracts/ 契约测试 + e2e/
packages/cli/
  package.json               @apicc/cli；bin: apicc
  src/main.ts                commander 定义 + run(argv) 可编程入口
  src/bin.ts                 shebang 薄壳
  tests/e2e.test.ts          临时工作区 + 本地 HTTP 服务端到端
pnpm-workspace.yaml
```

域对象关系：`Workspace → Group[] → Project[] → { Environment[], Collection[] }`；`Collection → Folder[] / ApiDefinition[]`；`ApiDefinition → TestCase[]`。所有对象 `id` 为 ULID；对象间引用用 id；文件路径仅负责人工可读（规格 §6）。

---

### 任务 1：Monorepo 脚手架与冒烟测试

**文件：**
- 创建：`pnpm-workspace.yaml`
- 创建：`packages/core/package.json`、`packages/core/tsconfig.json`、`packages/core/vitest.config.ts`
- 创建：`packages/core/src/index.ts`
- 测试：`packages/core/tests/smoke.test.ts`
- 修改：`.gitignore`

- [ ] **步骤 1：创建工作区与包配置**

`pnpm-workspace.yaml`：

```yaml
packages:
  - "packages/*"
```

`packages/core/package.json`：

```json
{
  "name": "@apicc/core",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "engines": { "node": ">=20" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

`packages/core/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`packages/core/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 85, functions: 80 },
    },
  },
});
```

`packages/core/src/index.ts`：

```ts
export const version = "0.1.0";
```

`.gitignore` 追加：

```
node_modules/
dist/
.apicc/
coverage/
```

- [ ] **步骤 2：编写失败的冒烟测试**

`packages/core/tests/smoke.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

describe("smoke", () => {
  it("exports version", () => {
    expect(version).toBe("0.1.0");
  });
});
```

- [ ] **步骤 3：安装依赖并验证测试失败（入口缺依赖时先装测试工具）**

运行：`pnpm install && pnpm -C packages/core add -D vitest typescript @types/node && pnpm -C packages/core vitest run tests/smoke.test.ts`
预期：PASS（本任务为脚手架，冒烟测试直接通过即为验证）

- [ ] **步骤 4：Commit**

```bash
git add pnpm-workspace.yaml packages/core .gitignore pnpm-lock.yaml
git commit -m "chore: pnpm monorepo 脚手架与 @apicc/core 冒烟测试"
```

---

### 任务 2：域模型（zod schema + 类型 + 环境继承链）

**文件：**
- 创建：`packages/core/src/domain/model.ts`
- 创建：`packages/core/src/domain/envChain.ts`
- 测试：`packages/core/tests/domain/model.test.ts`、`packages/core/tests/domain/envChain.test.ts`

- [ ] **步骤 1：编写失败的 schema 测试**

`packages/core/tests/domain/model.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { ApiDefinitionSchema, TestCaseSchema } from "../../src/domain/model.js";

describe("域 schema", () => {
  it("接受合法接口定义", () => {
    const api = {
      id: "01J5M8Z9Q2V3K4M5N6P7Q8R9S0",
      name: "create-order",
      version: "1.0.0",
      method: "POST",
      url: "{{baseUrl}}/orders",
      headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
      query: [],
      body: { kind: "json", content: '{"sku":"A1"}' },
      cases: [],
    };
    expect(ApiDefinitionSchema.parse(api).method).toBe("POST");
  });

  it("拒绝未知字段与非法 method", () => {
    expect(() =>
      TestCaseSchema.parse({ id: "x", name: "c", scope: "base", nonsense: 1 }),
    ).toThrow();
    expect(() =>
      ApiDefinitionSchema.parse({ id: "x", name: "a", version: "1", method: "TELEPORT", url: "/", headers: [], query: [], cases: [] }),
    ).toThrow();
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/domain/model.test.ts`
预期：FAIL，`Cannot find module .../domain/model.js`

- [ ] **步骤 3：实现域模型**

`packages/core/src/domain/model.ts`：

```ts
import { z } from "zod";

export type ID = string;

export const KeyValuePairSchema = z.object({
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
});
export type KeyValuePair = z.infer<typeof KeyValuePairSchema>;

export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const BodySchema = z.object({
  kind: z.enum(["json", "xml", "raw", "graphql", "form"]),
  content: z.string().default(""),
  form: z.array(KeyValuePairSchema).optional(),
});
export type BodyContent = z.infer<typeof BodySchema>;

export const AuthSpecSchema = z.object({
  type: z.enum(["bearer", "basic", "apikey"]),
  token: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  placement: z.enum(["header", "query"]).default("header"),
});
export type AuthSpec = z.infer<typeof AuthSpecSchema>;

export const AssertionSchema = z.object({
  id: z.string(),
  target: z.enum(["status", "header", "bodyJson", "responseTime"]),
  op: z.enum(["eq", "neq", "contains", "lt", "gt", "lte", "gte"]),
  expected: z.string().optional(),
  headerName: z.string().optional(),
  path: z.string().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const DataDriverSchema = z.object({
  sourcePath: z.string(),
  format: z.enum(["csv", "json"]),
});
export type DataDriver = z.infer<typeof DataDriverSchema>;

export const TestCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string().default("base"),
  parameters: z.record(z.string()).default({}),
  dataDriver: DataDriverSchema.optional(),
  preScript: z.string().optional(),
  postScript: z.string().optional(),
  assertions: z.array(AssertionSchema).default([]),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const ApiDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().default("1.0.0"),
  deprecated: z.boolean().default(false),
  method: HttpMethodSchema,
  url: z.string(),
  headers: z.array(KeyValuePairSchema).default([]),
  query: z.array(KeyValuePairSchema).default([]),
  body: BodySchema.optional(),
  auth: AuthSpecSchema.optional(),
  design: z.string().optional(),
  cases: z.array(TestCaseSchema).default([]),
});
export type ApiDefinition = z.infer<typeof ApiDefinitionSchema>;

export const FolderSchema = z.object({ id: z.string(), name: z.string(), apis: z.array(ApiDefinitionSchema).default([]) });
export type Folder = z.infer<typeof FolderSchema>;

export const CollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string()).default({}),
  scripts: z.object({ pre: z.string().optional(), post: z.string().optional() }).optional(),
  folders: z.array(FolderSchema).default([]),
  apis: z.array(ApiDefinitionSchema).default([]),
});
export type Collection = z.infer<typeof CollectionSchema>;

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  extends: z.string().optional(),
  variables: z.record(z.string()).default({}),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string()).default({}),
  environments: z.array(EnvironmentSchema).default([]),
  collections: z.array(CollectionSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export const GroupSchema = z.object({ id: z.string(), name: z.string(), projects: z.array(ProjectSchema).default([]) });
export type Group = z.infer<typeof GroupSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.record(z.string()).default({}),
  groups: z.array(GroupSchema).default([]),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
```

`packages/core/src/domain/envChain.ts`：

```ts
import type { Environment, Project } from "./model.js";

/** 返回环境名称及其全部祖先名称（extends 按环境名引用）。无环保障由调用方 schema 外校验。 */
export function envChain(env: Environment, project: Project): string[] {
  const byName = new Map(project.environments.map((e) => [e.name, e]));
  const chain: string[] = [];
  const seen = new Set<string>([env.name]);
  let cur: Environment | undefined = env;
  while (cur) {
    chain.push(cur.name);
    const parentName = cur.extends;
    if (!parentName || seen.has(parentName)) break;
    seen.add(parentName);
    cur = byName.get(parentName);
  }
  return chain;
}
```

安装依赖：`pnpm -C packages/core add zod ulid`。

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/domain/model.test.ts`
预期：PASS（2 个用例）

- [ ] **步骤 5：编写失败的 envChain 测试**

`packages/core/tests/domain/envChain.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { envChain } from "../../src/domain/envChain.js";
import type { Environment, Project } from "../../src/domain/model.js";

const project: Project = {
  id: "p1", name: "proj", variables: {},
  environments: [
    { id: "e1", name: "dev", variables: {} },
    { id: "e2", name: "sit", extends: "dev", variables: {} },
    { id: "e3", name: "press", extends: "sit", variables: {} },
  ],
  collections: [],
};

describe("envChain", () => {
  it("press 展开为 press→sit→dev", () => {
    const press = project.environments[2] as Environment;
    expect(envChain(press, project)).toEqual(["press", "sit", "dev"]);
  });
  it("无继承时只含自身", () => {
    expect(envChain(project.environments[0] as Environment, project)).toEqual(["dev"]);
  });
});
```

- [ ] **步骤 6：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/domain/envChain.test.ts`
预期：PASS（2 个用例）

- [ ] **步骤 7：Commit**

```bash
git add packages/core/src packages/core/tests packages/core/package.json
git commit -m "feat(core): 域模型 zod schema、类型与环境继承链"
```

---

### 任务 3：事件总线

**文件：**
- 创建：`packages/core/src/events/bus.ts`
- 测试：`packages/core/tests/events/bus.test.ts`

- [ ] **步骤 1：编写失败的测试**

`packages/core/tests/events/bus.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createEventBus } from "../../src/events/bus.js";

describe("EventBus", () => {
  it("按注册顺序串行触发同类型处理器", async () => {
    const bus = createEventBus();
    const calls: string[] = [];
    bus.on("beforeCase", async () => { calls.push("a"); });
    bus.on("beforeCase", async () => { calls.push("b"); });
    await bus.emit("beforeCase", { apiName: "x", caseName: "y", row: undefined });
    expect(calls).toEqual(["a", "b"]);
  });

  it("off 后不再触发，且不同事件互不影响", async () => {
    const bus = createEventBus();
    let n = 0;
    const off = bus.on("afterRun", () => { n += 1; });
    bus.on("beforeRun", () => { n += 100; });
    off();
    await bus.emit("afterRun", { total: 0, passed: 0, failed: 0 });
    await bus.emit("beforeRun", { collectionName: "c" });
    expect(n).toBe(100);
  });

  it("处理器抛错时 emit 拒绝并带事件名", async () => {
    const bus = createEventBus();
    bus.on("afterResponse", () => { throw new Error("boom"); });
    await expect(bus.emit("afterResponse", { status: 200 })).rejects.toThrow(/afterResponse.*boom/);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/events/bus.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现事件总线**

`packages/core/src/events/bus.ts`：

```ts
/** 执行生命周期事件载荷。request 为可变引用，钩子直接修改即生效（规格 §5.2）。 */
export interface RunEventMap {
  beforeRun: { collectionName: string; envName?: string };
  beforeCase: { apiName: string; caseName: string; row?: number };
  beforeRequest: { request: unknown };
  afterResponse: { status: number; timeMs: number };
  afterCase: { apiName: string; caseName: string; passed: boolean };
  afterRun: { total: number; passed: number; failed: number };
}

export type EventName = keyof RunEventMap;
type Handler<K extends EventName> = (payload: RunEventMap[K]) => void | Promise<void>;

export interface EventBus {
  on<K extends EventName>(type: K, handler: Handler<K>): () => void;
  emit<K extends EventName>(type: K, payload: RunEventMap[K]): Promise<void>;
}

export function createEventBus(): EventBus {
  const handlers = new Map<EventName, Set<Handler<EventName>>>();
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler as Handler<EventName>);
      handlers.set(type, set);
      return () => set.delete(handler as Handler<EventName>);
    },
    async emit(type, payload) {
      for (const h of handlers.get(type) ?? []) {
        try {
          await h(payload);
        } catch (e) {
          throw new Error(`事件 ${type} 处理器失败: ${(e as Error).message}`);
        }
      }
    },
  };
}
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/events/bus.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/events packages/core/tests/events
git commit -m "feat(core): 类型化执行生命周期事件总线"
```

---

### 任务 4：插件注册中心与契约测试基座

**文件：**
- 创建：`packages/core/src/plugin/types.ts`
- 创建：`packages/core/src/plugin/registry.ts`
- 测试：`packages/core/tests/plugin/registry.test.ts`
- 测试：`packages/core/tests/contracts/assertOperator.contract.ts`、`packages/core/tests/contracts/reporter.contract.ts`

- [ ] **步骤 1：编写失败的注册中心测试**

`packages/core/tests/plugin/registry.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../src/plugin/registry.js";

const fakeAssert = {
  op: "eq",
  evaluate: (actual: unknown, expected?: string) => ({
    pass: String(actual) === expected,
    message: "eq",
  }),
};

describe("PluginRegistry", () => {
  it("注册、获取、注销断言操作符", () => {
    const reg = createPluginRegistry();
    reg.registerAssert(fakeAssert);
    expect(reg.getAssert("eq")).toBe(fakeAssert);
    reg.registerAssert({ ...fakeAssert, op: "neq" });
    expect(reg.listAsserts()).toHaveLength(2);
  });

  it("同名覆盖时保留最后注册者", () => {
    const reg = createPluginRegistry();
    reg.registerScriptEngine({ language: "javascript", run: () => {} });
    const second = { language: "javascript", run: () => { /* v2 */ } };
    reg.registerScriptEngine(second);
    expect(reg.getScriptEngine("javascript")).toBe(second);
  });

  it("plugin(def) 执行 setup 完成自注册", () => {
    const reg = createPluginRegistry();
    reg.plugin({
      name: "my-assert", version: "1.0.0",
      setup(ctx) { ctx.registry.registerAssert(fakeAssert); },
    });
    expect(reg.getAssert("eq")).toBeDefined();
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/plugin/registry.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现扩展点接口与注册中心**

`packages/core/src/plugin/types.ts`：

```ts
import type { AuthSpec, BodyContent, KeyValuePair, HttpMethod } from "../domain/model.js";
import type { Workspace } from "../domain/model.js";
import type { RunResult } from "../report/types.js";

export interface ExecutableRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  query: KeyValuePair[];
  body?: BodyContent;
  auth?: AuthSpec;
}

export interface ExecutionResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  timeMs: number;
}

export interface HttpExecuteOptions {
  connectTimeoutMs: number; // 默认 10000
  totalTimeoutMs: number;   // 默认 30000
}

export interface ProtocolClient {
  canHandle(request: ExecutableRequest): boolean;
  execute(request: ExecutableRequest, opts: HttpExecuteOptions): Promise<ExecutionResponse>;
}

export interface AuthProvider {
  type: AuthSpec["type"];
  apply(request: ExecutableRequest, auth: AuthSpec, getVar: (name: string) => string | undefined): void;
}

export interface AssertResult { pass: boolean; message: string }

export interface AssertOperator {
  op: string;
  evaluate(actual: unknown, expected: string | undefined): AssertResult;
}

export interface PmVariables { get(name: string): string | undefined; set(name: string, value: string): void }

export interface PmApi {
  variables: PmVariables;
  environment: { get(name: string): string | undefined };
  request: ExecutableRequest;
  response?: {
    status: number;
    headers: Record<string, string>;
    time: number;
    text(): string;
    json(): unknown;
  };
  assert(condition: boolean, message: string): void;
}

export interface ScriptContext { pm: PmApi }

export interface ScriptEngine {
  language: string;
  /** 同步执行；超时或异常抛错（含 ScriptTimeoutError）。 */
  run(code: string, ctx: ScriptContext): void;
}

export interface Reporter {
  format: string;
  /** 写出报告文件并返回绝对路径。 */
  render(result: RunResult, outDir: string): Promise<string>;
}

export interface ImportedProject {
  project: import("../domain/model.js").Project;
  warnings: string[];
}

export interface Importer {
  name: string;
  detect(fileName: string, content: string): boolean;
  parse(content: string): ImportedProject;
}

export interface LoadProblem { file: string; message: string }

export interface StorageAdapter {
  load(root: string): Promise<{ workspace: Workspace; problems: LoadProblem[] }>;
  save(root: string, workspace: Workspace): Promise<void>;
}

export interface PluginContext { registry: PluginRegistryApi }

export interface PluginRegistryApi {
  registerProtocol(client: ProtocolClient): void;
  registerAuth(provider: AuthProvider): void;
  registerAssert(operator: AssertOperator): void;
  registerScriptEngine(engine: ScriptEngine): void;
  registerReporter(reporter: Reporter): void;
  registerImporter(importer: Importer): void;
  registerStorage(adapter: StorageAdapter): void;
}

export interface PluginDefinition {
  name: string;
  version: string;
  setup(ctx: PluginContext): void;
}
```

`packages/core/src/plugin/registry.ts`：

```ts
import type {
  AssertOperator, AuthProvider, Importer, PluginContext, PluginDefinition,
  PluginRegistryApi, ProtocolClient, Reporter, ScriptEngine, StorageAdapter,
} from "./types.js";

export interface PluginRegistry extends PluginRegistryApi {
  getAssert(op: string): AssertOperator | undefined;
  listAsserts(): AssertOperator[];
  getScriptEngine(language: string): ScriptEngine | undefined;
  getReporter(format: string): Reporter | undefined;
  listImporters(): Importer[];
  getAuth(type: string): AuthProvider | undefined;
  getStorage(): StorageAdapter | undefined;
  getProtocol(request: { url: string }): ProtocolClient | undefined;
  plugin(def: PluginDefinition): void;
}

export function createPluginRegistry(): PluginRegistry {
  const protocols = new Map<string, ProtocolClient>();
  const auths = new Map<string, AuthProvider>();
  const asserts = new Map<string, AssertOperator>();
  const engines = new Map<string, ScriptEngine>();
  const reporters = new Map<string, Reporter>();
  const importers = new Map<string, Importer>();
  let storage: StorageAdapter | undefined;

  const api: PluginRegistry = {
    registerProtocol(client) { protocols.set(client.constructor.name, client); },
    registerAuth(p) { auths.set(p.type, p); },
    registerAssert(o) { asserts.set(o.op, o); },
    registerScriptEngine(e) { engines.set(e.language, e); },
    registerReporter(r) { reporters.set(r.format, r); },
    registerImporter(i) { importers.set(i.name, i); },
    registerStorage(s) { storage = s; },
    getAssert: (op) => asserts.get(op),
    listAsserts: () => [...asserts.values()],
    getScriptEngine: (l) => engines.get(l),
    getReporter: (f) => reporters.get(f),
    listImporters: () => [...importers.values()],
    getAuth: (t) => auths.get(t),
    getStorage: () => storage,
    getProtocol(request) {
      for (const client of protocols.values()) if (client.canHandle(request as never)) return client;
      return undefined;
    },
    plugin(def) {
      def.setup({ registry: api });
    },
  };
  return api;
}
```

同时创建执行结果类型 `packages/core/src/report/types.ts`（registry 的 Reporter 依赖它）：

```ts
import type { AssertResult } from "../plugin/types.js";

export interface CaseOutcome {
  apiId: string;
  apiName: string;
  caseId: string;
  caseName: string;
  row?: number;
  passed: boolean;
  durationMs: number;
  assertions: AssertResult[];
  error?: string;
}

export interface RunResult {
  collectionId: string;
  collectionName: string;
  envName?: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  cases: CaseOutcome[];
}
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/plugin/registry.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 5：编写两个契约测试基座（后续插件任务必须调用）**

`packages/core/tests/contracts/assertOperator.contract.ts`：

```ts
import { expect } from "vitest";
import type { AssertOperator } from "../../src/plugin/types.js";

/** 断言操作符契约：任何内置/第三方 AssertOperator 都必须通过。 */
export function itCompliesWithAssertOperatorContract(op: AssertOperator) {
  it(`契约: ${op.op} 对 undefined actual 返回 fail 且不抛错`, () => {
    const r = op.evaluate(undefined, "1");
    expect(r.pass).toBe(false);
    expect(typeof r.message).toBe("string");
  });
  it(`契约: ${op.op} 的 message 非空`, () => {
    expect(op.evaluate("a", "a").message.length).toBeGreaterThan(0);
  });
}
```

`packages/core/tests/contracts/reporter.contract.ts`：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Reporter } from "../../src/plugin/types.js";
import type { RunResult } from "../../src/report/types.js";

export const emptyRun: RunResult = {
  collectionId: "c1", collectionName: "demo",
  startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  total: 0, passed: 0, failed: 0, cases: [],
};

/** 报告渲染器契约：空结果可渲染、产出非空文件、返回存在的路径。 */
export function itCompliesWithReporterContract(reporter: Reporter, sample: RunResult = emptyRun) {
  it(`契约: ${reporter.format} 渲染空结果产出非空文件`, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-report-"));
    const file = await reporter.render(sample, outDir);
    const { readFileSync, statSync } = await import("node:fs");
    expect(statSync(file).size).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
  });
}
```

- [ ] **步骤 6：Commit**

```bash
git add packages/core/src/plugin packages/core/src/report/types.ts packages/core/tests/plugin packages/core/tests/contracts
git commit -m "feat(core): 插件注册中心、7 扩展点接口与契约测试基座"
```

---

### 任务 5：变量解析器

**文件：**
- 创建：`packages/core/src/variables/resolver.ts`
- 测试：`packages/core/tests/variables/resolver.test.ts`

- [ ] **步骤 1：编写失败的测试**

`packages/core/tests/variables/resolver.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { CyclicVariableError, createVariableResolver } from "../../src/variables/resolver.js";

describe("createVariableResolver", () => {
  it("优先级：运行时 > 环境 > 集合 > 项目 > 全局", () => {
    const r = createVariableResolver({
      layers: [
        { host: "env.example" },
        { host: "collection.example" },
        { host: "project.example", onlyProject: "p" },
        { onlyGlobal: "g" },
      ],
    });
    expect(r.get("host")).toBe("env.example");
    r.setRuntime("host", "runtime.example");
    expect(r.get("host")).toBe("runtime.example");
    expect(r.get("onlyProject")).toBe("p");
    expect(r.get("onlyGlobal")).toBe("g");
    expect(r.get("missing")).toBeUndefined();
  });

  it("resolve 替换全部占位符，未知变量保留原文", () => {
    const r = createVariableResolver({ layers: [{ host: "api.example" }] });
    expect(r.resolve("https://{{host}}/x/{{unknownVar}}")).toBe("https://api.example/x/{{unknownVar}}");
  });

  it("嵌套引用递归解析", () => {
    const r = createVariableResolver({ layers: [{ a: "{{b}}/x", b: "root" }] });
    expect(r.resolve("{{a}}")).toBe("root/x");
  });

  it("循环引用抛 CyclicVariableError 并含链路", () => {
    const r = createVariableResolver({ layers: [{ a: "{{b}}", b: "{{a}}" }] });
    expect(() => r.resolve("{{a}}")).toThrow(CyclicVariableError);
    expect(() => r.resolve("{{a}}")).toThrow(/a → b → a/);
  });

  it("内置动态变量可用", () => {
    const r = createVariableResolver({ layers: [] });
    expect(Number(r.get("$timestamp"))).toBeGreaterThan(0);
    expect(r.get("$uuid")).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.get("$isoTimestamp")).toMatch(/^20\d{2}-/);
    const n = Number(r.get("$randomInt"));
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1000);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/variables/resolver.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：安装依赖并实现**

运行：`pnpm -C packages/core add ulid`（若任务 2 未装）

`packages/core/src/variables/resolver.ts`：

```ts
export class CyclicVariableError extends Error {}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

const dynamic: Record<string, () => string> = {
  $timestamp: () => String(Date.now()),
  $isoTimestamp: () => new Date().toISOString(),
  $uuid: () => crypto.randomUUID(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};

export interface VariableResolver {
  /** 按优先级取值；未命中返回 undefined。 */
  get(name: string): string | undefined;
  /** 替换字符串中全部 {{name}}；未知变量保留原文；循环引用抛 CyclicVariableError。 */
  resolve(input: string): string;
  setRuntime(name: string, value: string): void;
  clearRuntime(): void;
}

/**
 * layers 按「高 → 低」优先级排列：[运行时, 环境, 集合, 项目, 全局]。
 * 运行时层始终存在且位于最前（规格 §7.3）。
 */
export function createVariableResolver(opts: { layers: Array<Record<string, string>> }): VariableResolver {
  const runtime = new Map<string, string>();

  function raw(name: string): string | undefined {
    for (const layer of [Object.fromEntries(runtime), ...opts.layers]) {
      const v = layer[name];
      if (v !== undefined) return v;
    }
    return dynamic[name]?.();
  }

  function resolveName(name: string, seen: string[]): string | undefined {
    if (seen.includes(name)) {
      throw new CyclicVariableError(`变量循环引用: ${[...seen, name].join(" → ")}`);
    }
    const v = raw(name);
    if (v === undefined) return undefined;
    if (PLACEHOLDER.test(v)) {
      PLACEHOLDER.lastIndex = 0;
      return resolve(v, [...seen, name]);
    }
    return v;
  }

  function resolve(input: string, seen: string[] = []): string {
    return input.replace(PLACEHOLDER, (match, name: string) => resolveName(name, seen) ?? match);
  }

  return {
    get: (name) => resolveName(name, []),
    resolve: (input) => resolve(input),
    setRuntime: (name, value) => runtime.set(name, value),
    clearRuntime: () => runtime.clear(),
  };
}
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/variables/resolver.test.ts`
预期：PASS（5 个用例）

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/variables packages/core/tests/variables
git commit -m "feat(core): 变量解析器——层级优先级、动态变量、循环引用检测"
```

---

### 任务 6：文件存储适配器（§6 目录布局）

**文件：**
- 创建：`packages/core/src/storage/fileStorage.ts`
- 测试：`packages/core/tests/storage/fileStorage.test.ts`

- [ ] **步骤 1：编写失败的 roundtrip 测试**

`packages/core/tests/storage/fileStorage.test.ts`：

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStorage } from "../../src/storage/fileStorage.js";
import type { Workspace } from "../../src/domain/model.js";

const workspace: Workspace = {
  id: "w1", name: "demo", variables: { region: "cn" },
  groups: [{
    id: "g1", name: "ecommerce",
    projects: [{
      id: "p1", name: "order-service", variables: {},
      environments: [{ id: "e1", name: "dev", extends: undefined, variables: { baseUrl: "http://127.0.0.1" } }],
      collections: [{
        id: "c1", name: "order-api", variables: {}, folders: [], apis: [],
      }],
    }],
  }],
};

describe("fileStorage", () => {
  it("save→load roundtrip 保留结构、变量与 id", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(problems).toEqual([]);
    expect(loaded.groups[0]?.projects[0]?.environments[0]?.variables.baseUrl).toBe("http://127.0.0.1");
    expect(loaded.groups[0]?.projects[0]?.collections[0]?.id).toBe("c1");
  });

  it("接口 design.md 与用例环境后缀落盘并读回", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    const ws: Workspace = {
      ...workspace,
      groups: [{
        ...workspace.groups[0]!, projects: [{
          ...workspace.groups[0]!.projects[0]!, collections: [{
            id: "c1", name: "order-api", variables: {}, folders: [],
            apis: [{
              id: "a1", name: "create-order", version: "1.0.0", deprecated: false,
              method: "POST", url: "{{baseUrl}}/orders", headers: [], query: [],
              design: "# 创建订单设计",
              cases: [
                { id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] },
                { id: "t2", name: "ok", scope: "sit", parameters: {}, assertions: [] },
              ],
            }],
          }],
        }],
      }],
    };
    await fileStorage.save(root, ws);
    const { workspace: loaded } = await fileStorage.load(root);
    const api = loaded.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    expect(api.design).toBe("# 创建订单设计");
    expect(api.cases.map((c) => c.scope).sort()).toEqual(["base", "sit"]);
  });

  it("坏 YAML 隔离为 problem，不阻塞其余加载", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-ws-"));
    await fileStorage.save(root, workspace);
    const envFile = join(root, "groups", "ecommerce", "projects", "order-service", "environments", "dev.yaml");
    writeFileSync(envFile, "id: [broken");
    const { workspace: loaded, problems } = await fileStorage.load(root);
    expect(loaded.groups[0]!.projects[0]!.environments).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toContain("dev.yaml");
  });

  it("缺少 apicc.workspace.yaml 时抛错", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-empty-"));
    await expect(fileStorage.load(root)).rejects.toThrow(/apicc\.workspace\.yaml/);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/storage/fileStorage.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：安装依赖并实现**

运行：`pnpm -C packages/core add yaml`

`packages/core/src/storage/fileStorage.ts`：

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ApiDefinition, Workspace } from "../domain/model.js";
import type { LoadProblem, StorageAdapter } from "../plugin/types.js";

const WORKSPACE_FILE = "apicc.workspace.yaml";

function readYaml<T>(file: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: parseYaml(readFileSync(file, "utf8")) as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function writeYaml(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifyYaml(JSON.parse(JSON.stringify(data))));
}

async function loadApiDir(dir: string, problems: LoadProblem[]): Promise<ApiDefinition | null> {
  const apiFile = join(dir, "api.yaml");
  if (!existsSync(apiFile)) return null;
  const res = readYaml<ApiDefinition>(apiFile);
  if (!res.ok) {
    problems.push({ file: relative(dir, apiFile), message: res.error });
    return null;
  }
  const api = res.data;
  const designFile = join(dir, "design.md");
  if (existsSync(designFile)) api.design = readFileSync(designFile, "utf8");
  api.cases = [];
  const casesDir = join(dir, "cases");
  if (existsSync(casesDir)) {
    for (const f of readdirSync(casesDir).filter((n) => n.endsWith(".yaml"))) {
      const cRes = readYaml<ApiDefinition["cases"][number]>(join(casesDir, f));
      if (!cRes.ok) {
        problems.push({ file: join("cases", f), message: cRes.error });
        continue;
      }
      api.cases.push(cRes.data);
    }
  }
  return api;
}

export const fileStorage: StorageAdapter = {
  async load(root: string) {
    const wsFile = join(root, WORKSPACE_FILE);
    if (!existsSync(wsFile)) {
      throw new Error(`工作区根目录缺少 ${WORKSPACE_FILE}: ${root}`);
    }
    const problems: LoadProblem[] = [];
    const wsRes = readYaml<Workspace>(wsFile);
    if (!wsRes.ok) throw new Error(`${WORKSPACE_FILE} 解析失败: ${wsRes.error}`);
    const workspace = wsRes.data;
    workspace.groups = [];

    const groupsDir = join(root, "groups");
    if (!existsSync(groupsDir)) return { workspace, problems };

    for (const gName of readdirSync(groupsDir)) {
      const gDir = join(groupsDir, gName);
      const gRes = readYaml<{ id: string; name: string }>(join(gDir, "group.yaml"));
      if (!gRes.ok) {
        problems.push({ file: join("groups", gName, "group.yaml"), message: gRes.error });
        continue;
      }
      const group = { ...gRes.data, projects: [] };
      const projectsDir = join(gDir, "projects");
      if (existsSync(projectsDir)) {
        for (const pName of readdirSync(projectsDir)) {
          const pDir = join(projectsDir, pName);
          const pRes = readYaml<Omit<(typeof group)["projects"][number], "environments" | "collections">>(
            join(pDir, "project.yaml"),
          );
          if (!pRes.ok) {
            problems.push({ file: join("groups", gName, "projects", pName, "project.yaml"), message: pRes.error });
            continue;
          }
          const project = { ...pRes.data, environments: [], collections: [] };

          const envDir = join(pDir, "environments");
          if (existsSync(envDir)) {
            for (const f of readdirSync(envDir).filter((n) => n.endsWith(".yaml"))) {
              const eRes = readYaml<(typeof project)["environments"][number]>(join(envDir, f));
              if (!eRes.ok) {
                problems.push({ file: join("environments", f), message: eRes.error });
                continue;
              }
              project.environments.push(eRes.data);
            }
          }

          const collDir = join(pDir, "collections");
          if (existsSync(collDir)) {
            for (const cName of readdirSync(collDir)) {
              const cRes = readYaml<Omit<(typeof project)["collections"][number], "apis">>(
                join(collDir, cName, "collection.yaml"),
              );
              if (!cRes.ok) {
                problems.push({ file: join("collections", cName, "collection.yaml"), message: cRes.error });
                continue;
              }
              const collection = { ...cRes.data, apis: [], folders: [] };
              const apisDir = join(collDir, cName, "apis");
              if (existsSync(apisDir)) {
                for (const aName of readdirSync(apisDir)) {
                  const api = await loadApiDir(join(apisDir, aName), problems);
                  if (api) collection.apis.push(api);
                }
              }
              project.collections.push(collection);
            }
          }
          group.projects.push(project);
        }
      }
      workspace.groups.push(group);
    }
    return { workspace, problems };
  },

  async save(root: string, ws: Workspace) {
    writeYaml(join(root, WORKSPACE_FILE), { id: ws.id, name: ws.name, variables: ws.variables });
    for (const g of ws.groups) {
      const gDir = join(root, "groups", g.name);
      writeYaml(join(gDir, "group.yaml"), { id: g.id, name: g.name });
      for (const p of g.projects) {
        const pDir = join(gDir, "projects", p.name);
        writeYaml(join(pDir, "project.yaml"), { id: p.id, name: p.name, variables: p.variables });
        for (const e of p.environments) {
          writeYaml(join(pDir, "environments", `${e.name}.yaml`), {
            id: e.id, name: e.name, extends: e.extends, variables: e.variables,
          });
        }
        for (const c of p.collections) {
          const cDir = join(pDir, "collections", c.name);
          writeYaml(join(cDir, "collection.yaml"), {
            id: c.id, name: c.name, variables: c.variables, scripts: c.scripts,
          });
          for (const api of c.apis) {
            const aDir = join(cDir, "apis", api.name);
            writeYaml(join(aDir, "api.yaml"), {
              id: api.id, name: api.name, version: api.version, deprecated: api.deprecated,
              method: api.method, url: api.url, headers: api.headers, query: api.query,
              body: api.body, auth: api.auth,
            });
            if (api.design) {
              mkdirSync(aDir, { recursive: true });
              writeFileSync(join(aDir, "design.md"), api.design);
            }
            for (const tc of api.cases) {
              const fileName = tc.scope === "base" ? `${tc.name}.yaml` : `${tc.name}.${tc.scope}.yaml`;
              writeYaml(join(aDir, "cases", fileName), tc);
            }
          }
        }
      }
    }
  },
};
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/storage/fileStorage.test.ts`
预期：PASS（4 个用例）

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/storage packages/core/tests/storage
git commit -m "feat(core): 文件存储适配器——§6 目录布局读写与坏文件隔离"
```

---

### 任务 7：SQLite 索引

**文件：**
- 创建：`packages/core/src/storage/sqliteIndex.ts`
- 测试：`packages/core/tests/storage/sqliteIndex.test.ts`

- [ ] **步骤 1：编写失败的测试**

`packages/core/tests/storage/sqliteIndex.test.ts`：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteIndex } from "../../src/storage/sqliteIndex.js";
import type { Workspace } from "../../src/domain/model.js";

const ws: Workspace = {
  id: "w1", name: "demo", variables: {},
  groups: [{
    id: "g1", name: "g", projects: [{
      id: "p1", name: "p", variables: {}, environments: [],
      collections: [{
        id: "c1", name: "c", variables: {}, folders: [],
        apis: [{
          id: "a1", name: "api", version: "1", deprecated: false,
          method: "GET", url: "/", headers: [], query: [],
          cases: [{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] }],
        }],
      }],
    }],
  }],
};

describe("SqliteIndex", () => {
  it("rebuild 后可按 id 与 type 查询", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-idx-")), "index.db");
    const idx = new SqliteIndex(db);
    idx.rebuild(ws, "/ws");
    expect(idx.byId("a1")?.type).toBe("api");
    expect(idx.byId("t1")?.parentId).toBe("a1");
    expect(idx.byType("api")).toHaveLength(1);
    idx.close();
  });

  it("重复 rebuild 幂等", () => {
    const db = join(mkdtempSync(join(tmpdir(), "apicc-idx-")), "index.db");
    const idx = new SqliteIndex(db);
    idx.rebuild(ws, "/ws");
    idx.rebuild(ws, "/ws");
    expect(idx.byType("case")).toHaveLength(1);
    idx.close();
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/storage/sqliteIndex.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：安装依赖并实现**

运行：`pnpm -C packages/core add better-sqlite3 && pnpm -C packages/core add -D @types/better-sqlite3`

`packages/core/src/storage/sqliteIndex.ts`：

```ts
import Database from "better-sqlite3";
import { join } from "node:path";
import type { Workspace } from "../domain/model.js";

interface Row { id: string; type: string; name: string; parentId: string | null; path: string }

/** 可重建的查询缓存（规格 §4）：任何时刻删除 db 文件后由 rebuild 恢复。 */
export class SqliteIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, type TEXT, name TEXT, parentId TEXT, path TEXT)",
    );
  }

  rebuild(ws: Workspace, root: string): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?)");
    const rows: Row[] = [];
    rows.push({ id: ws.id, type: "workspace", name: ws.name, parentId: null, path: "." });
    for (const g of ws.groups) {
      rows.push({ id: g.id, type: "group", name: g.name, parentId: ws.id, path: join("groups", g.name) });
      for (const p of g.projects) {
        rows.push({ id: p.id, type: "project", name: p.name, parentId: g.id, path: join("groups", g.name, "projects", p.name) });
        for (const e of p.environments) {
          rows.push({ id: e.id, type: "environment", name: e.name, parentId: p.id, path: join("environments", `${e.name}.yaml`) });
        }
        for (const c of p.collections) {
          rows.push({ id: c.id, type: "collection", name: c.name, parentId: p.id, path: join("collections", c.name) });
          for (const f of c.folders) {
            rows.push({ id: f.id, type: "folder", name: f.name, parentId: c.id, path: join("collections", c.name, f.name) });
          }
          for (const api of c.apis) {
            rows.push({ id: api.id, type: "api", name: api.name, parentId: c.id, path: join("collections", c.name, "apis", api.name) });
            for (const tc of api.cases) {
              rows.push({ id: tc.id, type: "case", name: tc.name, parentId: api.id, path: join("cases", tc.name) });
            }
          }
        }
      }
    }
    this.db.transaction(() => {
      this.db.exec("DELETE FROM objects");
      for (const r of rows) insert.run(r.id, r.type, r.name, r.parentId, r.path);
    })();
    void root;
  }

  byId(id: string): Omit<Row, never> | undefined {
    return this.db.prepare("SELECT id, type, name, parentId, path FROM objects WHERE id = ?").get(id) as Row | undefined;
  }

  byType(type: string): Row[] {
    return this.db.prepare("SELECT id, type, name, parentId, path FROM objects WHERE type = ?").all(type) as Row[];
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/storage/sqliteIndex.test.ts`
预期：PASS（2 个用例）

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/storage/sqliteIndex.ts packages/core/tests/storage/sqliteIndex.test.ts packages/core/package.json
git commit -m "feat(core): SQLite 可重建索引"
```

---

### 任务 8：JS 脚本引擎插件（vm 沙箱 + pm.*）

**文件：**
- 创建：`packages/core/src/sandbox/jsEngine.ts`
- 测试：`packages/core/tests/sandbox/jsEngine.test.ts`

- [ ] **步骤 1：编写失败的测试**

`packages/core/tests/sandbox/jsEngine.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { jsScriptEngine } from "../../src/sandbox/jsEngine.js";
import type { PmApi, ScriptContext } from "../../src/plugin/types.js";

const pm: PmApi = {
  variables: { get: () => undefined, set: () => {} },
  environment: { get: () => undefined },
  request: { method: "GET", url: "http://x/", headers: {}, query: [] },
  assert(cond: boolean, message: string) {
    (this as { __asserts: { cond: boolean; message: string }[] }).__asserts ??= [];
    (this as { __asserts: { cond: boolean; message: string }[] }).__asserts.push({ cond, message });
  },
};

const ctx: ScriptContext = { pm };

describe("jsScriptEngine", () => {
  it("把同一个 pm 对象传入沙箱（脚本的读写直接作用于该对象）", () => {
    jsScriptEngine.run("pm.variables.set('token', 'abc'); pm.__probe = true;", ctx);
    expect((ctx.pm as { __probe?: boolean }).__probe).toBe(true);
  });

  it("脚本异常向上传播", () => {
    expect(() => jsScriptEngine.run("throw new Error('bad');", ctx)).toThrow(/bad/);
  });

  it("死循环在超时后被中断", () => {
    expect(() => jsScriptEngine.run("for(;;){}", ctx)).toThrow();
  });

  it("沙箱内无法访问 node:fs", () => {
    expect(() => jsScriptEngine.run("require('node:fs');", ctx)).toThrow();
  });
});
```

同时在文件末尾补一个「与真实 resolver 联动」的用例：

```ts
import { createVariableResolver } from "../../src/variables/resolver.js";

it("pm.variables.set 写入 resolver 运行时层", () => {
  const resolver = createVariableResolver({ layers: [] });
  const realCtx: ScriptContext = {
    pm: {
      variables: { get: (n) => resolver.get(n), set: (n, v) => resolver.setRuntime(n, v) },
      environment: { get: () => undefined },
      request: { method: "GET", url: "/", headers: {}, query: [] },
      assert: () => {},
    },
  };
  jsScriptEngine.run("pm.variables.set('k', 'v');", realCtx);
  expect(resolver.get("k")).toBe("v");
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/sandbox/jsEngine.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现脚本引擎**

`packages/core/src/sandbox/jsEngine.ts`：

```ts
import { createContext, runInNewContext } from "node:vm";
import type { ScriptEngine } from "../plugin/types.js";

export const SCRIPT_TIMEOUT_MS = 3000;

export class ScriptTimeoutError extends Error {}

/**
 * node:vm 独立上下文：不提供 require/process/fs/net（规格 §8）。
 * 脚本只能通过注入的 pm 对象与外界交互。
 */
export const jsScriptEngine: ScriptEngine = {
  language: "javascript",
  run(code: string, ctx: ScriptContext): void {
    const sandbox = createContext({ pm: ctx.pm });
    try {
      runInNewContext(code, sandbox, { timeout: SCRIPT_TIMEOUT_MS });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("Script execution timed out")) throw new ScriptTimeoutError(`脚本超时（>${SCRIPT_TIMEOUT_MS}ms）`);
      throw e;
    }
  },
};
```

实现说明（写入该文件尾部注释即可）：引擎只负责把 `pm` 原样传入沙箱——脚本对该对象的一切读写（含新增属性）都直接落在 `ctx.pm` 上，由第一个用例验证；`pm.variables` 与真实解析器的联动由最后一个用例验证。

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/sandbox/jsEngine.test.ts`
预期：PASS（5 个用例）

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/sandbox packages/core/tests/sandbox
git commit -m "feat(core): JS 脚本引擎插件——vm 沙箱、超时与 pm 上下文"
```

---

### 任务 9：断言操作符插件

**文件：**
- 创建：`packages/core/src/assert/operators.ts`
- 测试：`packages/core/tests/assert/operators.test.ts`

- [ ] **步骤 1：编写失败的测试（含契约测试调用）**

`packages/core/tests/assert/operators.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { builtinAssertOperators } from "../../src/assert/operators.js";
import { itCompliesWithAssertOperatorContract } from "../contracts/assertOperator.contract.js";

const eq = builtinAssertOperators.find((o) => o.op === "eq")!;
const jsonEq = builtinAssertOperators.find((o) => o.op === "eq")!;

describe("内置断言操作符", () => {
  it("eq 数值与字符串", () => {
    expect(eq.evaluate(200, "200").pass).toBe(true);
    expect(eq.evaluate("abc", "abd").pass).toBe(false);
  });

  it("contains 适用于字符串与数组", () => {
    const contains = builtinAssertOperators.find((o) => o.op === "contains")!;
    expect(contains.evaluate("hello world", "world").pass).toBe(true);
    expect(contains.evaluate([1, 2], "2").pass).toBe(true);
    expect(contains.evaluate("hello", "x").pass).toBe(false);
  });

  it("lt/gte 数值比较", () => {
    const lt = builtinAssertOperators.find((o) => o.op === "lt")!;
    const gte = builtinAssertOperators.find((o) => o.op === "gte")!;
    expect(lt.evaluate(99, "100").pass).toBe(true);
    expect(gte.evaluate(100, "100").pass).toBe(true);
  });

  it("neq 不等成立", () => {
    const neq = builtinAssertOperators.find((o) => o.op === "neq")!;
    expect(neq.evaluate("a", "b").pass).toBe(true);
  });

  for (const op of builtinAssertOperators) {
    itCompliesWithAssertOperatorContract(op);
    void jsonEq;
  }
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/assert/operators.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现操作符**

`packages/core/src/assert/operators.ts`：

```ts
import type { AssertOperator } from "../plugin/types.js";

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function make(op: string, test: (actual: unknown, expected: string | undefined) => boolean, describeResult: (pass: boolean) => string): AssertOperator {
  return {
    op,
    evaluate(actual, expected) {
      const pass = test(actual, expected);
      return { pass, message: `${op} 断言${pass ? "通过" : "失败"}: actual=${JSON.stringify(actual)}, expected=${expected}` };
    },
    void describeResult,
  };
}

export const builtinAssertOperators: AssertOperator[] = [
  make("eq", (a, e) => (typeof a === "number" ? a === num(e) : String(a) === e), () => ""),
  make("neq", (a, e) => (typeof a === "number" ? a !== num(e) : String(a) !== e), () => ""),
  make("contains", (a, e) => Array.isArray(a) ? a.map(String).includes(e ?? "") : String(a).includes(e ?? ""), () => ""),
  make("lt", (a, e) => num(a) < num(e), () => ""),
  make("gt", (a, e) => num(a) > num(e), () => ""),
  make("lte", (a, e) => num(a) <= num(e), () => ""),
  make("gte", (a, e) => num(a) >= num(e), () => ""),
];
```

注意：`evaluate(undefined, …)` 时 `num(undefined)` 为 NaN，全部比较为 false → 契约「undefined 返回 fail」自动满足；`make` 内 `void describeResult` 请删除——直接去掉第三参，保持签名 `make(op, test)`。

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/assert/operators.test.ts`
预期：PASS（含 7 个操作符 × 2 契约用例）

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/assert packages/core/tests/assert
git commit -m "feat(core): 内置断言操作符插件与契约测试接入"
```

---

### 任务 10：HTTP 协议客户端与认证插件

**文件：**
- 创建：`packages/core/src/http/client.ts`
- 创建：`packages/core/src/http/auth.ts`
- 测试：`packages/core/tests/http/client.test.ts`、`packages/core/tests/http/auth.test.ts`

- [ ] **步骤 1：编写失败的客户端测试（本地 HTTP 服务）**

`packages/core/tests/http/client.test.ts`：

```ts
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpClient, classifyNetworkError } from "../../src/http/client.js";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/echo") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("x-echo", req.headers["x-token"] ?? "none");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ method: req.method, body }));
      });
    } else if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 5000);
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts = { connectTimeoutMs: 2000, totalTimeoutMs: 3000 };

describe("httpClient", () => {
  it("发送 POST JSON 并读取响应头/体/耗时", async () => {
    const res = await httpClient.execute(
      { method: "POST", url: `${baseUrl}/echo`, headers: { "content-type": "application/json", "x-token": "t1" }, query: [], body: { kind: "json", content: '{"a":1}' } },
      opts,
    );
    expect(res.status).toBe(200);
    expect(res.headers["x-echo"]).toBe("t1");
    expect(JSON.parse(res.bodyText)).toEqual({ method: "POST", body: '{"a":1}' });
    expect(res.timeMs).toBeGreaterThanOrEqual(0);
  });

  it("query 参数拼接到 URL", async () => {
    const res = await httpClient.execute(
      { method: "GET", url: `${baseUrl}/echo`, headers: {}, query: [{ key: "a", value: "1", enabled: true }], },
      opts,
    );
    expect(res.status).toBe(200);
  });

  it("连接拒绝分类为 refused", async () => {
    // 端口 1 几乎必然拒绝；若环境异常兜底校验分类函数存在
    try {
      await httpClient.execute({ method: "GET", url: "http://127.0.0.1:1/", headers: {}, query: [] }, opts);
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe("refused");
    }
  });

  it("响应超时分类为 timeout", async () => {
    try {
      await httpClient.execute({ method: "GET", url: `${baseUrl}/slow`, headers: {}, query: [] }, { connectTimeoutMs: 1000, totalTimeoutMs: 500 });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe("timeout");
    }
  });

  it("classifyNetworkError 覆盖 DNS", () => {
    expect(classifyNetworkError({ code: "ENOTFOUND" })).toBe("dns");
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/http/client.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：安装依赖并实现客户端**

运行：`pnpm -C packages/core add undici`

`packages/core/src/http/client.ts`：

```ts
import { Agent, request } from "undici";
import type { ExecutableRequest, ExecutionResponse, HttpExecuteOptions, ProtocolClient } from "../plugin/types.js";

export type HttpErrorKind = "dns" | "refused" | "timeout" | "tls" | "unknown";

export class HttpExecutionError extends Error {
  constructor(public kind: HttpErrorKind, cause: unknown) {
    super(`请求失败（${kind}）: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

export function classifyNetworkError(e: unknown): HttpErrorKind {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err.code ?? err.cause?.code ?? "";
  const msg = err.message ?? err.cause?.message ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (code.includes("TIMEOUT") || /timed?\s?out|timeout/i.test(msg)) return "timeout";
  if (/TLS|CERT/i.test(code) || /tls|certificate/i.test(msg)) return "tls";
  return "unknown";
}

const defaultAgent = new Agent({
  connect: { timeout: 10_000 },
  headersTimeout: 30_000,
  bodyTimeout: 30_000,
});

function buildUrl(req: ExecutableRequest): string {
  const qs = req.query
    .filter((kv) => kv.enabled && kv.key !== "")
    .map((kv) => `${encodeURIComponent(kv.key)}=${encodeURIComponent(kv.value)}`)
    .join("&");
  return qs ? `${req.url}${req.url.includes("?") ? "&" : "?"}${qs}` : req.url;
}

export const httpClient: ProtocolClient & { close(): void } = {
  canHandle: (req) => req.url.startsWith("http://") || req.url.startsWith("https://"),
  async execute(req, opts) {
    const started = performance.now();
    try {
      const agent = new Agent({
        connect: { timeout: opts.connectTimeoutMs },
        headersTimeout: opts.totalTimeoutMs,
        bodyTimeout: opts.totalTimeoutMs,
      });
      try {
        const res = await request(buildUrl(req), {
          method: req.method,
          headers: req.headers,
          body: req.body && req.body.kind !== "form" ? req.body.content : undefined,
          dispatcher: agent,
        });
        const bodyText = await res.body.text();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = String(v);
        return { status: res.statusCode, headers, bodyText, timeMs: performance.now() - started };
      } finally {
        await agent.close();
      }
    } catch (e) {
      throw new HttpExecutionError(classifyNetworkError(e), e);
    }
  },
  async close() {
    await defaultAgent.close();
  },
};
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/http/client.test.ts`
预期：PASS（5 个用例）

- [ ] **步骤 5：编写失败的认证测试**

`packages/core/tests/http/auth.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { builtinAuthProviders } from "../../src/http/auth.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

function req(): ExecutableRequest {
  return { method: "GET", url: "http://x/", headers: {}, query: [] };
}

describe("内置认证器", () => {
  it("bearer 写入 Authorization 头，值经变量解析", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "bearer")!;
    const r = req();
    provider.apply(r, { type: "bearer", token: "{{tok}}" }, (n) => (n === "tok" ? "secret" : undefined));
    expect(r.headers["Authorization"]).toBe("Bearer secret");
  });

  it("basic 写入 base64 凭证", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "basic")!;
    const r = req();
    provider.apply(r, { type: "basic", username: "u", password: "p" }, () => undefined);
    expect(r.headers["Authorization"]).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("apikey 支持 header 与 query 两种位置", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "apikey")!;
    const r1 = req();
    provider.apply(r1, { type: "apikey", key: "X-Key", value: "v", placement: "header" }, () => undefined);
    expect(r1.headers["X-Key"]).toBe("v");
    const r2 = req();
    provider.apply(r2, { type: "apikey", key: "key", value: "v", placement: "query" }, () => undefined);
    expect(r2.query).toContainEqual({ key: "key", value: "v", enabled: true });
  });
});
```

- [ ] **步骤 6：运行验证失败后实现认证器**

运行：`pnpm -C packages/core vitest run tests/http/auth.test.ts` → FAIL 后创建

`packages/core/src/http/auth.ts`：

```ts
import type { AuthProvider } from "../plugin/types.js";

export const builtinAuthProviders: AuthProvider[] = [
  {
    type: "bearer",
    apply(req, auth, getVar) {
      req.headers["Authorization"] = `Bearer ${getVar(auth.token ?? "") ?? auth.token ?? ""}`;
    },
  },
  {
    type: "basic",
    apply(req, auth, getVar) {
      const u = getVar(auth.username ?? "") ?? auth.username ?? "";
      const p = getVar(auth.password ?? "") ?? auth.password ?? "";
      req.headers["Authorization"] = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
    },
  },
  {
    type: "apikey",
    apply(req, auth, getVar) {
      const key = getVar(auth.key ?? "") ?? auth.key ?? "";
      const value = getVar(auth.value ?? "") ?? auth.value ?? "";
      if (auth.placement === "query") {
        req.query.push({ key, value, enabled: true });
      } else {
        req.headers[key] = value;
      }
    },
  },
];
```

再次运行：`pnpm -C packages/core vitest run tests/http/auth.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 7：Commit**

```bash
git add packages/core/src/http packages/core/tests/http packages/core/package.json
git commit -m "feat(core): undici HTTP 协议客户端插件与 bearer/basic/apikey 认证器"
```

---

### 任务 11：集合运行器 Runner

**文件：**
- 创建：`packages/core/src/runner/runner.ts`
- 测试：`packages/core/tests/runner/runner.test.ts`

- [ ] **步骤 1：编写失败的测试（含数据驱动与 fail-fast）**

`packages/core/tests/runner/runner.test.ts`：

```ts
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { createEventBus } from "../../src/events/bus.js";
import { CollectionRunner } from "../../src/runner/runner.js";
import { httpClient } from "../../src/http/client.js";
import { builtinAuthProviders } from "../../src/http/auth.js";
import { builtinAssertOperators } from "../../src/assert/operators.js";
import { jsScriptEngine } from "../../src/sandbox/jsEngine.js";
import type { Collection, Environment, Project, Workspace } from "../../src/domain/model.js";

let server: Server;
let baseUrl = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, n: 42 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function buildDeps(failFast = false) {
  const registry = createPluginRegistry();
  registry.registerProtocol(httpClient);
  for (const p of builtinAuthProviders) registry.registerAuth(p);
  for (const o of builtinAssertOperators) registry.registerAssert(o);
  registry.registerScriptEngine(jsScriptEngine);
  return new CollectionRunner({
    registry, bus: createEventBus(),
    timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 3000 },
    failFast,
  });
}

const env: Environment = { id: "e1", name: "dev", variables: { baseUrl, who: "dev" } };
const project: Project = { id: "p1", name: "p", variables: {}, environments: [env], collections: [] };
const workspace: Workspace = { id: "w1", name: "ws", variables: { who: "global" }, groups: [] };

function collectionWith(cases: Collection["apis"][number]["cases"]): Collection {
  return {
    id: "c1", name: "c", variables: {}, folders: [],
    apis: [{ id: "a1", name: "get-ok", version: "1", deprecated: false, method: "GET", url: "{{baseUrl}}/x", headers: [], query: [], cases }],
  };
}

describe("CollectionRunner", () => {
  it("基座用例：断言通过计入 passed", async () => {
    const col = collectionWith([
      { id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [
        { id: "as1", target: "status", op: "eq", expected: "200" },
        { id: "as2", target: "bodyJson", op: "eq", path: "$.n", expected: "42" },
      ] },
    ]);
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("失败断言计入 failed 且不中断后续", async () => {
    const col = collectionWith([
      { id: "t1", name: "bad", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "500" }] },
      { id: "t2", name: "good", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "200" }] },
    ]);
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
  });

  it("环境继承链上 scope=父环境 的用例也执行", async () => {
    const sitEnv: Environment = { id: "e2", name: "sit", extends: "dev", variables: { baseUrl, who: "sit" } };
    const col = collectionWith([{ id: "t1", name: "dev-only", scope: "dev", parameters: {}, assertions: [] }]);
    const result = await buildDeps().run(col, sitEnv, project, workspace, {});
    expect(result.total).toBe(1);
  });

  it("数据驱动：CSV 每行执行一次并注入运行时变量", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-run-"));
    writeFileSync(join(dir, "data.csv"), "sku\nA1\nB2");
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "dd", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/x`, headers: [], query: [],
        cases: [{
          id: "t1", name: "row", scope: "base", parameters: {},
          dataDriver: { sourcePath: join(dir, "data.csv"), format: "csv" },
          postScript: "if (pm.variables.get('sku') === undefined) throw new Error('sku 未注入');",
          assertions: [],
        }],
      }],
    };
    const result = await buildDeps().run(col, env, project, workspace, {});
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
  });

  it("前置脚本可改写请求路径", async () => {
    const seen: string[] = [];
    const col: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "rewrite", version: "1", deprecated: false,
        method: "GET", url: `${baseUrl}/wrong`, headers: [], query: [],
        cases: [{
          id: "t1", name: "rw", scope: "base", parameters: {}, assertions: [],
          preScript: "pm.request.url = pm.request.url.replace('/wrong', '/right');",
        }],
      }],
    };
    const bus = createEventBus();
    bus.on("beforeRequest", ({ request }) => { seen.push((request as { url: string }).url); });
    const runner = new CollectionRunner({
      registry: (() => { const r = createPluginRegistry(); r.registerProtocol(httpClient); for (const p of builtinAuthProviders) r.registerAuth(p); for (const o of builtinAssertOperators) r.registerAssert(o); r.registerScriptEngine(jsScriptEngine); return r; })(),
      bus, timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 3000 }, failFast: false,
    });
    const result = await runner.run(col, env, project, workspace, {});
    expect(seen[0]).toContain("/right");
    expect(result.passed).toBe(1);
  });

  it("failFast=true 时首个失败后停止", async () => {
    const col = collectionWith([
      { id: "t1", name: "bad", scope: "base", parameters: {}, assertions: [{ id: "a", target: "status", op: "eq", expected: "500" }] },
      { id: "t2", name: "never", scope: "base", parameters: {}, assertions: [] },
    ]);
    const result = await buildDeps(true).run(col, env, project, workspace, {});
    expect(result.total).toBe(1);
  });

  it("runsDir 提供时原始结果 JSON 先行落盘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-runs-"));
    const col = collectionWith([{ id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] }]);
    await buildDeps().run(col, env, project, workspace, { runsDir: dir });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).some((f) => f.endsWith(".json"))).toBe(true);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/runner/runner.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现 Runner**

`packages/core/src/runner/runner.ts`：

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import { envChain } from "../domain/envChain.js";
import type { ApiDefinition, Collection, Environment, Project, TestCase, Workspace } from "../domain/model.js";
import { createVariableResolver, type VariableResolver } from "../variables/resolver.js";
import type { EventBus } from "../events/bus.js";
import type { PmApi, PluginRegistry } from "../plugin/types.js";
import type { CaseOutcome, RunResult } from "../report/types.js";

export interface RunnerOptions { runsDir?: string }

export class CollectionRunner {
  constructor(private deps: {
    registry: PluginRegistry;
    bus: EventBus;
    timeouts: { connectTimeoutMs: number; totalTimeoutMs: number };
    failFast: boolean;
  }) {}

  async run(collection: Collection, env: Environment | undefined, project: Project, workspace: Workspace, opts: RunnerOptions): Promise<RunResult> {
    const startedAt = new Date();
    const chain = env ? envChain(env, project) : [];
    const resolver = createVariableResolver({
      layers: [env?.variables ?? {}, collection.variables, project.variables, workspace.variables],
    });
    const engine = this.deps.registry.getScriptEngine("javascript");
    if (!engine) throw new Error("缺少 javascript 脚本引擎插件");
    const storage = this.deps.registry.getStorage(); // 预留：报告与运行历史的适配器通道

    await this.deps.bus.emit("beforeRun", { collectionName: collection.name, envName: env?.name });

    const outcomes: CaseOutcome[] = [];
    const apis = [...collection.apis, ...collection.folders.flatMap((f) => f.apis)];
    if (collection.scripts?.pre) engine.run(collection.scripts.pre, this.buildContext(resolver, env, undefined, undefined));

    outer:
    for (const api of apis) {
      for (const tc of api.cases.filter((c) => c.scope === "base" || chain.includes(c.scope))) {
        const rows = this.expandDataRows(tc);
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const outcome = await this.runCase(api, tc, rows[rowIndex], rowIndex, rows.length > 1, resolver, env, engine);
          outcomes.push(outcome);
          if (!outcome.passed && this.deps.failFast) break outer;
        }
      }
    }

    const result: RunResult = {
      collectionId: collection.id, collectionName: collection.name, envName: env?.name,
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      total: outcomes.length, passed: outcomes.filter((o) => o.passed).length,
      failed: outcomes.filter((o) => !o.passed).length, cases: outcomes,
    };
    // 原始结果 JSON 先行落盘（规格 §8：报告失败不影响结果保存）
    if (opts.runsDir) {
      mkdirSync(opts.runsDir, { recursive: true });
      writeFileSync(join(opts.runsDir, `run-${Date.now()}.json`), JSON.stringify(result, null, 2));
    }
    await this.deps.bus.emit("afterRun", { total: result.total, passed: result.passed, failed: result.failed });
    return result;
  }

  private expandDataRows(tc: TestCase): Array<Record<string, string> | undefined> {
    if (!tc.dataDriver) return [undefined];
    const raw = readFileSync(tc.dataDriver.sourcePath, "utf8");
    const records: Array<Record<string, string>> =
      tc.dataDriver.format === "csv"
        ? parseCsv(raw, { columns: true, skip_empty_lines: true })
        : JSON.parse(raw);
    return records.length > 0 ? records : [undefined];
  }

  private async runCase(
    api: ApiDefinition, tc: TestCase,
    row: Record<string, string> | undefined, rowIndex: number, isDataDriven: boolean,
    resolver: VariableResolver, env: Environment | undefined,
    engine: NonNullable<ReturnType<PluginRegistry["getScriptEngine"]>>,
  ): Promise<CaseOutcome> {
    const started = performance.now();
    resolver.clearRuntime();
    for (const [k, v] of Object.entries({ ...tc.parameters, ...(row ?? {}) })) resolver.setRuntime(k, v);

    await this.deps.bus.emit("beforeCase", { apiName: api.name, caseName: tc.name, row: isDataDriven ? rowIndex : undefined });

    const request = {
      method: api.method,
      url: resolver.resolve(api.url),
      headers: Object.fromEntries(api.headers.filter((h) => h.enabled).map((h) => [h.key, resolver.resolve(h.value)])),
      query: api.query.map((q) => ({ ...q, value: resolver.resolve(q.value) })),
      body: api.body ? { ...api.body, content: resolver.resolve(api.body.content) } : undefined,
      auth: api.auth,
    };

    const pmAsserts: Array<{ pass: boolean; message: string }> = [];
    const ctx = this.buildContext(resolver, env, request, undefined, pmAsserts);

    let error: string | undefined;
    try {
      if (tc.preScript) engine.run(tc.preScript, ctx);
      await this.deps.bus.emit("beforeRequest", { request });

      if (request.auth) {
        const provider = this.deps.registry.getAuth(request.auth.type);
        provider?.apply(request, request.auth, (n) => resolver.get(n));
      }
      const client = this.deps.registry.getProtocol(request);
      if (!client) throw new Error(`无可用协议客户端处理 ${request.url}`);
      const response = await client.execute(request, this.deps.timeouts);
      await this.deps.bus.emit("afterResponse", { status: response.status, timeMs: response.timeMs });

      const postCtx = this.buildContext(resolver, env, request, response, pmAsserts);
      if (tc.postScript) engine.run(tc.postScript, postCtx);
    } catch (e) {
      error = (e as Error).message;
    }

    const assertions = [...this.evaluateAssertions(api, tc, ctx), ...pmAsserts];
    const passed = error === undefined && assertions.every((a) => a.pass);
    const outcome: CaseOutcome = {
      apiId: api.id, apiName: api.name, caseId: tc.id, caseName: tc.name,
      row: isDataDriven ? rowIndex : undefined,
      passed, durationMs: performance.now() - started,
      assertions, error,
    };
    await this.deps.bus.emit("afterCase", { apiName: api.name, caseName: tc.name, passed });
    return outcome;
  }

  private evaluateAssertions(api: ApiDefinition, tc: TestCase, ctx: { pm: PmApi }) {
    const response = ctx.pm.response;
    const registry = this.deps.registry;
    return tc.assertions.map((a) => {
      const op = registry.getAssert(a.op);
      if (!op) return { pass: false, message: `未知断言操作符: ${a.op}` };
      let actual: unknown;
      switch (a.target) {
        case "status": actual = response?.status; break;
        case "header": actual = response?.headers[(a.headerName ?? "").toLowerCase()]; break;
        case "responseTime": actual = response?.time; break;
        case "bodyJson": {
          try {
            const { JSONPath } = require("jsonpath-plus") as { JSONPath: (o: { path: string; json: unknown }) => unknown[] };
            actual = JSONPath({ path: a.path ?? "$", json: response?.json() })[0];
          } catch {
            actual = undefined;
          }
          break;
        }
      }
      return op.evaluate(actual, a.expected);
    });
  }

  private buildContext(
    resolver: VariableResolver, env: Environment | undefined,
    request?: { method: string; url: string; headers: Record<string, string>; query: unknown[]; body?: unknown },
    response?: { status: number; headers: Record<string, string>; bodyText: string; timeMs: number },
    pmAsserts?: Array<{ pass: boolean; message: string }>,
  ): { pm: PmApi } {
    let cachedJson: unknown;
    const pm: PmApi = {
      variables: { get: (n) => resolver.get(n), set: (n, v) => resolver.setRuntime(n, v) },
      environment: { get: (n) => env?.variables[n] },
      request: (request ?? { method: "GET", url: "", headers: {}, query: [] }) as PmApi["request"],
      response: response
        ? {
            status: response.status,
            headers: response.headers,
            time: response.timeMs,
            text: () => response.bodyText,
            json: () => (cachedJson ??= JSON.parse(response.bodyText)),
          }
        : undefined,
      assert: (condition, message) => {
        pmAsserts?.push({ pass: Boolean(condition), message });
      },
    };
    return { pm };
  }
}
```

实现说明：`evaluateAssertions` 内的 `require` 在 ESM 下不可用——实现时改用顶层静态导入 `import { JSONPath } from "jsonpath-plus";`，此处在计划里显式更正为静态导入。依赖安装：`pnpm -C packages/core add csv-parse jsonpath-plus`。

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/runner/runner.test.ts`
预期：PASS（7 个用例）

- [ ] **步骤 5：全量回归**

运行：`pnpm -C packages/core vitest run`
预期：全部 PASS

- [ ] **步骤 6：Commit**

```bash
git add packages/core/src/runner packages/core/tests/runner packages/core/package.json
git commit -m "feat(core): 集合运行器——数据驱动、脚本钩子、fail-fast、runs 落盘"
```

---

### 任务 12：报告插件（HTML / JUnit）

**文件：**
- 创建：`packages/core/src/report/html.ts`
- 创建：`packages/core/src/report/junit.ts`
- 测试：`packages/core/tests/report/reporters.test.ts`

- [ ] **步骤 1：编写失败的测试（含契约测试）**

`packages/core/tests/report/reporters.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { htmlReporter } from "../../src/report/html.js";
import { junitReporter } from "../../src/report/junit.js";
import type { RunResult } from "../../src/report/types.js";
import { itCompliesWithReporterContract } from "../contracts/reporter.contract.js";

const sample: RunResult = {
  collectionId: "c1", collectionName: "order-api", envName: "dev",
  startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  total: 2, passed: 1, failed: 1,
  cases: [
    { apiId: "a1", apiName: "get-ok", caseId: "t1", caseName: "ok", passed: true, durationMs: 12, assertions: [{ pass: true, message: "eq 通过" }] },
    { apiId: "a1", apiName: "get-ok", caseId: "t2", caseName: "bad", passed: false, durationMs: 30, assertions: [{ pass: false, message: "eq 失败" }], error: "请求失败（timeout）" },
  ],
};

describe("htmlReporter", () => {
  itCompliesWithReporterContract(htmlReporter, sample);

  it("包含汇总与用例明细", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-html-"));
    const file = await htmlReporter.render(sample, outDir);
    const html = readFileSync(file, "utf8");
    expect(html).toContain("order-api");
    expect(html).toContain("bad");
    expect(html).toContain("eq 失败");
  });
});

describe("junitReporter", () => {
  itCompliesWithReporterContract(junitReporter, sample);

  it("产出合法 testsuites 结构，失败用例含 failure 节点", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "apicc-junit-"));
    const file = await junitReporter.render(sample, outDir);
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain("<testsuites");
    expect(xml).toContain('failures="1"');
    expect(xml).toContain("<failure");
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/report/reporters.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现两个渲染器**

`packages/core/src/report/html.ts`：

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const htmlReporter: Reporter = {
  format: "html",
  async render(result: RunResult, outDir: string) {
    const rows = result.cases.map((c) => `
      <tr class="${c.passed ? "pass" : "fail"}">
        <td>${escapeHtml(c.apiName)}</td><td>${escapeHtml(c.caseName)}</td>
        <td>${c.row !== undefined ? c.row : "-"}</td><td>${c.passed ? "通过" : "失败"}</td>
        <td>${c.durationMs.toFixed(1)}</td>
        <td>${c.error ? escapeHtml(c.error) : c.assertions.filter((a) => !a.pass).map((a) => escapeHtml(a.message)).join("; ") || "-"}</td>
      </tr>`).join("\n");
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>apicc 报告 - ${escapeHtml(result.collectionName)}</title>
<style>body{font-family:sans-serif;margin:2rem}.pass{color:#0a7}.fail{color:#c33;background:#fee}</style></head>
<body><h1>${escapeHtml(result.collectionName)}${result.envName ? `（${escapeHtml(result.envName)}）` : ""}</h1>
<p>总计 ${result.total} · 通过 ${result.passed} · 失败 ${result.failed}</p>
<table border="1" cellpadding="4"><tr><th>接口</th><th>用例</th><th>数据行</th><th>结果</th><th>耗时ms</th><th>详情</th></tr>${rows}</table>
</body></html>`;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `report-${Date.now()}.html`);
    writeFileSync(file, html);
    return file;
  },
};
```

`packages/core/src/report/junit.ts`：

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reporter } from "../plugin/types.js";
import type { RunResult } from "./types.js";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const junitReporter: Reporter = {
  format: "junit",
  async render(result: RunResult, outDir: string) {
    const cases = result.cases.map((c) => `  <testcase name="${escapeXml(`${c.apiName}.${c.caseName}${c.row !== undefined ? `#${c.row}` : ""}`)}" classname="${escapeXml(result.collectionName)}" time="${(c.durationMs / 1000).toFixed(3)}">
    ${c.passed ? "" : `<failure message="${escapeXml(c.error ?? c.assertions.find((a) => !a.pass)?.message ?? "断言失败")}"/>`}
  </testcase>`).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="${result.total}" failures="${result.failed}">
  <testsuite name="${escapeXml(result.collectionName)}" tests="${result.total}" failures="${result.failed}">
${cases}
  </testsuite>
</testsuites>`;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `junit-${Date.now()}.xml`);
    writeFileSync(file, xml);
    return file;
  },
};
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/report/reporters.test.ts`
预期：PASS（4 个用例）

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/report packages/core/tests/report
git commit -m "feat(core): HTML 与 JUnit 报告渲染插件"
```

---

### 任务 13：导入器（Collection v2.1 与 OpenAPI 2.0/3.0）

**文件：**
- 创建：`packages/core/src/import/collection21.ts`
- 创建：`packages/core/src/import/openapi.ts`
- 测试：`packages/core/tests/import/collection21.test.ts`、`packages/core/tests/import/openapi.test.ts`

- [ ] **步骤 1：编写失败的 Collection v2.1 测试**

`packages/core/tests/import/collection21.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { collectionV21Importer } from "../../src/import/collection21.js";

const sample = JSON.stringify({
  info: { name: "order-api", schema: "v2.1.0" },
  item: [
    {
      name: "订单",
      item: [
        {
          name: "create",
          request: {
            method: "POST",
            url: { raw: "{{baseUrl}}/orders" },
            header: [{ key: "Content-Type", value: "application/json" }],
            body: { mode: "raw", raw: '{"sku":"A1"}' },
          },
        },
      ],
    },
    {
      name: "get",
      request: {
        method: "GET",
        url: { raw: "{{baseUrl}}/orders/1?a=1", query: [{ key: "a", value: "1", disabled: false }] },
      },
    },
  ],
});

describe("collectionV21Importer", () => {
  it("detect 识别 v2.1 JSON", () => {
    expect(collectionV21Importer.detect("c.json", sample)).toBe(true);
    expect(collectionV21Importer.detect("c.json", '{"openapi":"3.0.0"}')).toBe(false);
  });

  it("parse 映射文件夹/接口/请求体/查询参数", () => {
    const { project, warnings } = collectionV21Importer.parse(sample);
    const col = project.collections[0]!;
    expect(col.name).toBe("order-api");
    expect(col.folders[0]!.name).toBe("订单");
    expect(col.folders[0]!.apis[0]!.method).toBe("POST");
    expect(col.folders[0]!.apis[0]!.body?.content).toBe('{"sku":"A1"}');
    const flat = col.apis[0]!;
    expect(flat.query).toEqual([{ key: "a", value: "1", enabled: true }]);
    expect(flat.cases[0]!.name).toContain("get");
  });

  it("脚本事件跳过并产生 warning", () => {
    const withEvents = JSON.stringify({
      info: { name: "x", schema: "v2.1.0" },
      item: [{ name: "e", request: { method: "GET", url: { raw: "http://x/" } }, event: [{ listen: "test", script: { exec: [] } }] }],
    });
    const { warnings } = collectionV21Importer.parse(withEvents);
    expect(warnings.some((w) => w.includes("脚本"))).toBe(true);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/import/collection21.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现 Collection v2.1 导入器**

`packages/core/src/import/collection21.ts`：

```ts
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { ApiDefinition, Collection, Folder, Project } from "../domain/model.js";
import type { Importer, ImportedProject } from "../plugin/types.js";

interface V21Item {
  name: string;
  item?: V21Item[];
  request?: {
    method: string;
    url: { raw: string; query?: Array<{ key: string; value?: string; disabled?: boolean }> } | string;
    header?: Array<{ key: string; value?: string; disabled?: boolean }>;
    body?: { mode: string; raw?: string; urlencoded?: Array<{ key: string; value?: string }> };
    description?: string;
  };
  event?: unknown[];
  response?: unknown[];
}

function newId(): string {
  return randomUUID();
}

function toApi(item: V21Item): ApiDefinition | null {
  const req = item.request;
  if (!req) return null;
  const rawUrl = typeof req.url === "string" ? req.url : req.url.raw;
  const query = typeof req.url === "string" ? [] : (req.url.query ?? []).map((q) => ({
    key: q.key, value: q.value ?? "", enabled: !q.disabled,
  }));
  const headers = (req.header ?? []).map((h) => ({ key: h.key, value: h.value ?? "", enabled: !h.disabled }));
  let body: ApiDefinition["body"];
  if (req.body?.mode === "raw") {
    const isJson = req.body.raw?.trimStart().startsWith("{") || req.body.raw?.trimStart().startsWith("[");
    body = { kind: isJson ? "json" : "raw", content: req.body.raw ?? "" };
  } else if (req.body?.mode === "urlencoded" || req.body?.mode === "formdata") {
    body = { kind: "form", content: "", form: (req.body.urlencoded ?? []).map((kv) => ({ key: kv.key, value: kv.value ?? "", enabled: true })) };
  }
  return {
    id: newId(), name: item.name, version: "1.0.0", deprecated: false,
    method: (req.method ?? "GET").toUpperCase() as ApiDefinition["method"],
    url: rawUrl, headers, query, body,
    cases: [{ id: newId(), name: `${item.name}-smoke`, scope: "base", parameters: {}, assertions: [] }],
  };
}

function walk(items: V21Item[], collection: Collection, warnings: string[]): void {
  for (const item of items) {
    if (item.item) {
      const folder: Folder = { id: newId(), name: item.name, apis: [] };
      for (const child of item.item) {
        const api = toApi(child);
        if (api) folder.apis.push(api);
      }
      collection.folders.push(folder);
    } else {
      const api = toApi(item);
      if (api) collection.apis.push(api);
    }
    if (item.event?.length) warnings.push(`接口「${item.name}」携带脚本事件，已跳过（可手动补写前置/后置脚本）`);
    if (item.response?.length) warnings.push(`接口「${item.name}」携带响应示例，已跳过`);
  }
}

export const collectionV21Importer: Importer = {
  name: "collection-v21",
  detect(_fileName, content) {
    try {
      const doc = parseYaml(content) as { info?: { schema?: string } };
      return typeof doc?.info?.schema === "string" && doc.info.schema.startsWith("v2.");
    } catch {
      return false;
    }
  },
  parse(content): ImportedProject {
    const doc = parseYaml(content) as { info: { name: string }; item: V21Item[] };
    const warnings: string[] = [];
    const collection: Collection = { id: newId(), name: doc.info.name, variables: {}, folders: [], apis: [] };
    walk(doc.item ?? [], collection, warnings);
    const project: Project = { id: newId(), name: doc.info.name, variables: {}, environments: [], collections: [collection] };
    return { project, warnings };
  },
};
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/import/collection21.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 5：编写失败的 OpenAPI 测试**

`packages/core/tests/import/openapi.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { openapiImporter } from "../../src/import/openapi.js";

const v3 = `
openapi: 3.0.3
info: { title: 订单服务, version: 1.0.0 }
servers: [{ url: https://api.example.com/v1 }]
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        content:
          application/json:
            schema: { type: object, required: [sku] }
      responses: { "200": { description: ok } }
  /orders/{id}:
    get:
      summary: 查询订单
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok } }
`;

const v2 = `
swagger: "2.0"
info: { title: 旧服务, version: 2.0.0 }
host: api.example.com
basePath: /v2
paths:
  /ping:
    get: { responses: { "200": { description: ok } } }
`;

describe("openapiImporter", () => {
  it("detect 识别 3.0 与 2.0 文档", () => {
    expect(openapiImporter.detect("a.yaml", v3)).toBe(true);
    expect(openapiImporter.detect("a.yaml", v2)).toBe(true);
    expect(openapiImporter.detect("a.yaml", "info: x")).toBe(false);
  });

  it("3.0：servers 映射为 imported 环境的 baseUrl，路径映射为接口", () => {
    const { project, warnings } = openapiImporter.parse(v3);
    expect(project.environments[0]!.variables.baseUrl).toBe("https://api.example.com/v1");
    const col = project.collections[0]!;
    expect(col.apis).toHaveLength(2);
    const create = col.apis.find((a) => a.name === "createOrder")!;
    expect(create.method).toBe("POST");
    expect(create.url).toBe("{{baseUrl}}/orders");
    expect(create.body?.kind).toBe("json");
    expect(create.design).toContain("type: object");
    const get = col.apis.find((a) => a.name === "查询订单")!;
    expect(get.query[0]!.key).toBe("id");
    expect(warnings).toEqual([]);
  });

  it("2.0：host+basePath 组合 baseUrl", () => {
    const { project } = openapiImporter.parse(v2);
    expect(project.environments[0]!.variables.baseUrl).toBe("https://api.example.com/v2");
    expect(project.collections[0]!.apis[0]!.url).toBe("{{baseUrl}}/ping");
  });
});
```

- [ ] **步骤 6：运行验证失败后实现**

运行：`pnpm -C packages/core vitest run tests/import/openapi.test.ts` → FAIL 后创建

`packages/core/src/import/openapi.ts`：

```ts
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { ApiDefinition, Project } from "../domain/model.js";
import type { Importer, ImportedProject } from "../plugin/types.js";

type AnyDoc = Record<string, unknown>;

export const openapiImporter: Importer = {
  name: "openapi",
  detect(_fileName, content) {
    try {
      const doc = parseYaml(content) as AnyDoc;
      return typeof doc?.openapi === "string" || doc?.swagger === "2.0";
    } catch {
      return false;
    }
  },
  parse(content): ImportedProject {
    const doc = parseYaml(content) as AnyDoc;
    const isV3 = typeof doc.openapi === "string";
    const warnings: string[] = [];
    const info = doc.info as { title: string };

    let baseUrl: string;
    if (isV3) {
      const servers = (doc.servers ?? []) as Array<{ url: string }>;
      baseUrl = servers[0]?.url ?? "{{baseUrl}}";
      if (!servers[0]) warnings.push("未声明 servers，baseUrl 需要手动补齐");
    } else {
      const scheme = ((doc.schemes ?? ["https"]) as string[])[0];
      baseUrl = `${scheme}://${doc.host as string}${doc.basePath as string ?? ""}`;
    }

    const apis: ApiDefinition[] = [];
    const paths = (doc.paths ?? {}) as Record<string, Record<string, AnyDoc>>;
    const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(pathItem)) {
        if (!httpMethods.has(method)) continue;
        const operation = op as {
          operationId?: string; summary?: string;
          parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>;
          requestBody?: { content?: Record<string, { schema?: unknown }> };
          responses?: Record<string, unknown>;
        };
        const queryParams = (operation.parameters ?? []).filter((p) => p.in === "query" || p.in === "path");
        const jsonSchema = operation.requestBody?.content?.["application/json"]?.schema;
        if (operation.responses && !operation.responses["200"] && !operation.responses["201"]) {
          warnings.push(`接口 ${method.toUpperCase()} ${path} 无 2xx 响应定义`);
        }
        apis.push({
          id: randomUUID(),
          name: operation.operationId ?? operation.summary ?? `${method.toUpperCase()} ${path}`,
          version: String((doc.info as AnyDoc).version ?? "1.0.0"),
          deprecated: false,
          method: method.toUpperCase() as ApiDefinition["method"],
          url: `{{baseUrl}}${path}`,
          headers: [],
          query: queryParams.filter((p) => p.in === "query").map((p) => ({ key: p.name, value: "", enabled: true })),
          body: jsonSchema ? { kind: "json", content: JSON.stringify(jsonSchema, null, 2) } : undefined,
          design: jsonSchema || operation.description
            ? `# 接口设计\n\n${operation.description ?? ""}\n\n## 请求体 schema\n\n\`\`\`json\n${jsonSchema ? JSON.stringify(jsonSchema, null, 2) : "无"}\n\`\`\`\n`
            : undefined,
          cases: [{ id: randomUUID(), name: `${operation.operationId ?? path}-smoke`, scope: "base", parameters: {}, assertions: [] }],
        });
        void queryParams.filter((p) => p.in === "path");
      }
    }

    const project: Project = {
      id: randomUUID(), name: info.title, variables: {},
      environments: [{ id: randomUUID(), name: "imported", variables: { baseUrl } }],
      collections: [{ id: randomUUID(), name: info.title, variables: {}, folders: [], apis }],
    };
    return { project, warnings };
  },
};
```

再次运行：`pnpm -C packages/core vitest run tests/import/openapi.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 7：Commit**

```bash
git add packages/core/src/import packages/core/tests/import
git commit -m "feat(core): Collection v2.1 与 OpenAPI 2.0/3.0 导入插件"
```

---

### 任务 14：设计导出、公共出口与 CLI

**文件：**
- 创建：`packages/core/src/design/export.ts`
- 修改：`packages/core/src/index.ts`（公共出口 + 内置插件一键注册）
- 创建：`packages/cli/package.json`、`packages/cli/src/main.ts`、`packages/cli/src/bin.ts`
- 测试：`packages/core/tests/design/export.test.ts`、`packages/cli/tests/e2e.test.ts`

- [ ] **步骤 1：编写失败的设计导出测试**

`packages/core/tests/design/export.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { renderDesignMarkdown } from "../../src/design/export.js";
import type { ApiDefinition } from "../../src/domain/model.js";

const api: ApiDefinition = {
  id: "a1", name: "create-order", version: "1.2.0", deprecated: false,
  method: "POST", url: "{{baseUrl}}/orders",
  headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
  query: [],
  body: { kind: "json", content: '{"type":"object","required":["sku"]}' },
  design: "# 业务规则\n- 库存不足时返回 409",
  cases: [
    { id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] },
    { id: "t2", name: "conflict", scope: "sit", parameters: {}, assertions: [] },
  ],
};

describe("renderDesignMarkdown", () => {
  it("输出定义、schema、详细设计与用例清单", () => {
    const md = renderDesignMarkdown(api);
    expect(md).toContain("POST {{baseUrl}}/orders");
    expect(md).toContain("1.2.0");
    expect(md).toContain('"required":["sku"]');
    expect(md).toContain("库存不足时返回 409");
    expect(md).toContain("ok");
    expect(md).toContain("conflict");
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`pnpm -C packages/core vitest run tests/design/export.test.ts`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现设计导出**

`packages/core/src/design/export.ts`：

```ts
import type { ApiDefinition } from "../domain/model.js";

/** 渲染 agent 可消费的接口详细设计 Markdown（规格 §7.5）。 */
export function renderDesignMarkdown(api: ApiDefinition): string {
  const schemaBlock = api.body?.kind === "json" ? `\n\`\`\`json\n${api.body.content}\n\`\`\`\n` : "";
  const caseRows = api.cases
    .map((c) => `| ${c.name} | ${c.scope} | ${c.assertions.length} 条断言 |`)
    .join("\n");
  return `# 接口详细设计：${api.name}

## 定义

- 方法：**${api.method}**
- URL：\`${api.url}\`
- 版本：${api.version}${api.deprecated ? "（已废弃）" : ""}
- 请求头：${api.headers.map((h) => `${h.key}: ${h.value}`).join("；") || "无"}

## 请求体

${schemaBlock || "无"}

## 详细设计

${api.design ?? "（未编写，可补充业务规则、校验约定、错误码）"}

## 测试用例

| 用例 | 适用环境 | 断言 |
|------|----------|------|
${caseRows}
`;
}
```

- [ ] **步骤 4：运行验证通过**

运行：`pnpm -C packages/core vitest run tests/design/export.test.ts`
预期：PASS（1 个用例）

- [ ] **步骤 5：编写 core 公共出口与内置插件注册**

`packages/core/src/index.ts` 整体替换为：

```ts
export { version } from "./version.js";
export * from "./domain/model.js";
export { envChain } from "./domain/envChain.js";
export { createEventBus } from "./events/bus.js";
export type { RunEventMap } from "./events/bus.js";
export * from "./plugin/types.js";
export { createPluginRegistry, type PluginRegistry } from "./plugin/registry.js";
export { fileStorage } from "./storage/fileStorage.js";
export { SqliteIndex } from "./storage/sqliteIndex.js";
export { createVariableResolver, CyclicVariableError } from "./variables/resolver.js";
export { CollectionRunner } from "./runner/runner.js";
export { renderDesignMarkdown } from "./design/export.js";
export { htmlReporter } from "./report/html.js";
export { junitReporter } from "./report/junit.js";
export { collectionV21Importer } from "./import/collection21.js";
export { openapiImporter } from "./import/openapi.js";

import { createPluginRegistry, type PluginRegistry } from "./plugin/registry.js";
import { fileStorage } from "./storage/fileStorage.js";
import { httpClient } from "./http/client.js";
import { builtinAuthProviders } from "./http/auth.js";
import { builtinAssertOperators } from "./assert/operators.js";
import { jsScriptEngine } from "./sandbox/jsEngine.js";
import { htmlReporter } from "./report/html.js";
import { junitReporter } from "./report/junit.js";
import { collectionV21Importer } from "./import/collection21.js";
import { openapiImporter } from "./import/openapi.js";

/** 创建注册了全部内置插件的注册中心（内置功能即普通插件，规格 §4）。 */
export function createDefaultRegistry(): PluginRegistry {
  const registry = createPluginRegistry();
  registry.registerStorage(fileStorage);
  registry.registerProtocol(httpClient);
  for (const p of builtinAuthProviders) registry.registerAuth(p);
  for (const o of builtinAssertOperators) registry.registerAssert(o);
  registry.registerScriptEngine(jsScriptEngine);
  registry.registerReporter(htmlReporter);
  registry.registerReporter(junitReporter);
  registry.registerImporter(collectionV21Importer);
  registry.registerImporter(openapiImporter);
  return registry;
}
```

`packages/core/src/version.ts`：

```ts
export const version = "0.1.0";
```

补充冒烟测试 `packages/core/tests/smoke.test.ts` 追加：

```ts
import { createDefaultRegistry } from "../src/index.js";

it("默认注册中心已装配全部内置插件", () => {
  const reg = createDefaultRegistry();
  expect(reg.getStorage()).toBeDefined();
  expect(reg.getScriptEngine("javascript")).toBeDefined();
  expect(reg.getReporter("html")).toBeDefined();
  expect(reg.getReporter("junit")).toBeDefined();
  expect(reg.listImporters()).toHaveLength(2);
  expect(reg.listAsserts().length).toBeGreaterThanOrEqual(7);
});
```

- [ ] **步骤 6：运行 core 全量回归**

运行：`pnpm -C packages/core vitest run --coverage`
预期：全部 PASS 且覆盖率 ≥ 门槛（lines 85%）

- [ ] **步骤 7：编写失败的 CLI e2e 测试**

`packages/cli/package.json`：

```json
{
  "name": "@apicc/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "apicc": "./src/bin.ts" },
  "engines": { "node": ">=20" },
  "scripts": { "test": "vitest run" }
}
```

`packages/cli/src/bin.ts`：

```ts
#!/usr/bin/env node
import { runCli } from "./main.js";

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
```

`packages/cli/tests/e2e.test.ts`：

```ts
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, fileStorage } from "@apicc/core";
import type { Workspace } from "@apicc/core";
import { runCli } from "../src/main.js";

let server: Server;
let baseUrl = "";
let root: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  root = mkdtempSync(join(tmpdir(), "apicc-e2e-"));
  const ws: Workspace = {
    id: "w1", name: "e2e", variables: {},
    groups: [{
      id: "g1", name: "demo", projects: [{
        id: "p1", name: "svc", variables: {},
        environments: [{ id: "e1", name: "dev", variables: { baseUrl } }],
        collections: [{
          id: "c1", name: "api", variables: {}, folders: [],
          apis: [
            {
              id: "a1", name: "ok", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/x", headers: [], query: [],
              design: "# 设计",
              cases: [{ id: "t1", name: "passes", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "200" }] }],
            },
            {
              id: "a2", name: "bad", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/x", headers: [], query: [],
              cases: [{ id: "t2", name: "fails", scope: "base", parameters: {}, assertions: [{ id: "as", target: "status", op: "eq", expected: "500" }] }],
            },
          ],
        }],
      }],
    }],
  };
  await fileStorage.save(root, ws);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("CLI 端到端", () => {
  it("validate 正常工作区退出码 0", async () => {
    const code = await runCli(["validate", root], createDefaultRegistry());
    expect(code).toBe(0);
  });

  it("run 执行集合并产出报告，失败用例使退出码为 1", async () => {
    const runsDir = join(root, "runs");
    const code = await runCli(
      ["run", "groups/demo/projects/svc/collections/api", "--env", "dev", "--reporters", "html,junit", "--runs-dir", runsDir],
      createDefaultRegistry(),
    );
    expect(code).toBe(1);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(runsDir).some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("export-design 输出 Markdown 到 stdout", async () => {
    const logs: string[] = [];
    const code = await runCli(
      ["export-design", "groups/demo/projects/svc/collections/api/apis/ok"],
      createDefaultRegistry(),
      (line) => logs.push(line),
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("# 设计");
  });
});
```

- [ ] **步骤 8：运行验证失败**

运行：`pnpm -C packages/cli add -D vitest && pnpm install && pnpm -C packages/cli vitest run tests/e2e.test.ts`
预期：FAIL，`main.ts` 不存在

- [ ] **步骤 9：安装 CLI 依赖并实现 main.ts**

运行：`pnpm -C packages/cli add commander @apicc/core@workspace:*`

`packages/cli/src/main.ts`：

```ts
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { PluginRegistry } from "@apicc/core";

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
      const { workspace } = await storage!.load(root);
      let collectionDir: string | undefined;
      let collection: import("@apicc/core").Collection | undefined;
      let project: import("@apicc/core").Project | undefined;
      for (const g of workspace.groups) {
        for (const p of g.projects) {
          for (const c of p.collections) {
            const dir = join(root, "groups", g.name, "projects", p.name, "collections", c.name);
            if (dir.endsWith(collectionPath) || relative(dir, join(root, collectionPath)) === "") {
              collection = c; project = p; collectionDir = dir;
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
        const outDir = join(collectionDir, "runs");
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
      const file = join(root, apiPath, "api.yaml");
      const { parse: parseYaml } = await import("yaml");
      const { ApiDefinitionSchema, renderDesignMarkdown } = await import("@apicc/core");
      const api = ApiDefinitionSchema.parse(parseYaml(readFileSync(file, "utf8")));
      log(renderDesignMarkdown(api));
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (!(e as { handled?: boolean }).handled) throw e;
  }
  return process.exitCode ?? 0;
}
```

- [ ] **步骤 10：运行验证通过**

运行：`pnpm -C packages/cli vitest run tests/e2e.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 11：全仓回归与覆盖率门槛**

运行：`pnpm -r vitest run --coverage`（core 侧含覆盖率门槛）
预期：全部 PASS

- [ ] **步骤 12：Commit**

```bash
git add packages/core packages/cli
git commit -m "feat(cli): 设计导出、公共出口与 apicc validate/run/export-design 命令及端到端测试"
```

---

## 规格覆盖对照（计划 1 ↔ 规格 §3.1）

| 规格条目 | 任务 |
|----------|------|
| 工作区（文本 + Git 优先，SQLite 可重建索引） | 6、7 |
| 组织结构五级 | 2、6 |
| 环境派生 / 用例环境覆盖 | 2（envChain）、11（scope 过滤） |
| 变量体系 + 动态变量 + 循环检测 | 5、11 |
| REST 调试（headless 侧：请求构造与发送） | 10 |
| 请求认证 bearer/basic/apikey + AuthProvider 扩展点 | 4、10 |
| 测试用例与断言 | 2、9、11 |
| 前置/后置脚本（JS 沙箱） | 8、11 |
| 数据驱动遍历 | 11 |
| 集合顺序运行 + 运行历史落盘 | 11 |
| 测试报告 HTML/JUnit | 12 |
| 接口详细设计 + agent 导出 | 14 |
| 导入 Collection v2.1 / OpenAPI 2.0、3.0 | 13 |
| 插件底座 7 扩展点 + 事件总线 + 契约测试 | 3、4 |
| CLI（validate/run/export-design；import 见注） | 14 |

**注 1：** CLI `import` 命令（文件导入 → 预览 → 写入）属于交互确认流程，其 headless 部分已由导入器（任务 13）覆盖；带预览确认的 `apicc import` 命令归入计划 2 与 UI 一并交付（预览交互是 UI 需求）。
**注 2：** 调试 UI、i18n、Mock 预留字段消费、接口版本审批流：计划 2 或后续里程碑（规格 §3.2、§12）。

## 自检结果

1. **规格覆盖度**：§3.1 全部条目已映射（见上表）；§3.2 排除项未混入。规格 §12 的「pm.* API 完整面向」在任务 8/11 落地为 `variables/environment/request/response/assert` 五组。
2. **占位符扫描**：无「待定/TODO/后续实现」；所有代码步骤含真实代码；任务 9 步骤 3 与任务 11 步骤 3 中的两处「实现说明」是对计划文本自身错误的显式更正指令（删除无用参数、require 改静态导入），不是占位符。
3. **类型一致性**：`ExecutableRequest`/`ExecutionResponse`/`RunResult`/`CaseOutcome`/`PmApi` 在任务 4 定义、8/10/11/12/14 消费，签名一致；`fileStorage` 在任务 6 定义、14 注册；`envChain` 在任务 2 定义、11 消费。

## 执行注意事项

- 遵循品牌中立约束：任何新文件（含注释与测试数据）不得出现参考/竞品项目名
- 每个任务结束必须全量回归 `pnpm -C packages/core vitest run` 后再 commit
- Node ≥ 22；Windows 环境路径统一使用 `node:path` API，不手拼分隔符
