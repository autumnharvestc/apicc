import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import * as document from "../../src/design/document.js";
import { buildDocumentProjection } from "../../src/design/projection.js";
import { designDocumentIds, projectionProject } from "../helpers/designDocumentFixture.js";

const secondApiId = "10000000-0000-4000-8000-000000000099";
const secondCollectionId = "10000000-0000-4000-8000-000000000098";

function multiApiProject() {
  const project = projectionProject();
  const firstCollection = project.collections[0]!;
  const firstApi = firstCollection.apis[0]!;
  firstApi.contract.metadata.tags = ["public"];
  firstApi.contract.metadata.description = "</script><script>globalThis.injected=true</script><img src=x onerror=alert(1)>";
  firstApi.documentation = "Synthetic documentation secret: documentation-secret-sentinel";

  const secondCollection = structuredClone(firstCollection);
  secondCollection.id = secondCollectionId;
  secondCollection.name = "Admin";
  const secondApi = structuredClone(firstApi);
  secondApi.contract.id = secondApiId;
  secondApi.contract.metadata.name = "Admin read";
  secondApi.contract.metadata.tags = ["internal"];
  secondCollection.apis = [secondApi];
  project.collections.push(secondCollection);

  return project;
}

function multiApiProjection() {
  return buildDocumentProjection(createProjectSnapshot(multiApiProject()), { kind: "project" });
}

