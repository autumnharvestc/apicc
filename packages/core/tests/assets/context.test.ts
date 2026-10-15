import { describe, expect, it } from "vitest";

import { ApiAssetSchema, ComponentAssetSchema, ModelAssetSchema, ParameterBindingSchema, type ApiAsset, type ComponentAsset, type ModelAsset } from "../../src/contract/model.js";
import type { SchemaNode } from "../../src/contract/schemaNode.js";
import { createProjectAssetContext } from "../../src/assets/context.js";
import { componentFixtures, contractFixture, modelAssetFixture, parameterReference } from "../helpers/contractFixtures.js";

const projectId = "00000000-0000-4000-8000-000000000100";
const parameterComponentId = "00000000-0000-4000-8000-000000000006";
const modelId = "00000000-0000-4000-8000-000000000005";

function apiAsset(id: string, componentId?: string): ApiAsset {
  const input = contractFixture();
  input.contract.id = id;
  if (componentId) {
    (input.contract.request as Record<string, unknown>).query = [parameterReference(componentId, `00000000-0000-4000-8000-000000000${id.slice(-3)}`)];
  }
  return ApiAssetSchema.parse(input);
}

function parameterComponent(): Extract<ComponentAsset, { kind: "parameter" }> {
  const component = ComponentAssetSchema.parse(componentFixtures()[0]);
  if (component.kind !== "parameter") throw new Error("Fixture must be a parameter component.");
  return component;
}

function model(id: string, modelRef: string): ModelAsset {
  return ModelAssetSchema.parse({
    formatVersion: 1,
    id,
    name: `Model ${id.slice(-2)}`,
    description: "A model that references another model.",
    schema: { kind: "modelRef", modelId: modelRef },
  });
}

