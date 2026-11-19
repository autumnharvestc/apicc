import { useI18n } from "vue-i18n";

const messages = {
  en: {
    refresh: "Refresh tasks", launch: "Launch task", records: "Task records", notifications: "Notifications", recent: "Latest 20 agent tasks",
    session: "This computer’s results are available in this desktop session while cached.",
    pick: "Select a task to see its recorded execution.", settings: "List settings", noRecords: "No tasks recorded in this project.",
    legacy: "Older reports with unverified project ownership", legacyHint: "The project that produced this report could not be verified.",
    notRecorded: "Not recorded", detail: "Execution details", receipt: "Submission", accepted: "Accepted",
    submitting: "Submitting", uncertain: "Submission outcome unknown", back: "Back to list", technical: "Technical details",
    plan: "View schedule", run: "View this run", noRun: "This notification has no linked run.",
    unavailable: "The linked record is unavailable or you no longer have access.", returnNotifications: "Back to the notification",
    returnSchedule: "Back to the schedule", recordId: "Run ID", jobId: "Job number", requests: "Request execution",
    awaiting: "Awaiting result", sessionReport: "Desktop session", time: "Execution time", submitted: "Submitted at",
    confirmRerun: "Run the selected evidence target again?", rerun: "Run again", cancel: "Cancel", report: "Report",
    trace: "Workflow trace", target: "Target", position: "Execution location", selection: "Selected task"
  },
  "zh-CN": {
    refresh: "刷新任务", launch: "发起任务", records: "任务记录", notifications: "通知", recent: "代理任务 · 最近 20 条",
    session: "本机结果仅在此次桌面会话的缓存保留期间可见。",
    pick: "选择一条任务，查看该次执行的记录。", settings: "列表设置", noRecords: "当前项目还没有任务记录。",
    legacy: "项目归属未确认的旧报告", legacyHint: "无法确认这份报告所属的项目。",
    notRecorded: "未记录", detail: "执行详情", receipt: "提交状态", accepted: "已接收",
    submitting: "提交中", uncertain: "提交结果未确定", back: "返回列表", technical: "技术详情",
    plan: "查看计划", run: "查看本次运行", noRun: "此通知没有关联运行。",
    unavailable: "关联记录已不可用，或当前成员无权查看。", returnNotifications: "返回原通知",
    returnSchedule: "返回原计划", recordId: "执行标识", jobId: "任务编号", requests: "请求执行情况",
    awaiting: "等待结果", sessionReport: "本次桌面会话", time: "执行时间", submitted: "提交时间",
    confirmRerun: "再次执行所选证据关联的目标？", rerun: "确认重跑", cancel: "取消", report: "报告",
    trace: "工作流轨迹", target: "目标", position: "执行位置", selection: "所选任务"
  }
};
export function useRecordMessages() {
  const { locale } = useI18n({ useScope: "global" });
  return (key: keyof typeof messages.en) => messages[locale.value === "zh-CN" ? "zh-CN" : "en"][key];
}

export function recordTime(value: unknown, locale: string, compact = false): string | undefined {
  const epoch = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(epoch) || !Number.isFinite(new Date(epoch).getTime())) return undefined;
  if (compact) return new Intl.DateTimeFormat(locale, {timeZone:"UTC",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(epoch);
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23" }).format(epoch) + " UTC";
}
