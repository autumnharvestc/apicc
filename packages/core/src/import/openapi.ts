import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ProjectSchema } from "../domain/model.js";
import { sanitizeNodeName } from "../storage/sanitize.js";
import type { ApiDefinition, Project } from "../domain/model.js";
import type { Importer, ImportedProject } from "../plugin/types.js";

type AnyDoc = Record<string, unknown>;

export const openapiImporter: Importer = {
  name: "openapi",
  detect(_fileName, content) {
    try {
      const doc = parseYaml(content) as AnyDoc;
      return typeof doc?.openapi === "string" || doc?.swagger === "2.0";
    } catch {
      return false;
    }
  },
  parse(content): ImportedProject {
    const doc = parseYaml(content) as AnyDoc;
    const isV3 = typeof doc.openapi === "string";
    const warnings: string[] = [];
    const info = doc.info as { title: string };

    let baseUrl: string;
    if (isV3) {
      const servers = (doc.servers ?? []) as Array<{ url: string }>;
      baseUrl = servers[0]?.url ?? "{{baseUrl}}";
      if (!servers[0]) warnings.push("未声明 servers，baseUrl 需要手动补齐");
    } else {
      const scheme = ((doc.schemes ?? ["https"]) as string[])[0];
      baseUrl = `${scheme}://${doc.host as string}${doc.basePath as string ?? ""}`;
    }

    const apis: ApiDefinition[] = [];
    const paths = (doc.paths ?? {}) as Record<string, Record<string, AnyDoc>>;
    const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(pathItem)) {
        if (!httpMethods.has(method)) continue;
        const operation = op as {
          operationId?: string; summary?: string; description?: string;
          parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>;
          requestBody?: { content?: Record<string, { schema?: unknown }> };
          responses?: Record<string, unknown>;
        };
        // 域模型无独立 path 参数位：path/query 参数一并落入 query 列表（可编辑占位），URL 保留 {id} 占位符。
        const queryParams = (operation.parameters ?? []).filter((p) => p.in === "query" || p.in === "path");
        // 2.0 的请求体定义在操作级 parameters（in: body / formData）；与 3.0 requestBody 同用时 requestBody 优先。
        const bodyParam = (operation.parameters ?? []).find((p) => p.in === "body");
        const formParams = (operation.parameters ?? []).filter((p) => p.in === "formData");
        const jsonSchema = operation.requestBody?.content?.["application/json"]?.schema ?? bodyParam?.schema;
        if (operation.responses && !operation.responses["200"] && !operation.responses["201"]) {
          warnings.push(`接口 ${method.toUpperCase()} ${path} 无 2xx 响应定义`);
        }
        let body: ApiDefinition["body"];
        if (jsonSchema) {
          body = { kind: "json", content: JSON.stringify(jsonSchema, null, 2) };
          if (formParams.length > 0) warnings.push(`接口 ${method.toUpperCase()} ${path} 的 formData 参数已忽略（存在请求体 schema）`);
        } else if (formParams.length > 0) {
          body = { kind: "form", content: "", form: formParams.map((p) => ({ key: p.name, value: "", enabled: true })) };
        }
        apis.push({
          id: randomUUID(),
          name: sanitizeNodeName(operation.operationId ?? operation.summary ?? `${method.toUpperCase()} ${path}`),
          version: String((doc.info as AnyDoc).version ?? "1.0.0"),
          deprecated: false,
          method: method.toUpperCase() as ApiDefinition["method"],
          url: `{{baseUrl}}${path}`,
          headers: [],
          query: queryParams.map((p) => ({ key: p.name, value: "", enabled: true })),
          body,
          design: jsonSchema || operation.description
            ? `# 接口设计\n\n${operation.description ?? ""}\n\n## 请求体 schema\n\n\`\`\`yaml\n${jsonSchema ? stringifyYaml(jsonSchema) : "无"}\n\`\`\`\n`
            : undefined,
          cases: [{ id: randomUUID(), name: sanitizeNodeName(`${operation.operationId ?? path}-smoke`), scope: "base", parameters: {}, assertions: [] }],
        });
      }
    }

    const project: Project = {
      id: randomUUID(), name: sanitizeNodeName(info.title), variables: {},
      environments: [{ id: randomUUID(), name: "imported", variables: { baseUrl }, baseUrls: {} }],
      collections: [{ id: randomUUID(), name: sanitizeNodeName(info.title), variables: {}, folders: [], apis }],
      workflows: [],
    };
    // 严格 schema 自校验：导入产物必须恰好匹配域模型字段（多余字段 fail-fast）。
    return { project: ProjectSchema.parse(project), warnings };
  },
};
