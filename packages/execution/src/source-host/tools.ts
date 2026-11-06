import { stat, readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runOwnedProcess } from "./process.js";
import { SourceHostError } from "./limits.js";

export interface SourceGitTools {
  readonly gitPath: string;
  readonly sshPath?: string;
}
export interface ProbedSourceGitTools extends SourceGitTools {
  readonly capabilities: { readonly objectFormats: readonly ("sha1" | "sha256")[] } & ({ readonly transport: "git-https"; readonly httpSmart: true } | { readonly transport: "git-ssh"; readonly strictSsh: true });
}
/** The same finite app-owned settings are probed and written into per-read SSH configuration. */
export const sourceSshSettings: readonly (readonly [string, string])[] = [
  ["StrictHostKeyChecking", "yes"], ["IdentitiesOnly", "yes"], ["IdentityAgent", "none"], ["ProxyCommand", "none"], ["ProxyJump", "none"],
  ["PasswordAuthentication", "no"], ["KbdInteractiveAuthentication", "no"], ["PreferredAuthentications", "publickey"], ["NumberOfPasswordPrompts", "1"],
  ["ForwardAgent", "no"], ["ClearAllForwardings", "yes"], ["PermitLocalCommand", "no"], ["ControlMaster", "no"], ["ControlPath", "none"], ["RequestTTY", "no"], ["UpdateHostKeys", "no"],
];
/** Only trusted installation/system directories; never inherit PATH, Git or SSH settings. */
export function sourceToolEnvironment(tools: SourceGitTools, directory: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? "C:/Windows";
  return {
    ...(process.platform === "win32" ? { SystemRoot: systemRoot, PROGRAMDATA: process.env.PROGRAMDATA ?? "C:/ProgramData" } : {}),
    PATH: (process.platform === "win32" ? [dirname(tools.gitPath), resolve(dirname(tools.gitPath), "../mingw64/bin"), join(systemRoot, "System32")] : [dirname(tools.gitPath), ...(tools.sshPath ? [dirname(tools.sshPath)] : [])]).join(delimiter),
    HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, TEMP: directory, TMP: directory,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
  };
}
/** Probe installed tools, including both object formats, rather than trusting caller flags. */
export async function probeSourceGitTools(tools: SourceGitTools, signal: AbortSignal, transport: "git-https" | "git-ssh", privateRoot?: string): Promise<ProbedSourceGitTools> {
  const paths = [tools.gitPath, ...(transport === "git-ssh" ? [tools.sshPath] : [])];
  if (!paths.every(path => typeof path === "string" && isAbsolute(path))) throw new SourceHostError("SYNC_TOOL_CONFIG_INVALID");
  for (const path of paths) {
    try { if (!(await stat(path!)).isFile()) throw new Error(); } catch { throw new SourceHostError("SYNC_TOOL_UNAVAILABLE"); }
  }
  const directory = await mkdtemp(join(privateRoot ?? tmpdir(), "apicc-source-tool-probe-")); let retained = false;
  try {
    const env = sourceToolEnvironment(tools, directory);
    const run = (toolPath: string, args: string[], cwd = directory) => runOwnedProcess({ toolPath, args, cwd, env, maxOutputBytes: 512 * 1024, signal });
    const git = await run(tools.gitPath, ["--version"]);
    if (git.exitCode || !/^git version \d/.test(git.stdout.toString())) throw new SourceHostError("SYNC_GIT_CAPABILITY_UNSUPPORTED");
    const template = join(directory, "empty-template"); await mkdir(template);
    for (const format of ["sha1", "sha256"] as const) {
      const repository = join(directory, format);
      const init = await run(tools.gitPath, ["init", "--bare", `--object-format=${format}`, `--template=${template}`, repository]);
      if (init.exitCode) throw new SourceHostError("SYNC_GIT_CAPABILITY_UNSUPPORTED");
      const actual = await run(tools.gitPath, ["rev-parse", "--show-object-format"], repository);
      if (actual.exitCode || actual.stdout.toString().trim() !== format) throw new SourceHostError("SYNC_GIT_CAPABILITY_UNSUPPORTED");
    }
    if (transport === "git-https") {
      const executionPath = await run(tools.gitPath, ["--exec-path"]);
      try { if (executionPath.exitCode || !(await stat(join(executionPath.stdout.toString().trim(), process.platform === "win32" ? "git-remote-http.exe" : "git-remote-http"))).isFile()) throw new Error(); } catch { throw new SourceHostError("SYNC_GIT_CAPABILITY_UNSUPPORTED"); }
      return { ...tools, capabilities: { objectFormats: ["sha1", "sha256"], transport, httpSmart: true } };
    }
    const ssh = await run(tools.sshPath!, ["-V"]);
    if (ssh.exitCode || !/OpenSSH(?:_for_Windows)?[_ ]\d+\./.test(ssh.stderr.toString())) throw new SourceHostError("SYNC_SSH_CAPABILITY_UNSUPPORTED");
    const sshConfig = await run(tools.sshPath!, ["-G", "-F", process.platform === "win32" ? "NUL" : "/dev/null", ...sourceSshSettings.flatMap(([name, value]) => ["-o", `${name}=${value}`]), "owned.invalid"]);
    const text = sshConfig.stdout.toString();
    if (sshConfig.exitCode || !/^stricthostkeychecking (?:true|yes)$/m.test(text.replaceAll("\r", "")) || !/^identityagent none$/m.test(text.replaceAll("\r", ""))) throw new SourceHostError("SYNC_SSH_CAPABILITY_UNSUPPORTED");
    return { ...tools, capabilities: { objectFormats: ["sha1", "sha256"], transport, strictSsh: true } };
  } catch (error) {
    retained = error instanceof SourceHostError && error.code === "SYNC_PROCESS_UNCOLLECTED";
    throw error;
  } finally { if (!retained) await rm(directory, { recursive: true, force: true }); }
}
/** The URL is an application module resource, never a SourceReadInput path. */
export async function resolveOwnedProcessHelper(moduleURL: string): Promise<string> {
  const physical = fileURLToPath(new URL("./", moduleURL)).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  const executable = join(physical, "owned-process.exe"); let bytes: Buffer; let metadata: unknown;
  try {
    const info = await stat(executable); const manifestInfo = await stat(join(physical, "owned-process.resource.json"));
    if (info.size > 16 * 1024 * 1024 || manifestInfo.size > 4096) throw new SourceHostError("SYNC_PROCESS_HELPER_INVALID");
    bytes = await readFile(executable); metadata = JSON.parse(await readFile(join(physical, "owned-process.resource.json"), "utf8"));
  } catch (error) {
    if (error instanceof SourceHostError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SourceHostError("SYNC_PROCESS_HELPER_UNAVAILABLE");
    throw new SourceHostError("SYNC_PROCESS_HELPER_INVALID");
  }
  const manifest = metadata as { formatVersion?: number; executableSha256?: string; sourceSha256?: string };
  if (manifest?.formatVersion !== 1 || !/^[0-9a-f]{64}$/.test(manifest.sourceSha256 ?? "") || manifest.executableSha256 !== createHash("sha256").update(bytes).digest("hex")) throw new SourceHostError("SYNC_PROCESS_HELPER_INVALID");
  return executable;
}
