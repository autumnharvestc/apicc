import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { ContractProjectSchema, ContractWorkspaceSchema, type ContractProject } from "../../src/contract/workspace.js";
import { ParameterBindingSchema } from "../../src/contract/model.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";

function fixtureProject(): ContractProject {
  return ContractWorkspaceSchema.parse(workspaceFixture()).groups[0].projects[0];
}

function revisionAfter(change: (project: ContractProject) => void): string {
  const project = fixtureProject();
  const baseline = createProjectSnapshot(project).definitionRevision;
  change(project);
  const changed = createProjectSnapshot(project).definitionRevision;
  expect(changed).not.toBe(baseline);
  return changed;
}

const assertionOptionalFields = ["expected", "headerName", "path"] as const;

describe("project snapshots", () => {
  it("hashes the complete project definition, including shared settings, environments, containers and workflow", () => {
    revisionAfter((project) => { project.variables.global = "changed"; });
    revisionAfter((project) => { project.globals.headers.push({ key: "X-Global", value: "changed", enabled: true }); });
    revisionAfter((project) => { project.environments[0].baseUrls[project.collections[0].id] = "https://new.example.test"; });
    revisionAfter((project) => { project.collections[0].variables.moduleValue = "changed"; });
    revisionAfter((project) => { project.collections[0].preOperations[0].content = "changed ancestor operation"; });
    revisionAfter((project) => { project.collections[0].folders[0].preOperations.push({ id: "folder-op", type: "script", content: "changed" }); });
    revisionAfter((project) => { project.workflows[0].name = "changed workflow"; });
    revisionAfter((project) => { project.stressPolicy.maxConcurrency = 7; });
    revisionAfter((project) => { project.models[0].name = "changed model"; });
    revisionAfter((project) => { project.components[0].name = "changed component"; });
    revisionAfter((project) => { project.collections[0].apis[0].documentation = "changed API"; });
  });

  it("uses canonical object-key order while retaining array order", () => {
    const first = fixtureProject();
    const second = structuredClone(first);
    first.variables = JSON.parse('{"z":"last","a":"first"}') as Record<string, string>;
    second.variables = JSON.parse('{"a":"first","z":"last"}') as Record<string, string>;

    expect(createProjectSnapshot(first).definitionRevision).toBe(createProjectSnapshot(second).definitionRevision);

    const ordered = fixtureProject();
    ordered.workflows.push({ ...structuredClone(ordered.workflows[0]), id: "workflow-second", name: "Second workflow" });
    const reversed = structuredClone(ordered);
    reversed.workflows.reverse();
    expect(createProjectSnapshot(ordered).definitionRevision).not.toBe(createProjectSnapshot(reversed).definitionRevision);
  });

  it("hashes formal optional undefined fields as omitted while retaining strict JSON boundaries", () => {
    const explicitUndefined = fixtureProject();
    const api = explicitUndefined.collections[0].apis[0];
    const request = api.contract.request;
    if (request.protocol !== "http") throw new Error("Fixture must use HTTP.");
    explicitUndefined.environments[0].extends = undefined;
    request.query.push(ParameterBindingSchema.parse({
      kind: "inline",
      id: "00000000-0000-4000-8000-000000000901",
      name: "optional value",
      schema: {
        kind: "scalar",
        type: "string",
        description: undefined,
        default: undefined,
        examples: undefined,
        enum: undefined,
      },
      required: false,
      enabled: true,
      description: "",
      value: undefined,
    }));
    request.body = { kind: "graphql", query: "query { ok }", variables: undefined, operationName: undefined };
    api.contract.responses = [{
      kind: "inline",
      id: "00000000-0000-4000-8000-000000000902",
      status: "200",
      description: "ok",
      headers: {},
      content: { "application/json": { schema: undefined, examples: [] } },
    }];
    explicitUndefined.workflows[0].nodes.push({ id: "optional-node", kind: "noop", label: undefined, position: undefined });
    explicitUndefined.workflows[0].edges.push({ id: "optional-edge", from: "optional-node", to: "optional-node", condition: undefined });
    explicitUndefined.stressPolicy.maxConcurrency = undefined;
    explicitUndefined.stressPolicy.maxRps = undefined;

    expect(ContractProjectSchema.safeParse(explicitUndefined).success).toBe(true);
    const omitted = structuredClone(explicitUndefined);
    delete omitted.environments[0].extends;
    expect(ContractProjectSchema.safeParse(omitted).success).toBe(true);
    expect(createProjectSnapshot(explicitUndefined).definitionRevision).toBe(createProjectSnapshot(omitted).definitionRevision);

    const invalidJsonValue = fixtureProject();
    Reflect.set(invalidJsonValue.models[0].schema, "default", { nested: undefined });
    expect(ContractProjectSchema.safeParse(invalidJsonValue).success).toBe(false);
    expect(() => createProjectSnapshot(invalidJsonValue)).toThrow();

    const invalidArrayValue = fixtureProject();
    Reflect.set(invalidArrayValue.models[0].schema, "examples", [undefined]);
    expect(ContractProjectSchema.safeParse(invalidArrayValue).success).toBe(false);
    expect(() => createProjectSnapshot(invalidArrayValue)).toThrow();

    const sparseArrayValue = fixtureProject();
    Reflect.set(sparseArrayValue.models[0].schema, "examples", new Array(1));
    expect(() => createProjectSnapshot(sparseArrayValue)).toThrow();

    const unknownUndefined = fixtureProject();
    Reflect.set(unknownUndefined, "unknownField", undefined);
    expect(ContractProjectSchema.safeParse(unknownUndefined).success).toBe(false);
    expect(() => createProjectSnapshot(unknownUndefined)).toThrow();

    const defaultedUndefined = fixtureProject();
    Reflect.set(defaultedUndefined.collections[0], "variables", undefined);
    expect(ContractProjectSchema.safeParse(defaultedUndefined).success).toBe(true);
    expect(() => createProjectSnapshot(defaultedUndefined)).toThrow();
  });

  it.each(assertionOptionalFields)("hashes parsed assertion.%s undefined the same as omission", (field) => {
    const source = fixtureProject();
    source.collections[0].apis[0].cases = [{
      id: "assertion-optional-case",
      name: "assertion optionals",
      scope: "base",
      parameters: {},
      preOperations: [],
      postOperations: [],
      assertions: [{ id: "assertion-optional", target: "status", op: "eq", expected: "200" }],
    }];
    Reflect.set(source.collections[0].apis[0].cases[0].assertions[0], field, undefined);
    const parsed = ContractProjectSchema.parse(source);
    const parsedAssertion = parsed.collections[0].apis[0].cases[0].assertions[0];

    expect(Object.hasOwn(parsedAssertion, field)).toBe(true);
    expect(ContractProjectSchema.safeParse(parsed).success).toBe(true);

    const omitted = structuredClone(parsed);
    const omittedAssertion = omitted.collections[0].apis[0].cases[0].assertions[0];
    expect(Reflect.deleteProperty(omittedAssertion, field)).toBe(true);
    expect(ContractProjectSchema.safeParse(omitted).success).toBe(true);
    expect(createProjectSnapshot(parsed).definitionRevision).toBe(createProjectSnapshot(omitted).definitionRevision);
  });

  it("deep-copies and freezes the full definition while its context indexes that same frozen copy", () => {
    const project = fixtureProject();
    const originalName = project.collections[0].apis[0].contract.metadata.name;
    const snapshot = createProjectSnapshot(project);
    const frozenApi = snapshot.project.collections[0].apis[0];

    expect(snapshot.definitionRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(snapshot.project)).toBe(true);
    expect(Object.isFrozen(snapshot.project.collections)).toBe(true);
    expect(Object.isFrozen(snapshot.project.collections[0].apis[0].contract.metadata)).toBe(true);
    expect(snapshot.context.getContract(frozenApi.contract.id)).toBe(frozenApi.contract);
    expect(Object.isFrozen(snapshot.context.getContract(frozenApi.contract.id))).toBe(true);

    project.collections[0].apis[0].contract.metadata.name = "caller edit";
    project.environments[0].variables.changed = "caller edit";
    expect(snapshot.project.collections[0].apis[0].contract.metadata.name).toBe(originalName);
    expect(snapshot.project.environments[0].variables.changed).toBeUndefined();
    expect(Reflect.set(frozenApi.contract.metadata, "name", "context edit")).toBe(false);
  });

  it("preserves own __proto__ dictionary entries in a frozen snapshot", () => {
    const project = fixtureProject();
    project.variables = JSON.parse('{"__proto__":"kept","ordinary":"value"}') as Record<string, string>;
    const snapshot = createProjectSnapshot(project);

    expect(Object.keys(snapshot.project.variables)).toEqual(["__proto__", "ordinary"]);
    expect(snapshot.project.variables["__proto__"]).toBe("kept");
    expect(snapshot.definitionRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps an already-created snapshot stable when a later definition produces a new revision", () => {
    const project = fixtureProject();
    const running = createProjectSnapshot(project);
    const changed = structuredClone(project);
    changed.globals.headers.push({ key: "X-Run", value: "new", enabled: true });
    changed.environments[0].baseUrls[changed.collections[0].id] = "https://new.example.test";
    changed.collections[0].variables.moduleValue = "new";
    changed.collections[0].preOperations[0].content = "new operation";
    const nextRun = createProjectSnapshot(changed);

    expect(nextRun.definitionRevision).not.toBe(running.definitionRevision);
    expect(nextRun.project.globals.headers).toEqual([{ key: "X-Run", value: "new", enabled: true }]);
    expect(nextRun.project.environments[0].baseUrls[changed.collections[0].id]).toBe("https://new.example.test");
    expect(nextRun.project.collections[0].variables.moduleValue).toBe("new");
    expect(nextRun.project.collections[0].preOperations[0].content).toBe("new operation");
    expect(running.project.globals.headers).toEqual([]);
    expect(running.project.environments[0].baseUrls).toEqual({});
    expect(running.project.collections[0].variables).toEqual({});
    expect(running.project.collections[0].preOperations[0].content).toBe("collectionReady = true;");
  });
});
