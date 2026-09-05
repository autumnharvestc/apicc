/**
 * 视图切换禁用语义（M7-B 任务 2 折入项，抽出自 App.vue 的一行条件以便单测钉住）：
 * - 在线工作区激活 → 全部视图禁用（含 plugins：内容区让位在线编辑链路 OnlineApiEditor）；
 * - plugins（管理类视图，M7-B 任务 1 裁定①）不依赖工作区，未打开工作区也可查看；
 * - 其余视图为工作区级：未打开工作区禁用；
 * - 压测（M2-D3 裁定 A）为接口级视图：已打开工作区但未选中接口时禁用。
 */
export type SwitchView = "debug" | "cases" | "envs" | "run" | "import" | "design" | "wf" | "stress" | "plugins";

export const SWITCH_VIEWS: SwitchView[] = ["debug", "cases", "envs", "run", "import", "design", "wf", "stress", "plugins"];

export function isViewDisabled(
  view: SwitchView,
  ctx: { workspaceOpened: boolean; onlineActive: boolean; apiSelected: boolean },
): boolean {
  if (ctx.onlineActive) return true;
  if (view === "plugins") return false;
  return !ctx.workspaceOpened || (view === "stress" && !ctx.apiSelected);
}
