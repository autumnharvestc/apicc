// M6-C 任务 1（规格 §2 D2/D4）：AI 频道 IPC 测试——ai:save-config / ai:get-config /
// ai:suggest（fixture 桩）。key 永不回传渲染层明文（出口 only hasKey，裁定②）；
// suggest 桩已存密钥 → 固定两条建议（深拷贝），未配置 → 可读错误（连接测试失败态同源）。
// 另含契约 fixture 与 core TestCase schema 的同构性守卫（采用后必须过严格 schema 才能落盘）。
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiDefinitionSchema } from "@apicc/core";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { createAiKeyStore } from "../../../src/main/ai/config.js";
import type { SafeStorageLike } from "../../../src/main/online/tokenStore.js";
import { AI_FIXTURE_SUGGESTIONS } from "../../../src/shared/ai/contract.js";

const availableStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain, "utf8").toString("base64"), "utf8"),
  decryptString: (encrypted) => Buffer.from(encrypted.toString("utf8"), "base64").toString("utf8"),
};

function setup(withAi = true) {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ai-ipc-"));
  const keyStore = createAiKeyStore({ dir, storage: availableStorage });
  const deps = createIpcDeps({
    session: createSession(),
    pickDirectory: async () => dir,
    saveFile: async () => "",
    ...(withAi ? { ai: { keyStore } } : {}),
  });
  return { deps, dir, keyStore };
}

describe("AI 频道（M6-C 任务 1，fixture 阶段）", () => {
  it("ai:save-config 携 apiKey → 密钥入安全存储（文件无明文），返回 { hasKey: true }", async () => {
    const { deps, dir } = setup();
    const out = await deps.handle("ai:save-config", {}, { baseUrl: "https://api.example.com/v1", model: "gpt-test", apiKey: "sk-ipc-1" });
    expect(out).toEqual({ hasKey: true });
    const raw = readFileSync(join(dir, "ai-key.json"), "utf8");
    expect(raw).not.toContain("sk-ipc-1");
  });

  it("ai:save-config 不携 apiKey（省略或空串）→ 保持既有 key 不变", async () => {
    const { deps, keyStore } = setup();
    await deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m", apiKey: "sk-keep" });
    await deps.handle("ai:save-config", {}, { baseUrl: "https://b", model: "m2" });
    expect(keyStore.load()).toBe("sk-keep");
    const out = await deps.handle("ai:save-config", {}, { baseUrl: "https://c", model: "m3", apiKey: "" });
    expect(out).toEqual({ hasKey: true });
    expect(keyStore.load()).toBe("sk-keep");
  });

  it("ai:get-config：未存 key → { hasKey: false }；存后 → { hasKey: true }（key 明文永不回传）", async () => {
    const { deps } = setup();
    expect(await deps.handle("ai:get-config", {})).toEqual({ hasKey: false });
    await deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m", apiKey: "sk-x" });
    expect(await deps.handle("ai:get-config", {})).toEqual({ hasKey: true });
  });

  it("ai:suggest 桩：未配置密钥 → 可读错误（连接测试失败态同源）", async () => {
    const { deps } = setup();
    await expect(deps.handle("ai:suggest", {}, { apiId: "api-1" })).rejects.toThrow(/尚未配置 AI 密钥/);
  });

  it("ai:suggest 桩：已配置 → 固定两条建议（与契约 fixture 等值，且为深拷贝不泄漏内部引用）", async () => {
    const { deps } = setup();
    await deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m", apiKey: "sk-x" });
    const out = await deps.handle("ai:suggest", {}, { apiId: "api-1" });
    expect(out).toEqual(AI_FIXTURE_SUGGESTIONS);
    expect(out).not.toBe(AI_FIXTURE_SUGGESTIONS);
    expect(out[0]).not.toBe(AI_FIXTURE_SUGGESTIONS[0]);
    expect(out).toHaveLength(2);
  });

  it("ai:save-config 入参校验：baseUrl/model 缺失 → 带频道名的可读错误", async () => {
    const { deps } = setup();
    await expect(deps.handle("ai:save-config", {}, { baseUrl: "", model: "m", apiKey: "k" })).rejects.toThrow(/\[ai:save-config\]/);
    await expect(deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "" })).rejects.toThrow(/\[ai:save-config\]/);
  });

  it("ai 依赖未配置（组合根省略）→ ai:* 频道抛「AI 功能未配置」", async () => {
    const { deps } = setup(false);
    await expect(deps.handle("ai:get-config", {})).rejects.toThrow(/AI 功能未配置/);
    await expect(deps.handle("ai:save-config", {}, { baseUrl: "https://a", model: "m" })).rejects.toThrow(/AI 功能未配置/);
    await expect(deps.handle("ai:suggest", {}, { apiId: "x" })).rejects.toThrow(/AI 功能未配置/);
  });

  it("契约同构守卫：fixture 建议采用（本地补 id）后过 core ApiDefinitionSchema 严格校验", () => {
    const adoptedCases = AI_FIXTURE_SUGGESTIONS.map((s) => ({
      id: `case-${s.name}`,
      name: s.name,
      scope: s.scope,
      parameters: { ...s.parameters },
      assertions: s.assertions.map((a, i) => ({ ...a, id: `assert-${i}` })),
      ...(s.postScript !== undefined ? { postScript: s.postScript } : {}),
    }));
    const api = {
      id: "api-x", name: "示例", version: "1.0.0", deprecated: false, method: "GET", url: "/x",
      headers: [], query: [], cases: adoptedCases, protocol: "http",
    };
    expect(ApiDefinitionSchema.parse(api).cases).toHaveLength(2);
  });
});
