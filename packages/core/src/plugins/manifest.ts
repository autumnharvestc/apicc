import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validatePluginManifest } from "@apicc/plugin-sdk";
import type { PluginManifestV1 } from "@apicc/plugin-sdk";
import { checkRawCompatibility, checkVersions, PluginLoadError } from "./compatibility.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digestValue = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function normalizeManifest(input: unknown, hostVersion: string): PluginManifestV1 {
  checkRawCompatibility(input);
  const checked = validatePluginManifest(input);
  if (!checked.ok) throw new PluginLoadError("manifest_invalid", checked.problems.map(p => `${p.path}: ${p.reason}`).join("; "));
  const m = checked.manifest!;
  checkVersions(m, hostVersion);
  if (!m.entry.startsWith("./") && !m.entry.startsWith("../")) throw new PluginLoadError("manifest_invalid", "entry 须为相对静态清单目录的文件路径");
  return { manifestVersion: 1, id: m.id, name: m.name, version: m.version, apiVersion: 1,
    engines: { apicc: m.engines.apicc }, entry: m.entry,
    capabilities: [...m.capabilities].sort(),
    contributions: m.contributions.map(c => ({ kind: c.kind, id: c.id })).sort((a, b) => a.id.localeCompare(b.id)),
    ...(m.configSchema === undefined ? {} : { configSchema: structuredClone(m.configSchema) }),
  };
}
export function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new PluginLoadError("manifest_invalid", `无法读取合法 JSON：${file}`); }
}
export interface StaticPlugin {
  manifest: PluginManifestV1; source: string; entry: string; manifestDigest: string; entryDigest: string;
}
export function readStaticPlugin(source: string, userManifestDir: string, hostVersion: string): StaticPlugin {
  const normalized = source.replaceAll("\\", "/");
  let file: string;
  try {
    if (isAbsolute(source) || normalized.startsWith("./") || normalized.startsWith("../")) {
      const local = isAbsolute(source) ? resolve(source) : resolve(userManifestDir, normalized);
      file = existsSync(local) && statSync(local).isDirectory() ? join(local, "apicc-plugin.json") : local;
      if (!file.endsWith(".json") || !existsSync(file)) throw Error("missing");
    } else {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(source)) throw Error("invalid package name");
      file = createRequire(join(userManifestDir, "plugins.json")).resolve(`${source}/apicc-plugin.json`);
    }
    file = realpathSync(file);
  } catch { throw new PluginLoadError("manifest_missing", "缺少可读取的静态 apicc-plugin.json；请升级插件并在包 exports 中导出清单"); }
  const manifest = normalizeManifest(readJson(file), hostVersion);
  let packageDir = dirname(file);
  while (!existsSync(join(packageDir, "package.json")) && dirname(packageDir) !== packageDir) packageDir = dirname(packageDir);
  const pkg = readJson(join(packageDir, "package.json")) as { name?: unknown; version?: unknown } | null;
  if (pkg?.name !== manifest.name || pkg?.version !== manifest.version) throw new PluginLoadError("manifest_invalid", "package.json name/version 必须与静态清单一致");
  const entry = resolve(dirname(file), manifest.entry);
  let entryDigest: string;
  try { entryDigest = createHash("sha256").update(readFileSync(entry)).digest("hex"); }
  catch { throw new PluginLoadError("manifest_invalid", `无法读取插件入口：${entry}`); }
  return { manifest, source: file, entry, manifestDigest: digestValue(manifest), entryDigest };
}
