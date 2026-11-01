import { describe, expect, it } from "vitest";
import { builtinAiProviderCatalog, loadAiProviderCatalog, createAiConnectionFromTemplate } from "../../src/ai/catalog.js";

const custom = { id: "custom", formatVersion: 1, revision: 1, name: "Custom", baseUrl: "https://gateway.example/prefix/v1///", protocols: ["openai-chat-completions", "openai-responses", "anthropic-messages"], defaultProtocol: "openai-responses", auth: { kind: "bearer" }, headers: {}, modelDiscovery: false };

describe("declarative provider catalog", () => {
  it.each(["X-Client-Token", "x-client-token"])("rejects template static header %s matching its declared secret slot", header => {
    const previous = loadAiProviderCatalog(builtinAiProviderCatalog, []).catalog;
    const result = loadAiProviderCatalog(builtinAiProviderCatalog, [{ formatVersion: 1, providers: [{ ...custom, auth: { kind: "api-key", header: "X-Client-Token" }, headers: { [header]: "placeholder-only" } }] }], previous);
    expect(result.errors).toContainEqual(expect.objectContaining({ file: "overrides[0]", field: `providers.0.headers.${header}` }));
    expect(result.catalog).toEqual(previous);
  });
  it("keeps non-secret template headers and connection credential references", () => {
    const result = loadAiProviderCatalog({ formatVersion: 1, providers: [{ ...custom, auth: { kind: "api-key", header: "X-Client-Token" }, headers: { "x-visible-version": "v1" } }] }, []);
    expect(result.errors).toEqual([]);
    expect(createAiConnectionFromTemplate(result.catalog[0]!, { id: "new", name: "reference only", credentialRef: "safe-ref" })).toMatchObject({ auth: { kind: "api-key", header: "X-Client-Token" }, headers: { "x-visible-version": "v1" }, credentialRef: "safe-ref" });
  });
  it("loads builtin protocols and custom gateway configuration without code", () => {
    const result = loadAiProviderCatalog(builtinAiProviderCatalog, [{ formatVersion: 1, providers: [custom] }]);
    expect(result.errors).toEqual([]);
    expect(result.catalog?.find(p => p.id === "custom")?.baseUrl).toBe("https://gateway.example/prefix/v1");
    expect(result.catalog?.map(p => p.id)).toEqual(["openai", "anthropic", "custom"]);
    expect(result.catalog?.find(p => p.id === "anthropic")?.headers["anthropic-version"]).toBe("2023-06-01");
  });
  it.each([
    { baseUrl: "https://user:pass@example.com/v1" }, { baseUrl: "https://example.com/v1?q=x" },
    { baseUrl: "https://example.com/v1#x" }, { baseUrl: "http://example.com/v1" },
    { protocols: ["javascript"] }, { apiKey: "secret" }, { script: "js" },
    { headers: { Host: "evil" } }, { headers: { "x-custom": "a\r\nb" } },
    { headers: { Authorization: "Bearer secret" } }, { headers: { "x-api-key": "secret" } },
    { auth: { kind: "none" } }, { revision: 0 },
  ])("preserves previous valid catalog and reports file/field for invalid template %j", invalid => {
    const previous = loadAiProviderCatalog(builtinAiProviderCatalog, []).catalog;
    const result = loadAiProviderCatalog(builtinAiProviderCatalog, [{ formatVersion: 1, providers: [{ ...custom, ...invalid }] }], previous);
    expect(result.catalog).toEqual(previous);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.errors?.[0]).toMatchObject({ file: "overrides[0]", field: expect.any(String) });
  });
  it("allows only explicitly enabled loopback HTTP testing", () => {
    const load = (baseUrl: string, insecureLocalTest: boolean) => loadAiProviderCatalog({ formatVersion: 1, providers: [{ ...custom, baseUrl, insecureLocalTest, auth: { kind: "none" } }] }, []);
    expect(load("http://127.0.0.1:123/v1", true).errors).toEqual([]);
    expect(load("http://[::1]:123/v1", true).errors).toEqual([]);
    expect(load("http://127.0.0.1/v1", false).errors?.length).toBeGreaterThan(0);
    expect(load("http://remote.example/v1", true).errors?.length).toBeGreaterThan(0);
  });
  it("reports malformed URLs without throwing away the structured load result", () => {
    const result = loadAiProviderCatalog({ formatVersion: 1, providers: [{ ...custom, baseUrl: "not a url" }] }, []);
    expect(result.errors[0]).toMatchObject({ file: "builtin", field: "providers.0.baseUrl" });
  });
  it.each(["Upgrade", "TE", "Trailer"])("forbids transport header %s as a secret binding", header => {
    const result = loadAiProviderCatalog({ formatVersion: 1, providers: [{ ...custom, auth: { kind: "api-key", header } }] }, []);
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it("copies template values/source so updates and deletion do not drift connections", () => {
    const first = loadAiProviderCatalog({ formatVersion: 1, providers: [custom] }, []);
    const connection = createAiConnectionFromTemplate(first.catalog[0]!, { id: "new", name: "my connection", credentialRef: "ref" });
    const update = loadAiProviderCatalog({ formatVersion: 1, providers: [{ ...custom, revision: 2, baseUrl: "https://changed.example/v1" }] }, [], first.catalog);
    expect(update.diff?.updated).toEqual(["custom"]);
    expect(loadAiProviderCatalog({ formatVersion: 1, providers: [] }, [], update.catalog).diff?.removed).toEqual(["custom"]);
    expect(connection?.baseUrl).toBe("https://gateway.example/prefix/v1");
    expect(connection?.templateSource).toEqual({ id: "custom", revision: 1 });
  });
});
