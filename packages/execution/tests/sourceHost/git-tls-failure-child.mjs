import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { access, rm } from "node:fs/promises";

// Isolate a possible uncaught event-callback exception; deliberately no uncaught handler.
let text = "";
for await (const chunk of process.stdin) { text += chunk; if (text.length > 65536) throw Error("Test descriptor too large"); }
const descriptor = JSON.parse(text);
const { createSourceHost } = await import(pathToFileURL(descriptor.entry).href);
const require = createRequire(descriptor.entry);
const { prepareNetworkRun } = await import(pathToFileURL(require.resolve("@apicc/core")).href);
const prepared = await prepareNetworkRun({ scope: { canonicalRoot: descriptor.root, project: { workspaceId: "owned", groupId: "owned", projectId: "owned" } }, store: { load: async () => ({ revision: "1", configuration: { formatVersion: 1, profiles: [], environmentSelections: [] } }), save: async () => "1" }, secretStore: {}, selection: { kind: "direct" } });
const events = []; let released = 0; let retained = 0; let delivered = 0;
const exists = () => access(descriptor.directory).then(() => true, () => false);
const host = createSourceHost({
  git: { tools: descriptor.tools, createPrivateRead: async () => ({ directory: descriptor.directory, collect: async () => { await rm(descriptor.directory, { recursive: true, force: true }); events.push("collected"); }, retainUncollected: async () => { retained++; } }) },
  captureNetwork: async () => ({ prepared, policyIdentity: "owned-policy-v1", materialIdentity: "owned-material-v1", approveDestination: () => true }),
  resolveAddresses: async () => [{ address: descriptor.address, family: 4 }],
  onContent: async () => { delivered++; },
});
const lease = { ...descriptor.lease, release: async () => { released++; events.push(await exists() ? "released-existing" : "released-absent"); } };
process.stdout.write(JSON.stringify({ stage: "public-read", node: process.versions.node }) + "\n");
let failure;
try { await host.readSource(descriptor.input, lease); }
catch (error) { failure = { code: error.code, message: String(error) }; }
process.stdout.write(JSON.stringify({ failure, released, retained, delivered, directoryExists: await exists(), events }) + "\n");
