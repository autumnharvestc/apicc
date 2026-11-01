import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiConfigRepository, createDefaultRegistry, type AiSecretBackend } from "@apicc/core";
import { runCli } from "../src/main.js";
import type { RunCliDeps } from "../src/main.js";

afterEach(() => vi.restoreAllMocks());

// The old CLI exits on an unimplemented command; intercept that external process
// boundary so absence is a feature RED, never a module loading error.
function fixture(available = true) {
  vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`CLI exit ${code}`); });
  const home = mkdtempSync(join(tmpdir(), "apicc-ai-config-"));
  const vault = new Map<string, { value: string; audience: string }>();
  let sequence = 0;
  const backend: AiSecretBackend = {
    availability: available ? "available" : "unavailable",
    async get(ref, audience) { const item = vault.get(ref); return item?.audience === audience ? item.value : undefined; },
    async put(value, audience) { const ref = `secret-${++sequence}`; vault.set(ref, { value, audience }); return ref; },
    async remove(ref, audience) { if (vault.get(ref)?.audience === audience) vault.delete(ref); },
  };
  const logs: string[] = [];
  const deps = { aiHomeDir: home, aiEnv: { SYNTHETIC_AI_KEY: "synthetic-private-value" }, aiSecretBackend: backend, loadPlugins: false };
  const run = (args: string[], overrides: RunCliDeps = {}) => runCli(["ai", "config", ...args], createDefaultRegistry(), line => logs.push(line), { ...deps, ...overrides });
  return { home, vault, logs, run, repository: createAiConfigRepository({ privateRoot: join(home, ".apicc", "ai") }) };
}

