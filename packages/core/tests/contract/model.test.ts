import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiAssetSchema,
  ApiContractSchema,
  ComponentAssetSchema,
  ModelAssetSchema,
} from "../../src/contract/model.js";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { JsonValueSchema, SchemaNodeSchema, StringRecordSchema } from "../../src/contract/schemaNode.js";
import {
  bodyFixtures,
  authBindingFixtures,
  componentFixtures,
  contractFixture,
  inlineParameter,
  httpRequestFixture,
  modelAssetFixture,
  parameterReference,
  protocolRequestFixtures,
  responseReference,
  workspaceFixture,
  workspaceFixtureWithUnknownFolderField,
} from "../helpers/contractFixtures.js";

describe("versioned contract assets", () => {
  it("keeps schema examples separate from an absent request value", () => {
    const asset = contractFixture();
    asset.contract.request.query = [inlineParameter({
      name: "limit",
      schema: { kind: "scalar", type: "integer", default: 10, examples: [20], enum: [10, 20] },
    })];

    const parsed = ApiAssetSchema.parse(asset);
    const parsedQueryParameter = parsed.contract.request.query[0];
    expect(parsedQueryParameter).not.toHaveProperty("value");
    if (parsedQueryParameter.kind === "inline") {
      expect(parsedQueryParameter.schema).toEqual({
        kind: "scalar",
        type: "integer",
        default: 10,
        examples: [20],
        enum: [10, 20],
      });
    }
    expect(ApiAssetSchema.safeParse({ ...asset, method: "GET" }).success).toBe(false);
  });

  it("rejects unknown fields at the asset boundary", () => {
    const asset = contractFixture();
    const withUnknownAssetField = { ...asset, futureField: true };

    expect(ApiAssetSchema.safeParse(withUnknownAssetField).success).toBe(false);
  });

  it("rejects unknown keywords on nested SchemaNodes", () => {
    const asset = contractFixture();
    const withUnknownSchemaField = {
      ...asset,
      contract: {
        ...asset.contract,
        request: {
          ...asset.contract.request,
          body: {
            kind: "json",
            content: "{}",
            schema: { kind: "scalar", type: "string", format: "date-time" },
          },
        },
      },
    };

    expect(ApiAssetSchema.safeParse(withUnknownSchemaField).success).toBe(false);
  });

  it("rejects SOAP-only fields on HTTP requests", () => {
    const httpWithSoapFields = contractFixture(httpRequestFixture({ envelope: "<Envelope/>" }));
    const parsed = ApiContractSchema.safeParse(httpWithSoapFields.contract);
    expect(parsed.success).toBe(false);
  });

  it("rejects HTTP-only fields on WebSocket requests", () => {
    const websocketWithHttpFields = contractFixture({
      ...protocolRequestFixtures()[1],
      method: "GET",
      body: { kind: "none" },
    });

    expect(ApiContractSchema.safeParse(websocketWithHttpFields.contract).success).toBe(false);
  });

  it("requires POST for SOAP requests", () => {
    const soapWithWrongMethod = contractFixture({ ...protocolRequestFixtures()[2], method: "GET" });

    expect(ApiContractSchema.safeParse(soapWithWrongMethod.contract).success).toBe(false);
  });

  it("rejects unsupported asset format versions", () => {
    expect(ApiContractSchema.safeParse({ ...contractFixture().contract, formatVersion: 2 }).success).toBe(false);
    expect(ModelAssetSchema.safeParse({ ...modelAssetFixture(), formatVersion: 0 }).success).toBe(false);
    expect(ComponentAssetSchema.safeParse({ ...componentFixtures()[0], formatVersion: 2 }).success).toBe(false);
    expect(ContractWorkspaceSchema.safeParse({ ...workspaceFixture(), formatVersion: 2 }).success).toBe(false);
  });

  it("accepts the three protocol shapes and all eight explicit body kinds", () => {
    for (const request of protocolRequestFixtures()) {
      expect(ApiContractSchema.safeParse({ ...contractFixture().contract, request }).success).toBe(true);
    }

    for (const body of bodyFixtures()) {
      const request = { ...protocolRequestFixtures()[0], body };
      expect(ApiContractSchema.safeParse({ ...contractFixture().contract, request }).success).toBe(true);
    }
  });

  it("defaults HTTP authentication and body to their empty variants", () => {
    const request = { ...protocolRequestFixtures()[0] };
    delete request.auth;
    delete request.body;
    const parsed = ApiContractSchema.parse({ ...contractFixture().contract, request });

    if (parsed.request.protocol === "http") {
      expect(parsed.request.auth).toEqual({ kind: "none" });
      expect(parsed.request.body).toEqual({ kind: "none" });
    }
  });

  it("rejects schema design fields copied onto a parameter instance", () => {
    const asset = contractFixture();
    asset.contract.request.query = [{
      ...inlineParameter({ name: "limit", schema: { kind: "scalar", type: "integer" } }),
      default: 10,
      examples: [20],
      enum: [10, 20],
    }];

    expect(ApiAssetSchema.safeParse(asset).success).toBe(false);
  });

  it("accepts all typed component kinds and multiple response variants", () => {
    for (const component of componentFixtures()) {
      expect(ComponentAssetSchema.safeParse(component).success).toBe(true);
    }
    expect(ApiContractSchema.safeParse(contractFixture().contract).success).toBe(true);
  });

  it("accepts typed parameter bindings in each of the four locations", () => {
    const request = {
      ...protocolRequestFixtures()[0],
      pathParams: [inlineParameter({ name: "userId", schema: { kind: "scalar", type: "integer" }, required: true })],
      query: [parameterReference()],
      headers: [inlineParameter({ name: "X-Trace", schema: { kind: "scalar", type: "string" }, id: "00000000-0000-4000-8000-000000000023" })],
      cookies: [parameterReference("00000000-0000-4000-8000-000000000006", "00000000-0000-4000-8000-000000000024")],
    };

    expect(ApiContractSchema.safeParse({ ...contractFixture().contract, request }).success).toBe(true);
    expect(ApiContractSchema.safeParse({
      ...contractFixture().contract,
      request: { ...request, query: [{ ...parameterReference(), expectedKind: "auth" }] },
    }).success).toBe(false);
  });

  it("accepts all authentication bindings and rejects plaintext secrets", () => {
    for (const auth of authBindingFixtures()) {
      const request = { ...protocolRequestFixtures()[0], auth };
      expect(ApiContractSchema.safeParse({ ...contractFixture().contract, request }).success).toBe(true);
    }

    const request = { ...protocolRequestFixtures()[0], auth: { kind: "bearer", token: "plain-token" } };
    expect(ApiContractSchema.safeParse({ ...contractFixture().contract, request }).success).toBe(false);
  });

  it("accepts typed response component references and rejects invalid status tokens", () => {
    const contract = { ...contractFixture().contract, responses: [responseReference()] };
    expect(ApiContractSchema.safeParse(contract).success).toBe(true);

    const baseResponse = contractFixture().contract.responses[0] as Record<string, unknown>;
    for (const status of ["99", "600", "2xx", "201 Created"]) {
      const invalid = { ...contractFixture().contract, responses: [{ ...baseResponse, status }] };
      expect(ApiContractSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects cyclic host values that are not JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(JsonValueSchema.safeParse(cyclic).success).toBe(false);
  });

  it("preserves a JSON-deserialized __proto__ key in SchemaNode properties", () => {
    const properties = JSON.parse('{"__proto__":{"kind":"scalar","type":"string"}}') as Record<string, unknown>;
    const parsed = SchemaNodeSchema.safeParse({
      kind: "object",
      properties,
      required: ["__proto__"],
      additionalProperties: false,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "object") {
      expect(Object.keys(parsed.data.properties)).toEqual(["__proto__"]);
      expect(parsed.data.properties["__proto__"]).toEqual({ kind: "scalar", type: "string" });
    }
  });

  it("rejects direct object cycles in SchemaNode while allowing acyclic sharing", () => {
    const cyclic: Record<string, unknown> = { kind: "array" };
    cyclic.items = cyclic;
    expect(SchemaNodeSchema.safeParse(cyclic).success).toBe(false);

    const sharedChild = { kind: "scalar", type: "string" };
    const shared = SchemaNodeSchema.safeParse({
      kind: "object",
      properties: { first: sharedChild, second: sharedChild },
      required: [],
      additionalProperties: false,
    });
    expect(shared.success).toBe(true);
    expect(SchemaNodeSchema.safeParse({ kind: "modelRef", modelId: "00000000-0000-4000-8000-000000000005" }).success).toBe(true);
  });

  it.each([
    ["an extra string key", () => { const value = [1]; Object.defineProperty(value, "extra", { value: 2, enumerable: true }); return value; }],
    ["an extra function key", () => { const value = [1]; Object.defineProperty(value, "extra", { value: () => 1, enumerable: true }); return value; }],
    ["an extra cyclic key", () => { const value = [1]; Object.defineProperty(value, "extra", { value, enumerable: true }); return value; }],
    ["a symbol key", () => { const value = [1]; Object.defineProperty(value, Symbol("extra"), { value: 2, enumerable: true }); return value; }],
    ["an accessor key", () => { const value = [1]; Object.defineProperty(value, "extra", { get: () => 2, enumerable: true }); return value; }],
    ["a non-enumerable key", () => { const value = [1]; Object.defineProperty(value, "extra", { value: 2, enumerable: false }); return value; }],
    ["a hole", () => Array(1)],
  ])("rejects JSON arrays with %s", (_description, createValue) => {
    expect(JsonValueSchema.safeParse(createValue()).success).toBe(false);
  });

  it.each([
    ["a non-writable index", () => { const value = [1]; Object.defineProperty(value, "0", { value: 1, writable: false }); return value; }],
    ["a non-configurable index", () => { const value = [1]; Object.defineProperty(value, "0", { value: 1, configurable: false }); return value; }],
    ["a frozen array", () => Object.freeze([1])],
    ["a sealed array", () => Object.seal([1])],
    ["a frozen nested array", () => Object.freeze([Object.freeze([1])])],
  ])("accepts JSON arrays with %s", (_description, createValue) => {
    expect(JsonValueSchema.safeParse(createValue()).success).toBe(true);
  });

  it("accepts ordinary JSON arrays", () => {
    expect(JsonValueSchema.safeParse([1, "two", null, { enabled: true }, [3]]).success).toBe(true);
  });

  it("parses each recursive dictionary child once and preserves parsed values", () => {
    let leafVisits = 0;
    const leafSchema = z.string().superRefine(() => {
      leafVisits += 1;
    });
    let recursiveSchema: z.ZodType<unknown>;
    recursiveSchema = z.lazy(() => z.union([
      leafSchema,
      StringRecordSchema(recursiveSchema),
    ]));

    for (let depth = 0; depth <= 5; depth += 1) {
      let input: unknown = "leaf";
      for (let level = 0; level < depth; level += 1) input = { child: input };
      leafVisits = 0;
      const parsed = recursiveSchema.safeParse(input);

      expect(parsed.success).toBe(true);
      expect(leafVisits).toBe(1);
      if (parsed.success) expect(parsed.data).toEqual(input);
    }

    const ownProtoKey = JSON.parse('{"__proto__":"leaf"}') as Record<string, unknown>;
    leafVisits = 0;
    const parsed = recursiveSchema.safeParse(ownProtoKey);
    expect(parsed.success).toBe(true);
    expect(leafVisits).toBe(1);
    if (parsed.success && typeof parsed.data === "object" && parsed.data !== null) {
      expect(Object.keys(parsed.data)).toEqual(["__proto__"]);
      expect((parsed.data as Record<string, unknown>)["__proto__"]).toBe("leaf");
    }
  });

  it("keeps dictionary key paths on child validation failures", () => {
    const parsed = StringRecordSchema(z.string()).safeParse({ invalidValue: 42 });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(["invalidValue"]);
  });

  it("preserves __proto__ keys in response header and content dictionaries", () => {
    const contract = contractFixture().contract;
    const response = contract.responses[0] as Record<string, unknown>;
    response.headers = JSON.parse('{"__proto__":"kept-header"}') as Record<string, string>;
    response.content = JSON.parse('{"__proto__":{"examples":[]}}') as Record<string, unknown>;

    const parsed = ApiContractSchema.parse(contract);
    const parsedResponse = parsed.responses[0];
    expect(parsedResponse.kind).toBe("inline");
    if (parsedResponse.kind === "inline") {
      expect(Object.keys(parsedResponse.headers)).toEqual(["__proto__"]);
      expect(Object.keys(parsedResponse.content)).toEqual(["__proto__"]);
    }
  });

  it("preserves __proto__ keys in all workspace and reused environment dictionaries", () => {
    const workspace = workspaceFixture();
    const protoStrings = () => JSON.parse('{"__proto__":"preserved"}') as Record<string, string>;
    workspace.variables = protoStrings();
    const groups = workspace.groups as Array<Record<string, unknown>>;
    const projects = groups[0].projects as Array<Record<string, unknown>>;
    const project = projects[0];
    project.variables = protoStrings();
    const environments = project.environments as Array<Record<string, unknown>>;
    environments[0].variables = protoStrings();
    environments[0].baseUrls = protoStrings();
    const collections = project.collections as Array<Record<string, unknown>>;
    (collections[0]).variables = protoStrings();

    const parsed = ContractWorkspaceSchema.parse(workspace);
    const parsedProject = parsed.groups[0].projects[0];
    expect(Object.keys(parsed.variables)).toContain("__proto__");
    expect(Object.keys(parsedProject.variables)).toContain("__proto__");
    expect(Object.keys(parsedProject.environments[0].variables)).toContain("__proto__");
    expect(Object.keys(parsedProject.environments[0].baseUrls)).toContain("__proto__");
    expect(Object.keys(parsedProject.collections[0].variables)).toContain("__proto__");
  });

  it("preserves __proto__ keys in reused TestCase parameters", () => {
    const asset = contractFixture();
    asset.cases = [{
      id: "case-proto-key",
      name: "dictionary key",
      parameters: JSON.parse('{"__proto__":"parameter-value"}'),
      preOperations: [],
      postOperations: [],
      assertions: [],
    }];

    const parsed = ApiAssetSchema.parse(asset);
    expect(Object.keys(parsed.cases[0].parameters)).toEqual(["__proto__"]);
    expect(parsed.cases[0].parameters["__proto__"]).toBe("parameter-value");
  });

  it.each(["preScript", "postScript"])("rejects legacy %s fields in API asset cases", (legacyField) => {
    const asset = contractFixture();
    asset.cases = [{
      id: "case-legacy-script",
      name: "old shape",
      [legacyField]: "old script",
      parameters: {},
      preOperations: [],
      postOperations: [],
      assertions: [],
    }];

    expect(ApiAssetSchema.safeParse(asset).success).toBe(false);
  });

  it("accepts nested, combinatorial, and model-reference SchemaNodes", () => {
    expect(SchemaNodeSchema.safeParse(modelAssetFixture().schema).success).toBe(true);
  });

  it("rejects unknown SchemaNode keywords instead of stripping them", () => {
    expect(SchemaNodeSchema.safeParse({ kind: "scalar", type: "string", format: "date-time" }).success).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["functions", () => "not JSON"],
    ["non-finite numbers", Number.NaN],
    ["host objects", new Date("2026-10-07T00:00:00Z")],
  ])("rejects %s as JSON values", (_description, value) => {
    expect(JsonValueSchema.safeParse(value).success).toBe(false);
  });

  it("accepts the explicit inactive workspace container tree", () => {
    expect(ContractWorkspaceSchema.safeParse(workspaceFixture()).success).toBe(true);
  });

  it("rejects unknown fields in recursively nested workspace containers", () => {
    expect(ContractWorkspaceSchema.safeParse(workspaceFixtureWithUnknownFolderField()).success).toBe(false);
  });
});
