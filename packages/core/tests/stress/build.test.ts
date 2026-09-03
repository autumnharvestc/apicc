import { describe, expect, it } from "vitest";
import { buildStressRequest } from "../../src/stress/build.js";
import { createVariableResolver } from "../../src/index.js";
import type { ApiDefinition } from "../../src/domain/model.js";
import type { AuthProvider } from "../../src/plugin/types.js";
import type { VariableResolver } from "../../src/variables/resolver.js";

const api: ApiDefinition = {
  id: "a", name: "下单", version: "1", deprecated: false, method: "POST",
  url: "{{baseUrl}}/orders",
  headers: [{ key: "X-K", value: "{{hid}}", enabled: true }],
  query: [{ key: "page", value: "1", enabled: true }],
  body: { kind: "json", content: '{"n":{{n}}}' },
  auth: { type: "bearer", token: "{{tok}}", placement: "header" },
  cases: [],
};

const baseResolver = (): VariableResolver =>
  createVariableResolver({ layers: [{ baseUrl: "http://s", hid: "h1", n: "7", tok: "t" }] });

describe("buildStressRequest", () => {
  it("解析变量并应用认证（provider 注入）", () => {
    const resolver = baseResolver();
    const applied: string[] = [];
    const providers: AuthProvider[] = [{
      type: "bearer",
      apply: (req) => {
        applied.push("bearer");
        req.headers["Authorization"] = "Bearer t";
      },
    }];
    const req = buildStressRequest(api, resolver, providers);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://s/orders");
    expect(req.headers["X-K"]).toBe("h1");
    expect(req.headers["Authorization"]).toBe("Bearer t");
    expect(req.body?.content).toBe('{"n":7}');
    expect(applied).toEqual(["bearer"]);
  });

  it("query 仅保留启用项且值已解析（拼接留给 http client）；禁用 header 不进请求", () => {
    const resolver = createVariableResolver({ layers: [{ p: "2" }] });
    const req = buildStressRequest(
      {
        ...api,
        headers: [
          { key: "X-On", value: "1", enabled: true },
          { key: "X-Off", value: "0", enabled: false },
        ],
        query: [
          { key: "page", value: "{{p}}", enabled: true },
          { key: "skip", value: "x", enabled: false },
        ],
      },
      resolver,
      [],
    );
    expect(req.headers).toEqual({ "X-On": "1" });
    expect(req.query).toEqual([{ key: "page", value: "2", enabled: true }]);
  });

  it("无 auth 时不应用任何 provider；providers 按 type 匹配首个命中", () => {
    const applied: string[] = [];
    const providers: AuthProvider[] = [
      { type: "basic", apply: () => void applied.push("basic") },
      { type: "apikey", apply: () => void applied.push("apikey") },
    ];
    const noAuth = buildStressRequest({ ...api, auth: undefined }, baseResolver(), providers);
    expect(noAuth.auth).toBeUndefined();
    expect(applied).toEqual([]);

    buildStressRequest(
      { ...api, auth: { type: "apikey", key: "k", value: "v", placement: "header" } },
      baseResolver(),
      providers,
    );
    expect(applied).toEqual(["apikey"]);
  });

  it("form 请求体逐项解析变量值（与 runner 语义一致）", () => {
    const resolver = createVariableResolver({ layers: [{ u: "a", v2: "b" }] });
    const req = buildStressRequest(
      {
        ...api,
        body: {
          kind: "form",
          content: "",
          form: [
            { key: "u", value: "{{u}}", enabled: true },
            { key: "x", value: "{{v2}}", enabled: false },
          ],
        },
      },
      resolver,
      [],
    );
    expect(req.body?.form).toEqual([
      { key: "u", value: "a", enabled: true },
      { key: "x", value: "b", enabled: false },
    ]);
  });
});
