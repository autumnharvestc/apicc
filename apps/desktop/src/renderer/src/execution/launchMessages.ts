import { useI18n } from "vue-i18n";

const messages = {
  en: {
    launch: "Launch task", records: "Task records", choose: "Select run target", type: "Task type", search: "Search by name",
    noTargets: "No saved targets match", thisRun: "Run preview", pick: "Select a target to preview its execution.",
    scope: "Scope", environment: "Environment", location: "Execution location", local: "This computer", moduleScope: "Current module and subfolders",
    applicable: "Applicable targets", caseOutcome: "Passed {passed} · Failed {failed}", module: "Module cases", case: "Single API case", suite: "Test suite", workflow: "Workflow", stress: "Load test plan",
    start: { module: "Run module cases", case: "Run case", suite: "Run suite", workflow: "Run workflow", stress: "Start load test" },
    cases: "{count} cases", apis: "{count} APIs", previewCases: "Case preview", api: "API", dataDriven: "Data driven",
    rowsAfterRun: "The report shows the number of data rows executed.", skippedCase: "{name} · Skipped because no case applies to this environment",
    "no-cases": "There are no runnable cases in this environment.", "preview-changed": "The saved scope changed. Review the updated preview and launch again.",
    "target-unavailable": "The selected target is unavailable.", "environment-ambiguous": "The selected environment name is ambiguous in this project.",
    "environment-unavailable": "The selected environment is unavailable. Choose an environment in the status bar.",
    "workflow-draft": "Publish and enable this workflow before running it.", "scope-unavailable": "This case variant does not apply to the selected environment.",
    "save-before-running": "Save the selected target before running it.", "read-only": "Your project permissions do not allow this run.",
    "agent-offline": "The selected agent is unavailable.", "agent-config": "The selected agent has not applied its configuration.",
    "agent-capability": "The selected agent does not support this task.", "local-material": "This project requires materials available only on this computer.",
    "invalid-stress": "The saved load test plan is invalid.", unavailable: "The project is unavailable.",
    entries: "{count} suite entries", nodes: "{count} workflow nodes", assertionCount: "{count} assertions", maxVus: "Maximum virtual users",
    planEnvironment: "Uses the environment saved in the target.", inputs: "Run inputs", required: "Required", missingInput: "Enter a value for {name}.",
    data: "Dataset", noData: "None", loading: "Reading saved scope…", busy: "Starting or running the selected task…",
    accepted: "Task submitted to agent.", finished: "Run finished.", inspect: "View this run", cancel: "Cancel", submitting: "Sending task…",
    sourceChanged: "The execution context changed. Launch again to confirm the target.",
  },
  "zh-CN": {
    launch: "发起任务", records: "任务记录", choose: "选择运行目标", type: "任务类型", search: "按名称查找",
    noTargets: "没有匹配的已保存目标", thisRun: "本次执行", pick: "选择目标以查看执行范围。",
    scope: "范围", environment: "环境", location: "执行位置", local: "本机", moduleScope: "当前模块及子文件夹",
    applicable: "适用目标", caseOutcome: "通过 {passed} 条 · 失败 {failed} 条", module: "模块用例", case: "单接口用例", suite: "测试套件", workflow: "工作流", stress: "压测计划",
    start: { module: "运行模块用例", case: "运行用例", suite: "运行套件", workflow: "运行工作流", stress: "启动压测" },
    cases: "{count} 个用例", apis: "{count} 个接口", previewCases: "用例预览", api: "接口", dataDriven: "数据驱动",
    rowsAfterRun: "实际执行的数据行数见运行报告。", skippedCase: "{name} · 当前环境无适用用例，跳过",
    "no-cases": "当前环境没有可运行的用例。", "preview-changed": "已保存的执行范围已变化，请核对更新后的预览，再次发起。",
    "target-unavailable": "所选目标已不可用。", "environment-ambiguous": "所选环境在项目内存在同名项。",
    "environment-unavailable": "所选环境已不可用，请在底栏重新选择。",
    "workflow-draft": "工作流为草稿，请发布并启用后再运行。", "scope-unavailable": "该用例版本不适用于所选环境。",
    "save-before-running": "请先保存所选目标，再发起运行。", "read-only": "当前项目权限不允许运行。",
    "agent-offline": "所选代理不可用。", "agent-config": "所选代理尚未应用配置。",
    "agent-capability": "所选代理不支持此任务。", "local-material": "当前项目需要本机专用材料。",
    "invalid-stress": "已保存的压测计划配置无效。", unavailable: "当前项目不可用。",
    entries: "{count} 个套件条目", nodes: "{count} 个工作流节点", assertionCount: "{count} 条断言", maxVus: "最大虚拟用户数",
    planEnvironment: "采用目标中已保存的环境。", inputs: "运行输入", required: "必填", missingInput: "请输入 {name}。",
    data: "数据集", noData: "无", loading: "正在读取已保存的执行范围…", busy: "任务正在发起或执行…",
    accepted: "任务已提交至代理。", finished: "运行已结束。", inspect: "查看本次运行", cancel: "取消", submitting: "正在提交任务…",
    sourceChanged: "执行上下文已变化，请再次发起以确认目标。",
  },
};

export type LaunchMessage = keyof typeof messages.en | `start.${keyof typeof messages.en.start}`;

export function useLaunchMessages() {
  const { locale } = useI18n({ useScope: "global" });
  return (key: LaunchMessage, values: Record<string, string | number> = {}) => {
    const labels = locale.value === "zh-CN" ? messages["zh-CN"] : messages.en;
    const message = key.startsWith("start.") ? labels.start[key.slice(6) as keyof typeof labels.start] : labels[key as keyof Omit<typeof labels, "start">];
    return message.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
  };
}

export function launchError(error: unknown, label: ReturnType<typeof useLaunchMessages>): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /run-launch-([a-z-]+)/.exec(message);
  return match ? label(match[1] as LaunchMessage) : message;
}
