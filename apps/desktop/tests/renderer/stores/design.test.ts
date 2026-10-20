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
    api.apiSave = async (_locator, asset, revision) => {
      submitted.push(asset.documentation);
      await gate;
      return { api: asset, sourceApiRevision: revision, sourceProjectRevision: "project-revision" };
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

  it("uses the captured editor root and rejects a late preview after switching away and back", async () => {
    const { api, fixture, editor, design } = await seeded();
    const created = await api.nodeCreate({ kind: "api", parent: fixture.collection.locator, api: { name: "接口 B" } });
    if (created.kind !== "api") throw new Error("Expected an API node");
    const session = editor.sessions[editor.activeKey!]!;
    design.setContent("未保存说明");

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = api.designPreview.bind(api);
    let received: Parameters<typeof api.designPreview>[0] | undefined;
    api.designPreview = async (input) => {
      received = input;
      await gate;
      return original(input);
    };

    const pending = design.preview();
    try {
      expect(received).toMatchObject({
        sourceRoot: session.root,
        locator: fixture.apiLocator,
        sourceProjectRevision: session.sourceProjectRevision,
        assetDraft: { documentation: "未保存说明" },
      });
      await editor.load(created.locator);
      design.load();
      await editor.load(fixture.apiLocator);
      design.load();
      release!();
      await pending;

      expect(design.previewStatus).toBe("idle");
      expect(design.previewResult).toBeNull();
    } finally {
      release!();
      await pending.catch(() => {});
    }
  });

  it("invalidates a pending same-session preview when content or a valid control draft changes", async () => {
    const { api, design } = await seeded();
    const original = api.designPreview.bind(api);
    const releases: Array<() => void> = [];
    const gates = [0, 1].map(() => new Promise<void>((resolve) => releases.push(resolve)));
    let requestIndex = 0;
    api.designPreview = async (input) => {
      await gates[requestIndex++]!;
      return original(input);
    };

    design.setContent("before first preview");
    const first = design.preview();
    design.setContent("edited in the same session");
    expect(design.previewStatus).toBe("idle");

    const second = design.preview();
    design.setControlDraft("contract.request.body.schema.default", '"valid control edit"', null);
    expect(design.previewStatus).toBe("idle");

    releases.forEach((release) => release());
    await Promise.all([first, second]);
    expect(design.previewStatus).toBe("idle");
    expect(design.previewResult).toBeNull();
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
    api.apiSave = async (_locator, asset, revision) => { await gate; return { api: asset, sourceApiRevision: revision, sourceProjectRevision: "project-revision" }; };
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
    api.designExport = async (input) => {
      received = input;
      return original(input);
    };
    const path = await design.exportDocument("markdown", { kind: "project" });
    expect(received).toEqual({
      sourceRoot: fixture.root,
      locator: fixture.apiLocator,
      format: "markdown",
      scope: { kind: "project" },
    });
    expect(editor.locator).toEqual(fixture.apiLocator);
    expect(path).toContain("示例项目.md");
    expect(path.endsWith(".md")).toBe(true);
  });
});
