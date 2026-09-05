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

describe("renderDesignMarkdown 多协议（M5 D5 最小适配）", () => {
  it("websocket 接口：协议行 + 消息模板块（http 接口输出不含协议行）", () => {
    const wsApi = {
      id: "w1", name: "ws-rt", version: "1", deprecated: false,
      protocol: "websocket", url: "{{wsUrl}}/rt", message: '{"ping":1}',
      headers: [], query: [], cases: [],
    } as unknown as ApiDefinition;
    const md = renderDesignMarkdown(wsApi);
    expect(md).toContain("- 协议：**websocket**");
    expect(md).toContain("ws-rt");
    expect(md).toContain("WebSocket：连接后发送以上消息模板");
    expect(renderDesignMarkdown({ ...api, protocol: undefined })).not.toContain("- 协议：");
  });

  it("soap 接口：协议行 + 信封块 + SOAPAction", () => {
    const soapApi = {
      id: "s1", name: "soap-add", version: "1", deprecated: false, method: "POST",
      protocol: "soap", url: "{{baseUrl}}/soap",
      envelope: "<Envelope/>", soapAction: "urn:add",
      headers: [], query: [], cases: [],
    } as unknown as ApiDefinition;
    const md = renderDesignMarkdown(soapApi);
    expect(md).toContain("- 协议：**soap**");
    expect(md).toContain("<Envelope/>");
    expect(md).toContain("SOAPAction: urn:add");
  });
});
