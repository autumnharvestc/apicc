import type { MessageBoxOptions } from 'electron';

export function lossyExportDialog(diagnostics: readonly { code: string; path: string; message: string }[], locale: 'zh-CN' | 'en' = 'en'): MessageBoxOptions {
  const en = locale === 'en';
  const visible = diagnostics.slice(0, 10).map(({code,path,message}) => `${code} — ${path}: ${message}`);
  if (diagnostics.length > visible.length) {
    const remaining = diagnostics.length - visible.length;
    visible.push(en ? `… ${remaining} more diagnostic(s)` : `… 另有 ${remaining} 项诊断`);
  }
  return {
    type:'warning',
    title:en ? 'OpenAPI export may lose semantics' : 'OpenAPI 导出可能丢失语义',
    message:en ? 'The selected OpenAPI document omits or transforms some contract semantics. Continue exporting?' : '所选 OpenAPI 文档会省略或转换部分契约语义。是否继续导出？',
    detail:visible.join('\n'), buttons:en ? ['Cancel','Export anyway'] : ['取消','仍然导出'],
    defaultId:0, cancelId:0, noLink:true,
  };
}
