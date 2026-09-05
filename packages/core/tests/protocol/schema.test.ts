import { describe, expect, it } from "vitest";
import { ApiDefinitionSchema } from "../../src/domain/model.js";

/** M4 旧 yaml 形状（无任何 M5 新字段）——零破坏基线。 */
const legacyApi = {
  id: "01J5M8Z9Q2V3K4M5N6P7Q8R9S0",
  name: "get-ok",
  version: "1.0.0",
  deprecated: false,
  method: "GET",
  url: "{{baseUrl}}/x",
  headers: [],
  query: [],
  cases: [],
};

describe("域 schema 协议演进（M5 D2）", () => {
  it("无 protocol 的旧 yaml 形状 parse 后 protocol 默认 http，其余字段原样", () => {
    const parsed = ApiDefinitionSchema.parse(legacyApi);
    expect(parsed.protocol).toBe("http");
    expect(parsed.method).toBe("GET");
    expect(parsed.url).toBe("{{baseUrl}}/x");
    expect(parsed).not.toHaveProperty("message");
    expect(parsed).not.toHaveProperty("envelope");
    expect(parsed).not.toHaveProperty("soapAction");
  });

  it("websocket 接口：message 可选，缺省 method 以 GET 填充（裁定④：旧形状含 method 仍合法）", () => {
    const withoutMethod = ApiDefinitionSchema.parse({
      ...legacyApi,
      protocol: "websocket",
      url: "ws://127.0.0.1:9000/echo",
      message: "hello {{name}}",
    });
    expect(withoutMethod.protocol).toBe("websocket");
    expect(withoutMethod.message).toBe("hello {{name}}");
    expect(withoutMethod.method).toBe("GET");

    const withMethod = ApiDefinitionSchema.parse({
      ...legacyApi,
      protocol: "websocket",
      url: "ws://127.0.0.1:9000/echo",
      method: "POST",
    });
    expect(withMethod.method).toBe("POST");
  });

  it("websocket 显式 method 非法值仍受 HttpMethod 枚举约束", () => {
    expect(() =>
      ApiDefinitionSchema.parse({ ...legacyApi, protocol: "websocket", method: "TELEPORT" }),
    ).toThrow();
  });

  it("soap 接口缺 envelope → 拒绝；非 POST method → 拒绝；envelope+POST → 合法", () => {
    const noEnvelope = { ...legacyApi, protocol: "soap", method: "POST", url: "http://x/soap" };
    expect(() => ApiDefinitionSchema.parse(noEnvelope)).toThrow(/envelope/);

    const badMethod = { ...legacyApi, protocol: "soap", method: "GET", url: "http://x/soap", envelope: "<x/>" };
    expect(() => ApiDefinitionSchema.parse(badMethod)).toThrow(/POST/);

    const soapWithoutExplicitMethod = { ...legacyApi, protocol: "soap", url: "http://x/soap", envelope: "<x/>" };
    delete (soapWithoutExplicitMethod as { method?: string }).method;
    expect(() => ApiDefinitionSchema.parse(soapWithoutExplicitMethod)).toThrow(/POST/);

    const ok = ApiDefinitionSchema.parse({
      ...legacyApi,
      protocol: "soap",
      method: "POST",
      url: "http://x/soap",
      envelope: "<soap:Envelope/>",
      soapAction: "urn:DoIt",
    });
    expect(ok.envelope).toBe("<soap:Envelope/>");
    expect(ok.soapAction).toBe("urn:DoIt");
  });

  it("http/soap 之外未纳入的协议值（grpc）→ 枚举拒绝（fail-fast）", () => {
    expect(() =>
      ApiDefinitionSchema.parse({ ...legacyApi, protocol: "grpc" }),
    ).toThrow(/protocol/);
  });
});
