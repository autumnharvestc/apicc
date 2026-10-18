import { createServer as createHttpServer, request as forwardHttpRequest } from "node:http";
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { Server as HttpsServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import { createHttpClient, HttpExecutionError } from "../../src/http/client.js";
import { prepareNetworkRun } from "../../src/network/prepare.js";
import type { NetworkProfileStore } from "../../src/network/privateStore.js";
import type { NetworkConfiguration, NetworkProfile, NetworkScope } from "../../src/network/profiles.js";
import type { SecretStore } from "../../src/credentials/types.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

type HttpRequest = Extract<ExecutableRequest, { protocol: "http" }>;
const httpRequest = (url: string, headers: Record<string, string> = {}): HttpRequest => ({
  protocol: "http", method: "GET", url, headers, query: [], auth: { kind: "none" },
});

const scope: NetworkScope = {
  canonicalRoot: "C:/synthetic/apicc-task2",
  project: { workspaceId: "task2-workspace", groupId: "task2-group", projectId: "task2-project" },
};
const clientKeyRefA = { id: "synthetic-task2-client-key-a", policy: "test-auto" } as const;
const clientKeyRefB = { id: "synthetic-task2-client-key-b", policy: "test-auto" } as const;
const proxyPasswordRef = { id: "synthetic-task2-proxy-password", policy: "test-auto" } as const;
const proxyPassword = "synthetic-proxy-password";

async function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(`./fixtures/network/${name}`, import.meta.url));
}

function memoryStore(configuration: NetworkConfiguration): NetworkProfileStore {
  return {
    async load() { return { revision: "synthetic-task2-revision", configuration }; },
    async save() { throw new Error("Unexpected network fixture store write."); },
  };
}

function testSecretStore(values: Readonly<Record<string, string>>): SecretStore {
  const versions = Object.fromEntries(Object.keys(values).map((id) => [id, `synthetic-version:${id}`]));
  return {
    async put() { throw new Error("Unexpected network fixture secret write."); },
    async resolve(_project, reference, expectedVersion) {
      if (expectedVersion !== versions[reference.id] || values[reference.id] === undefined) {
        throw new Error("Unexpected network fixture secret lookup.");
      }
      return values[reference.id]!;
    },
    async version(_project, reference) {
      const version = versions[reference.id];
      if (version === undefined) throw new Error("Unexpected network fixture secret version lookup.");
      return version;
    },
    async remove() { throw new Error("Unexpected network fixture secret removal."); },
    async status(_project, reference) { return values[reference.id] === undefined ? "missing" : "available"; },
  };
}

function directProfile(origin: string, caPath: string, clientCertificatePath?: string): NetworkConfiguration {
  return {
    formatVersion: 1,
    profiles: [{
      id: "synthetic-mtls",
      name: "Synthetic mTLS",
      kind: "direct",
      targetTlsBindings: [{
        origin,
        tls: {
          caCertificatePaths: [caPath],
          ...(clientCertificatePath === undefined ? {} : {
            clientCertificatePaths: [clientCertificatePath],
            clientPrivateKeyRef: clientKeyRefA,
          }),
        },
      }],
    }],
    projectSelection: { kind: "profile", profileId: "synthetic-mtls" },
    environmentSelections: [],
  };
}

function proxyProfile(
  proxyUrl: string,
  origins: readonly [string, string],
  targetCaPath: string,
  proxyCaPath: string,
  clientCertificatePaths: readonly [string, string],
): NetworkConfiguration {
  const tlsFor = (clientCertificatePath: string, keyRef: typeof clientKeyRefA | typeof clientKeyRefB) => ({
    caCertificatePaths: [targetCaPath],
    clientCertificatePaths: [clientCertificatePath],
    clientPrivateKeyRef: keyRef,
  });
  const profile: NetworkProfile = {
    id: "synthetic-proxy-mtls",
    name: "Synthetic proxy mTLS",
    kind: "proxy",
    proxyUrl,
    username: "synthetic-proxy-user",
    passwordRef: proxyPasswordRef,
    proxyTLS: { caCertificatePaths: [proxyCaPath] },
    targetTlsBindings: [
      { origin: origins[0], tls: tlsFor(clientCertificatePaths[0], clientKeyRefA) },
      { origin: origins[1], tls: tlsFor(clientCertificatePaths[1], clientKeyRefB) },
    ],
  };
  return {
    formatVersion: 1,
    profiles: [profile],
    projectSelection: { kind: "profile", profileId: profile.id },
    environmentSelections: [],
  };
}

