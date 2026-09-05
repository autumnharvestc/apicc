// M7-B 任务 2 折入项（任务 1 审查）：App.vue 在线模式 plugins 禁用语义——任务 1 的
// 条件式把 plugins 例外写成了恒可用（注释/报告与代码不符）。本单测钉住修正后的
// 禁用语义（纯函数抽出自 App.vue，一行条件 + 一例测试的落点）：
//   - 在线工作区激活 → 全部视图禁用（含 plugins——内容区让位 OnlineApiEditor）；
//   - 未打开工作区（非在线）→ 工作区级视图禁用、plugins（管理类视图）恒可用；
//   - 压测（接口级视图，裁定 A）仅在已打开工作区且未选中接口时禁用。
import { describe, expect, it } from "vitest";
import { isViewDisabled, type SwitchView } from "../../src/renderer/src/viewSwitch.js";

const base = { workspaceOpened: false, onlineActive: false, apiSelected: false };

describe("viewSwitch 禁用语义（M7-B 任务 2 折入项）", () => {
  it("在线模式激活：全部视图禁用（含 plugins——任务 1 注释与代码不符的折入修复）", () => {
    const online = { ...base, onlineActive: true };
    for (const v of ["debug", "cases", "envs", "run", "import", "design", "wf", "stress", "plugins"] as SwitchView[]) {
      expect(isViewDisabled(v, online), `在线模式下 ${v} 应禁用`).toBe(true);
    }
  });

  it("未打开工作区（非在线）：工作区级视图禁用，plugins（管理类视图，裁定①）恒可用", () => {
    expect(isViewDisabled("cases", base)).toBe(true);
    expect(isViewDisabled("run", base)).toBe(true);
    expect(isViewDisabled("plugins", base)).toBe(false);
  });

  it("打开工作区：视图可用；压测未选中接口禁用（裁定 A），选中后可用", () => {
    const opened = { ...base, workspaceOpened: true };
    expect(isViewDisabled("debug", opened)).toBe(false);
    expect(isViewDisabled("plugins", opened)).toBe(false);
    expect(isViewDisabled("stress", opened)).toBe(true);
    expect(isViewDisabled("stress", { ...opened, apiSelected: true })).toBe(false);
  });
});
