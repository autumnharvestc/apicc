import { z } from "zod";
import builtin from "./providers.v1.json" with { type: "json" };
import { AiConnectionSchema, AiProviderTemplateSchema, type AiConnection, type AiProviderTemplate } from "./config.js";

export const builtinAiProviderCatalog: unknown = builtin;
export const AiProviderCatalogSchema = z.object({ formatVersion: z.literal(1), providers: z.array(AiProviderTemplateSchema) }).strict();
export interface AiCatalogLoadResult {
  catalog: readonly AiProviderTemplate[];
  errors: { file: string; field: string; message: string }[];
  diff: { added: string[]; updated: string[]; removed: string[] };
}
export function loadAiProviderCatalog(builtin: unknown, overrides: readonly unknown[], previous: readonly AiProviderTemplate[] = []): AiCatalogLoadResult {
  const errors: AiCatalogLoadResult["errors"] = [];
  const entries = new Map<string, AiProviderTemplate>();
  for (const [index, file] of [builtin, ...overrides].entries()) {
    const name = index === 0 ? "builtin" : `overrides[${index - 1}]`;
    const parsed = AiProviderCatalogSchema.safeParse(file);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map(issue => ({ file: name, field: issue.path.join("."), message: "供应商模板字段无效" })));
      continue;
    }
    const seen = new Set<string>();
    for (const provider of parsed.data.providers) {
      if (seen.has(provider.id)) errors.push({ file: name, field: "providers.id", message: "文件内 ID 重复" });
      seen.add(provider.id);
      entries.set(provider.id, provider);
    }
  }
  if (errors.length) return { catalog: structuredClone(previous), errors, diff: { added: [], updated: [], removed: [] } };
  const catalog = [...entries.values()];
  const old = new Map(previous.map(p => [p.id, p]));
  return { catalog, errors, diff: {
    added: catalog.filter(p => !old.has(p.id)).map(p => p.id),
    updated: catalog.filter(p => old.has(p.id) && JSON.stringify(old.get(p.id)) !== JSON.stringify(p)).map(p => p.id),
    removed: previous.filter(p => !entries.has(p.id)).map(p => p.id),
  } };
}
export function createAiConnectionFromTemplate(template: AiProviderTemplate, input: { id: string; name: string; credentialRef?: string }): AiConnection {
  const validated = AiProviderTemplateSchema.parse(template);
  return AiConnectionSchema.parse({ ...input, revision: 1, owner: { kind: "personal" },
    templateSource: { id: validated.id, revision: validated.revision }, baseUrl: validated.baseUrl,
    protocols: [...validated.protocols], auth: { ...validated.auth }, headers: { ...validated.headers }, insecureLocalTest: validated.insecureLocalTest,
  });
}