describe("document export", () => {
  it("exports only a redacted test-case summary in Markdown and HTML", () => {
    const project = projectionProject();
    const api = project.collections[0]!.apis[0]!;
    api.cases = [{
      id: "10000000-0000-4000-8000-000000000099",
      name: "token=case-name-secret",
      scope: "base",
      parameters: { access_token: "case-parameter-secret" },
      preOperations: [{ id: "case-pre-op", type: "script", content: "case-script-secret" }],
      postOperations: [],
      assertions: [{ id: "case-assertion", target: "bodyJson", op: "eq", path: "private.path", expected: "case-expected-secret" }],
    }];

    const projection = buildDocumentProjection(createProjectSnapshot(project), { kind: "project" });
    const projectedApi = projection.apis[0]!;
    const markdown = document.renderDocumentMarkdown(projection);
    const renderHtml = (document as unknown as { renderDocumentHtml?: (value: typeof projection) => string }).renderDocumentHtml;

    expect(renderHtml).toBeTypeOf("function");
    if (!renderHtml) throw new Error("HTML document renderer is not available.");
    const html = renderHtml(projection);

    expect(projectedApi.caseSummaries).toEqual([{ name: "token=****", scope: "base", assertionCount: 1 }]);
    expect(markdown).toContain("| token=**** | base | 1 |");
    expect(html).toContain("<td>token=****</td><td>base</td><td>1</td>");
    for (const output of [JSON.stringify(projection), markdown, html]) {
      expect(output).toContain("token=****");
      expect(output).not.toContain("case-name-secret");
      expect(output).not.toContain("case-parameter-secret");
      expect(output).not.toContain("case-script-secret");
      expect(output).not.toContain("case-expected-secret");
      expect(output).not.toContain("private.path");
    }
  });

  it("renders same-name models with unique per-API anchors and matching links", () => {
    const projection = multiApiProjection();
    const markdown = document.renderDocumentMarkdown(projection);
    const modelAnchor = `id="model-${designDocumentIds.contract}-${designDocumentIds.model}"`;
    const secondModelAnchor = `id="model-${secondApiId}-${designDocumentIds.model}"`;

    expect(markdown.split(modelAnchor)).toHaveLength(2);
    expect(markdown.split(secondModelAnchor)).toHaveLength(2);
    expect(markdown).toContain(`[User](#model-${designDocumentIds.contract}-${designDocumentIds.model})`);
    expect(markdown).toContain(`[User](#model-${secondApiId}-${designDocumentIds.model})`);
  });

  it("renders a self-contained HTML document with safe text, search, anchors and copy controls", () => {
    const projection = multiApiProjection();
    const renderHtml = (document as unknown as { renderDocumentHtml?: (value: typeof projection) => string }).renderDocumentHtml;

    expect(renderHtml).toBeTypeOf("function");
    if (!renderHtml) throw new Error("HTML document renderer is not available.");
    const html = renderHtml(projection);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("id=\"document-search\"");
    expect(html).toContain(`id="api-${designDocumentIds.contract}"`);
    expect(html).toContain(`id="api-${secondApiId}"`);
    expect(html).toContain(`id="model-${designDocumentIds.contract}-${designDocumentIds.model}"`);
    expect(html).toContain(`id="model-${secondApiId}-${designDocumentIds.model}"`);
    expect(html).toContain("data-copy-button");
    expect(html).toContain("globalThis.injected=true");
    expect(html).toContain("&lt;/script&gt;&lt;script&gt;");
    expect(html).not.toContain("</script><script>globalThis.injected=true");
    expect(html).not.toContain("documentation-secret-sentinel");
    expect(html).not.toContain("synthetic-import-token");
    expect(html).not.toContain("credential-ref-id");
    expect(html).not.toContain("C:\\private\\upload.bin");
  });

  it("uses stable project order and selected dependency closure for each supported scope", () => {
    const projection = multiApiProjection();
    const project = multiApiProject();
    const snapshot = createProjectSnapshot(project);
    const allProject = buildDocumentProjection(snapshot, { kind: "project" });
    const selectedCollections = buildDocumentProjection(createProjectSnapshot(project), { kind: "collections", collectionIds: [secondCollectionId] });
    const selectedApis = buildDocumentProjection(createProjectSnapshot(project), { kind: "apis", contractIds: [secondApiId, designDocumentIds.contract] });
    const selectedTags = buildDocumentProjection(createProjectSnapshot(project), { kind: "tags", tags: ["internal"] });
    const noMatch = buildDocumentProjection(snapshot, { kind: "tags", tags: ["not-present"] });

    expect(projection.apis.map((api) => api.contractId)).toEqual([designDocumentIds.contract, secondApiId]);
    expect(allProject.apis.map((api) => api.contractId)).toEqual([designDocumentIds.contract, secondApiId]);
    expect(selectedCollections.apis.map((api) => api.contractId)).toEqual([secondApiId]);
    expect(selectedApis.apis.map((api) => api.contractId)).toEqual([designDocumentIds.contract, secondApiId]);
    expect(selectedTags.apis.map((api) => api.contractId)).toEqual([secondApiId]);
    expect(selectedTags.apis[0]?.models.map((model) => model.id)).toEqual([designDocumentIds.model]);
    expect(selectedTags.apis[0]?.components.map((component) => component.id)).toEqual([designDocumentIds.parameterComponent]);
    expect(noMatch.apis).toEqual([]);
    expect(noMatch.diagnostics).toContainEqual(expect.objectContaining({ code: "DOCUMENT_SCOPE_TARGET_NOT_FOUND" }));
  });

  it("keeps one labeled search and count outside collapsed navigation and connects real API targets", () => {
    const html = document.renderDocumentHtml(multiApiProjection());
    const sidebar = html.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/)?.[1];
    const controls = sidebar?.match(/<div class="document-controls">([\s\S]*?)<\/div>/)?.[1];
    const navigation = html.match(/<nav id="document-contents" aria-label="Contents">([\s\S]*?)<\/nav>/)?.[1];
    const main = html.match(/<main>([\s\S]*?)<\/main>/)?.[1];

    expect(controls).toBeDefined();
    expect(controls).toContain('<label for="document-search">');
    expect(controls).toContain('<input id="document-search" type="search"');
    expect(controls).toContain('<p id="search-summary" aria-live="polite">');
    expect(controls).toContain('id="contents-toggle"');
    expect(html.match(/id="document-search"/g)).toHaveLength(1);
    expect(html.match(/id="search-summary"/g)).toHaveLength(1);
    expect(html).toContain('<button id="contents-toggle" type="button" aria-controls="document-contents" aria-expanded="false">');
    expect(navigation).toBeDefined();
    expect(navigation).not.toContain('id="document-search"');
    expect(navigation).not.toContain('id="search-summary"');
    expect(main).toBeDefined();
    expect(main).not.toContain('id="document-search"');
    expect(main).not.toContain('id="search-summary"');
    const links = [...(navigation ?? "").matchAll(/<li data-api-target="([^"]+)"><a href="#([^"]+)">/g)];
    expect(links.map((link) => [link[1], link[2]])).toEqual([
      [`api-${designDocumentIds.contract}`, `api-${designDocumentIds.contract}`],
      [`api-${secondApiId}`, `api-${secondApiId}`],
    ]);
    for (const link of links) expect(html).toContain(`<section class="api" id="${link[2]}"`);
  });

  it("runs generated search to filter directory and APIs together, restore counts and reset deep scroll", () => {
    const project = multiApiProject();
    const secondRequest = project.collections[1]!.apis[0]!.contract.request;
    if (secondRequest.protocol !== "http") throw new Error("Expected HTTP fixture.");
    secondRequest.method = "POST";
    secondRequest.path = "/admin/audit";
    const html = document.renderDocumentHtml(buildDocumentProjection(createProjectSnapshot(project), { kind: "project" }));
    const sections = [...html.matchAll(/<section class="api" id="([^"]+)" data-search="([^"]*)">/g)]
      .map((match) => ({ id: match[1]!, dataset: { search: match[2]! }, hidden: false }));
    const entries = [...html.matchAll(/<li([^>]*)><a href="#([^"]+)">/g)]
      .map((match) => ({ id: match[2]!, dataset: { apiTarget: match[1]!.match(/data-api-target="([^"]+)"/)?.[1] }, hidden: false }));
    let input = () => {};
    let toggle = () => {};
    let expanded = "false";
    let scrollTop = 0;
    const classes = new Set<string>();
    const contents = { scrollTop: 0, classList: { toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) } };
    const search = { value: "", addEventListener: (_event: string, handler: () => void) => { input = handler; } };
    const summary = { textContent: "Showing 2 APIs" };
    const elements = new Map<string, unknown>(sections.map((section) => [section.id, section]));
    elements.set("document-search", search);
    elements.set("search-summary", summary);
    elements.set("document-contents", contents);
    elements.set("document-sidebar", { getBoundingClientRect: () => ({ height: 200 }) });
    elements.set("contents-toggle", {
      getAttribute: () => expanded,
      setAttribute: (_name: string, value: string) => { expanded = value; },
      addEventListener: (_event: string, handler: () => void) => { toggle = handler; },
    });
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    // Only the generated fixed script runs; this synthetic DOM boundary does not render HTML/CSS.
    runInNewContext(script!, {
      document: {
        documentElement: { style: { setProperty: () => {} } },
        getElementById: (id: string) => elements.get(id),
        querySelectorAll: (selector: string) => {
          if (selector === "[data-search]") return sections;
          if (selector === "[data-api-target]") return entries;
          throw new Error(`Unexpected selector: ${selector}`);
        },
        addEventListener: () => {},
      },
      window: { addEventListener: () => {}, scrollTo: (options: { top: number }) => { scrollTop = options.top; } },
    });

    const first = `api-${designDocumentIds.contract}`;
    const second = `api-${secondApiId}`;
    for (const [query, expected] of [
      [" ADMIN READ ", [second]], ["post", [second]], ["/users/", [first]],
      ["PUBLIC", [first]], ["not-present", []], ["", [first, second]],
    ] as const) {
      search.value = query;
      scrollTop = 1500;
      contents.scrollTop = 500;
      input();
      expect(sections.filter((section) => !section.hidden).map((section) => section.id)).toEqual(expected);
      expect(entries.filter((entry) => !entry.hidden).map((entry) => entry.id)).toEqual(expected);
      expect(summary.textContent).toBe(`Showing ${expected.length} of 2 APIs`);
      expect(scrollTop).toBe(0);
      expect(contents.scrollTop).toBe(0);
    }
    toggle();
    expect(expanded).toBe("true");
    expect(classes.has("is-open")).toBe(true);
    toggle();
    expect(expanded).toBe("false");
    expect(classes.has("is-open")).toBe(false);
  });
});
