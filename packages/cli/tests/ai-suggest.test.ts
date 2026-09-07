import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultRegistry, fileStorage, TestCaseSchema } from "@apicc/core";
import type { Workspace } from "@apicc/core";
import { parse as parseYaml } from "yaml";
import { resolveAiConfig, runCli } from "../src/main.js";

let server: Server;
let serverBase = "";
let root = "";
let emptyHome = "";
let fileHome = "";
let prevCwd = "";

/** 替身 OpenAI 兼容端点：记录请求（验 Bearer/模型），按 replyContent 返回 choices[0].message.content。 */
const capturedRequests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
let replyContent = "";

const API_KEY = "sk-e2e-secret-MUST-NOT-LEAK";
const envTrio = {
  APICC_AI_BASE_URL: "", // beforeAll 里填 serverBase + /v1
  APICC_AI_API_KEY: API_KEY,
  APICC_AI_MODEL: "test-model",
};
const apiPath = "groups/demo/projects/svc/collections/api/apis/orders";

const suggestionCases = [
  {
    name: "qty 为 0 应被拒绝",
    scope: "base",
    parameters: { qty: "0" },
    assertions: [{ target: "status", op: "eq", expected: "400" }], // 无 id——core 顺修②本地回填
  },
  { name: "缺 sku 应 400", scope: "base", parameters: {}, assertions: [] },
  { name: "qty 为负数应 400", scope: "base", parameters: {}, assertions: [] },
];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      capturedRequests.push({ url: req.url ?? "", authorization: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: replyContent } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  serverBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  envTrio.APICC_AI_BASE_URL = `${serverBase}/v1`;

  // 工作区夹具（fileStorage 落盘）：含 design 与既有用例的 POST 接口
  root = mkdtempSync(join(tmpdir(), "apicc-ai-e2e-"));
  const ws: Workspace = {
    id: "00000000-0000-4000-8000-000000000001", name: "ai-e2e", variables: {},
    groups: [{
      id: "00000000-0000-4000-8000-000000000002", name: "demo", projects: [{
        id: "00000000-0000-4000-8000-000000000004", name: "svc", variables: {}, workflows: [],
        environments: [],
        collections: [{
          id: "00000000-0000-4000-8000-000000000008", name: "api", variables: {}, folders: [],
          apis: [{
            id: "00000000-0000-4000-8000-000000000011", name: "orders", version: "1.0.0", deprecated: false, method: "POST",
            url: "https://api.example.com/orders",
            headers: [{ key: "content-type", value: "application/json", enabled: true }],
            query: [],
            body: { kind: "json", content: '{"sku":"A1","qty":1}' },
            design: "# 创建订单\n- qty 必须为正整数",
            cases: [{ id: "00000000-0000-4000-8000-000000000015", name: "正常创建订单", scope: "base", parameters: {}, assertions: [] }],
          }],
        }],
      }],
    }],
  };
  await fileStorage.save(root, ws);
  // CLI 按「从 cwd 向上查找 apicc.workspace.yaml」定位工作区（与 e2e.test.ts 同款模拟）。
  prevCwd = process.cwd();
  process.chdir(root);

  // 空 home（无任何 AI 配置）
  emptyHome = mkdtempSync(join(tmpdir(), "apicc-ai-home-empty-"));
  // 带 ~/.apicc/ai.json 的 home
  fileHome = mkdtempSync(join(tmpdir(), "apicc-ai-home-file-"));
  mkdirSync(join(fileHome, ".apicc"), { recursive: true });
  writeFileSync(join(fileHome, ".apicc", "ai.json"), JSON.stringify({
    baseUrl: `${serverBase}/v1`, apiKey: API_KEY, model: "test-model",
  }));
});

afterAll(() => {
  process.chdir(prevCwd);
  return new Promise<void>((r) => server.close(() => r()));
});

const run = (argv: string[], logs: string[], deps: Parameters<typeof runCli>[3] = {}) =>
  runCli(argv, createDefaultRegistry(), (l) => logs.push(l), deps);

