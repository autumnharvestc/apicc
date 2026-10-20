import type { ImportExchangeDiagnostic } from "./merge.js";
import { createProjectSnapshot } from "../assets/snapshot.js";
import type { ContractProject } from "../contract/workspace.js";
import type { AssetDiagnostic } from "../assets/context.js";

const informationalCodes = new Set([
  "AUTH_VALUE_REMOVED",
  "REQUEST_FILE_NOT_BOUND",
  "OPENAPI_INFO_DESCRIPTION_UNREPRESENTED",
  "OPENAPI_INFO_FIELD_UNSUPPORTED",
  "OPENAPI_EXTERNAL_DOCS_UNREPRESENTED",
  "OPENAPI_TAG_METADATA_UNREPRESENTED",
  "SCRIPT_EVENT_NOT_IMPORTED",
]);

function safeDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|etc)\/)[^\s"'<>]*/g, "[local path]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[id]");
}

function assetDiagnosticMessage(diagnostic: AssetDiagnostic): string {
  switch (diagnostic.code) {
    case "ASSET_REFERENCE_MISSING": return "引用的目标资产不存在。";
    case "ASSET_REFERENCE_KIND_MISMATCH": return "引用目标资产类型不匹配。";
    case "ASSET_ID_DUPLICATE": return "资产 ID 重复，无法确定唯一目标。";
    case "ASSET_MODEL_REFERENCE_CYCLE": return "模型引用形成循环。";
    case "ASSET_PARAMETER_LOCATION_MISMATCH": return "参数组件的位置与所属参数列表不匹配。";
    case "ASSET_PARAMETER_NAME_DUPLICATE": return "同一参数位置存在重复名称。";
    case "ASSET_RESPONSE_STATUS_CONTENT_TYPE_DUPLICATE": return "同一响应状态和媒体类型重复定义。";
    case "ASSET_NOT_FOUND": return "资产引用目标不存在。";
    default: return "资产定义存在结构诊断。";
  }
}

/** Derive non-overridable import errors from the host's existing project asset graph. */
export function projectAssetImportDiagnostics(project: ContractProject): ImportExchangeDiagnostic[] {
  return createProjectSnapshot(project).context.diagnostics.map((diagnostic) => ({
    severity: "error",
    code: diagnostic.code,
    path: safeDiagnosticText(diagnostic.path),
    message: assetDiagnosticMessage(diagnostic),
    lossy: false,
  }));
}

/** Merge preview and plan diagnostics without showing the same public warning twice. */
export function deduplicateImportDiagnostics(diagnostics: readonly ImportExchangeDiagnostic[]): ImportExchangeDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.path, diagnostic.message, diagnostic.lossy]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Normalize legacy plugin diagnostics without exposing parser-owned IDs or unsafe paths. */
export function normalizeImportDiagnostics(parsed: unknown): ImportExchangeDiagnostic[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const source = parsed as { diagnostics?: unknown; warnings?: unknown };
  const diagnostics: ImportExchangeDiagnostic[] = Array.isArray(source.diagnostics)
    ? source.diagnostics.map((item, index) => {
      const value = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
      const code = typeof value.code === "string" ? value.code : `IMPORT_DIAGNOSTIC_${index + 1}`;
      const structuralError = /(UNRESOLVED|MISSING|CYCLE|COLLISION|DUPLICATE|INVALID|CONFLICT$|REFERENCE_UNSUPPORTED)/i.test(code);
      const severity: ImportExchangeDiagnostic["severity"] = value.severity === "error" || structuralError ? "error" : "warning";
      const message = typeof value.message === "string" ? value.message
        : typeof value.reason === "string" ? value.reason : "Importer reported a diagnostic.";
      const lossy = severity === "error" ? false
        : typeof value.lossy === "boolean" ? value.lossy
          : typeof value.reason === "string" && !informationalCodes.has(code);
      return {
        severity,
        code,
        path: safeDiagnosticText(typeof value.path === "string" ? value.path : ""),
        message: safeDiagnosticText(message),
        lossy,
      };
    }) : [];
  if (Array.isArray(source.warnings)) {
    for (const warning of source.warnings) {
      if (typeof warning !== "string") continue;
      const message = safeDiagnosticText(warning);
      if (diagnostics.some((item) => item.message === message)) continue;
      diagnostics.push({ severity: "warning", code: "IMPORT_WARNING", path: "", message, lossy: false });
    }
  }
  return diagnostics;
}
