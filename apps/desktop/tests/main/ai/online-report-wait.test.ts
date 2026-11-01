import { expect, it } from "vitest";
import { createOnlineSession } from "../../../src/main/online/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import { createOnlineExecutionHost } from "../../../src/main/online/execution.js";
import { stressV2Report } from "../../helpers/stressV2.js";
it("cancels a pending legacy-local report reader without cancelling or waiting for the original business execution", async () => {
  let entered!: () => void, release!: (response: Response) => void, executionSignal: AbortSignal | undefined;
  const enteredPromise = new Promise<void>(r => { entered = r; }), gate = new Promise<Response>(r => { release = r; });
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/auth/login")) return Response.json({ token: "synthetic-member", expiresAt: "2027-01-01T00:00:00Z", user: { id: "7", username: "member", displayName: "Member", role: "USER", disabled: false } });
    expect(String(url)).toBe("https://control.test/api/v1/workspaces/11/projects/33/execution-agents"); executionSignal = init?.signal ?? undefined; entered(); return gate;
  };
  const session = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: transport, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await session.login({ baseUrl: "https://control.test", username: "member", password: "synthetic" }); session.openWorkspace({ workspaceId: "11", name: "Workspace", myRole: "EDITOR" });
  const context = { serverId: "https://control.test/api/v1", ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } }, host = createOnlineExecutionHost({ session, fetch: transport });
  const runId = "10000000-0000-4000-8000-000000000001", location = { kind: "local" as const };
  const original = host.handle({ operation: "run", context, runId, location, target: { kind: "stress", plan: stressV2Report().plan }, expectedVersion: "1", runConfig: {}, materials: { projectId: "33", credentials: [], attachments: [] }, localOnlyRefIds: [] }).catch(e => e);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await enteredPromise; const abort = new AbortController();
    const reading = host.handle({ operation: "report", context, runId, location }, { signal: abort.signal }).then(() => "delivered", () => "cancelled");
    abort.abort(); const outcome = await Promise.race([reading, new Promise<string>(r => { timer = setTimeout(() => r("still-waiting"), 200); })]);
    expect(outcome).toBe("cancelled"); expect(executionSignal?.aborted).toBe(false);
  } finally { if (timer) clearTimeout(timer); release(Response.json({ deliberate: "invalid preparation: never start a worker" })); await original; await host.close(); }
});