describe("AI 配置解析（裁定⑤：env 三件套优先 → ~/.apicc/ai.json）", () => {
  it("env 三件套齐全时优先于用户级文件", () => {
    const cfg = resolveAiConfig({ env: envTrio, homeDir: fileHome });
    expect(cfg.baseUrl).toBe(`${serverBase}/v1`);
    expect(cfg.apiKey).toBe(API_KEY);
    expect(cfg.model).toBe("test-model");
  });

  it("env 缺失回落 ~/.apicc/ai.json", () => {
    const cfg = resolveAiConfig({ env: {}, homeDir: fileHome });
    expect(cfg.baseUrl).toBe(`${serverBase}/v1`);
    expect(cfg.apiKey).toBe(API_KEY);
    expect(cfg.model).toBe("test-model");
  });

  it("env 三件套不完整 → 视为未配置 env，回落文件", () => {
    const cfg = resolveAiConfig({ env: { APICC_AI_BASE_URL: envTrio.APICC_AI_BASE_URL }, homeDir: fileHome });
    expect(cfg.apiKey).toBe(API_KEY); // 来自文件而非残缺 env
  });

  it("env 三件套不完整且无文件 → 可读报错（而非静默忽略残缺 env）", () => {
    expect(() =>
      resolveAiConfig({ env: { APICC_AI_BASE_URL: envTrio.APICC_AI_BASE_URL }, homeDir: emptyHome }),
    ).toThrow(/不完整/);
  });

  it("两者皆缺 → 可读错误指引两种配置方式", () => {
    expect(() => resolveAiConfig({ env: {}, homeDir: emptyHome })).toThrow(/AI 配置/);
    expect(() => resolveAiConfig({ env: {}, homeDir: emptyHome })).toThrow(/APICC_AI_BASE_URL/);
    expect(() => resolveAiConfig({ env: {}, homeDir: emptyHome })).toThrow(/ai\.json/);
  });

  it("文件字段不完整 → 可读错误", () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-ai-home-bad-"));
    mkdirSync(join(home, ".apicc"), { recursive: true });
    writeFileSync(join(home, ".apicc", "ai.json"), JSON.stringify({ baseUrl: "https://x", apiKey: "k" }));
    expect(() => resolveAiConfig({ env: {}, homeDir: home })).toThrow(/不完整/);
  });

  it("文件不是合法 JSON → 可读错误", () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-ai-home-broken-"));
    mkdirSync(join(home, ".apicc"), { recursive: true });
    writeFileSync(join(home, ".apicc", "ai.json"), "{oops");
    expect(() => resolveAiConfig({ env: {}, homeDir: home })).toThrow(/不是合法 JSON/);
  });
});

