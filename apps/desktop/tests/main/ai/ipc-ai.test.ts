// M6-C 任务 2（规格 §2 D1/D2/D4/D7）：AI 真调用链路 IPC 测试——ai:suggest 切真实现
// （main 以保存的配置构造 core createAiProvider → suggestCases → 深拷贝返回），新增
// ai:test-config 轻量探测（最小 completions，内容不解析）。零真实网络纪律：fetch 经
// deps 注入替身（OpenAI 兼容响应形状），CI/测试不发任何真实请求。
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TestCaseSchema } from "@apicc/core";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { createAiKeyStore } from "../../../src/main/ai/config.js";
import type { AiSuggestInput } from "../../../src/shared/ai/contract.js";
import type { SafeStorageLike } from "../../../src/main/online/tokenStore.js";
import { IDS, makeWorkspace, persistWorkspace, uuid } from "../helpers/contract-assets.js";

const availableStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain, "utf8").toString("base64"), "utf8"),
  decryptString: (encrypted) => Buffer.from(encrypted.toString("utf8"), "base64").toString("utf8"),
};

interface FetchCall { url: string; init: RequestInit }

/** OpenAI 兼容端点替身：记录调用并按 assistant 文本产出 200 JSON（choices[0].message.content）。 */
function fetchStub(content: string, calls: FetchCall[] = [], status = 200): typeof fetch {
  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = status === 200
      ? JSON.stringify({ choices: [{ message: { content } }] })
      : JSON.stringify({ error: { message: "替身端点故障" } });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** 合法 AI 输出：两条用例（第二条断言缺 id——core 回填本地 ULID，裁定④）。 */
const VALID_AI_OUTPUT = JSON.stringify({
  cases: [
    { name: "AI 生成-正常 200", scope: "base", parameters: {}, assertions: [{ id: "a-1", target: "status", op: "eq", expected: "200" }] },
    { name: "AI 生成-不存在 404", assertions: [{ target: "status", op: "eq", expected: "404" }] },
  ],
});

const BAD_AI_OUTPUT = JSON.stringify({ cases: [{ name: 123 }] });

function setup(opts: { content?: string; status?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ai-ipc-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "apicc-ai-workspace-"));
  const keyStore = createAiKeyStore({ dir, storage: availableStorage });
  const calls: FetchCall[] = [];
  const session = createSession();
  const deps = createIpcDeps({
    session,
    pickDirectory: async () => dir,
    saveFile: async () => "",
    ai: { keyStore, fetch: fetchStub(opts.content ?? VALID_AI_OUTPUT, calls, opts.status ?? 200) },
  });
  return { deps, dir, workspaceDir, keyStore, calls, session };
}

/** 经 IPC 链路造一个已打开工作区 + 一条接口，返回 apiId。 */
async function seedApi(deps: ReturnType<typeof createIpcDeps>, dir: string) {
  const opened = await deps.handle("ws:create", {}, dir, "演示");
  const groupLocator = { workspaceId: opened.workspace.id };
  const group = await deps.handle("node:create", {}, { kind: "group", parent: groupLocator, name: "g" });
  if (group.kind !== "group") throw new Error("Expected the group fixture to be created.");
  const project = await deps.handle("node:create", {}, { kind: "project", parent: group.locator, name: "p" });
  if (project.kind !== "project") throw new Error("Expected the project fixture to be created.");
  const collection = await deps.handle("node:create", {}, { kind: "collection", parent: project.locator, name: "c" });
  if (collection.kind !== "collection") throw new Error("Expected the collection fixture to be created.");
  const api = await deps.handle("node:create", {}, { kind: "api", parent: collection.locator, api: { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/x" } });
  if (api.kind !== "api") throw new Error("Expected the API fixture to be created.");
  return { id: api.id, locator: api.locator };
}

describe("AI 频道：配置面（沿用任务 1 契约）", () => {
  it("ai:save-config 携 apiKey → 密钥入安全存储（文件无明文），返回 { hasKey: true }；不携（省略/空串）→ 保持既有", async () => {
    const { deps, dir, keyStore } = setup();
    const out = await deps.handle("ai:save-config", {}, { baseUrl: "https://api.example.com/v1", model: "m-test", apiKey: "sk-ipc-1" });
    expect(out).toEqual({ hasKey: true });
    const raw = readFileSync(join(dir, "ai-key.json"), "utf8");
    expect(raw).not.toContain("sk-ipc-1");
    await deps.handle("ai:save-config", {}, { baseUrl: "https://b", model: "m2" });
    expect(keyStore.load()).toBe("sk-ipc-1");
  });

  it("ai:get-config：未存 key → { hasKey: false }；存后 → { hasKey: true }（key 明文永不回传）", async () => {
    const { deps } = setup();
    expect(await deps.handle("ai:get-config", {})).toEqual({ hasKey: false });
    await deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m", apiKey: "sk-x" });
    expect(await deps.handle("ai:get-config", {})).toEqual({ hasKey: true });
  });

  it("ai:save-config 入参校验：baseUrl/model 缺失 → 带频道名的可读错误；ai 依赖未配置 → ai:* 抛「AI 功能未配置」", async () => {
    const { deps } = setup();
    await expect(deps.handle("ai:save-config", {}, { baseUrl: "", model: "m", apiKey: "k" })).rejects.toThrow(/\[ai:save-config\]/);
    const bare = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "" });
    await expect(bare.handle("ai:get-config", {})).rejects.toThrow(/AI 功能未配置/);
    await expect(bare.handle("ai:suggest", {}, { locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi }, baseUrl: "https://a", model: "m" })).rejects.toThrow(/AI 功能未配置/);
    await expect(bare.handle("ai:test-config", {}, { baseUrl: "https://a", model: "m" })).rejects.toThrow(/AI 功能未配置/);
  });
});

