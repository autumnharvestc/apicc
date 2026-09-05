import { describe, expect, it } from "vitest";
import { buildStressRequest } from "../../src/stress/build.js";
import { createVariableResolver } from "../../src/index.js";
import type { ApiDefinition } from "../../src/domain/model.js";
import type { VariableResolver } from "../../src/variables/resolver.js";

/** M5 D5/D7：压测请求构造透传协议字段（变量解析与 url/body 同管线）。 */
describe("buildStressRequest 协议字段透传", () => {
  const resolver: VariableResolver = createVariableResolver({
    layers: [{ baseUrl: "http://s", who: "m5" }],
  });

  it("websocket：protocol 与 message 模板经变量解析透传", () => {
    const api = {
      id: "a", name: "ws", version: "1", deprecated: false, url: "ws://s/rt",
      protocol: "websocket", message: '{"who":"{{who}}"}', headers: [], query: [], cases: [],
    } as unknown as ApiDefinition;
    const req = buildStressRequest(api, resolver, []);
    expect(req.protocol).toBe("websocket");
    expect(req.message).toBe('{"who":"m5"}');
    expect(req.envelope).toBeUndefined();
  });

  it("soap：envelope 与 soapAction 经变量解析透传", () => {
    const api = {
      id: "a", name: "soap", version: "1", deprecated: false, method: "POST", url: "http://s/soap",
      protocol: "soap", envelope: '<AddUser name="{{who}}"/>', soapAction: "urn:add",
      headers: [], query: [], cases: [],
    } as unknown as ApiDefinition;
    const req = buildStressRequest(api, resolver, []);
    expect(req.protocol).toBe("soap");
    expect(req.envelope).toBe('<AddUser name="m5"/>');
    expect(req.soapAction).toBe("urn:add");
  });

  it("旧形状 http 接口：协议字段缺省不产生键（请求形状零破坏）", () => {
    const api: ApiDefinition = {
      id: "a", name: "http", version: "1", deprecated: false, method: "GET",
      url: "{{baseUrl}}/x", headers: [], query: [], cases: [],
    };
    const req = buildStressRequest(api, resolver, []);
    // 实现显式置 undefined（键存在值缺失）——零破坏看值语义而非键存在性。
    expect(req.protocol).toBeUndefined();
    expect(req.message).toBeUndefined();
    expect(req.envelope).toBeUndefined();
    expect(req.soapAction).toBeUndefined();
  });
});
