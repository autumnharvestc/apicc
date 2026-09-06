/**
 * 视图切换模型（M8 布局层级改造）：九个平铺视图收敛为七个图标导航模块——
 * - api（接口）模块内含子视图页签（调试/设计/用例，原 debug/design/cases 三个平铺视图）；
 * - run/wf/stress/envs/import/plugins 内容面板原样挂到各自模块。
 * 禁用语义（沿袭 M7-B 折入项的单测钉住约定）：
 * - 在线工作区激活 → 全部模块禁用（内容区整体让位在线编辑链路 OnlineApiEditor）；
 * - plugins（管理类视图，M7-B 裁定①）不依赖工作区恒可用；
 * - 其余模块为工作区级：未打开工作区禁用；
 * - 压测（M2-D3 裁定 A）为接口级视图：已打开工作区但未选中接口时禁用。
 * - api 子视图：接口未选中禁用（在线模式禁用已由模块级覆盖）。
 */
export type SwitchView = "api" | "run" | "wf" | "stress" | "envs" | "import" | "plugins";

export const SWITCH_VIEWS: SwitchView[] = ["api", "run", "wf", "stress", "envs", "import", "plugins"];

/** 接口模块子视图（原平铺视图 debug/design/cases 收编）。 */
export type ApiSubView = "debug" | "design" | "cases";

export const API_SUB_VIEWS: ApiSubView[] = ["debug", "design", "cases"];

export interface ViewGateContext {
  workspaceOpened: boolean;
  onlineActive: boolean;
  apiSelected: boolean;
}

export function isViewDisabled(view: SwitchView, ctx: ViewGateContext): boolean {
  if (ctx.onlineActive) return true;
  if (view === "plugins") return false;
  return !ctx.workspaceOpened || (view === "stress" && !ctx.apiSelected);
}

export function isApiSubViewDisabled(ctx: Pick<ViewGateContext, "onlineActive" | "apiSelected">): boolean {
  return ctx.onlineActive || !ctx.apiSelected;
}
