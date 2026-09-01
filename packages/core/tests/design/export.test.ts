import { describe, expect, it } from "vitest";
import { renderDesignMarkdown } from "../../src/design/export.js";
import type { ApiDefinition } from "../../src/domain/model.js";

const api: ApiDefinition = {
  id: "a1", name: "create-order", version: "1.2.0", deprecated: false,
  method: "POST", url: "{{baseUrl}}/orders",
  headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
  query: [],
  body: { kind: "json", content: '{"type":"object","required":["sku"]}' },
  design: "# 业务规则\n- 库存不足时返回 409",
  cases: [
    { id: "t1", name: "ok", scope: "base", parameters: {}, assertions: [] },
    { id: "t2", name: "conflict", scope: "sit", parameters: {}, assertions: [] },
  ],
};

describe("renderDesignMarkdown", () => {
  it("输出定义、schema、详细设计与用例清单", () => {
    const md = renderDesignMarkdown(api);
    expect(md).toContain("POST {{baseUrl}}/orders");
    expect(md).toContain("1.2.0");
    expect(md).toContain('"required":["sku"]');
    expect(md).toContain("库存不足时返回 409");
    expect(md).toContain("ok");
    expect(md).toContain("conflict");
  });
});
