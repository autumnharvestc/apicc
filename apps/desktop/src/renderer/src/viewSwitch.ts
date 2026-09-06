/**
 * 视图切换模型（M9-C 层级调整）：rail 模块收敛为「主页（固定最左）+ 六模块」——
 * - home（主页）：服务器/团队分组/项目管理，恒可用；
 * - api（接口）模块内含子视图页签（调试/设计；用例页签 M9-D 移入测试模块）；
 * - run/wf/stress/envs/import 内容面板挂到各自模块；
 * - 插件移出 rail → TopBar 齿轮设置抽屉（M9-C 裁定 D5）。
 * 禁用语义（单测钉住）：
 * - home 恒可用；在线工作区激活 → 其余模块禁用（内容区让位 OnlineApiEditor）；
 * - 其余模块为工作区级：未打开工作区禁用；
 * - 压测（接口级）已打开工作区但未选中接口时禁用。
 */
export type SwitchView = "home" | "api" | "run" | "wf" | "stress" | "envs" | "import";

export const SWITCH_VIEWS: SwitchView[] = ["home", "api", "run", "wf", "stress", "envs", "import"];

/** 接口模块子视图（M8 用例页签暂留，M9-D 移入测试模块后收敛为 调试/设计）。 */
export type ApiSubView = "debug" | "design" | "cases";

export const API_SUB_VIEWS: ApiSubView[] = ["debug", "design", "cases"];

export interface ViewGateContext {
  workspaceOpened: boolean;
  onlineActive: boolean;
  apiSelected: boolean;
}

export function isViewDisabled(view: SwitchView, ctx: ViewGateContext): boolean {
  if (view === "home") return false;
  if (ctx.onlineActive) return true;
  return !ctx.workspaceOpened || (view === "stress" && !ctx.apiSelected);
}

export function isApiSubViewDisabled(ctx: Pick<ViewGateContext, "onlineActive" | "apiSelected">): boolean {
  return ctx.onlineActive || !ctx.apiSelected;
}
