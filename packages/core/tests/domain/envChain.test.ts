import { describe, expect, it } from "vitest";
import { envChain } from "../../src/domain/envChain.js";
import type { Environment, Project } from "../../src/domain/model.js";

const project: Project = {
  id: "p1", name: "proj", variables: {},
  environments: [
    { id: "e1", name: "dev", variables: {} },
    { id: "e2", name: "sit", extends: "dev", variables: {} },
    { id: "e3", name: "press", extends: "sit", variables: {} },
  ],
  collections: [],
};

describe("envChain", () => {
  it("press 展开为 press→sit→dev", () => {
    const press = project.environments[2] as Environment;
    expect(envChain(press, project)).toEqual(["press", "sit", "dev"]);
  });
  it("无继承时只含自身", () => {
    expect(envChain(project.environments[0] as Environment, project)).toEqual(["dev"]);
  });
});
