import { createDefaultRegistry } from "@apicc/core";
import { runCli } from "../../dist/main.js";

const accessRef = "synthetic-oauth-access";
const refreshRef = "synthetic-oauth-refresh";
const versions = new Map([
  [accessRef, process.env.APICC_TEST_ACCESS_VERSION ?? "synthetic-access-version"],
  [refreshRef, process.env.APICC_TEST_REFRESH_VERSION ?? "synthetic-refresh-version"],
]);
const values = new Map([
  [accessRef, process.env.APICC_TEST_ACCESS_TOKEN ?? "synthetic-access-token"],
  [refreshRef, "synthetic-refresh-token"],
]);
const store = {
  async put(_scope, ref, value) {
    values.set(ref.id, value);
    versions.set(ref.id, "unexpected-child-secret-write");
  },
  async resolve(_scope, ref, expectedVersion) {
    if (expectedVersion !== undefined && versions.get(ref.id) !== expectedVersion) throw new Error("synthetic version conflict");
    const value = values.get(ref.id);
    if (value === undefined) throw new Error("synthetic secret missing");
    return value;
  },
  async version(_scope, ref) {
    const version = versions.get(ref.id);
    if (version === undefined) throw new Error("synthetic secret missing");
    return version;
  },
  async remove(_scope, ref) { values.delete(ref.id); versions.delete(ref.id); },
  async status(_scope, ref) { return values.has(ref.id) ? "available" : "missing"; },
};

const code = await runCli(process.argv.slice(2), createDefaultRegistry(), console.log, {
  secretStore: store,
  oauthPrivateRoot: process.env.APICC_TEST_OAUTH_ROOT,
  networkPrivateRoot: process.env.APICC_TEST_NETWORK_ROOT,
  pluginsHomeDir: process.env.APICC_TEST_PLUGIN_HOME,
  loadPlugins: false,
});
process.exitCode = code;
