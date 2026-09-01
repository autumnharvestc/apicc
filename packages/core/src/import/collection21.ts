import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { ProjectSchema } from "../domain/model.js";
import type { ApiDefinition, Collection, Folder, Project } from "../domain/model.js";
import type { Importer, ImportedProject } from "../plugin/types.js";

interface V21Item {
  name: string;
  item?: V21Item[];
  request?: {
    method: string;
    url: { raw: string; query?: Array<{ key: string; value?: string; disabled?: boolean }> } | string;
    header?: Array<{ key: string; value?: string; disabled?: boolean }>;
    body?: { mode: string; raw?: string; urlencoded?: Array<{ key: string; value?: string }> };
    description?: string;
  };
  event?: unknown[];
  response?: unknown[];
}

function newId(): string {
  return randomUUID();
}

function toApi(item: V21Item): ApiDefinition | null {
  const req = item.request;
  if (!req) return null;
  const rawUrl = typeof req.url === "string" ? req.url : req.url.raw;
  const query = typeof req.url === "string" ? [] : (req.url.query ?? []).map((q) => ({
    key: q.key, value: q.value ?? "", enabled: !q.disabled,
  }));
  const headers = (req.header ?? []).map((h) => ({ key: h.key, value: h.value ?? "", enabled: !h.disabled }));
  let body: ApiDefinition["body"];
  if (req.body?.mode === "raw") {
    const isJson = req.body.raw?.trimStart().startsWith("{") || req.body.raw?.trimStart().startsWith("[");
    body = { kind: isJson ? "json" : "raw", content: req.body.raw ?? "" };
  } else if (req.body?.mode === "urlencoded" || req.body?.mode === "formdata") {
    body = { kind: "form", content: "", form: (req.body.urlencoded ?? []).map((kv) => ({ key: kv.key, value: kv.value ?? "", enabled: true })) };
  }
  return {
    id: newId(), name: item.name, version: "1.0.0", deprecated: false,
    method: (req.method ?? "GET").toUpperCase() as ApiDefinition["method"],
    url: rawUrl, headers, query, body,
    cases: [{ id: newId(), name: `${item.name}-smoke`, scope: "base", parameters: {}, assertions: [] }],
  };
}

function walk(items: V21Item[], collection: Collection, warnings: string[]): void {
  for (const item of items) {
    if (item.item) {
      const folder: Folder = { id: newId(), name: item.name, apis: [] };
      for (const child of item.item) {
        const api = toApi(child);
        if (api) folder.apis.push(api);
      }
      collection.folders.push(folder);
    } else {
      const api = toApi(item);
      if (api) collection.apis.push(api);
    }
    if (item.event?.length) warnings.push(`接口「${item.name}」携带脚本事件，已跳过（可手动补写前置/后置脚本）`);
    if (item.response?.length) warnings.push(`接口「${item.name}」携带响应示例，已跳过`);
  }
}

export const collectionV21Importer: Importer = {
  name: "collection-v21",
  detect(_fileName, content) {
    try {
      const doc = parseYaml(content) as { info?: { schema?: string } };
      return typeof doc?.info?.schema === "string" && doc.info.schema.startsWith("v2.");
    } catch {
      return false;
    }
  },
  parse(content): ImportedProject {
    const doc = parseYaml(content) as { info: { name: string }; item: V21Item[] };
    const warnings: string[] = [];
    const collection: Collection = { id: newId(), name: doc.info.name, variables: {}, folders: [], apis: [] };
    walk(doc.item ?? [], collection, warnings);
    const project: Project = { id: newId(), name: doc.info.name, variables: {}, environments: [], collections: [collection] };
    // 严格 schema 自校验：导入产物必须恰好匹配域模型字段（多余字段 fail-fast）。
    return { project: ProjectSchema.parse(project), warnings };
  },
};
