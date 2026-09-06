// M8 布局层级改造：九平铺视图收敛为七图标导航模块 + 接口子视图页签，禁用语义
// 单测钉住沿用 M7-B 折入项约定（纯函数抽出自 App.vue）：
//   - 在线工作区激活 → 全部模块与子视图禁用（内容区让位 OnlineApiEditor）；
//   - 未打开工作区（非在线）→ 工作区级模块禁用、plugins（管理类视图）恒可用；
//   - 压测（接口级视图，M2-D3 裁定 A）仅在已打开工作区且未选中接口时禁用；
//   - api 子视图（调试/设计/用例）：在线模式或未选中接口时禁用。
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
  it("模块清单：7 模块固定顺序（rail 渲染顺序契约，主页固定最左）", () => {
    expect(SWITCH_VIEWS).toEqual(["home", "api", "run", "wf", "test", "envs", "import"]);
    expect(API_SUB_VIEWS).toEqual(["debug", "design"]);
  });

  it("在线模式激活：除主页外全部模块禁用（内容区让位 OnlineApiEditor；主页管理连接恒可用）", () => {
    const online = { ...base, onlineActive: true };
    for (const v of SWITCH_VIEWS as SwitchView[]) {
      expect(isViewDisabled(v, online), `在线模式下 ${v} 应禁用`).toBe(v === "home" ? false : true);
    }
  });

  it("未打开工作区（非在线）：工作区级模块禁用，主页恒可用", () => {
    expect(isViewDisabled("api", base)).toBe(true);
    expect(isViewDisabled("run", base)).toBe(true);
    expect(isViewDisabled("home", base)).toBe(false);
  });

  it("打开工作区：全部模块可用（测试模块的接口门控在其交互层，rail 不再按接口区分）", () => {
    const opened = { ...base, workspaceOpened: true };
    expect(isViewDisabled("api", opened)).toBe(false);
    expect(isViewDisabled("home", opened)).toBe(false);
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