describe("ai suggest-cases 端到端（替身 OpenAI 兼容端点，零真实网络）", () => {
  it("缺省打 stdout：YAML 候选用例经 TestCaseSchema 校验回读；Bearer 密钥到端点且不进日志", async () => {
    replyContent = JSON.stringify({ cases: suggestionCases });
    const logs: string[] = [];
    const code = await run(["ai", "suggest-cases", apiPath, "--instruction", "补充边界用例"], logs, {
      aiEnv: envTrio, aiHomeDir: emptyHome,
    });
    expect(code).toBe(0);

    // 端点收到正确请求：chat completions 路径 + Bearer 密钥 + json_object + 摘要内容
    expect(capturedRequests.at(-1)?.url).toBe("/v1/chat/completions");
    expect(capturedRequests.at(-1)?.authorization).toBe(`Bearer ${API_KEY}`);
    const body = capturedRequests.at(-1)?.body as { response_format: { type: string }; messages: Array<{ content: string }> };
    expect(body.response_format).toEqual({ type: "json_object" });
    const userMsg = body.messages.find((m) => m.content.includes("orders"));
    expect(userMsg?.content).toContain("补充边界用例");
    expect(userMsg?.content).toContain("正常创建订单"); // 既有用例清单（避免重复）

    // stdout 末条为 YAML：解析回读并经 TestCaseSchema 严格校验
    const yamlText = logs.at(-1)!;
    const doc = parseYaml(yamlText) as { cases: unknown[] };
    expect(doc.cases).toHaveLength(suggestionCases.length);
    for (const c of doc.cases) expect(() => TestCaseSchema.parse(c)).not.toThrow();
    expect((doc.cases[0] as { name: string }).name).toBe("qty 为 0 应被拒绝");
    expect((doc.cases[0] as { assertions: Array<{ id: string }> }).assertions[0]!.id)
      .toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // core 顺修②：id 本地回填
    expect((doc.cases[0] as { id: string }).id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // 裁定⑦：密钥不出现在任何日志输出
    expect(logs.join("\n")).not.toContain(API_KEY);
  }, 20000);

  it("--limit 1 截断（替身返回 3 条，只输出 1 条）", async () => {
    replyContent = JSON.stringify({ cases: suggestionCases });
    const logs: string[] = [];
    const code = await run(["ai", "suggest-cases", apiPath, "--limit", "1"], logs, {
      aiEnv: envTrio, aiHomeDir: emptyHome,
    });
    expect(code).toBe(0);
    const doc = parseYaml(logs.at(-1)!) as { cases: unknown[] };
    expect(doc.cases).toHaveLength(1);
    expect((doc.cases[0] as { name: string }).name).toBe(suggestionCases[0]!.name);
  }, 20000);

  it("--out 写 YAML 文件且 stdout 不含 YAML 块；缺省（无 --out）打 stdout", async () => {
    replyContent = JSON.stringify({ cases: suggestionCases });
    const outFile = join(root, "ai-suggest-out.yaml");
    const logs: string[] = [];
    const code = await run(["ai", "suggest-cases", apiPath, "--out", outFile], logs, {
      aiEnv: envTrio, aiHomeDir: emptyHome,
    });
    expect(code).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    const doc = parseYaml(readFileSync(outFile, "utf8")) as { cases: unknown[] };
    for (const c of doc.cases) expect(() => TestCaseSchema.parse(c)).not.toThrow();
    expect(logs.join("\n")).not.toContain("cases:"); // YAML 只进文件
    expect(logs.join("\n")).toContain("ai-suggest-out.yaml"); // 摘要行含输出路径
    expect(logs.join("\n")).not.toContain(API_KEY);
  }, 20000);

  it("用户级文件配置（ai.json）走通命令全流程", async () => {
    replyContent = JSON.stringify({ cases: suggestionCases });
    const logs: string[] = [];
    const code = await run(["ai", "suggest-cases", apiPath], logs, { aiEnv: {}, aiHomeDir: fileHome });
    expect(code).toBe(0);
    const doc = parseYaml(logs.at(-1)!) as { cases: unknown[] };
    expect(doc.cases.length).toBeGreaterThan(0);
  }, 20000);

  it("两者皆缺 → 可读错误（拒绝执行）", async () => {
    await expect(
      run(["ai", "suggest-cases", apiPath], [], { aiEnv: {}, aiHomeDir: emptyHome }),
    ).rejects.toThrow(/AI 配置/);
  });

  it("--limit 0 → CLI 侧 clamp 可读报错（裁定⑥）", async () => {
    await expect(
      run(["ai", "suggest-cases", apiPath, "--limit", "0"], [], { aiEnv: envTrio, aiHomeDir: emptyHome }),
    ).rejects.toThrow(/limit 必须为正整数/);
  });

  it("接口定位复用既有 resolve 先例：未找到接口可读报错", async () => {
    await expect(
      run(["ai", "suggest-cases", "groups/demo/projects/svc/collections/api/apis/不存在"], [], {
        aiEnv: envTrio, aiHomeDir: emptyHome,
      }),
    ).rejects.toThrow(/未找到接口/);
  });
});
