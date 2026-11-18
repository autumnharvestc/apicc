// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { ContractWorkspaceSchema, StressPlanSchema } from "@apicc/core/schema";
import { workspaceFixture } from "../../../../../packages/core/tests/helpers/contractFixtures.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createOnlineExecutionStore } from "../../../src/renderer/src/stores/onlineExecution.js";
import { createOnlineProjectAdapter } from "../../../src/renderer/src/stores/onlineProjectAdapter.js";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import OnlineRunLaunch from "../../../src/renderer/src/components/online/OnlineRunLaunch.vue";
import type { OnlineExecutionInput } from "../../../src/shared/online/execution.js";

enableAutoUnmount(afterEach);
it("keeps online selection read-only, preserves the exact dispatched case and only opens that submission", async () => {
  const requests: Array<Extract<OnlineExecutionInput, {operation:"run"}>> = [];
  let settle!: () => void;
  const gate = new Promise<void>(resolve => { settle = resolve; });
  const execution = createOnlineExecutionStore({ onlineExecution: async input => {
    if (input.operation !== "run") return [];
    requests.push(input);
    await gate;
    throw new Error("submission-uncertain");
  }});
  const scope = {workspaceId:"11",groupId:"22",projectId:"33"};
  execution.activate({scope,ownerId:"7",serverId:"https://control.test/api/v1"});
  execution.setVisible(true);
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  const asset = project.collections[0]!.apis[0]!;
  asset.cases = ["First", "Second"].map((name, index) => ({id:"case-"+index,name,scope:"base",parameters:{},assertions:[],preOperations:[],postOperations:[]}));
  project.workflows = [{ id: "00000000-0000-4000-8000-000000000091", name: "Enabled", status: "enabled", nodes: [{id:"noop",kind:"noop"}], edges: [] }];
  project.stressPlans = [{ formatVersion: 1, id:"saved", name:"Saved plan", updatedAt:0, plan: StressPlanSchema.parse({
    formatVersion:1, target:{kind:"workflow",workflowId:project.workflows[0]!.id}, load:{kind:"constant-vus",vus:1},termination:{maxIterations:1},
  })}];
  execution.project = project; execution.saved = JSON.stringify(project);
  execution.view = { project, problems: [], assets:{...scope,format:"contract-files-v1",contractProjectId:project.id,version:"1",manifestHash:"a".repeat(64),files:[]} };
  const adapter = createOnlineProjectAdapter(execution, createMemoryApi(), () => false, () => false);
  const panel = mount(OnlineRunLaunch, {props:{execution,adapter,reportError:vi.fn()},global:{plugins:[createI18nInstance().i18n]}});
  try {
    const kind = panel.get('[data-testid="launch-kind"]');
    expect(kind.findAll("option").map(item => item.attributes("value"))).toEqual(["case","suite","workflow","stress"]);
    const pick = panel.findAll('[data-testid="launch-target"]')[1]!;
    await pick.setValue(true); await flushPromises();
    expect(adapter.editor.locator).toBeNull(); expect(requests).toHaveLength(0);
    await panel.setProps({readOnly:true}); expect(panel.get('[data-testid="run-btn"]').attributes("disabled")).toBeDefined();
    await panel.setProps({readOnly:false});
    const button = panel.get('[data-testid="run-btn"]');
    await Promise.all([button.trigger("click"),button.trigger("click")]); await flushPromises();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({operation:"run",expectedVersion:"1",location:{kind:"local"},target:{kind:"debug",invocation:{mode:"case",case:{apiId:asset.contract.id,caseId:"case-1",scope:"base"}}}});
    await kind.setValue("stress"); settle(); await flushPromises();
    const recordsButton = panel.findAll("button").find(item => item.text().includes("本次运行") || item.text().includes("View this run"))!;
    await recordsButton.trigger("click"); expect(panel.emitted("records")?.[0]).toEqual([requests[0]!.runId]);
    await panel.get('[data-testid="launch-target"]').setValue(true); await flushPromises();
    expect(button.attributes("disabled")).toBeDefined();
    const origins = panel.get(".stress-launch input:not([type=number])");
    await origins.setValue("http://127.0.0.1:8123"); await panel.get(".stress-launch button").trigger("click");
    expect(button.attributes("disabled")).toBeUndefined();
    await origins.setValue("http://127.0.0.1:8124");
    expect(button.attributes("disabled")).toBeDefined(); expect(requests).toHaveLength(1);
  } finally { settle(); adapter.stop(); execution.setVisible(false); }
});
