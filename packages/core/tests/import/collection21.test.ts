import { describe, expect, it } from "vitest";
import { collectionV21Importer } from "../../src/import/collection21.js";

function parseCollection(content: string): ReturnType<typeof collectionV21Importer.parse> {
  return collectionV21Importer.parse(content);
}

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
            body: { mode: "raw", raw: '{"sku":"A1"}', options: { raw: { language: "json" } } },
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
  it("detect parses v2.1 JSON and URL-form schema identifiers", () => {
    expect(collectionV21Importer.detect("c.json", sample)).toBe(true);
    expect(collectionV21Importer.detect("c.json", '{"openapi":"3.0.0"}')).toBe(false);
    const urlSchema = JSON.stringify({
      info: { name: "n", schema: "https://example.com/schemas/collection/v2.1.0/collection.json" },
      item: [],
    });
    expect(collectionV21Importer.detect("c.json", urlSchema)).toBe(true);
  });

  it("delegates into the standard project shape while retaining nested folders and request data", () => {
    const { project, diagnostics, warnings } = parseCollection(sample);
    expect(project.globals).toEqual({ query: [], headers: [], cookies: [], body: [] });
    expect(project.stressPolicy).toEqual({ trustedOrigins: [], deniedOrigins: [] });
    expect(project.models).toEqual([]);
    expect(project.components).toEqual([]);

    const col = project.collections[0]!;
    expect(col.name).toBe("order-api");
    expect(col.folders[0]!.name).toBe("订单");
    const create = col.folders[0]!.apis[0]!;
    expect(create.contract.request).toMatchObject({ protocol: "http", method: "POST", path: "/orders" });
    if (create.contract.request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(create.contract.request.body).toMatchObject({ kind: "json", content: '{"sku":"A1"}' });
    expect(create.cases).toEqual([]);

    const get = col.apis[0]!;
    expect(get.contract.request.protocol).toBe("http");
    if (get.contract.request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(get.contract.request.query).toEqual([expect.objectContaining({ kind: "inline", name: "a", value: "1" })]);
    expect(get.cases).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("script events are not executed and remain visible as structured diagnostics and warning projections", () => {
    const withEvents = JSON.stringify({
      info: { name: "x", schema: "v2.1.0" },
      item: [{ name: "e", request: { method: "GET", url: { raw: "http://x/" } }, event: [{ listen: "test", script: { exec: [] } }] }],
    });
    const { project, diagnostics, warnings } = parseCollection(withEvents);
    const asset = project.collections[0]!.apis[0]!;
    const diagnostic = diagnostics.find((item) => item.code === "SCRIPT_EVENT_NOT_IMPORTED");
    expect(diagnostic).toMatchObject({ ownerId: asset.contract.id });
    expect(diagnostic?.path).toContain("event");
    expect(diagnostic?.reason).toContain("not imported or executed");
    expect(warnings).toContain(diagnostic?.reason);
    expect(asset.cases).toEqual([]);
  });

  it("formdata fields map to an unbound multipart body and file binding loss stays structured", () => {
    const withForm = JSON.stringify({
      info: { name: "f", schema: "v2.1.0" },
      item: [{
        name: "upload",
        request: {
          method: "POST",
          url: { raw: "{{baseUrl}}/upload" },
          body: { mode: "formdata", formdata: [{ key: "sku", value: "A1" }, { key: "count", value: "2" }, { key: "f", type: "file", src: "upload.bin" }] },
        },
      }],
    });
    const { project, diagnostics, warnings } = parseCollection(withForm);
    const asset = project.collections[0]!.apis[0]!;
    const request = asset.contract.request;
    expect(request.protocol).toBe("http");
    if (request.protocol !== "http") throw new Error("Expected an HTTP request.");
    expect(request.body.kind).toBe("multipart");
    if (request.body.kind !== "multipart") throw new Error("Expected multipart body fields.");
    expect(request.body.entries).toMatchObject([
      { kind: "text", name: "sku", value: "A1", enabled: true },
      { kind: "text", name: "count", value: "2", enabled: true },
      { kind: "file", name: "f", file: { path: "" }, enabled: true },
    ]);
    const diagnostic = diagnostics.find((item) => item.code === "REQUEST_FILE_NOT_BOUND");
    expect(diagnostic).toMatchObject({ ownerId: asset.contract.id });
    expect(diagnostic?.path).toContain("formdata.f");
    expect(warnings).toContain(diagnostic?.reason);
  });
});
