import { describe, expect, it } from "vitest";
import { createIpcDeps } from "../../src/main/ipc.js";
import { toTreeNode } from "../../src/main/tree.js";
import { localTreeNodeKey, type LocalTreeNodeDTO, type TreeNodeDTO } from "../../src/shared/tree-dto.js";
import { IpcChannel } from "../../src/shared/channels.js";
import { createSession } from "../../src/main/session.js";
import { IDS, makeApi, makeTempRoot, makeWorkspace, persistWorkspace, projectOne, uuid } from "./helpers/contract-assets.js";

function flatten(node: TreeNodeDTO): TreeNodeDTO[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

function expectLocalKind<K extends LocalTreeNodeDTO["kind"]>(node: TreeNodeDTO | undefined, kind: K): Extract<LocalTreeNodeDTO, { kind: K }> {
  if (!node || node.source !== "local" || node.kind !== kind) throw new Error(`Missing local ${kind} tree node`);
  return node as Extract<LocalTreeNodeDTO, { kind: K }>;
}

describe("toTreeNode", () => {
  it("builds full local locators, stable UI keys, hydrated summaries, and arbitrary folder ancestry", async () => {
    const workspace = makeWorkspace();
    const firstProject = projectOne(workspace);
    const firstApi = firstProject.collections[0]!.apis[0]!;
    if (firstApi.contract.request.protocol !== "http") throw new Error("fixture protocol changed");
    firstApi.contract.request.method = "PATCH";
    const soapApi = makeApi(uuid(151), "SOAP API");
    soapApi.contract.request = {
      protocol: "soap", method: "POST", baseUrl: "https://api.example.test", path: "/soap",
      pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, envelope: "<request />",
    };
    const websocketApi = makeApi(uuid(152), "WebSocket API");
    websocketApi.contract.request = {
      protocol: "websocket", baseUrl: "wss://api.example.test", path: "/events",
      pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, message: "hello",
    };
    firstProject.collections[0]!.apis.push(soapApi, websocketApi);
    firstProject.environments[0]!.extends = "base";
    firstProject.environments[0]!.variables = { token: "dev-token" };
    firstProject.environments.push({ id: uuid(150), name: "base", variables: { token: "base-token" }, baseUrls: {} });
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });

      const dto = toTreeNode(workspace);
      const all = flatten(dto);
      const root = expectLocalKind(dto, "root");
      const groupOne = expectLocalKind(all.find((node) => node.source === "local" && node.kind === "group" && node.id === IDS.groupOne), "group");
      const projectNode = expectLocalKind(all.find((node) => node.source === "local" && node.kind === "project" && node.id === IDS.projectOne), "project");
      const firstApiNode = expectLocalKind(all.find((node) => node.source === "local" && node.kind === "api" && node.id === IDS.sharedApi && "locator" in node && node.locator.groupId === IDS.groupOne), "api");
      const secondApiNode = expectLocalKind(all.find((node) => node.source === "local" && node.kind === "api" && node.id === IDS.sharedApi && "locator" in node && node.locator.groupId === IDS.groupTwo), "api");
      const deepApiNode = expectLocalKind(all.find((node) => node.source === "local" && node.kind === "api" && node.id === IDS.deepApi), "api");
      const soapApiNode = expectLocalKind(all.find((node) => node.source === "local" && node.kind === "api" && node.id === uuid(151)), "api");
      const websocketApiNode = expectLocalKind(all.find((node) => node.source === "local" && node.kind === "api" && node.id === uuid(152)), "api");
      const workflow = projectNode.workflows[0]!;

      expect(root.locator).toEqual({ workspaceId: IDS.workspace });
      expect(groupOne.locator).toEqual({ workspaceId: IDS.workspace, groupId: IDS.groupOne });
      expect(projectNode.envs[0]).toMatchObject({
        source: "local",
        id: IDS.environment,
        name: "dev",
        extends: "base",
        variables: { token: "dev-token" },
        baseUrls: { [IDS.collectionOne]: "https://dev.example.test", [IDS.secondCollection]: "https://second.example.test" },
        locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, environmentId: IDS.environment },
      });
      expect(workflow).toMatchObject({
        source: "local",
        id: IDS.workflow,
        name: "request flow",
        status: "draft",
        locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, workflowId: IDS.workflow },
      });
      expect(firstApiNode.locator).toEqual({
        workspaceId: IDS.workspace,
        groupId: IDS.groupOne,
        projectId: IDS.projectOne,
        collectionId: IDS.collectionOne,
        folderIds: [],
        apiId: IDS.sharedApi,
      });
      expect((firstApiNode as { protocol?: string }).protocol).toBe("http");
      expect((firstApiNode as { method?: string }).method).toBe("PATCH");
      expect((soapApiNode as { protocol?: string }).protocol).toBe("soap");
      expect((soapApiNode as { method?: string }).method).toBe("POST");
      expect((websocketApiNode as { protocol?: string }).protocol).toBe("websocket");
      expect((websocketApiNode as { method?: string }).method).toBeUndefined();
      expect(deepApiNode.locator.folderIds).toEqual([IDS.folderOne, IDS.folderTwo]);
      expect(session.locateApi(deepApiNode.locator)?.api.contract.id).toBe(deepApiNode.id);
      expect(firstApiNode.key).not.toBe(secondApiNode.key);
    const renamedApiNode = { ...firstApiNode, label: "renamed in the UI" };
    expect(localTreeNodeKey(renamedApiNode)).toBe(firstApiNode.key);
      expect(localTreeNodeKey({ ...firstApiNode, locator: {
        apiId: firstApiNode.locator.apiId,
        folderIds: [...firstApiNode.locator.folderIds],
        collectionId: firstApiNode.locator.collectionId,
        projectId: firstApiNode.locator.projectId,
        groupId: firstApiNode.locator.groupId,
        workspaceId: firstApiNode.locator.workspaceId,
      } })).toBe(firstApiNode.key);

      deepApiNode.label = "caller edit";
      projectNode.envs[0]!.variables.token = "caller edit";
      expect(workspace.groups[0]!.projects[0]!.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.metadata.name).toBe("deep API");
      expect(firstProject.environments[0]!.variables.token).toBe("dev-token");

      const treeGet = await deps.handle(IpcChannel.TreeGet, null);
      const refreshedApi = flatten(treeGet).find((node) => node.source === "local" && node.kind === "api" && node.id === IDS.sharedApi) as { protocol?: string; method?: string } | undefined;
      expect(refreshedApi).toMatchObject({ protocol: "http", method: "PATCH" });
      await session.open(temporary.path);
      const reopenedTree = await deps.handle(IpcChannel.TreeGet, null);
      const reopenedSoap = flatten(reopenedTree).find((node) => node.source === "local" && node.kind === "api" && node.id === uuid(151)) as { protocol?: string; method?: string } | undefined;
      expect(reopenedSoap).toMatchObject({ protocol: "soap", method: "POST" });

      const renamedWorkspace = structuredClone(workspace);
      renamedWorkspace.groups[0]!.name = "renamed group";
      projectOne(renamedWorkspace).name = "renamed project";
      const renamedTree = flatten(toTreeNode(renamedWorkspace));
      expect(renamedTree.find((node) => node.source === "local" && node.kind === "api" && node.id === IDS.sharedApi && "locator" in node && node.locator.groupId === IDS.groupOne)?.key).toBe(firstApiNode.key);
    } finally {
      await temporary.dispose();
    }
  });
});
