import type { AiBusinessResult, AiContextPreview, AiInvocationHost, AiProgress, AiResolvedInvocation, AiUsage } from "./types.js";
import { buildRepairMessage, parseAiCaseOutput } from "./suggest.js";
import { parseAiAssertionWireOutput } from "./assertions.js";
import { parseAnalysisOutput } from "./analysis.js";

export class AiAssistanceError extends Error {
  constructor(readonly code: "business-output-invalid" | "purpose-mismatch" | "instruction-budget" | "preview-reprepare-required" | "evidence-selection-too-large", readonly problems: readonly string[] = []) {
    super(`AI 辅助失败（${code}）`); this.name = "AiAssistanceError";
  }
}

/** One host operation owns all structure repairs; transport errors leave it unchanged. */
export async function runAiAssistance(preview: AiContextPreview, resolved: AiResolvedInvocation, host: AiInvocationHost, options: { signal: AbortSignal; onProgress?: (event: AiProgress) => void }): Promise<AiBusinessResult> {
  const invocation = structuredClone(resolved);
  if (preview.purpose !== invocation.purpose) throw new AiAssistanceError("purpose-mismatch");
  // Count the actual confirmed payload, never stale or caller-supplied byte metadata.
  let instructionBytes = 0;
  try {
    for (const message of preview.messages.filter(item => item.role === "user")) {
      const data = JSON.parse(message.content) as { instruction?: unknown };
      if (data.instruction !== undefined && typeof data.instruction !== "string") throw new Error();
      instructionBytes += new TextEncoder().encode(data.instruction ?? "").byteLength;
    }
  } catch { throw new AiAssistanceError("preview-reprepare-required"); }
  if (instructionBytes > invocation.budgets.maxInstructionBytes) throw new AiAssistanceError("instruction-budget");
  if (preview.purpose !== "report-analysis" && (preview.limit ?? (preview.purpose === "case-suggestion" ? 5 : 10)) > invocation.budgets.candidateCount) throw new AiAssistanceError("preview-reprepare-required");
  if (preview.purpose === "report-analysis" && preview.evidence.length > invocation.budgets.evidenceCount) throw new AiAssistanceError("evidence-selection-too-large");
  return host.run({ resolved: invocation, signal: options.signal, onProgress: options.onProgress }, async session => {
    const messages = preview.messages.map(message => ({ ...message }));
    const usages: Array<AiUsage | undefined> = [];
    const problems: string[] = [];
    for (let attempt = 0; ; attempt++) {
      // Deliberately outside the parser catch: no repair after transport failure.
      const call = await session.invoke({ messages, outputSchema: preview.outputSchema, kind: attempt === 0 ? "initial" : "repair" });
      usages.push(call.usage);
      try {
        const usage: AiUsage | undefined = usages.every(value => value !== undefined) ? {
          ...(usages.every(value => value!.inputTokens !== undefined) ? { inputTokens: usages.reduce((sum, value) => sum + value!.inputTokens!, 0) } : {}),
          ...(usages.every(value => value!.outputTokens !== undefined) ? { outputTokens: usages.reduce((sum, value) => sum + value!.outputTokens!, 0) } : {}),
        } : undefined;
        const metadata = { source: preview.source, model: { profileId: invocation.model.id, modelId: invocation.model.modelId, connectionId: invocation.connection.id }, generatedAt: new Date().toISOString(), timeZone: "UTC" as const, label: "AI 辅助" as const, ...(usage ? { usage } : {}) };
        if (preview.purpose === "case-suggestion") return { purpose: preview.purpose, ...parseAiCaseOutput(call.text, preview), ...metadata };
        if (preview.purpose === "assertion-suggestion") return { purpose: preview.purpose, assertions: parseAiAssertionWireOutput(call.text, preview), evidence: preview.evidence, ...metadata };
        const parsed = parseAnalysisOutput(call.text, preview.evidence);
        const ids = new Set(parsed.observedFacts.flatMap(fact => fact.evidenceIds));
        const limitations = [...parsed.limitations, ...preview.redaction.limitations,
          ...preview.omitted.map(item => `${item.item}: ${item.reason}`),
          ...preview.evidence.filter(item => item.state !== "collected" || item.truncated).map(item => `${item.location}: ${item.state}${item.truncated ? ", truncated" : ""}`)];
        return { purpose: preview.purpose, analysis: { ...parsed, observedFacts: preview.evidence.filter(item => ids.has(item.id)), limitations: [...new Set(limitations)] }, evidence: preview.evidence, evidenceSelection: preview.evidenceSelection!, ...metadata };
      } catch (error) {
        const code = error instanceof Error && /^[a-z][a-z-]+$/.test(error.message) ? error.message : "invalid-json-or-structure";
        problems.push(code);
        if (attempt >= invocation.budgets.repairAttempts) throw new AiAssistanceError("business-output-invalid", problems);
        const format = preview.purpose === "case-suggestion" ? '{"cases":[...]}' : preview.purpose === "assertion-suggestion" ? '{"assertions":[...]}' : "（包含结论、证据引用、可能原因、核查步骤与限制的对象）";
        messages.push({ role: "assistant", content: call.text }, { role: "user", content: buildRepairMessage([code], format) });
      }
    }
  });
}