describe("ai:suggest 真链路（core provider + suggestCases，任务 2 步骤 1①）", () => {
  it("完整链路：保存密钥 + 打开工作区接口 → ai:suggest 返回两条建议（id 齐全唯一、可直接过 TestCase 形状）", async () => {
    const { deps, dir, workspaceDir, calls, session } = setup();
    await deps.handle("ai:save-config", {}, { baseUrl: "https://ai.example.com/v1", model: "model-x", apiKey: "sk-real-1" });
    const seeded = await seedApi(deps, workspaceDir);
    const projectLocator = {
      workspaceId: seeded.locator.workspaceId,
      groupId: seeded.locator.groupId,
      projectId: seeded.locator.projectId,
    };
    const model = await session.createModel(projectLocator, {
      name: "AI_PROMPT_MODEL_SENTINEL",
      description: "Only this project's referenced model belongs in the AI prompt.",
      schema: { kind: "object", properties: { promptSentinel: { kind: "scalar", type: "string" } }, required: ["promptSentinel"], additionalProperties: false },
    });
    const parameter = await session.createComponent(projectLocator, {
      name: "AI_PROMPT_PARAMETER_SENTINEL",
      description: "Only this project's referenced parameter belongs in the AI prompt.",
      kind: "parameter",
      definition: { location: "header", name: "AI_PROMPT_PARAMETER_SENTINEL", schema: { kind: "scalar", type: "string" }, required: true, description: "AI prompt parameter sentinel" },
    });
    const api = session.locateApi(seeded.locator)!.api;
    if (api.contract.request.protocol !== "http") throw new Error("Expected an HTTP API fixture.");
    api.contract.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: model.id } };
    api.contract.request.headers.push({ kind: "componentRef", id: uuid(9001), componentId: parameter.id, expectedKind: "parameter" });
    await session.saveApi(seeded.locator, api);
    const locator = seeded.locator;
    const out = (await deps.handle("ai:suggest", {}, { locator, baseUrl: "https://ai.example.com/v1", model: "model-x" })) as Array<{ id: string; name: string; assertions: Array<{ id: string }> }>;
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.id)).size).toBe(2);
    for (const c of out) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTypeOf("string");
      for (const a of c.assertions) expect(a.id).toBeTruthy(); // 缺 id 的断言由 core 回填
    }
    // 请求面：OpenAI 兼容 chat/completions + Bearer + json_object + model
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ai.example.com/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-real-1");
    const payload = JSON.parse(String(calls[0]!.init.body)) as { model: string; response_format: { type: string }; messages: Array<{ role: string; content: string }> };
    expect(payload.model).toBe("model-x");
    expect(payload.response_format).toEqual({ type: "json_object" });
    expect(payload.messages[0]!.role).toBe("system");
    expect(payload.messages[1]!.content).toContain("AI_PROMPT_MODEL_SENTINEL");
    expect(payload.messages[1]!.content).toContain(parameter.id);
    expect(payload.messages[1]!.content).toContain("AI_PROMPT_PARAMETER_SENTINEL");
    // 产物面：每条建议即合法 TestCase（含 id），可直接提交给契约资产保存链路。
    expect(out.map((testCase) => TestCaseSchema.parse(testCase))).toHaveLength(2);
  });

  it("未存密钥 → 可读错误指引配置对话框，且不发起 provider 请求", async () => {
    const { deps, workspaceDir, calls } = setup();
    const locator = (await seedApi(deps, workspaceDir)).locator;
    await expect(deps.handle("ai:suggest", {}, { locator, baseUrl: "https://a", model: "m" })).rejects.toThrow(/尚未配置 AI 密钥/);
    expect(calls).toHaveLength(0);
  });

  it("apiId 未命中 → 「未找到接口」可读错误", async () => {
    const { deps, workspaceDir } = setup();
    await deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m", apiKey: "sk-x" });
    const seeded = await seedApi(deps, workspaceDir);
    await expect(deps.handle("ai:suggest", {}, { locator: { ...seeded.locator, apiId: uuid(9999) }, baseUrl: "https://a", model: "m" })).rejects.toThrow(/未找到接口/);
  });

  it("跨项目重复 API ID 由完整 locator 精确定位目标项目上下文", async () => {
    const { deps, calls } = setup();
    await deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m", apiKey: "sk-x" });
    const workspaceDir = mkdtempSync(join(tmpdir(), "apicc-ai-ambiguous-"));
    await persistWorkspace(workspaceDir, makeWorkspace());
    await deps.handle("ws:open", {}, workspaceDir);
    const locator = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo, collectionId: IDS.collectionTwo, folderIds: [], apiId: IDS.sharedApi };
    const output = await deps.handle("ai:suggest", {}, { locator, baseUrl: "https://a", model: "m" });
    expect(output).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-x");
    const payload = JSON.parse(String(calls[0]!.init.body)) as { messages: Array<{ content: string }> };
    expect(payload.messages[1]!.content).toContain("project two API");
    expect(payload.messages[1]!.content).not.toContain("project one API");
  });

  it("AI 两次输出均非法 → AiSuggestError 冒泡（报错带解析失败原因）", async () => {
    const { deps, workspaceDir } = setup({ content: BAD_AI_OUTPUT });
    await deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m", apiKey: "sk-x" });
    const locator = (await seedApi(deps, workspaceDir)).locator;
    await expect(deps.handle("ai:suggest", {}, { locator, baseUrl: "https://a", model: "m" })).rejects.toThrow(/解析失败/);
  });

  it("入参校验：baseUrl/model/apiId 缺失 → 带频道名的可读错误", async () => {
    const { deps } = setup();
    const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi };
    // Runtime-negative IPC input crosses the static contract only at this explicit unknown boundary.
    const malformedLocator: unknown = {};
    await expect(deps.handle("ai:suggest", {}, { locator: malformedLocator as AiSuggestInput["locator"], baseUrl: "https://a", model: "m" })).rejects.toThrow(/\[ai:suggest\]/);
    await expect(deps.handle("ai:suggest", {}, { locator, baseUrl: "", model: "m" })).rejects.toThrow(/\[ai:suggest\]/);
    await expect(deps.handle("ai:suggest", {}, { locator, baseUrl: "https://a", model: "" })).rejects.toThrow(/\[ai:suggest\]/);
  });
});

