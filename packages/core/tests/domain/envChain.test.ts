import { describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { envChain, mergedEnvVars } from "../../src/domain/envChain.js";
import type { Environment, Project } from "../../src/domain/model.js";
import { createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";

const project: Project = {
  id: "p1", name: "proj", variables: {},
  globals: { query: [], headers: [], cookies: [], body: [] },
  environments: [
    { id: "e1", name: "dev", variables: {}, baseUrls: {} },
    { id: "e2", name: "sit", extends: "dev", variables: {}, baseUrls: {} },
    { id: "e3", name: "press", extends: "sit", variables: {}, baseUrls: {} },
  ],
  collections: [],
  workflows: [],
  stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
  models: [],
  components: [],
};

describe("envChain", () => {
  it("press 展开为 press→sit→dev", () => {
    const press = project.environments[2] as Environment;
    expect(envChain(press, project)).toEqual(["press", "sit", "dev"]);
  });
  it("无继承时只含自身", () => {
    expect(envChain(project.environments[0] as Environment, project)).toEqual(["dev"]);
  });
  it("readonly snapshot inputs preserve the existing chain and parent-to-child variable merge", () => {
    const mutableProject = createContractExecutionProject("http://parent.example");
    mutableProject.environments = [
      { id: "e1", name: "dev", variables: { inherited: "dev", shared: "dev" }, baseUrls: {} },
      { id: "e2", name: "sit", extends: "dev", variables: {}, baseUrls: {} },
      { id: "e3", name: "press", extends: "sit", variables: { shared: "press" }, baseUrls: {} },
    ];
    const snapshot = createProjectSnapshot(mutableProject);
    const readonlyProject = snapshot.project;
    const environment = readonlyProject.environments[2]!;

    expect(envChain(environment, readonlyProject)).toEqual(["press", "sit", "dev"]);
    expect(mergedEnvVars(environment, readonlyProject)).toEqual({ inherited: "dev", shared: "press" });
  });
});
