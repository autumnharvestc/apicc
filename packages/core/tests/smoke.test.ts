import { describe, expect, it } from "vitest";
import * as Core from "../src/index.js";

describe("smoke", () => {
  it("exports version", () => {
    expect(Core.version).toBe("0.1.0");
  });

  it("默认注册中心已装配全部内置插件", () => {
    const reg = Core.createDefaultRegistry();
    expect(reg.getStorage()).toBeDefined();
    expect(reg.getScriptEngine("javascript")).toBeDefined();
    expect(reg.getReporter("html")).toBeDefined();
    expect(reg.getReporter("junit")).toBeDefined();
    expect(reg.listImporters()).toHaveLength(2);
    expect(reg.listAsserts().length).toBeGreaterThanOrEqual(7);
  });

  it("exposes the explicit host API without internal capture, clone, or stress-container helpers", () => {
    expect(Core.createProjectAssetContext).toBeTypeOf("function");
    expect(Core.createProjectSnapshot).toBeTypeOf("function");
    expect(Core.cloneProjectDefinition).toBeTypeOf("function");
    expect(Core.prepareCredentialBindings).toBeTypeOf("function");
    expect(Core.createSystemSecretStore).toBeTypeOf("function");
    expect(Core.materializeRequest).toBeTypeOf("function");
    expect(Core.createStressCaseSession).toBeTypeOf("function");

    const publicExports = Core as unknown as Record<string, unknown>;
    expect(publicExports.captureProjectExecutionRun).toBeUndefined();
    expect(publicExports.cloneDefinitionValue).toBeUndefined();
    expect(publicExports.createReadonlyProjectAssetContext).toBeUndefined();
    expect(publicExports.StressCaseContainer).toBeUndefined();
  });

  it("does not forward runtime-only backend injection fields from the public store factory", () => {
    let backendLoaderReads = 0;
    const options = {
      privateRoot: ".apicc/private",
      get loadBackend(): () => Promise<never> {
        backendLoaderReads += 1;
        throw new Error("public factory forwarded backend injection");
      },
    };

    expect(() => Core.createSystemSecretStore(options)).not.toThrow();
    expect(backendLoaderReads).toBe(0);
  });
});
