import { describe, expect, it } from "vitest";
import { createProjectSnapshot, type DeepReadonly } from "../../src/assets/snapshot.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../../src/domain/executionSelection.js";
import { contractExecutionIds, createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";

const collectionId = contractExecutionIds.collection;

function projectWithEnvironments(): ContractProject {
  const project = createContractExecutionProject("http://parent.example");
  project.environments = [
    { id: "env-parent", name: "parent", variables: { shared: "parent", parentOnly: "parent" }, baseUrls: { [collectionId]: "http://parent.example" } },
    { id: "env-child", name: "child", extends: "parent", variables: { shared: "child", childOnly: "child" }, baseUrls: {} },
    { id: "env-empty", name: "empty", extends: "parent", variables: {}, baseUrls: { [collectionId]: "" } },
  ];
  return project;
}

describe("selectEffectiveCases", () => {
  it("keeps logical ID order while selecting the closest applicable scope", () => {
    const versions = [
      { id: "shared", scope: "base", mark: "base" },
      { id: "second", scope: "base", mark: "second" },
      { id: "shared", scope: "parent", mark: "parent" },
      { id: "shared", scope: "child", mark: "child" },
    ];

    expect(selectEffectiveCases(versions, ["child", "parent"]).map((testCase) => testCase.mark))
      .toEqual(["child", "second"]);
    expect(selectEffectiveCases(versions, []).map((testCase) => testCase.mark))
      .toEqual(["base", "second"]);
    expect(selectEffectiveCases(versions, ["child", "parent"], "shared").map((testCase) => testCase.mark))
      .toEqual(["child"]);
    expect(selectEffectiveCases([{ id: "only", scope: "other" }], ["child"])).toEqual([]);
  });

  it("uses input order only to break ties at the same scope rank", () => {
    const firstOrder = [
      { id: "item", scope: "parent", mark: "parent-first" },
      { id: "item", scope: "child", mark: "child-first" },
      { id: "item", scope: "child", mark: "child-second" },
    ];
    const secondOrder = [firstOrder[2]!, firstOrder[0]!, firstOrder[1]!];

    expect(selectEffectiveCases(firstOrder, ["child", "parent"])[0]?.mark).toBe("child-first");
    expect(selectEffectiveCases(secondOrder, ["child", "parent"])[0]?.mark).toBe("child-second");
    expect(selectEffectiveCases([{ id: "ancestor", scope: "parent", mark: "ancestor" }], ["child", "parent"]))
      .toEqual([{ id: "ancestor", scope: "parent", mark: "ancestor" }]);
  });

  it("returns no result for a missing logical ID and isolates each API input", () => {
    const firstApi = [{ id: "shared", scope: "base", mark: "first-api" }, { id: "shared", scope: "child", mark: "first-child" }];
    const secondApi = [{ id: "shared", scope: "base", mark: "second-api" }];

    expect(selectEffectiveCases(firstApi, ["child"], "missing")).toEqual([]);
    expect(selectEffectiveCases(firstApi, ["child"]).map((testCase) => testCase.mark)).toEqual(["first-child"]);
    expect(selectEffectiveCases(secondApi, ["child"]).map((testCase) => testCase.mark)).toEqual(["second-api"]);
  });

  it("accepts readonly inputs and returns an independent array with the original element identities", () => {
    const frozenCases = Object.freeze([
      Object.freeze({ id: "item", scope: "base", label: "base" as const }),
      Object.freeze({ id: "item", scope: "child", label: "child" as const }),
    ]);
    const readonlyCases: readonly Readonly<{ id: string; scope: string; label: "base" | "child" }>[] = frozenCases;
    const selected = selectEffectiveCases(readonlyCases, Object.freeze(["child"]));

    expect(selected).not.toBe(readonlyCases);
    expect(selected[0]).toBe(frozenCases[1]);
    selected.push(frozenCases[0]!);
    expect(readonlyCases.map((testCase) => testCase.label)).toEqual(["base", "child"]);
  });
});

describe("resolveExecutionEnvironment", () => {
  it("inherits variables and the nearest defined collection base URL from the selected snapshot", () => {
    const snapshot = createProjectSnapshot(projectWithEnvironments());
    const environment = resolveExecutionEnvironment(snapshot.project, collectionId, "env-child");

    expect(environment).toMatchObject({
      chain: ["child", "parent"],
      variables: { shared: "child", parentOnly: "parent", childOnly: "child", baseUrl: "http://parent.example" },
      baseUrl: "http://parent.example",
    });
    expect(environment.environment).toBe(snapshot.project.environments[1]);
  });

  it("lets a child explicitly replace an inherited collection base URL with an empty string", () => {
    const snapshot = createProjectSnapshot(projectWithEnvironments());
    const environment = resolveExecutionEnvironment(snapshot.project, collectionId, "env-empty");

    expect(environment.chain).toEqual(["empty", "parent"]);
    expect(environment.baseUrl).toBe("");
    expect(environment.variables.baseUrl).toBe("");
  });

  it("leaves environment fields absent when no environment is selected", () => {
    const snapshot = createProjectSnapshot(projectWithEnvironments());
    const environment = resolveExecutionEnvironment(snapshot.project, collectionId);

    expect(environment).toEqual({ chain: [], variables: {} });
    expect("environment" in environment).toBe(false);
    expect("baseUrl" in environment).toBe(false);
  });

  it("returns independent variables without changing the frozen snapshot or later results", () => {
    const snapshot = createProjectSnapshot(projectWithEnvironments());
    const first = resolveExecutionEnvironment(snapshot.project, collectionId, "env-child");
    first.variables.shared = "caller-change";
    first.variables.baseUrl = "caller-url";

    const second = resolveExecutionEnvironment(snapshot.project, collectionId, "env-child");
    const readonlyProject: DeepReadonly<ContractProject> = snapshot.project;
    expect(readonlyProject.environments[1]?.variables.shared).toBe("child");
    expect(second.variables.shared).toBe("child");
    expect(second.baseUrl).toBe("http://parent.example");
  });

  it("rejects an unknown environment ID instead of choosing another environment", () => {
    const snapshot = createProjectSnapshot(projectWithEnvironments());

    expect(() => resolveExecutionEnvironment(snapshot.project, collectionId, "missing-env"))
      .toThrow("配置错误: 项目快照中不存在环境 missing-env");
  });
});