function httpProxyProfile(proxyUrl: string): NetworkConfiguration {
  const profile: NetworkProfile = {
    id: "synthetic-http-proxy-lookup",
    name: "Synthetic HTTP proxy lookup",
    kind: "proxy",
    proxyUrl,
    username: "synthetic-proxy-user",
    passwordRef: proxyPasswordRef,
    targetTlsBindings: [],
  };
  return {
    formatVersion: 1,
    profiles: [profile],
    projectSelection: { kind: "profile", profileId: profile.id },
    environmentSelections: [],
  };
}

async function listen(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function portOf(server: HttpServer): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The synthetic loopback fixture did not bind a TCP port.");
  return address.port;
}

function trackSockets(server: HttpServer): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

async function closeServer(server: HttpServer, sockets: Set<Socket>): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function nativeMtlsProof(url: string, ca: Buffer, cert: Buffer, key: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { agent: false, ca, cert, key, rejectUnauthorized: true }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("prepared network HTTP transport", () => {
  it("uses per-origin CA/mTLS over a real proxy TLS+CONNECT route, strips proxy auth, and resolves a named HTTP proxy", async () => {
    const [targetCa, targetServerCertificate, targetServerKey, clientCertificateA, clientKeyA,
      clientCertificateB, clientKeyB, proxyCa, proxyCertificate, proxyKey] = await Promise.all([
      fixture("synthetic-target-ca.pem"),
      fixture("synthetic-target-server.pem"),
      fixture("synthetic-target-server.key"),
      fixture("synthetic-client.pem"),
      fixture("synthetic-client.key"),
      fixture("synthetic-client-b.pem"),
      fixture("synthetic-client-b.key"),
      fixture("synthetic-proxy-ca.pem"),
      fixture("synthetic-proxy-server.pem"),
      fixture("synthetic-proxy-server.key"),
    ]);
    const root = await mkdtemp(join(tmpdir(), "apicc-task2-network-"));
    const targetCaPath = join(root, "target-ca.pem");
    const proxyCaPath = join(root, "proxy-ca.pem");
    const clientCertificatePathA = join(root, "client-a.pem");
    const clientCertificatePathB = join(root, "client-b.pem");
    await Promise.all([
      writeFile(targetCaPath, targetCa),
      writeFile(proxyCaPath, proxyCa),
      writeFile(clientCertificatePathA, clientCertificateA),
      writeFile(clientCertificatePathB, clientCertificateB),
    ]);

    const targetObservations: Array<{ server: string; path: string; authorized: boolean; client: string | undefined; proxyAuthorization: string | undefined }> = [];
    const proxyConnectAuth: Array<string | undefined> = [];
    const proxyForwardAuth: Array<string | undefined> = [];
    const namedHttpProxyAuth: Array<string | undefined> = [];
    const businessHttpProxyAuth: Array<string | undefined> = [];
    const resolverLookups: string[] = [];
    const proxyTunnels = new Set<Socket>();
    const servers: Array<{ server: HttpServer; sockets: Set<Socket> }> = [];
    let client: ReturnType<typeof createHttpClient> | undefined;

    const register = async (server: HttpServer) => {
      const sockets = trackSockets(server);
      servers.push({ server, sockets });
      await listen(server);
      return server;
    };

    try {
      let secondUrl = "";
      const makeTarget = (name: string) => createHttpsServer({
        cert: targetServerCertificate,
        key: targetServerKey,
        ca: targetCa,
        requestCert: true,
        rejectUnauthorized: true,
      }, (request, response) => {
        const socket = request.socket as TLSSocket;
        const clientName = socket.getPeerCertificate().subject.CN as string | undefined;
        targetObservations.push({
          server: name,
          path: request.url ?? "",
          authorized: socket.authorized,
          client: clientName,
          proxyAuthorization: typeof request.headers["proxy-authorization"] === "string"
            ? request.headers["proxy-authorization"] : undefined,
        });
        if (name === "first" && request.url === "/redirect") {
          response.writeHead(302, { location: secondUrl });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ authorized: socket.authorized, client: clientName ?? null }));
      });

      const firstTarget = await register(makeTarget("first"));
      const secondTarget = await register(makeTarget("second"));
      const firstUrl = `https://127.0.0.1:${portOf(firstTarget)}/handshake`;
      secondUrl = `https://127.0.0.1:${portOf(secondTarget)}/finish`;
      const firstOrigin = new URL(firstUrl).origin;
      const secondOrigin = new URL(secondUrl).origin;

      const httpTarget = await register(createHttpServer((_request: IncomingMessage, response: ServerResponse) => {
        businessHttpProxyAuth.push(typeof _request.headers["proxy-authorization"] === "string"
          ? _request.headers["proxy-authorization"] : undefined);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ proxyAuthorization: _request.headers["proxy-authorization"] ?? null }));
      }));

      const proxy = createHttpsServer({ cert: proxyCertificate, key: proxyKey }, (request, response) => {
        const proxyAuthorization = request.headers["proxy-authorization"];
        proxyForwardAuth.push(typeof proxyAuthorization === "string" ? proxyAuthorization : undefined);
        let target: URL;
        try { target = new URL(request.url ?? ""); }
        catch { response.writeHead(400).end(); return; }
        const headers = { ...request.headers };
        delete headers["proxy-authorization"];
        headers.host = target.host;
        const upstream = forwardHttpRequest(target, { method: request.method, headers }, (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        });
        upstream.once("error", (error) => response.destroy(error));
        request.pipe(upstream);
      });
      proxy.on("connect", (request, downstream, head) => {
        const proxyAuthorization = request.headers["proxy-authorization"];
        proxyConnectAuth.push(typeof proxyAuthorization === "string" ? proxyAuthorization : undefined);
        const authority = new URL(`http://${request.url}`);
        const upstream = connectTcp(Number(authority.port), authority.hostname);
        proxyTunnels.add(upstream);
        upstream.once("close", () => proxyTunnels.delete(upstream));
        upstream.once("connect", () => {
          downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          downstream.pipe(upstream);
          upstream.pipe(downstream);
        });
        upstream.once("error", () => downstream.destroy());
        downstream.once("error", () => upstream.destroy());
        downstream.once("close", () => upstream.destroy());
      });
      await register(proxy);

      const resolverProxyHostname = "resolver-proxy.synthetic.invalid";
      const namedHttpProxy = createHttpServer((request, response) => {
        const proxyAuthorization = request.headers["proxy-authorization"];
        namedHttpProxyAuth.push(typeof proxyAuthorization === "string" ? proxyAuthorization : undefined);
        let target: URL;
        try { target = new URL(request.url ?? ""); }
        catch { response.writeHead(400).end(); return; }
        const headers = { ...request.headers };
        delete headers["proxy-authorization"];
        headers.host = target.host;
        const upstream = forwardHttpRequest(target, { method: request.method, headers }, (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        });
        upstream.once("error", (error) => response.destroy(error));
        request.pipe(upstream);
      });
      await register(namedHttpProxy);

      const proof = await nativeMtlsProof(firstUrl, targetCa, clientCertificateA, clientKeyA);
      expect(proof).toEqual({
        status: 200,
        body: JSON.stringify({ authorized: true, client: "APICC Task2 Synthetic Client" }),
      });

      const secretStore = testSecretStore({
        [clientKeyRefA.id]: clientKeyA.toString("utf8"),
        [clientKeyRefB.id]: clientKeyB.toString("utf8"),
        [proxyPasswordRef.id]: proxyPassword,
      });
      const lookup: NonNullable<NonNullable<Parameters<typeof createHttpClient>[0]>["lookup"]> = (hostname, options, callback) => {
        resolverLookups.push(hostname);
        if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      };
      const directClient = createHttpClient({ lookup });
      client = directClient;
      const directNetwork = await prepareNetworkRun({
        scope,
        store: memoryStore(directProfile(firstOrigin, targetCaPath)),
        secretStore,
        selection: { kind: "direct" },
      });
      await expect(directClient.execute(httpRequest(firstUrl), {
        connectTimeoutMs: 1_500, totalTimeoutMs: 5_000, runtime: { network: directNetwork },
      })).rejects.toBeInstanceOf(HttpExecutionError);

      const caOnlyNetwork = await prepareNetworkRun({
        scope,
        store: memoryStore(directProfile(firstOrigin, targetCaPath)),
        secretStore,
      });
      await expect(directClient.execute(httpRequest(firstUrl), {
        connectTimeoutMs: 1_500, totalTimeoutMs: 5_000, runtime: { network: caOnlyNetwork },
      })).rejects.toBeInstanceOf(HttpExecutionError);

      const directMtlsNetwork = await prepareNetworkRun({
        scope,
        store: memoryStore(directProfile(firstOrigin, targetCaPath, clientCertificatePathA)),
        secretStore,
      });
      const directResponse = await directClient.execute(httpRequest(firstUrl), {
        connectTimeoutMs: 1_500, totalTimeoutMs: 5_000, runtime: { network: directMtlsNetwork },
      });
      expect(directResponse.status).toBe(200);
      expect(JSON.parse(directResponse.bodyText)).toEqual({ authorized: true, client: "APICC Task2 Synthetic Client" });

      const proxyUrl = `https://127.0.0.1:${portOf(proxy)}`;
      const proxyNetwork = await prepareNetworkRun({
        scope,
        store: memoryStore(proxyProfile(
          proxyUrl,
          [firstOrigin, secondOrigin],
          targetCaPath,
          proxyCaPath,
          [clientCertificatePathA, clientCertificatePathB],
        )),
        secretStore,
      });
      expect(Object.keys(proxyNetwork.credentialVersions).sort()).toEqual([
        clientKeyRefA.id, clientKeyRefB.id, proxyPasswordRef.id,
      ].sort());
      const proxyResponse = await directClient.execute(httpRequest(
        `https://127.0.0.1:${portOf(firstTarget)}/redirect`,
        { "Proxy-Authorization": "Bearer caller-value" },
      ), {
        connectTimeoutMs: 1_500,
        totalTimeoutMs: 5_000,
        followRedirects: true,
        runtime: { network: proxyNetwork },
      });
      expect(proxyResponse.status).toBe(200);
      expect(JSON.parse(proxyResponse.bodyText)).toEqual({ authorized: true, client: "APICC Task2 Synthetic Client B" });

      const forwardedResponse = await directClient.execute(httpRequest(
        `http://127.0.0.1:${portOf(httpTarget)}/forwarded`,
        { "Proxy-Authorization": "Bearer caller-value" },
      ), {
        connectTimeoutMs: 1_500,
        totalTimeoutMs: 5_000,
        runtime: { network: proxyNetwork },
      });
      expect(JSON.parse(forwardedResponse.bodyText)).toEqual({ proxyAuthorization: null });
      const expectedProxyAuthorization = `Basic ${Buffer.from(`synthetic-proxy-user:${proxyPassword}`, "utf8").toString("base64")}`;

      const namedHttpProxyNetwork = await prepareNetworkRun({
        scope,
        store: memoryStore(httpProxyProfile(`http://${resolverProxyHostname}:${portOf(namedHttpProxy)}`)),
        secretStore,
      });
      const namedHttpProxyResponse = await directClient.execute(httpRequest(
        `http://127.0.0.1:${portOf(httpTarget)}/named-proxy-resolution`,
        { "Proxy-Authorization": "Bearer caller-value" },
      ), {
        connectTimeoutMs: 1_500,
        totalTimeoutMs: 5_000,
        runtime: { network: namedHttpProxyNetwork },
      });
      expect(namedHttpProxyResponse.status).toBe(200);
      expect(JSON.parse(namedHttpProxyResponse.bodyText)).toEqual({ proxyAuthorization: null });
      expect(resolverLookups).toContain(resolverProxyHostname);

      expect(proxyConnectAuth).toEqual([expectedProxyAuthorization, expectedProxyAuthorization]);
      expect(proxyForwardAuth).toEqual([expectedProxyAuthorization]);
      expect(namedHttpProxyAuth).toEqual([expectedProxyAuthorization]);
      expect(businessHttpProxyAuth).toEqual([undefined, undefined]);
      expect(targetObservations.filter((observation) => observation.path === "/redirect")).toEqual([{
        server: "first", path: "/redirect", authorized: true,
        client: "APICC Task2 Synthetic Client", proxyAuthorization: undefined,
      }]);
      expect(targetObservations.filter((observation) => observation.path === "/finish")).toEqual([{
        server: "second", path: "/finish", authorized: true,
        client: "APICC Task2 Synthetic Client B", proxyAuthorization: undefined,
      }]);
    } finally {
      await client?.close();
      for (const socket of proxyTunnels) socket.destroy();
      for (const { server, sockets } of servers.reverse()) await closeServer(server, sockets);
      await rm(root, { recursive: true, force: true });
    }
  });
});
