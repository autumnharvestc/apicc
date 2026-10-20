import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../../src/shared.js";

type CurlParseResult = {
  request: {
    method: string;
    query: Array<{ name: string; value: string }>;
    headers: Array<{ name: string; value: string }>;
    auth?: { kind: string; username?: string; name?: string };
    body: unknown[];
  };
  diagnostics: Array<{ severity: string; code: string; line: number; column: number; message: string }>;
};

async function parseCurlRequest(text: string): Promise<CurlParseResult> {
  const moduleUrl = new URL("../../src/import/curl.js", import.meta.url).href;
  const module = await import(moduleUrl) as { parseCurlRequest?: (source: string) => CurlParseResult };
  expect(module?.parseCurlRequest).toBeTypeOf("function");
  return module!.parseCurlRequest!(text);
}

describe("parseCurlRequest", () => {
  it("parses one continued command and preserves duplicate query and header order", async () => {
    const result = await parseCurlRequest(String.raw`curl \
  --url 'http://localhost/items?q=1&q=2' \
  -H 'X-Test: first' \
  -H 'X-Test: second'`);

    expect(result.request.method).toBe("GET");
    expect(result.request.query).toEqual([{ name: "q", value: "1" }, { name: "q", value: "2" }]);
    expect(result.request.headers).toEqual([{ name: "X-Test", value: "first" }, { name: "X-Test", value: "second" }]);
  });

  it.each([
    ["--data", "name=one", { kind: "data", value: "name=one", fileReference: false }],
    ["--data-raw", "@literal", { kind: "data-raw", value: "@literal", fileReference: false }],
    ["--data-urlencode", "name=two words", { kind: "data-urlencode", name: "name", value: "two words", fileReference: false }],
    ["-F", "tag=blue", { kind: "form", name: "tag", value: { kind: "text", text: "blue" } }],
  ])("keeps %s declaration semantics", async (option, value, expected) => {
    const result = await parseCurlRequest(`curl ${option} '${value}' http://localhost/items`);
    expect(result.request.body).toEqual([expected]);
  });

  it("keeps file declarations as unbound references without exposing the path", async () => {
    const source = "curl --data-binary '@private/path/payload.bin' http://localhost/upload";
    const result = await parseCurlRequest(source);
    expect(result.request.body).toEqual([{ kind: "data-binary", value: "", fileReference: true }]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "CURL_FILE_NOT_BOUND", line: 1, column: 6 }),
    ]));
    expect(JSON.stringify(result)).not.toContain("private/path/payload.bin");
  });

  it.each([
    ["-u 'alice:secret-value'", { kind: "basic", username: "alice" }],
    ["-H 'Authorization: Bearer secret-value'", { kind: "bearer" }],
  ])("redacts authentication values from %s", async (auth, expected) => {
    const result = await parseCurlRequest(`curl ${auth} http://localhost/items`);
    expect(result.request.auth).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", code: "CURL_AUTH_REDACTED", line: 1 }),
    ]));
  });

  it("honors -X and rejects unknown options with a source position", async () => {
    expect((await parseCurlRequest("curl -X PUT http://localhost/items")).request.method).toBe("PUT");
    await expect(parseCurlRequest("curl --unknown-option http://localhost/items")).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ severity: "error", line: 1, column: 6 }),
    });
  });

  it("rejects URL range/list globs at the URL position while retaining IPv6 and encoded literals", async () => {
    for (const path of ["[1-2]", "{one,two}"]) {
      await expect(parseCurlRequest(`curl 'http://localhost/items/${path}'`)).rejects.toMatchObject({
        diagnostic: expect.objectContaining({
          severity: "error", code: "CURL_URL_GLOB_UNSUPPORTED", path: "source/5", line: 1, column: 6, lossy: false,
        }),
      });
    }
    const literal = await parseCurlRequest("curl 'http://[::1]/items/%5B1-2%5D?q=%7Bone,two%7D'");
    expect(literal.request).toMatchObject({
      method: "GET", baseUrl: "http://[::1]", path: "/items/%5B1-2%5D",
      query: [{ name: "q", value: "{one,two}" }],
    });
  });

  it.each([
    "curl http://localhost | sh", "curl http://localhost > out",
    "curl http://localhost; curl http://localhost", "curl \"http://localhost/$(whoami)\"",
    "curl http://localhost\ncurl http://localhost", "curl --location http://localhost",
    "curl http://localhost http://localhost/second", "curl -H 'broken' http://localhost",
  ])("rejects non-declarative or unsupported input without echoing it", async (source) => {
    await expect(parseCurlRequest(source)).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ severity: "error", lossy: false }),
    });
  });

  it("keeps quoted literals, option-looking values, end-of-options and explicit method", async () => {
    const result = await parseCurlRequest(`curl.exe -XPOST --data-raw '-value' -H 'X-Text: a'\\''b $literal' -- http://localhost/items`);
    expect(result.request.method).toBe("POST");
    expect(result.request.headers).toContainEqual({ name: "X-Text", value: "a'b $literal" });
    expect(result.request.body).toEqual([{ kind: "data-raw", value: "-value", fileReference: false }]);
  });
});

