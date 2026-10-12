// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDesignStore } from "../../../src/renderer/src/stores/design.js";
import { contractAssetFixture } from "../helpers/contract-assets.js";

async function seeded(root = mkdtempSync(join(tmpdir(), "apicc-design-seeded-"))) {
  const api = createMemoryApi({ root });
  const fixture = await contractAssetFixture(api, root);
  const editor = useEditorStore(api, () => ({ root, readOnly: false }));
  await editor.load(fixture.apiLocator);
  const design = useDesignStore(api, editor);
  design.load();
  return { api, fixture, editor, design };
}

describe("design store", () => {
  it("hydrates and saves ApiAsset.documentation through a formal locator, including reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-design-"));
    const { design, editor, api, fixture } = await seeded(root);
    expect(design.content).toBe("");
    expect(design.dirty).toBe(false);
    design.setContent("业务规则：下单前需校验库存");
    expect(design.dirty).toBe(true);
    await design.save();
    expect(design.dirty).toBe(false);
    expect(editor.api!.documentation).toBe("业务规则：下单前需校验库存");

    const fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    expect((await fresh.apiGet(fixture.apiLocator)).api.documentation).toBe("业务规则：下单前需校验库存");
    expect(api.designExportCalls).toHaveLength(0);
  });

  it("fixed save snapshot keeps later same-slot edits dirty and late save cannot hydrate a switched slot", async () => {
    const { api, fixture, editor, design } = await seeded();
    const created = await api.nodeCreate({ kind: "api", parent: fixture.collection.locator, api: { name: "接口 B" } });
    if (created.kind !== "api") throw new Error("Expected an API node");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submitted: string[] = [];
    api.apiSave = async (_locator, asset) => {
      submitted.push(asset.documentation);
      await gate;
      return asset;
    };

    design.setContent("submitted A");
    const saving = design.save();
    try {
      design.setContent("edited after submit");
      await editor.load(created.locator);
      design.load();
      expect(design.content).toBe("");
      release!();
      await saving;

      expect(submitted).toEqual(["submitted A"]);
      expect(editor.api?.contract.metadata.name).toBe("接口 B");
      expect(design.content).toBe("");
      expect(design.dirty).toBe(false);
      const originalKey = JSON.stringify(["local", fixture.root, fixture.apiLocator.workspaceId, fixture.apiLocator.groupId,
        fixture.projectLocator.projectId, fixture.apiLocator.collectionId, fixture.apiLocator.folderIds, fixture.apiLocator.apiId]);
      expect(design.drafts[originalKey]).toMatchObject({ content: "edited after submit", snapshot: "submitted A" });
    } finally {
      release!();
      await saving.catch(() => {});
    }
  });

  it("drops a documentation draft when its editor slot is evicted and reloads the same key", async () => {
    const { fixture, editor, design } = await seeded();
    const key = editor.activeKey!;
    const previousGeneration = editor.sessions[key]!.generation;
    design.setContent("draft from closed slot");

    editor.evictProject(fixture.projectLocator, fixture.root);
    design.load();
    expect(design.drafts[key]).toBeUndefined();

    await editor.load(fixture.apiLocator);
    expect(editor.sessions[key]!.generation).not.toBe(previousGeneration);
    design.load();
    expect(design.content).toBe("");
    expect(design.snapshot).toBe("");
    expect(design.dirty).toBe(false);
  });

  it("does not let an old save completion change the reloaded slot snapshot", async () => {
    const { api, fixture, editor, design } = await seeded();
    const key = editor.activeKey!;
    design.setContent("submitted by old slot");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.apiSave = async (_locator, asset) => { await gate; return asset; };
    let saving: Promise<void> | undefined;
    try {
      saving = design.save();
      editor.evictProject(fixture.projectLocator, fixture.root);
      design.load();
      expect(design.drafts[key]).toBeUndefined();

      await editor.load(fixture.apiLocator);
      design.load();
      design.setContent("new slot draft");
      expect(design.snapshot).toBe("");
      release();
      await saving;

      expect(design.content).toBe("new slot draft");
      expect(design.snapshot).toBe("");
      expect(design.dirty).toBe(true);
      expect(design.drafts[key]).toMatchObject({ content: "new slot draft", snapshot: "" });
    } finally {
      release();
      await saving?.catch(() => {});
    }
  });

  it("exports by the active full ApiLocator", async () => {
    const { design, api, editor, fixture } = await seeded();
    let received: unknown;
    const original = api.designExport.bind(api);
    api.designExport = async (locator) => {
      received = locator;
      return original(locator);
    };
    const path = await design.exportMarkdown();
    expect(received).toEqual(fixture.apiLocator);
    expect(editor.locator).toEqual(fixture.apiLocator);
    expect(path).toContain("示例接口");
    expect(path.endsWith(".md")).toBe(true);
  });
});
