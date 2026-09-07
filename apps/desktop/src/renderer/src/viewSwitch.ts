/**
 * 视图切换模型（M11）：rail 模块收敛为五项；主页（M11）移至顶栏「主页」按钮——
 * 服务器/团队分组/项目管理入口（主页视图无侧栏），不再占导航项；
 * - api（接口）模块子视图收敛为 调试/设计（接口栏聚焦接口定义，裁定⑥）；
 * - test（测试）：单接口用例管理（用例项运行/压测）+ 场景用例（裁定 D2），取代原压测栏；
 * - run/wf/envs 内容面板挂到各自模块；导入（M10）归接口模块头部按钮；插件在设置抽屉。
 * 禁用语义（单测钉住）：home 恒可用；在线 → 除主页外全禁用；其余工作区级。
 */
export type SwitchView = "api" | "run" | "wf" | "test" | "envs";

export const SWITCH_VIEWS: SwitchView[] = ["api", "run", "wf", "test", "envs"];

/** 接口模块子视图（M9-D：用例页签移入测试模块，接口栏聚焦定义）。 */
export type ApiSubView = "debug" | "design";

export const API_SUB_VIEWS: ApiSubView[] = ["debug", "design"];

export interface ViewGateContext {
  workspaceOpened: boolean;
  onlineActive: boolean;
  apiSelected: boolean;
}

export function isViewDisabled(view: SwitchView, ctx: ViewGateContext): boolean {
  if (ctx.onlineActive) return true;
  return !ctx.workspaceOpened;
}

export function isApiSubViewDisabled(ctx: Pick<ViewGateContext, "onlineActive" | "apiSelected">): boolean {
  return ctx.onlineActive || !ctx.apiSelected;
}
