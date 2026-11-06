import { it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveOwnedProcessHelper } from "../../src/source-host/tools.js";
import { buildSourceHostResources } from "../../scripts/build-source-host-resources.mjs";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import ts from "typescript";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const sourcePath = "packages/execution/src/source-host/owned-process.cs";
const resourceBuilderPath = "packages/execution/scripts/build-source-host-resources.mjs";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function withDirectory(callback: (directory: string) => Promise<void>) { const directory = await mkdtemp(join(tmpdir(), "apicc-owned-resource-")); try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
const tools = process.platform === "win32" ? { gitPath: "D:/env/Git/cmd/git.exe", sshPath: "C:/Windows/System32/OpenSSH/ssh.exe", powershellPath: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" } : { gitPath: "/usr/bin/git", sshPath: "/usr/bin/ssh" };
let applicationDirectory: string;
let application: typeof import("../../src/source-host/tools.js");
beforeAll(async () => {
  applicationDirectory = await mkdtemp(join(tmpdir(), "apicc-tools-application-"));
  const sourceDirectory = fileURLToPath(new URL("../../src/source-host/", import.meta.url));
  for (const name of await readdir(sourceDirectory)) if (name.endsWith(".ts")) await writeFile(join(applicationDirectory, name.slice(0, -3) + ".js"), ts.transpileModule(await readFile(join(sourceDirectory, name), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  await writeFile(join(applicationDirectory, "package.json"), '{"type":"module"}');
  await buildSourceHostResources({ outputDirectory: applicationDirectory, platform: process.platform, powershellPath: tools.powershellPath });
  application = await import(/* @vite-ignore */ pathToFileURL(join(applicationDirectory, "tools.js")).href);
}, 30000);
afterAll(async () => { if (applicationDirectory) await rm(applicationDirectory, { recursive: true, force: true }); });
const probeSourceGitTools = (input: import("../../src/source-host/tools.js").SourceGitTools, signal: AbortSignal) => application.probeSourceGitTools(input, signal, "git-ssh");
// Premise: real installed tools exist; refusal tests exercise product validation.
it("accepts installed Git/OpenSSH after real required capability probes", async () => {
  expect((await exec(tools.gitPath, ["--version"])).stdout).toMatch(/^git version /);
  await expect(probeSourceGitTools(tools, new AbortController().signal)).resolves.toMatchObject(tools);
});
it("returns actual format and strict SSH capabilities for the selected transport", async () => {
  const probed = await probeSourceGitTools(tools, new AbortController().signal);
  expect(probed.capabilities).toEqual({ objectFormats: ["sha1", "sha256"], transport: "git-ssh", strictSsh: true });
});
it("probes HTTPS transport without requiring an unused SSH tool or curloptResolve", async () => {
  await expect(application.probeSourceGitTools({ gitPath: tools.gitPath, sshPath: process.platform === "win32" ? "C:/owned-missing-ssh.exe" : "/owned-missing-ssh" }, new AbortController().signal, "git-https")).resolves.toMatchObject({ capabilities: { objectFormats: ["sha1", "sha256"], transport: "git-https", httpSmart: true } });
});
// Breakage caught: relative lookup or a different executable masquerades as Git.
it.each([{ changes: { gitPath: "git" }, code: "SYNC_TOOL_CONFIG_INVALID" }, { changes: { gitPath: process.execPath }, code: "SYNC_GIT_CAPABILITY_UNSUPPORTED" }, { changes: { sshPath: process.execPath }, code: "SYNC_SSH_CAPABILITY_UNSUPPORTED" }, { changes: { gitPath: process.platform === "win32" ? "C:/apicc-owned-missing/git.exe" : "/apicc-owned-missing/git" }, code: "SYNC_TOOL_UNAVAILABLE" }])("explicitly refuses $code", async ({ changes, code }) => {
  await expect(probeSourceGitTools({ ...tools, ...changes }, new AbortController().signal)).rejects.toMatchObject({ code });
});

// Breakage caught: Windows builds ship an absent/stale helper or unbound binary.
it("builds the native resource and copies source with artifact integrity metadata", async () => withDirectory(async directory => {
  await expect(buildSourceHostResources({ outputDirectory: directory, platform: process.platform, powershellPath: tools.powershellPath })).resolves.toBeUndefined();
  const source = await readFile(join(root, sourcePath));
  expect(await readFile(join(directory, "owned-process.cs"))).toEqual(source);
  if (process.platform === "win32") {
    const exe = await readFile(join(directory, "owned-process.exe"));
    expect(exe.subarray(0, 2).toString()).toBe("MZ");
    expect(JSON.parse(await readFile(join(directory, "owned-process.resource.json"), "utf8"))).toMatchObject({ formatVersion: 1, sourceSha256: digest(source), executableSha256: digest(exe) });
  } else expect(await access(join(directory, "owned-process.exe")).then(() => true, () => false)).toBe(false);
}));

it("the actual execution build emits the application helper resource", async () => {
  await exec(process.execPath, ["--run", "build"], { cwd: join(root, "packages/execution"), windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
  const resourcePath = join(root, "packages/execution/dist/source-host", process.platform === "win32" ? "owned-process.exe" : "owned-process.cs");
  expect(await access(resourcePath).then(() => true, () => false)).toBe(true);
}, 60000);

async function isolatedIdentityTree(directory: string) {
  const manifest = JSON.parse(await readFile(join(root, "packages/execution/build-identity-sources.json"), "utf8"));
  const paths = new Set<string>(manifest.files);
  const visit = async (relative: string) => { for (const entry of await readdir(join(root, relative), { withFileTypes: true })) { if (manifest.excludeNames.includes(entry.name)) continue; const path = `${relative}/${entry.name}`; if (entry.isDirectory()) await visit(path); else if (manifest.sourceExtensions.includes(extname(path))) paths.add(path); } };
  for (const sourceDirectory of manifest.sourceDirectories) await visit(sourceDirectory);
  // Resource and builder exist even before the product manifest learns about them.
  paths.add(sourcePath); paths.add(resourceBuilderPath);
  for (const path of paths) { const target = join(directory, path); await mkdir(dirname(target), { recursive: true }); await copyFile(join(root, path), target); }
}
// Exercise the real fingerprint generator on an isolated source copy, never mutate product source.
it.each([sourcePath, resourceBuilderPath])("changes execution identity when %s bytes change", async changedPath => withDirectory(async directory => {
  await isolatedIdentityTree(directory);
  const run = async () => JSON.parse((await exec(process.execPath, [join(directory, "packages/execution/scripts/build-identity.mjs"), "--print"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout);
  const before = await run(); await writeFile(join(directory, changedPath), Buffer.concat([await readFile(join(directory, changedPath)), Buffer.from("\n// owned identity change\n")]));
  const after = await run(); expect(after.coreBuildId).not.toBe(before.coreBuildId);
}));

// Model the actual physical unpack tree; packed Electron access itself is T14 evidence.
it.each([{ mode: "intact", code: null }, { mode: "tampered", code: "SYNC_PROCESS_HELPER_INVALID" }, { mode: "missing", code: "SYNC_PROCESS_HELPER_UNAVAILABLE" }])("resolves or refuses the $mode physical app.asar.unpacked helper", async ({ mode, code }) => withDirectory(async directory => {
  const relative = "node_modules/@apicc/execution/dist/source-host";
  const unpacked = join(directory, "app.asar.unpacked", relative); await mkdir(unpacked, { recursive: true });
  const bytes = Buffer.from("MZ-owned-resource-marker"); const executable = join(unpacked, "owned-process.exe"); await writeFile(executable, bytes);
  await writeFile(join(unpacked, "owned-process.resource.json"), JSON.stringify({ formatVersion: 1, executableSha256: digest(bytes), sourceSha256: "1".repeat(64) }));
  const moduleURL = pathToFileURL(join(directory, "app.asar", relative, "tools.js")).href;
  if (mode === "tampered") await writeFile(executable, "MZ-tampered");
  if (mode === "missing") await rm(executable);
  if (code) await expect(resolveOwnedProcessHelper(moduleURL)).rejects.toMatchObject({ code });
  else await expect(resolveOwnedProcessHelper(moduleURL)).resolves.toBe(executable);
}));

// Feed actual packaging settings to the installed ASAR packer, not a YAML-field assertion.
it("desktop ASAR settings physically unpack helper bytes and their integrity metadata", async () => withDirectory(async directory => {
  const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
  const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
  const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar") as { createPackageWithOptions(source: string, output: string, options: { unpack: string }): Promise<void> };
  const yaml = desktopRequire("yaml") as { parse(text: string): { asarUnpack: string[] } };
  const settings = yaml.parse(await readFile(join(root, "apps/desktop/electron-builder.yml"), "utf8"));
  const relative = "node_modules/@apicc/execution/dist/source-host";
  const source = join(directory, "application"); await mkdir(join(source, relative), { recursive: true });
  await writeFile(join(source, relative, "owned-process.exe"), "MZ-owned-packaging-marker");
  await writeFile(join(source, relative, "owned-process.resource.json"), '{"formatVersion":1}');
  const output = join(directory, "app.asar");
  const unpack = settings.asarUnpack.length === 1 ? settings.asarUnpack[0] : `{${settings.asarUnpack.join(",")}}`;
  await asar.createPackageWithOptions(source, output, { unpack });
  const physical = join(output + ".unpacked", relative);
  expect(await access(join(physical, "owned-process.exe")).then(() => true, () => false)).toBe(true);
  expect(await readFile(join(physical, "owned-process.exe"), "utf8")).toBe("MZ-owned-packaging-marker");
  expect(await readFile(join(physical, "owned-process.resource.json"), "utf8")).toBe('{"formatVersion":1}');
}));
