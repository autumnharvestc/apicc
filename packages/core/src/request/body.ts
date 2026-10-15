import type { DeepReadonly } from "../assets/context.js";
import type { RequestBody } from "../contract/model.js";
import type { LocalFileReference } from "../contract/request.js";
import type { KeyValuePair } from "../domain/model.js";
import { RequestMaterializationError } from "./parameters.js";

export type RuntimeBody =
  | { kind: "json" | "xml" | "raw"; content: string }
  | { kind: "form"; content: string; form: KeyValuePair[] }
  | { kind: "binary"; file: LocalFileReference; contentType: string }
  | { kind: "multipart"; entries: Array<
      | { kind: "text"; name: string; value: string; enabled?: boolean }
      | { kind: "file"; name: string; file: LocalFileReference; filename?: string; contentType: string; enabled?: boolean }
    > };

export function materializeBody(
  body: DeepReadonly<RequestBody>,
  globals: readonly DeepReadonly<KeyValuePair>[],
  resolve: (template: string) => string,
): RuntimeBody | undefined {
  switch (body.kind) {
    case "none":
      return undefined;
    case "json":
    case "xml":
      return { kind: body.kind, content: resolve(body.content) };
    case "text":
      return { kind: "raw", content: resolve(body.content) };
    case "graphql": {
      const payload: { query: string; variables?: unknown; operationName?: string } = { query: resolve(body.query) };
      if (body.variables !== undefined && body.variables.trim() !== "") {
        try {
          const variables: unknown = JSON.parse(resolve(body.variables));
          if (typeof variables !== "object" || variables === null || Array.isArray(variables)) {
            throw new Error("variables must be a JSON object");
          }
          payload.variables = variables;
        } catch {
          throw new RequestMaterializationError("GRAPHQL_VARIABLES_INVALID", "GraphQL variables must resolve to a JSON object.");
        }
      }
      if (body.operationName !== undefined) payload.operationName = resolve(body.operationName);
      return { kind: "json", content: JSON.stringify(payload) };
    }
    case "urlencoded": {
      const fields = body.fields.filter((field) => field.enabled).map((field) => ({
        key: field.name,
        value: resolve(field.value),
        enabled: true,
      }));
      const namesInRequest = new Set(body.fields.map((field) => field.name));
      const extra = globals
        .filter((field) => field.enabled && field.key.length > 0 && !namesInRequest.has(field.key))
        .map((field) => ({ key: field.key, value: resolve(field.value), enabled: true }));
      return { kind: "form", content: "", form: [...fields, ...extra] };
    }
    case "multipart":
      return {
        kind: "multipart",
        entries: body.entries.filter((entry) => entry.enabled).map((entry) => entry.kind === "text"
          ? { kind: "text", name: entry.name, value: resolve(entry.value) }
          : {
              kind: "file", name: entry.name, file: { path: entry.file.path },
              ...(entry.filename === undefined ? {} : { filename: entry.filename }),
              contentType: entry.contentType ?? "application/octet-stream",
            }),
      };
    case "binary":
      return { kind: "binary", file: { path: body.file.path }, contentType: body.contentType };
  }
}
