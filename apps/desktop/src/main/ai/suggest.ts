/**
 * AI 真调用链路（M6-C 任务 2，计划步骤 1①②；规格 §2 D1/D2/D7）：
 * - ai:suggest：定位接口定义 → core createAiProvider（OpenAI 兼容）+ suggestCases
 *   （zod 严格解析 + 恰好一次修复重试 + 本地补 ULID id）→ 深拷贝返回。
 * - ai:test-config：轻量探测——最小 completions（内容不解析），验证连通/鉴权/响应面；
 *   任务 1 的「连接测试借道 suggest 桩」随真链路接入收敛为本频道。
 * 配置边界（D2）：key 取自 main 安全存储（AiKeyStore，缺失 → 可读错误指引配置对话框）；
 * baseUrl/model 为渲染层已保存配置随调用携带（非敏感）。fetch 为形依赖（生产缺省
 * globalThis.fetch，测试注入替身——CI 零真实网络纪律，D7）。
 * 本模块不直接 import electron，保证 vitest（node 环境）可加载。
 */
import { createAiProvider, suggestCases, type AiSuggestedCase, type ApiDefinition } from "@apicc/core";
import type { AiKeyStore } from "./config.js";

export interface AiRuntimeDeps {
  /** AI key 安全存储（生产 = userData 目录 + electron safeStorage）。 */
  keyStore: AiKeyStore;
  /** 注入 fetch（生产缺省 globalThis.fetch；测试注入替身）。 */
  fetch?: typeof fetch;
}

export interface AiSuggestRequest { apiId: string; baseUrl: string; model: string }

/**
 * 组装 provider 配置：key 必须已存（缺失 → 可读错误指引打开 AI 设置）；baseUrl/model
 * 非空性已由频道入参 schema 收口。缺 key 时绝不发请求。
 */
function requireProviderConfig(deps: AiRuntimeDeps, baseUrl: string, model: string) {
  const apiKey = deps.keyStore.load();
  if (!apiKey) throw new Error("尚未配置 AI 密钥，请先在 AI 设置中保存配置");
  return { baseUrl, apiKey, model };
}

/** ai:suggest 真链路：定位接口（未命中 → 可读错误）→ provider → suggestCases → 深拷贝返回（IPC 结构化克隆前置防御）。 */
export async function runAiSuggest(
  deps: AiRuntimeDeps,
  request: AiSuggestRequest,
  locateApi: (apiId: string) => ApiDefinition | undefined,
): Promise<AiSuggestedCase[]> {
  const api = locateApi(request.apiId);
  if (!api) throw new Error(`未找到接口: ${request.apiId}`);
  const provider = createAiProvider(requireProviderConfig(deps, request.baseUrl, request.model), { fetch: deps.fetch });
  const cases = await suggestCases(api, { provider });
  return cases.map((c) => structuredClone(c));
}

/** ai:test-config 轻量探测：最小 completions（返回内容不解析——只验证请求面可用）；provider 错误归一化文案原样冒泡。 */
export async function runAiTestConfig(deps: AiRuntimeDeps, request: { baseUrl: string; model: string }): Promise<{ ok: true }> {
  const provider = createAiProvider(requireProviderConfig(deps, request.baseUrl, request.model), { fetch: deps.fetch });
  await provider([{ role: "user", content: "ping" }]);
  return { ok: true };
}
