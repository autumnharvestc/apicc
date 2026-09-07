// M5-B 任务 2（D2 保存链路真集成）：桌面端保存链路「api:save → session.saveApi →
// fileStorage 白名单落盘 → reopen 经新 ApiDefinitionSchema strict 校验读回」对
// WebSocket / SOAP 接口的端到端核验（真 core，无替身）。
//
// 与任务 1 的差别：任务 1 的保存载荷是本地 fixture 断言（旧 core strict schema 不
// 接线）；本文件在合并 main（M5-A 协议内核 @ c03d36c）后跑真链路——
// - 正例：WS/SOAP 接口字段（protocol/message/envelope/soapAction）落盘往返不丢；
// - 负例：soap 缺 envelope（或 method 非 POST）→ reopen 时 superRefine 拒绝，
//   进 problems 留痕且该接口不载入（strict 校验拒绝未知/不完整形状，不静默丢弃）；
// - 零破坏：纯 HTTP 接口落盘 yaml 不含 protocol 键（fileStorage 白名单口径，
//   M5 之前形状逐字段一致），reopen 零 problems 且缺省回填 http。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSession } from "../../src/main/session.js";

const dirs: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "apicc-m5b-save-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 会话夹具：开临时工作区并铺 分组/项目/集合，返回 session 与集合 id。 */
async function seededSession() {
  const s = createSession();
  const dir = root();
  await s.create(dir, "多协议");
  await s.open(dir);
  const g = s.createGroup("g");
  const p = s.createProject(g.id, "p");
  const c = s.createCollection(p.id, "c");
  return { s, dir, collectionId: c.id };
}

/** 集合根接口的落盘 yaml 文本（白名单核验用）。id 布局（轨一）：目录名=实体 id。 */
function apiYaml(dir: string, gId: string, pId: string, cId: string, apiId: string): string {
  return readFileSync(join(dir, "groups", gId, "projects", pId, "collections", cId, "apis", apiId, "api.yaml"), "utf8");
}

describe("M5-B 任务 2 保存链路：WS/SOAP 经新 schema 落盘往返（真 core）", () => {
  it("WS 接口：protocol/message 经 saveApi 落盘，reopen 读回不丢（D2）", async () => {
    const { s, dir, collectionId } = await seededSession();
    const api = s.createApi(collectionId, null, { name: "ws-echo", method: "GET", url: "ws://127.0.0.1:9/echo" });
    api.protocol = "websocket";
    api.message = "ping-{{token}}";
    await s.saveApi(api);
    // id 布局（轨一）：目录名=实体 id，自内存模型取链路 id
    const g = s.workspace!.groups.find((x) => x.projects.some((p) => p.collections.some((c) => c.id === collectionId)))!;
    const p = g.projects[0]!;

    // 落盘形状（白名单口径）：非 http 才写 protocol；message 随值写。
    const yaml = apiYaml(dir, g.id, p.id, collectionId, api.id);
    expect(yaml).toContain("protocol: websocket");
    expect(yaml).toContain("message:");

    const s2 = createSession();
    await s2.open(dir);
    const found = s2.locateApi(api.id);
    expect(found?.api.protocol).toBe("websocket");
    expect(found?.api.message).toBe("ping-{{token}}");
    expect(found?.api.envelope).toBeUndefined();
    expect(found?.api.soapAction).toBeUndefined();
  });

  it("SOAP 接口：envelope/soapAction 经 saveApi 落盘，reopen 读回不丢（D2）", async () => {
    const { s, dir, collectionId } = await seededSession();
    const api = s.createApi(collectionId, null, { name: "soap-do", method: "POST", url: "http://127.0.0.1:9/soap" });
    api.protocol = "soap";
    api.envelope = "<Envelope><body>{{payload}}</body></Envelope>";
    api.soapAction = "urn:Ping";
    await s.saveApi(api);
    const g = s.workspace!.groups.find((x) => x.projects.some((p) => p.collections.some((c) => c.id === collectionId)))!;

    const yaml = apiYaml(dir, g.id, g.projects[0]!.id, collectionId, api.id);
    expect(yaml).toContain("protocol: soap");
    expect(yaml).toContain("soapAction: urn:Ping");

    const s2 = createSession();
    await s2.open(dir);
    const found = s2.locateApi(api.id);
    expect(found?.api.protocol).toBe("soap");
    expect(found?.api.envelope).toBe("<Envelope><body>{{payload}}</body></Envelope>");
    expect(found?.api.soapAction).toBe("urn:Ping");
    expect(found?.api.message).toBeUndefined();
  });

  it("负例：soap 缺 envelope 且 method 非 POST → reopen 经新 schema strict 拒绝（problems 留痕、接口不载入）", async () => {
    const { s, dir, collectionId } = await seededSession();
    const api = s.createApi(collectionId, null, { name: "soap-bad", method: "GET", url: "http://127.0.0.1:9/soap" });
    api.protocol = "soap"; // 无 envelope、method 保持 GET —— 双双违反 superRefine
    await s.saveApi(api);

    const s2 = createSession();
    const reopened = await s2.open(dir);
    const apiProblems = reopened.problems.filter((pr) => pr.message.includes("envelope"));
    expect(apiProblems).toHaveLength(1);
    expect(apiProblems[0]!.message).toContain("schema 校验失败");
    expect(apiProblems[0]!.message).toContain("envelope");
    expect(apiProblems[0]!.message).toContain("POST");
    // strict 拒绝 = 该接口不进内存模型（不静默降级为 http 执行）
    expect(s2.locateApi(api.id)).toBeUndefined();
  });

  it("零破坏：纯 HTTP 接口落盘 yaml 无 protocol 键（M5 前形状），reopen 零 problems 且缺省 http", async () => {
    const { s, dir, collectionId } = await seededSession();
    const api = s.createApi(collectionId, null, { name: "plain", method: "GET", url: "http://127.0.0.1:9/x" });
    await s.saveApi(api);
    const g = s.workspace!.groups.find((x) => x.projects.some((p) => p.collections.some((c) => c.id === collectionId)))!;

    expect(apiYaml(dir, g.id, g.projects[0]!.id, collectionId, api.id)).not.toContain("protocol:");

    const s2 = createSession();
    const reopened = await s2.open(dir);
    expect(reopened.problems).toEqual([]);
    const found = s2.locateApi(api.id);
    expect(found?.api.protocol).toBe("http"); // schema default 回填，显示/执行口径一致（D5 protocolOf）
  });
});
