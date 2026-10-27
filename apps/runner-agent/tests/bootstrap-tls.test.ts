import { expect, it } from "vitest";
import { createServer } from "node:https";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapAgent } from "../src/bootstrap.js";
import { defaultAgentConfig } from "@apicc/execution/contract";

// Catches mixing the installed dispatcher's protocol with a different built-in fetch version.
it("production bootstrap reaches real HTTPS using its independent CA with certificate verification", async () => {
  const file = (name: string) => readFile(new URL(`../../../packages/core/tests/http/fixtures/network/${name}`, import.meta.url), "utf8");
  const [ca, cert, key] = await Promise.all([file("synthetic-target-ca.pem"), file("synthetic-target-server.pem"), file("synthetic-target-server.key")]);
  const root = await mkdtemp(join(tmpdir(), "apicc-bootstrap-tls-"));
  const controller = new AbortController(); let registrations = 0, polls = 0;
  let baseUrl = "";
  const control = createServer({ cert, key }, (request, response) => {
    let text = ""; request.on("data", bytes => { text += bytes; }); request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/runner/runtime") { registrations++; const body = JSON.parse(text); response.end(JSON.stringify({ registered: true, sessionId: body.sessionId, serverId: baseUrl, configuration: { configVersion: "0", config: defaultAgentConfig } })); }
      else { response.end('{"deliveries":[],"commands":[]}'); if (request.url === "/api/v1/runner/poll") { polls++; queueMicrotask(() => controller.abort()); } }
    });
  });
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve)); baseUrl = `https://127.0.0.1:${(control.address() as { port: number }).port}/api/v1`;
  const tokenFile = join(root, "token"), caFile = join(root, "ca.pem"); await writeFile(tokenFile, "t11-synthetic-control-token"); await writeFile(caFile, ca);
  const timer = setTimeout(() => controller.abort(new Error("Control readiness was not observed")), 3000);
  try {
    await expect(bootstrapAgent({ baseUrl, agentId: "1", tokenFile, trustedCaFile: caFile, dataDirectory: join(root, "data") }, controller.signal)).resolves.toBeUndefined();
    expect(registrations).toBeGreaterThan(0);
    expect(polls).toBeGreaterThan(0);
  } finally { clearTimeout(timer); controller.abort(); control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
