import type { ProjectAssetContextReadView, DeepReadonly } from "../assets/context.js";
import type { ApiAsset } from "../contract/model.js";
import { contractAiView } from "../ai/contractView.js";

/** Render the same read-only design projection consumed by AI into Markdown. */
export function renderContractMarkdown(asset: DeepReadonly<ApiAsset>, context: ProjectAssetContextReadView): string {
  const view = contractAiView(asset, context);
  const request = view.request;
  const requestRecord = asRecord(request);
  const auth = asRecord(requestRecord?.auth);
  const authLabel = auth ? `${stringOr(auth.kind, "unknown")}${auth.placeholder ? ` (${auth.placeholder})` : ""}` : "unknown";
  const heading = `# ${view.name}`;
  const summary = [
    `- Contract ID: ${view.contractId}`,
    `- Method: ${stringOr(requestRecord?.method, stringOr(requestRecord?.protocol, "unknown").toUpperCase())}`,
    `- Base URL: ${stringOr(requestRecord?.baseUrl, "")}`,
    `- Path: ${stringOr(requestRecord?.path, "")}`,
    `- Authentication: ${authLabel}`,
  ].join("\n");
  const parameters = JSON.stringify({
    pathParams: requestRecord?.pathParams ?? [],
    query: requestRecord?.query ?? [],
    headers: requestRecord?.headers ?? [],
    cookies: requestRecord?.cookies ?? [],
    body: requestRecord?.body,
  }, null, 2);
  const responses = JSON.stringify(view.responses, null, 2);
  const models = JSON.stringify(view.models, null, 2);
  return [
    heading,
    stringOr(view.description, ""),
    "## Request",
    summary,
    "### Parameters and body",
    codeBlock(parameters),
    "## Responses",
    codeBlock(responses),
    "## Referenced models",
    codeBlock(models),
  ].filter(Boolean).join("\n\n");
}

function codeBlock(value: string | undefined): string {
  const serialized = value ?? "null";
  const fence = serialized.includes("```") ? "````" : "```";
  return `${fence}json\n${serialized}\n${fence}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
