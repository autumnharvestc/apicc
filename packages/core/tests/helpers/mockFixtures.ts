import { contractExecutionIds, createContractExecutionProject } from "./contractExecutionFixtures.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import type { MockProjectConfig } from "../../src/mock/config.js";

export const mockFixtureIds = {
  pathParameter: "10000000-0000-4000-8000-000000000012",
  response: "10000000-0000-4000-8000-000000000013",
  example: "10000000-0000-4000-8000-000000000014",
  rule: "10000000-0000-4000-8000-000000000015",
} as const;

export function createMockConfiguredProject(): ContractProject & { mock: MockProjectConfig } {
  const project = createContractExecutionProject("http://mock-fixture.invalid");
  const api = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  const request = api.contract.request;
  if (request.protocol !== "http") throw new Error("Mock fixture must use HTTP.");
  request.method = "GET";
  request.path = "/items/{id}";
  request.pathParams = [{
    kind: "inline",
    id: mockFixtureIds.pathParameter,
    name: "id",
    schema: { kind: "scalar", type: "string" },
    required: true,
    enabled: true,
    description: "item path parameter",
  }];
  api.contract.responses = [{
    kind: "inline",
    id: mockFixtureIds.response,
    status: "200",
    description: "A fixed mock item",
    headers: { "X-Mock-Fixture": "fixed", "Content-Length": "999" },
    content: {
      "application/json": {
        schema: {
          kind: "object",
          properties: { id: { kind: "scalar", type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        examples: [{
          kind: "inline",
          id: mockFixtureIds.example,
          name: "fixed item",
          value: { id: "item-7" },
        }],
      },
    },
  }];

  const mock: MockProjectConfig = {
    formatVersion: 1,
    seed: "b1-fixed-seed",
    enabledContractIds: [contractExecutionIds.contract],
    rules: [{
      id: mockFixtureIds.rule,
      enabled: true,
      contractId: contractExecutionIds.contract,
      conditions: [],
      responseBindingId: mockFixtureIds.response,
      mediaType: "application/json",
      source: { kind: "example", exampleBindingId: mockFixtureIds.example },
      delayMs: 0,
    }],
  };
  return Object.assign(project, { mock });
}
