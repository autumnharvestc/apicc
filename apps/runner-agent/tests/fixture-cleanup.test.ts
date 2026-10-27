import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";

type Owner = "e2e" | "ui" | "server";
// Run the actual owner teardown block without executing its Java/Docker startup.
// Only external Docker/child-stop operations are replaced; sockets and evidence files are real and private.
function cleanupBody(owner: Owner): string {
  const name = owner === "e2e" ? "e2e-server.test.ts" : owner === "ui" ? "ui-service.mjs" : "server-fixture.ts";
  const file = ts.createSourceFile(name, readFileSync(new URL(name, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let body: ts.Block | undefined;
  const visit = (node: ts.Node): void => {
    if (owner === "e2e" && ts.isCallExpression(node) && node.expression.getText(file) === "afterAll") body = (node.arguments[0] as ts.ArrowFunction).body as ts.Block;
    if (owner === "ui" && ts.isTryStatement(node) && node.parent === file) body = node.finallyBlock;
    if (owner === "server" && ts.isPropertyAssignment(node) && node.name.getText(file) === "close" && ts.isArrowFunction(node.initializer)) body = node.initializer.body as ts.Block;
    if (owner === "server" && ts.isVariableDeclaration(node) && node.name.getText(file) === "close" && node.initializer && ts.isArrowFunction(node.initializer)) body = node.initializer.body as ts.Block;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!body) throw new Error(`No actual teardown found for ${owner}`);
  return ts.transpileModule(body.statements.map(statement => statement.getText(file)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
async function listen(): Promise<Server> {
  const server = createServer((_request, response) => response.end("owned synthetic resource"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// The regression is an early evidence/stop error preventing unrelated owned listeners from closing.
it.each<Owner>(["e2e", "ui", "server"])("%s teardown closes independent resources after an early failure and preserves unsafe data", async owner => {
  const root = mkdtempSync(join(tmpdir(), "apicc-t11-cleanup-"));
  const volumeRoot = join(root, "owned-volume"); mkdirSync(volumeRoot); writeFileSync(join(volumeRoot, "ledger"), "synthetic evidence");
  const target = await listen(), control = await listen();
  const failure = new Error(`synthetic ${owner} external failure`);
  let stopped = false;
  const command = (_file: string, args: string[]) => {
    if (args[0] === "exec") throw failure;
    if (args[0] === "stop") { if (owner === "ui") throw failure; stopped = true; return "stopped"; }
    if (args[0] === "inspect") return JSON.stringify({ Running: !stopped, ExitCode: stopped ? 0 : null });
    if (args[0] === "cp") { writeFileSync(args[2]!, "copied synthetic ledger"); return ""; }
    if (args[0] === "volume" && args[1] === "rm") {
      if (!stopped) throw new Error("Attempted deletion while stop was unconfirmed");
      rmSync(volumeRoot, { recursive: true });
    }
    return "";
  };
  const bindings = {
    gates: owner === "e2e" ? new Map() : new Set(), containerCreated: true, volumeCreated: true, container: true, volumeMade: true,
    name: "owned-container", volume: "owned-volume", target, proxy: target,
    server: { root, close: () => close(control) }, dispatcher: { close: () => close(control) }, stop: async () => { throw failure; }, root, serviceFailure: undefined,
    command, spawnSync: () => ({ status: 0, stdout: "synthetic log", stderr: "" }),
    readFileSync, writeFileSync, appendFileSync, join, process: { env: {} }, expect,
  };
  let caught: unknown;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(...Object.keys(bindings), cleanupBody(owner))(...Object.values(bindings)).catch((error: unknown) => { caught = error; });
    expect.soft(target.listening, "owned target/proxy must close despite the unrelated failure").toBe(false);
    expect.soft(control.listening, "owned control/dispatcher must also close").toBe(false);
    expect.soft(String(caught), "the original external failure must remain observable").toContain(failure.message);
    if (owner !== "server") expect.soft(existsSync(volumeRoot), "delete data only after confirming the corresponding container stopped").toBe(owner === "ui");
  } finally {
    await close(target); await close(control);
    // No process ever used this synthetic directory; this is test fallback, not owner teardown evidence.
    rmSync(root, { recursive: true });
  }
});

it("formal smoke attempts every independent volume and writes machine evidence when one removal fails", async () => {
  const source = ts.createSourceFile('smoke-runner-agent.mjs', readFileSync(new URL('../../../scripts/smoke-runner-agent.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const statement = source.statements.find(node => ts.isTryStatement(node));
  if (!statement || !ts.isTryStatement(statement) || !statement.finallyBlock) throw new Error('Actual smoke finally block missing');
  const root = mkdtempSync(join(tmpdir(), 'apicc-final-smoke-cleanup-'));
  const first = join(root, 'volume-one'), second = join(root, 'volume-two'), output = join(root, 'evidence.json');
  mkdirSync(first); mkdirSync(second);
  const result = { resources: { root }, cleanup: [] as unknown[], failure: 'original controlled smoke failure' };
  const removals: string[] = []; const removalError = new Error('controlled first volume removal failure');
  const bindings = { containers: new Set(), volumes: new Set([first, second]), composeArgs: undefined, composeEnv: undefined, root, output, passed: false, result, prefix: 'owned-smoke',
    docker: (args: string[]) => { if (args[0] !== 'volume' || args[1] !== 'rm') throw new Error('Unexpected operation'); removals.push(args[2]!); if (args[2] === first) throw removalError; if (args[2] !== second) throw new Error('Unowned synthetic volume'); rmSync(second, { recursive: true }); },
    writeFileSync, rmSync, realpathSync: (path: string) => path, dirname: () => 'never-remove-root', tmpdir: () => 'private-temp', process: { exitCode: 0 }, console: { log() {}, error() {} },
  };
  let caught: unknown;
  try {
    const body = statement.finallyBlock.statements.map(node => node.getText(source)).join('\n');
    try { new Function(...Object.keys(bindings), body)(...Object.values(bindings)); } catch (error) { caught = error; }
    expect.soft(removals).toEqual([first, second]);
    expect.soft(existsSync(second)).toBe(false);
    expect.soft(existsSync(output)).toBe(true);
    if (existsSync(output)) {
      const evidence = JSON.parse(readFileSync(output, 'utf8'));
      expect.soft(evidence.passed).toBe(false);
      expect.soft(evidence.failure).toBe('original controlled smoke failure');
      expect.soft(JSON.stringify(evidence.cleanup)).toContain(removalError.message);
    }
    expect.soft(caught, 'cleanup must not replace the original smoke failure').toBeUndefined();
  } finally { rmSync(root, { recursive: true }); }
});
