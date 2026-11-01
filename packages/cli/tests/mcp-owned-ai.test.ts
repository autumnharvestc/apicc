import { Command } from "commander";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDefaultRegistry } from "@apicc/core";
import { registerAiCommands } from "../src/ai/commands.js";
import * as sources from "../src/mcp/source.js";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { createMcpLocalExecutionHost } from "../src/mcp/localExecution.js";
import { localCaseExecutionFixture, outcome, signal } from "./mcp-execution.fixture.js";
import { oid } from "./mcp-online.fixture.js";

it("r55_ai_analysis_refuses_the_actual_owned_failure_before_any_ai_fetch_or_business_retry", async () => {
  const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
    const request = project.collections[0]!.apis[0]!.contract.request;
    if (request.protocol !== "http") throw new Error("actual HTTP fixture required");
    request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
  } });
  f.writeDriver("fixed-before-prepare");
  const adapter = createMcpLocalExecutionHost({ networkPrivateRoot: join(f.privateRoot, "network") }), started = vi.spyOn(adapter, "start");
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: adapter });
  let sourceFactory: ReturnType<typeof vi.spyOn> | undefined, aiRequests = 0;
  try {
    const ticket = await host.prepare(f.input, signal()); f.writeDriver("changed-source-before-business-start");
    const run = await host.start({ ticketId: ticket.ticketId, intentId: "ai-owned-known-failure" }, signal());
    expect((await outcome(() => started.mock.results[0]!.value)).error).toBe("FILE_SOURCE_CHANGED");
    expect(await f.source.getReport(run.runId, {}, signal())).toMatchObject({ failure: { executionFact: "not-started", reasonCode: "FILE_SOURCE_CHANGED" } });
    // Only factory selection is substituted: all authority, paging and report reads stay on this actual source.
    sourceFactory = vi.spyOn(sources, "createMcpSource").mockResolvedValue(f.source);
    const command = new Command();
    registerAiCommands(command, { registry: createDefaultRegistry(), workspaceRoot: () => f.workspaceRoot, log() {}, aiHomeDir: f.privateRoot,
      aiEnv: { APICC_AI_BASE_URL: "https://synthetic-ai.example/v1", APICC_AI_API_KEY: "SYNTHETIC_ONLY", APICC_AI_MODEL: "synthetic-model" },
      aiFetch: async () => { aiRequests++; throw new Error("unexpected synthetic AI request"); },
    });
    const result = await outcome(() => command.parseAsync(["node", "apicc", "ai", "analyze-report", `groups/${oid(2)}/projects/${oid(3)}`, "--report", run.runId, "--confirm-send"]));
    expect.soft(result.error ?? "").toMatch(/原生报告|native report|报告未采集/);
    expect(aiRequests).toBe(0); expect(f.requests).toEqual([]); expect(started).toHaveBeenCalledTimes(1);
  } finally { sourceFactory?.mockRestore(); await host.close(); await f.close(); }
});
