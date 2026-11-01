import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CollectionRunner,
  createDefaultRegistry,
  createEventBus,
  createProjectSnapshot,
  renderContractMarkdown,
  redactAiText,
  safeAiValue,
  version,
  type PluginRegistry,
} from "@apicc/core";
import { prepareExecutionRun, type CredentialHostOptions } from "../credentials.js";
import { createOutputSanitizer } from "../output.js";
import { assertWorkspaceUsable, listApiLocations, loadWorkspace, locateApi } from "../workspace.js";
import { boundedJson } from "./pagination.js";
import { createMcpSource, type McpSource } from "./source.js";
import { registerSourceTools } from "./sourceTools.js";
import { createMcpExecutionHost, type McpExecutionHostOptions } from "./execution.js";
import { registerExecutionTools } from "./executionTools.js";
import { executionCapabilityFor } from "./executionCapabilities.js";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpServerOptions extends CredentialHostOptions {
  allowRun?: boolean;
  registry?: PluginRegistry;
  log?: (line: string) => void;
  maxOutputBytes?: number;
  privateRoot?: string;
  limits?: McpExecutionHostOptions["limits"];
  localHost?: McpExecutionHostOptions["localHost"];
  localProfile?: McpExecutionHostOptions["localProfile"];
}
function outputBudget(options: McpServerOptions) {
  const budget = options.maxOutputBytes ?? 128 * 1024;
  if (!Number.isInteger(budget) || budget < 4096 || budget > 1024 * 1024) throw new Error("MCP 输出预算范围为 4 KiB–1 MiB");
  return budget;
}
export function createScopedMcpServer(source: McpSource, options: McpServerOptions = {}): McpServer {
  const maxBytes = outputBudget(options);
  const host = options.allowRun ? executionHost(source, options) : undefined;
  const server = new McpServer({ name: "apicc", version });
  installToolResultBudget(server, maxBytes);
  registerSourceTools(server, async () => source, maxBytes);
  if (host) {
    registerExecutionTools(server, async () => source, async () => host, maxBytes);
    const capability = executionCapabilityFor(source);
    if (capability.kind === "local") registerLegacyRunCase(server, capability.root, options, maxBytes);
  }
  const close = server.close.bind(server);
  let closing: Promise<void> | undefined;
  server.close = () => closing ??= (async () => { try { await host?.close(); } finally { try { await close(); } finally { await source.close(); } } })();
  return server;
}

function executionHost(source: McpSource, options: McpServerOptions) {
  return createMcpExecutionHost({ source, privateRoot: options.privateRoot ?? join(homedir(), ".apicc", "mcp", "execution"),
    limits: options.limits, localHost: options.localHost, localProfile: options.localProfile,
    secretStore: options.secretStore, credentialPrivateRoot: options.credentialPrivateRoot, networkPrivateRoot: options.networkPrivateRoot });
}

/** Keep SDK dispatch and strict validation intact, including errors produced before our handlers. */
function installToolResultBudget(server: McpServer, maxBytes: number): void {
  const register = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => register(schema, async (request, extra) => {
    const result = await handler(request, extra);
    if ((request as { method?: unknown }).method !== "tools/call") return result;
    try { boundedJson(result, maxBytes); return result; }
    catch {
      const fallback = { content: [{ type: "text" as const, text: "工具参数或结果超过输出预算；执行事实尚未确认，请查询原票据/运行，勿重新提交。" }],
        structuredContent: { data: { error: "mcp-output-budget-exceeded" } }, isError: true };
      boundedJson(fallback, maxBytes); return fallback;
    }
  });
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text }] , isError: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "MCP 操作失败";
}

