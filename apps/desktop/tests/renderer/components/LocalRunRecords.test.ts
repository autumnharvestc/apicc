// @vitest-environment jsdom
import { computed } from "vue";
import { newWorkbenchPosition, workbenchPositionKey } from "../../../src/renderer/src/stores/workbenchPosition.js";
import { expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { computeReport } from "@apicc/core";
import LocalRunRecords from "../../../src/renderer/src/components/LocalRunRecords.vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";

it("shows the recorded environment name, readable duration and task refresh action", async () => {
  const project = { workspaceId:"w", groupId:"g", projectId:"p" };
  const summary = {kind:"collection",file:"suite.json", collectionName:"Daily checks", startedAt:"2030-01-01T08:11:22.345Z", total:1,passed:1,failed:0,archiveProject:project, archiveDigest:"a".repeat(64), projectId:"p"};
  const readArchive = vi.fn(async () => ({...summary, envName:"QA environment", executionIdentity:{environmentId:"saved-environment-id"}, cases:[{apiName:"Accounts",caseName:"Check",passed:true,durationMs:687.1129000001,assertions:[]}]}));
  const { i18n } = createI18nInstance(); i18n.global.locale.value="zh-CN";
  const view = mount(LocalRunRecords, { props:{project,workspace:{root:"/fixture"} as never, run:{readArchiveList:async()=>[summary],readArchive} as never, reportError:vi.fn()},global:{plugins:[i18n]} });
  await flushPromises(); await view.get('[data-file="suite.json"]').trigger("click"); await flushPromises();
  expect(readArchive).toHaveBeenCalledWith("suite.json",{scope:project,digest:"a".repeat(64)});
  expect(view.text()).toContain("刷新任务"); expect(view.text()).toContain("QA environment"); expect(view.text()).toContain("687.11 ms");
  expect(view.text()).not.toContain("saved-environment-id"); expect(view.text()).not.toContain("刷新通知");
  view.unmount();
});

it("shows the failed workflow node and distinguishes a current environment name from a recorded name", async () => {
  const project = {workspaceId:"w",groupId:"g",projectId:"p"};
  const summary = {kind:"workflow",file:"night.json",collectionName:"Night regression",startedAt:"2030-01-01T08:11:22Z",projectId:"p",archiveProject:project,archiveDigest:"a".repeat(64),logicalVerdict:"failed"};
  const report = {...summary,cases:[],executionIdentity:{environmentId:"env-at-run"},workflow:{entries:[{label:"故意失败的断言",nodeKind:"assert",failureKind:"assertion",error:"Workflow assertion failed"}]}};
  const workspace = {root:"/fixture",tree:{children:[{children:[{kind:"project",locator:project,envs:[{id:"env-at-run",name:"集成环境"}]}]}]}};
  const {i18n} = createI18nInstance(); i18n.global.locale.value = 'zh-CN';
  const view = mount(LocalRunRecords,{props:{project,workspace:workspace as never,run:{readArchiveList:async()=>[summary],readArchive:async()=>report} as never,reportError:vi.fn()},global:{plugins:[i18n]}});
  try {
    await flushPromises(); await view.get('[data-file="night.json"]').trigger("click"); await flushPromises();
    expect(view.get('.record-failure').text()).toBe("故意失败的断言 · 工作流断言失败");
    expect(view.get('.record-facts dd').text()).toBe("集成环境（当前名称）");
    expect(view.get('.record-detail details').text()).toContain("Workflow assertion failed");
  } finally { view.unmount(); }
});

it("does not reopen a replacement with the same legacy filename and no digest", async () => {
  const position = newWorkbenchPosition(), project = { workspaceId: "a", groupId: "b", projectId: "c" };
  position.localRecord = { file: "daily.json", legacy: true };
  const row = { kind: "collection", file: "daily.json", collectionName: "Replacement", total: 0, failed: 0, passed: 0, startedAt: "2030-01-01T00:00:00Z" };
  const readArchive = vi.fn(), run = { readArchiveList: async () => [row], readArchive };
  const { i18n } = createI18nInstance();
  const view = mount(LocalRunRecords, { props: { project, workspace: { root: "/test" } as never, run: run as never, reportError: vi.fn() },
    global: { plugins: [i18n], provide: { [workbenchPositionKey as symbol]: computed(() => position) } } });
  await flushPromises();
  expect(position.localRecord).toBeNull();
  expect(readArchive).not.toHaveBeenCalled();
  expect(view.get('[role="alert"]').text()).toBeTruthy();
  view.unmount();
});

it("separates unowned archives, opens the exact saved file, and publishes only the selected verified result", async () => {
  const project = { workspaceId:"w",groupId:"g",projectId:"p" };
  const base = {kind:"stress",startedAt:"2030-01-01T08:11:22.345Z",totalRequests:0,ok:0,failed:0,rps:0};
  const rows = [{...base,archiveProject:project,projectId:"p",file:"first.json"},{...base,archiveProject:project,projectId:"p",file:"second.json"},
    {...base,projectId:"p",file:"ambiguous.json"},{...base,file:"legacy.json"},
    {...base,archiveProject:{...project,groupId:"other"},projectId:"p",file:"other.json"}];
  const readArchive = vi.fn(async () => ({kind:"stress",report:{...computeReport([],{concurrency:1,startedAt:0,finishedAt:0}),projectId:"p"}}));
  const run = { readArchiveList:vi.fn(async()=>rows), readArchive, running:false };
  const workspace = { root:"test-root",tree:{children:["g","other"].map(groupId=>({kind:"group",children:[{kind:"project",locator:{...project,groupId}}]}))} };
  const {i18n} = createI18nInstance(); i18n.global.locale.value="zh-CN";
  const view = mount(LocalRunRecords,{props:{run:run as any,workspace:workspace as any,project,reportError:vi.fn()},global:{plugins:[i18n],stubs:{StressReportView:true}}});
  await flushPromises();
  expect(view.find('[data-file="other.json"]').exists()).toBe(false);
  expect(view.get(".record-list details").attributes("open")).toBeUndefined();
  expect(view.get(".record-list details").text()).toContain("ambiguous.json");
  expect(view.get(".record-list details").text()).toContain("legacy.json");
  await view.get('[data-file="first.json"]').trigger("click");await flushPromises();
  await view.get('[data-file="second.json"]').trigger("click");await flushPromises();
  const publish=()=>view.findAll("button").find(button=>button.text()==="发布所选单项到项目");
  expect(publish()).toBeDefined(); await publish()!.trigger("click");
  expect(view.emitted("collaboration")).toEqual([[{kind:"stress",file:"second.json",project}]]);
  expect(readArchive.mock.calls).toEqual([["first.json",{scope:project}],["second.json",{scope:project}]]);
  await view.findAll("button").find(button=>button.text()==="返回列表")!.trigger("click");
  expect(view.get('[data-file="second.json"]').attributes("aria-current")).toBe("true");
  await view.get('[data-file="legacy.json"]').trigger("click");await flushPromises();
  expect(view.text()).toContain("无法确认这份报告所属的项目");expect(publish()).toBeUndefined();
  view.unmount();
});