describe("CLI personal AI configuration", () => {
  it('final C M2 config show exposes project purpose budget layers and effective provenance without raw configuration', async () => {
    const f = fixture();
    await f.run(['connection', 'gateway', '--template', 'openai']);
    await f.run(['model', 'analysis', '--connection', 'gateway', '--model', 'synthetic-model', '--protocol', 'openai-chat-completions', '--output-mode', 'json-object', '--no-streaming']);
    const document = await f.repository.read();
    document.bindings = [{ purpose: 'report-analysis', modelProfileId: 'analysis', budgets: { maxRequests: 4 } }];
    document.models[0]!.budgets = { maxRequests: 3 };
    document.models[0]!.purposeBudgets = { 'report-analysis': { maxRequests: 5 } };
    document.projectOverrides = [{ projectKey: 'project-explicit', purpose: 'report-analysis', modelProfileId: 'analysis', budgets: { maxRequests: 6, deadlineMs: 123456 } }];
    await f.repository.write(document, document.revision);
    const before = readFileSync(join(f.home, '.apicc', 'ai', 'config.v1.json'));
    f.logs.length = 0; await f.run(['show']); const text = f.logs.join('\n');
    for (const expected of ['project-explicit', '报告分析', 'analysis', '123456', 'ms']) expect.soft(text).toContain(expected);
    expect.soft(text).toMatch(/项目.*(?:覆盖|预算)/); expect.soft(text).toMatch(/来源|继承/);
    expect.soft(text).toMatch(/(?:请求.*6|6.*次)/);
    for (const forbidden of ['credentialRef', 'synthetic-private-value', '"projectOverrides"', '"maxRequests"']) expect(text).not.toContain(forbidden);
    expect(readFileSync(join(f.home, '.apicc', 'ai', 'config.v1.json'))).toEqual(before);
  });
  it("creates two independent models and purpose bindings only in the private root", async () => {
    const f = fixture();
    await f.run(["connection", "gateway", "--template", "openai", "--base-url", "https://fixture.example/v1"]);
    await f.run(["model", "cases", "--connection", "gateway", "--model", "model-one", "--protocol", "openai-responses", "--output-mode", "json-schema", "--no-streaming"]);
    await f.run(["model", "analysis", "--connection", "gateway", "--model", "model-two", "--protocol", "openai-chat-completions", "--output-mode", "json-object", "--no-streaming"]);
    await f.run(["bind", "case-suggestion", "cases"]);
    await f.run(["bind", "report-analysis", "analysis"]);
    const document = await f.repository.read();
    expect(document.models.map(m => [m.id, m.modelId, m.protocol])).toEqual([
      ["cases", "model-one", "openai-responses"], ["analysis", "model-two", "openai-chat-completions"],
    ]);
    expect(document.bindings).toEqual([
      { purpose: "case-suggestion", modelProfileId: "cases", budgets: {} },
      { purpose: "report-analysis", modelProfileId: "analysis", budgets: {} },
    ]);
    expect(existsSync(join(f.home, ".apicc", "ai.json"))).toBe(false);
    await f.run(["show"]);
    expect(f.logs.join("\n")).toContain("model-one");
    expect(f.logs.join("\n")).not.toContain("credentialRef");
  });

  it("stores env secrets in the backend with a fresh reference and never in private JSON or diagnostics", async () => {
    const f = fixture();
    await f.run(["connection", "one", "--template", "openai"]);
    await f.run(["credential", "one", "--secret-env", "SYNTHETIC_AI_KEY"]);
    const first = (await f.repository.read()).connections[0]!.credentialRef;
    await f.run(["credential", "one", "--secret-env", "SYNTHETIC_AI_KEY"]);
    const next = (await f.repository.read()).connections[0]!.credentialRef;
    expect(first).not.toBe(next);
    expect(f.vault.size).toBe(1);
    expect(readFileSync(join(f.home, ".apicc", "ai", "config.v1.json"), "utf8")).not.toContain("synthetic-private-value");
    expect(f.logs.join("\n")).not.toContain("synthetic-private-value");
  });

  it("refuses persistent secrets when the secure backend is unavailable without plaintext fallback", async () => {
    const f = fixture(false);
    await f.run(["connection", "one", "--template", "openai"]);
    const before = readFileSync(join(f.home, ".apicc", "ai", "config.v1.json"));
    await expect(f.run(["credential", "one", "--secret-env", "SYNTHETIC_AI_KEY"])).rejects.toThrow(/secure-backend-unavailable/);
    expect(readFileSync(join(f.home, ".apicc", "ai", "config.v1.json"))).toEqual(before);
    expect(f.vault.size).toBe(0);
  });

  it("uses the OS adapter with fresh audience-bound opaque references instead of plaintext storage", async () => {
    const f = fixture();
    const osValues = new Map<string, string>();
    const aiKeyringEntry = (service: string, account: string) => ({
      async getPassword() { return osValues.get(`${service}/${account}`) ?? null; },
      async setPassword(value: string) { osValues.set(`${service}/${account}`, value); },
      async deleteCredential() { return osValues.delete(`${service}/${account}`); },
    });
    const options = { aiSecretBackend: undefined, aiKeyringEntry };
    await f.run(["connection", "os", "--template", "openai"], options);
    await f.run(["credential", "os", "--secret-env", "SYNTHETIC_AI_KEY"], options);
    const first = (await f.repository.read()).connections[0]!.credentialRef;
    await f.run(["credential", "os", "--secret-env", "SYNTHETIC_AI_KEY"], options);
    expect((await f.repository.read()).connections[0]!.credentialRef).not.toBe(first);
    expect(osValues.size).toBe(1);
    const envelope = JSON.parse([...osValues.values()][0]!);
    expect(envelope).toMatchObject({ value: "synthetic-private-value" });
    expect(envelope.audience).toContain("https://api.openai.com/v1");
    expect([...osValues.keys()][0]).not.toContain("synthetic-private-value");
    expect(readFileSync(join(f.home, ".apicc", "ai", "config.v1.json"), "utf8")).not.toContain("synthetic-private-value");
  });
  it("previews provider templates as readable fields", async () => {
    const f = fixture();
    await f.run(["templates"]);
    expect(f.logs.join("\n")).toContain("OpenAI");
    expect(f.logs.join("\n")).not.toContain('"providers"');
  });
  it("migrates the old file only after original-address confirmation and preserves the original bytes", async () => {
    const f = fixture();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(f.home, ".apicc"), { recursive: true });
    const file = join(f.home, ".apicc", "ai.json");
    const original = JSON.stringify({ baseUrl: "https://old.example/v1", model: "old", apiKey: "MIGRATION_SYNTHETIC" });
    writeFileSync(file, original);
    await f.run(["migrate-legacy"]);
    expect((await f.repository.read()).connections).toHaveLength(0);
    await f.run(["migrate-legacy", "--confirm-address", "https://old.example/v1"]);
    expect((await f.repository.read()).bindings).toHaveLength(3);
    expect(f.vault.size).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(f.logs.join("\n")).not.toContain("MIGRATION_SYNTHETIC");
  });
  it("persists explicit model capabilities and separate model/purpose budgets for Core resolution", async () => {
    const f = fixture();
    await f.run(["connection", "one", "--template", "openai"]);
    const common = ["model", "custom", "--connection", "one", "--model", "custom-model", "--protocol", "openai-responses", "--output-mode", "json-schema"];
    await f.run([...common, "--budget", "candidateCount=3", "--capability", "maxInputTokens=65536", "--confirm-capabilities"]);
    await f.run([...common, "--purpose", "report-analysis", "--budget", "evidenceCount=2"]);
    const model = (await f.repository.read()).models[0]!;
    expect(model.budgets.candidateCount).toBe(3);
    expect(model.purposeBudgets["report-analysis"]).toEqual({ evidenceCount: 2 });
    expect(model.capabilities).toMatchObject({ status: "confirmed", maxInputTokens: 65536 });
  });
});
