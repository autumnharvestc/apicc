#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(join(repositoryRoot, "apps/desktop/package.json"));
const ts = desktopRequire("typescript");
const sourceRoots = ["packages/core/src", "packages/cli/src", "apps/desktop/src"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".vue"]);
const legacySourcePattern = /\b(?:ApiDefinition|LooseApi|ApiDefinitionSchema)\b/;
const rendererEagerForbiddenMarkers = [
  "@napi-rs/keyring",
  "better-sqlite3",
  "node:sqlite",
  "createSystemSecretStore",
  "defaultCredentialPrivateRoot",
];
const rendererCredentialForbiddenMarkers = [
  "@napi-rs/keyring",
  "SystemSecretStore",
  "createSystemSecretStore",
  "defaultCredentialPrivateRoot",
];

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

const legacyHits = [];
for (const relativeRoot of sourceRoots) {
  const root = join(repositoryRoot, relativeRoot);
  walk(root, (path) => {
    if (!sourceExtensions.has(extname(path))) return;
    const contents = readFileSync(path, "utf8");
    if (legacySourcePattern.test(contents)) legacyHits.push(path.slice(repositoryRoot.length + 1));
  });
}

const rendererRoot = join(repositoryRoot, "apps/desktop/dist-renderer");
if (!existsSync(rendererRoot)) throw new Error(`renderer build output not found: ${rendererRoot}`);
const rendererFiles = [];
const rendererCredentialHits = [];
walk(rendererRoot, (path) => {
  if (extname(path) !== ".js") return;
  rendererFiles.push(path);
  const contents = readFileSync(path, "utf8");
  for (const marker of rendererCredentialForbiddenMarkers) {
    if (contents.includes(marker)) rendererCredentialHits.push({ file: relative(rendererRoot, path), marker });
  }
});

if (rendererFiles.length === 0) throw new Error("renderer build did not produce JavaScript assets");
const html = readFileSync(join(rendererRoot, "index.html"), "utf8");
const moduleScriptTags = [...html.matchAll(/<script\b[^>]*>/gi)]
  .map(([tag]) => tag)
  .filter((tag) => /\btype\s*=\s*["']module["']/i.test(tag));
if (moduleScriptTags.length !== 1) throw new Error(`expected one renderer module entry, found ${moduleScriptTags.length}`);
const entrySource = moduleScriptTags[0]?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
if (!entrySource) throw new Error("renderer module entry has no src attribute");
const rendererEntry = resolve(rendererRoot, entrySource);
const rendererRootPrefix = `${resolve(rendererRoot)}${sep}`;
if (!rendererEntry.startsWith(rendererRootPrefix) || !existsSync(rendererEntry)) {
  throw new Error(`renderer module entry is outside or missing from build output: ${entrySource}`);
}

function parseModule(path) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function staticModuleSpecifiers(sourceFile) {
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function dynamicModuleSpecifiers(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function resolveRendererImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(fromFile), specifier);
  if (!target.startsWith(rendererRootPrefix)) throw new Error(`renderer import escapes build output: ${specifier}`);
  if (!existsSync(target)) throw new Error(`renderer import target missing from build output: ${specifier}`);
  return target;
}

const eagerFiles = new Set();
const eagerPending = [rendererEntry];
const eagerSources = new Map();
while (eagerPending.length > 0) {
  const path = eagerPending.pop();
  if (!path || eagerFiles.has(path)) continue;
  eagerFiles.add(path);
  const sourceFile = parseModule(path);
  eagerSources.set(path, sourceFile);
  for (const specifier of staticModuleSpecifiers(sourceFile)) {
    const target = resolveRendererImport(path, specifier);
    if (target) eagerPending.push(target);
  }
}

const memoryChunks = rendererFiles.filter((path) => readFileSync(path, "utf8").includes("apicc-memory-"));
if (memoryChunks.length !== 1) throw new Error(`expected one isolated memory fallback chunk, found ${memoryChunks.length}`);
const memoryChunk = memoryChunks[0];
const memoryChunkName = relative(rendererRoot, memoryChunk);
const rendererEntrySource = eagerSources.get(rendererEntry);
const entryDynamicTargets = rendererEntrySource
  ? dynamicModuleSpecifiers(rendererEntrySource)
    .map((specifier) => resolveRendererImport(rendererEntry, specifier))
    .filter((target) => target !== undefined)
  : [];
const memoryFallbackIsDynamicAndIsolated = !eagerFiles.has(memoryChunk) && entryDynamicTargets.includes(memoryChunk);
const eagerHits = [];
for (const path of eagerFiles) {
  const contents = readFileSync(path, "utf8");
  for (const marker of rendererEagerForbiddenMarkers) {
    if (contents.includes(marker)) eagerHits.push({ file: relative(rendererRoot, path), marker });
  }
}

const result = {
  cwd: process.cwd(),
  runtime: { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch },
  productionSourceLegacyHits: legacyHits,
  rendererJavaScriptFiles: rendererFiles.length,
  rendererEagerJavaScriptFiles: eagerFiles.size,
  rendererMemoryFallbackChunk: memoryChunkName,
  rendererMemoryFallbackIsolatedDynamicImport: memoryFallbackIsDynamicAndIsolated,
  rendererEagerForbiddenHits: eagerHits,
  rendererCredentialForbiddenHits: rendererCredentialHits,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (legacyHits.length > 0 || !memoryFallbackIsDynamicAndIsolated || eagerHits.length > 0 || rendererCredentialHits.length > 0) process.exitCode = 1;
