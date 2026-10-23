import type {
  AssertOperator, AuthProvider, ExecutableRequest, Importer, PluginContext, PluginDefinition,
  PluginRegistryApi, ProtocolClient, Reporter, ScriptEngine, StorageAdapter,
} from "./types.js";

export interface PluginRegistry extends PluginRegistryApi {
  /** Core-only resolver; SDK setup contexts never receive this registry. */
  installSdkResolver(resolver: SdkRegistryResolver): void;
  getAssert(op: string): AssertOperator | undefined;
  listAsserts(): AssertOperator[];
  getScriptEngine(language: string): ScriptEngine | undefined;
  getReporter(format: string): Reporter | undefined;
  listImporters(): Importer[];
  getAuth(type: string): AuthProvider | undefined;
  getStorage(): StorageAdapter | undefined;
  getProtocol(request: ExecutableRequest): ProtocolClient | undefined;
  /** Host-only metadata selection: never probes built-in canHandle or guest callbacks. */
  getSdkProtocol(request: ExecutableRequest): ProtocolClient | undefined;
  plugin(def: PluginDefinition): void;
}

export interface SdkRegistryResolver {
  getAssert(op: string): AssertOperator | undefined;
  listAsserts(): AssertOperator[];
  getReporter(format: string): Reporter | undefined;
  listImporters(): Importer[];
  getAuth(type: AuthProvider["type"]): AuthProvider | undefined;
  getProtocol(request: ExecutableRequest): ProtocolClient | undefined;
}

export function createPluginRegistry(): PluginRegistry {
  const protocols = new Map<string, ProtocolClient>();
  const auths = new Map<string, AuthProvider>();
  const asserts = new Map<string, AssertOperator>();
  const engines = new Map<string, ScriptEngine>();
  const reporters = new Map<string, Reporter>();
  const importers = new Map<string, Importer>();
  let storage: StorageAdapter | undefined;
  let sdk: SdkRegistryResolver | undefined;

  const api: PluginRegistry = {
    installSdkResolver(resolver) { sdk = resolver; },
    registerProtocol(client) { protocols.set(client.name, client); },
    registerAuth(p) { auths.set(p.type, p); },
    registerAssert(o) { asserts.set(o.op, o); },
    registerScriptEngine(e) { engines.set(e.language, e); },
    registerReporter(r) { reporters.set(r.format, r); },
    registerImporter(i) { importers.set(i.name, i); },
    registerStorage(s) { storage = s; },
    getAssert: (op) => sdk?.getAssert(op) ?? asserts.get(op),
    listAsserts: () => [...asserts.values(), ...(sdk?.listAsserts() ?? [])],
    getScriptEngine: (l) => engines.get(l),
    getReporter: (f) => sdk?.getReporter(f) ?? reporters.get(f),
    listImporters: () => [...importers.values(), ...(sdk?.listImporters() ?? [])],
    getAuth: (t) => sdk?.getAuth(t as AuthProvider["type"]) ?? auths.get(t),
    getStorage: () => storage,
    getSdkProtocol: (request) => sdk?.getProtocol(request),
    getProtocol(request) {
      const external = sdk?.getProtocol(request);
      if (external) return external;
      for (const client of protocols.values()) if (client.canHandle(request)) return client;
      return undefined;
    },
    plugin(def) {
      def.setup({ registry: api });
    },
  };
  return api;
}
