import { describe, expect, it } from "vitest";
import { collectionV21Importer } from "../../src/import/collection21.js";

const sample = JSON.stringify({
  info: { name: "order-api", schema: "v2.1.0" },
  item: [
    {
      name: "订单",
      item: [
        {
          name: "create",
          request: {
            method: "POST",
            url: { raw: "{{baseUrl}}/orders" },
            header: [{ key: "Content-Type", value: "application/json" }],
            body: { mode: "raw", raw: '{"sku":"A1"}' },
          },
        },
      ],
    },
    {
      name: "get",
      request: {
        method: "GET",
        url: { raw: "{{baseUrl}}/orders/1?a=1", query: [{ key: "a", value: "1", disabled: false }] },
      },
    },
  ],
});

describe("collectionV21Importer", () => {
  it("detect 识别 v2.1 JSON", () => {
    expect(collectionV21Importer.detect("c.json", sample)).toBe(true);
    expect(collectionV21Importer.detect("c.json", '{"openapi":"3.0.0"}')).toBe(false);
  });

  it("parse 映射文件夹/接口/请求体/查询参数", () => {
    const { project, warnings } = collectionV21Importer.parse(sample);
    const col = project.collections[0]!;
    expect(col.name).toBe("order-api");
    expect(col.folders[0]!.name).toBe("订单");
    expect(col.folders[0]!.apis[0]!.method).toBe("POST");
    expect(col.folders[0]!.apis[0]!.body?.content).toBe('{"sku":"A1"}');
    const flat = col.apis[0]!;
    expect(flat.query).toEqual([{ key: "a", value: "1", enabled: true }]);
    expect(flat.cases[0]!.name).toContain("get");
  });

  it("脚本事件跳过并产生 warning", () => {
    const withEvents = JSON.stringify({
      info: { name: "x", schema: "v2.1.0" },
      item: [{ name: "e", request: { method: "GET", url: { raw: "http://x/" } }, event: [{ listen: "test", script: { exec: [] } }] }],
    });
    const { warnings } = collectionV21Importer.parse(withEvents);
    expect(warnings.some((w) => w.includes("脚本"))).toBe(true);
  });

  it("detect 兼容 URL 形态的 schema 标识", () => {
    const urlSchema = JSON.stringify({
      info: { name: "n", schema: "https://example.com/schemas/collection/v2.1.0/collection.json" },
      item: [],
    });
    expect(collectionV21Importer.detect("c.json", urlSchema)).toBe(true);
  });

  it("formdata 表单映射并跳过文件项", () => {
    const withForm = JSON.stringify({
      info: { name: "f", schema: "v2.1.0" },
      item: [{
        name: "upload",
        request: {
          method: "POST",
          url: { raw: "{{baseUrl}}/upload" },
          body: { mode: "formdata", formdata: [{ key: "sku", value: "A1" }, { key: "count", value: "2" }, { key: "f", type: "file" }] },
        },
      }],
    });
    const { project, warnings } = collectionV21Importer.parse(withForm);
    const api = project.collections[0]!.apis[0]!;
    expect(api.body?.kind).toBe("form");
    expect(api.body?.form).toEqual([
      { key: "sku", value: "A1", enabled: true },
      { key: "count", value: "2", enabled: true },
    ]);
    expect(warnings.filter((w) => w.includes("文件类型表单项不支持"))).toHaveLength(1);
  });
});