describe("ai:test-config 轻量探测（任务 2 步骤 1②）", () => {
  it("已配置 → 最小 completions 探测成功，返回 { ok: true }；探测消息含 \"JSON\"（适配 json_object 约束，审查修复·重要）", async () => {
    const { deps, calls } = setup();
    await deps.handle("ai:save-config", {}, { baseUrl: "https://ai.example.com/v1", model: "model-x", apiKey: "sk-probe" });
    const out = await deps.handle("ai:test-config", {}, { baseUrl: "https://ai.example.com/v1", model: "model-x" });
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ai.example.com/v1/chat/completions");
    // provider 恒带 response_format json_object：messages 缺 "JSON" 字样会被严格端点 400
    const payload = JSON.parse(String(calls[0]!.init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]!.content).toContain("JSON");
  });

  it("未存密钥 → 可读错误；端点 500 → provider 归一化错误冒泡", async () => {
    const noKey = setup();
    await expect(noKey.deps.handle("ai:test-config", {}, { baseUrl: "https://a", model: "m" })).rejects.toThrow(/尚未配置 AI 密钥/);
    const failing = setup({ status: 500 });
    await failing.deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m", apiKey: "sk-x" });
    await expect(failing.deps.handle("ai:test-config", {}, { baseUrl: "https://a", model: "m" })).rejects.toThrow(/AI provider 请求失败/);
  });

  it("入参校验：baseUrl/model 缺失 → [ai:test-config] 可读错误", async () => {
    const { deps } = setup();
    await expect(deps.handle("ai:test-config", {}, { baseUrl: "", model: "m" })).rejects.toThrow(/\[ai:test-config\]/);
    await expect(deps.handle("ai:test-config", {}, { baseUrl: "https://a", model: "" })).rejects.toThrow(/\[ai:test-config\]/);
  });
});
