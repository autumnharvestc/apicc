import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ApiAsset } from "../../src/contract/model.js";
import { createDefaultRegistry } from "../../src/index.js";
import type { ProjectExecutionRun } from "../../src/runner/runner.js";
import { WorkflowRunner } from "../../src/workflow/runner.js";
import { createContractExecutionProject, contractExecutionIds } from "../helpers/contractExecutionFixtures.js";

/**
 * Workflow production path: a referenced snapshot WebSocket API extracts a
 * runtime value, a condition edge carries it, and a referenced HTTP API consumes it.
 */
describe("WorkflowRunner cross protocol (WS → conditional edge → HTTP)", () => {
  let httpServer: Server;
  let httpBaseUrl = "";
  let wss: WebSocketServer;
  let wssUrl = "";
  let seenAuth: string | undefined;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      seenAuth = _req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ auth: seenAuth ?? "" }));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    httpBaseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
    const address = wss.address() as { port: number };
    wssUrl = `ws://127.0.0.1:${address.port}`;
    wss.on("connection", (socket: WsSocket) => {
      socket.on("message", (data) => {
        socket.send(JSON.stringify({ token: `tk-${JSON.parse(data.toString()).user}` }));
        socket.close(1000);
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("resolves API and case references from one frozen project and carries the WS token to HTTP", async () => {
    const project = createContractExecutionProject(httpBaseUrl);
    project.environments[0]!.variables = { wsUrl: wssUrl, httpUrl: httpBaseUrl };
    project.environments[0]!.baseUrls = {};
    const wsApiId = "10000000-0000-4000-8000-000000000011";
    const httpApiId = "10000000-0000-4000-8000-000000000012";
    const wsAsset: ApiAsset = {
      contract: {
        formatVersion: 1,
        id: wsApiId,
        metadata: { name: "ws-login", description: "", tags: [], version: "1", status: "draft" },
        request: {
          protocol: "websocket", baseUrl: "{{wsUrl}}", path: "/rt", pathParams: [], query: [], headers: [], cookies: [],
          auth: { kind: "none" }, message: '{"user":"m5"}',
        },
        responses: [],
      },
      cases: [{
        id: "case-ws", name: "ws-login", scope: "base", parameters: {},
        preOperations: [],
        postOperations: [{ id: "extract-token", type: "script", content: 'pm.variables.set("token", JSON.parse(pm.response.text()).token);' }],
        assertions: [{ id: "ws-token", target: "bodyJson", op: "eq", expected: "tk-m5", path: "token" }],
      }],
      documentation: "",
    };
    const httpAsset: ApiAsset = {
      contract: {
        formatVersion: 1,
        id: httpApiId,
        metadata: { name: "http-who", description: "", tags: [], version: "1", status: "draft" },
        request: {
          protocol: "http", method: "GET", baseUrl: "{{httpUrl}}", path: "/who", pathParams: [], query: [], cookies: [],
          headers: [{ kind: "inline", id: "10000000-0000-4000-8000-000000000013", name: "authorization", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "{{token}}" }],
          auth: { kind: "none" }, body: { kind: "none" },
        },
        responses: [],
      },
      cases: [{
        id: "case-http", name: "http-who", scope: "base", parameters: {},
        preOperations: [], postOperations: [],
        assertions: [{ id: "http-auth", target: "bodyJson", op: "eq", expected: "tk-m5", path: "auth" }],
      }],
      documentation: "",
    };
    project.collections[0]!.folders = [];
    project.collections[0]!.apis = [wsAsset, httpAsset];
    project.workflows = [{
      id: "workflow-cross-protocol", name: "cross protocol", status: "enabled",
      nodes: [
        { id: "ws", kind: "request", apiId: wsApiId, caseId: "case-ws", label: "ws" },
        { id: "http", kind: "request", apiId: httpApiId, caseId: "case-http", label: "http" },
      ],
      edges: [{ id: "ws-to-http", from: "ws", to: "http", condition: "prev.passed" }],
    }];
    const run: ProjectExecutionRun = {
      snapshot: createProjectSnapshot(project),
      credentialBindings: { resolve: () => { throw new Error("No credential expected"); }, versions: {} },
    };

    const result = await new WorkflowRunner({
      registry: createDefaultRegistry(),
      environmentId: contractExecutionIds.environment,
      failFast: false,
    }).run(run, "workflow-cross-protocol");
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.nodeResults.map((node) => node.state)).toEqual(["passed", "passed"]);
    expect(seenAuth).toBe("tk-m5");
  });
});
