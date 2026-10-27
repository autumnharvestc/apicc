// Test-only Electron main driver of the actual desktop online host. No renderer/UI automation.
import { readFile, writeFile } from "node:fs/promises";
import { createOnlineSession } from "../../../dist-electron/main/online/session.js";
import { createOnlineClient } from "../../../dist-electron/main/online/client.js";
import { createOnlineExecutionHost } from "../../../dist-electron/main/online/execution.js";
import { createSystemSecretStore } from "@apicc/core";
import { join } from "node:path";
import assert from "node:assert/strict";
const app = process.versions.electron ? (await import("electron")).app : { quit() {}, exit(code) { process.exit(code); } };

let host, cleanup = [], context;
try {
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  const session = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  const login = await session.login({ baseUrl: input.baseUrl, username: input.username, password: input.password });
  session.openWorkspace({ workspaceId: input.scope.workspaceId, name: "T11 synthetic", myRole: "OWNER" });
  context = { serverId: `${input.baseUrl}/api/v1`, ownerId: login.user.id, scope: input.scope };
  cleanup = input.cleanup ?? [];
  host = createOnlineExecutionHost({ session, localStore: () => createSystemSecretStore({ privateRoot: join(input.privateRoot, "credentials") }) });
  const results = [];
  for (const operation of input.operations) {
    if (operation.expectError) {
      let caught; try { await host.handle({ ...operation.input, context }); } catch (error) { caught = error; }
      assert(caught instanceof Error && caught.message.includes(operation.expectError), `Expected ${operation.expectError}; received ${String(caught)}`); results.push({ expectedError: operation.expectError });
    } else results.push(await host.handle({ ...operation, context }));
  }
  await writeFile(process.argv[3], JSON.stringify({ runtime: process.versions, results }, null, 2) + "\n");
  for (const operation of cleanup) await host.handle({ ...operation, context }); cleanup = [];
  await host.close(); app.quit();
} catch (error) { console.error(error); for (const operation of cleanup) { try { await host?.handle({ ...operation, context }); } catch (cleanupError) { console.error(cleanupError); } } await host?.close(); app.exit(1); }
