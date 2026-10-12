import { parse as parseYaml } from "yaml";
import { parseContractCollection21 } from "./contractCollection21.js";
import type { Importer, ImportedProject } from "../plugin/types.js";

type ParsedDocument = Record<string, unknown>;

function parseDocument(content: string): ParsedDocument {
  const parsed: unknown = parseYaml(content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("A collection v2.1 document object is required.");
  }
  return parsed as ParsedDocument;
}

export const collectionV21Importer: Importer = {
  name: "collection-v21",
  detect(_fileName, content) {
    try {
      const document = parseDocument(content);
      const info = document.info;
      if (info === null || typeof info !== "object" || Array.isArray(info)) return false;
      const schema = (info as Record<string, unknown>).schema;
      return typeof schema === "string" && /v2\.\d/.test(schema);
    } catch {
      return false;
    }
  },
  parse(content): ImportedProject {
    const result = parseContractCollection21(parseDocument(content));
    return {
      project: result.project,
      diagnostics: result.diagnostics,
      warnings: result.diagnostics.map((diagnostic) => diagnostic.reason),
    };
  },
};
