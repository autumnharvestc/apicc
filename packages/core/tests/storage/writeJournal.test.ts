import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { decodeContractWorkspace, encodeContractWorkspace } from "../../src/storage/contractFiles.js";
import { apiDesignFilePath, writerLockFilePath, writeJournalDirectoryPath } from "../../src/storage/paths.js";
import { calculateWorkspaceRevision, commitWritePlan, recoverPendingWriteJournal } from "../../src/storage/writeJournal.js";
import type { WorkspaceWritePlan } from "../../src/storage/contractFiles.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";

const roots: string[] = [];
const groupId = "00000000-0000-4000-8000-000000000017";
const projectId = "00000000-0000-4000-8000-000000000018";
const collectionId = "00000000-0000-4000-8000-000000000020";
const apiId = "00000000-0000-4000-8000-000000000001";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apicc-write-journal-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    const tempRoot = resolve(tmpdir()) + sep;
    if (!isAbsolute(target) || !target.startsWith(tempRoot)) {
      throw new Error(`Refusing to clean a non-test directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
});

function plan(): WorkspaceWritePlan {
  return encodeContractWorkspace(ContractWorkspaceSchema.parse(workspaceFixture()));
}

async function commit(root: string, workspacePlan: WorkspaceWritePlan, options: Parameters<typeof commitWritePlan>[2]) {
  const result = await commitWritePlan(root, workspacePlan, options);
  expect(result.revision).not.toBe("");
  return result;
}

async function filesUnder(root: string, current = root): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [path, content] of await filesUnder(root, absolutePath)) result.set(path, content);
    } else if (entry.isFile()) {
      result.set(relative(root, absolutePath).replaceAll("\\", "/"), await readFile(absolutePath, "utf8"));
    }
  }
  return result;
}

describe("contract workspace write journal", () => {
  it("rejects unsafe or malformed plans before creating the workspace root", async () => {
    const root = join(tmpdir(), `apicc-invalid-plan-${randomUUID()}`);
    const unsafe: WorkspaceWritePlan = { files: new Map([["../outside.yaml", "name: unsafe\n"]]) };
    await expect(commitWritePlan(root, unsafe, { expectedRevision: "empty", deletions: [] })).rejects.toThrow();
    expect(existsSync(root)).toBe(false);

    const malformed: WorkspaceWritePlan = { files: new Map([["apicc.workspace.yaml", "formatVersion: [\n"]]) };
    await expect(commitWritePlan(root, malformed, { expectedRevision: "empty", deletions: [] })).rejects.toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it("rejects deletions outside formal workspace files before creating the root", async () => {
    const root = join(tmpdir(), `apicc-invalid-delete-${randomUUID()}`);
    for (const path of ["notes.txt", ".apicc/write-lock"]) {
      await expect(commitWritePlan(root, { files: new Map() }, {
        expectedRevision: "empty",
        deletions: [path],
      })).rejects.toThrow();
      expect(existsSync(root)).toBe(false);
    }
  });

  it("retains a journal containing a non-workspace target without touching that target", async () => {
    const root = await temporaryRoot();
    const operationId = "00000000-0000-4000-8000-000000000099";
    const operation = join(root, writeJournalDirectoryPath(), operationId);
    const nonWorkspacePath = join(root, ".apicc", "unrelated-data");
    await mkdir(operation, { recursive: true });
    await writeFile(nonWorkspacePath, "keep this private file\n", "utf8");
    await writeFile(join(operation, "manifest.yaml"), JSON.stringify({
      version: 1,
      operationId,
      files: [{ path: ".apicc/unrelated-data", action: "delete", existed: false }],
    }), "utf8");

    const problems = await recoverPendingWriteJournal(root);
    expect(problems.length).toBeGreaterThan(0);
    expect(await readFile(nonWorkspacePath, "utf8")).toBe("keep this private file\n");
    expect(existsSync(join(operation, "manifest.yaml"))).toBe(true);
  });

  it("rejects a backup whose intermediate directory links outside the workspace", async () => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    const operationId = "00000000-0000-4000-8000-000000000097";
    const operation = join(root, writeJournalDirectoryPath(), operationId);
    const backupDirectory = join(operation, "backups");
    const targetPath = join(root, "apicc.workspace.yaml");
    const backupPath = join(external, "apicc.workspace.yaml");
    const targetBytes = Buffer.from("original in-root bytes\n", "utf8");
    const externalBytes = Buffer.from("outside backup bytes\n", "utf8");
    await mkdir(operation, { recursive: true });
    await writeFile(targetPath, targetBytes);
    await writeFile(backupPath, externalBytes);
    await symlink(external, backupDirectory, "junction");
    await writeFile(join(operation, "manifest.yaml"), JSON.stringify({
      version: 1,
      operationId,
      files: [{ path: "apicc.workspace.yaml", action: "replace", existed: true }],
    }), "utf8");

    const problems = await recoverPendingWriteJournal(root);
    expect(problems.length).toBeGreaterThan(0);
    expect(Buffer.compare(await readFile(targetPath), targetBytes)).toBe(0);
    expect(Buffer.compare(await readFile(backupPath), externalBytes)).toBe(0);
    expect(existsSync(join(operation, "manifest.yaml"))).toBe(true);
  });

  it("recovers a pending empty-root journal before the first workspace write", async () => {
    const root = await temporaryRoot();
    const operationId = "00000000-0000-4000-8000-000000000098";
    const operation = join(root, writeJournalDirectoryPath(), operationId);
    await mkdir(operation, { recursive: true });
    await writeFile(join(operation, "manifest.yaml"), JSON.stringify({ version: 1, operationId, files: [] }), "utf8");

    await commit(root, plan(), { expectedRevision: "empty", deletions: [] });
    expect(existsSync(operation)).toBe(false);
    expect((await decodeContractWorkspace(root)).readOnly).toBe(false);
  });

  it("does not overwrite an external edit made after the loaded revision", async () => {
    const root = await temporaryRoot();
    const originalPlan = plan();
    const initial = await commit(root, originalPlan, { expectedRevision: "empty", deletions: [] });
    const loaded = await decodeContractWorkspace(root);
    expect(loaded.revision).toBe(initial.revision);
    const designPath = apiDesignFilePath({ groupId, projectId, collectionId, folderIds: [], apiId });
    const externalText = "# externally changed design\n";
    await writeFile(join(root, designPath), externalText, "utf8");
    const before = await filesUnder(root);

    await expect(commitWritePlan(root, originalPlan, { expectedRevision: loaded.revision, deletions: [] })).rejects.toThrow();
    expect(await filesUnder(root)).toEqual(before);
    expect(await readFile(join(root, designPath), "utf8")).toBe(externalText);
  });

  it("includes every serialized workspace metadata and side file in the revision", async () => {
    const root = await temporaryRoot();
    const workspacePlan = plan();
    await commit(root, workspacePlan, { expectedRevision: "empty", deletions: [] });
    const originalRevision = await calculateWorkspaceRevision(root);

    for (const [path, original] of workspacePlan.files) {
      await writeFile(join(root, path), `${original}\n# revision probe\n`, "utf8");
      expect(await calculateWorkspaceRevision(root), path).not.toBe(originalRevision);
      await writeFile(join(root, path), original, "utf8");
    }
    expect(await calculateWorkspaceRevision(root)).toBe(originalRevision);
  });

  it("leaves an unknown writer lock untouched", async () => {
    const root = await temporaryRoot();
    const originalPlan = plan();
    await commit(root, originalPlan, { expectedRevision: "empty", deletions: [] });
    const lockPath = join(root, writerLockFilePath());
    await mkdir(join(root, ".apicc"), { recursive: true });
    const unknownOwner = "{\"owner\":\"unknown\",\"operationId\":\"unknown-operation\"}\n";
    await writeFile(lockPath, unknownOwner, { flag: "wx" });
    const before = await filesUnder(root);

    await expect(commitWritePlan(root, originalPlan, { expectedRevision: (await decodeContractWorkspace(root)).revision, deletions: [] })).rejects.toThrow();
    expect(await filesUnder(root)).toEqual(before);
    expect(await readFile(lockPath, "utf8")).toBe(unknownOwner);
  });

  it("rolls back all prior files after a staging failure", async () => {
    const root = await temporaryRoot();
    const originalPlan = plan();
    const initial = await commit(root, originalPlan, { expectedRevision: "empty", deletions: [] });
    const before = await filesUnder(root);
    const changedPlan = plan();
    changedPlan.files.set("apicc.workspace.yaml", `${changedPlan.files.get("apicc.workspace.yaml")}\n`);

    await expect(commitWritePlan(root, changedPlan, {
      expectedRevision: initial.revision,
      deletions: [],
      faultInjector: (stage) => { if (stage === "after-staging") throw new Error("injected staging failure"); },
    })).rejects.toThrow();
    expect(await filesUnder(root)).toEqual(before);
    expect((await decodeContractWorkspace(root)).readOnly).toBe(false);
  });

  it("restores the original workspace when replacing the second file fails", async () => {
    const root = await temporaryRoot();
    const originalPlan = plan();
    const initial = await commit(root, originalPlan, { expectedRevision: "empty", deletions: [] });
    const before = await filesUnder(root);
    const changedPlan = plan();
    for (const [path, content] of changedPlan.files) changedPlan.files.set(path, `${content}\n`);
    let replacements = 0;

    await expect(commitWritePlan(root, changedPlan, {
      expectedRevision: initial.revision,
      deletions: [],
      faultInjector: (stage) => {
        if (stage === "after-replace" && ++replacements === 2) throw new Error("injected second replacement failure");
      },
    })).rejects.toThrow();
    expect(replacements).toBe(2);
    expect(await filesUnder(root)).toEqual(before);
    expect((await decodeContractWorkspace(root)).readOnly).toBe(false);
  });

  it("restores an explicitly deleted file when a later delete step fails", async () => {
    const root = await temporaryRoot();
    const workspace = ContractWorkspaceSchema.parse(workspaceFixture());
    const api = workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    api.cases.push({ ...api.cases[0]!, id: "second-case" });
    const originalPlan = encodeContractWorkspace(workspace);
    const initial = await commit(root, originalPlan, { expectedRevision: "empty", deletions: [] });
    const before = await filesUnder(root);
    const casePaths = [...originalPlan.files.keys()].filter((path) => path.includes("/cases/") && !path.endsWith("/index.yaml"));
    expect(casePaths).toHaveLength(2);
    const changedWorkspace = structuredClone(workspace);
    changedWorkspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.cases = [];
    const deletionPlan = encodeContractWorkspace(changedWorkspace);
    let deletions = 0;

    await expect(commitWritePlan(root, deletionPlan, {
      expectedRevision: initial.revision,
      deletions: casePaths,
      faultInjector: (stage) => {
        if (stage === "after-delete" && ++deletions === 2) throw new Error("injected second deletion failure");
      },
    })).rejects.toThrow();
    expect(deletions).toBe(2);
    expect(await filesUnder(root)).toEqual(before);
    expect((await decodeContractWorkspace(root)).readOnly).toBe(false);
  });

  it("rolls back changed files when committing the completion marker fails", async () => {
    const root = await temporaryRoot();
    const originalPlan = plan();
    const initial = await commit(root, originalPlan, { expectedRevision: "empty", deletions: [] });
    const before = await filesUnder(root);
    const changedPlan = plan();
    changedPlan.files.set("apicc.workspace.yaml", `${changedPlan.files.get("apicc.workspace.yaml")}\n`);

    await expect(commitWritePlan(root, changedPlan, {
      expectedRevision: initial.revision,
      deletions: [],
      faultInjector: (stage) => { if (stage === "before-committed-marker") throw new Error("injected marker failure"); },
    })).rejects.toThrow();
    expect(await filesUnder(root)).toEqual(before);
    expect((await decodeContractWorkspace(root)).readOnly).toBe(false);
  });

  it("rolls back when revision calculation fails before the final completion marker", async () => {
    const root = await temporaryRoot();
    const originalPlan = plan();
    const initial = await commit(root, originalPlan, { expectedRevision: "empty", deletions: [] });
    const before = await filesUnder(root);
    const changedPlan = plan();
    changedPlan.files.set("apicc.workspace.yaml", `${changedPlan.files.get("apicc.workspace.yaml")}\n`);
    let injected = false;

    await expect(commitWritePlan(root, changedPlan, {
      expectedRevision: initial.revision,
      deletions: [],
      faultInjector: (stage) => {
        if ((stage as string) === "before-revision-calculation") {
          injected = true;
          throw new Error("injected revision calculation failure");
        }
      },
    })).rejects.toThrow();
    expect(injected).toBe(true);
    expect(await filesUnder(root)).toEqual(before);
    expect((await decodeContractWorkspace(root)).readOnly).toBe(false);
  });

  it("retains the journal and returns read-only when rollback and reopen recovery both fail", async () => {
    const root = await temporaryRoot();
    const originalPlan = plan();
    const initial = await commit(root, originalPlan, { expectedRevision: "empty", deletions: [] });
    const before = await filesUnder(root);
    const changedPlan = plan();
    for (const [path, content] of changedPlan.files) changedPlan.files.set(path, `${content}\n`);
    let replacements = 0;

    await expect(commitWritePlan(root, changedPlan, {
      expectedRevision: initial.revision,
      deletions: [],
      faultInjector: (stage) => {
        if (stage === "after-replace" && ++replacements === 2) throw new Error("injected replacement failure");
        if (stage === "before-rollback-restore") throw new Error("injected rollback failure");
      },
    })).rejects.toThrow();
    const partial = await filesUnder(root);
    expect(partial).not.toEqual(before);
    expect([...partial.keys()].some((path) => path.startsWith(".apicc/write-journal/"))).toBe(true);

    const readOnly = await decodeContractWorkspace(root, {
      faultInjector: (stage) => { if (stage === "before-recovery-restore") throw new Error("injected reopen recovery failure"); },
    });
    expect(readOnly.readOnly).toBe(true);
    expect(readOnly.problems.length).toBeGreaterThan(0);
    expect([...await filesUnder(root)].some(([path]) => path.startsWith(".apicc/write-journal/"))).toBe(true);

    const recovered = await decodeContractWorkspace(root);
    expect(recovered.readOnly).toBe(false);
    expect(await filesUnder(root)).toEqual(before);
  });
});
