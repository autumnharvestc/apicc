import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Agent, fetch as controlFetch } from "undici";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import { ExecutionInputsSchema, RuntimeRegistrationSchema, RuntimeRegistrationResultSchema, runtimeCompatibilityIdForRuntime, type AgentConfig, type TaskEnvelopeV1 } from "@apicc/execution/contract";
import { createAgentMaterialsClient, ExecutionHttpError } from "@apicc/execution/client";
import { initialAgentConfig, canonicalControlBaseUrl, type AgentDeployment } from "./config.js";
import { AgentSupervisor, type SettledExecution } from "./supervisor.js";
import { createLongPollingTransport } from "./transport/longPolling.js";
import { runAgentControl } from "./transport/control.js";
import { equal } from "./invocationContext.js";
import { runResultOutbox, type ArchiveReceipt } from "./outbox.js";
import type { PendingReport } from "./ledger.js";

async function boundedJSON(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Empty data response");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > maximum) { await reader.cancel(); throw new Error("Data transfer exceeds reserved input capacity"); } chunks.push(next.value); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  finally { reader.releaseLock(); }
}
/** Data requests never borrow the long-poll connection or give the task a control identity. */
export function createAgentDataClient(options: { baseUrl: string; token: () => Promise<string>; fetch: typeof fetch; config: () => AgentConfig }) {
  const base = canonicalControlBaseUrl(options.baseUrl);
  return {
    async request(path: string, method: string, body: BodyInit | undefined, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
      signal.throwIfAborted(); const controller = new AbortController(); const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      const timeout = setTimeout(() => controller.abort(new Error("Data transfer deadline")), options.config().transferTimeoutMs);
      try {
        const response = await options.fetch(`${base}/${path}`, { method, body, headers: { authorization: `Bearer ${await options.token()}`, ...headers }, signal: controller.signal, redirect: "error", cache: "no-store" });
        if (!response.ok) throw new ExecutionHttpError(response.status);
        // Complete the body under this data deadline; callers receive a buffered response.
        const maximum = options.config().inputCacheBytes; const json = await boundedJSON(response, maximum); return Response.json(json);
      } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
    },
    async inputs(task: TaskEnvelopeV1, signal: AbortSignal) { const response = await this.request(`runner/jobs/${task.jobId}/inputs?executionId=${task.executionId}`, "GET", undefined, {}, signal); return ExecutionInputsSchema.parse(await response.json()); },
    async runtime(body: unknown, signal: AbortSignal) { const response = await this.request("runner/runtime", "POST", JSON.stringify(RuntimeRegistrationSchema.parse(body)), { "content-type": "application/json" }, signal); return RuntimeRegistrationResultSchema.parse(await response.json()); },
    async upload(report: PendingReport, signal: AbortSignal): Promise<ArchiveReceipt> { const response = await this.request(`runner/jobs/${report.jobId}/report?executionId=${report.executionId}`, "PUT", new Uint8Array(Buffer.from(report.text, "utf8")), { "content-type": "application/octet-stream", "X-Report-Hash": report.hash }, signal); const receipt = await response.json() as ArchiveReceipt; if (receipt.archived !== true || receipt.reportHash !== report.hash || receipt.reportBytes !== report.bytes) throw new Error("Invalid archive acknowledgement"); return receipt; },
  };
}

/** Production assembly always opens the durable ledger; initialization never falls back to memory. */
export async function bootstrapAgent(deployment: AgentDeployment, signal: AbortSignal, hooks: { fetch?: typeof fetch; onSettled?: (result: SettledExecution) => void } = {}): Promise<void> {
  await mkdir(deployment.dataDirectory, { recursive: true });
  const identity = await readBuildIdentity(); const sessionId = randomUUID();
  const compatibility = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId);
  const token = async () => { const value = (await readFile(deployment.tokenFile, "utf8")).trim(); if (!value || /[\r\n]/.test(value)) throw new Error("Agent identity file is invalid"); return value; };
  const ca = deployment.trustedCaFile ? await readFile(deployment.trustedCaFile, "utf8") : undefined;
  const dispatcher = ca ? new Agent({ connect: { ca, rejectUnauthorized: true } }) : undefined;
  // Dispatcher handlers must come from the same installed HTTP implementation.
  const installedFetch = controlFetch as unknown as typeof fetch;
  const fetcher: typeof fetch = hooks.fetch ?? ((input, init) => installedFetch(input, { ...init, ...(dispatcher ? { dispatcher } : {}) }));
  let config = initialAgentConfig(deployment);
  let supervisor: AgentSupervisor;
  const transport = createLongPollingTransport({ baseUrl: deployment.baseUrl, token, fetch: fetcher, config: () => config, onInvalidEntry: (kind, _index, entry) => { if (kind === "delivery") supervisor.rejectMalformedDelivery(entry); } });
  const data = createAgentDataClient({ baseUrl: deployment.baseUrl, token, fetch: fetcher, config: () => config });
  supervisor = new AgentSupervisor({ dataDirectory: deployment.dataDirectory, serverId: deployment.baseUrl, agentId: deployment.agentId, sessionId, runtimeCompatibilityId: compatibility, identity, config, configVersion: "0", transport,
    loadInputs: (task, signal) => data.inputs(task, signal),
    loadMaterials: (task, signal) => createAgentMaterialsClient({ baseUrl: deployment.baseUrl, token, fetch: fetcher, timeoutMs: config.transferTimeoutMs }).loadAssigned(task.jobId, task.executionId, signal),
    onSettled: hooks.onSettled,
  });
  let registrationState = ""; let registration: Promise<void> | undefined;
  const register = async (): Promise<void> => {
    if (registration) return registration;
    const state = supervisor.configurationState(); const key = JSON.stringify(state); if (key === registrationState) return;
    registration = (async () => {
      const result = await data.runtime({ protocolVersion: 1, sessionId, coreBuildId: identity.coreBuildId, scriptApiId: identity.scriptApiId, nodeVersion: process.versions.node, v8Version: process.versions.v8, runtimeCompatibilityId: compatibility, capabilities: identity.capabilities, configuration: state }, signal);
      if (!result.registered || result.sessionId !== sessionId || canonicalControlBaseUrl(result.serverId) !== deployment.baseUrl) throw new Error("Control service identity or runtime registration mismatch");
      if (result.configuration.configVersion !== state.configVersion || !equal(result.configuration.config, supervisor.currentConfig)) supervisor.applyConfig(result.configuration.config, result.configuration.configVersion);
      config = supervisor.currentConfig; registrationState = key;
    })();
    try { await registration; } finally { registration = undefined; }
  };
  const lanes = new AbortController(); const stop = () => lanes.abort(signal.reason); signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  try {
    await register(); await register();
    await Promise.all([
      runAgentControl({ supervisor, transport, heartbeat: (input, signal) => transport.heartbeat(input, signal), sessionId, beforeExchange: async () => { config = supervisor.currentConfig; await register(); } }, lanes.signal),
      runResultOutbox({ config: () => supervisor.currentConfig, reports: () => supervisor.pendingReports(), upload: (report, signal) => data.upload(report, signal), acknowledge: (executionId, receipt) => supervisor.acknowledgeReport(executionId, receipt) }, lanes.signal),
    ]);
  } finally { lanes.abort(); signal.removeEventListener("abort", stop); await supervisor.close(); await dispatcher?.close(); }
}