export function createMcpServer(root: string, options: McpServerOptions = {}): McpServer {
  const registry = options.registry ?? createDefaultRegistry();
  if (!registry.getStorage()) throw new Error("未注册存储适配器");
  const log = options.log ?? ((line: string) => { console.error(line); });
  const allowRun = options.allowRun === true;
  log(`[apicc mcp] 工作区: ${root}${allowRun ? "（保存目标执行与兼容 run-case 已启用）" : "（只读模式）"}`);
  const server = new McpServer({ name: "apicc", version });
  let source: Promise<McpSource> | undefined;
  let host: Promise<ReturnType<typeof createMcpExecutionHost>> | undefined;
  const getSource = () => source ??= createMcpSource({ workspace: root, registry });
  const maxBytes = outputBudget(options);
  installToolResultBudget(server, maxBytes);
  registerSourceTools(server, getSource, maxBytes);
  if (allowRun) {
    registerExecutionTools(server, getSource, () => host ??= getSource().then(source => executionHost(source, options)), maxBytes);
    registerLegacyRunCase(server, root, { ...options, registry }, maxBytes);
  }
  const close = server.close.bind(server);
  let closing: Promise<void> | undefined;
  server.close = () => closing ??= (async () => {
    try { await (await host)?.close(); }
    finally { try { await close(); } finally { await (await source)?.close(); } }
  })();
  return server;
}

function registerLegacyRunCase(server: McpServer, root: string, options: McpServerOptions, maxBytes: number): void {
  const registry = options.registry ?? createDefaultRegistry();
  const credentialOptions = {
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
    ...(options.credentialPrivateRoot ? { credentialPrivateRoot: options.credentialPrivateRoot } : {}),
  };
  const API_PATH_DESC = "工作区相对完整 UUID 路径（直接使用 list-apis 返回的 apiPath）";
    server.registerTool(
      "run-case",
      {
        title: "执行单个接口用例",
        description: "在完整项目快照和祖先操作上下文中执行接口用例；执行类工具，仅在 --allow-run 时可用。",
        inputSchema: {
          apiPath: z.string().min(1).describe(API_PATH_DESC),
          caseId: z.string().min(1).describe("用例 ID（见 get-api-design 产出的用例表）"),
        },
      },
      async ({ apiPath, caseId }) => {
        let sanitizer = createOutputSanitizer([]);
        let attempted = false; let executed = false;
        const boundedError = (message: string) => {
          const result = errorResult(redactAiText(sanitizer.redactText(message)));
          try { boundedJson(result, maxBytes); return result; }
          catch {
            return errorResult(executed ? "用例已执行；结果超过 MCP 输出预算，未返回完整结果。请勿重试，避免重复业务副作用。"
              : attempted ? "执行已开始，可能已产生业务副作用；结果超过 MCP 输出预算。请勿重试。"
                : "本次未开始执行；错误结果超过 MCP 输出预算，请缩小输入选择。");
          }
        };
        try {
          const state = await loadWorkspace(registry, root);
          assertWorkspaceUsable(state);
          const location = locateApi(state.workspace, apiPath);
          const matchingCases = location.api.cases.filter((candidate) => candidate.id === caseId);
          if (matchingCases.length === 0) return boundedError(`用例不存在: ${caseId}`);
          const testCase = matchingCases.find((candidate) => candidate.scope === "base");
          if (!testCase) {
            const unsupported = matchingCases[0]!;
            return boundedError(`用例「${unsupported.name}」的 scope（${unsupported.scope}）不适用于 run-case（未选环境，仅 base 适用）`);
          }
          const prepared = await prepareExecutionRun(
            state.workspace,
            location.group.id,
            location.project,
            [location.api],
            credentialOptions,
            undefined,
            undefined,
            [{
              collectionId: location.collection.id,
              apiId: location.api.contract.id,
              caseId: testCase.id,
              scope: testCase.scope,
            }],
            { workspaceRoot: root },
          );
          sanitizer = createOutputSanitizer(prepared.secrets);
          const runner = new CollectionRunner({
            registry,
            bus: createEventBus(),
            timeouts: { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 },
            failFast: true,
          });
          attempted = true;
          const result = await runner.run(prepared.run, location.collection.id, {
            caseSelection: {
              apiId: location.api.contract.id,
              caseId,
              folderIds: location.folderIds,
            },
          });
          executed = true;
          const outcome = result.cases[0];
          if (!outcome) return boundedError(`用例「${testCase.name}」未能产生执行结果`);
          try {
            const output = textResult(boundedJson(safeAiValue(sanitizer.redactValue(outcome)), maxBytes));
            boundedJson(output, maxBytes); return output;
          } catch { return boundedError("用例已执行；结果超过 MCP 输出预算，无法返回完整结果。请勿重试，避免重复业务副作用。"); }
        } catch (error) {
          return boundedError(errorText(error));
        }
      },
    );
}
