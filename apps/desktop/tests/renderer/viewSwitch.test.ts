import { describe, expect, it } from "vitest";
import {
  isViewDisabled,
  isApiSubViewDisabled,
  SWITCH_VIEWS,
  API_SUB_VIEWS,
  type SwitchView,
} from "../../src/renderer/src/viewSwitch.js";

const base = { workspaceOpened: false, onlineActive: false, apiSelected: false };

describe("viewSwitch 模块禁用语义（M9-D：测试模块取代压测栏）", () => {
  it("模块清单：5 模块固定顺序（rail 渲染顺序契约，主页固定最左）", () => {
    expect(SWITCH_VIEWS).toEqual(["api", "run", "wf", "test", "envs"]); // 主页在顶栏（M11）；导入归接口模块（M10）
    expect(API_SUB_VIEWS).toEqual(["debug", "design"]);
  });

  it("在线格式未解析时可浏览接口，正式项目开放五个模块", () => {
    const online = { ...base, onlineActive: true };
    for (const v of SWITCH_VIEWS as SwitchView[]) {
      expect(isViewDisabled(v, online)).toBe(v !== "api");
      expect(isViewDisabled(v, { ...online, onlineProjectAvailable: true })).toBe(false);
    }
  });

  it("未打开工作区（非在线）：工作区级模块禁用", () => {
    expect(isViewDisabled("api", base)).toBe(true);
    expect(isViewDisabled("run", base)).toBe(true);
  });

  it("打开工作区：全部模块可用（测试模块的接口门控在其交互层，rail 不再按接口区分）", () => {
    const opened = { ...base, workspaceOpened: true };
    expect(isViewDisabled("api", opened)).toBe(false);
    expect(isViewDisabled("test", opened)).toBe(false);
  });
});

describe("api 子视图禁用语义（M8）", () => {
  it("在线模式禁用；未选中接口禁用；打开工作区且选中接口可用", () => {
    expect(isApiSubViewDisabled({ onlineActive: true, apiSelected: true })).toBe(true);
    expect(isApiSubViewDisabled({ onlineActive: false, apiSelected: false })).toBe(true);
    expect(isApiSubViewDisabled({ onlineActive: false, apiSelected: true })).toBe(false);
  });
});
