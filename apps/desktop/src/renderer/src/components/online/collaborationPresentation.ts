export function collaborationBytes(value: number) {
  return value >= 1048576 && value % 1048576 === 0 ? `${value / 1048576} MiB` : value >= 1024 && value % 1024 === 0 ? `${value / 1024} KiB` : `${value} B`;
}
export function collaborationTime(value: string | number, locale: string) {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZoneName: 'longOffset' }).format(new Date(value));
}
export function collaborationDuration(value: number, locale: string) {
  return value >= 86400000 ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value / 86400000)} ${locale === 'zh-CN' ? '天' : 'days'} (${value} ms)` : `${value} ms`;
}
export const countLabels: Record<string, string> = { 'logical.units': 'logicalUnits', 'case.rows': 'caseRows', 'request.started': 'requestsStarted', 'request.completed': 'requestsCompleted', 'http.exchanges': 'httpExchanges', iterations: 'iterations' };
