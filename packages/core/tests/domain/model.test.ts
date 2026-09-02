import { describe, expect, it } from "vitest";
import { ApiDefinitionSchema, TestCaseSchema } from "../../src/domain/model.js";

describe("域 schema", () => {
  it("接受合法接口定义", () => {
    const api = {
      id: "01J5M8Z9Q2V3K4M5N6P7Q8R9S0",
      name: "create-order",
      version: "1.0.0",
      method: "POST",
      url: "{{baseUrl}}/orders",
      headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
      query: [],
      body: { kind: "json", content: '{"sku":"A1"}' },
      cases: [],
    };
    expect(ApiDefinitionSchema.parse(api).method).toBe("POST");
  });

  it("拒绝未知字段与非法 method", () => {
    expect(() =>
      TestCaseSchema.parse({ id: "x", name: "c", scope: "base", nonsense: 1 }),
    ).toThrow();
    expect(() =>
      ApiDefinitionSchema.parse({ id: "x", name: "a", version: "1", method: "TELEPORT", url: "/", headers: [], query: [], cases: [] }),
    ).toThrow();
  });
});
