/**
 * 视图切换模型（M9-D）：rail 模块 =「主页（固定最左）+ 六模块」——
 * - home（主页）：服务器/团队分组/项目管理，恒可用；
 * - api（接口）模块子视图收敛为 调试/设计（接口栏聚焦接口定义，裁定⑥）；
 * - test（测试）：单接口用例管理（用例项运行/压测）+ 场景用例（裁定 D2），取代原压测栏；
 * - run/wf/envs/import 内容面板挂到各自模块；插件在设置抽屉（M9-C 裁定 D5）。
 * 禁用语义（单测钉住）：home 恒可用；在线 → 除主页外全禁用；其余工作区级。
 */
export type SwitchView = "home" | "api" | "run" | "wf" | "test" | "envs" | "import";

export const SWITCH_VIEWS: SwitchView[] = ["home", "api", "run", "wf", "test", "envs", "import"];

/** 接口模块子视图（M9-D：用例页签移入测试模块，接口栏聚焦定义）。 */
export type ApiSubView = "debug" | "design";

export const API_SUB_VIEWS: ApiSubView[] = ["debug", "design"];

export interface ViewGateContext {
  workspaceOpened: boolean;
  onlineActive: boolean;
  apiSelected: boolean;
}

export function isViewDisabled(view: SwitchView, ctx: ViewGateContext): boolean {
  if (view === "home") return false;
  if (ctx.onlineActive) return true;
  return !ctx.workspaceOpened;
}

export function isApiSubViewDisabled(ctx: Pick<ViewGateContext, "onlineActive" | "apiSelected">): boolean {
  return ctx.onlineActive || !ctx.apiSelected;
}
