import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { StringRecordSchema, TestCaseSchema } from "../../src/schema.js";

describe("renderer-safe schema entry", () => {
  it("exports shared operation and dictionary schemas without the Core runtime entry", async () => {
    const testCase = TestCaseSchema.parse({ id: "case-1", name: "case" });
    expect(testCase.preOperations).toEqual([]);
    expect(testCase.postOperations).toEqual([]);

    const source = JSON.parse('{"__proto__":"kept"}') as Record<string, unknown>;
    const parsed = StringRecordSchema(z.string()).parse(source);
    expect(Object.keys(parsed)).toEqual(["__proto__"]);
    expect(parsed["__proto__"]).toBe("kept");

    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(manifest.exports?.["./assets/context"]).toEqual({
      types: "./dist/assets/context.d.ts",
      default: "./dist/assets/context.js",
    });
    const onlineStore = readFileSync(
      new URL("../../../../apps/desktop/src/renderer/src/stores/online.ts", import.meta.url),
      "utf8",
    );
    expect(onlineStore).toMatch(/import\s*\{\s*createProjectAssetContext\s*\}\s*from\s*["']@apicc\/core\/assets\/context["']/);
    const contextEntry = await import("@apicc/core/assets/context");
    expect(typeof contextEntry.createProjectAssetContext).toBe("function");
  });
});
