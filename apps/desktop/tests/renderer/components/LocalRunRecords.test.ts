// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { computeReport } from "@apicc/core";
import LocalRunRecords from "../../../src/renderer/src/components/LocalRunRecords.vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";

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
  expect(readArchive.mock.calls).toEqual([["first.json"],["second.json"]]);
  await view.findAll("button").find(button=>button.text()==="返回列表")!.trigger("click");
  expect(view.get('[data-file="second.json"]').attributes("aria-current")).toBe("true");
  await view.get('[data-file="legacy.json"]').trigger("click");await flushPromises();
  expect(view.text()).toContain("无法确认这份报告所属的项目");expect(publish()).toBeUndefined();
  view.unmount();
});