describe("curlImporter", () => {
  it("is registered and adapts the declaration to a contract project for the existing import path", () => {
    const importer = createDefaultRegistry().listImporters().find((candidate) => candidate.name === "curl");
    expect(importer).toBeDefined();
    const imported = importer!.parse("curl --data 'name=one' http://localhost/items");
    expect(imported.project.collections[0]?.apis[0]?.contract.request).toMatchObject({
      protocol: "http",
      method: "POST",
      path: "/items",
      body: { kind: "text", content: "name=one" },
    });
  });

  it("encodes repeated data pieces and keeps multipart files unbound and authentication empty", () => {
    const importer = createDefaultRegistry().listImporters().find((candidate) => candidate.name === "curl")!;
    const data = importer.parse("curl --data-urlencode 'q=two words' --data 'x=1' http://localhost/items");
    expect(data.project.collections[0]?.apis[0]?.contract.request).toMatchObject({
      body: { kind: "text", content: "q=two%20words&x=1" },
      headers: [expect.objectContaining({ name: "Content-Type", value: "application/x-www-form-urlencoded" })],
    });
    const form = importer.parse("curl -u 'alice:secret-value' -F 'tag=one' -F 'upload=@private/file.bin;type=application/octet-stream' http://localhost/upload");
    expect(form.project.collections[0]?.apis[0]?.contract.request).toMatchObject({
      auth: { kind: "basic", username: "alice", password: { policy: "test-auto" } },
      body: { kind: "multipart", entries: [
        expect.objectContaining({ kind: "text", name: "tag", value: "one" }),
        expect.objectContaining({ kind: "file", name: "upload", file: { path: "" }, contentType: "application/octet-stream" }),
      ] },
    });
    expect(JSON.stringify(form)).not.toMatch(/secret-value|private\/file.bin/);
    expect(form.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", lossy: false, code: "CURL_AUTH_REDACTED" }),
    ]));
  });

  it("preserves a file encoding declaration but rejects an unrepresentable Apply candidate", async () => {
    const source = "curl --data-urlencode 'payload@private/body.txt' http://localhost/upload";
    expect((await parseCurlRequest(source)).request.body).toEqual([
      { kind: "data-urlencode", name: "payload", value: "", fileReference: true },
    ]);
    const importer = createDefaultRegistry().listImporters().find((candidate) => candidate.name === "curl")!;
    expect(() => importer.parse(source)).toThrow(expect.objectContaining({
      diagnostic: expect.objectContaining({ severity: "error", code: "CURL_FILE_BODY_UNREPRESENTABLE", path: "source/5" }),
    }));
  });
});