describe("ProjectAssetContext", () => {
  it("finds every typed component reference and refuses to delete a referenced component", () => {
    const first = apiAsset("00000000-0000-4000-8000-000000000101", parameterComponentId);
    const second = apiAsset("00000000-0000-4000-8000-000000000102", parameterComponentId);
    const component = parameterComponent();
    const context = createProjectAssetContext({ projectId, assets: [first, second], models: [], components: [component] });

    expect(context.referencesTo(component.id).map((reference) => reference.ownerId).sort()).toEqual([first.contract.id, second.contract.id]);
    expect(context.referencesTo(component.id).map((reference) => reference.path).sort()).toEqual([
      "contract.request.query[0].componentId",
      "contract.request.query[0].componentId",
    ]);
    expect(context.delete(component.id)).toMatchObject({ ok: false, code: "ASSET_REFERENCED" });
    expect(context.getComponent(component.id)?.name).toBe("User ID");
    expect(component.name).toBe("User ID");
  });

  it("renames an asset without changing its ID or mutating the caller's definition", () => {
    const component = parameterComponent();
    const context = createProjectAssetContext({ projectId, assets: [], models: [], components: [component] });

    expect(context.rename(component.id, "Account identifier")).toEqual({ ok: true });
    expect(context.getComponent(component.id)).toMatchObject({ id: component.id, name: "Account identifier" });
    expect(component.name).toBe("User ID");
  });

  it("reports stable missing-target and wrong-kind diagnostics while retaining an editable draft", () => {
    const asset = apiAsset("00000000-0000-4000-8000-000000000103");
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.query = [ParameterBindingSchema.parse(parameterReference("00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-000000000130"))];
    request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: "00000000-0000-4000-8000-000000000199" } };
    const exampleComponent = ComponentAssetSchema.parse(componentFixtures()[3]);
    const context = createProjectAssetContext({ projectId, assets: [asset], models: [], components: [exampleComponent] });

    expect(context.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ASSET_REFERENCE_KIND_MISMATCH",
        ownerId: asset.contract.id,
        path: "contract.request.query[0].componentId",
        targetId: exampleComponent.id,
      }),
      expect.objectContaining({
        code: "ASSET_REFERENCE_MISSING",
        ownerId: asset.contract.id,
        path: "contract.request.body.schema.modelId",
        targetId: "00000000-0000-4000-8000-000000000199",
      }),
    ]));
    expect(context.getContract(asset.contract.id)?.id).toBe(asset.contract.id);
    expect(context.checkGate("publish")).toMatchObject({ ok: false });
    expect(context.checkGate("execution", asset.contract.id)).toMatchObject({ ok: false });
  });

  it("uses the selected case request for execution gates while managing every stored reference", () => {
    const asset = apiAsset("00000000-0000-4000-8000-000000000161");
    const defaultRequest = asset.contract.request;
    if (defaultRequest.protocol !== "http") throw new Error("Fixture must use HTTP.");
    defaultRequest.query = [ParameterBindingSchema.parse(parameterReference("00000000-0000-4000-8000-000000000199", "00000000-0000-4000-8000-000000000198"))];
    defaultRequest.headers = [
      ParameterBindingSchema.parse({ kind: "inline", id: "00000000-0000-4000-8000-000000000196", name: "X-Request", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "first" }),
      ParameterBindingSchema.parse({ kind: "inline", id: "00000000-0000-4000-8000-000000000197", name: "x-request", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "second" }),
    ];
    asset.cases = [{
      id: "case-clean-effective-request",
      name: "clean case",
      scope: "local",
      parameters: {},
      preOperations: [],
      postOperations: [],
      assertions: [],
      requestOverride: { ...defaultRequest, query: [], headers: [], body: { kind: "none" } },
    }];
    asset.cases.push({
      ...asset.cases[0]!,
      id: "case-with-separate-bad-reference",
      scope: "unselected",
      requestOverride: { ...defaultRequest, path: "/unselected", body: { kind: "none" } },
    });
    const context = createProjectAssetContext({ projectId, assets: [asset], models: [], components: [] });

    expect(context.checkGate("execution", asset.contract.id).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ASSET_REFERENCE_MISSING", path: "contract.request.query[0].componentId" }),
    ]));
    expect(context.checkGate("execution", asset.contract.id, asset.cases[0]!.requestOverride).ok).toBe(true);
    expect(context.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ASSET_REFERENCE_MISSING", path: "contract.request.query[0].componentId" }),
      expect.objectContaining({ code: "ASSET_REFERENCE_MISSING", path: "cases[1].requestOverride.query[0].componentId" }),
      expect.objectContaining({ code: "ASSET_PARAMETER_NAME_DUPLICATE", path: "contract.request.headers[1].name" }),
      expect.objectContaining({ code: "ASSET_PARAMETER_NAME_DUPLICATE", path: "cases[1].requestOverride.headers[1].name" }),
    ]));
    expect(context.checkGate("publish", asset.contract.id).diagnostics).toContainEqual(expect.objectContaining({
      code: "ASSET_PARAMETER_NAME_DUPLICATE",
      path: "cases[1].requestOverride.headers[1].name",
    }));
  });

  it("diagnoses effective parameter and response design conflicts without rejecting cross-location names", () => {
    const asset = apiAsset("00000000-0000-4000-8000-000000000121");
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    request.pathParams = [ParameterBindingSchema.parse({
      kind: "inline", id: "00000000-0000-4000-8000-000000000151", name: "token",
      schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "",
    })];
    request.query = [ParameterBindingSchema.parse({
      kind: "inline", id: "00000000-0000-4000-8000-000000000152", name: "token",
      schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "",
    })];
    request.headers = [
      ParameterBindingSchema.parse({
        kind: "inline", id: "00000000-0000-4000-8000-000000000153", name: "Authorization",
        schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "",
      }),
      ParameterBindingSchema.parse(parameterReference(parameterComponentId, "00000000-0000-4000-8000-000000000154")),
    ];
    request.cookies = [ParameterBindingSchema.parse(parameterReference("00000000-0000-4000-8000-000000000155", "00000000-0000-4000-8000-000000000156"))];

    const headerComponent = parameterComponent();
    headerComponent.definition.location = "header";
    headerComponent.definition.name = "authorization";
    const wrongLocationComponent = parameterComponent();
    wrongLocationComponent.id = "00000000-0000-4000-8000-000000000155";
    wrongLocationComponent.definition.location = "query";
    const response = ComponentAssetSchema.parse(componentFixtures()[2]);
    if (response.kind !== "response") throw new Error("Fixture must be a response component.");
    response.definition.status = "200";
    response.definition.content = {
      "application/json": { schema: { kind: "scalar", type: "string" }, examples: [] },
      "text/plain": { examples: [] },
    };
    asset.contract.responses = [
      {
        kind: "inline", id: "00000000-0000-4000-8000-000000000157", status: "200", description: "",
        headers: {}, content: { "application/json": { schema: { kind: "scalar", type: "string" }, examples: [] } },
      },
      { kind: "componentRef", id: "00000000-0000-4000-8000-000000000158", componentId: response.id, expectedKind: "response" },
    ];
    const context = createProjectAssetContext({
      projectId,
      assets: [asset],
      models: [],
      components: [headerComponent, wrongLocationComponent, response],
    });

    expect(context.diagnostics).toEqual(expect.arrayContaining([
      {
        code: "ASSET_PARAMETER_NAME_DUPLICATE",
        ownerId: asset.contract.id,
        path: "contract.request.headers[1].componentId",
      },
      {
        code: "ASSET_PARAMETER_LOCATION_MISMATCH",
        ownerId: asset.contract.id,
        path: "contract.request.cookies[0].componentId",
        targetId: wrongLocationComponent.id,
      },
      {
        code: "ASSET_RESPONSE_STATUS_CONTENT_TYPE_DUPLICATE",
        ownerId: asset.contract.id,
        path: "contract.responses[1]",
        targetId: response.id,
      },
    ]));
    expect(context.diagnostics.filter((diagnostic) => diagnostic.code === "ASSET_PARAMETER_NAME_DUPLICATE")).toHaveLength(1);
  });

  it("scopes publish diagnostics to the selected contract and its design dependencies", () => {
    const selected = apiAsset("00000000-0000-4000-8000-000000000122");
    const selectedRequest = selected.contract.request;
    if (selectedRequest.protocol !== "http") throw new Error("Fixture must use HTTP.");
    selectedRequest.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: "00000000-0000-4000-8000-000000000199" } };
    selectedRequest.query = [ParameterBindingSchema.parse(parameterReference("00000000-0000-4000-8000-000000000009", "00000000-0000-4000-8000-000000000159"))];
    selectedRequest.headers = [ParameterBindingSchema.parse(parameterReference(parameterComponentId, "00000000-0000-4000-8000-000000000160"))];
    selected.contract.responses = [{
      kind: "componentRef", id: "00000000-0000-4000-8000-000000000161",
      componentId: "00000000-0000-4000-8000-000000000162", expectedKind: "response",
    }];

    const unrelated = apiAsset("00000000-0000-4000-8000-000000000123");
    const unrelatedRequest = unrelated.contract.request;
    if (unrelatedRequest.protocol !== "http") throw new Error("Fixture must use HTTP.");
    unrelatedRequest.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: "00000000-0000-4000-8000-000000000198" } };
    unrelated.contract.responses = [];

    const clean = apiAsset("00000000-0000-4000-8000-000000000124");
    const cleanRequest = clean.contract.request;
    if (cleanRequest.protocol !== "http") throw new Error("Fixture must use HTTP.");
    cleanRequest.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    clean.contract.responses = [];

    const parameter = parameterComponent();
    const duplicateParameter = parameterComponent();
    duplicateParameter.name = "Ambiguous parameter";
    const example = ComponentAssetSchema.parse(componentFixtures()[3]);
    const context = createProjectAssetContext({
      projectId,
      assets: [selected, unrelated, clean],
      models: [],
      components: [parameter, duplicateParameter, example],
    });

    const selectedResult = context.checkGate("publish", selected.contract.id);
    expect(selectedResult.ok).toBe(false);
    expect(selectedResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ASSET_REFERENCE_MISSING", ownerId: selected.contract.id, path: "contract.request.body.schema.modelId" }),
      expect.objectContaining({ code: "ASSET_REFERENCE_KIND_MISMATCH", ownerId: selected.contract.id, path: "contract.request.query[0].componentId" }),
      expect.objectContaining({ code: "ASSET_ID_DUPLICATE", ownerId: selected.contract.id, path: "contract.request.headers[0].componentId" }),
      expect.objectContaining({ code: "ASSET_REFERENCE_MISSING", ownerId: selected.contract.id, path: "contract.responses[0].componentId" }),
    ]));
    expect(selectedResult.diagnostics.every((diagnostic) => diagnostic.ownerId !== unrelated.contract.id)).toBe(true);
    expect(context.checkGate("publish").ok).toBe(false);
    expect(context.checkGate("publish", clean.contract.id)).toEqual({ ok: true, diagnostics: [] });
  });

  it("tracks nested model refs in all four inline request parameter groups", () => {
    const asset = apiAsset("00000000-0000-4000-8000-000000000105");
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    asset.contract.responses = [];
    const reference = (id: string, schema: SchemaNode) => ParameterBindingSchema.parse({
      kind: "inline",
      id,
      name: "input",
      schema,
      required: false,
      enabled: true,
      description: "",
    });
    request.pathParams = [reference("00000000-0000-4000-8000-000000000141", {
      kind: "object",
      properties: { nested: { kind: "array", items: { kind: "modelRef", modelId } } },
      required: [],
      additionalProperties: false,
    })];
    request.query = [reference("00000000-0000-4000-8000-000000000142", {
      kind: "array",
      items: { kind: "modelRef", modelId },
    })];
    request.headers = [reference("00000000-0000-4000-8000-000000000143", {
      kind: "allOf",
      variants: [{ kind: "modelRef", modelId }],
    })];
    request.cookies = [reference("00000000-0000-4000-8000-000000000144", { kind: "modelRef", modelId })];
    const target = ModelAssetSchema.parse({ ...modelAssetFixture(), id: modelId, schema: { kind: "scalar", type: "string" } });
    const context = createProjectAssetContext({ projectId, assets: [asset], models: [target], components: [] });

    expect(context.referencesTo(modelId).map((reference) => reference.path)).toEqual([
      "contract.request.pathParams[0].schema.properties[\"nested\"].items.modelId",
      "contract.request.query[0].schema.items.modelId",
      "contract.request.headers[0].schema.variants[0].modelId",
      "contract.request.cookies[0].schema.modelId",
    ]);
    expect(context.dependencyClosure(asset.contract.id).models.map((item) => item.id)).toEqual([modelId]);
    expect(context.delete(modelId)).toMatchObject({ ok: false, code: "ASSET_REFERENCED" });
    expect(context.diagnostics).toEqual([]);
    expect(context.checkGate("publish")).toEqual({ ok: true, diagnostics: [] });
    expect(context.checkGate("execution", asset.contract.id)).toEqual({ ok: true, diagnostics: [] });
  });

  it("blocks publish and selected execution for missing or wrong-kind inline parameter models", () => {
    const asset = apiAsset("00000000-0000-4000-8000-000000000106");
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    asset.contract.responses = [];
    request.query = [
      ParameterBindingSchema.parse({
        kind: "inline",
        id: "00000000-0000-4000-8000-000000000145",
        name: "missing",
        schema: { kind: "modelRef", modelId: "00000000-0000-4000-8000-000000000199" },
        required: false,
        enabled: true,
        description: "",
      }),
      ParameterBindingSchema.parse({
        kind: "inline",
        id: "00000000-0000-4000-8000-000000000146",
        name: "wrong-kind",
        schema: { kind: "modelRef", modelId: parameterComponentId },
        required: false,
        enabled: true,
        description: "",
      }),
    ];
    const context = createProjectAssetContext({
      projectId,
      assets: [asset],
      models: [],
      components: [parameterComponent()],
    });

    expect(context.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ASSET_REFERENCE_MISSING",
        ownerId: asset.contract.id,
        path: "contract.request.query[0].schema.modelId",
        targetId: "00000000-0000-4000-8000-000000000199",
      }),
      expect.objectContaining({
        code: "ASSET_REFERENCE_KIND_MISMATCH",
        ownerId: asset.contract.id,
        path: "contract.request.query[1].schema.modelId",
        targetId: parameterComponentId,
      }),
    ]));
    expect(context.checkGate("publish").ok).toBe(false);
    expect(context.checkGate("execution", asset.contract.id).ok).toBe(false);
  });

  it("diagnoses duplicate project asset IDs at a stable location", () => {
    const component = parameterComponent();
    const duplicate = { ...component, name: "Duplicate" };
    const context = createProjectAssetContext({ projectId, assets: [], models: [], components: [component, duplicate] });

    expect(context.diagnostics).toContainEqual({
      code: "ASSET_ID_DUPLICATE",
      ownerId: component.id,
      path: "components[1].id",
      targetId: component.id,
    });
    expect(context.getComponent(component.id)).toBeUndefined();
  });

  it("blocks execution when a selected request target is ambiguous because its asset ID is duplicated", () => {
    const asset = apiAsset("00000000-0000-4000-8000-000000000104", parameterComponentId);
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    asset.contract.responses = [];
    const component = parameterComponent();
    const duplicate = { ...component, name: "Ambiguous parameter" };
    const context = createProjectAssetContext({ projectId, assets: [asset], models: [], components: [component, duplicate] });

    expect(context.checkGate("execution", asset.contract.id)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "ASSET_ID_DUPLICATE",
        ownerId: asset.contract.id,
        path: "contract.request.query[0].componentId",
        targetId: component.id,
      })],
    });
  });

  it("allows finite structural recursion between models", () => {
    const firstModelId = "00000000-0000-4000-8000-000000000110";
    const secondModelId = "00000000-0000-4000-8000-000000000111";
    const component = parameterComponent();
    component.definition.location = "query";
    component.definition.schema = { kind: "modelRef", modelId: firstModelId };
    const auth = ComponentAssetSchema.parse(componentFixtures()[1]);
    const response = ComponentAssetSchema.parse(componentFixtures()[2]);
    const example = ComponentAssetSchema.parse(componentFixtures()[3]);
    if (auth.kind !== "auth" || response.kind !== "response" || example.kind !== "example") throw new Error("Fixture component kinds changed.");
    response.definition.content["application/json"].schema = { kind: "modelRef", modelId: firstModelId };
    response.definition.content["application/json"].examples = [{
      kind: "componentRef",
      id: "00000000-0000-4000-8000-000000000133",
      componentId: example.id,
      expectedKind: "example",
    }];
    const asset = apiAsset("00000000-0000-4000-8000-000000000112");
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.query = [ParameterBindingSchema.parse(parameterReference(component.id, "00000000-0000-4000-8000-000000000131"))];
    request.auth = { kind: "componentRef", componentId: auth.id, expectedKind: "auth" };
    request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    asset.contract.responses = [{
      kind: "componentRef",
      id: "00000000-0000-4000-8000-000000000134",
      componentId: response.id,
      expectedKind: "response",
    }];
    const context = createProjectAssetContext({
      projectId,
      assets: [asset],
      models: [
        ModelAssetSchema.parse({ ...modelAssetFixture(), id: firstModelId, schema: {
          kind: "object",
          properties: { next: { kind: "modelRef", modelId: secondModelId } },
          required: [],
          additionalProperties: false,
        } }),
        ModelAssetSchema.parse({ ...modelAssetFixture(), id: secondModelId, schema: {
          kind: "object",
          properties: { previous: { kind: "modelRef", modelId: firstModelId } },
          required: [],
          additionalProperties: false,
        } }),
      ],
      components: [component, auth, response, example],
    });

    const closure = context.dependencyClosure(asset.contract.id);
    expect(closure.assets.map((item) => item.contract.id)).toEqual([asset.contract.id]);
    expect(closure.components.map((item) => item.id)).toEqual([component.id, auth.id, response.id, example.id]);
    expect(closure.models.map((item) => item.id).sort()).toEqual([firstModelId, secondModelId]);
    expect(context.diagnostics).toEqual([]);
    expect(context.checkGate("publish")).toEqual({ ok: true, diagnostics: [] });
    expect(context.checkGate("execution", asset.contract.id)).toEqual({ ok: true, diagnostics: [] });
  });

  it("diagnoses pure self and multi-model reference cycles while keeping closure finite", () => {
    const api = apiAsset("00000000-0000-4000-8000-000000000107");
    const request = api.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: modelId } };
    api.contract.responses = [];
    const selfCycle = model(modelId, modelId);
    const context = createProjectAssetContext({ projectId, assets: [api], models: [selfCycle], components: [] });

    expect(context.diagnostics).toContainEqual({
      code: "ASSET_MODEL_REFERENCE_CYCLE",
      ownerId: modelId,
      path: "models[0].schema.modelId",
      targetId: modelId,
    });
    expect(context.checkGate("publish").ok).toBe(false);
    expect(context.checkGate("execution", api.contract.id).diagnostics).toContainEqual(expect.objectContaining({
      code: "ASSET_MODEL_REFERENCE_CYCLE",
      ownerId: modelId,
      targetId: modelId,
    }));
    expect(context.dependencyClosure(api.contract.id).models.map((item) => item.id)).toEqual([modelId]);

    const secondModelId = "00000000-0000-4000-8000-000000000111";
    const ring = createProjectAssetContext({
      projectId,
      assets: [api],
      models: [model(modelId, secondModelId), model(secondModelId, modelId)],
      components: [],
    });
    expect(ring.diagnostics.filter((diagnostic) => diagnostic.code === "ASSET_MODEL_REFERENCE_CYCLE")).toEqual([
      expect.objectContaining({ ownerId: modelId, targetId: secondModelId }),
      expect.objectContaining({ ownerId: secondModelId, targetId: modelId }),
    ]);
    expect(ring.checkGate("execution", api.contract.id).ok).toBe(false);
  });

  it("does not let a pure reference ring in an unrelated response block request execution", () => {
    const asset = apiAsset("00000000-0000-4000-8000-000000000108");
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    asset.contract.responses = [{
      kind: "inline",
      id: "00000000-0000-4000-8000-000000000147",
      status: "400",
      description: "response only",
      headers: {},
      content: { "application/json": { schema: { kind: "modelRef", modelId }, examples: [] } },
    }];
    const secondModelId = "00000000-0000-4000-8000-000000000111";
    const context = createProjectAssetContext({
      projectId,
      assets: [asset],
      models: [model(modelId, secondModelId), model(secondModelId, modelId)],
      components: [],
    });

    expect(context.diagnostics.filter((diagnostic) => diagnostic.code === "ASSET_MODEL_REFERENCE_CYCLE")).toHaveLength(2);
    expect(context.checkGate("publish").ok).toBe(false);
    expect(context.checkGate("execution", asset.contract.id)).toEqual({ ok: true, diagnostics: [] });
  });

  it("lets a negative request execute when only its response definition is incomplete", () => {
    const asset = apiAsset("00000000-0000-4000-8000-000000000120");
    asset.cases = [{
      id: "negative-case",
      name: "invalid input is rejected by the server",
      scope: "base",
      parameters: { quantity: "-1" },
      preOperations: [],
      postOperations: [],
      assertions: [],
    }];
    const request = asset.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    request.body = { kind: "json", content: "{\"quantity\":-1}", schema: { kind: "scalar", type: "string" } };
    asset.contract.responses = [{
      kind: "componentRef",
      id: "00000000-0000-4000-8000-000000000132",
      componentId: "00000000-0000-4000-8000-000000000199",
      expectedKind: "response",
    }];
    const context = createProjectAssetContext({ projectId, assets: [asset], models: [], components: [] });

    expect(context.diagnostics).toContainEqual(expect.objectContaining({
      code: "ASSET_REFERENCE_MISSING",
      path: "contract.responses[0].componentId",
    }));
    expect(context.checkGate("execution", asset.contract.id)).toEqual({ ok: true, diagnostics: [] });
    expect(context.checkGate("publish")).toMatchObject({ ok: false });
  });

  it("does not expose a mutable internal asset index", () => {
    const component = parameterComponent();
    const context = createProjectAssetContext({ projectId, assets: [], models: [], components: [component] });
    const firstRead = context.getComponent(component.id);
    if (!firstRead) throw new Error("Component should exist.");
    Reflect.set(firstRead, "name", "Outside edit");

    expect(context.getComponent(component.id)?.name).toBe("User ID");
  });

  it("accepts a recursive schema through model refs without expanding the referenced model inline", () => {
    const recursive = ModelAssetSchema.parse({
      ...modelAssetFixture(),
      schema: {
        kind: "object",
        properties: { next: { kind: "modelRef", modelId } },
        required: [],
        additionalProperties: false,
      },
    });
    const context = createProjectAssetContext({ projectId, assets: [], models: [recursive], components: [] });

    expect(context.diagnostics).toEqual([]);
    expect(context.dependencyClosure(recursive.id).models.map((item) => item.id)).toEqual([recursive.id]);
  });
});
