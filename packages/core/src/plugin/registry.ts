import type {
  AssertOperator, AuthProvider, Importer, PluginContext, PluginDefinition,
  PluginRegistryApi, ProtocolClient, Reporter, ScriptEngine, StorageAdapter,
} from "./types.js";

export interface PluginRegistry extends PluginRegistryApi {
  getAssert(op: string): AssertOperator | undefined;
  listAsserts(): AssertOperator[];
  getScriptEngine(language: string): ScriptEngine | undefined;
  getReporter(format: string): Reporter | undefined;
  listImporters(): Importer[];
  getAuth(type: string): AuthProvider | undefined;
  getStorage(): StorageAdapter | undefined;
  getProtocol(request: { url: string }): ProtocolClient | undefined;
  plugin(def: PluginDefinition): void;
}

export function createPluginRegistry(): PluginRegistry {
  const protocols = new Map<string, ProtocolClient>();
  const auths = new Map<string, AuthProvider>();
  const asserts = new Map<string, AssertOperator>();
  const engines = new Map<string, ScriptEngine>();
  const reporters = new Map<string, Reporter>();
  const importers = new Map<string, Importer>();
  let storage: StorageAdapter | undefined;

  const api: PluginRegistry = {
    registerProtocol(client) { protocols.set(client.constructor.name, client); },
    registerAuth(p) { auths.set(p.type, p); },
    registerAssert(o) { asserts.set(o.op, o); },
    registerScriptEngine(e) { engines.set(e.language, e); },
    registerReporter(r) { reporters.set(r.format, r); },
    registerImporter(i) { importers.set(i.name, i); },
    registerStorage(s) { storage = s; },
    getAssert: (op) => asserts.get(op),
    listAsserts: () => [...asserts.values()],
    getScriptEngine: (l) => engines.get(l),
    getReporter: (f) => reporters.get(f),
    listImporters: () => [...importers.values()],
    getAuth: (t) => auths.get(t),
    getStorage: () => storage,
    getProtocol(request) {
      for (const client of protocols.values()) if (client.canHandle(request as never)) return client;
      return undefined;
    },
    plugin(def) {
      def.setup({ registry: api });
    },
  };
  return api;
}
