// Multi-protocol save/reopen through the formal contract-asset and full-locator path.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { createSession } from "../../src/main/session.js";
import type { ApiLocator, CollectionLocator } from "../../src/shared/locations.js";
import { IDS, makeTempRoot, makeWorkspace, persistWorkspace } from "./helpers/contract-assets.js";

const roots: Array<{ dispose: () => Promise<void> }> = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => root.dispose()));
});

async function seededSession() {
  const root = await makeTempRoot("apicc-multi-protocol-save-");
  roots.push(root);
  await persistWorkspace(root.path, makeWorkspace());
  const session = createSession();
  await session.open(root.path);
  const collection: CollectionLocator = {
    workspaceId: IDS.workspace,
    groupId: IDS.groupOne,
    projectId: IDS.projectOne,
    collectionId: IDS.collectionOne,
  };
  return { session, root: root.path, collection };
}

function apiYaml(root: string, locator: ApiLocator): string {
  return readFileSync(join(root, "groups", locator.groupId, "projects", locator.projectId, "collections", locator.collectionId, "apis", locator.apiId, "api.yaml"), "utf8");
}

describe("WS/SOAP 保存链路：经新 schema 落盘往返", () => {
  it("WS 接口：protocol/message 经 saveApi 落盘，reopen 读回不丢", async () => {
    const { session, root, collection } = await seededSession();
    const api = await session.createApi(collection, { name: "ws-echo", protocol: "websocket", baseUrl: "ws://127.0.0.1:9", path: "/echo" });
    if (api.contract.request.protocol !== "websocket") throw new Error("expected websocket request");
    api.contract.request.message = "ping-{{token}}";
    const locator: ApiLocator = { ...collection, folderIds: [], apiId: api.contract.id };
    await session.saveApi(locator, api);
    const yaml = apiYaml(root, locator);
    expect(yaml).toContain("protocol: websocket");
    expect(yaml).toContain("message:");

    const reopened = createSession();
    await reopened.open(root);
    const request = reopened.locateApi(locator)?.api.contract.request;
    expect(request?.protocol).toBe("websocket");
    if (request?.protocol !== "websocket") throw new Error("expected websocket request after reopen");
    expect(request.message).toBe("ping-{{token}}");
  });

  it("SOAP 接口：envelope/soapAction 经 saveApi 落盘，reopen 读回不丢", async () => {
    const { session, root, collection } = await seededSession();
    const api = await session.createApi(collection, { name: "soap-do", protocol: "soap", baseUrl: "http://127.0.0.1:9", path: "/soap" });
    if (api.contract.request.protocol !== "soap") throw new Error("expected SOAP request");
    api.contract.request.envelope = "<Envelope><body>{{payload}}</body></Envelope>";
    api.contract.request.soapAction = "urn:Ping";
    const locator: ApiLocator = { ...collection, folderIds: [], apiId: api.contract.id };
    await session.saveApi(locator, api);
    const yaml = apiYaml(root, locator);
    expect(yaml).toContain("protocol: soap");
    expect(yaml).toContain("soapAction: urn:Ping");

    const reopened = createSession();
    await reopened.open(root);
    const request = reopened.locateApi(locator)?.api.contract.request;
    expect(request?.protocol).toBe("soap");
    if (request?.protocol !== "soap") throw new Error("expected SOAP request after reopen");
    expect(request.envelope).toBe("<Envelope><body>{{payload}}</body></Envelope>");
    expect(request.soapAction).toBe("urn:Ping");
  });

  it("损坏的 SOAP 资产缺 envelope 且 method 非 POST：reopen 留 problem 且不载入该接口", async () => {
    const { session, root, collection } = await seededSession();
    const api = await session.createApi(collection, { name: "soap-bad", protocol: "soap", baseUrl: "http://127.0.0.1:9", path: "/soap" });
    if (api.contract.request.protocol !== "soap") throw new Error("expected SOAP request");
    api.contract.request.envelope = "<Envelope/>";
    const locator: ApiLocator = { ...collection, folderIds: [], apiId: api.contract.id };
    await session.saveApi(locator, api);

    const broken = parse(apiYaml(root, locator)) as { request: Record<string, unknown> };
    broken.request.method = "GET";
    delete broken.request.envelope;
    const file = join(root, "groups", locator.groupId, "projects", locator.projectId, "collections", locator.collectionId, "apis", locator.apiId, "api.yaml");
    writeFileSync(file, stringify(broken));

    const reopened = createSession();
    const result = await reopened.open(root);
    const problems = result.problems.filter((problem) => problem.file.includes(locator.apiId));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toBe("Invalid contract file structure or unknown field.");
    expect(reopened.locateApi(locator)).toBeUndefined();
  });

  it("HTTP 接口保存 formatVersion 与显式 protocol，reopen 零 problems 且仍为 http", async () => {
    const { session, root, collection } = await seededSession();
    const api = await session.createApi(collection, { name: "plain", method: "GET", baseUrl: "http://127.0.0.1:9", path: "/x" });
    const locator: ApiLocator = { ...collection, folderIds: [], apiId: api.contract.id };
    await session.saveApi(locator, api);
    const serialized = parse(apiYaml(root, locator)) as { formatVersion: number; request: { protocol?: string } };
    expect(serialized.formatVersion).toBe(1);
    expect(serialized.request.protocol).toBe("http");

    const reopened = createSession();
    const result = await reopened.open(root);
    expect(result.problems).toEqual([]);
    expect(reopened.locateApi(locator)?.api.contract.request.protocol).toBe("http");
  });
});
