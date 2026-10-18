import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CollectionRunner,
  createDefaultRegistry,
  createEventBus,
  createProjectSnapshot,
  renderContractMarkdown,
  version,
  type PluginRegistry,
} from "@apicc/core";
import { prepareExecutionRun, type CredentialHostOptions } from "../credentials.js";
import { createOutputSanitizer } from "../output.js";
import { assertWorkspaceUsable, listApiLocations, loadWorkspace, locateApi } from "../workspace.js";

export interface McpServerOptions extends CredentialHostOptions {
  allowRun?: boolean;
  registry?: PluginRegistry;
  log?: (line: string) => void;
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
  const credentialOptions = {
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
    ...(options.credentialPrivateRoot ? { credentialPrivateRoot: options.credentialPrivateRoot } : {}),
  };
  log(`[apicc mcp] 工作区: ${root}${allowRun ? "（run-case 已启用）" : "（只读模式）"}`);

  const API_PATH_DESC = "工作区相对完整 UUID 路径（直接使用 list-apis 返回的 apiPath）";
  const server = new McpServer({ name: "apicc", version });

  server.registerTool(
    "list-apis",
    {
      title: "列出工作区接口",
      description: "列出工作区内接口的摘要（id/name/protocol/url/apiPath）。apiPath 可用于 get-api-design 与 run-case 定位接口。",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const state = await loadWorkspace(registry, root);
        assertWorkspaceUsable(state);
        const rows = listApiLocations(state.workspace).map(({ api, apiPath }) => ({
          id: api.contract.id,
          name: api.contract.metadata.name,
          protocol: api.contract.request.protocol,
          url: `${api.contract.request.baseUrl}${api.contract.request.path}`,
          apiPath,
        }));
        return textResult(JSON.stringify(rows, null, 2));
      } catch (error) {
        return errorResult(errorText(error));
      }
    },
  );

  server.registerTool(
    "get-api-design",
    {
      title: "读取接口详细设计",
      description: "从本次加载的项目快照及其资产上下文渲染接口契约与设计正文。",
      inputSchema: { apiPath: z.string().min(1).describe(API_PATH_DESC) },
      annotations: { readOnlyHint: true },
    },
    async ({ apiPath }) => {
      try {
        const state = await loadWorkspace(registry, root);
        assertWorkspaceUsable(state);
        const location = locateApi(state.workspace, apiPath);
        const snapshot = createProjectSnapshot(location.project);
        return textResult(renderContractMarkdown(location.api, snapshot.context));
      } catch (error) {
        return errorResult(errorText(error));
      }
    },
  );

  if (allowRun) {
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
        try {
          const state = await loadWorkspace(registry, root);
          assertWorkspaceUsable(state);
          const location = locateApi(state.workspace, apiPath);
          const matchingCases = location.api.cases.filter((candidate) => candidate.id === caseId);
          if (matchingCases.length === 0) return errorResult(`用例不存在: ${caseId}`);
          const testCase = matchingCases.find((candidate) => candidate.scope === "base");
          if (!testCase) {
            const unsupported = matchingCases[0]!;
            return errorResult(`用例「${unsupported.name}」的 scope（${unsupported.scope}）不适用于 run-case（未选环境，仅 base 适用）`);
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
          const result = await runner.run(prepared.run, location.collection.id, {
            caseSelection: {
              apiId: location.api.contract.id,
              caseId,
              folderIds: location.folderIds,
            },
          });
          const outcome = result.cases[0];
          if (!outcome) return errorResult(`用例「${testCase.name}」未能产生执行结果`);
          return textResult(JSON.stringify(sanitizer.redactValue(outcome), null, 2));
        } catch (error) {
          return errorResult(sanitizer.redactText(errorText(error)));
        }
      },
    );
  }

  return server;
}
