import { describe, expect, it } from "vitest";
import { openapiImporter } from "../../src/import/openapi.js";

const v3 = `
openapi: 3.0.3
info: { title: 订单服务, version: 1.0.0 }
servers: [{ url: https://api.example.com/v1 }]
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        content:
          application/json:
            schema: { type: object, required: [sku] }
      responses: { "200": { description: ok } }
  /orders/{id}:
    get:
      summary: 查询订单
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { "200": { description: ok } }
`;

const v2 = `
swagger: "2.0"
info: { title: 旧服务, version: 2.0.0 }
host: api.example.com
basePath: /v2
paths:
  /ping:
    get: { responses: { "200": { description: ok } } }
`;

describe("openapiImporter", () => {
  it("detect 识别 3.0 与 2.0 文档", () => {
    expect(openapiImporter.detect("a.yaml", v3)).toBe(true);
    expect(openapiImporter.detect("a.yaml", v2)).toBe(true);
    expect(openapiImporter.detect("a.yaml", "info: x")).toBe(false);
  });

  it("3.0：servers 映射为 imported 环境的 baseUrl，路径映射为接口", () => {
    const { project, warnings } = openapiImporter.parse(v3);
    expect(project.environments[0]!.variables.baseUrl).toBe("https://api.example.com/v1");
    const col = project.collections[0]!;
    expect(col.apis).toHaveLength(2);
    const create = col.apis.find((a) => a.name === "createOrder")!;
    expect(create.method).toBe("POST");
    expect(create.url).toBe("{{baseUrl}}/orders");
    expect(create.body?.kind).toBe("json");
    expect(create.design).toContain("type: object");
    const get = col.apis.find((a) => a.name === "查询订单")!;
    expect(get.query[0]!.key).toBe("id");
    expect(warnings).toEqual([]);
  });

  it("2.0：host+basePath 组合 baseUrl", () => {
    const { project } = openapiImporter.parse(v2);
    expect(project.environments[0]!.variables.baseUrl).toBe("https://api.example.com/v2");
    expect(project.collections[0]!.apis[0]!.url).toBe("{{baseUrl}}/ping");
  });

  it("2.0：in body 参数映射为 json 请求体与 design", () => {
    const v2Body = `
swagger: "2.0"
info: { title: 旧下单服务, version: 1.0.0 }
host: api.example.com
paths:
  /orders:
    post:
      operationId: createOrderV2
      parameters:
        - { name: order, in: body, schema: { type: object, required: [sku] } }
      responses: { "200": { description: ok } }
`;
    const { project, warnings } = openapiImporter.parse(v2Body);
    const api = project.collections[0]!.apis[0]!;
    expect(api.body?.kind).toBe("json");
    expect(api.design).toContain("type: object");
    expect(warnings).toEqual([]);
  });

  it("2.0：in formData 参数映射为 form 请求体", () => {
    const v2Form = `
swagger: "2.0"
info: { title: 上传服务, version: 1.0.0 }
host: api.example.com
paths:
  /upload:
    post:
      parameters:
        - { name: name, in: formData, type: string }
        - { name: file, in: formData, type: file }
      responses: { "200": { description: ok } }
`;
    const { project } = openapiImporter.parse(v2Form);
    const api = project.collections[0]!.apis[0]!;
    expect(api.body?.kind).toBe("form");
    expect(api.body?.form).toEqual([{ key: "name", value: "", enabled: true }, { key: "file", value: "", enabled: true }]);
  });
});
