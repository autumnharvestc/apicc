import { mkdtemp, readFile, readdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { buildSourceHostResources } from "../../scripts/build-source-host-resources.mjs";
import { withGitSource, type GitSourceFixture } from "./git-fixture.mjs";
import type { Socket } from "node:net";

/** A client timeout may reset these intentionally stalled owned endpoints; other errors remain visible. */
export function observeOwnedPeerReset(socket: Socket): void { socket.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") throw error; }); }

/** One fresh service for sequential cases, with explicit lifetime and no concurrent mutable state. */
export async function holdGitSource() {
  let release!: () => void; let ready!: (fixture: GitSourceFixture) => void; let rejectReady!: (error: unknown) => void;
  const untilClosed = new Promise<void>(resolve => { release = resolve; });
  const available = new Promise<GitSourceFixture>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const running = withGitSource(async fixture => { ready(fixture); await untilClosed; });
  running.catch(rejectReady);
  return { fixture: await available, close: async () => { release(); await running; } };
}

/** Explicit test application install; runtime imports only adjacent built resources. */
export async function installGitApplication() {
  const directory = await mkdtemp(join(tmpdir(), "apicc-git-application-"));
  const source = fileURLToPath(new URL("../../src/source-host/", import.meta.url));
  for (const name of await readdir(source)) if (name.endsWith(".ts")) await writeFile(join(directory, name.slice(0, -3) + ".js"), ts.transpileModule(await readFile(join(source, name), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await symlink(fileURLToPath(new URL("../../node_modules/", import.meta.url)), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await buildSourceHostResources({ outputDirectory: directory, platform: process.platform });
  const api = await import(/* @vite-ignore */ pathToFileURL(join(directory, "index.js")).href) as typeof import("../../src/source-host/index.js");
  const processApi = await import(/* @vite-ignore */ pathToFileURL(join(directory, "process.js")).href) as typeof import("../../src/source-host/process.js");
  const toolApi = await import(/* @vite-ignore */ pathToFileURL(join(directory, "tools.js")).href) as typeof import("../../src/source-host/tools.js");
  return { directory, api, processApi, toolApi, close: () => rm(directory, { recursive: true, force: true }) };
}
