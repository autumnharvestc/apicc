import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { ApiAsset } from "../contract/model.js";
import { contractAiView } from "../ai/contractView.js";
import { redactCommonCredentialText } from "../import/schemaMapping.js";
import { renderContractMarkdown as renderContractMarkdownBase } from "./contractMarkdown.js";

/** Render Markdown from the selected immutable asset and the context for the same project snapshot. */
export function renderDesignMarkdown(asset: DeepReadonly<ApiAsset>, context: ProjectAssetContextReadView): string {
  const contract = context.getContract(asset.contract.id);
  if (!contract) throw new TypeError("The API asset must belong to the supplied project snapshot context.");
  const view = contractAiView(asset, context);
  const request = asRecord(view.request);
  const protocol = stringOr(request?.protocol, "unknown");
  const protocolDetails = protocol === "websocket"
    ? `- WebSocket message template: ${stringOr(request?.message, "")}`
    : protocol === "soap"
      ? `- SOAP envelope: ${stringOr(request?.envelope, "")}\n- SOAPAction: ${stringOr(request?.soapAction, "")}`
      : "";
  const version = stringOr(view.version, "");
  const documentation = asset.documentation
    ? `## Documentation\n\n${redactCommonCredentialText(asset.documentation)}`
    : "";
  const caseRows = asset.cases.map((testCase) =>
    `| ${testCase.name} | ${testCase.scope} | ${testCase.assertions.length} |`,
  );
  const cases = [
    "## Test cases",
    "",
    "| Name | Scope | Assertions |",
    "|------|-------|------------|",
    ...caseRows,
  ].join("\n");
  return [
    renderContractMarkdownBase(asset, context),
    `## Contract metadata\n\n- Version: ${version}\n- Status: ${contract.metadata.status}`,
    protocolDetails ? `## Protocol details\n\n${protocolDetails}` : "",
    documentation,
    cases,
  ].filter(Boolean).join("\n\n");
}

/** Explicit name for new consumers; retained entrypoint has the same snapshot-based contract. */
export const renderContractMarkdown = renderDesignMarkdown;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
