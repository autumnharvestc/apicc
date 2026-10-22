import type { ContractProject } from "../../src/contract/workspace.js";
import { WorkflowSchema } from "../../src/workflow/model.js";

/** The same three invocation/report scenarios are consumed by Core and both run hosts. */
export function workflowReportScenarios(apiId: string, caseId: string) {
  const ids = [91, 92, 93, 94, 95].map((id) => `10000000-0000-4000-8000-${String(id).padStart(12, "0")}`);
  const [retry, or, recover, noop, bad] = ids;
  const request = { id: "request", kind: "request", apiId, caseId };
  const flow = (id: string | undefined, name: string, node: unknown) => WorkflowSchema.parse({ id, name, executionVersion: 2, status: "enabled", nodes: [node], edges: [] });
  return [
    flow(retry, "retry", { ...request, policy: { retry: { maxAttempts: 2, retryOn: ["transport"], delayMs: 0 } } }),
    flow(or, "or", { id: "or", kind: "parallel", join: "any-success", branches: [{ id: "bad", workflowId: bad }, { id: "good", workflowId: noop }] }),
    flow(recover, "recover", { ...request, policy: { onError: { workflowId: noop, mode: "recover" } } }),
    flow(noop, "noop", { id: "noop", kind: "noop" }),
    flow(bad, "bad", { id: "assert", kind: "assert", predicate: { op: "eq", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 2 } } }),
  ];
}

export const contractExecutionIds = {
  project: "10000000-0000-4000-8000-000000000001",
  collection: "10000000-0000-4000-8000-000000000002",
  outerFolder: "10000000-0000-4000-8000-000000000003",
  innerFolder: "10000000-0000-4000-8000-000000000004",
  contract: "10000000-0000-4000-8000-000000000005",
  credential: "credential-ref-1",
  case: "case-1",
  environment: "env-local",
  workflow: "workflow-1",
  requestNode: "request-1",
} as const;

/** One frozen project definition shared by collection, workflow, and stress consumer tests. */
export function createContractExecutionProject(baseUrl: string): ContractProject {
  const ids = contractExecutionIds;
  const asset = {
    contract: {
      formatVersion: 1 as const,
      id: ids.contract,
      metadata: { name: "snapshot-request", description: "", tags: [], version: "1", status: "draft" as const },
      request: {
        protocol: "http" as const,
        method: "POST" as const,
        baseUrl: "{{baseUrl}}",
        path: "/{{folderPath}}/items",
        pathParams: [],
        query: [{
          kind: "inline" as const,
          id: "10000000-0000-4000-8000-000000000006",
          name: "region",
          schema: { kind: "scalar" as const, type: "string" as const },
          required: false,
          enabled: true,
          description: "ordinary value binding",
          value: "{{region}}",
        }, {
          kind: "inline" as const,
          id: "10000000-0000-4000-8000-000000000007",
          name: "baseUrl",
          schema: { kind: "scalar" as const, type: "string" as const },
          required: false,
          enabled: true,
          description: "selected module base URL binding",
          value: "{{baseUrl}}",
        }],
        headers: [{
          kind: "inline" as const,
          id: "10000000-0000-4000-8000-000000000008",
          name: "X-Base-Template",
          schema: { kind: "scalar" as const, type: "string" as const },
          required: false,
          enabled: true,
          description: "selected module base URL header",
          value: "{{baseUrl}}",
        }],
        cookies: [],
        auth: { kind: "bearer" as const, token: { id: ids.credential, policy: "test-auto" } },
        body: { kind: "json" as const, content: '{"region":"{{region}}","ancestor":"{{ancestorValue}}","baseUrl":"{{baseUrl}}"}' },
      },
      responses: [],
    },
    cases: [{
      id: ids.case,
      name: "snapshot-case",
      scope: "base",
      parameters: {},
      preOperations: [{ id: "case-pre", type: "script" as const, content: 'pm.request.headers["X-Case"] = pm.variables.get("ancestorValue") ?? "missing"; pm.request.headers["X-Base-Variable"] = pm.variables.get("baseUrl") ?? "missing"; pm.request.headers["X-Base-Environment"] = pm.environment.get("baseUrl") ?? "missing";' }],
      postOperations: [],
      assertions: [],
    }],
    documentation: "",
  };

  return {
    id: ids.project,
    name: "snapshot-project",
    variables: { region: "project", baseUrl: "http://project-stale.example" },
    globals: {
      query: [{ key: "global", value: "global-value", enabled: true }],
      headers: [{ key: "X-Global", value: "global-header", enabled: true }],
      cookies: [],
      body: [],
    },
    environments: [{
      id: ids.environment,
      name: "local",
      variables: { region: "environment", baseUrl: "http://stale.example" },
      baseUrls: { [ids.collection]: baseUrl },
    }],
    collections: [{
      id: ids.collection,
      name: "snapshot-collection",
      variables: { region: "module", baseUrl: "http://module-stale.example" },
      preOperations: [],
      postOperations: [],
      folders: [{
        id: ids.outerFolder,
        name: "outer",
        preOperations: [],
        postOperations: [],
        folders: [{
          id: ids.innerFolder,
          name: "inner",
          preOperations: [{ id: "folder-pre", type: "script", content: 'pm.variables.set("ancestorValue", "folder"); pm.variables.set("folderPath", "nested");' }],
          postOperations: [{ id: "folder-post", type: "script", content: 'pm.variables.set("folderClosed", "true");' }],
          folders: [],
          apis: [asset],
        }],
        apis: [],
      }],
      apis: [],
    }],
    workflows: [{
      id: ids.workflow,
      name: "snapshot-workflow",
      status: "enabled",
      nodes: [{ id: ids.requestNode, kind: "request", apiId: ids.contract, caseId: ids.case }],
      edges: [],
    }],
    stressPolicy: { trustedOrigins: [baseUrl], deniedOrigins: [], maxConcurrency: 2 },
    models: [],
    components: [],
  };
}
