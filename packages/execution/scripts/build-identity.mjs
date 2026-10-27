import { readFile, readdir, writeFile, mkdir, lstat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_IDENTITY_ALGORITHM, fingerprintSources } from "../src/buildIdentity.ts";

// Anchored to this script, never process.cwd(); the source list itself participates in the identity.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifestPath = "packages/execution/build-identity-sources.json";
const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
if (manifest.manifestVersion !== 1 || manifest.algorithm !== BUILD_IDENTITY_ALGORITHM) throw new Error("unsupported build identity manifest");
const paths = new Set(manifest.files);
const visit = async (directory) => {
  for (const name of (await readdir(join(root, directory))).sort()) {
    if (manifest.excludeNames.includes(name)) continue;
    const path = `${directory}/${name}`;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`symlink is not a deterministic source: ${path}`);
    if (info.isDirectory()) await visit(path);
    else if (manifest.sourceExtensions.includes(extname(path))) paths.add(path);
  }
};
for (const directory of manifest.sourceDirectories) await visit(directory);
const sourceFiles = [...paths].sort();
const entries = await Promise.all(sourceFiles.map(async path => {
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith("..")) throw new Error("source manifest escapes repository");
  return { path, bytes: await readFile(absolute) };
}));
const scriptFiles = new Set(manifest.scriptApiFiles);
if (![...scriptFiles].every(path => paths.has(path))) throw new Error("script API source missing from build manifest");
const identity = {
  algorithm: BUILD_IDENTITY_ALGORITHM,
  coreBuildId: fingerprintSources(entries),
  scriptApiId: fingerprintSources(entries.filter(entry => scriptFiles.has(entry.path))),
  capabilities: [...manifest.capabilities].sort(),
  sourceFiles,
};
if (process.argv.includes("--print")) console.log(JSON.stringify(identity));
else {
  const output = new URL("../dist/build-identity.json", import.meta.url);
  await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(identity, null, 2) + "\n");
  console.log(`execution build identity ${identity.coreBuildId} (${sourceFiles.length} source files)`);
}
