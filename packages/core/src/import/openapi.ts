import { parse as parseYaml } from "yaml";
import { parseContractOpenapi } from "./contractOpenapi.js";
import type { Importer, ImportedProject } from "../plugin/types.js";

type ParsedDocument = Record<string, unknown>;

function parseDocument(content: string): ParsedDocument {
  const parsed: unknown = parseYaml(content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("An OpenAPI document object is required.");
  }
  return parsed as ParsedDocument;
}

export const openapiImporter: Importer = {
  name: "openapi",
  detect(_fileName, content) {
    try {
      const document = parseDocument(content);
      return typeof document.openapi === "string" || document.swagger === "2.0";
    } catch {
      return false;
    }
  },
  parse(content): ImportedProject {
    const result = parseContractOpenapi(parseDocument(content));
    return {
      project: result.project,
      diagnostics: result.diagnostics,
      warnings: result.diagnostics.map((diagnostic) => diagnostic.reason),
    };
  },
};
