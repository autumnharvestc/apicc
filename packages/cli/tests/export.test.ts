import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileStorage, type ContractWorkspace } from "@apicc/core";
import { parse as parseYaml } from "yaml";
import { spawnOwnedCliProcess } from "./helpers/ownedCliProcess.js";

const groupId = "30000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000002";
const collectionId = "30000000-0000-4000-8000-000000000003";
const apiId = "30000000-0000-4000-8000-000000000004";
const projectPath = `groups/${groupId}/projects/${projectId}`;
const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
const syntheticSecret = "cli-export-secret-sentinel";

let workspaceRoot = "";
let outputRoot = "";

function exportWorkspace(): ContractWorkspace {
  return {
    formatVersion: 1,
    id: "30000000-0000-4000-8000-000000000000",
    name: "export workspace",
    variables: {},
    groups: [{
      id: groupId,
      name: "group",
      projects: [{
        id: projectId,
        name: "export project",
        variables: {},
        globals: { query: [], headers: [], cookies: [], body: [] },
        environments: [],
        workflows: [],
        stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
        models: [],
        components: [],
        collections: [{
          id: collectionId,
          name: "public API",
          variables: {},
          preOperations: [],
          postOperations: [],
          folders: [],
          apis: [{
            contract: {
              formatVersion: 1,
              id: apiId,
              metadata: { name: "List records", description: "saved docs", tags: ["public"], version: "1.0.0", status: "published" },
              request: {
                protocol: "http",
                method: "GET",
                baseUrl: "https://api.example.test",
                path: "/records",
                pathParams: [],
                query: [{ kind: "inline", id: "30000000-0000-4000-8000-000000000005", name: "access_token", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: syntheticSecret }],
                headers: [],
                cookies: [],
                auth: { kind: "none" },
                body: { kind: "none" },
              },
              responses: [{
                kind: "inline",
                id: "30000000-0000-4000-8000-000000000006",
                status: "200",
                description: "Records returned",
                headers: {},
                content: { "application/json": { schema: { kind: "scalar", type: "string" }, examples: [] } },
              }],
            },
            cases: [],
            documentation: "Saved documentation for export.",
          }],
        }],
      }],
    }],
  };
}

function lossyExportWorkspace(): ContractWorkspace {
  const workspace = exportWorkspace();
  const api = workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
  const request = api.contract.request;
  if (request.protocol !== "http") throw new Error("HTTP export fixture required");
  api.contract.request = {
    protocol: "websocket",
    baseUrl: request.baseUrl,
    path: request.path,
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "none" },
    message: "{\"ping\":true}",
  };
  return workspace;
}

async function runExport(args: string[]) {
  return await spawnOwnedCliProcess({
    command: process.execPath,
    args: [cliEntry, "--no-plugins", "export", projectPath, ...args],
    cwd: workspaceRoot,
    env: { ...process.env, NODE_ENV: "test" },
    timeoutMs: 10_000,
  }).result;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "apicc-export-cli-"));
  outputRoot = mkdtempSync(join(tmpdir(), "apicc-export-output-"));
  await saveWorkspace(exportWorkspace());
});

async function saveWorkspace(workspace: ContractWorkspace): Promise<void> {
  const current = await fileStorage.load(workspaceRoot);
  await fileStorage.save(workspaceRoot, workspace, { expectedRevision: current.revision, deletions: [] });
}

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (outputRoot) rmSync(outputRoot, { recursive: true, force: true });
});

describe("CLI document export", () => {
  it("writes the selected API document without printing masked source credentials", async () => {
    const outputPath = join(outputRoot, "api.md");
    const result = await runExport(["--format", "markdown", "--output", outputPath, "--api", apiId]);

    expect(result.termination).toBe("exit");
    expect(result.exitCode).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("List records");
    expect(output).not.toContain(syntheticSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(syntheticSecret);
  });

  it("does not create an output file when the requested scope has no matches", async () => {
    const outputPath = join(outputRoot, "no-match.md");
    const result = await runExport(["--format", "markdown", "--output", outputPath, "--tag", "missing-tag"]);

    expect(result.termination).toBe("exit");
    expect(result.exitCode).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(result.stderr).toContain("没有匹配的接口");
    expect(`${result.stdout}${result.stderr}`).not.toContain(syntheticSecret);
  });

  it("writes OpenAPI JSON and YAML with independent specification and info versions", async () => {
    const jsonPath = join(outputRoot, "api.openapi.json");
    const jsonResult = await runExport(["--format", "openapi-3.1", "--output", jsonPath, "--api", apiId, "--info-version", "4.2.0"]);
    expect(jsonResult.termination).toBe("exit");
    expect(jsonResult.exitCode, `${jsonResult.stdout}${jsonResult.stderr}`).toBe(0);
    const json = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
    expect(json.openapi).toBe("3.1.0");
    expect(json.info).toMatchObject({ version: "4.2.0" });
    expect(JSON.stringify(json)).not.toContain(syntheticSecret);

    const yamlPath = join(outputRoot, "api.openapi.yaml");
    const yamlResult = await runExport(["--format", "openapi-3.0", "--encoding", "yaml", "--output", yamlPath, "--api", apiId]);
    expect(yamlResult.termination).toBe("exit");
    expect(yamlResult.exitCode).toBe(0);
    const yaml = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
    expect(yaml.openapi).toBe("3.0.3");
    expect(yaml.info).toMatchObject({ version: "1.0.0" });
    expect(JSON.stringify(yaml)).not.toContain(syntheticSecret);
  });

  it("requires --allow-lossy before writing an OpenAPI export with unsupported protocol semantics", async () => {
    await saveWorkspace(lossyExportWorkspace());
    try {
      const deniedPath = join(outputRoot, "lossy-denied.json");
      const denied = await runExport(["--format", "openapi-3.1", "--output", deniedPath, "--api", apiId]);
      expect(denied.termination).toBe("exit");
      expect(denied.exitCode).toBe(1);
      expect(existsSync(deniedPath)).toBe(false);
      expect(`${denied.stdout}${denied.stderr}`).toContain("未确认的语义损失");

      const allowedPath = join(outputRoot, "lossy-allowed.json");
      const allowed = await runExport(["--format", "openapi-3.1", "--output", allowedPath, "--api", apiId, "--allow-lossy"]);
      expect(allowed.termination).toBe("exit");
      expect(allowed.exitCode).toBe(0);
      expect(existsSync(allowedPath)).toBe(true);
    } finally {
      await saveWorkspace(exportWorkspace());
    }
  });

  it("returns a nonzero result for a write failure without printing source content", async () => {
    const outputPath = join(outputRoot, "missing-directory", "document.html");
    const result = await runExport(["--format", "html", "--output", outputPath, "--api", apiId]);

    expect(result.termination).toBe("exit");
    expect(result.exitCode).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(result.stderr).toContain("无法写入目标文件");
    expect(`${result.stdout}${result.stderr}`).not.toContain(syntheticSecret);
  });
});
