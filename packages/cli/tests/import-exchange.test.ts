import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultRegistry, fileStorage, type Importer } from "@apicc/core";
import { runCli } from "../src/main.js";
import { IDS, makeTempRoot, makeWorkspace, persistWorkspace, projectOne, uuid } from "../../../apps/desktop/tests/main/helpers/contract-assets.js";
import { parseContractOpenapi } from "../../core/src/import/contractOpenapi.js";

describe("CLI import exchange", () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it("rejects host-derived asset graph errors on project add even when plugin diagnostics are empty and loss is allowed", async () => {
    const temporary = await makeTempRoot("apicc-cli-import-invalid-assets-");
    try {
      const workspaceRoot = join(temporary.path, "workspace");
      await persistWorkspace(workspaceRoot, makeWorkspace());
      process.chdir(workspaceRoot);
      const source = join(temporary.path, "invalid.fixture");
      await writeFile(source, "fixture");
      const imported = parseContractOpenapi({
        openapi: "3.0.3",
        info: { title: "Plugin project with a missing model", version: "1.0.0" },
        paths: { "/detached": { get: { operationId: "detached" } } },
      }).project;
      imported.collections[0]!.apis[0]!.contract.request.body = {
        kind: "json",
        content: "{}",
        schema: { kind: "modelRef", modelId: uuid(900) },
      };
      const importer: Importer = {
        name: "untrusted-empty-diagnostics",
        detect: (fileName) => fileName.endsWith(".fixture"),
        parse: () => ({ project: structuredClone(imported), diagnostics: [], warnings: [] }),
      };
      const registry = createDefaultRegistry();
      registry.registerImporter(importer);
      const before = await fileStorage.load(workspaceRoot);
      const logs: string[] = [];
      const error = await runCli(["import", source, "--group", "group one", "--yes", "--allow-lossy"], registry, (line) => logs.push(line), { loadPlugins: false })
        .then(() => undefined, (caught: unknown) => caught);
      expect(String(error), logs.join("\n")).toMatch(/结构、引用或冲突错误/);
      expect(logs.join("\n")).toContain("ASSET_REFERENCE_MISSING");
      const after = await fileStorage.load(workspaceRoot);
      expect(after.revision).toBe(before.revision);
      expect(after.workspace).toEqual(before.workspace);
    } finally {
      process.chdir(originalCwd);
      await temporary.dispose();
    }
  });

  it("previews one explicit collection merge, keeps --yes separate from --allow-lossy, and saves overwrite atomically", async () => {
    const temporary = await makeTempRoot("apicc-cli-import-exchange-");
    try {
      const workspaceRoot = join(temporary.path, "workspace");
      const initial = makeWorkspace();
      await persistWorkspace(workspaceRoot, initial);
      process.chdir(workspaceRoot);
      const source = join(temporary.path, "source.openapi.json");
      await writeFile(source, JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Imported source", version: "1.0.0" },
        paths: { "/items": { get: {
          operationId: "replacement",
          "x-import-loss": "not represented by the contract model",
          responses: { "200": { description: "ok" } },
        } } },
      }));
      const targetLocator = `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}`;
      const command = ["import", source, "--target-collection", targetLocator, "--policy", "overwrite", "--yes"];
      const logs: string[] = [];
      const registry = createDefaultRegistry();
      const before = await fileStorage.load(workspaceRoot);
      const oldTarget = projectOne(before.workspace).collections.find((collection) => collection.id === IDS.collectionOne)!.apis[0]!;
      const oldOtherModule = projectOne(before.workspace).collections.find((collection) => collection.id === IDS.secondCollection)!.apis;

      const firstError = await runCli(command, registry, (line) => logs.push(line), { loadPlugins: false })
        .then(() => undefined, (error: unknown) => error);
      expect(String(firstError), logs.join("\n")).toMatch(/结构、引用或冲突错误/);
      expect(logs.join("\n")).toContain(`project one API (${IDS.sharedApi})`);
      expect(logs.join("\n")).toContain(`deep API (${IDS.deepApi})`);
      const stillBefore = await fileStorage.load(workspaceRoot);
      expect(stillBefore.revision).toBe(before.revision);
      expect(stillBefore.workspace).toEqual(before.workspace);
      expect(logs.join("\n")).toContain("有损");

      // Parsing again produces fresh source IDs; only the stable workspace target ID is selected externally.
      const selectedTargetCommand = [...command, "--target-api", IDS.sharedApi];
      await expect(runCli(selectedTargetCommand, registry, () => {}, { loadPlugins: false }))
        .rejects.toThrow(/--allow-lossy/);
      const stillBeforeLossConfirmation = await fileStorage.load(workspaceRoot);
      expect(stillBeforeLossConfirmation.revision).toBe(before.revision);
      await expect(runCli([...selectedTargetCommand, "--allow-lossy"], registry, () => {}, { loadPlugins: false })).resolves.toBe(0);
      const after = await fileStorage.load(workspaceRoot);
      const updatedProject = projectOne(after.workspace);
      const updatedTarget = updatedProject.collections.find((collection) => collection.id === IDS.collectionOne)!.apis[0]!;
      expect(after.revision).not.toBe(before.revision);
      expect(updatedTarget.contract.id).toBe(oldTarget.contract.id);
      expect(updatedTarget.cases).toEqual(oldTarget.cases);
      expect(updatedTarget.documentation).toBe(oldTarget.documentation);
      expect(updatedProject.collections.find((collection) => collection.id === IDS.secondCollection)!.apis).toEqual(oldOtherModule);
      expect(after.workspace.groups.find((group) => group.id === IDS.groupTwo)!.projects).toEqual(before.workspace.groups.find((group) => group.id === IDS.groupTwo)!.projects);
      expect(await readFile(source, "utf8")).toContain("x-import-loss");
    } finally {
      process.chdir(originalCwd);
      await temporary.dispose();
    }
  });
});
