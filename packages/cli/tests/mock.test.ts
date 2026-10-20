import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMockConfiguredProject } from "../../core/tests/helpers/mockFixtures.js";
import { ContractProjectSchema, fileStorage } from "@apicc/core";
import { IDS, makeWorkspace, makeTempRoot, persistWorkspace } from "../../../apps/desktop/tests/main/helpers/contract-assets.js";
import { createMockManager } from "../../../apps/desktop/src/main/mockManager.js";
import { createSession } from "../../../apps/desktop/src/main/session.js";
import type { ProjectLocator } from "../../../apps/desktop/src/shared/locations.js";
import { spawnOwnedCliProcess, type OwnedCliProcess } from "./helpers/ownedCliProcess.js";

const projectPath = `groups/${IDS.groupOne}/projects/${IDS.projectOne}`;
const entry = join(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
let activeChild: OwnedCliProcess | undefined;
let activeRoot: Awaited<ReturnType<typeof makeTempRoot>> | undefined;
let activeDesktopManager: ReturnType<typeof createMockManager> | undefined;

const projectLocator: ProjectLocator = {
  workspaceId: IDS.workspace,
  groupId: IDS.groupOne,
  projectId: IDS.projectOne,
};

afterEach(async () => {
  if (activeDesktopManager) {
    await activeDesktopManager.stopAll();
    activeDesktopManager = undefined;
  }
  if (activeChild) {
    const result = await activeChild.cleanup();
    if (!result.closeConfirmed) throw new Error(`Mock CLI child did not confirm close: ${result.terminationDiagnostics.join("; ")}`);
    activeChild = undefined;
  }
  await activeRoot?.dispose();
  activeRoot = undefined;
});

function portCanBeRebound(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

describe("foreground mock command", () => {
  it("serves a real request, keeps seed override ephemeral, and releases the listener on signal", async () => {
    activeRoot = await makeTempRoot("apicc-b3-cli-");
    const workspace = makeWorkspace();
    workspace.groups[0]!.projects[0] = ContractProjectSchema.parse({ ...createMockConfiguredProject(), id: IDS.projectOne });
    await persistWorkspace(activeRoot.path, workspace);

    const desktopSession = createSession();
    await desktopSession.open(activeRoot.path);
    activeDesktopManager = createMockManager({ session: desktopSession });
    const desktopFixture = await activeDesktopManager.start(projectLocator);
    expect(desktopFixture.status).toBe("running");

    activeChild = spawnOwnedCliProcess({
      command: process.execPath,
      args: [entry, "--no-plugins", "mock", projectPath, "--port", "0", "--seed", "cli-only-seed"],
      cwd: activeRoot.path,
      env: { ...process.env, NODE_ENV: "test" },
      timeoutMs: 10_000,
      readyToken: "MOCK_READY ",
    });
    let output = "";
    activeChild.child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    await activeChild.waitForReady(5_000);
    const address = output.match(/MOCK_READY (http:\/\/\S+) revision=\S+/)?.[1];
    expect(address).toBeTruthy();
    const response = await fetch(`${address}/items/item-7`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "item-7" });

    await activeDesktopManager.stopAll();
    activeDesktopManager = undefined;
    const cliAfterDesktopFixtureClose = await fetch(`${address}/items/item-7`);
    expect(cliAfterDesktopFixtureClose.status).toBe(200);
    await expect(cliAfterDesktopFixtureClose.json()).resolves.toEqual({ id: "item-7" });

    const saved = await fileStorage.load(activeRoot.path);
    expect(saved.workspace.groups[0]!.projects[0]!.mock?.seed).toBe("b1-fixed-seed");
    const terminationSignal = process.platform === "win32" ? "SIGTERM" : "SIGINT";
    expect(activeChild.child.kill(terminationSignal)).toBe(true);
    const stopped = await activeChild.result;
    expect(stopped.closeConfirmed).toBe(true);
    expect(activeChild.closeEventObserved()).toBe(true);
    expect(stopped.termination).toBe("exit");
    await expect(fetch(`${address}/items/item-7`)).rejects.toThrow();
    const port = Number(new URL(address!).port);
    await portCanBeRebound(port);
    if (process.platform === "win32") {
      expect(stopped.exitCode).toBeNull();
      expect(stopped.signal).toBe("SIGTERM");
    } else {
      expect(stopped.exitCode).toBe(0);
      expect(stopped.signal).toBeNull();
    }
    activeChild = undefined;
  });
});
